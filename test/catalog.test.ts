import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAeProduct } from "../src/aliexpress.js";
import {
  CatalogService,
  ShopifyCatalog,
  computePrice,
  parseAeProductId,
  prepareVariants,
  sanitizeHtml,
  shopifyQty,
  type CatalogStore,
  type CreatedProduct,
  type NewProduct,
} from "../src/catalog.js";
import { ShopifyStore } from "../src/shopify.js";
import type { AeProduct, CatalogSource } from "../src/types.js";
import { PRICING, memRepo, seedShop, shopService } from "./helpers.js";

test("computePrice: kurz × násobek, zaokrouhlení na …9, nikdy pod nákladem", () => {
  assert.equal(computePrice(5, PRICING), 229); // 5×23×2 = 230 → 230 − 1
  assert.equal(computePrice(5.2, PRICING), 239); // 239.2 → 240 − 1
  assert.equal(computePrice(10, { ...PRICING, multiplier: 1, roundStep: 0 }), 230);
  assert.equal(computePrice(10, { ...PRICING, multiplier: 1, roundStep: 10, roundOffset: 9 }), 230, "zaokrouhlení nesmí jít pod náklad");
  assert.equal(computePrice(3, { ...PRICING, fixedAdd: 50 }), 189); // 138 + 50 = 188 → 190 − 1
});

test("shopifyQty: buffer a strop", () => {
  assert.equal(shopifyQty(1000, PRICING), 50);
  assert.equal(shopifyQty(10, PRICING), 8);
  assert.equal(shopifyQty(1, PRICING), 0);
});

test("parseAeProductId z ID i odkazu", () => {
  assert.equal(parseAeProductId("1005006543210987"), "1005006543210987");
  assert.equal(parseAeProductId("https://www.aliexpress.com/item/1005006543210987.html?spm=a2g0o"), "1005006543210987");
  assert.equal(parseAeProductId("https://cs.aliexpress.com/item/1005006543210987.html"), "1005006543210987");
  assert.throws(() => parseAeProductId("lampa"));
});

test("sanitizeHtml odstraní skripty a události", () => {
  const out = sanitizeHtml('<p onclick="x()">A</p><script>alert(1)</script><img src="a.jpg" onerror=hack()><a href="javascript:evil()">b</a>');
  assert.ok(!/script|onclick|onerror|javascript:/i.test(out), out);
  assert.match(out, /<p>A<\/p>/);
  assert.match(out, /<img src="a.jpg">/);
});

const AE_RAW = {
  ae_item_base_info_dto: { product_id: 1005006543210987, subject: "LED lampa", detail: "<p>Popis</p>", product_status_type: "onSelling" },
  ae_multimedia_info_dto: { image_urls: "https://ae01.alicdn.com/a.jpg;https://ae01.alicdn.com/b.jpg" },
  ae_store_info: { store_id: 42, store_name: "Lamp Store" },
  ae_item_sku_info_dtos: {
    ae_item_sku_info_d_t_o: [
      sku("14:193#Black;200007763:201336100", "Black", "China", "5.20", 100),
      sku("14:193#Black;200007763:201336106", "Black", "Czech Republic", "6.10", 0),
      sku("14:175#White;200007763:201336100", "White", "China", "5.00", 3),
    ],
  },
};
function sku(id: string, color: string, from: string, price: string, stock: number) {
  return {
    id,
    sku_id: id.length,
    offer_sale_price: price,
    sku_price: "9.99",
    sku_available_stock: stock,
    currency_code: "USD",
    ae_sku_property_dtos: {
      ae_sku_property_d_t_o: [
        { sku_property_id: 14, sku_property_name: "Color", sku_property_value: color, sku_image: `https://ae01.alicdn.com/${color}.jpg` },
        { sku_property_id: 200007763, sku_property_name: "Ships From", sku_property_value: from },
      ],
    },
  };
}

test("parseAeProduct + prepareVariants: zabalená pole, Ships From se zahodí, vybere se varianta se skladem", () => {
  const p = parseAeProduct(AE_RAW, "USD");
  assert.equal(p.title, "LED lampa");
  assert.equal(p.available, true);
  assert.equal(p.images.length, 2);
  assert.equal(p.skus.length, 3);
  assert.equal(p.skus[0]!.price, 5.2);
  const v = prepareVariants(p);
  assert.equal(v.length, 2);
  const black = v.find((s) => s.options[0]!.value === "Black")!;
  assert.equal(black.skuAttr, "14:193#Black;200007763:201336100", "CZ sklad má 0 ks → vezme se Čína");
  assert.deepEqual(black.options, [{ name: "Color", value: "Black" }]);
  assert.equal(parseAeProduct({ ...AE_RAW, ae_item_base_info_dto: { ...AE_RAW.ae_item_base_info_dto, product_status_type: "offline" } }, "USD").available, false);
});

