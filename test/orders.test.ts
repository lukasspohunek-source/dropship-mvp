import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictError, OrderService, type OrderConfig } from "../src/orders.js";
import { FakeSupplier, MAPPING, memRepo, order } from "./helpers.js";

const LIVE: OrderConfig = { dryRun: false, autoPay: { enabled: true, maxOrderTotal: 1500, maxPerDay: 2 } };

function setup(cfg: OrderConfig = LIVE) {
  const repo = memRepo();
  const sup = new FakeSupplier();
  const svc = new OrderService(repo, sup, cfg);
  return { repo, sup, svc };
}

test("duplicitní webhook nevytvoří druhou objednávku", () => {
  const { svc } = setup();
  assert.equal(svc.ingest(order()).created, true);
  assert.equal(svc.ingest(order()).created, false);
});

test("bez mapování → NEEDS_MAPPING; po přidání mapování se odešle", async () => {
  const { repo, sup, svc } = setup();
  const { id } = svc.ingest(order());
  assert.equal(await svc.process(id), "NEEDS_MAPPING");
  assert.equal(sup.placed.length, 0);
  repo.upsertMapping(MAPPING);
  await svc.reprocessWaitingForMapping();
  const o = repo.getOrder(id)!;
  assert.equal(o.status, "PLACED");
  assert.equal(sup.placed[0]?.tryToPay, true);
  assert.equal(sup.placed[0]?.lines[0]?.aeSkuAttr, "14:200003699");
  assert.equal(repo.shipmentsForOrder(id).length, 1);
});

test("chybějící telefon → NEEDS_ADDRESS, nic se neodešle", async () => {
  const { repo, sup, svc } = setup();
  repo.upsertMapping(MAPPING);
  const { id } = svc.ingest(order({ address: { ...order().address!, phone: null } }));
  assert.equal(await svc.process(id), "NEEDS_ADDRESS");
  assert.match(repo.getOrder(id)!.last_error!, /telefon/);
  assert.equal(sup.placed.length, 0);
});

test("oprava adresy z NEEDS_ADDRESS objednávku odešle", async () => {
  const { repo, sup, svc } = setup();
  repo.upsertMapping(MAPPING);
  const { id } = svc.ingest(order({ address: { ...order().address!, phone: null } }));
  await svc.process(id);
  assert.equal(await svc.updateAddress(id, { phone: "+420 603 000 111" }), "PLACED");
  assert.equal(sup.placed[0]?.address.phone, "+420 603 000 111");
  assert.equal(sup.placed[0]?.address.city, "Brno", "ostatní pole zůstanou");
});

test("jen digitální položky → IGNORED", async () => {
  const { svc } = setup();
  const { id } = svc.ingest(order({ lines: [{ ...order().lines[0]!, requiresShipping: false }] }));
  assert.equal(await svc.process(id), "IGNORED");
});

test("nad cenovým limitem → NEEDS_APPROVAL; po schválení se zaplatí", async () => {
  const { repo, sup, svc } = setup();
  repo.upsertMapping(MAPPING);
  const { id } = svc.ingest(order({ totalPrice: 4990 }));
  assert.equal(await svc.process(id), "NEEDS_APPROVAL");
  assert.equal(sup.placed.length, 0);
  assert.equal(await svc.approve(id), "PLACED");
  assert.equal(sup.placed[0]?.tryToPay, true);
  await assert.rejects(svc.approve(id), ConflictError);
});

test("denní limit automatických plateb", async () => {
  const { repo, sup, svc } = setup();
  repo.upsertMapping(MAPPING);
  for (let i = 0; i < 3; i++) {
    sup.next = { kind: "ok", aeOrderIds: [`81000000000000${10 + i}`] };
    const { id } = svc.ingest(order({ shopifyOrderId: `60${i}`, name: `#20${i}` }));
    await svc.process(id);
  }
  const statuses = repo.listOrders().map((o) => o.status).reverse();
  assert.deepEqual(statuses, ["PLACED", "PLACED", "NEEDS_APPROVAL"]);
});

test("AUTO_PAY vypnuto → odešle se bez platby a bez schvalování", async () => {
  const { repo, sup, svc } = setup({ dryRun: false, autoPay: { enabled: false, maxOrderTotal: 0, maxPerDay: 0 } });
  repo.upsertMapping(MAPPING);
  const { id } = svc.ingest(order({ totalPrice: 99999 }));
  assert.equal(await svc.process(id), "PLACED");
  assert.equal(sup.placed[0]?.tryToPay, false);
});

test("DRY_RUN nic neodešle", async () => {
  const { repo, sup, svc } = setup({ ...LIVE, dryRun: true });
  repo.upsertMapping(MAPPING);
  const { id } = svc.ingest(order());
  assert.equal(await svc.process(id), "DRY_RUN");
  assert.equal(sup.placed.length, 0);
  assert.match(repo.eventsForOrder(id).at(-1)!.message, /DRY_RUN: odeslalo by se 2× 1005001234567890/);
});

test("odmítnutí AE → PLACE_FAILED, retry po opravě projde", async () => {
  const { repo, sup, svc } = setup();
  repo.upsertMapping(MAPPING);
  sup.next = { kind: "rejected", code: "DELIVERY_METHOD_NOT_EXIST", message: "" };
  const { id } = svc.ingest(order());
  assert.equal(await svc.process(id), "PLACE_FAILED");
  sup.next = { kind: "ok", aeOrderIds: ["8100000000000099"] };
  assert.equal(await svc.retry(id), "PLACED");
});

test("nejistý výsledek → PLACE_UNCERTAIN, bez potvrzení se znovu neodešle", async () => {
  const { repo, sup, svc } = setup();
  repo.upsertMapping(MAPPING);
  sup.next = { kind: "uncertain", message: "fetch failed" };
  const { id } = svc.ingest(order());
  assert.equal(await svc.process(id), "PLACE_UNCERTAIN");
  await svc.processPending();
  assert.equal(sup.placed.length, 1, "automaticky se nesmí opakovat");
  await assert.rejects(svc.retry(id), /confirmNotPlaced/);
  svc.markPlacedManually(id, ["8100000000000123"]);
  assert.equal(repo.getOrder(id)!.status, "PLACED");
  assert.equal(repo.shipmentsForOrder(id)[0]?.ae_order_id, "8100000000000123");
});

test("souběžné zpracování stejné objednávky odešle jen jednou", async () => {
  const { repo, sup, svc } = setup();
  repo.upsertMapping(MAPPING);
  const { id } = svc.ingest(order());
  await Promise.all([svc.process(id), svc.process(id), svc.processPending()]);
  assert.equal(sup.placed.length, 1);
});

test("zrušení odeslané objednávky lokálně nejde", async () => {
  const { repo, svc } = setup();
  repo.upsertMapping(MAPPING);
  const { id } = svc.ingest(order());
  await svc.process(id);
  assert.throws(() => svc.cancel(id), ConflictError);
});
