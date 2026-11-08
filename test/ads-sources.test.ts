import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THRESHOLDS, AdsService } from "../src/ads.js";
import { GoogleAdsSource, SklikSource, TikTokAdsSource, csvDate, csvNumber, parseAdsCsv } from "../src/ads-sources.js";
import { ConflictError, ValidationError } from "../src/errors.js";
import { memRepo, seedShop, shopService } from "./helpers.js";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

test("TikTok: Access-Token hlavička, dělení na 30 dní, stránkování, hodnota z ROAS", async () => {
  const urls: URL[] = [];
  const src = new TikTokAdsSource("TT", (async (u: string, init: RequestInit) => {
    const url = new URL(u);
    urls.push(url);
    assert.equal((init.headers as Record<string, string>)["Access-Token"], "TT");
    if (url.pathname.endsWith("/advertiser/info/")) return json({ code: 0, data: { list: [{ name: "Pokovo TT", currency: "czk" }] } });
    const page = Number(url.searchParams.get("page"));
    return json({
      code: 0,
      data: {
        page_info: { total_page: 2 },
        list: [{ dimensions: { ad_id: `${page}1`, stat_time_day: `${url.searchParams.get("start_date")} 00:00:00` }, metrics: { spend: "100.5", impressions: "1000", clicks: "20", complete_payment: "2", complete_payment_roas: "3", campaign_id: "77", campaign_name: "Lampa TT" } }],
      },
    });
  }) as typeof fetch);
  assert.deepEqual(await src.account("7000000000001"), { id: "7000000000001", name: "Pokovo TT", currency: "CZK" });
  const rows = await src.insights("7000000000001", "2026-09-01", "2026-11-08");
  const reports = urls.filter((u) => u.pathname.endsWith("/report/integrated/get/"));
  assert.deepEqual([...new Set(reports.map((u) => `${u.searchParams.get("start_date")}..${u.searchParams.get("end_date")}`))], ["2026-09-01..2026-09-30", "2026-10-01..2026-10-30", "2026-10-31..2026-11-08"]);
  assert.equal(rows.length, 6, "3 okna × 2 stránky");
  assert.deepEqual([rows[0]!.date, rows[0]!.adId, rows[0]!.spend, rows[0]!.purchases, rows[0]!.purchaseValue], ["2026-09-01", "tt:11", 100.5, 2, 301.5]);
  assert.equal(JSON.parse(reports[0]!.searchParams.get("dimensions")!)[1], "stat_time_day");
  const bad = new TikTokAdsSource("X", (async () => json({ code: 40105, message: "Access token is incorrect" })) as unknown as typeof fetch);
  await assert.rejects(bad.account("1"), /TIKTOK_ACCESS_TOKEN/);
});

test("Google Ads: OAuth refresh (cache), developer-token, MCC, GAQL, mikro-jednotky", async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let tokenCalls = 0;
  const src = new GoogleAdsSource(
    { developerToken: "DEV", clientId: "cid", clientSecret: "sec", refreshToken: "ref", loginCustomerId: "123-456-7890", version: "v26" },
    (async (u: string, init: RequestInit) => {
      if (u.startsWith("https://oauth2.googleapis.com/token")) {
        tokenCalls++;
        assert.match(String(init.body), /grant_type=refresh_token/);
        return json({ access_token: "AT", expires_in: 3600 });
      }
      calls.push({ url: u, headers: init.headers as Record<string, string>, body: String(init.body) });
      const q = JSON.parse(String(init.body)).query as string;
      if (q.includes("FROM customer")) return json([{ results: [{ customer: { descriptiveName: "Pokovo G", currencyCode: "CZK" } }] }]);
      return json([{ results: [{ segments: { date: "2026-11-01" }, campaign: { id: "11", name: "Lampa G" }, adGroup: { id: "22", name: "AG" }, adGroupAd: { ad: { id: "33" } }, metrics: { costMicros: "12345678", impressions: "500", clicks: "9", conversions: 1.5, conversionsValue: 600 } }] }]);
    }) as typeof fetch,
  );
  assert.deepEqual(await src.account("111-222-3333"), { id: "1112223333", name: "Pokovo G", currency: "CZK" });
  const rows = await src.insights("1112223333", "2026-11-01", "2026-11-08");
  assert.equal(tokenCalls, 1, "token se cachuje");
  assert.equal(calls[1]!.url, "https://googleads.googleapis.com/v26/customers/1112223333/googleAds:searchStream");
  assert.equal(calls[1]!.headers["developer-token"], "DEV");
  assert.equal(calls[1]!.headers["login-customer-id"], "1234567890");
  assert.match(calls[1]!.body, /BETWEEN '2026-11-01' AND '2026-11-08'/);
  assert.deepEqual([rows[0]!.spend, rows[0]!.campaignId, rows[0]!.adId, rows[0]!.purchases], [12.35, "11", "g:33", 1.5]);
  await assert.rejects(src.insights("1", "2026-11-01' OR 1=1 --", "2026-11-08"), /Neplatné datum/);
});

