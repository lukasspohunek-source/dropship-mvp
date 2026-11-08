import type { AdRow, AdsSource } from "./ads.js";

/**
 * Další reklamní kanály (jen čtení útraty): TikTok Ads, Google Ads, Sklik.
 * Heureka a ostatní: univerzální CSV import (parseAdsCsv).
 * Tvary odpovědí podle veřejné dokumentace; první reálný běh ověř.
 */

const enc = (v: unknown) => JSON.stringify(v);

async function readJson(res: Response, label: string): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

function addDays(date: string, d: number): string {
  const x = new Date(`${date}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
}

// ---------- TikTok Marketing API v1.3 ----------

export class TikTokAdsSource implements AdsSource {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = "https://business-api.tiktok.com/open_api/v1.3",
  ) {}

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const res = await this.fetchImpl(`${this.base}${path}?${new URLSearchParams(params)}`, {
      headers: { "Access-Token": this.token },
      signal: AbortSignal.timeout(60_000),
    });
    const j = await readJson(res, "TikTok API");
    if (j.code !== 0) {
      const hint = j.code === 40105 || j.code === 40104 ? " – neplatný token (TIKTOK_ACCESS_TOKEN)" : "";
      throw new Error(`TikTok API (${j.code}): ${j.message ?? "chyba"}${hint}`);
    }
    return j.data;
  }

  async account(accountId: string) {
    const id = accountId.trim();
    const d = await this.get("/advertiser/info/", { advertiser_ids: enc([id]), fields: enc(["name", "currency"]) });
    const a = d?.list?.[0];
    if (!a?.currency) throw new Error("TikTok nevrátil měnu účtu");
    return { id, name: a.name ?? null, currency: String(a.currency).toUpperCase() };
  }

  /** Report je omezený na 30 dní – delší období se dělí. */
  async insights(accountId: string, since: string, until: string): Promise<AdRow[]> {
    const out: AdRow[] = [];
    for (let from = since; from <= until; from = addDays(from, 30)) {
      const end = addDays(from, 29);
      const to = end < until ? end : until;
      for (let page = 1, total = 1; page <= total && page <= 50; page++) {
        const d = await this.get("/report/integrated/get/", {
          advertiser_id: accountId,
          report_type: "BASIC",
          data_level: "AUCTION_AD",
          dimensions: enc(["ad_id", "stat_time_day"]),
          metrics: enc(["spend", "impressions", "clicks", "complete_payment", "complete_payment_roas", "campaign_id", "campaign_name", "adgroup_id", "adgroup_name", "ad_name"]),
          start_date: from,
          end_date: to,
          page: String(page),
          page_size: "1000",
        });
        total = Number(d?.page_info?.total_page ?? 1);
        for (const r of d?.list ?? []) out.push(tiktokRow(r));
      }
    }
    return out;
  }
}

function tiktokRow(r: any): AdRow {
  const m = r.metrics ?? {};
  const spend = Number(m.spend) || 0;
  return {
    date: String(r.dimensions?.stat_time_day ?? "").slice(0, 10),
    adId: `tt:${r.dimensions?.ad_id}`,
    adName: m.ad_name ?? null,
    adsetId: m.adgroup_id ? `tt:${m.adgroup_id}` : null,
    adsetName: m.adgroup_name ?? null,
    campaignId: m.campaign_id ? String(m.campaign_id) : null,
    campaignName: m.campaign_name ?? null,
    spend,
    impressions: Number(m.impressions) || 0,
    clicks: Number(m.clicks) || 0,
    purchases: Number(m.complete_payment) || 0,
    purchaseValue: Math.round((Number(m.complete_payment_roas) || 0) * spend * 100) / 100,
  };
}

// ---------- Google Ads API (REST, GAQL) ----------

export interface GoogleAdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** ID správcovského účtu (MCC), pokud se k účtu přistupuje přes něj. */
  loginCustomerId?: string | null;
  version?: string;
}

export const normGoogleId = (id: string) => id.replace(/\D/g, "");

export class GoogleAdsSource implements AdsSource {
  private access: { token: string; exp: number } | null = null;

  constructor(
    private readonly cfg: GoogleAdsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async token(): Promise<string> {
    if (this.access && this.access.exp > this.now() + 60_000) return this.access.token;
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: this.cfg.refreshToken }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await readJson(res, "Google OAuth");
    if (!j.access_token) throw new Error(`Google OAuth: ${j.error_description ?? j.error ?? "bez tokenu"} – zkontroluj GOOGLE_ADS_* proměnné`);
    this.access = { token: j.access_token, exp: this.now() + Number(j.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  private async query(customerId: string, gaql: string): Promise<any[]> {
    const id = normGoogleId(customerId);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.token()}`,
      "developer-token": this.cfg.developerToken,
      "Content-Type": "application/json",
    };
    if (this.cfg.loginCustomerId) headers["login-customer-id"] = normGoogleId(this.cfg.loginCustomerId);
    const res = await this.fetchImpl(`https://googleads.googleapis.com/${this.cfg.version ?? "v26"}/customers/${id}/googleAds:searchStream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: gaql }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = await readJson(res, "Google Ads API");
    const chunks: any[] = Array.isArray(j) ? j : [j];
    const err = chunks.find((c) => c?.error)?.error;
    if (err || !res.ok) throw new Error(`Google Ads API (${err?.code ?? res.status}): ${err?.message ?? "chyba"}`);
    return chunks.flatMap((c) => c.results ?? []);
  }

  async account(accountId: string) {
    const id = normGoogleId(accountId);
    const r = await this.query(id, "SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1");
    const c = r[0]?.customer;
    if (!c?.currencyCode) throw new Error("Google Ads nevrátil měnu účtu");
    return { id, name: c.descriptiveName ?? null, currency: String(c.currencyCode).toUpperCase() };
  }

  async insights(accountId: string, since: string, until: string): Promise<AdRow[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error("Neplatné datum");
    const rows = await this.query(
      accountId,
      `SELECT segments.date, campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id,
         metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
       FROM ad_group_ad WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.impressions > 0`,
    );
    return rows.map(
      (r: any): AdRow => ({
        date: String(r.segments?.date),
        adId: `g:${r.adGroupAd?.ad?.id}`,
        adName: null,
        adsetId: r.adGroup?.id ? `g:${r.adGroup.id}` : null,
        adsetName: r.adGroup?.name ?? null,
        campaignId: r.campaign?.id ? String(r.campaign.id) : null,
        campaignName: r.campaign?.name ?? null,
        spend: Math.round((Number(r.metrics?.costMicros) || 0) / 10_000) / 100,
        impressions: Number(r.metrics?.impressions) || 0,
        clicks: Number(r.metrics?.clicks) || 0,
        purchases: Number(r.metrics?.conversions) || 0,
        purchaseValue: Number(r.metrics?.conversionsValue) || 0,
      }),
    );
  }
}

// ---------- Sklik (API Drak JSON v5) ----------

export class SklikSource implements AdsSource {
  private session: string | null = null;

  /**
   * @param moneyDivisor Sklik dokumentuje rozpočty v haléřích; u totalMoney jednotku neuvádí.
   *        Výchozí 100 (haléře → Kč) – ověř na prvním reportu proti rozhraní Skliku.
   */
  constructor(
    private readonly token: string,
    private readonly moneyDivisor = 100,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = "https://api.sklik.cz/drak/json/v5",
  ) {}

  private async call(method: string, params: unknown[], retry = true): Promise<any> {
    const res = await this.fetchImpl(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(60_000),
    });
    const j = await readJson(res, "Sklik API");
    if (Number(j.status) === 401 && retry && method !== "client.loginByToken") {
      this.session = null;
      const user = { ...(params[0] as object), session: await this.login() };
      return this.call(method, [user, ...params.slice(1)], false);
    }
    if (Number(j.status) !== 200 && Number(j.status) !== 206) throw new Error(`Sklik API (${j.status}): ${j.statusMessage ?? "chyba"}`);
    if (j.session) this.session = j.session;
    return j;
  }

  private async login(): Promise<string> {
    if (this.session) return this.session;
    const j = await this.call("client.loginByToken", [this.token]);
    if (!j.session) throw new Error("Sklik nevrátil session – zkontroluj SKLIK_TOKEN");
    this.session = j.session;
    return j.session;
  }

  async account(accountId: string) {
    if (accountId !== "self" && !/^\d+$/.test(accountId)) throw new Error('Sklik: ID účtu musí být číslo (userId spravovaného účtu) nebo "self"');
    await this.login();
    return { id: accountId, name: "Sklik", currency: "CZK" };
  }

  async insights(accountId: string, since: string, until: string): Promise<AdRow[]> {
    const user = () => (accountId === "self" ? { session: this.session } : { session: this.session, userId: Number(accountId) });
    await this.login();
    const created = await this.call("campaigns.createReport", [user(), { dateFrom: since, dateTo: until }, { statGranularity: "daily" }]);
    const total = Number(created.totalCount ?? 0);
    const out: AdRow[] = [];
    for (let offset = 0; offset < total && offset < 5000; offset += 100) {
      const r = await this.call("campaigns.readReport", [
        user(),
        created.reportId,
        { offset, limit: 100, allowEmptyStatistics: false, displayColumns: ["id", "name", "clicks", "impressions", "totalMoney", "conversions", "conversionValue"] },
      ]);
      for (const c of r.report ?? []) for (const st of c.stats ?? []) out.push(this.row(c, st));
    }
    return out;
  }

  private row(c: any, st: any): AdRow {
    return {
      date: String(st.date).slice(0, 10),
      adId: `sk:${c.id}`,
      adName: null,
      adsetId: null,
      adsetName: null,
      campaignId: String(c.id),
      campaignName: c.name ?? null,
      spend: (Number(st.totalMoney) || 0) / this.moneyDivisor,
      impressions: Number(st.impressions) || 0,
      clicks: Number(st.clicks) || 0,
      purchases: Number(st.conversions) || 0,
      purchaseValue: (Number(st.conversionValue) || 0) / this.moneyDivisor,
    };
  }
}

// ---------- CSV import (Heureka a cokoli dalšího) ----------

export interface CsvRow {
  date: string;
  campaign: string;
  spend: number;
  clicks: number;
  impressions: number;
  conversions: number;
  value: number;
}

const HEADERS: Record<keyof CsvRow, string[]> = {
  date: ["date", "datum", "den", "day"],
  campaign: ["campaign", "kampan", "kampaň", "nazev", "název", "campaign name"],
  spend: ["spend", "cost", "costs", "naklady", "náklady", "cena", "utrata", "útrata"],
  clicks: ["clicks", "kliky", "prokliky", "kliknuti", "kliknutí"],
  impressions: ["impressions", "zobrazeni", "zobrazení", "imprese"],
  conversions: ["conversions", "konverze", "objednavky", "objednávky", "nakupy", "nákupy", "orders"],
  value: ["value", "hodnota", "trzby", "tržby", "obrat", "revenue", "conversion value", "hodnota konverzí"],
};

const normHead = (s: string) => s.trim().replace(/^﻿/, "").replace(/^"|"$/g, "").trim().toLowerCase();

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"' && quoted && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function csvNumber(v: string | undefined): number {
  if (v == null) return 0;
  const t = v.replace(/\s| |Kč|CZK|EUR|€/gi, "").trim();
  if (!t) return 0;
  // 1.234,56 / 1234,56 → desetinná čárka; 1,234.56 / 1234.56 → tečka
  const n = /,\d{1,2}$/.test(t) ? t.replaceAll(".", "").replace(",", ".") : t.replaceAll(",", "");
  const x = Number(n);
  if (!Number.isFinite(x)) throw new Error(`Neplatné číslo „${v}“`);
  return x;
}

export function csvDate(v: string): string {
  const t = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  throw new Error(`Neplatné datum „${v}“ (čekám RRRR-MM-DD nebo D. M. RRRR)`);
}

/** Načte CSV (oddělovač ; , nebo tab, česká i anglická hlavička). Povinné: datum, kampaň, útrata. */
export function parseAdsCsv(text: string, maxRows = 50_000): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("CSV je prázdné");
  const head = lines[0]!;
  const sep = [";", "\t", ","].sort((a, b) => head.split(b).length - head.split(a).length)[0]!;
  const cols = splitLine(head, sep).map(normHead);
  const idx = Object.fromEntries(Object.entries(HEADERS).map(([k, names]) => [k, cols.findIndex((c) => names.includes(c))])) as Record<keyof CsvRow, number>;
  const missing = (["date", "campaign", "spend"] as const).filter((k) => idx[k] < 0);
  if (missing.length) throw new Error(`V hlavičce chybí sloupce: ${missing.join(", ")} (např. datum;kampaň;náklady;kliky;zobrazení;konverze;hodnota)`);
  if (lines.length - 1 > maxRows) throw new Error(`Max. ${maxRows} řádků`);
  return lines.slice(1).map((line, i) => {
    const c = splitLine(line, sep);
    const get = (k: keyof CsvRow) => (idx[k] >= 0 ? c[idx[k]] : undefined);
    try {
      const campaign = (get("campaign") ?? "").trim();
      if (!campaign) throw new Error("chybí název kampaně");
      return {
        date: csvDate(get("date") ?? ""),
        campaign: campaign.slice(0, 200),
        spend: csvNumber(get("spend")),
        clicks: Math.round(csvNumber(get("clicks"))),
        impressions: Math.round(csvNumber(get("impressions"))),
        conversions: csvNumber(get("conversions")),
        value: csvNumber(get("value")),
      };
    } catch (e) {
      throw new Error(`Řádek ${i + 2}: ${(e as Error).message}`);
    }
  });
}
