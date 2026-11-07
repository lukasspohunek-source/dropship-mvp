import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretBox } from "../src/crypto.js";
import { BOX, memRepo, seedShop, shopService } from "./helpers.js";

test("SecretBox: šifrování tam a zpět, jiný klíč neotevře, poškození se pozná", () => {
  const sealed = BOX.seal("shpat_abc");
  assert.notEqual(sealed, "shpat_abc");
  assert.equal(BOX.open(sealed), "shpat_abc");
  assert.notEqual(BOX.seal("x"), BOX.seal("x"), "náhodné IV");
  assert.throws(() => new SecretBox("jiny-klic-0123456789-0123456789-xx").open(sealed));
  const parts = sealed.split(":");
  parts[3] = Buffer.from("podvrh").toString("base64");
  assert.throws(() => BOX.open(parts.join(":")));
  assert.throws(() => new SecretBox("kratky"));
});

test("tokeny jsou v DB šifrované a webhook secret se dá dešifrovat", () => {
  const repo = memRepo();
  seedShop(repo, { secret: "whsec_tajne" });
  const raw = JSON.stringify(repo.db.prepare("SELECT * FROM shops").all());
  assert.ok(!raw.includes("shpat_test") && !raw.includes("whsec_tajne"));
  assert.equal(shopService(repo).findForWebhook("pokovo.myshopify.com")?.webhookSecret, "whsec_tajne");
});

test("store() vytvoří Shopify klienta s dešifrovaným tokenem pro správný e-shop", async () => {
  const repo = memRepo();
  const urls: string[] = [];
  const tokens: string[] = [];
  const svc = shopService(repo, (async (u: string, init: RequestInit) => {
    urls.push(u);
    tokens.push((init.headers as Record<string, string>)["X-Shopify-Access-Token"]!);
    return new Response(JSON.stringify({ data: { ok: true } }));
  }) as unknown as typeof fetch);
  const id = svc.create({ domain: "a.myshopify.com", name: "A", currency: "czk", country: "cz", adminToken: "tokA", webhookSecret: "s" }).id;
  assert.equal(svc.get(id).currency, "CZK");
  await svc.store(id).graphql("{ shop { id } }", {});
  assert.equal(urls[0], "https://a.myshopify.com/admin/api/2026-10/graphql.json");
  assert.equal(tokens[0], "tokA");
  svc.update(id, { adminToken: "tokB" });
  await svc.store(id).graphql("{ shop { id } }", {});
  assert.equal(tokens[1], "tokB", "po změně tokenu se klient obnoví");
});