test("Sklik: login tokenem, poziční parametry, report po dnech, haléře → Kč, obnova session po 401", async () => {
  const bodies: { method: string; params: any[] }[] = [];
  let sessions = 0;
  let expired = true;
  const src = new SklikSource("SKTOKEN", 100, (async (u: string, init: RequestInit) => {
    const method = u.split("/").pop()!;
    const params = JSON.parse(String(init.body));
    bodies.push({ method, params });
    if (method === "client.loginByToken") return json({ status: 200, session: `S${++sessions}` });
    if (method === "campaigns.createReport") {
      if (expired) {
        expired = false;
        return json({ status: 401, statusMessage: "Invalid session" });
      }
      return json({ status: 200, reportId: "R1", totalCount: 1, session: params[0].session });
    }
    return json({ status: 200, report: [{ id: 501, name: "Lampa Sklik", stats: [{ date: "2026-11-01T00:00:00", totalMoney: 12345, clicks: 30, impressions: 900, conversions: 2, conversionValue: 110000 }] }] });
  }) as typeof fetch);
  assert.deepEqual(await src.account("self"), { id: "self", name: "Sklik", currency: "CZK" });
  await assert.rejects(src.account("abc"), /číslo/);
  const rows = await src.insights("987", "2026-11-01", "2026-11-08");
  assert.deepEqual(bodies[0], { method: "client.loginByToken", params: ["SKTOKEN"] });
  const create = bodies.filter((b) => b.method === "campaigns.createReport");
  assert.deepEqual(create.at(-1)!.params, [{ session: "S2", userId: 987 }, { dateFrom: "2026-11-01", dateTo: "2026-11-08" }, { statGranularity: "daily" }]);
  const read = bodies.find((b) => b.method === "campaigns.readReport")!;
  assert.equal(read.params[1], "R1");
  assert.deepEqual(read.params[2].displayColumns, ["id", "name", "clicks", "impressions", "totalMoney", "conversions", "conversionValue"]);
  assert.deepEqual([rows[0]!.date, rows[0]!.campaignId, rows[0]!.spend, rows[0]!.purchaseValue], ["2026-11-01", "501", 123.45, 1100]);
});

