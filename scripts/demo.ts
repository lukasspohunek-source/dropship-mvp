/**
 * Demo: rozhraní s ukázkovými daty, bez AliExpressu a Shopify (vše falešné, v paměti).
 *   npm run demo   → http://localhost:3100/app/  token: demo-token-0123456789-abcdef
 */
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

const app = createApp({
  repo, orders, tracking, shops,
  oauth: { authorizeUrl: () => "https://example.com/ae-oauth-demo", handleCallback: async () => {}, isAuthorized: () => true },
  onOrderCreated: (id, inc) => void crm.recordOrder(id, inc),
  extraAdmin: [catalogRouter(catalog, shops, () => orders.reprocessWaitingForMapping()), crmRouter(crm), complianceRouter(compliance)],
  cfg: { adminToken: TOKEN, publicBaseUrl: `http://localhost:${PORT}`, dryRun: false, autoPay: true },
});
app.listen(PORT, () => console.log(`DEMO: http://localhost:${PORT}/app/  token: ${TOKEN}`));
