import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Repo } from "./db.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { idParam, optStr } from "./http.js";
import type { OrderService } from "./orders.js";
import { parseOrderWebhook, verifyShopifyHmac } from "./shopify.js";
import type { ShopInput, ShopService } from "./shops.js";
import type { TrackingService } from "./tracking.js";
import type { IncomingOrder } from "./types.js";

export interface OAuthProvider {
  authorizeUrl(redirectUri: string): string;
  handleCallback(code: string, state: string): Promise<void>;
  isAuthorized(): boolean;
}

export interface AppDeps {
  repo: Repo;
  orders: OrderService;
  tracking: TrackingService;
  oauth: OAuthProvider;
  shops: ShopService;
  /** Volá se po uložení nové objednávky (např. CRM). Chyba se jen zaloguje. */
  onOrderCreated?: (orderId: number, incoming: IncomingOrder) => void;
  /** Další admin routery (katalog, CRM, compliance…), připojené pod /admin. */
  extraAdmin?: express.Router[];
  cfg: { adminToken: string; publicBaseUrl: string; dryRun: boolean; autoPay: boolean };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const parseJson = (v: string | null) => (v ? JSON.parse(v) : null);

function orderView(repo: Repo, id: number, withDetail = false) {
  const o = repo.getOrder(id);
  if (!o) throw new NotFoundError(`Objednávka ${id} neexistuje`);
  const base = {
    id: o.id,
    shopId: o.shop_id,
    customerId: o.customer_id,
    shopifyOrderId: o.shopify_order_id,
    name: o.name,
    status: o.status,
    totalPrice: o.total_price,
    currency: o.currency,
    aeOrderIds: parseJson(o.ae_order_ids_json),
    tryToPay: o.try_to_pay === 1,
    lastError: o.last_error,
    placedAt: o.placed_at,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
  if (!withDetail) return base;
  return {
    ...base,
    email: o.email,
    address: parseJson(o.address_json),
    lines: parseJson(o.lines_json),
    supplierLines: parseJson(o.supplier_lines_json),
    shipments: repo.shipmentsForOrder(id),
    events: repo.eventsForOrder(id),
  };
}

export function createApp(d: AppDeps) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      dryRun: d.cfg.dryRun,
      autoPay: d.cfg.autoPay,
      aliexpressAuthorized: d.oauth.isAuthorized(),
      shops: d.shops.list().filter((s) => s.active).length,
    });
  });

  // ---------- Shopify webhook ----------
  app.post("/webhooks/shopify/orders-paid", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
    const raw = req.body as Buffer;
    const domain = (req.get("x-shopify-shop-domain") ?? "").toLowerCase();
    const found = domain ? d.shops.findForWebhook(domain) : undefined;
    if (!found) {
      res.status(403).send("unknown shop");
      return;
    }
    if (!Buffer.isBuffer(raw) || !verifyShopifyHmac(raw, req.get("x-shopify-hmac-sha256"), found.webhookSecret)) {
      res.status(401).send("invalid hmac");
      return;
    }
    if (!found.shop.active) {
      // 200, aby Shopify webhook neopakoval; neaktivní e-shop objednávky nezpracovává.
      d.repo.log(null, "warn", `Webhook z neaktivního e-shopu ${domain} ignorován`);
      res.status(200).json({ ok: true, ignored: true });
      return;
    }
    let incoming: IncomingOrder;
    try {
      incoming = parseOrderWebhook(JSON.parse(raw.toString("utf8")));
    } catch (e) {
      d.repo.log(null, "error", `Neplatný webhook z ${domain}: ${(e as Error).message}`);
      res.status(400).send("bad payload");
      return;
    }
    const { id, created } = d.orders.ingest(incoming, found.shop.id);
    if (created && d.onOrderCreated) {
      try {
        d.onOrderCreated(id, incoming);
      } catch (e) {
        d.repo.log(id, "error", `Navazující zpracování (CRM) selhalo: ${(e as Error).message}`);
      }
    }
    // Shopify chce odpověď do 5 s → odeslání do AE až po odpovědi.
    res.status(200).json({ ok: true, id, created });
    if (created) {
      setImmediate(() => {
        d.orders.process(id).catch((e) => d.repo.log(id, "error", `Zpracování selhalo: ${(e as Error).message}`));
      });
    }
  });

  // ---------- AliExpress OAuth callback (veřejný, chráněný parametrem state) ----------
  app.get("/ae/oauth/callback", async (req, res) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (!code || !state) {
      res.status(400).send("Chybí code nebo state");
      return;
    }
    try {
      await d.oauth.handleCallback(code, state);
      res.send("AliExpress je propojený. Okno můžeš zavřít.");
    } catch (e) {
      d.repo.log(null, "error", `AE OAuth: ${(e as Error).message}`);
      res.status(400).send(`Propojení selhalo: ${(e as Error).message}`);
    }
  });

  // ---------- Admin API ----------
  const admin = express.Router();
  admin.use((req, res, next) => {
    const h = req.get("authorization") ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token || !safeEqual(token, d.cfg.adminToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  admin.use(express.json({ limit: "1mb" }));

  admin.get("/orders", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const shopId = req.query.shopId ? Number(req.query.shopId) : undefined;
    res.json(d.repo.listOrders({ status, shopId }).map((o) => orderView(d.repo, o.id)));
  });

  admin.get("/shops", (_req, res) => {
    res.json(d.shops.list());
  });
  admin.post("/shops", (req, res) => {
    res.status(201).json(d.shops.create(req.body as ShopInput));
  });
  admin.get("/shops/:id", (req, res) => {
    res.json(d.shops.get(idParam(req)));
  });
  admin.patch("/shops/:id", (req, res) => {
    res.json(d.shops.update(idParam(req), req.body as Partial<ShopInput>));
  });
  admin.get("/orders/:id", (req, res) => {
    res.json(orderView(d.repo, idParam(req), true));
  });
  admin.post("/orders/:id/approve", async (req, res) => {
    const id = idParam(req);
    await d.orders.approve(id);
    res.json(orderView(d.repo, id));
  });
  admin.post("/orders/:id/retry", async (req, res) => {
    const id = idParam(req);
    await d.orders.retry(id, { confirmNotPlaced: req.body?.confirmNotPlaced === true });
    res.json(orderView(d.repo, id));
  });
  admin.post("/orders/:id/mark-placed", (req, res) => {
    const id = idParam(req);
    const ids = req.body?.aeOrderIds;
    if (!Array.isArray(ids)) throw new ValidationError("aeOrderIds musí být pole");
    d.orders.markPlacedManually(id, ids.map(String));
    res.json(orderView(d.repo, id));
  });
  admin.patch("/orders/:id/address", async (req, res) => {
    const id = idParam(req);
    if (!req.body || typeof req.body !== "object") throw new ValidationError("Tělo musí být JSON objekt");
    await d.orders.updateAddress(id, req.body);
    res.json(orderView(d.repo, id, true));
  });
  admin.post("/orders/:id/cancel", (req, res) => {
    const id = idParam(req);
    d.orders.cancel(id);
    res.json(orderView(d.repo, id));
  });

  admin.get("/mappings", (_req, res) => {
    res.json(d.repo.listMappings());
  });
  admin.put("/mappings/:variantId", async (req, res) => {
    const variantId = String(req.params.variantId);
    if (!/^\d+$/.test(variantId)) throw new ValidationError("variantId musí být číselné ID varianty Shopify");
    const aeProductId = String(req.body?.aeProductId ?? "").trim();
    if (!/^\d+$/.test(aeProductId)) throw new ValidationError("aeProductId musí být číselné ID produktu AliExpress");
    const shopId = req.body?.shopId != null ? Number(req.body.shopId) : null;
    if (shopId != null) d.shops.get(shopId);
    d.repo.upsertMapping({
      shopifyVariantId: variantId,
      shopId,
      aeProductId,
      aeSkuAttr: optStr(req.body?.aeSkuAttr, "aeSkuAttr"),
      logisticsServiceName: optStr(req.body?.logisticsServiceName, "logisticsServiceName"),
      note: optStr(req.body?.note, "note"),
    });
    await d.orders.reprocessWaitingForMapping();
    res.json(d.repo.getMapping(variantId));
  });
  admin.delete("/mappings/:variantId", (req, res) => {
    if (!d.repo.deleteMapping(String(req.params.variantId))) throw new NotFoundError("Mapování neexistuje");
    res.status(204).end();
  });

  admin.post("/tracking/sync", async (_req, res) => {
    res.json(await d.tracking.syncAll());
  });
  admin.get("/ae/oauth-url", (_req, res) => {
    res.json({ url: d.oauth.authorizeUrl(`${d.cfg.publicBaseUrl}/ae/oauth/callback`) });
  });

  for (const r of d.extraAdmin ?? []) admin.use(r);
  app.use("/admin", admin);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as Error;
    const status =
      e instanceof NotFoundError ? 404 : e instanceof ConflictError ? 409 : e instanceof ValidationError ? 400 : 500;
    if (status === 500) d.repo.log(null, "error", `HTTP 500: ${e.stack ?? e.message}`);
    res.status(status).json({ error: status === 500 ? "internal error" : e.message });
  });
  return app;
}
