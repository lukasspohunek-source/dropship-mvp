import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  ClaudeTrendAnalyzer,
  GoogleTrendsSource,
  HeurekaSource,
  TikTokSource,
  TrendService,
  collectSuggestions,
  htmlToText,
  type Analysis,
  type AnalyzerInput,
  type TrendSource,
} from "../src/trends.js";
import { memRepo, seedShop, shopService } from "./helpers.js";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

test("Google Trends: trending now + rostoucí dotazy, Breakout = maximum", async () => {
  const urls: string[] = [];
  const src = new GoogleTrendsSource("KEY", (async (u: string) => {
    urls.push(u);
    if (u.includes("trending_now")) return json({ trending_searches: [{ query: "lampa na čtení", search_volume: 20000 }] });
    return json({ related_queries: { rising: [{ query: "magnetická lampa", value: "Breakout" }, { query: "lampa usb c", extracted_value: 250, value: "+250%" }] } });
  }) as typeof fetch);
  const s = await src.fetch({ seeds: ["lampa"], country: "CZ", language: "cs" });
  assert.equal(s.length, 3);
  assert.equal(s.find((x) => x.term === "magnetická lampa")!.score, 100);
  assert.ok(s.find((x) => x.term === "lampa usb c")!.score > 50);
  assert.match(urls[1]!, /geo=CZ/);
  assert.match(urls[1]!, /data_type=RELATED_QUERIES/);
});

test("Seznam: návrhy z neznámé struktury, bez duplicit a bez samotného dotazu", () => {
  const r = collectSuggestions({ result: [{ itemText: "lampa" }, { itemText: "lampa stolní" }, { nested: { text: "lampa stolní" } }, { phrase: "lampa led" }] }, "lampa");
  assert.deepEqual(r, ["lampa stolní", "lampa led"]);
});

test("TikTok přes Bright Data: řazení podle zhlédnutí, 202 = chyba", async () => {
  let body = "";
  const ok = new TikTokSource({ apiKey: "BD" }, "gd_tt", (async (_u: string, init: RequestInit) => {
    body = String(init.body);
    return json([
      { description: "Tahle lampa je hit #lampa", play_count: 1200000, digg_count: 50000, hashtags: ["lampa", "fyp"], url: "https://tiktok.com/1" },
      { description: "nuda", play_count: 300 },
      { error: "blocked" },
    ]);
  }) as typeof fetch);
  const s = await ok.fetch({ seeds: ["Stolní lampa"], country: "CZ", language: "cs" });
  assert.deepEqual(JSON.parse(body), [{ url: "https://www.tiktok.com/tag/stolnilampa" }]);
  assert.equal(s.length, 2);
  assert.match(s[0]!.term, /hit/);
  assert.match(s[0]!.detail!, /1200000 zhlédnutí/);
  const pending = new TikTokSource({ apiKey: "BD" }, "gd_tt", (async () => new Response("{}", { status: 202 })) as unknown as typeof fetch);
  await assert.rejects(pending.fetch({ seeds: ["x"], country: "CZ", language: "cs" }), /snapshot/);
});

test("Heureka: zóna Web Unlockeru, SK doména, text bez skriptů", async () => {
  let req: any;
  const h = new HeurekaSource({ apiKey: "BD", unlockerZone: "unl1" }, (async (_u: string, init: RequestInit) => {
    req = JSON.parse(String(init.body));
    return new Response("<html><script>x()</script><h3>Lampa A 499 Kč</h3>&nbsp;<p>Lampa B</p></html>");
  }) as unknown as typeof fetch);
  const s = await h.fetch({ seeds: ["lampa"], country: "SK", language: "sk" });
  assert.equal(req.zone, "unl1");
  assert.match(req.url, /^https:\/\/www\.heureka\.sk\//);
  assert.equal(s[0]!.detail, "Lampa A 499 Kč Lampa B");
  assert.equal(htmlToText("a&amp;b &#353;"), "a&b š");
});

test("ClaudeTrendAnalyzer: Opus 5.5, fallbacks default, strukturovaný výstup přes JSON schéma", async () => {
  const analysis: Analysis = {
    summary: "Roste zájem o magnetické lampy.",
    candidates: [{ name: "Magnetická lampa", why: "Roste na Google i TikToku", evidence: ["google_trends: Breakout"], searchKeywords: ["magnetic led lamp"], aeProductId: "1005", expectedSellPrice: 499, score: 87, risks: ["Li-ion baterie"] }],
  };
  let sent: any;
  let headers: Headers | undefined;
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      headers = new Headers(init.headers);
      return json({
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(analysis) }],
        stop_reason: "end_turn", stop_sequence: null, stop_details: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      });
    }) as unknown as typeof fetch,
  });
  const out = await new ClaudeTrendAnalyzer(client).analyze({ shop: { name: "Pokovo", country: "CZ", currency: "CZK" }, seeds: ["lampa"], signals: [], aeProducts: [] });
  assert.deepEqual(out, analysis);
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.fallbacks, "default");
  assert.match(headers!.get("anthropic-beta")!, /server-side-fallback-2026-07-01/);
  assert.equal(sent.output_config.format.type, "json_schema");
  assert.equal(sent.output_config.effort, "high");
  assert.equal(sent.tool_choice, undefined, "žádné nucené volání nástroje (Opus 5.5 vrací 400)");
  assert.match(sent.system, /ignoruj/);
});

