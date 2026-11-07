import assert from "node:assert/strict";
import { test } from "node:test";
import { CrmService, addDays } from "../src/crm.js";
import { ConflictError, ValidationError } from "../src/errors.js";
import { memRepo, order, seedShop } from "./helpers.js";

function setup(nowIso = "2026-11-07T10:00:00Z") {
  let now = new Date(nowIso);
  const clock = () => now;
  const repo = memRepo(clock);
  const shopId = seedShop(repo);
  const crm = new CrmService(repo, clock);
  const add = (over: Parameters<typeof order>[0] = {}) => {
    const o = order(over);
    const { id } = repo.insertOrder(o, over.shopifyOrderId ? shopId : shopId);
    crm.recordOrder(id, o);
    return id;
  };
  return { repo, crm, shopId, add, setNow: (iso: string) => (now = new Date(iso)) };
}

test("objednávka založí zákazníka, druhá ho jen doplní; útrata se sčítá po měnách", () => {
  const t = setup();
  t.add({ shopifyOrderId: "1", totalPrice: 899 });
  t.add({ shopifyOrderId: "2", totalPrice: 101, customer: { email: "ZAKAZNIK@example.com", name: null, phone: null, acceptsMarketing: false, consentAt: null } });
  t.add({ shopifyOrderId: "3", totalPrice: 40, currency: "EUR" });
  const list = t.crm.listCustomers();
  assert.equal(list.length, 1);
  const c = list[0] as any;
  assert.equal(c.email, "zakaznik@example.com");
  assert.equal(c.name, "Jan Novák", "prázdné jméno nepřepíše existující");
  assert.equal(c.orders_count, 3);
  assert.deepEqual(c.spent, { CZK: 1000, EUR: 40 });
  assert.equal(t.crm.getCustomer(c.id).orders.length, 3);
});