test("CSV: české hlavičky, středník, desetinná čárka, mezery v tisících, uvozovky, chyby s číslem řádku", () => {
  const rows = parseAdsCsv('﻿Datum;Kampaň;Náklady;Prokliky;Zobrazení;Objednávky;Tržby\n1. 11. 2026;"Lampy; LED";1 234,50 Kč;120;3 400;3;2 997\n2026-11-02;Háčky;99,9;10;500;0;0\n');
  assert.deepEqual(rows[0], { date: "2026-11-01", campaign: "Lampy; LED", spend: 1234.5, clicks: 120, impressions: 3400, conversions: 3, value: 2997 });
  assert.equal(rows[1]!.spend, 99.9);
  assert.equal(parseAdsCsv("date,campaign,cost\n2026-11-01,A,1,234.56")[0]!.spend, 1, "čárka jako oddělovač sloupců – přebytečný sloupec se ignoruje");
  assert.equal(csvNumber("1.234,56"), 1234.56);
  assert.equal(csvNumber("1,234.56"), 1234.56);
  assert.equal(csvDate("2026-1-5"), "2026-01-05");
  assert.throws(() => parseAdsCsv("datum;kampaň\n2026-11-01;A"), /náklady|spend/);
  assert.throws(() => parseAdsCsv("datum;kampaň;náklady\n32/11/2026;A;1"), /Řádek 2: Neplatné datum/);
  assert.throws(() => parseAdsCsv("datum;kampaň;náklady"), /prázdné/);
});

test("více platforem: účty s platformou, CSV import Heureky, sync jen platforem s API, statistika sčítá vše", async () => {
  const repo = memRepo(() => new Date("2026-11-08T12:00:00Z"));
  const shopId = seedShop(repo);
  const shops = shopService(repo);
  const tiktok = {
    account: async (id: string) => ({ id, name: "TT", currency: "CZK" }),
    insights: async () => [{ date: "2026-11-05", adId: "tt:1", adName: null, adsetId: null, adsetName: null, campaignId: "900", campaignName: "TT kampaň", spend: 200, impressions: 1000, clicks: 10, purchases: 0, purchaseValue: 0 }],
  };
  const ads = new AdsService(repo, shops, { tiktok }, null, { feePct: 2, feeFixed: 0, fxToEur: { EUR: 1, CZK: 0.04 }, thresholds: DEFAULT_THRESHOLDS }, () => new Date("2026-11-08T12:00:00Z"));
  await assert.rejects(ads.addAccount(shopId, "123456", "meta"), /META_ACCESS_TOKEN/);
  await assert.rejects(ads.addAccount(shopId, "123", "neco"), /platform/);
  const tt = await ads.addAccount(shopId, "7000000000001", "tiktok");
  const heu = await ads.addAccount(shopId, "heureka-cz", "heureka");
  assert.equal(heu.currency, "CZK");
  assert.deepEqual(ads.importCsv(heu.id, "datum;kampaň;náklady;prokliky\n2026-11-05;Lampy;150,5;40\n2026-11-06;Lampy;50;10"), { rows: 2, from: "2026-11-05", to: "2026-11-06" });
  ads.importCsv(heu.id, "datum;kampaň;náklady\n2026-11-06;Lampy;60");
  // Chybné CSV je chyba vstupu (400), ne chyba serveru; účet s API nejde plnit z CSV (dvojí útrata).
  assert.throws(() => ads.importCsv(heu.id, ""), ValidationError);
  assert.throws(() => ads.importCsv(heu.id, "datum;cena\n2026-11-05;10"), (e) => e instanceof ValidationError && /chybí sloupce/.test(e.message));
  assert.throws(() => ads.importCsv(heu.id, "datum;kampaň;náklady\n2026-11-05;Lampy;abc"), (e) => e instanceof ValidationError && /Řádek 2/.test(e.message));
  assert.throws(() => ads.importCsv(tt.id, "datum;kampaň;náklady\n2026-11-05;TT kampaň;99"), (e) => e instanceof ConflictError && /dvakrát/.test(e.message));
  assert.deepEqual(await ads.syncAll(), { accounts: 1, rows: 1, errors: 0 }, "Heureka se nesynchronizuje, jen importuje");
  const st = ads.stats(shopId, "2026-11-01", "2026-11-08");
  assert.equal(st.totals.spend, 410.5, "200 TikTok + 150,5 + 60 Heureka (6. 11. přepsáno)");
  assert.deepEqual(st.campaigns.map((c) => [c.platform, c.name]).sort(), [["heureka", "Lampy"], ["tiktok", "TT kampaň"]]);
  assert.ok(ads.status().platforms.includes("heureka"));
});
