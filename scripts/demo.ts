/**
 * Demo: rozhraní s ukázkovými daty, bez AliExpressu a Shopify (vše falešné, v paměti).
 *   npm run demo   → http://localhost:3100/app/  token: demo-token-0123456789-abcdef
 */
import { AdsService, DEFAULT_THRESHOLDS, adsRouter, type AdRow } from "../src/ads.js";
import { parseAeProduct } from "../src/aliexpress.js";
import { CatalogService, catalogRouter, type CatalogStore } from "../src/catalog.js";
import { ComplianceService, complianceRouter } from "../src/compliance.js";
import { SecretBox } from "../src/crypto.js";
import { CrmService, crmRouter } from "../src/crm.js";
import { Repo } from "../src/db.js";
import { OrderService } from "../src/orders.js";
import { createApp } from "../src/server.js";
import { ShopService } from "../src/shops.js";
import { TrackingService } from "../src/tracking.js";
import { TrendService, trendsRouter } from "../src/trends.js";
import type { AeProduct, CatalogSource, IncomingOrder, PlaceResult, Store, Supplier, SupplierOrderInfo } from "../src/types.js";

const PORT = Number(process.env.PORT ?? 3100);
const TOKEN = "demo-token-0123456789-abcdef";
const repo = new Repo(":memory:");
const shops = new ShopService(repo, new SecretBox("demo-secret-key-0123456789-abcdefghij"), {
  apiVersion: "2026-10",
  autoPayMaxOrderTotal: 1500,
  pricing: { fxRate: 23, multiplier: 2.2, fixedAdd: 0, roundStep: 10, roundOffset: 1, stockBuffer: 2, stockCap: 50, priceAlertPct: 15 },
});

const sku = (id: string, color: string, price: string, stock: number) => ({
  id, offer_sale_price: price, sku_available_stock: stock, currency_code: "USD",
  ae_sku_property_dtos: { ae_sku_property_d_t_o: [{ sku_property_id: 14, sku_property_name: "Barva", sku_property_value: color }] },
});
const DEMO_PRODUCT = parseAeProduct({
  ae_item_base_info_dto: { product_id: 1005006543210987, subject: "LED stolní lampa s USB-C", detail: "<p>Stmívatelná lampa.</p>", product_status_type: "onSelling" },
  ae_multimedia_info_dto: { image_urls: "" },
  ae_item_sku_info_dtos: [sku("14:193#Black", "Černá", "6.40", 120), sku("14:175#White", "Bílá", "6.10", 8)],
}, "USD");

class DemoSupplier implements Supplier, CatalogSource {
  n = 0;
  async placeOrder(): Promise<PlaceResult> {
    return { kind: "ok", aeOrderIds: [`81000000000${String(++this.n).padStart(5, "0")}`] };
  }
  async getOrder(): Promise<SupplierOrderInfo> {
    return { orderStatus: "WAIT_BUYER_ACCEPT_GOODS", logisticsStatus: "SELLER_SEND_GOODS", productIds: [], tracking: [{ number: `LP${Date.now()}CZ`, carrier: "CAINIAO_STANDARD" }] };
  }
  async getProduct(id: string): Promise<AeProduct> {
    if (id !== DEMO_PRODUCT.productId) throw new Error("V demu jde importovat jen produkt 1005006543210987");
    return structuredClone(DEMO_PRODUCT);
  }
}
let gid = 1000;
const demoStore: Store & CatalogStore = {
  async fulfill() { return { fulfillmentIds: [`gid://shopify/Fulfillment/${++gid}`], nothingOpen: false }; },
  async primaryLocation() { return "gid://shopify/Location/1"; },
  async createProduct(p) {
    return { productGid: `gid://shopify/Product/${++gid}`, variants: p.variants.map((v) => ({ gid: `gid://shopify/ProductVariant/${++gid}`, inventoryItemGid: `gid://shopify/InventoryItem/${gid}`, options: v.options })) };
  },
  async updateVariants() {},
  async setInventory() {},
};

const supplier = new DemoSupplier();
const orders = new OrderService(repo, supplier, { dryRun: false, autoPay: { enabled: true, maxPerDay: 20 } }, (id) => shops.get(id).autoPayMaxOrderTotal);
const tracking = new TrackingService(repo, supplier, () => demoStore, { notifyCustomer: false, unpaidWarnHours: 6, urlTemplate: "" });
const catalog = new CatalogService(repo, supplier, shops, () => demoStore);
const crm = new CrmService(repo);
const compliance = new ComplianceService(repo, shops, crm, { sellerCountry: "CZ", fxToEur: { EUR: 1, CZK: 0.04 }, retentionYears: 0 });