test("souhlas s marketingem: udělen s datem a zdrojem; objednávka bez souhlasu ho odvolá", () => {
  const t = setup();
  t.add({ shopifyOrderId: "1", customer: { email: "a@b.cz", name: "A", phone: null, acceptsMarketing: true, consentAt: "2026-11-01T08:00:00Z" } });
  let c = t.crm.listCustomers()[0] as any;
  assert.equal(c.acceptsMarketing, true);
  assert.equal(c.marketing_consent_at, "2026-11-01T08:00:00Z");
  assert.match(c.marketing_consent_source, /#1001/);
  t.add({ shopifyOrderId: "2", customer: { email: "a@b.cz", name: "A", phone: null, acceptsMarketing: false, consentAt: null } });
  c = t.crm.listCustomers()[0] as any;
  assert.equal(c.acceptsMarketing, false);
  assert.match(c.marketing_consent_source, /odvoláno/);
});

test("ruční souhlas vyžaduje zdroj", () => {
  const t = setup();
  assert.throws(() => t.crm.createCustomer({ name: "B", email: "b@b.cz", acceptsMarketing: true }), ValidationError);
  const c = t.crm.createCustomer({ name: "B", email: "b@b.cz", acceptsMarketing: true, consentSource: "veletrh Brno, papírový formulář", tags: "VIP, Velkoobchod" }) as any;
  assert.deepEqual(c.tags, ["vip", "velkoobchod"]);
  assert.throws(() => t.crm.createCustomer({ name: "C", email: "B@b.cz" }), ConflictError);
});

test("GDPR: anonymizace jen bez rozpracovaných objednávek; smaže osobní údaje i z objednávek", () => {
  const t = setup();
  const oid = t.add();
  const cid = t.crm.listCustomers()[0]!.id as number;
  t.crm.addNote("customer", cid, "Volal kvůli dopravě, tel. 777123456");
  assert.throws(() => t.crm.anonymize(cid), /rozpracované/);
  t.repo.setStatus(oid, "FULFILLED");
  const exp = t.crm.exportCustomerData(cid);
  assert.equal(exp.orders[0]!.address.city, "Brno");
  assert.equal(exp.notes.length, 1);
  const a = t.crm.anonymize(cid) as any;
  assert.ok(a.anonymized_at);
  assert.equal(a.email, null);
  assert.equal(t.repo.getOrder(oid)!.address_json, null);
  assert.equal(t.repo.getOrder(oid)!.email, null);
  assert.equal(t.crm.listNotes("customer", cid).length, 0);
  assert.equal(t.crm.listCustomers().length, 0);
  // Nová objednávka se stejným e-mailem vytvoří nového zákazníka, ne oživení anonymizovaného.
  t.add({ shopifyOrderId: "9" });
  assert.equal(t.crm.listCustomers().length, 1);
});

test("úkoly: filtry po splatnosti a hotovo", () => {
  const t = setup();
  t.crm.createTask({ title: "Zavolat dodavateli", dueDate: "2026-11-05", priority: "HIGH" });
  const today = t.crm.createTask({ title: "Odpovědět na e-mail", dueDate: "2026-11-07" }) as any;
  t.crm.createTask({ title: "Příští týden", dueDate: "2026-11-12" });
  assert.equal(t.crm.listTasks({ due: "overdue" }).length, 1);
  assert.equal(t.crm.listTasks({ due: "today" }).length, 1);
  assert.equal(t.crm.listTasks({ due: "week" }).length, 2);
  const done = t.crm.updateTask(today.id, { status: "DONE" }) as any;
  assert.ok(done.done_at);
  assert.throws(() => t.crm.createTask({ title: "x", dueDate: "7.11.2026" }), /RRRR-MM-DD/);
  assert.throws(() => t.crm.createTask({ title: "x", entityType: "customer", entityId: 999 }), /neexistuje/);
});

test("leady: prohra vyžaduje důvod, konverze propojí existujícího zákazníka", () => {
  const t = setup();
  t.add();
  const l = t.crm.createLead({ name: "Firma s.r.o.", email: "zakaznik@example.com", value: 50000, currency: "czk" }) as any;
  assert.throws(() => t.crm.updateLead(l.id, { stage: "LOST" }), /lostReason/);
  t.crm.updateLead(l.id, { stage: "PROPOSAL" });
  const c = t.crm.convertLead(l.id) as any;
  assert.equal(c.email, "zakaznik@example.com");
  assert.equal((t.crm.getLead(l.id) as any).stage, "WON");
  assert.equal(t.crm.listCustomers().length, 1, "nevznikl duplicitní zákazník");
});

test("odstoupení: lhůta 14 dní, pozdní podání se označí; reklamace 30 dní; po lhůtě overdue", () => {
  const t = setup();
  const oid = t.add();
  const w = t.crm.createTicket({ type: "WITHDRAWAL", orderId: oid, reason: "Nevyhovuje", deliveredAt: "2026-10-20", filedAt: "2026-11-06" }) as any;
  assert.equal(w.deadline, "2026-11-20");
  assert.equal(w.late_filing, 1, "podáno 17 dní po doručení");
  assert.ok(w.customer_id, "zákazník se doplní z objednávky");
  const c = t.crm.createTicket({ type: "COMPLAINT", orderId: oid, reason: "Nesvítí", filedAt: "2026-11-07" }) as any;
  assert.equal(c.deadline, addDays("2026-11-07", 30));
  assert.equal(c.late_filing, 0);
  assert.throws(() => t.crm.updateTicket(c.id, { status: "RESOLVED" }), /resolution/);
  assert.throws(() => t.crm.updateTicket(c.id, { status: "REJECTED" }), /odůvodnění/);
  t.setNow("2026-12-08T10:00:00Z");
  assert.equal(t.crm.listTickets({ overdue: true }).length, 2);
  const r = t.crm.updateTicket(c.id, { status: "RESOLVED", resolution: "REPLACEMENT", note: "Poslána nová lampa" }) as any;
  assert.ok(r.closed_at);
  assert.equal(r.overdue, false);
  assert.equal(r.notes.length, 1);
  assert.equal(t.crm.dashboard().tickets.overdue, 1);
});

test("segmenty: export jen se souhlasem, filtry a ochrana proti CSV injection", () => {
  const t = setup();
  t.add({ shopifyOrderId: "1", customer: { email: "ano@x.cz", name: "=HYPERLINK(\"evil\")", phone: null, acceptsMarketing: true, consentAt: "2026-10-01T00:00:00Z" } });
  t.add({ shopifyOrderId: "2", customer: { email: "ne@x.cz", name: "Ne", phone: null, acceptsMarketing: false, consentAt: null } });
  const s = t.crm.createSegment({ name: "Všichni v CZ", filter: { country: "cz" } }) as any;
  assert.equal(s.size, 1, "bez souhlasu se nepočítá");
  const csv = t.crm.segmentCsv(s.id);
  assert.match(csv, /ano@x\.cz/);
  assert.doesNotMatch(csv, /ne@x\.cz/);
  assert.match(csv, /"'=HYPERLINK/);
  const all = t.crm.createSegment({ name: "Interní přehled", filter: { marketingOnly: false } }) as any;
  assert.equal(all.size, 2);
  assert.doesNotMatch(t.crm.segmentCsv(all.id), /ne@x\.cz/, "CSV export i tak jen se souhlasem");
  const stale = t.crm.createSegment({ name: "Neaktivní", filter: { lastOrderOlderThanDays: 90, marketingOnly: false } }) as any;
  assert.equal(stale.size, 0);
  t.setNow("2027-03-01T00:00:00Z");
  assert.equal(t.crm.getSegment(stale.id).size, 2);
});

test("dashboard", () => {
  const t = setup();
  const oid = t.add();
  t.repo.setStatus(oid, "NEEDS_APPROVAL");
  t.crm.createLead({ name: "L", stage: "QUALIFIED", value: 1000 });
  t.crm.createTask({ title: "x", dueDate: "2026-11-01" });
  const d = t.crm.dashboard();
  assert.equal(d.needsAttention, 1);
  assert.equal(d.revenue30d[0]!.total, 899);
  assert.equal(d.newCustomers30d, 1);
  assert.equal(d.tasks.overdue, 1);
  assert.deepEqual(d.pipeline, [{ stage: "QUALIFIED", n: 1, value: 1000 }]);
});
