import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { OrderService } from "../src/orders.js";
import { createApp } from "../src/server.js";
import { TrackingService } from "../src/tracking.js";
import { FakeStore, FakeSupplier, MAPPING, memRepo } from "./helpers.js";

const SECRET = "whsec_test";
const ADMIN = "admin-token-0123456789-abcdef";
const repo = memRepo();
const sup = new FakeSupplier();
const orders = new OrderService(repo, sup, { dryRun: false, autoPay: { enabled: true, maxOrderTotal: 1500, maxPerDay: 10 } });
const tracking = new TrackingService(repo, sup, new FakeStore(), { notifyCustomer: false, unpaidWarnHours: 6, urlTemplate: "" });
const app = createApp({
  repo,
  orders,
  tracking,
  oauth: { authorizeUrl: (r) => `https://ae/auth?redirect=${r}`, handleCallback: async () => {}, isAuthorized: () => true },
  cfg: { adminToken: ADMIN, webhookSecret: SECRET, shop: "pokovo.myshopify.com", publicBaseUrl: "https://dropship.example.cz", dryRun: false },
});
let base = "";
let server: ReturnType<typeof app.listen>;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const payload = JSON.stringify({
  id: 7001,
  name: "#3001",
  currency: "CZK",
  total_price: "2490.00",
  shipping_address: { name: "Jan Novák", address1: "Hlavní 1", city: "Písek", zip: "39701", country_code: "CZ", phone: "+420777000111" },
  line_items: [{ id: 1, variant_id: 111, title: "Lampa", quantity: 1, requires_shipping: true }],
});
const hook = (body: string, hmac: string, shop = "pokovo.myshopify.com") =>
  fetch(`${base}/webhooks/shopify/orders-paid`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-hmac-sha256": hmac, "x-shopify-shop-domain": shop },
    body,
  });
const adminReq = (path: string, init: RequestInit = {}, token = ADMIN) =>
  fetch(`${base}/admin${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
const tick = () => new Promise((r) => setTimeout(r, 20));

test("webhook: špatný podpis 401, cizí shop 403", async () => {
  assert.equal((await hook(payload, "nope")).status, 401);
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64");
  assert.equal((await hook(payload, sig, "cizi.myshopify.com")).status, 403);
});

test("celý tok: webhook → čeká na mapování → mapování → schválení → PLACED", async () => {
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64");
  const r = await hook(payload, sig);
  assert.equal(r.status, 200);
  const { id } = (await r.json()) as { id: number };
  await tick();
  assert.equal(repo.getOrder(id)!.status, "NEEDS_MAPPING");

  assert.equal((await hook(payload, sig)).status, 200, "opakovaný webhook je OK");

  const m = await adminReq(`/mappings/111`, {
    method: "PUT",
    body: JSON.stringify({ aeProductId: MAPPING.aeProductId, aeSkuAttr: MAPPING.aeSkuAttr }),
  });
  assert.equal(m.status, 200);
  assert.equal(repo.getOrder(id)!.status, "NEEDS_APPROVAL", "2490 Kč je nad limitem 1500");

  const a = await adminReq(`/orders/${id}/approve`, { method: "POST" });
  assert.equal(a.status, 200);
  assert.equal(((await a.json()) as { status: string }).status, "PLACED");
  assert.equal((await adminReq(`/orders/${id}/approve`, { method: "POST" })).status, 409);

  const detail = (await (await adminReq(`/orders/${id}`)).json()) as { events: unknown[]; shipments: unknown[] };
  assert.ok(detail.events.length >= 3);
  assert.equal(detail.shipments.length, 1);
});

test("admin: bez tokenu 401, validace 400, neznámé id 404", async () => {
  assert.equal((await adminReq("/orders", {}, "spatny")).status, 401);
  assert.equal((await adminReq("/mappings/abc", { method: "PUT", body: "{}" })).status, 400);
  assert.equal((await adminReq("/mappings/5", { method: "PUT", body: JSON.stringify({ aeProductId: "x" }) })).status, 400);
  assert.equal((await adminReq("/orders/99999")).status, 404);
  const u = (await (await adminReq("/ae/oauth-url")).json()) as { url: string };
  assert.match(u.url, /redirect=https:\/\/dropship\.example\.cz\/ae\/oauth\/callback/);
});

test("health", async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, dryRun: false, aliexpressAuthorized: true });
});