class FakeSource implements CatalogSource {
  product: AeProduct = parseAeProduct(AE_RAW, "USD");
  calls: string[] = [];
  async getProduct(id: string, country: string) {
    this.calls.push(`${id}@${country}`);
    if (id !== this.product.productId) throw new Error("not found");
    return structuredClone(this.product);
  }
}

let gidSeq = 0;
class FakeCatalogStore implements CatalogStore {
  base = 9000 + 100 * gidSeq++;
  created: NewProduct[] = [];
  priceCalls: { variantGid: string; price: number; cost: number }[][] = [];
  stockCalls: { inventoryItemGid: string; quantity: number }[][] = [];
  locationCalls = 0;
  async primaryLocation() {
    this.locationCalls++;
    return "gid://shopify/Location/1";
  }
  async createProduct(p: NewProduct): Promise<CreatedProduct> {
    this.created.push(p);
    return {
      productGid: "gid://shopify/Product/900",
      variants: p.variants.map((v, i) => {
        const n = this.base + 10 * (this.created.length - 1) + i;
        return { gid: `gid://shopify/ProductVariant/${n}`, inventoryItemGid: `gid://shopify/InventoryItem/${n - 1000}`, options: v.options };
      }),
    };
  }
  async updateVariants(_g: string, items: { variantGid: string; price: number; cost: number }[]) {
    this.priceCalls.push(items);
  }
  async setInventory(_l: string, items: { inventoryItemGid: string; quantity: number }[]) {
    this.stockCalls.push(items);
  }
}

function setup() {
  const repo = memRepo();
  const shopId = seedShop(repo);
  const shops = shopService(repo);
  const src = new FakeSource();
  const store = new FakeCatalogStore();
  const cat = new CatalogService(repo, src, shops, () => store);
  return { repo, shopId, shops, src, store, cat };
}

test("import: vytvoří koncept v Shopify, mapování variant a uloží lokaci", async () => {
  const t = setup();
  const out = await t.cat.importProduct(t.shopId, "https://www.aliexpress.com/item/1005006543210987.html");
  assert.equal(t.src.calls[0], "1005006543210987@CZ");
  const np = t.store.created[0]!;
  assert.deepEqual(np.options, [{ name: "Color", values: ["Black", "White"] }]);
  assert.deepEqual(np.variants.map((v) => [v.price, v.quantity, v.cost]), [[239, 50, 119.6], [229, 1, 115]]);
  assert.equal(out.variants.length, 2);
  assert.equal(out.product.shopify_product_gid, "gid://shopify/Product/900");
  const m = t.repo.getMapping(String(t.store.base))!;
  assert.equal(m.aeProductId, "1005006543210987");
  assert.equal(m.aeSkuAttr, "14:193#Black;200007763:201336100");
  assert.equal(t.shops.get(t.shopId).locationGid, "gid://shopify/Location/1");
  await assert.rejects(t.cat.importProduct(t.shopId, "1005006543210987"), /už je/);
  await t.cat.importProduct(seedShop(t.repo, { domain: "sk.myshopify.com", currency: "EUR", country: "SK" }), "1005006543210987");
  assert.equal(t.src.calls.at(-1), "1005006543210987@SK", "stejný produkt jde do jiného e-shopu");
});

test("import odmítne produkt mimo prodej a s víc než 3 volbami", async () => {
  const t = setup();
  t.src.product.available = false;
  await assert.rejects(t.cat.importProduct(t.shopId, "1005006543210987"), /není na AliExpressu v prodeji/);
  t.src.product = parseAeProduct(AE_RAW, "USD");
  for (const s of t.src.product.skus) s.options.push({ name: "A", value: "1" }, { name: "B", value: "2" }, { name: "C", value: s.skuAttr });
  await assert.rejects(t.cat.importProduct(t.shopId, "1005006543210987"), /max\. 3/);
});

