import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Repo } from "./db.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { idParam, oneOf, optNum } from "./http.js";
import type { ShopifyStore } from "./shopify.js";
import type { PricingRules, Shop, ShopService } from "./shops.js";
import type { AeProduct, AeSku, CatalogSource } from "./types.js";

// ---------- ceny a sklad ----------

/** Prodejní cena v měně e-shopu z nákladu v měně AE. Nikdy ne pod nákladem. */
export function computePrice(cost: number, r: PricingRules): number {
  const base = cost * r.fxRate;
  let p = base * r.multiplier + r.fixedAdd;
  if (r.roundStep > 0) p = Math.ceil(p / r.roundStep) * r.roundStep - r.roundOffset;
  if (p < base) p = Math.ceil(base);
  return Math.round(p * 100) / 100;
}

export function shopifyQty(aeStock: number, r: PricingRules): number {
  return Math.max(0, Math.min(r.stockCap, Math.floor(aeStock) - r.stockBuffer));
}

/** Odstraní nebezpečné části HTML popisu z AliExpressu. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|form)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed|link|meta)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, "$1=$2#$2");
}

export function parseAeProductId(input: string): string {
  const s = String(input ?? "").trim();
  if (/^\d{6,}$/.test(s)) return s;
  const m = s.match(/\/item\/(?:[^/]*\/)?(\d{6,})\.html/) ?? s.match(/(\d{10,})/);
  if (!m?.[1]) throw new ValidationError("Nerozpoznal jsem ID produktu – vlož číslo nebo odkaz aliexpress.com/item/….html");
  return m[1];
}

const SHIPS_FROM = /ships?\s*from|odesíláno z|place of dispatch/i;
const optKey = (o: { name: string; value: string }[]) =>
  o
    .map((x) => `${x.name.toLowerCase()}=${x.value.toLowerCase()}`)
    .sort((a, b) => a.localeCompare(b))
    .join("|");

/**
 * Připraví varianty pro Shopify: zahodí volbu "Ships From" (zákazníka nezajímá),
 * ze shodných kombinací nechá tu se skladem a nejnižší cenou.
 */
export function prepareVariants(p: AeProduct): AeSku[] {
  const best = new Map<string, AeSku>();
  for (const s of p.skus) {
    const options = s.options.filter((o) => !SHIPS_FROM.test(o.name) && o.value);
    const sku = { ...s, options };
    const k = optKey(options);
    const cur = best.get(k);
    const better =
      !cur || (sku.stock > 0 && cur.stock <= 0) || ((sku.stock > 0) === (cur.stock > 0) && sku.price < cur.price);
    if (better) best.set(k, sku);
  }
  return [...best.values()];
}

// ---------- Shopify ----------

export interface NewProduct {
  title: string;
  descriptionHtml: string;
  images: string[];
  options: { name: string; values: string[] }[];
  variants: { options: { name: string; value: string }[]; price: number; cost: number; sku: string; quantity: number }[];
}

export interface CreatedProduct {
  productGid: string;
  variants: { gid: string; inventoryItemGid: string; options: { name: string; value: string }[] }[];
}

export interface CatalogStore {
  primaryLocation(): Promise<string>;
  createProduct(p: NewProduct, locationGid: string): Promise<CreatedProduct>;
  updateVariants(productGid: string, items: { variantGid: string; price: number; cost: number }[]): Promise<void>;
  setInventory(locationGid: string, items: { inventoryItemGid: string; quantity: number }[]): Promise<void>;
}

const money = (n: number) => n.toFixed(2);

export class ShopifyCatalog implements CatalogStore {
  constructor(private store: ShopifyStore) {}

  async primaryLocation(): Promise<string> {
    const d = await this.store.graphql<{ locations: { nodes: { id: string }[] } }>(
      `query { locations(first: 1) { nodes { id } } }`,
      {},
    );
    const id = d.locations.nodes[0]?.id;
    if (!id) throw new Error("E-shop nemá žádnou lokaci skladu");
    return id;
  }

