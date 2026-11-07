import { createHmac, timingSafeEqual } from "node:crypto";
import type { FulfillResult, IncomingOrder, OrderLine, ShippingAddress, Store } from "./types.js";

/** Ověří podpis Shopify webhooku (HMAC-SHA256 z raw těla, base64). */
export function verifyShopifyHmac(rawBody: Buffer, headerHmac: string | undefined, secret: string): boolean {
  if (!headerHmac) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(headerHmac, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** Převede REST payload webhooku orders/paid na interní tvar. */
export function parseOrderWebhook(body: any): IncomingOrder {
  if (!body || body.id == null) throw new Error("Payload neobsahuje id objednávky");
  const sa = body.shipping_address;
  let address: ShippingAddress | null = null;
  if (sa) {
    const fullName = str(sa.name) ?? [str(sa.first_name), str(sa.last_name)].filter(Boolean).join(" ");
    address = {
      fullName,
      address1: str(sa.address1) ?? "",
      address2: str(sa.address2),
      city: str(sa.city) ?? "",
      province: str(sa.province),
      zip: str(sa.zip) ?? "",
      countryCode: (str(sa.country_code) ?? "").toUpperCase(),
      phone: str(sa.phone) ?? str(body.phone) ?? str(body.customer?.phone),
    };
  }
  const lines: OrderLine[] = (body.line_items ?? []).map((li: any) => ({
    lineItemGid: str(li.admin_graphql_api_id) ?? `gid://shopify/LineItem/${li.id}`,
    variantId: li.variant_id != null ? String(li.variant_id) : null,
    title: String(li.title ?? li.name ?? ""),
    sku: str(li.sku),
    quantity: Number(li.quantity ?? 0),
    requiresShipping: li.requires_shipping !== false,
  }));
  return {
    shopifyOrderId: String(body.id),
    shopifyOrderGid: str(body.admin_graphql_api_id) ?? `gid://shopify/Order/${body.id}`,
    name: String(body.name ?? `#${body.order_number ?? body.id}`),
    currency: String(body.currency ?? ""),
    totalPrice: Number(body.total_price ?? 0),
    email: str(body.email) ?? str(body.contact_email),
    address,
    lines,
  };
}

const FULFILLMENT_ORDERS_QUERY = `
query OrderFulfillmentOrders($id: ID!) {
  order(id: $id) {
    fulfillmentOrders(first: 20) {
      nodes {
        id
        status
        lineItems(first: 100) {
          nodes { id remainingQuantity lineItem { id } }
        }
      }
    }
  }
}`;

const FULFILLMENT_CREATE = `
mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status }
    userErrors { field message }
  }
}`;

interface FoNode {
  id: string;
  status: string;
  lineItems: { nodes: { id: string; remainingQuantity: number; lineItem: { id: string } }[] };
}

export class ShopifyStore implements Store {
  constructor(
    private cfg: { shop: string; adminToken: string; apiVersion: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`https://${this.cfg.shop}/admin/api/${this.cfg.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.cfg.adminToken },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text) as { data?: T; errors?: unknown };
    if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 500)}`);
    if (!json.data) throw new Error("Shopify GraphQL: prázdná odpověď");
    return json.data;
  }

  async fulfill(args: Parameters<Store["fulfill"]>[0]): Promise<FulfillResult> {
    const data = await this.graphql<{ order: { fulfillmentOrders: { nodes: FoNode[] } } | null }>(
      FULFILLMENT_ORDERS_QUERY,
      { id: args.orderGid },
    );
    if (!data.order) throw new Error(`Objednávka ${args.orderGid} v Shopify neexistuje`);

    // Kolik kusů z každé položky ještě chceme vyřídit.
    const wanted = new Map<string, number>();
    for (const li of args.lineItems) wanted.set(li.lineItemGid, (wanted.get(li.lineItemGid) ?? 0) + li.quantity);

    // Jedno fulfillmentCreate smí obsahovat jen FO ze stejné lokace → posíláme po jednom FO.
    const plan: { foId: string; items: { id: string; quantity: number }[] }[] = [];
    for (const fo of data.order.fulfillmentOrders.nodes) {
      if (fo.status !== "OPEN" && fo.status !== "IN_PROGRESS") continue;
      const items: { id: string; quantity: number }[] = [];
      for (const n of fo.lineItems.nodes) {
        const need = wanted.get(n.lineItem.id) ?? 0;
        const qty = Math.min(need, n.remainingQuantity);
        if (qty > 0) {
          items.push({ id: n.id, quantity: qty });
          wanted.set(n.lineItem.id, need - qty);
        }
      }
      if (items.length) plan.push({ foId: fo.id, items });
    }
    if (!plan.length) return { fulfillmentIds: [], nothingOpen: true };

    const ids: string[] = [];
    for (const p of plan) {
      const trackingInfo: Record<string, string> = { number: args.trackingNumber, company: args.carrier };
      if (args.trackingUrl) trackingInfo.url = args.trackingUrl;
      const r = await this.graphql<{
        fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: { field: string[]; message: string }[] };
      }>(FULFILLMENT_CREATE, {
        fulfillment: {
          notifyCustomer: args.notifyCustomer,
          trackingInfo,
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: p.foId, fulfillmentOrderLineItems: p.items }],
        },
      });
      const errs = r.fulfillmentCreate.userErrors;
      if (errs.length) throw new Error(`Shopify fulfillmentCreate: ${errs.map((e) => e.message).join("; ")}`);
      if (r.fulfillmentCreate.fulfillment) ids.push(r.fulfillmentCreate.fulfillment.id);
    }
    return { fulfillmentIds: ids, nothingOpen: false };
  }
}
