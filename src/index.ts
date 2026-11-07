import { AliExpressSupplier } from "./aliexpress.js";
import { loadConfig } from "./config.js";
import { Repo } from "./db.js";
import { OrderService } from "./orders.js";
import { createApp } from "./server.js";
import { ShopifyStore } from "./shopify.js";
import { TrackingService } from "./tracking.js";

const cfg = loadConfig();
const repo = new Repo(cfg.dbPath);

// Proces mohl spadnout uprostřed odesílání → nevíme, jestli objednávka v AE vznikla.
for (const id of repo.idsByStatus("PLACING")) {
  repo.setStatus(id, "PLACE_UNCERTAIN", "Proces skončil během odesílání – zkontroluj v AliExpressu");
  repo.log(id, "error", "Restart během odesílání → PLACE_UNCERTAIN, zkontroluj v AliExpressu");
}

const supplier = new AliExpressSupplier(repo, cfg.ae);
const store = new ShopifyStore(cfg.shopify);
const orders = new OrderService(repo, supplier, cfg.orders);
const tracking = new TrackingService(repo, supplier, store, cfg.tracking);

const app = createApp({
  repo,
  orders,
  tracking,
  oauth: supplier,
  cfg: {
    adminToken: cfg.adminToken,
    webhookSecret: cfg.shopify.webhookSecret,
    shop: cfg.shopify.shop,
    publicBaseUrl: cfg.publicBaseUrl,
    dryRun: cfg.orders.dryRun,
  },
});

const server = app.listen(cfg.port, () => {
  console.log(
    `dropship-mvp běží na :${cfg.port} | DRY_RUN=${cfg.orders.dryRun} | AUTO_PAY=${cfg.orders.autoPay.enabled}` +
      ` (limit ${cfg.orders.autoPay.maxOrderTotal}, ${cfg.orders.autoPay.maxPerDay}/den)`,
  );
});

const orderTimer = setInterval(() => {
  orders.processPending().catch((e) => repo.log(null, "error", `processPending: ${(e as Error).message}`));
}, cfg.orders.pollSeconds * 1000);

const trackingTimer = setInterval(() => {
  tracking
    .syncAll()
    .then((r) => r.checked && console.log(`tracking: ${JSON.stringify(r)}`))
    .catch((e) => repo.log(null, "error", `tracking: ${(e as Error).message}`));
}, cfg.tracking.intervalMinutes * 60 * 1000);

function shutdown(sig: string) {
  console.log(`${sig} – ukončuji`);
  clearInterval(orderTimer);
  clearInterval(trackingTimer);
  server.close(() => {
    repo.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