  async createProduct(p: NewProduct, locationGid: string): Promise<CreatedProduct> {
    const noOptions = p.options.length === 0;
    const productOptions = noOptions
      ? [{ name: "Title", values: [{ name: "Default Title" }] }]
      : p.options.map((o) => ({ name: o.name, values: o.values.map((v) => ({ name: v })) }));
    const input = {
      title: p.title,
      descriptionHtml: p.descriptionHtml,
      status: "DRAFT",
      productOptions,
      files: p.images.slice(0, 10).map((u) => ({ originalSource: u, contentType: "IMAGE" })),
      variants: p.variants.map((v) => ({
        optionValues: noOptions
          ? [{ optionName: "Title", name: "Default Title" }]
          : v.options.map((o) => ({ optionName: o.name, name: o.value })),
        price: money(v.price),
        sku: v.sku,
        inventoryPolicy: "DENY",
        inventoryItem: { tracked: true, cost: money(v.cost) },
        inventoryQuantities: [{ locationId: locationGid, name: "available", quantity: v.quantity }],
      })),
    };
    const d = await this.store.graphql<{
      productSet: {
        product: { id: string; variants: { nodes: { id: string; selectedOptions: { name: string; value: string }[]; inventoryItem: { id: string } }[] } } | null;
        userErrors: { field: string[]; message: string }[];
      };
    }>(
      `mutation ProductSet($input: ProductSetInput!) {
        productSet(synchronous: true, input: $input) {
          product { id variants(first: 250) { nodes { id selectedOptions { name value } inventoryItem { id } } } }
          userErrors { field message }
        }
      }`,
      { input },
    );
    const errs = d.productSet.userErrors;
    if (errs.length || !d.productSet.product)
      throw new Error(`Shopify productSet: ${errs.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ") || "bez produktu"}`);
    return {
      productGid: d.productSet.product.id,
      variants: d.productSet.product.variants.nodes.map((n) => ({
        gid: n.id,
        inventoryItemGid: n.inventoryItem.id,
        options: noOptions ? [] : n.selectedOptions,
      })),
    };
  }

  async updateVariants(productGid: string, items: { variantGid: string; price: number; cost: number }[]): Promise<void> {
    for (let i = 0; i < items.length; i += 250) {
      const chunk = items.slice(i, i + 250);
      const d = await this.store.graphql<{ productVariantsBulkUpdate: { userErrors: { field: string[]; message: string }[] } }>(
        `mutation Upd($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
        }`,
        {
          productId: productGid,
          variants: chunk.map((c) => ({ id: c.variantGid, price: money(c.price), inventoryItem: { cost: money(c.cost) } })),
        },
      );
      const errs = d.productVariantsBulkUpdate.userErrors;
      if (errs.length) throw new Error(`Shopify productVariantsBulkUpdate: ${errs.map((e) => e.message).join("; ")}`);
    }
  }

  async setInventory(locationGid: string, items: { inventoryItemGid: string; quantity: number }[]): Promise<void> {
    for (let i = 0; i < items.length; i += 250) {
      const chunk = items.slice(i, i + 250);
      const d = await this.store.graphql<{ inventorySetQuantities: { userErrors: { code: string; message: string }[] } }>(
        `mutation Inv($input: InventorySetQuantitiesInput!, $key: String!) {
          inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { code field message } }
        }`,
        {
          key: randomUUID(),
          input: {
            name: "available",
            reason: "correction",
            referenceDocumentUri: "dropship-mvp://sync",
            quantities: chunk.map((c) => ({
              inventoryItemId: c.inventoryItemGid,
              locationId: locationGid,
              quantity: c.quantity,
              changeFromQuantity: null,
            })),
          },
        },
      );
      const errs = d.inventorySetQuantities.userErrors;
      if (errs.length) throw new Error(`Shopify inventorySetQuantities: ${errs.map((e) => e.message).join("; ")}`);
    }
  }
}

// ---------- služba ----------

