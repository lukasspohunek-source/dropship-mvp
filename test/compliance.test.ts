import assert from "node:assert/strict";
import { test } from "node:test";
import { ComplianceService, gpsrMissing } from "../src/compliance.js";
import { CrmService } from "../src/crm.js";
import { memRepo, order, seedShop, shopService } from "./helpers.js";

function setup(nowIso = "2026-11-07T10:00:00Z", retentionYears = 0) {
  let now = new Date(nowIso);
  const clock = () => now;
  const repo = memRepo(clock);
  const shopId = seedShop(repo);
  const shops = shopService(repo);
  const crm = new CrmService(repo, clock);
  const c = new ComplianceService(repo, shops, crm, { sellerCountry: "CZ", fxToEur: { EUR: 1, CZK: 0.04 }, retentionYears }, clock);
  const product = (ae: string) =>
    Number(
      repo.db
        .prepare("INSERT INTO products (shop_id, ae_product_id, title, ae_currency, created_at, updated_at) VALUES (?, ?, 'Lampa', 'USD', ?, ?)")
        .run(shopId, ae, clock().toISOString(), clock().toISOString()).lastInsertRowid,
    );
  const addOrder = (over: Parameters<typeof order>[0], status = "FULFILLED") => {
    const o = order(over);
    const { id } = repo.insertOrder(o, shopId);
    crm.recordOrder(id, o);
    repo.setStatus(id, status as any);
    return id;
  };
  return { repo, shopId, crm, c, product, addOrder, setNow: (iso: string) => (now = new Date(iso)) };
}

test("GPSR: výrobce mimo EU vyžaduje odpovědnou osobu v EU; report a kopírování", () => {
  const t = setup();
  const a = t.product("1");
  const b = t.product("2");
  assert.equal(t.c.gpsrReport().length, 2);
  let r = t.c.setGpsr(a, {
    manufacturer: { name: "Shenzhen Lamp Co.", address: "Shenzhen, CN", contact: "sales@lamp.cn" },
    productIdentifier: "Model LX-12",
    warnings: "Nepoužívat ve vlhkém prostředí.",
  });
  assert.deepEqual(r.missing, ["odpovědná osoba v EU – název", "odpovědná osoba v EU – adresa", "odpovědná osoba v EU – kontakt"]);
  r = t.c.setGpsr(a, { euResponsible: { name: "EU Rep s.r.o.", address: "Praha 1", contact: "rep@eu.cz" } });
  assert.deepEqual(r.missing, []);
  assert.equal(r.gpsr.manufacturer.name, "Shenzhen Lamp Co.", "dílčí úprava nepřepíše ostatní");
  t.c.copyGpsr(a, [b]);
  assert.equal(t.c.gpsrReport().length, 0);
  assert.deepEqual(gpsrMissing({ ...r.gpsr, manufacturerInEu: true, euResponsible: { name: null, address: null, contact: null } }), []);
});

test("údaje prodávajícího a vzorový formulář pro odstoupení", () => {
  const t = setup();
  assert.throws(() => t.c.setSeller(t.shopId, { ico: "123" }), /8 číslic/);
  const s = t.c.setSeller(t.shopId, { legalName: "Pokovo s.r.o.", address: "Radošovice 1", ico: "12345678", email: "info@pokovo.cz" });
  assert.deepEqual(s.missing, ["adresa pro vrácení zboží (v EU)"]);
  const form = t.c.withdrawalForm(t.shopId);
  assert.match(form, /VZOROVÝ FORMULÁŘ PRO ODSTOUPENÍ OD SMLOUVY/);
  assert.match(form, /Adresát: Pokovo s\.r\.o\., Radošovice 1, IČO 12345678, e-mail: info@pokovo\.cz/);
  assert.match(form, /Nehodící se škrtněte/);
  assert.equal(t.c.overview().shopsMissingSellerInfo.length, 1);
});

test("GDPR retence: vypnutá nic nedělá; zapnutá anonymizuje staré zákazníky", () => {
  const off = setup();
  off.addOrder({ shopifyOrderId: "1" });
  assert.deepEqual(off.c.retentionCandidates(), []);

  const t = setup("2020-01-10T10:00:00Z", 3);
  t.addOrder({ shopifyOrderId: "1", customer: { email: "stary@x.cz", name: "S", phone: null, acceptsMarketing: false, consentAt: null } });
  t.setNow("2023-06-01T00:00:00Z");
  t.addOrder({ shopifyOrderId: "2", customer: { email: "novy@x.cz", name: "N", phone: null, acceptsMarketing: false, consentAt: null } });
  t.setNow("2024-02-01T00:00:00Z");
  const cand = t.c.retentionCandidates();
  assert.deepEqual(cand.map((x) => x.email), ["stary@x.cz"]);
  const r = t.c.applyRetention();
  assert.equal(r.anonymized.length, 1);
  assert.equal(t.crm.listCustomers().length, 1);
});

test("DPH report: domácí vs. EU na dálku, chybějící kurz, objednávky nad limit IOSS", () => {
  const t = setup();
  const addr = (cc: string) => ({ ...order().address!, countryCode: cc });
  t.addOrder({ shopifyOrderId: "1", totalPrice: 1210, totalTax: 210, currency: "CZK", address: addr("CZ") });
  t.addOrder({ shopifyOrderId: "2", totalPrice: 120, totalTax: 20, currency: "EUR", address: addr("SK") });
  t.addOrder({ shopifyOrderId: "3", totalPrice: 200, totalTax: 0, currency: "EUR", address: addr("DE") });
  t.addOrder({ shopifyOrderId: "4", totalPrice: 50, totalTax: 0, currency: "GBP", address: addr("GB") });
  t.addOrder({ shopifyOrderId: "5", totalPrice: 9999, totalTax: 0, currency: "EUR", address: addr("AT") }, "CANCELLED");
  const r = t.c.vatReport(2026);
  const by = Object.fromEntries(r.countries.map((c) => [c.country, c]));
  assert.equal(by.CZ!.domestic, true);
  assert.equal(by.CZ!.netEur, 40);
  assert.equal(by.SK!.netEur, 100);
  assert.equal(by.GB!.eu, false);
  assert.equal(by.AT, undefined, "zrušené se nepočítají");
  assert.equal(r.euDistanceSales.netEur, 300);
  assert.equal(r.euDistanceSales.percent, 3);
  assert.ok(r.warnings.some((w) => /GBP/.test(w)));
  assert.deepEqual(r.ordersOverIossLimit.map((o) => o.totalPrice), [200]);
  assert.ok(r.notes.some((n) => /IOSS/.test(n)));
  assert.throws(() => t.c.vatReport(1999));
});

test("DPH report: varování u 80 % a překročení limitu", () => {
  const t = setup();
  const addr = { ...order().address!, countryCode: "DE" };
  t.addOrder({ shopifyOrderId: "1", totalPrice: 8500, totalTax: 0, currency: "EUR", address: addr });
  assert.ok(t.c.vatReport(2026).warnings.some((w) => /85 %/.test(w)));
  t.addOrder({ shopifyOrderId: "2", totalPrice: 2000, totalTax: 0, currency: "EUR", address: addr });
  assert.ok(t.c.vatReport(2026).warnings.some((w) => /Překročen limit/.test(w)));
});