// ---- ukázková data ----
const cz = shops.create({ domain: "pokovo-demo.myshopify.com", name: "Pokovo CZ", currency: "CZK", country: "CZ", adminToken: "x", webhookSecret: "y" }).id;
const sk = shops.create({ domain: "pokovo-sk-demo.myshopify.com", name: "Pokovo SK", currency: "EUR", country: "SK", adminToken: "x", webhookSecret: "y", autoPayMaxOrderTotal: 60, pricing: { fxRate: 0.93 } }).id;
compliance.setSeller(cz, { legalName: "Pokovo s.r.o.", address: "Radošovice 1, 370 01", ico: "12345678", email: "info@pokovo.cz" });

const { product } = await catalog.importProduct(cz, "https://www.aliexpress.com/item/1005006543210987.html");
const variant = catalog.get(product.id).variants[0]!.shopify_variant_id;

const mk = (n: number, over: Partial<IncomingOrder>, shopId = cz): number => {
  const o: IncomingOrder = {
    shopifyOrderId: String(7000 + n), shopifyOrderGid: `gid://shopify/Order/${7000 + n}`, name: `#${1000 + n}`, currency: "CZK", totalPrice: 549, totalTax: 95.28,
    email: `zakaznik${n}@example.cz`,
    address: { fullName: ["Jana Dvořáková", "Petr Svoboda", "Eva Malá", "Tomáš Černý", "Lucie Králová"][n % 5]!, address1: "Hlavní 12", address2: null, city: ["Praha", "Brno", "Písek", "Tábor", "Bratislava"][n % 5]!, province: null, zip: "37001", countryCode: shopId === sk ? "SK" : "CZ", phone: "+420777123456" },
    lines: [{ lineItemGid: `gid://shopify/LineItem/${n}`, variantId: variant, title: "LED stolní lampa – Černá", sku: null, quantity: 1, requiresShipping: true }],
    customer: { email: `zakaznik${n}@example.cz`, name: null, phone: null, acceptsMarketing: n % 2 === 0, consentAt: n % 2 === 0 ? new Date().toISOString() : null },
    ...over,
  };
  const { id } = orders.ingest(o, shopId);
  crm.recordOrder(id, o);
  return id;
};
for (const id of [mk(1, {}), mk(2, {}), mk(3, { totalPrice: 2490 })]) await orders.process(id);
await orders.process(mk(4, { lines: [{ lineItemGid: "gid://shopify/LineItem/99", variantId: "55555", title: "Háček na zeď (nenamapováno)", sku: null, quantity: 2, requiresShipping: true }] }));
await orders.process(mk(5, { address: { fullName: "Bez Telefonu", address1: "Polní 5", address2: null, city: "Tábor", province: null, zip: "39001", countryCode: "CZ", phone: null } }));
await orders.process(mk(6, { currency: "EUR", totalPrice: 89, totalTax: 14.83 }, sk));
await tracking.syncAll();

const firstOrder = repo.listOrders({}).at(-1)!.id;
crm.createTicket({ type: "COMPLAINT", orderId: firstOrder, reason: "Lampa bliká", filedAt: new Date(Date.now() - 32 * 86400e3).toISOString().slice(0, 10) });
crm.createTicket({ type: "WITHDRAWAL", orderId: firstOrder + 1, reason: "Nevyhovuje barva", deliveredAt: new Date(Date.now() - 5 * 86400e3).toISOString().slice(0, 10) });
crm.createLead({ name: "Hotel Šumava", company: "Šumava a.s.", email: "nakup@sumava.cz", value: 85000, currency: "CZK", source: "veletrh", stage: "PROPOSAL" });
crm.createLead({ name: "Kavárna U Mostu", stage: "NEW", source: "Instagram" });
crm.createTask({ title: "Zavolat hotelu Šumava kvůli nabídce", dueDate: new Date(Date.now() - 86400e3).toISOString().slice(0, 10), priority: "HIGH" });
crm.createTask({ title: "Objednat vzorky nových lamp", dueDate: new Date().toISOString().slice(0, 10) });
crm.createSegment({ name: "Věrní zákazníci CZ", filter: { country: "CZ", minOrders: 1 } });