export interface ProductRow {
  id: number;
  shop_id: number;
  ae_product_id: string;
  shopify_product_gid: string | null;
  title: string;
  ae_currency: string;
  status: "ACTIVE" | "PAUSED";
  gpsr_json: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  shopify_variant_id: string;
  shopify_variant_gid: string | null;
  inventory_item_gid: string | null;
  ae_sku_attr: string | null;
  last_cost: number | null;
  last_price: number | null;
  last_stock: number | null;
  last_synced_at: string | null;
}

export interface SyncSummary {
  products: number;
  priceUpdates: number;
  stockUpdates: number;
  errors: number;
}

const variantIdFromGid = (gid: string) => gid.split("/").pop()!;

export class CatalogService {
  private syncing = false;

  constructor(
    private repo: Repo,
    private source: CatalogSource,
    private shops: ShopService,
    private storeFor: (shopId: number) => CatalogStore = (id) => new ShopifyCatalog(shops.store(id)),
  ) {}

  list(shopId?: number): (ProductRow & { variants: number })[] {
    const sql = `SELECT p.*, (SELECT COUNT(*) FROM mappings m WHERE m.product_id = p.id) AS variants
                 FROM products p ${shopId ? "WHERE p.shop_id = ?" : ""} ORDER BY p.id DESC`;
    return this.repo.db.prepare(sql).all(...(shopId ? [shopId] : [])) as unknown as (ProductRow & { variants: number })[];
  }

  get(id: number): { product: ProductRow; variants: VariantRow[] } {
    const product = this.repo.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
    if (!product) throw new NotFoundError(`Produkt ${id} neexistuje`);
    const variants = this.repo.db
      .prepare(
        `SELECT shopify_variant_id, shopify_variant_gid, inventory_item_gid, ae_sku_attr, last_cost, last_price, last_stock, last_synced_at
         FROM mappings WHERE product_id = ? ORDER BY shopify_variant_id`,
      )
      .all(id) as unknown as VariantRow[];
    return { product, variants };
  }

  setStatus(id: number, status: "ACTIVE" | "PAUSED"): void {
    this.get(id);
    this.repo.db.prepare("UPDATE products SET status = ?, updated_at = ? WHERE id = ?").run(status, this.repo.now_(), id);
  }

  private async location(shop: Shop, store: CatalogStore): Promise<string> {
    if (shop.locationGid) return shop.locationGid;
    const gid = await store.primaryLocation();
    this.shops.setLocation(shop.id, gid);
    return gid;
  }

