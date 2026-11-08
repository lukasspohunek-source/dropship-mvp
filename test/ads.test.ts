import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  AdsService,
  ClaudeAdsAdvisor,
  DEFAULT_THRESHOLDS,
  MetaAdsClient,
  analyzeStats,
  convert,
  pickAction,
  type AdRow,
  type AdsSource,
  type AdsStats,
  type Advice,
} from "../src/ads.js";
import { Repo } from "../src/db.js";
import { parseAttribution, parseOrderWebhook } from "../src/shopify.js";
import type { OrderLine } from "../src/types.js";
import { memRepo, order, seedShop, shopService } from "./helpers.js";

const FX = { EUR: 1, CZK: 0.04, USD: 0.92 };
const DEFAULT_PRICING_FOR_TEST = { fxRate: 23, multiplier: 2, fixedAdd: 0, roundStep: 10, roundOffset: 1, stockBuffer: 2, stockCap: 50, priceAlertPct: 15 };
const CFG = { feePct: 2, feeFixed: 0, fxToEur: FX, thresholds: DEFAULT_THRESHOLDS };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

test("pickAction: první typ nákupu podle priority, bez dvojího sčítání", () => {
  assert.equal(pickAction([{ action_type: "link_click", value: "40" }, { action_type: "purchase", value: "3" }, { action_type: "omni_purchase", value: "4" }]), 4);
  assert.equal(pickAction([{ action_type: "offsite_conversion.fb_pixel_purchase", value: "2" }]), 2);
  assert.equal(pickAction(undefined), 0);
});

test("MetaAdsClient: Bearer token, stránkování, chyba 190 s nápovědou", async () => {
  const urls: string[] = [];
  const auth: string[] = [];
  const client = new MetaAdsClient("TOKEN", "v26.0", (async (u: string, init: RequestInit) => {
    urls.push(u);
    auth.push((init.headers as Record<string, string>).Authorization!);
    if (u.includes("/insights?") && !u.includes("after=")) return json({ data: [{ date_start: "2026-11-01", ad_id: "1", campaign_id: "10", campaign_name: "K1", spend: "12.50", impressions: "1000", clicks: "20", actions: [{ action_type: "purchase", value: "1" }], action_values: [{ action_type: "purchase", value: "30.5" }] }], paging: { next: "https://graph.facebook.com/v26.0/act_123/insights?after=X" } });
    if (u.includes("after=X")) return json({ data: [{ date_start: "2026-11-02", ad_id: "1", spend: "5" }] });
    return json({ name: "Pokovo Ads", currency: "czk" });
  }) as typeof fetch);
  assert.deepEqual(await client.account("act_123"), { id: "123", name: "Pokovo Ads", currency: "CZK" });
  const rows = await client.insights("act_123", "2026-11-01", "2026-11-02");
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0]!.spend, rows[0]!.purchases, rows[0]!.purchaseValue], [12.5, 1, 30.5]);
  assert.match(urls[1]!, /^https:\/\/graph\.facebook\.com\/v26\.0\/act_123\/insights\?/);
  assert.match(decodeURIComponent(urls[1]!), /time_range=\{"since":"2026-11-01","until":"2026-11-02"\}/);
  assert.ok(!urls.some((u) => u.includes("TOKEN")), "token nesmí být v URL");
  assert.ok(auth.every((a) => a === "Bearer TOKEN"));
  const bad = new MetaAdsClient("T", "v26.0", (async () => json({ error: { code: 190, message: "Invalid OAuth access token" } }, 400)) as unknown as typeof fetch);
  await assert.rejects(bad.account("1"), /190.*META_ACCESS_TOKEN/);
});

test("UTM a cena položky z webhooku Shopify", () => {
  assert.deepEqual(parseAttribution({ landing_site: "/products/lampa?utm_source=facebook&utm_medium=paid&utm_campaign=Lampa%20CZ&fbclid=x", source_name: "web" }), {
    utmSource: "facebook", utmMedium: "paid", utmCampaign: "Lampa CZ", utmContent: null, sourceName: "web",
  });
  assert.equal(parseAttribution({ landing_site: "/" }), null);
  const o = parseOrderWebhook({ id: 1, line_items: [{ id: 1, variant_id: 5, title: "x", quantity: 2, price: "299.00", total_discount: "50.00" }] });
  assert.equal(o.lines[0]!.unitPrice, 274);
});

