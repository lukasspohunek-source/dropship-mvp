import { Router } from "express";
import type { CrmService } from "./crm.js";
import type { Repo } from "./db.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { idParam, optStr } from "./http.js";
import type { ShopService } from "./shops.js";

/**
 * Podpora legislativních povinností. NENAHRAZUJE právníka ani daňového poradce –
 * hlídá procesy a upozorňuje na mezery.
 */

export const EU_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
] as const;
export const OSS_THRESHOLD_EUR = 10_000;
export const IOSS_MAX_CONSIGNMENT_EUR = 150;

// ---------- GPSR (nařízení EU 2023/988) ----------

export interface Gpsr {
  manufacturer: { name: string | null; address: string | null; contact: string | null };
  /** Odpovědná osoba v EU – povinná, pokud výrobce nesídlí v EU. */
  euResponsible: { name: string | null; address: string | null; contact: string | null };
  manufacturerInEu: boolean;
  /** Identifikace produktu (typ, model, šarže). */
  productIdentifier: string | null;
  /** Upozornění a bezpečnostní informace v jazyce zákazníka. */
  warnings: string | null;
  /** Nese produkt CE (je-li vyžadováno)? null = netýká se / nevím. */
  ceMarking: boolean | null;
}

const emptyGpsr = (): Gpsr => ({
  manufacturer: { name: null, address: null, contact: null },
  euResponsible: { name: null, address: null, contact: null },
  manufacturerInEu: false,
  productIdentifier: null,
  warnings: null,
  ceMarking: null,
});

export function gpsrMissing(g: Gpsr | null): string[] {
  const x = g ?? emptyGpsr();
  const miss: string[] = [];
  if (!x.manufacturer.name) miss.push("výrobce – název");
  if (!x.manufacturer.address) miss.push("výrobce – poštovní adresa");
  if (!x.manufacturer.contact) miss.push("výrobce – e-mail/web");
  if (!x.manufacturerInEu) {
    if (!x.euResponsible.name) miss.push("odpovědná osoba v EU – název");
    if (!x.euResponsible.address) miss.push("odpovědná osoba v EU – adresa");
    if (!x.euResponsible.contact) miss.push("odpovědná osoba v EU – kontakt");
  }
  if (!x.productIdentifier) miss.push("identifikace produktu (typ/model/šarže)");
  if (!x.warnings) miss.push("upozornění a bezpečnostní informace");
  return miss;
}

function parseGpsr(b: any, cur: Gpsr | null): Gpsr {
  const g = cur ?? emptyGpsr();
  const party = (src: any, prev: Gpsr["manufacturer"], f: string) =>
    src === undefined
      ? prev
      : {
          name: optStr(src?.name, `${f}.name`, 300),
          address: optStr(src?.address, `${f}.address`, 1000),
          contact: optStr(src?.contact, `${f}.contact`, 300),
        };
  return {
    manufacturer: party(b?.manufacturer, g.manufacturer, "manufacturer"),
    euResponsible: party(b?.euResponsible, g.euResponsible, "euResponsible"),
    manufacturerInEu: b?.manufacturerInEu === undefined ? g.manufacturerInEu : b.manufacturerInEu === true,
    productIdentifier: b?.productIdentifier === undefined ? g.productIdentifier : optStr(b.productIdentifier, "productIdentifier", 300),
    warnings: b?.warnings === undefined ? g.warnings : optStr(b.warnings, "warnings", 10000),
    ceMarking: b?.ceMarking === undefined ? g.ceMarking : b.ceMarking === null ? null : b.ceMarking === true,
  };
}

// ---------- údaje prodávajícího (per e-shop) ----------

export interface SellerInfo {
  legalName: string | null;
  address: string | null;
  ico: string | null;
  dic: string | null;
  email: string | null;
  phone: string | null;
  returnAddress: string | null;
}

export function sellerMissing(s: SellerInfo | null): string[] {
  const miss: string[] = [];
  if (!s?.legalName) miss.push("obchodní firma / jméno");
  if (!s?.address) miss.push("sídlo");
  if (!s?.ico) miss.push("IČO");
  if (!s?.email) miss.push("e-mail");
  if (!s?.returnAddress) miss.push("adresa pro vrácení zboží (v EU)");
  return miss;
}

// ---------- služba ----------

export interface ComplianceConfig {
  sellerCountry: string;
  /** Kolik EUR je 1 jednotka měny (např. {"CZK":0.04,"EUR":1}). */
  fxToEur: Record<string, number>;
  /** 0 = retence vypnutá. Jinak anonymizace po N letech od poslední objednávky. */
  retentionYears: number;
}