  async importProduct(shopId: number, aeInput: string): Promise<{ product: ProductRow; variants: VariantRow[] }> {
    const shop = this.shops.get(shopId);
    const aeId = parseAeProductId(aeInput);
    if (this.repo.db.prepare("SELECT 1 FROM products WHERE shop_id = ? AND ae_product_id = ?").get(shopId, aeId))
      throw new ConflictError(`Produkt ${aeId} už je v e-shopu ${shop.name} naimportovaný`);

    const p = await this.source.getProduct(aeId, shop.country);
    if (!p.available) throw new ValidationError(`Produkt ${aeId} není na AliExpressu v prodeji pro ${shop.country}`);
    const skus = prepareVariants(p);
    if (!skus.length) throw new ValidationError("Produkt nemá žádné varianty");
    if (skus.length > 250) throw new ValidationError(`Produkt má ${skus.length} variant, limit je 250`);

    const optionNames: string[] = [];
    for (const s of skus) for (const o of s.options) if (!optionNames.includes(o.name)) optionNames.push(o.name);
    if (optionNames.length > 3) throw new ValidationError(`Produkt má ${optionNames.length} voleb (${optionNames.join(", ")}), Shopify umí max. 3`);
    if (skus.some((s) => s.options.length !== optionNames.length))
      throw new ValidationError("Varianty mají nekonzistentní volby – importuj ručně");

    const store = this.storeFor(shopId);
    const loc = await this.location(shop, store);
    const created = await store.createProduct(
      {
        title: p.title.slice(0, 255),
        descriptionHtml: sanitizeHtml(p.descriptionHtml),
        images: p.images,
        options: optionNames.map((n) => ({ name: n, values: [...new Set(skus.map((s) => s.options.find((o) => o.name === n)!.value))] })),
        variants: skus.map((s, i) => ({
          options: s.options,
          price: computePrice(s.price, shop.pricing),
          cost: Math.round(s.price * shop.pricing.fxRate * 100) / 100,
          sku: `AE-${aeId}-${s.skuId ?? i + 1}`,
          quantity: shopifyQty(s.stock, shop.pricing),
        })),
      },
      loc,
    );

    const t = this.repo.now_();
    this.repo.db.exec("BEGIN");
    try {
      const r = this.repo.db
        .prepare(
          `INSERT INTO products (shop_id, ae_product_id, shopify_product_gid, title, ae_currency, status, last_synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        )
        .run(shopId, aeId, created.productGid, p.title, p.currency, t, t, t);
      const productId = Number(r.lastInsertRowid);
      const ins = this.repo.db.prepare(
        `INSERT INTO mappings (shopify_variant_id, shop_id, product_id, shopify_variant_gid, inventory_item_gid, ae_product_id,
           ae_sku_attr, ae_sku_id, last_cost, last_price, last_stock, last_synced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const v of created.variants) {
        const k = optKey(v.options);
        const sku = skus.find((s) => optKey(s.options) === k) ?? (skus.length === 1 ? skus[0] : undefined);
        if (!sku) throw new Error(`Nepodařilo se spárovat variantu Shopify ${v.gid} (${k}) s AliExpressem`);
        ins.run(
          variantIdFromGid(v.gid),
          shopId,
          productId,
          v.gid,
          v.inventoryItemGid,
          aeId,
          sku.skuAttr,
          sku.skuId,
          sku.price,
          computePrice(sku.price, shop.pricing),
          shopifyQty(sku.stock, shop.pricing),
          t,
          t,
        );
      }
      this.repo.db.exec("COMMIT");
      this.repo.log(null, "info", `Import AE ${aeId} → ${shop.name}: ${created.variants.length} variant (koncept v Shopify)`);
      // Objednávky, které čekaly na mapování těchto variant, zpracuje volající (reprocessWaitingForMapping).
      return this.get(productId);
    } catch (e) {
      this.repo.db.exec("ROLLBACK");
      throw new Error(`Produkt vznikl v Shopify (${created.productGid}), ale nepodařilo se ho uložit: ${(e as Error).message}`);
    }
  }

  async syncProduct(id: number): Promise<{ priceUpdates: number; stockUpdates: number }> {
    const { product } = this.get(id);
    const shop = this.shops.get(product.shop_id);
    const store = this.storeFor(shop.id);
    const rows = this.repo.db
      .prepare("SELECT * FROM mappings WHERE product_id = ?")
      .all(id) as unknown as (VariantRow & { ae_sku_attr: string })[];
    const t = this.repo.now_();
    try {
      const p = await this.source.getProduct(product.ae_product_id, shop.country);
      const prices: { variantGid: string; price: number; cost: number }[] = [];
      const stock: { inventoryItemGid: string; quantity: number }[] = [];
      const updates: { variantId: string; cost: number | null; price: number | null; stock: number }[] = [];
      const alerts: string[] = [];

      for (const r of rows) {
        const sku = p.available ? p.skus.find((s) => s.skuAttr === r.ae_sku_attr) : undefined;
        const qty = sku ? shopifyQty(sku.stock, shop.pricing) : 0;
        let price = r.last_price;
        let cost = r.last_cost;
        if (sku && sku.price > 0) {
          price = computePrice(sku.price, shop.pricing);
          cost = sku.price;
          if (r.shopify_variant_gid && (r.last_price == null || Math.abs(price - r.last_price) >= 0.01)) {
            prices.push({ variantGid: r.shopify_variant_gid, price, cost: Math.round(sku.price * shop.pricing.fxRate * 100) / 100 });
            if (r.last_price && Math.abs(price - r.last_price) / r.last_price * 100 > shop.pricing.priceAlertPct)
              alerts.push(`${r.shopify_variant_id}: ${r.last_price} → ${price} ${shop.currency}`);
          }
        }
        if (!sku && (r.last_stock ?? 1) > 0)
          alerts.push(`${r.shopify_variant_id}: varianta ${p.available ? "zmizela z AE" : "– produkt stažen z prodeje"} → sklad 0`);
        if (r.inventory_item_gid && qty !== r.last_stock) stock.push({ inventoryItemGid: r.inventory_item_gid, quantity: qty });
        updates.push({ variantId: r.shopify_variant_id, cost, price, stock: qty });
      }

      if (prices.length && product.shopify_product_gid) await store.updateVariants(product.shopify_product_gid, prices);
      if (stock.length) await store.setInventory(await this.location(shop, store), stock);

      const up = this.repo.db.prepare(
        "UPDATE mappings SET last_cost = ?, last_price = ?, last_stock = ?, last_synced_at = ?, updated_at = ? WHERE shopify_variant_id = ?",
      );
      for (const u of updates) up.run(u.cost, u.price, u.stock, t, t, u.variantId);
      this.repo.db.prepare("UPDATE products SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(t, t, id);
      if (alerts.length) this.repo.log(null, "warn", `Sync AE ${product.ae_product_id} (${shop.name}): ${alerts.join("; ")}`);
      return { priceUpdates: prices.length, stockUpdates: stock.length };
    } catch (e) {
      const msg = (e as Error).message;
      this.repo.db.prepare("UPDATE products SET last_error = ?, updated_at = ? WHERE id = ?").run(msg, t, id);
      this.repo.log(null, "error", `Sync AE ${product.ae_product_id} (${shop.name}): ${msg}`);
      throw e;
    }
  }

  async syncAll(): Promise<SyncSummary> {
    const sum: SyncSummary = { products: 0, priceUpdates: 0, stockUpdates: 0, errors: 0 };
    if (this.syncing) return sum;
    this.syncing = true;
    try {
      const ids = (
        this.repo.db
          .prepare("SELECT p.id FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.status = 'ACTIVE' AND s.active = 1 ORDER BY p.id")
          .all() as { id: number }[]
      ).map((r) => r.id);
      for (const id of ids) {
        sum.products++;
        try {
          const r = await this.syncProduct(id);
          sum.priceUpdates += r.priceUpdates;
          sum.stockUpdates += r.stockUpdates;
        } catch {
          sum.errors++;
        }
      }
    } finally {
      this.syncing = false;
    }
    return sum;
  }
}

// ---------- HTTP ----------

export function catalogRouter(catalog: CatalogService, shops: ShopService, afterImport: () => Promise<void>): Router {
  const r = Router();
  r.get("/products", (req, res) => {
    res.json(catalog.list(req.query.shopId ? Number(req.query.shopId) : undefined));
  });
  r.get("/products/:id", (req, res) => {
    res.json(catalog.get(idParam(req)));
  });
  r.post("/products/import", async (req, res) => {
    const shopId = Number(req.body?.shopId);
    if (!Number.isInteger(shopId) || shopId <= 0) throw new ValidationError("shopId je povinné");
    const out = await catalog.importProduct(shopId, String(req.body?.aeProduct ?? ""));
    await afterImport();
    res.status(201).json(out);
  });
  r.post("/products/sync", async (_req, res) => {
    res.json(await catalog.syncAll());
  });
  r.post("/products/:id/sync", async (req, res) => {
    res.json(await catalog.syncProduct(idParam(req)));
  });
  r.patch("/products/:id", (req, res) => {
    const id = idParam(req);
    if (req.body?.status !== undefined) catalog.setStatus(id, oneOf(req.body.status, ["ACTIVE", "PAUSED"] as const, "status"));
    res.json(catalog.get(id));
  });
  r.get("/pricing/preview", (req, res) => {
    const shop = shops.get(Number(req.query.shopId));
    const cost = optNum(req.query.cost, "cost") ?? 0;
    res.json({ cost, currency: shop.currency, price: computePrice(cost, shop.pricing), rules: shop.pricing });
  });
  return r;
}