test("convert přes EUR", () => {
  assert.equal(Math.round(convert(10, "USD", "CZK", FX)!), 230);
  assert.equal(convert(10, "GBP", "CZK", FX), null);
  assert.equal(convert(10, "CZK", "CZK", FX), 10);
});

// ---------- statistiky ----------

function setup(today = "2026-11-08") {
  const clock = () => new Date(`${today}T12:00:00Z`);
  const repo = memRepo(clock);
  const shopId = seedShop(repo);
  const shops = shopService(repo);
  const t = clock().toISOString();
  const addProduct = (ae: string, title: string, cost: number, stock = 20) => {
    const pid = Number(repo.db.prepare("INSERT INTO products (shop_id, ae_product_id, title, ae_currency, created_at, updated_at) VALUES (?, ?, ?, 'USD', ?, ?)").run(shopId, ae, title, t, t).lastInsertRowid);
    const vid = String(9000 + pid);
    repo.db.prepare("INSERT INTO mappings (shopify_variant_id, shop_id, product_id, ae_product_id, last_cost, last_stock, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(vid, shopId, pid, ae, cost, stock, t);
    return { pid, vid };
  };
  let n = 0;
  const addOrder = (day: string, lines: { vid: string; qty: number; price?: number }[], gross: number, utm: string | null = null) => {
    n++;
    const ls: OrderLine[] = lines.map((l, i) => ({ lineItemGid: `gid://shopify/LineItem/${n}${i}`, variantId: l.vid, title: "x", sku: null, quantity: l.qty, requiresShipping: true, unitPrice: l.price ?? null }));
    const { id } = repo.insertOrder(order({ shopifyOrderId: `o${n}`, totalPrice: gross, totalTax: Math.round((gross - gross / 1.21) * 100) / 100, lines: ls, attribution: utm ? { utmSource: "facebook", utmMedium: null, utmCampaign: utm, utmContent: null, sourceName: null } : null }), shopId);
    repo.db.prepare("UPDATE orders SET created_at = ?, status = 'FULFILLED' WHERE id = ?").run(`${day}T10:00:00.000Z`, id);
    return id;
  };
  const addAccount = (accountId: string, currency: string) => repo.db.prepare("INSERT INTO ad_accounts (shop_id, account_id, currency, created_at) VALUES (?, ?, ?, ?)").run(shopId, accountId, currency, t);
  const addStat = (accountId: string, r: Partial<AdRow> & { date: string; adId: string }) =>
    repo.db
      .prepare("INSERT INTO ad_stats (platform, account_id, date, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, spend, impressions, clicks, purchases, purchase_value, updated_at) VALUES ('meta', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(accountId, r.date, r.adId, r.adName ?? null, r.adsetId ?? null, r.adsetName ?? null, r.campaignId ?? null, r.campaignName ?? null, r.spend ?? 0, r.impressions ?? 0, r.clicks ?? 0, r.purchases ?? 0, r.purchaseValue ?? 0, t);
  return { repo, shopId, shops, clock, addProduct, addOrder, addAccount, addStat };
}

test("zisk po reklamě: tržba bez DPH, náklad z AE, poplatky, vratky; přiřazení podle názvu, vazby i UTM", () => {
  const s = setup();
  const lamp = s.addProduct("1005006543210987", "Lampa", 5); // 5 USD × 23 = 115 Kč
  const hook = s.addProduct("1005009999999999", "Háček", 1);
  // 2 objednávky lampy (605 Kč s DPH = 500 bez DPH), jedna s háčkem v košíku
  const o1 = s.addOrder("2026-11-05", [{ vid: lamp.vid, qty: 1, price: 484 }, { vid: hook.vid, qty: 1, price: 121 }], 605, "Lampa CZ");
  s.addOrder("2026-11-06", [{ vid: lamp.vid, qty: 1 }], 605);
  s.repo.db.prepare("INSERT INTO tickets (type, order_id, status, resolution, reason, filed_at, deadline, refund_amount, created_at, updated_at) VALUES ('COMPLAINT', ?, 'RESOLVED', 'REFUND', 'x', '2026-11-07', '2026-12-07', 121, ?, ?)").run(o1, s.clock().toISOString(), s.clock().toISOString());
  s.addAccount("111", "USD");
  s.addStat("111", { date: "2026-11-05", adId: "a1", campaignId: "c1", campaignName: "Lampa CZ 1005006543210987", spend: 10, impressions: 2000, clicks: 30, purchases: 2, purchaseValue: 50 });
  s.addStat("111", { date: "2026-11-06", adId: "a2", campaignId: "c2", campaignName: "Obecná", spend: 5, impressions: 500, clicks: 5 });
  const ads = new AdsService(s.repo, s.shops, null, null, CFG, s.clock);
  ads.setLink("campaign", "1234", lamp.pid); // vazba na neexistující kampaň nevadí
  const st: AdsStats = ads.stats(s.shopId, "2026-11-01", "2026-11-08");

  const L = st.products.find((p) => p.productId === lamp.pid)!;
  // revenue lampy: o1 500 × 484/605 = 400; o2 500 → 900
  assert.equal(L.revenue, 900);
  assert.equal(L.cogs, 230);
  assert.equal(L.fees, 18);
  assert.equal(L.refunds, 80, "vratka 121 s DPH → 100 bez DPH, podíl lampy 80 %");
  assert.equal(L.grossProfit, 572);
  assert.equal(L.spend, 230, "10 USD → 230 Kč, kampaň přiřazená podle ID v názvu");
  assert.equal(L.profitAfterAds, 342);
  assert.equal(L.orders, 2);
  assert.equal(L.metaPurchases, 2);
  assert.equal(L.breakEvenRoas, 1.57);
  assert.equal(L.roas, 3.91);
  const H = st.products.find((p) => p.productId === hook.pid)!;
  assert.equal(H.revenue, 100);
  assert.equal(st.totals.spend, 345);
  assert.equal(st.totals.unlinkedSpend, 115);
  assert.equal(st.totals.orders, 2);
  const c1 = st.campaigns.find((c) => c.campaignId === "c1")!;
  assert.equal(c1.ctrPct, 1.5);
  assert.equal(c1.metaValue, 1150);
  const day5 = st.daily.find((d) => d.date === "2026-11-05")!;
  assert.equal(day5.spend, 230);
  assert.equal(st.daily.length, 8);

  // explicitní vazba má přednost před názvem
  ads.setLink("campaign", "2000", hook.pid);
  s.addStat("111", { date: "2026-11-07", adId: "a3", campaignId: "2000", campaignName: "Lampa 1005006543210987", spend: 1 });
  assert.equal(ads.stats(s.shopId, "2026-11-07", "2026-11-07").products.find((p) => p.productId === hook.pid)!.spend, 23);
  assert.throws(() => ads.setLink("kampan", "1", 1), /level/);
  assert.throws(() => ads.setLink("ad", "abc", 1), /metaId/);
});

test("UTM objednávky se spárují s kampaní podle názvu", () => {
  const s = setup();
  const lamp = s.addProduct("1005006543210987", "Lampa", 5);
  s.addOrder("2026-11-05", [{ vid: lamp.vid, qty: 1 }], 605, "lampa cz");
  s.addAccount("111", "CZK");
  s.addStat("111", { date: "2026-11-05", adId: "a1", campaignId: "c1", campaignName: "Lampa CZ", spend: 100, purchases: 4 });
  const st = new AdsService(s.repo, s.shops, null, null, CFG, s.clock).stats(s.shopId, "2026-11-01", "2026-11-08");
  const c = st.campaigns[0]!;
  assert.equal(c.utmOrders, 1);
  assert.equal(c.utmRevenue, 500);
});

test("chybějící kurz účtu se ohlásí", () => {
  const s = setup();
  s.addAccount("111", "GBP");
  s.addStat("111", { date: "2026-11-05", adId: "a1", campaignId: "c1", spend: 10 });
  const st = new AdsService(s.repo, s.shops, null, null, CFG, s.clock).stats(s.shopId, "2026-11-01", "2026-11-08");
  assert.ok(st.warnings.some((w) => /GBP/.test(w)));
});

// ---------- pravidla ----------

function baseStats(over: Partial<AdsStats> = {}): AdsStats {
  return {
    shopId: 1, currency: "CZK", from: "2026-11-01", to: "2026-11-14",
    totals: { orders: 0, revenue: 0, cogs: 0, fees: 0, refunds: 0, grossProfit: 0, spend: 0, profitAfterAds: 0, mer: null, unlinkedSpend: 0, metaPurchases: 0, costSource: { actual: 0, estimated: 0, missing: 0 } },
    customers: { newCustomers: 0, returningOrders: 0, returningSharePct: null, ncac: null, avgFirstOrderProfit: null, ltv90Revenue: null, ltv90Profit: null, ltvCohortSize: 0 },
    products: [], campaigns: [], daily: [], warnings: [], ...over,
  };
}
const P = (o: Partial<AdsStats["products"][number]>) => ({ productId: 1, title: "Lampa", aeProductId: "1", orders: 0, units: 0, revenue: 0, cogs: 0, fees: 0, refunds: 0, grossProfit: 0, spend: 0, profitAfterAds: 0, marginPct: null, breakEvenRoas: null, roas: null, cpa: null, metaPurchases: 0, stockOut: false, missingCost: false, ...o });
const C = (o: Partial<AdsStats["campaigns"][number]>) => ({ campaignId: "c1", name: "K1", spend: 0, impressions: 0, clicks: 0, ctrPct: null, cpc: null, metaPurchases: 0, metaValue: 0, metaRoas: null, utmOrders: 0, utmRevenue: 0, productIds: [], ctrLast3Pct: null, ctrPrev7Pct: null, linked: false, ...o });
const ids = (s: AdsStats) => analyzeStats(s, DEFAULT_THRESHOLDS, FX).map((f) => f.id);

test("pravidla: ztráta, škálování, vyprodáno, nízká marže, organický prodej, chybějící cena", () => {
  assert.deepEqual(ids(baseStats({ products: [P({ units: 4, orders: 4, revenue: 2000, grossProfit: 600, spend: 900, profitAfterAds: -300, roas: 2.22, breakEvenRoas: 3.33, marginPct: 30 })] })), ["loss-1"]);
  assert.deepEqual(ids(baseStats({ products: [P({ units: 4, orders: 4, revenue: 2000, grossProfit: 600, spend: 200, profitAfterAds: 400, roas: 10, breakEvenRoas: 3.33, marginPct: 30 })] })), [], "4 objednávky < 5 → ještě neškálovat");
  const scale = analyzeStats(baseStats({ products: [P({ units: 6, orders: 6, revenue: 3000, grossProfit: 900, spend: 300, profitAfterAds: 600, roas: 10, breakEvenRoas: 3.33, marginPct: 30 })] }), DEFAULT_THRESHOLDS, FX);
  assert.equal(scale[0]!.id, "scale-1");
  assert.match(scale[0]!.action, /20 %/);
  assert.deepEqual(ids(baseStats({ products: [P({ spend: 50, stockOut: true })] })), ["stockout-1"], "50 Kč < 15 € → bez verdiktu o ztrátě, ale vyprodáno platí vždy");
  assert.deepEqual(ids(baseStats({ products: [P({ orders: 3, units: 3, revenue: 1000, grossProfit: 150, marginPct: 15, breakEvenRoas: 6.67 })] })), ["margin-1", "organic-1"]);
  assert.deepEqual(ids(baseStats({ products: [P({ revenue: 100, grossProfit: 100, missingCost: true, marginPct: 100 })] })), ["cost-1"]);
  assert.deepEqual(ids(baseStats({ products: [P({ productId: null, spend: 9999, profitAfterAds: -9999 })] })), [], "nenamapované položky nemají verdikt");
});

test("pravidla: kampaň bez prodeje, slabé CTR, únava, pixel, nepřiřazená útrata, ztrátový e-shop; řazení podle závažnosti", () => {
  const f = analyzeStats(
    baseStats({
      totals: { orders: 2, revenue: 1000, cogs: 0, fees: 0, refunds: 0, grossProfit: 400, spend: 1000, profitAfterAds: -600, mer: 1, unlinkedSpend: 600, metaPurchases: 6, costSource: { actual: 0, estimated: 0, missing: 0 } },
      campaigns: [
        C({ campaignId: "a", spend: 800, clicks: 40, impressions: 10000, ctrPct: 0.4 }),
        C({ campaignId: "b", spend: 200, impressions: 4000, clicks: 60, ctrPct: 1.5, ctrLast3Pct: 0.8, ctrPrev7Pct: 2, metaPurchases: 6, utmOrders: 2 }),
      ],
    }),
    DEFAULT_THRESHOLDS,
    FX,
  );
  assert.deepEqual(f.map((x) => x.id), ["noconv-a", "shop-loss", "ctr-a", "fatigue-b", "pixel-b", "unlinked"]);
  assert.equal(f[0]!.severity, "critical");
});

// ---------- analýza + AI ----------

test("analyze: uloží report; AI ID mimo nálezy se zahodí, priorita oříznutá; chyba AI report nezastaví", async () => {
  const s = setup();
  const lamp = s.addProduct("1005006543210987", "Lampa", 20);
  s.addOrder("2026-11-05", [{ vid: lamp.vid, qty: 1 }], 605);
  s.addAccount("111", "CZK");
  s.addStat("111", { date: "2026-11-05", adId: "a1", campaignId: "c1", campaignName: "Lampa 1005006543210987", spend: 900, impressions: 5000, clicks: 100, purchases: 1 });
  const advice: Advice = { summary: "Lampa prodělává.", actions: [{ title: "Pozastav", why: "ztráta", steps: ["Ads Manager → pozastavit"], findingIds: ["loss-" + lamp.pid, "vymysleny"], priority: 7 }] };
  let seen: any;
  const ads = new AdsService(s.repo, s.shops, null, { advise: async (i) => ((seen = i), advice) }, CFG, s.clock);
  const rep = await ads.analyze(s.shopId, 14);
  assert.equal(rep.from, "2026-10-26");
  assert.ok(rep.findings.some((f) => f.id === `loss-${lamp.pid}`));
  assert.deepEqual(rep.ai!.actions[0]!.findingIds, [`loss-${lamp.pid}`]);
  assert.equal(rep.ai!.actions[0]!.priority, 3);
  assert.equal(seen.shop.currency, "CZK");
  assert.equal(ads.listReports()[0]!.critical >= 1, true);

  const failing = new AdsService(s.repo, s.shops, null, { advise: async () => { throw new Error("AI down"); } }, CFG, s.clock);
  const r2 = await failing.analyze(s.shopId, 7);
  assert.equal(r2.ai, null);
  assert.equal(r2.aiError, "AI down");
  await assert.rejects(ads.analyze(s.shopId, 1), /3–90/);
});

test("ClaudeAdsAdvisor: Opus 5.5, fallbacks default, JSON schéma, žádné nucené nástroje", async () => {
  let sent: any;
  const client = new Anthropic({
    apiKey: "k",
    maxRetries: 0,
    fetch: (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return json({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify({ summary: "S", actions: [] }) }], stop_reason: "end_turn", stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }) as unknown as typeof fetch,
  });
  const out = await new ClaudeAdsAdvisor(client).advise({ shop: { name: "P", currency: "CZK" }, period: { from: "a", to: "b" }, totals: baseStats().totals, products: [], campaigns: [], findings: [] });
  assert.equal(out.summary, "S");
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.fallbacks, "default");
  assert.equal(sent.output_config.format.type, "json_schema");
  assert.equal(sent.tool_choice, undefined);
  assert.match(sent.system, /VÝHRADNĚ čísla ze vstupu/);
});