const trends = new TrendService(
  repo,
  shops,
  [
    { id: "google_trends", label: "Google Trends (demo)", fetch: async (q) => q.seeds.map((s, i) => ({ source: "google_trends", term: `${s} usb-c`, score: 90 - i * 10, detail: "roste +250 %" })) },
    { id: "tiktok", label: "TikTok (demo)", caveat: "Scraping přes Bright Data – v rozporu s podmínkami platformy.", fetch: async () => [{ source: "tiktok", term: "Stolní lampa, která se nabíjí magnetem #lampa", score: 82, detail: "1,2 mil. zhlédnutí" }] },
  ],
  async () => [{ productId: "1005006543210987", title: "Magnetic LED desk lamp USB-C", priceAe: 6.1, currency: "USD", orders: 5400, rating: 96.4, url: null }],
  {
    analyze: async (i) => ({
      summary: `Napříč zdroji roste zájem o nabíjecí lampy (${i.signals.length} signálů). Doporučuji otestovat 1–2 varianty.`,
      candidates: [
        { name: "Magnetická LED lampa s USB-C", why: "Roste na Google Trends i TikToku, malá a lehká, AliExpress má produkt s 5 400 objednávkami.", evidence: ["google_trends: lampa usb-c +250 %", "tiktok: 1,2 mil. zhlédnutí"], searchKeywords: ["magnetic led desk lamp"], aeProductId: "1005006543210987", expectedSellPrice: 349, score: 86, risks: ["Li-ion baterie – omezení přepravy", "Elektro – CE/GPSR údaje od výrobce"] },
        { name: "Organizér kabelů na stůl", why: "Doplňkový prodej k lampě, stabilní poptávka.", evidence: ["google_trends: organizér kabelů"], searchKeywords: ["desk cable organizer"], aeProductId: null, expectedSellPrice: null, score: 58, risks: [] },
      ],
    }),
  },
  { maxRunsPerDay: 50 },
  catalog,
);

// ---- reklamy (falešná Meta, 14 dní dat) ----
const daysAgo = (d: number) => new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10);
for (let d = 13; d >= 1; d -= 2) {
  const id = mk(100 + d, { shopifyOrderId: String(9000 + d), name: `#2${100 + d}`, totalPrice: 549, attribution: { utmSource: "facebook", utmMedium: "paid", utmCampaign: "Lampa CZ 1005006543210987", utmContent: null, sourceName: "web" } });
  repo.db.prepare("UPDATE orders SET created_at = ?, status = 'FULFILLED' WHERE id = ?").run(`${daysAgo(d)}T09:00:00.000Z`, id);
}
const fakeMeta = {
  account: async (id: string) => ({ id, name: "Pokovo reklamy", currency: "CZK" }),
  insights: async (): Promise<AdRow[]> => {
    const rows: AdRow[] = [];
    for (let d = 13; d >= 0; d--) {
      const fatigue = d <= 2 ? 0.4 : 1;
      rows.push({ date: daysAgo(d), adId: "120200000000001", adName: "Video lampa", adsetId: "120200000000010", adsetName: "CZ 25–45", campaignId: "120200000000100", campaignName: "Lampa CZ 1005006543210987", spend: 60, impressions: 2400, clicks: Math.round(36 * fatigue), purchases: d % 2 ? 1 : 0, purchaseValue: d % 2 ? 549 : 0 });
      rows.push({ date: daysAgo(d), adId: "120200000000002", adName: "Obrázek zima", adsetId: "120200000000020", adsetName: "Zájmy", campaignId: "120200000000200", campaignName: "Obecná – zimní", spend: 45, impressions: 900, clicks: 5, purchases: 0, purchaseValue: 0 });
    }
    return rows;
  },
};
const ads = new AdsService(
  repo,
  shops,
  fakeMeta,
  {
    advise: async (i) => ({
      summary: `Za ${i.period.from} – ${i.period.to} je zisk před reklamou ${Math.round(i.totals.grossProfit)} ${i.shop.currency} a útrata ${Math.round(i.totals.spend)} ${i.shop.currency}. Kampaň na lampu vydělává, obecná kampaň utrácí bez prodeje.`,
      actions: i.findings.slice(0, 3).map((f, k) => ({ title: f.title, why: f.detail, steps: [f.action], findingIds: [f.id], priority: k + 1 })),
    }),
  },
  { feePct: 2, feeFixed: 0, fxToEur: { EUR: 1, CZK: 0.04 }, thresholds: DEFAULT_THRESHOLDS },
);
await ads.addAccount(cz, "act_1234567890");
await ads.syncAll();
await ads.analyze(cz, 14);

const app = createApp({
  repo, orders, tracking, shops,
  oauth: { authorizeUrl: () => "https://example.com/ae-oauth-demo", handleCallback: async () => {}, isAuthorized: () => true },
  onOrderCreated: (id, inc) => void crm.recordOrder(id, inc),
  extraAdmin: [catalogRouter(catalog, shops, () => orders.reprocessWaitingForMapping()), crmRouter(crm), complianceRouter(compliance), trendsRouter(trends, () => orders.reprocessWaitingForMapping()), adsRouter(ads)],
  cfg: { adminToken: TOKEN, publicBaseUrl: `http://localhost:${PORT}`, dryRun: false, autoPay: true },
});
app.listen(PORT, () => console.log(`DEMO: http://localhost:${PORT}/app/  token: ${TOKEN}`));