test("ClaudeTrendAnalyzer: odmítnutí se ohlásí jako chyba", async () => {
  const client = new Anthropic({
    apiKey: "k",
    maxRetries: 0,
    fetch: (async () => json({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: "cyber", explanation: null }, usage: { input_tokens: 1, output_tokens: 0 } })) as unknown as typeof fetch,
  });
  await assert.rejects(new ClaudeTrendAnalyzer(client).analyze({ shop: { name: "x", country: "CZ", currency: "CZK" }, seeds: [], signals: [], aeProducts: [] }), /odmítla \(cyber\)/);
});

function service(opts: { sources?: TrendSource[]; analyzer?: (i: AnalyzerInput) => Analysis; maxRuns?: number } = {}) {
  const repo = memRepo();
  const shopId = seedShop(repo);
  const shops = shopService(repo);
  const seen: AnalyzerInput[] = [];
  const imported: string[] = [];
  const t = new TrendService(
    repo,
    shops,
    opts.sources ?? [
      { id: "ok", label: "OK", fetch: async () => [{ source: "ok", term: "lampa", score: 80 }] },
      { id: "broken", label: "Broken", fetch: async () => { throw new Error("HTTP 403"); } },
    ],
    async () => [{ productId: "1005", title: "Magnetic LED lamp", priceAe: 5.2, currency: "USD", orders: 1200, rating: 96, url: null }],
    opts.analyzer ? { analyze: async (i) => (seen.push(i), opts.analyzer!(i)) } : null,
    { maxRunsPerDay: opts.maxRuns ?? 10 },
    { importProduct: async (_s: number, id: string) => (imported.push(id), { product: {}, variants: [] }) } as any,
  );
  return { repo, shopId, t, seen, imported };
}

const ANALYSIS: Analysis = {
  summary: "S",
  candidates: [
    { name: "Lampa", why: "w", evidence: ["ok: lampa"], searchKeywords: ["magnetic lamp"], aeProductId: "1005", expectedSellPrice: null, score: 90, risks: [] },
    { name: "Vymyšlené", why: "w", evidence: [], searchKeywords: ["fake thing"], aeProductId: "999999", expectedSellPrice: null, score: 140, risks: [] },
  ],
};

test("běh: chyba jednoho zdroje nezastaví ostatní; vymyšlené AE ID se zahodí; marži počítá kód", async () => {
  const s = service({ analyzer: () => ANALYSIS });
  const id = s.t.start(s.shopId, "lampa, organizér");
  await new Promise((r) => setTimeout(r, 20));
  const run = s.t.get(id);
  assert.equal(run.status, "DONE");
  assert.deepEqual(run.sourceErrors, { broken: "HTTP 403" });
  assert.deepEqual(s.seen[0]!.seeds, ["lampa", "organizér"]);
  assert.equal(s.seen[0]!.aeProducts.length, 1);
  const [fake, real] = run.result.candidates;
  assert.equal(fake.score, 100, "skóre oříznuto na 0–100");
  assert.equal(fake.aeProductId, null, "ID mimo seznam AE = halucinace");
  assert.equal(real.ourPrice, 239);
  assert.equal(real.costInShopCurrency, 119.6);
  assert.equal(real.marginPct, 50);
  assert.match(real.aeSearchUrl, /wholesale-magnetic-lamp/);
  await assert.rejects(s.t.importCandidate(id, 0), /ručně/);
  await s.t.importCandidate(id, 1);
  assert.deepEqual(s.imported, ["1005"]);
});

test("bez AI se uloží jen signály; validace a denní limit", async () => {
  const s = service({ maxRuns: 1 });
  assert.throws(() => s.t.start(s.shopId, "  "), /téma/);
  const id = s.t.start(s.shopId, ["lampa"]);
  assert.throws(() => s.t.start(s.shopId, ["x"]), /limit|probíhá/);
  await new Promise((r) => setTimeout(r, 20));
  const run = s.t.get(id);
  assert.equal(run.result.aiUsed, false);
  assert.equal(run.data.signals.length, 1);
  assert.throws(() => s.t.start(s.shopId, ["x"]), /Denní limit/);
});

test("když nic nevrátí data, běh je FAILED s důvody", async () => {
  const s = service({ sources: [{ id: "a", label: "A", fetch: async () => { throw new Error("down"); } }] });
  (s.t as any).aeTrending = async () => { throw new Error("AE down"); };
  const id = s.t.start(s.shopId, ["x"]);
  await new Promise((r) => setTimeout(r, 20));
  const run = s.t.get(id);
  assert.equal(run.status, "FAILED");
  assert.match(run.error!, /down/);
});