test("sync: zápis řádků, přepis stejných dnů, chyba účtu se uloží", async () => {
  const s = setup();
  s.addAccount("111", "CZK");
  s.addAccount("222", "CZK");
  let spend = 10;
  const src: AdsSource = {
    account: async () => ({ id: "1", name: null, currency: "CZK" }),
    insights: async (acc) => {
      if (acc === "222") throw new Error("Meta API (190): token");
      return [{ date: "2026-11-08", adId: "a1", adName: null, adsetId: null, adsetName: null, campaignId: "c", campaignName: "K", spend, impressions: 1, clicks: 0, purchases: 0, purchaseValue: 0 }];
    },
  };
  const ads = new AdsService(s.repo, s.shops, src, null, CFG, s.clock);
  assert.deepEqual(await ads.syncAll(), { accounts: 2, rows: 1, errors: 1 });
  spend = 25;
  await ads.syncAll();
  assert.equal((s.repo.db.prepare("SELECT spend FROM ad_stats").get() as { spend: number }).spend, 25);
  assert.match((s.repo.db.prepare("SELECT last_error FROM ad_accounts WHERE account_id = '222'").get() as { last_error: string }).last_error, /190/);
});

test("addAccount: bez Meta 409-chyba, validace ID, duplicita", async () => {
  const s = setup();
  await assert.rejects(new AdsService(s.repo, s.shops, null, null, CFG, s.clock).addAccount(s.shopId, "123456"), /META_ACCESS_TOKEN/);
  const ads = new AdsService(s.repo, s.shops, { account: async (id) => ({ id, name: "Účet", currency: "CZK" }), insights: async () => [] }, null, CFG, s.clock);
  await assert.rejects(ads.addAccount(s.shopId, "act_abc"), /číslo/);
  const a = await ads.addAccount(s.shopId, "act_123456");
  assert.equal(a.account_id, "123456");
  await assert.rejects(ads.addAccount(s.shopId, "123456"), /už je/);
});

