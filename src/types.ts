// Sdílené typy. Supplier a Store jsou rozhraní, aby šla logika testovat bez sítě.

export type OrderStatus =
  | "RECEIVED" // přišla ze Shopify, čeká na zpracování
  | "IGNORED" // nic k odeslání (např. jen digitální položky)
  | "NEEDS_MAPPING" // některá varianta nemá přiřazený produkt AliExpress
  | "NEEDS_ADDRESS" // chybí povinné údaje adresy / telefon
  | "NEEDS_APPROVAL" // nad limitem automatické platby, čeká na schválení
  | "DRY_RUN" // zkušební režim – objednávka se neodeslala
  | "PLACING" // právě se odesílá do AliExpressu (zámek)
  | "PLACED" // vytvořeno v AliExpressu, čeká na tracking
  | "PLACE_FAILED" // AliExpress objednávku odmítl (bezpečné opakovat po opravě)
  | "PLACE_UNCERTAIN" // nevíme, jestli vznikla – NUTNÁ ruční kontrola v AliExpressu
  | "FULFILLED" // tracking odeslán do Shopify
  | "CANCELLED";

export interface ShippingAddress {
  fullName: string;
  address1: string;
  address2: string | null;
  city: string;
  province: string | null;
  zip: string;
  countryCode: string; // ISO 3166-1 alpha-2, např. "CZ"
  phone: string | null;
}

export interface OrderLine {
  lineItemGid: string; // gid://shopify/LineItem/...
  variantId: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  requiresShipping: boolean;
}

export interface IncomingOrder {
  shopifyOrderId: string;
  shopifyOrderGid: string;
  name: string; // "#1001"
  currency: string;
  totalPrice: number;
  totalTax: number;
  email: string | null;
  address: ShippingAddress | null;
  lines: OrderLine[];
  customer: IncomingCustomer | null;
}

export interface IncomingCustomer {
  email: string | null;
  name: string | null;
  phone: string | null;
  acceptsMarketing: boolean;
  consentAt: string | null;
}

export interface Mapping {
  shopifyVariantId: string;
  shopId?: number | null;
  aeProductId: string;
  aeSkuAttr: string | null; // např. "14:200003699;5:361386"
  logisticsServiceName: string | null; // např. "CAINIAO_STANDARD"
  note: string | null;
}

/** Řádek objednávky po namapování – ukládá se při odeslání, aby šel později spárovat tracking. */
export interface SupplierLine {
  lineItemGid: string;
  title: string;
  quantity: number;
  aeProductId: string;
  aeSkuAttr: string | null;
  logisticsServiceName: string | null;
}

export type PlaceResult =
  | { kind: "ok"; aeOrderIds: string[] }
  /** AliExpress požadavek zpracoval a odmítl – objednávka nevznikla. */
  | { kind: "rejected"; code: string; message: string }
  /** Síťová chyba / neočekávaná odpověď – objednávka MOHLA vzniknout. */
  | { kind: "uncertain"; message: string };

export interface SupplierOrderInfo {
  orderStatus: string;
  logisticsStatus: string;
  productIds: string[];
  tracking: { number: string; carrier: string }[];
}

export interface Supplier {
  placeOrder(args: {
    address: ShippingAddress;
    lines: SupplierLine[];
    tryToPay: boolean;
  }): Promise<PlaceResult>;
  getOrder(aeOrderId: string): Promise<SupplierOrderInfo>;
}

export interface FulfillResult {
  fulfillmentIds: string[];
  /** true = v Shopify už nebylo nic otevřeného (např. vyřízeno ručně). */
  nothingOpen: boolean;
}

export interface Store {
  fulfill(args: {
    orderGid: string;
    lineItems: { lineItemGid: string; quantity: number }[];
    trackingNumber: string;
    carrier: string;
    trackingUrl: string | null;
    notifyCustomer: boolean;
  }): Promise<FulfillResult>;
}
