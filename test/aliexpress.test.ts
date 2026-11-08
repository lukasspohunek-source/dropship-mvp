import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { AliExpressSupplier, splitPhone, toAeAddress } from "../src/aliexpress.js";
import { memRepo, order } from "./helpers.js";

const CFG = { appKey: "123", appSecret: "sec", payCurrency: "USD", orderMemo: "no invoice", authorizeUrl: "https://api-sg.aliexpress.com/oauth/authorize" };
const realFetch = globalThis.fetch;
let calls: string[] = [];
let reply: () => Promise<Response>;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return reply();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (o: unknown) => async () => new Response(JSON.stringify(o), { status: 200 });

function authorized(now = Date.now()) {
  const repo = memRepo();
  repo.setKv("ae_token", JSON.stringify({ access_token: "AT", refresh_token: "RT", expire_time: now + 7 * 86400e3, refresh_token_valid_time: now + 30 * 86400e3 }));
  return { repo, s: new AliExpressSupplier(repo, CFG, () => now) };
}

const LINES = [{ lineItemGid: "li1", title: "Lampa", quantity: 2, aeProductId: "1005001234567890", aeSkuAttr: "14:200003699", logisticsServiceName: "CAINIAO_STANDARD" }];

test("splitPhone rozdělí CZ i jiné formáty", () => {
  assert.deepEqual(splitPhone("+420 777 123 456", "CZ"), { phoneCountry: "+420", mobile: "777123456" });
  assert.deepEqual(splitPhone("00420777123456", "CZ"), { phoneCountry: "+420", mobile: "777123456" });
  assert.deepEqual(splitPhone("777 123 456", "CZ"), { phoneCountry: "+420", mobile: "777123456" });
  assert.deepEqual(splitPhone("+49 151 2345678", "CZ"), { phoneCountry: "", mobile: "491512345678" });
});

test("toAeAddress doplní provincii městem", () => {
  const a = toAeAddress(order().address!);
  assert.equal(a.province, "Brno");
  assert.equal(a.country, "CZ");
  assert.equal(a.mobile_no, "777123456");
});

test("placeOrder úspěch → ok s ID; posílá try_to_pay a podepsaný požadavek", async () => {
  const { s } = authorized();
  reply = json({ aliexpress_trade_buy_placeorder_response: { result: { is_success: true, order_list: { number: [8100000000000001] } } } });
  const r = await s.placeOrder({ address: order().address!, lines: LINES, tryToPay: true });
  assert.deepEqual(r, { kind: "ok", aeOrderIds: ["8100000000000001"] });
  const u = new URL(calls[0]!);
  assert.equal(u.searchParams.get("method"), "aliexpress.ds.order.create");
  assert.equal(u.searchParams.get("session"), "AT");
  assert.ok(u.searchParams.get("sign"));
  assert.equal(JSON.parse(u.searchParams.get("ds_extend_request")!).payment.try_to_pay, "true");
  const dto = JSON.parse(u.searchParams.get("param_place_order_request4_open_api_d_t_o")!);
  assert.equal(dto.product_items[0].product_count, 2);
  assert.equal(dto.logistics_address.phone_country, "+420");
});

test("placeOrder: jiný klíč odpovědi (ds_order_create) se taky přečte", async () => {
  const { s } = authorized();
  reply = json({ aliexpress_ds_order_create_response: { result: { is_success: true, order_list: [8100000000000002] } } });
  const r = await s.placeOrder({ address: order().address!, lines: LINES, tryToPay: false });
  assert.deepEqual(r, { kind: "ok", aeOrderIds: ["8100000000000002"] });
});

test("placeOrder odmítnutí → rejected s kódem", async () => {
  const { s } = authorized();
  reply = json({ aliexpress_trade_buy_placeorder_response: { result: { is_success: false, error_code: "B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL" } } });
  const r = await s.placeOrder({ address: order().address!, lines: LINES, tryToPay: true });
  assert.equal(r.kind, "rejected");
  assert.equal(r.kind === "rejected" && r.code, "B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL");
});