test("sync: změna ceny a skladu se propíše jen u změněných variant; stažení z prodeje → sklad 0", async () => {
  const t = setup();
  const { product } = await t.cat.importProduct(t.shopId, "1005006543210987");
  assert.deepEqual(await t.cat.syncProduct(product.id), { priceUpdates: 0, stockUpdates: 0 }, "beze změny nic neposílá");

  t.src.product.skus[0]!.price = 7; // Black/China: 5.2 → 7 USD (+35 %)
  t.src.product.skus[2]!.stock = 40; // White: 3 → 40
  assert.deepEqual(await t.cat.syncProduct(product.id), { priceUpdates: 1, stockUpdates: 1 });
  const b = t.store.base;
  assert.deepEqual(t.store.priceCalls[0], [{ variantGid: `gid://shopify/ProductVariant/${b}`, price: 329, cost: 161 }]);
  assert.deepEqual(t.store.stockCalls[0], [{ inventoryItemGid: `gid://shopify/InventoryItem/${b + 1 - 1000}`, quantity: 38 }]);
  assert.ok(t.repo.db.prepare("SELECT message FROM events WHERE message LIKE '%239 → 329%'").get(), "varování o velké změně ceny");

  t.src.product.available = false;
  await t.cat.syncProduct(product.id);
  assert.deepEqual(t.store.stockCalls.at(-1)!.map((s) => s.quantity), [0, 0]);
});

test("syncAll přeskočí pozastavené produkty a chyby počítá", async () => {
  const t = setup();
  const { product } = await t.cat.importProduct(t.shopId, "1005006543210987");
  t.cat.setStatus(product.id, "PAUSED");
  assert.equal((await t.cat.syncAll()).products, 0);
  t.cat.setStatus(product.id, "ACTIVE");
  t.src.product.productId = "999"; // AE vrátí chybu
  const r = await t.cat.syncAll();
  assert.equal(r.errors, 1);
  assert.match(t.cat.get(product.id).product.last_error!, /not found/);
});

test("ShopifyCatalog posílá správné mutace (productSet, bulk update, inventory s idempotency)", async () => {
  const bodies: { query: string; variables: any }[] = [];
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    bodies.push(b);
    let data: unknown = {};
    if (b.query.includes("productSet"))
      data = {
        productSet: {
          product: { id: "gid://shopify/Product/1", variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", selectedOptions: [{ name: "Title", value: "Default Title" }], inventoryItem: { id: "gid://shopify/InventoryItem/21" } }] } },
          userErrors: [],
        },
      };
    if (b.query.includes("productVariantsBulkUpdate")) data = { productVariantsBulkUpdate: { userErrors: [] } };
    if (b.query.includes("inventorySetQuantities")) data = { inventorySetQuantities: { userErrors: [] } };
    return new Response(JSON.stringify({ data }));
  }) as unknown as typeof fetch;
  const sc = new ShopifyCatalog(new ShopifyStore({ shop: "a.myshopify.com", adminToken: "t", apiVersion: "2026-10" }, fakeFetch));
  const c = await sc.createProduct(
    { title: "X", descriptionHtml: "", images: ["https://img/1.jpg"], options: [], variants: [{ options: [], price: 299, cost: 120.5, sku: "AE-1-1", quantity: 5 }] },
    "gid://shopify/Location/1",
  );
  assert.deepEqual(c.variants[0]!.options, [], "výchozí varianta nemá volby");
  const input = bodies[0]!.variables.input;
  assert.equal(input.status, "DRAFT");
  assert.deepEqual(input.variants[0].optionValues, [{ optionName: "Title", name: "Default Title" }]);
  assert.equal(input.variants[0].price, "299.00");
  assert.deepEqual(input.variants[0].inventoryItem, { tracked: true, cost: "120.50" });
  assert.deepEqual(input.variants[0].inventoryQuantities, [{ locationId: "gid://shopify/Location/1", name: "available", quantity: 5 }]);

  await sc.updateVariants("gid://shopify/Product/1", [{ variantGid: "gid://shopify/ProductVariant/11", price: 349, cost: 130 }]);
  assert.deepEqual(bodies[1]!.variables.variants, [{ id: "gid://shopify/ProductVariant/11", price: "349.00", inventoryItem: { cost: "130.00" } }]);

  await sc.setInventory("gid://shopify/Location/1", [{ inventoryItemGid: "gid://shopify/InventoryItem/21", quantity: 0 }]);
  assert.match(bodies[2]!.query, /@idempotent\(key: \$key\)/);
  assert.ok(bodies[2]!.variables.key);
  assert.deepEqual(bodies[2]!.variables.input.quantities[0], { inventoryItemId: "gid://shopify/InventoryItem/21", locationId: "gid://shopify/Location/1", quantity: 0, changeFromQuantity: null });
});