export class ComplianceService {
  constructor(
    private repo: Repo,
    private shops: ShopService,
    private crm: CrmService,
    private cfg: ComplianceConfig,
    private now: () => Date = () => new Date(),
  ) {}

  // GPSR
  getGpsr(productId: number): { gpsr: Gpsr; missing: string[] } {
    const r = this.repo.db.prepare("SELECT gpsr_json FROM products WHERE id = ?").get(productId) as { gpsr_json: string | null } | undefined;
    if (!r) throw new NotFoundError(`Produkt ${productId} neexistuje`);
    const g = r.gpsr_json ? (JSON.parse(r.gpsr_json) as Gpsr) : emptyGpsr();
    return { gpsr: g, missing: gpsrMissing(g) };
  }

  setGpsr(productId: number, body: any) {
    const cur = this.getGpsr(productId).gpsr;
    const g = parseGpsr(body, cur);
    this.repo.db.prepare("UPDATE products SET gpsr_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(g), this.repo.now_(), productId);
    return { gpsr: g, missing: gpsrMissing(g) };
  }

  /** Kopie GPSR údajů na více produktů (typicky stejný dodavatel). */
  copyGpsr(fromId: number, toIds: number[]) {
    const g = this.getGpsr(fromId).gpsr;
    for (const id of toIds) {
      this.getGpsr(id);
      this.repo.db.prepare("UPDATE products SET gpsr_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(g), this.repo.now_(), id);
    }
    return { copied: toIds.length };
  }

  gpsrReport() {
    const rows = this.repo.db.prepare("SELECT id, shop_id, ae_product_id, title, status, gpsr_json FROM products ORDER BY id").all() as any[];
    return rows
      .map((r) => ({ id: r.id, shopId: r.shop_id, aeProductId: r.ae_product_id, title: r.title, status: r.status, missing: gpsrMissing(r.gpsr_json ? JSON.parse(r.gpsr_json) : null) }))
      .filter((r) => r.missing.length);
  }

  // Prodávající
  getSeller(shopId: number): SellerInfo | null {
    this.shops.get(shopId);
    const raw = this.repo.getKv(`seller:${shopId}`);
    return raw ? (JSON.parse(raw) as SellerInfo) : null;
  }

  setSeller(shopId: number, b: any): { seller: SellerInfo; missing: string[] } {
    const cur = this.getSeller(shopId);
    const pick = (k: keyof SellerInfo, max: number) => (b?.[k] === undefined ? (cur?.[k] ?? null) : optStr(b[k], k, max));
    const s: SellerInfo = {
      legalName: pick("legalName", 300),
      address: pick("address", 1000),
      ico: pick("ico", 20),
      dic: pick("dic", 20),
      email: pick("email", 320),
      phone: pick("phone", 50),
      returnAddress: pick("returnAddress", 1000),
    };
    if (s.ico && !/^\d{8}$/.test(s.ico)) throw new ValidationError("IČO musí mít 8 číslic");
    this.repo.setKv(`seller:${shopId}`, JSON.stringify(s));
    return { seller: s, missing: sellerMissing(s) };
  }

  /** Vzorový formulář pro odstoupení (příloha nařízení vlády č. 363/2013 Sb.). */
  withdrawalForm(shopId: number): string {
    const shop = this.shops.get(shopId);
    const s = this.getSeller(shopId);
    const adresat = s?.legalName
      ? `${s.legalName}, ${s.address ?? "[sídlo]"}${s.ico ? `, IČO ${s.ico}` : ""}, e-mail: ${s.email ?? "[e-mail]"}`
      : `[doplň obchodní firmu, sídlo a e-mail – e-shop ${shop.name}]`;
    return [
      "VZOROVÝ FORMULÁŘ PRO ODSTOUPENÍ OD SMLOUVY",
      "(vyplňte tento formulář a pošlete jej zpět pouze v případě, že chcete odstoupit od smlouvy)",
      "",
      `Adresát: ${adresat}`,
      s?.returnAddress ? `Adresa pro vrácení zboží: ${s.returnAddress}` : "",
      "",
      "Oznamuji/oznamujeme (*), že tímto odstupuji/odstupujeme (*) od smlouvy o nákupu tohoto zboží (*)/o poskytnutí těchto služeb (*):",
      "………………………………………………………………",
      "Číslo objednávky: ……………………",
      "Datum objednání (*)/datum obdržení (*): ……………………",
      "Jméno a příjmení spotřebitele/spotřebitelů: ……………………",
      "Adresa spotřebitele/spotřebitelů: ……………………",
      "Číslo účtu pro vrácení peněz (nepovinné): ……………………",
      "Podpis spotřebitele/spotřebitelů (pouze pokud je tento formulář zasílán v listinné podobě): ……………………",
      "Datum: ……………………",
      "",
      "(*) Nehodící se škrtněte nebo údaje doplňte.",
      "",
    ]
      .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
      .join("\n");
  }

  // GDPR retence
  retentionCandidates(): { id: number; email: string | null; lastOrderAt: string | null }[] {
    if (this.cfg.retentionYears <= 0) return [];
    const cutoff = new Date(this.now());
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - this.cfg.retentionYears);
    const c = cutoff.toISOString();
    return (
      this.repo.db
        .prepare(
          `SELECT c.id, c.email, (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = c.id) AS last_order_at
           FROM customers c WHERE c.anonymized_at IS NULL AND c.updated_at < ?
           AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.customer_id = c.id AND l.stage NOT IN ('WON','LOST'))`,
        )
        .all(c) as any[]
    )
      .filter((r) => (r.last_order_at ?? "") < c)
      .map((r) => ({ id: r.id, email: r.email, lastOrderAt: r.last_order_at }));
  }

  applyRetention(): { anonymized: number[]; skipped: { id: number; reason: string }[] } {
    const out = { anonymized: [] as number[], skipped: [] as { id: number; reason: string }[] };
    for (const c of this.retentionCandidates()) {
      try {
        this.crm.anonymize(c.id);
        out.anonymized.push(c.id);
      } catch (e) {
        out.skipped.push({ id: c.id, reason: (e as Error).message });
      }
    }
    if (out.anonymized.length) this.repo.log(null, "info", `GDPR retence: anonymizováno ${out.anonymized.length} zákazníků`);
    return out;
  }

  // DPH / OSS / IOSS
  vatReport(year: number) {
    if (!Number.isInteger(year) || year < 2021 || year > 2100) throw new ValidationError("Neplatný rok");
    const from = `${year}-01-01`;
    const to = `${year + 1}-01-01`;
    const rows = this.repo.db
      .prepare(
        `SELECT country_code AS country, currency, COUNT(*) AS orders, SUM(total_price) AS gross, SUM(total_tax) AS tax,
           SUM(CASE WHEN total_price > 0 THEN 1 ELSE 0 END) AS n,
           MAX(total_price) AS max_order
         FROM orders WHERE created_at >= ? AND created_at < ? AND status NOT IN ('CANCELLED','IGNORED') AND country_code IS NOT NULL
         GROUP BY country_code, currency`,
      )
      .all(from, to) as any[];
    const missingFx = new Set<string>();
    const eur = (amount: number, cur: string) => {
      const r = this.cfg.fxToEur[cur];
      if (r == null) {
        missingFx.add(cur);
        return 0;
      }
      return Math.round(amount * r * 100) / 100;
    };
    const byCountry = new Map<string, { country: string; orders: number; netEur: number; grossEur: number; maxOrderEur: number }>();
    for (const r of rows) {
      const k = r.country as string;
      const cur = byCountry.get(k) ?? { country: k, orders: 0, netEur: 0, grossEur: 0, maxOrderEur: 0 };
      cur.orders += Number(r.orders);
      cur.grossEur += eur(Number(r.gross), r.currency);
      cur.netEur += eur(Number(r.gross) - Number(r.tax), r.currency);
      cur.maxOrderEur = Math.max(cur.maxOrderEur, eur(Number(r.max_order), r.currency));
      byCountry.set(k, cur);
    }
    const countries = [...byCountry.values()].map((c) => ({
      ...c,
      netEur: Math.round(c.netEur * 100) / 100,
      grossEur: Math.round(c.grossEur * 100) / 100,
      eu: (EU_COUNTRIES as readonly string[]).includes(c.country),
      domestic: c.country === this.cfg.sellerCountry,
    }));
    const crossBorderEu = countries.filter((c) => c.eu && !c.domestic);
    const distanceEur = Math.round(crossBorderEu.reduce((a, c) => a + c.netEur, 0) * 100) / 100;
    const overIoss = this.repo.db
      .prepare(
        `SELECT id, name, currency, total_price FROM orders WHERE created_at >= ? AND created_at < ? AND status NOT IN ('CANCELLED','IGNORED')`,
      )
      .all(from, to)
      .filter((o: any) => eur(Number(o.total_price), o.currency) > IOSS_MAX_CONSIGNMENT_EUR)
      .map((o: any) => ({ id: o.id, name: o.name, totalPrice: o.total_price, currency: o.currency }));
    const pct = Math.round((distanceEur / OSS_THRESHOLD_EUR) * 1000) / 10;
    const warnings: string[] = [];
    if (missingFx.size) warnings.push(`Chybí kurz do EUR pro: ${[...missingFx].join(", ")} – doplň OSS_FX_TO_EUR, jinak je report neúplný`);
    if (pct >= 100) warnings.push(`Překročen limit ${OSS_THRESHOLD_EUR} € pro prodej na dálku v EU – DPH státu zákazníka (OSS)`);
    else if (pct >= 80) warnings.push(`Prodej na dálku v EU je na ${pct} % limitu ${OSS_THRESHOLD_EUR} €`);
    if (overIoss.length) warnings.push(`${overIoss.length} objednávek nad ${IOSS_MAX_CONSIGNMENT_EUR} € – u zásilek ze třetích zemí nejde použít IOSS (běžné celní řízení)`);
    return {
      year,
      sellerCountry: this.cfg.sellerCountry,
      countries,
      euDistanceSales: { netEur: distanceEur, thresholdEur: OSS_THRESHOLD_EUR, percent: pct },
      ordersOverIossLimit: overIoss,
      warnings,
      notes: [
        "Limit 10 000 € (OSS) platí pro prodej na dálku zboží odesílaného z jiného státu EU – součet za všechny e-shopy a země EU mimo domácí.",
        "Zboží odesílané ze třetích zemí (např. z Číny přes AliExpress) je dovoz: zásilky do 150 € lze řešit režimem IOSS, bez limitu 10 000 €.",
        "Částky bez DPH počítané z total_price − total_tax Shopify; přepočet kurzem z OSS_FX_TO_EUR. Pro přiznání použij kurz ČNB podle zákona o DPH.",
        "Report je orientační podklad, ne daňové přiznání – ověř s daňovým poradcem.",
      ],
    };
  }

  overview() {
    const today = this.now().toISOString().slice(0, 10);
    const shops = this.shops.list().map((s) => ({ id: s.id, name: s.name, sellerMissing: sellerMissing(this.getSeller(s.id)) }));
    const one = (sql: string, ...a: string[]) => Number((this.repo.db.prepare(sql).get(...a) as { n: number }).n);
    return {
      gpsrIncompleteProducts: this.gpsrReport().length,
      shopsMissingSellerInfo: shops.filter((s) => s.sellerMissing.length),
      ticketsOverdue: one("SELECT COUNT(*) AS n FROM tickets WHERE closed_at IS NULL AND deadline < ?", today),
      lateWithdrawals: one("SELECT COUNT(*) AS n FROM tickets WHERE type = 'WITHDRAWAL' AND late_filing = 1 AND closed_at IS NULL"),
      retention: { enabled: this.cfg.retentionYears > 0, years: this.cfg.retentionYears, candidates: this.retentionCandidates().length },
      vat: this.vatReport(this.now().getUTCFullYear()).warnings,
      disclaimer: "Pomůcka pro dodržování povinností, ne právní ani daňové poradenství.",
    };
  }
}

// ---------- HTTP ----------

export function complianceRouter(c: ComplianceService): Router {
  const r = Router();
  r.get("/compliance/overview", (_q, res) => void res.json(c.overview()));
  r.get("/compliance/gpsr", (_q, res) => void res.json(c.gpsrReport()));
  r.get("/compliance/products/:id/gpsr", (q, res) => void res.json(c.getGpsr(idParam(q))));
  r.put("/compliance/products/:id/gpsr", (q, res) => void res.json(c.setGpsr(idParam(q), q.body)));
  r.post("/compliance/products/:id/gpsr/copy", (q, res) => {
    const to = q.body?.toProductIds;
    if (!Array.isArray(to) || !to.every((x) => Number.isInteger(x) && x > 0)) throw new ValidationError("toProductIds musí být pole ID");
    res.json(c.copyGpsr(idParam(q), to));
  });
  r.get("/compliance/shops/:id/seller", (q, res) => {
    const s = c.getSeller(idParam(q));
    res.json({ seller: s, missing: sellerMissing(s) });
  });
  r.put("/compliance/shops/:id/seller", (q, res) => void res.json(c.setSeller(idParam(q), q.body)));
  r.get("/compliance/shops/:id/withdrawal-form", (q, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(c.withdrawalForm(idParam(q)));
  });
  r.get("/compliance/gdpr/retention", (_q, res) => void res.json(c.retentionCandidates()));
  r.post("/compliance/gdpr/retention", (_q, res) => void res.json(c.applyRetention()));
  r.get("/compliance/vat", (q, res) => void res.json(c.vatReport(Number(q.query.year ?? new Date().getUTCFullYear()))));
  return r;
}
