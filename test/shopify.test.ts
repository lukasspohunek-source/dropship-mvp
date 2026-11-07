import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { ShopifyStore, parseOrderWebhook, verifyShopifyHmac } from "../src/shopify.js";

const SECRET = "shpss_test_secret";
const sign = (b: Buffer) => createHmac("sha256", SECRET).update(b).digest("base64");

test("HMAC: platný podpis projde, změněné tělo ne", () => {
  const body = Buffer.from('{"id":1}');
  assert.equal(verifyShopifyHmac(body, sign(body), SECRET), true);
  assert.equal(verifyShopifyHmac(Buffer.from('{"id":2}'), sign(body), SECRET), false);
  assert.equal(verifyShopifyHmac(body, undefined, SECRET), false);
  assert.equal(verifyShopifyHmac(body, "abc", SECRET), false);
});

test("parseOrderWebhook převede REST payload", () => {
  const o = parseOrderWebhook({
    id: 820982911946154500,
    admin_graphql_api_id: "gid://shopify/Order/820982911946154508",
    name: "#9999",
    currency: "CZK",
    total_price: "1249.00",
    email: "a@b.cz",
    phone: null,
    shipping_address: {
      first_name: "Eva",
      last_name: "Malá",
      name: "Eva Malá",
      address1: "Polní 5",
      address2: "",
      city: "Radošovice",
      province: null,
      zip: "37001",
      country_code: "cz",
      phone: "777111222",
    },
    line_items: [
      { id: 1, admin_graphql_api_id: "gid://shopify/LineItem/1", variant_id: 42, title: "Stojan", quantity: 1, sku: "", requires_shipping: true },
      { id: 2, variant_id: null, title: "Dárkový poukaz", quantity: 1, requires_shipping: false },
    ],
  });
  assert.equal(o.totalPrice, 1249);
  assert.equal(o.address?.countryCode, "CZ");
  assert.equal(o.address?.address2, null);
  assert.equal(o.address?.fullName, "Eva Malá");
  assert.equal(o.lines[0]?.variantId, "42");
  assert.equal(o.lines[0]?.sku, null);
  assert.equal(o.lines[1]?.lineItemGid, "gid://shopify/LineItem/2");
  assert.equal(o.lines[1]?.requiresShipping, false);
});

test("ShopifyStore.fulfill: vyřídí jen požadované položky, po jednom FO, a umí 'nic otevřeného'", async () => {
  const bodies: any[] = [];
  let foStatus = "OPEN";
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const data = body.query.includes("fulfillmentOrders")
      ? {
          order: {
            fulfillmentOrders: {
              nodes: [
                {
                  id: "gid://shopify/FulfillmentOrder/1",
                  status: foStatus,
                  lineItems: {
                    nodes: [
                      { id: "gid://shopify/FulfillmentOrderLineItem/10", remainingQuantity: 2, lineItem: { id: "gid://shopify/LineItem/1" } },
                      { id: "gid://shopify/FulfillmentOrderLineItem/11", remainingQuantity: 1, lineItem: { id: "gid://shopify/LineItem/2" } },
                    ],
                  },
                },
                { id: "gid://shopify/FulfillmentOrder/2", status: "CLOSED", lineItems: { nodes: [] } },
              ],
            },
          },
        }
      : { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/77", status: "SUCCESS" }, userErrors: [] } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;

  const s = new ShopifyStore({ shop: "x.myshopify.com", adminToken: "t", apiVersion: "2026-10" }, fakeFetch);
  const r = await s.fulfill({
    orderGid: "gid://shopify/Order/1",
    lineItems: [{ lineItemGid: "gid://shopify/LineItem/1", quantity: 2 }],
    trackingNumber: "LP00123",
    carrier: "CAINIAO_STANDARD",
    trackingUrl: "https://t.17track.net/en#nums=LP00123",
    notifyCustomer: true,
  });
  assert.deepEqual(r, { fulfillmentIds: ["gid://shopify/Fulfillment/77"], nothingOpen: false });
  const mut = bodies[1].variables.fulfillment;
  assert.deepEqual(mut.lineItemsByFulfillmentOrder, [
    { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/1", fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/10", quantity: 2 }] },
  ]);
  assert.equal(mut.trackingInfo.number, "LP00123");

  foStatus = "CLOSED";
  const r2 = await s.fulfill({ orderGid: "gid://shopify/Order/1", lineItems: [{ lineItemGid: "gid://shopify/LineItem/1", quantity: 2 }], trackingNumber: "X", carrier: "Y", trackingUrl: null, notifyCustomer: false });
  assert.deepEqual(r2, { fulfillmentIds: [], nothingOpen: true });
});

test("ShopifyStore: userErrors vyhodí chybu", async () => {
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    const q = JSON.parse(String(init.body)).query as string;
    const data = q.includes("fulfillmentOrders")
      ? { order: { fulfillmentOrders: { nodes: [{ id: "fo", status: "OPEN", lineItems: { nodes: [{ id: "foli", remainingQuantity: 1, lineItem: { id: "li" } }] } }] } } }
      : { fulfillmentCreate: { fulfillment: null, userErrors: [{ field: ["x"], message: "Access denied" }] } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  const s = new ShopifyStore({ shop: "x.myshopify.com", adminToken: "t", apiVersion: "2026-10" }, fakeFetch);
  await assert.rejects(
    s.fulfill({ orderGid: "o", lineItems: [{ lineItemGid: "li", quantity: 1 }], trackingNumber: "1", carrier: "c", trackingUrl: null, notifyCustomer: false }),
    /Access denied/,
  );
});
