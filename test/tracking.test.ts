import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderService } from "../src/orders.js";
import { TrackingService } from "../src/tracking.js";
import { FakeStore, FakeSupplier, MAPPING, memRepo, order } from "./helpers.js";

const TCFG = { notifyCustomer: true, unpaidWarnHours: 6, urlTemplate: "https://t.17track.net/en#nums={number}" };

async function placed(aeIds: string[], lines = order().lines) {
  let now = new Date("2026-11-07T10:00:00Z");
  const clock = () => now;
  const repo = memRepo(clock);
  const sup = new FakeSupplier();
  const store = new FakeStore();
  repo.upsertMapping(MAPPING);
  repo.upsertMapping({ ...MAPPING, shopifyVariantId: "222", aeProductId: "1005009999999999" });
  sup.next = { kind: "ok", aeOrderIds: aeIds };
  const svc = new OrderService(repo, sup, { dryRun: false, autoPay: { enabled: true, maxOrderTotal: 9999, maxPerDay: 9 } }, clock);
  const { id } = svc.ingest(order({ lines }));
  await svc.process(id);
  const tr = new TrackingService(repo, sup, store, TCFG, clock);
  return { repo, sup, store, tr, id, advance: (h: number) => (now = new Date(now.getTime() + h * 3600e3)) };
}

test("bez trackingu nic; s trackingem vyřídí v Shopify a objednávka je FULFILLED", async () => {
  const t = await placed(["81"]);
  t.sup.orders.set("81", { orderStatus: "WAIT_SELLER_SEND_GOODS", logisticsStatus: "NO_LOGISTICS", productIds: [MAPPING.aeProductId], tracking: [] });
  assert.deepEqual(await t.tr.syncAll(), { checked: 1, fulfilled: 0, errors: 0 });
  assert.equal(t.store.calls.length, 0);

  t.sup.orders.set("81", { orderStatus: "WAIT_BUYER_ACCEPT_GOODS", logisticsStatus: "SELLER_SEND_GOODS", productIds: [MAPPING.aeProductId], tracking: [{ number: "LP001CZ", carrier: "CAINIAO_STANDARD" }] });
  assert.deepEqual(await t.tr.syncAll(), { checked: 1, fulfilled: 1, errors: 0 });
  const call = t.store.calls[0]!;
  assert.equal(call.orderGid, "gid://shopify/Order/5001");
  assert.deepEqual(call.lineItems, [{ lineItemGid: "gid://shopify/LineItem/1", quantity: 2 }]);
  assert.equal(call.trackingUrl, "https://t.17track.net/en#nums=LP001CZ");
  assert.equal(t.repo.getOrder(t.id)!.status, "FULFILLED");
  assert.deepEqual(await t.tr.syncAll(), { checked: 0, fulfilled: 0, errors: 0 });
});

test("rozdělená objednávka: každá zásilka vyřídí jen své položky", async () => {
  const lines = [
    order().lines[0]!,
    { lineItemGid: "gid://shopify/LineItem/2", variantId: "222", title: "Háček", sku: null, quantity: 1, requiresShipping: true },
  ];
  const t = await placed(["81", "82"], lines);
  t.sup.orders.set("81", { orderStatus: "WAIT_BUYER_ACCEPT_GOODS", logisticsStatus: "SELLER_SEND_GOODS", productIds: [MAPPING.aeProductId], tracking: [{ number: "A1", carrier: "C" }] });
  t.sup.orders.set("82", { orderStatus: "WAIT_SELLER_SEND_GOODS", logisticsStatus: "NO_LOGISTICS", productIds: ["1005009999999999"], tracking: [] });
  await t.tr.syncAll();
  assert.deepEqual(t.store.calls[0]!.lineItems, [{ lineItemGid: "gid://shopify/LineItem/1", quantity: 2 }]);
  assert.equal(t.repo.getOrder(t.id)!.status, "PLACED");

  t.sup.orders.set("82", { orderStatus: "WAIT_BUYER_ACCEPT_GOODS", logisticsStatus: "SELLER_SEND_GOODS", productIds: ["1005009999999999"], tracking: [{ number: "B2", carrier: "C" }] });
  await t.tr.syncAll();
  assert.deepEqual(t.store.calls[1]!.lineItems, [{ lineItemGid: "gid://shopify/LineItem/2", quantity: 1 }]);
  assert.equal(t.repo.getOrder(t.id)!.status, "FULFILLED");
});

test("dlouho nezaplacená AE objednávka → jedno varování", async () => {
  const t = await placed(["81"]);
  t.sup.orders.set("81", { orderStatus: "PLACE_ORDER_SUCCESS", logisticsStatus: "NO_LOGISTICS", productIds: [], tracking: [] });
  await t.tr.syncAll();
  t.advance(7);
  await t.tr.syncAll();
  await t.tr.syncAll();
  const warns = t.repo.eventsForOrder(t.id).filter((e) => /zaplacená/.test(e.message));
  assert.equal(warns.length, 1);
});

test("chyba AE u jedné zásilky nezastaví ostatní", async () => {
  const t = await placed(["81"]);
  // "81" není ve FakeSupplier → getOrder vyhodí chybu
  const r = await t.tr.syncAll();
  assert.equal(r.errors, 1);
  assert.match(t.repo.shipmentsForOrder(t.id)[0]!.last_error!, /neznámá/);
});
