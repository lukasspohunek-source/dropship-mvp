import { Repo } from "../src/db.js";
import type { IncomingOrder, PlaceResult, Store, Supplier, SupplierOrderInfo } from "../src/types.js";

export const memRepo = (now?: () => Date) => new Repo(":memory:", now);

export function order(over: Partial<IncomingOrder> = {}): IncomingOrder {
  return {
    shopifyOrderId: "5001",
    shopifyOrderGid: "gid://shopify/Order/5001",
    name: "#1001",
    currency: "CZK",
    totalPrice: 899,
    email: "zakaznik@example.com",
    address: {
      fullName: "Jan Novák",
      address1: "Hlavní 12",
      address2: null,
      city: "Brno",
      province: null,
      zip: "60200",
      countryCode: "CZ",
      phone: "+420 777 123 456",
    },
    lines: [
      {
        lineItemGid: "gid://shopify/LineItem/1",
        variantId: "111",
        title: "Lampa",
        sku: "L-1",
        quantity: 2,
        requiresShipping: true,
      },
    ],
    ...over,
  };
}

export class FakeSupplier implements Supplier {
  placed: Parameters<Supplier["placeOrder"]>[0][] = [];
  next: PlaceResult = { kind: "ok", aeOrderIds: ["8100000000000001"] };
  orders = new Map<string, SupplierOrderInfo>();
  async placeOrder(args: Parameters<Supplier["placeOrder"]>[0]): Promise<PlaceResult> {
    this.placed.push(args);
    return this.next;
  }
  async getOrder(id: string): Promise<SupplierOrderInfo> {
    const o = this.orders.get(id);
    if (!o) throw new Error(`neznámá AE objednávka ${id}`);
    return o;
  }
}

export class FakeStore implements Store {
  calls: Parameters<Store["fulfill"]>[0][] = [];
  async fulfill(args: Parameters<Store["fulfill"]>[0]) {
    this.calls.push(args);
    return { fulfillmentIds: [`gid://shopify/Fulfillment/${this.calls.length}`], nothingOpen: false };
  }
}

export const MAPPING = {
  shopifyVariantId: "111",
  aeProductId: "1005001234567890",
  aeSkuAttr: "14:200003699",
  logisticsServiceName: "CAINIAO_STANDARD",
  note: null,
};