test("placeOrder error_response → rejected; síťová chyba → uncertain", async () => {
  const { s } = authorized();
  reply = json({ error_response: { code: "IllegalAccessToken", msg: "token invalid", request_id: "x" } });
  assert.equal((await s.placeOrder({ address: order().address!, lines: LINES, tryToPay: true })).kind, "rejected");
  reply = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal((await s.placeOrder({ address: order().address!, lines: LINES, tryToPay: true })).kind, "uncertain");
  reply = async () => new Response("bad gateway", { status: 502 });
  assert.equal((await s.placeOrder({ address: order().address!, lines: LINES, tryToPay: true })).kind, "uncertain");
});

test("placeOrder bez tokenu → rejected AUTH a nic se neodešle", async () => {
  const s = new AliExpressSupplier(memRepo(), CFG);
  const r = await s.placeOrder({ address: order().address!, lines: LINES, tryToPay: true });
  assert.equal(r.kind === "rejected" && r.code, "AUTH");
  assert.equal(calls.length, 0);
});

test("getOrder vrátí status, produkty a tracking", async () => {
  const { s } = authorized();
  reply = json({
    aliexpress_trade_ds_order_get_response: {
      result: {
        order_status: "WAIT_BUYER_ACCEPT_GOODS",
        logistics_status: "SELLER_SEND_GOODS",
        child_order_list: { ae_child_order_info: [{ product_id: 1005001234567890 }] },
        logistics_info_list: { ae_order_logistics_info: [{ logistics_no: "LP00123CZ", logistics_service: "CAINIAO_STANDARD" }] },
        order_amount: { amount: "7.43", currency_code: "USD" },
      },
      rsp_code: "200",
    },
  });
  const r = await s.getOrder("8100000000000001");
  assert.deepEqual(r, {
    orderStatus: "WAIT_BUYER_ACCEPT_GOODS",
    logisticsStatus: "SELLER_SEND_GOODS",
    productIds: ["1005001234567890"],
    tracking: [{ number: "LP00123CZ", carrier: "CAINIAO_STANDARD" }],
    orderAmount: { amount: 7.43, currency: "USD" },
  });
});

test("token se obnoví, když brzy vyprší", async () => {
  const now = Date.now();
  const repo = memRepo();
  repo.setKv("ae_token", JSON.stringify({ access_token: "OLD", refresh_token: "RT", expire_time: now + 3600e3, refresh_token_valid_time: now + 30 * 86400e3 }));
  const s = new AliExpressSupplier(repo, CFG, () => now);
  let n = 0;
  reply = async () => {
    n++;
    if (n === 1) return new Response(JSON.stringify({ access_token: "NEW", refresh_token: "RT2", expire_time: now + 7 * 86400e3, refresh_token_valid_time: now + 30 * 86400e3 }));
    return new Response(JSON.stringify({ aliexpress_trade_ds_order_get_response: { result: { order_status: "PLACE_ORDER_SUCCESS", logistics_status: "NO_LOGISTICS" } } }));
  };
  await s.getOrder("1");
  assert.match(calls[0]!, /\/auth\/token\/refresh/);
  assert.equal(new URL(calls[1]!).searchParams.get("session"), "NEW");
  assert.equal(JSON.parse(repo.getKv("ae_token")!).access_token, "NEW");
});

test("OAuth: callback s cizím state se odmítne", async () => {
  const repo = memRepo();
  const s = new AliExpressSupplier(repo, CFG);
  const url = new URL(s.authorizeUrl("https://example.com/ae/oauth/callback"));
  assert.equal(url.searchParams.get("client_id"), "123");
  await assert.rejects(s.handleCallback("code", "spatny"), /state/);
  reply = json({ access_token: "AT", refresh_token: "RT", expire_time: Date.now() + 1e9, refresh_token_valid_time: Date.now() + 2e9 });
  await s.handleCallback("code", url.searchParams.get("state")!);
  assert.equal(s.isAuthorized(), true);
});