test("migrace DB v2 → v4 doplní UTM sloupce a částku AE u zásilek", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsm-"));
  const file = join(dir, "t.db");
  new Repo(file).close();
  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX idx_orders_utm_campaign");
  for (const c of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "source_name"]) raw.exec(`ALTER TABLE orders DROP COLUMN ${c}`);
  for (const c of ["ae_amount", "ae_currency"]) raw.exec(`ALTER TABLE shipments DROP COLUMN ${c}`);
  raw.exec("PRAGMA user_version = 2");
  raw.close();
  const repo = new Repo(file);
  const cols = (repo.db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(["utm_source", "utm_campaign", "source_name"].every((c) => cols.includes(c)));
  const scols = (repo.db.prepare("PRAGMA table_info(shipments)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(scols.includes("ae_amount") && scols.includes("ae_currency"));
  assert.equal((repo.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
  repo.close();
});

test("náklad: skutečná částka z AE (zboží + doprava) > snapshot z odeslání > poslední cena; doprava v odhadu", async () => {
  const s = setup();
  const lamp = s.addProduct("1005006543210987", "Lampa", 5);
  const shop = s.shops.get(s.shopId);
  s.shops.update(s.shopId, { pricing: { ...shop.pricing, shippingPerUnit: 1.5 } });
  // A: skutečná částka 7,43 USD z AE → 170,89 Kč
  const a = s.addOrder("2026-11-05", [{ vid: lamp.vid, qty: 1 }], 605);
  s.repo.markPlaced(a, ["81"], [{ lineItemGid: "gid://shopify/LineItem/10", title: "x", quantity: 1, aeProductId: "1005006543210987", aeSkuAttr: null, logisticsServiceName: null, unitCost: 4 }], false);
  s.repo.updateShipmentStatus(s.repo.shipmentsForOrder(a)[0]!.id, { aeOrderStatus: "WAIT", logisticsStatus: "X", trackingNumber: null, carrier: null, aeAmount: 7.43, aeCurrency: "USD" });
  // B: odesláno se snapshotem 4 USD (dnes už stojí 5) → (4 + 1,5) × 23 = 126,5
  const b = s.addOrder("2026-11-06", [{ vid: lamp.vid, qty: 1 }], 605);
  s.repo.markPlaced(b, ["82"], [{ lineItemGid: "gid://shopify/LineItem/20", title: "x", quantity: 1, aeProductId: "1005006543210987", aeSkuAttr: null, logisticsServiceName: null, unitCost: 4 }], false);
  // C: bez snapshotu → (5 + 1,5) × 23 = 149,5
  s.addOrder("2026-11-07", [{ vid: lamp.vid, qty: 1 }], 605);
  const st = new AdsService(s.repo, s.shops, null, null, CFG, s.clock).stats(s.shopId, "2026-11-01", "2026-11-08");
  const L = st.products.find((p) => p.productId === lamp.pid)!;
  assert.equal(L.cogs, 446.89);
  assert.deepEqual(st.totals.costSource, { actual: 1, estimated: 2, missing: 0 });
});

test("doprava se promítne do prodejní ceny i nákladu v Shopify", async () => {
  const { computePrice, unitCostInShop } = await import("../src/catalog.js");
  const r = { ...DEFAULT_PRICING_FOR_TEST, shippingPerUnit: 1.5 };
  assert.equal(unitCostInShop(5, r), 149.5);
  assert.equal(computePrice(5, r), 299); // (5+1,5)×23×2 = 299 → 300 − 1
});

test("zákazníci: noví vs. vracející se, nCAC, zisk z 1. objednávky, LTV 90 dní", () => {
  const s = setup("2026-11-08");
  const lamp = s.addProduct("1005006543210987", "Lampa", 5);
  const mk = (day: string, email: string) => {
    const id = s.addOrder(day, [{ vid: lamp.vid, qty: 1 }], 605);
    s.repo.db.prepare("UPDATE orders SET email = ?, customer_id = NULL WHERE id = ?").run(email, id);
  };
  mk("2026-06-01", "stara@x.cz"); // kohorta pro LTV
  mk("2026-07-10", "stara@x.cz"); // do 90 dní
  mk("2026-11-02", "stara@x.cz"); // vracející se v období
  mk("2026-11-03", "nova1@x.cz");
  mk("2026-11-04", "nova2@x.cz");
  mk("2026-11-05", "nova2@x.cz"); // vracející se nová zákaznice
  s.addAccount("111", "CZK");
  s.addStat("111", { date: "2026-11-03", adId: "a", campaignId: "c", spend: 600 });
  const st = new AdsService(s.repo, s.shops, null, null, CFG, s.clock).stats(s.shopId, "2026-11-01", "2026-11-08");
  const c = st.customers;
  assert.equal(c.newCustomers, 2);
  assert.equal(c.returningOrders, 2);
  assert.equal(c.returningSharePct, 50);
  assert.equal(c.ncac, 300);
  assert.equal(c.avgFirstOrderProfit, 375, "500 − 115 − 10 poplatek");
  assert.equal(c.ltvCohortSize, 1);
  assert.equal(c.ltv90Revenue, 1000);
});

test("pravidlo nCAC: ztráta na zákazníkovi vs. zaplatí se opakovaným nákupem", () => {
  const cust = (o: Partial<AdsStats["customers"]>) => ({ newCustomers: 4, returningOrders: 0, returningSharePct: 0, ncac: 400, avgFirstOrderProfit: 250, ltv90Revenue: null, ltv90Profit: null, ltvCohortSize: 0, ...o });
  const tot = { ...baseStats().totals, spend: 1600 };
  assert.deepEqual(ids(baseStats({ totals: tot, customers: cust({}) })), ["ncac-loss"]);
  assert.deepEqual(ids(baseStats({ totals: tot, customers: cust({ ltv90Profit: 450, ltvCohortSize: 6 }) })), ["ncac-payback"]);
  assert.deepEqual(ids(baseStats({ totals: tot, customers: cust({ ltv90Profit: 450, ltvCohortSize: 2 }) })), ["ncac-loss"], "malá kohorta nestačí");
  assert.deepEqual(ids(baseStats({ totals: tot, customers: cust({ ncac: 200 }) })), []);
});
