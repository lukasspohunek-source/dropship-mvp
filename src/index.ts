import { AliExpressSupplier } from "./aliexpress.js";
import { CatalogService, catalogRouter } from "./catalog.js";
import { ComplianceService, complianceRouter } from "./compliance.js";
import { loadConfig } from "./config.js";
import { CrmService, crmRouter } from "./crm.js";
import { SecretBox } from "./crypto.js";
import { Repo } from "./db.js";
import { OrderService } from "./orders.js";
import { createApp } from "./server.js";
import { ShopService } from "./shops.js";
import { TrackingService } from "./tracking.js";
import {
  ClaudeTrendAnalyzer,
  GoogleShoppingSource,
  GoogleTrendsSource,
  HeurekaSource,
  InstagramSource,
  SeznamSuggestSource,
  TikTokSource,
  TrendService,
  trendsRouter,
  type TrendSource,
} from "./trends.js";

const cfg = loadConfig();
const repo = new Repo(cfg.dbPath);
const shops = new ShopService(repo, new SecretBox(cfg.secretKey), {
  apiVersion: cfg.shopify.apiVersion,
  autoPayMaxOrderTotal: cfg.orders.autoPay.maxOrderTotal,
  pricing: cfg.pricingDefaults,
});

// První e-shop z .env (pohodlné pro jeden obchod; další přidáš přes POST /admin/shops).
const b = cfg.shopify.bootstrap;
if (b && !shops.findForWebhook(b.domain)) {
  shops.create({ domain: b.domain, name: b.name, currency: b.currency, country: b.country, adminToken: b.adminToken, webhookSecret: b.webhookSecret });
}

// Proces mohl spadnout uprostřed odesílání → nevíme, jestli objednávka v AE vznikla.
for (const id of repo.idsByStatus("PLACING")) {
  repo.setStatus(id, "PLACE_UNCERTAIN", "Proces skončil během odesílání – zkontroluj v AliExpressu");
  repo.log(id, "error", "Restart během odesílání → PLACE_UNCERTAIN, zkontroluj v AliExpressu");
}

const supplier = new AliExpressSupplier(repo, cfg.ae);
const orders = new OrderService(repo, supplier, cfg.orders, (shopId) => shops.get(shopId).autoPayMaxOrderTotal);
const tracking = new TrackingService(repo, supplier, (shopId) => shops.store(shopId), cfg.tracking);
const catalog = new CatalogService(repo, supplier, shops);
const crm = new CrmService(repo);
const compliance = new ComplianceService(repo, shops, crm, cfg.compliance);

// Zdroje trendů se zapnou jen s vyplněnými klíči.
const t = cfg.trends;
const trendSources: TrendSource[] = [];
if (t.serpApiKey) trendSources.push(new GoogleTrendsSource(t.serpApiKey), new GoogleShoppingSource(t.serpApiKey));
if (t.seznam) trendSources.push(new SeznamSuggestSource());
if (t.brightData?.tiktokDatasetId) trendSources.push(new TikTokSource(t.brightData, t.brightData.tiktokDatasetId));
if (t.brightData?.instagramDatasetId) trendSources.push(new InstagramSource(t.brightData, t.brightData.instagramDatasetId));
if (t.brightData?.unlockerZone) trendSources.push(new HeurekaSource(t.brightData));
const trends = new TrendService(
  repo,
  shops,
  trendSources,
  (country) => supplier.getTrendingProducts(country, t.aeFeeds),
  t.aiEnabled ? new ClaudeTrendAnalyzer(undefined, t.model) : null,
  { maxRunsPerDay: t.maxRunsPerDay },
  catalog,
);
// Běh, který spadl s procesem, by visel jako RUNNING a blokoval další.
repo.db.prepare("UPDATE trend_runs SET status = 'FAILED', error = 'Přerušeno restartem' WHERE status = 'RUNNING'").run();

const app = createApp({
  repo,
  orders,
  tracking,
  oauth: supplier,
  shops,
  onOrderCreated: (id, incoming) => void crm.recordOrder(id, incoming),
  extraAdmin: [catalogRouter(catalog, shops, () => orders.reprocessWaitingForMapping()), crmRouter(crm), complianceRouter(compliance), trendsRouter(trends, () => orders.reprocessWaitingForMapping())],
  cfg: { adminToken: cfg.adminToken, publicBaseUrl: cfg.publicBaseUrl, dryRun: cfg.orders.dryRun, autoPay: cfg.orders.autoPay.enabled },
});

const server = app.listen(cfg.port, () => {
  console.log(
    `dropship-mvp běží na :${cfg.port} | e-shopů: ${shops.list().length} | DRY_RUN=${cfg.orders.dryRun} | AUTO_PAY=${cfg.orders.autoPay.enabled} (${cfg.orders.autoPay.maxPerDay}/den)`,
  );
});

const timers: NodeJS.Timeout[] = [];
const every = (ms: number, name: string, fn: () => Promise<unknown>) =>
  timers.push(setInterval(() => void fn().catch((e) => repo.log(null, "error", `${name}: ${(e as Error).message}`)), ms));

every(cfg.orders.pollSeconds * 1000, "processPending", () => orders.processPending());
every(cfg.tracking.intervalMinutes * 60_000, "tracking", async () => {
  const r = await tracking.syncAll();
  if (r.checked) console.log(`tracking: ${JSON.stringify(r)}`);
});

if (cfg.catalog.syncHours > 0)
  every(cfg.catalog.syncHours * 3600_000, "catalog", async () => {
    const r = await catalog.syncAll();
    if (r.products) console.log(`katalog: ${JSON.stringify(r)}`);
  });

if (cfg.compliance.retentionYears > 0)
  every(24 * 3600_000, "gdpr-retence", async () => compliance.applyRetention());

function shutdown(sig: string) {
  console.log(`${sig} – ukončuji`);
  for (const t of timers) clearInterval(t);
  server.close(() => {
    repo.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
