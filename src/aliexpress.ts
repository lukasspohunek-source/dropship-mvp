import { randomBytes } from "node:crypto";
import { DropshipperClient } from "ae_sdk";
import type { Repo } from "./db.js";
import type { AeTrendProduct } from "./trends.js";
import type { AeProduct, AeSku, CatalogSource, PlaceResult, ShippingAddress, Supplier, SupplierLine, SupplierOrderInfo } from "./types.js";

interface StoredToken {
  access_token: string;
  refresh_token: string;
  /** ms epoch */
  expire_time: number;
  /** ms epoch */
  refresh_token_valid_time: number;
}

const TOKEN_KEY = "ae_token";
const STATE_KEY = "ae_oauth_state";
const REFRESH_BEFORE_MS = 24 * 3600 * 1000;

// Mezinárodní předvolby pro rozdělení telefonu (AliExpress chce zvlášť předvolbu a číslo).
const DIAL_CODES: Record<string, string> = {
  CZ: "+420", SK: "+421", DE: "+49", AT: "+43", PL: "+48", HU: "+36", FR: "+33", IT: "+39",
  ES: "+34", NL: "+31", BE: "+32", GB: "+44", IE: "+353", SE: "+46", DK: "+45", FI: "+358",
  PT: "+351", RO: "+40", SI: "+386", HR: "+385", US: "+1", CA: "+1",
};

export function splitPhone(phone: string, countryCode: string): { phoneCountry: string; mobile: string } {
  let digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);
  const dial = DIAL_CODES[countryCode];
  if (dial && digits.startsWith(dial)) return { phoneCountry: dial, mobile: digits.slice(dial.length) };
  if (digits.startsWith("+")) return { phoneCountry: "", mobile: digits.slice(1) };
  return { phoneCountry: dial ?? "", mobile: digits.replace(/^0+/, "") };
}

export function toAeAddress(a: ShippingAddress) {
  const { phoneCountry, mobile } = splitPhone(a.phone ?? "", a.countryCode);
  return {
    full_name: a.fullName,
    contact_person: a.fullName,
    address: a.address1,
    address2: a.address2 ?? undefined,
    city: a.city,
    // AliExpress vyžaduje provincii; u CZ ji Shopify často nemá → použijeme město.
    // OVĚŘ na prvních testovacích objednávkách, co AE pro CZ akceptuje.
    province: a.province ?? a.city,
    zip: a.zip,
    country: a.countryCode,
    phone_country: phoneCountry,
    mobile_no: mobile,
  };
}

/** Najde v odpovědi objekt *_response s polem result (AE mění názvy klíčů mezi verzemi API). */
function findResult(data: any): any {
  if (!data || typeof data !== "object") return undefined;
  for (const [k, v] of Object.entries(data)) {
    if (k.endsWith("_response") && v && typeof v === "object" && "result" in (v as object)) return (v as any).result;
  }
  return undefined;
}

function findTokenObject(data: any): any {
  if (!data || typeof data !== "object") return undefined;
  if ("access_token" in data) return data;
  for (const v of Object.values(data)) if (v && typeof v === "object" && "access_token" in (v as object)) return v;
  return undefined;
}

/** SDK používáme jen kvůli podpisu požadavků; odpovědi parsujeme sami (SDK spadne na jiném klíči odpovědi). */
class AeClient extends DropshipperClient {
  raw(method: string, params: Record<string, unknown>): Promise<any> {
    return this.execute(method as any, params as any) as Promise<any>;
  }
}

/** AE vrací pole různě zabalená: [..], {wrapper: [..]}, nebo jediný objekt. */
export function unwrapList(v: unknown): any[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object") {
    const vals = Object.values(v as object);
    if (vals.length === 1 && Array.isArray(vals[0])) return vals[0];
    if (vals.length === 1 && vals[0] != null && typeof vals[0] !== "object") return [vals[0]];
    return [v];
  }
  return [v];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Převede výsledek aliexpress.ds.product.get na interní tvar. */
export function parseAeProduct(r: any, fallbackCurrency: string): AeProduct {
  const base = r?.ae_item_base_info_dto ?? {};
  const skus: AeSku[] = unwrapList(r?.ae_item_sku_info_dtos).map((s: any) => {
    const props = unwrapList(s.ae_sku_property_dtos ?? s.aeop_s_k_u_propertys);
    const options = props.map((p: any) => ({
      name: String(p.sku_property_name ?? "Varianta").trim(),
      value: String(p.property_value_definition_name ?? p.sku_property_value ?? p.property_value_id ?? "").trim(),
    }));
    const attr =
      s.sku_attr ??
      s.id ??
      props.map((p: any) => `${p.sku_property_id}:${p.property_value_id_long ?? p.property_value_id}`).join(";");
    const price = num(s.offer_sale_price) || num(s.sku_price);
    const stock = num(s.sku_available_stock ?? s.s_k_u_available_stock ?? s.ipm_sku_stock);
    const image = props.find((p: any) => p.sku_image)?.sku_image ?? null;
    return {
      skuAttr: String(attr ?? ""),
      skuId: s.sku_id != null ? String(s.sku_id) : null,
      price,
      stock: s.sku_stock === false ? 0 : stock,
      options,
      image: image ? String(image) : null,
    };
  });
  const status = String(base.product_status_type ?? "onSelling");
  const first = unwrapList(r?.ae_item_sku_info_dtos)[0] as any;
  return {
    productId: String(base.product_id ?? ""),
    title: String(base.subject ?? "").trim(),
    descriptionHtml: String(base.detail ?? base.mobile_detail ?? ""),
    currency: String(first?.currency_code ?? base.currency_code ?? fallbackCurrency),
    available: status === "onSelling" && skus.length > 0,
    images: String(r?.ae_multimedia_info_dto?.image_urls ?? "")
      .split(";")
      .map((u) => u.trim())
      .filter(Boolean),
    skus,
    store: {
      id: r?.ae_store_info?.store_id != null ? String(r.ae_store_info.store_id) : null,
      name: r?.ae_store_info?.store_name ?? null,
    },
  };
}

export class AliExpressSupplier implements Supplier, CatalogSource {
  constructor(
    private repo: Repo,
    private cfg: { appKey: string; appSecret: string; payCurrency: string; orderMemo: string; authorizeUrl: string },
    private now: () => number = () => Date.now(),
  ) {}

  // ---------- OAuth ----------

  authorizeUrl(redirectUri: string): string {
    const state = randomBytes(16).toString("hex");
    this.repo.setKv(STATE_KEY, JSON.stringify({ state, exp: this.now() + 15 * 60 * 1000 }));
    const u = new URL(this.cfg.authorizeUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("force_auth", "true");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("client_id", this.cfg.appKey);
    u.searchParams.set("state", state);
    return u.toString();
  }

  async handleCallback(code: string, state: string): Promise<void> {
    const raw = this.repo.getKv(STATE_KEY);
    const saved = raw ? (JSON.parse(raw) as { state: string; exp: number }) : undefined;
    if (!saved || saved.state !== state || saved.exp < this.now()) throw new Error("Neplatný nebo prošlý OAuth state");
    this.repo.deleteKv(STATE_KEY);
    const res = await this.baseClient("").generateToken({ code });
    this.saveToken(res, "generateToken");
  }

  isAuthorized(): boolean {
    return this.repo.getKv(TOKEN_KEY) != null;
  }

  private baseClient(session: string): AeClient {
    return new AeClient({ app_key: this.cfg.appKey, app_secret: this.cfg.appSecret, session });
  }

  private saveToken(res: any, op: string): void {
    const t = res?.ok ? findTokenObject(res.data) : undefined;
    if (!t?.access_token) {
      const detail = JSON.stringify(res?.error_response ?? res?.data ?? {}).slice(0, 300);
      throw new Error(`AliExpress ${op} selhal: ${res?.message ?? ""} ${detail}`);
    }
    const stored: StoredToken = {
      access_token: String(t.access_token),
      refresh_token: String(t.refresh_token),
      expire_time: Number(t.expire_time),
      refresh_token_valid_time: Number(t.refresh_token_valid_time),
    };
    this.repo.setKv(TOKEN_KEY, JSON.stringify(stored));
    this.repo.log(null, "info", `AliExpress token uložen, platí do ${new Date(stored.expire_time).toISOString()}`);
  }

  private async client(): Promise<AeClient> {
    const raw = this.repo.getKv(TOKEN_KEY);
    if (!raw) throw new Error("AliExpress není autorizovaný – zavolej GET /admin/ae/oauth-url a projdi přihlášení");
    let tok = JSON.parse(raw) as StoredToken;
    if (tok.expire_time - this.now() < REFRESH_BEFORE_MS) {
      if (tok.refresh_token_valid_time < this.now())
        throw new Error("AliExpress refresh token vypršel – projdi znovu OAuth (GET /admin/ae/oauth-url)");
      const res = await this.baseClient("").refreshToken({ refresh_token: tok.refresh_token });
      this.saveToken(res, "refreshToken");
      tok = JSON.parse(this.repo.getKv(TOKEN_KEY)!) as StoredToken;
    }
    return this.baseClient(tok.access_token);
  }

  // ---------- objednávky ----------

  async placeOrder(args: { address: ShippingAddress; lines: SupplierLine[]; tryToPay: boolean }): Promise<PlaceResult> {
    let client: AeClient;
    try {
      client = await this.client();
    } catch (e) {
      // Bez platného tokenu se nic neodeslalo → bezpečné jako "rejected".
      return { kind: "rejected", code: "AUTH", message: (e as Error).message };
    }

    let res: any;
    try {
      res = await client.raw("aliexpress.ds.order.create", {
        ds_extend_request: JSON.stringify({
          payment: { pay_currency: this.cfg.payCurrency, try_to_pay: args.tryToPay ? "true" : "false" },
        }),
        param_place_order_request4_open_api_d_t_o: JSON.stringify({
          logistics_address: toAeAddress(args.address),
          product_items: args.lines.map((l) => ({
            product_id: Number(l.aeProductId),
            product_count: l.quantity,
            sku_attr: l.aeSkuAttr ?? undefined,
            logistics_service_name: l.logisticsServiceName ?? undefined,
            order_memo: this.cfg.orderMemo,
          })),
        }),
      });
    } catch (e) {
      return { kind: "uncertain", message: `Výjimka při volání AE: ${(e as Error).message}` };
    }

    if (!res.ok) {
      // error_response = AE požadavek zpracoval a odmítl (např. špatné parametry).
      if (res.error_response) {
        const er = res.error_response;
        return {
          kind: "rejected",
          code: String(er.code ?? er.sub_code ?? "ERROR"),
          message: String(er.msg ?? er.sub_msg ?? res.message),
        };
      }
      // Síť / HTTP / JSON chyba → nevíme, jestli objednávka vznikla.
      return { kind: "uncertain", message: String(res.message) };
    }

    const result = findResult(res.data);
    if (!result) return { kind: "uncertain", message: `Neočekávaná odpověď AE: ${JSON.stringify(res.data).slice(0, 300)}` };
    if (result.is_success === false || result.is_success === "false") {
      return { kind: "rejected", code: String(result.error_code ?? "UNKNOWN"), message: String(result.error_msg ?? "") };
    }
    const ids = unwrapList(result.order_list).map((x: unknown) => String(x));
    if (!ids.length) return { kind: "uncertain", message: "AE vrátil úspěch bez čísel objednávek" };
    // Pozn.: ID nad 2^53 by JSON.parse zaokrouhlil – AE ID jsou zatím pod touto hranicí.
    return { kind: "ok", aeOrderIds: ids };
  }

  async getProduct(productId: string, shipToCountry: string): Promise<AeProduct> {
    if (!/^\d+$/.test(productId)) throw new Error("ID produktu AliExpress musí být číslo");
    const client = await this.client();
    const res: any = await client.raw("aliexpress.ds.product.get", {
      product_id: productId,
      ship_to_country: shipToCountry,
      target_currency: this.cfg.payCurrency,
      target_language: "en",
    });
    if (!res.ok) {
      const detail = JSON.stringify(res.error_response ?? {}).slice(0, 200);
      throw new Error(`AE product.get ${productId}: ${res.message} ${detail}`);
    }
    const r = findResult(res.data);
    if (!r) throw new Error(`AE product.get ${productId}: neočekávaná odpověď`);
    return parseAeProduct(r, this.cfg.payCurrency);
  }

  /**
   * Bestsellery z doporučených DS feedů (aliexpress.ds.recommend.feed.get).
   * Bez zadaných feedů vezme první dva z aliexpress.ds.feedname.get.
   */
  async getTrendingProducts(country: string, feeds: string[] = []): Promise<AeTrendProduct[]> {
    const client = await this.client();
    let names = feeds;
    if (!names.length) {
      const fr: any = await client.raw("aliexpress.ds.feedname.get", {});
      if (!fr.ok) throw new Error(`AE feedname.get: ${fr.message}`);
      const result = findResult(fr.data);
      names = unwrapList(result?.promos ?? result).map((p: any) => String(p?.promo_name ?? "")).filter(Boolean).slice(0, 2);
      if (!names.length) throw new Error("AE nevrátil žádné feedy – nastav AE_TREND_FEEDS");
    }
    const out: AeTrendProduct[] = [];
    for (const feed of names) {
      const res: any = await client.raw("aliexpress.ds.recommend.feed.get", {
        feed_name: feed,
        country,
        target_currency: this.cfg.payCurrency,
        target_language: "EN",
        page_size: 50,
        sort: "volumeDesc",
      });
      if (!res.ok) throw new Error(`AE recommend.feed.get (${feed}): ${res.message}`);
      const result = findResult(res.data);
      for (const p of unwrapList(result?.products ?? result?.result?.products)) {
        if (!p?.product_id) continue;
        const rating = Number.parseFloat(String(p.evaluate_rate ?? "").replace("%", ""));
        out.push({
          productId: String(p.product_id),
          title: String(p.product_title ?? "").slice(0, 200),
          priceAe: num(p.target_sale_price ?? p.sale_price ?? p.target_app_sale_price),
          currency: String(p.target_sale_price_currency ?? p.sale_price_currency ?? this.cfg.payCurrency),
          orders: p.lastest_volume != null ? num(p.lastest_volume) : null,
          rating: Number.isFinite(rating) ? rating : null,
          url: p.product_detail_url ?? null,
        });
      }
    }
    return [...new Map(out.map((p) => [p.productId, p])).values()].sort((a, b) => (b.orders ?? 0) - (a.orders ?? 0));
  }

  async getOrder(aeOrderId: string): Promise<SupplierOrderInfo> {
    const client = await this.client();
    // ae_sdk posílá order_id, starší dokumentace TOP uvádí single_order_query → posíláme obojí.
    // OVĚŘ na první reálné objednávce a nepotřebné pole odstraň.
    const res: any = await client.raw("aliexpress.trade.ds.order.get", {
      order_id: aeOrderId,
      single_order_query: JSON.stringify({ order_id: aeOrderId }),
    });
    if (!res.ok) {
      const detail = JSON.stringify(res.error_response ?? {}).slice(0, 200);
      throw new Error(`AE order.get ${aeOrderId}: ${res.message} ${detail}`);
    }
    const r = findResult(res.data);
    if (!r) throw new Error(`AE order.get ${aeOrderId}: neočekávaná odpověď`);
    const children = unwrapList(r.child_order_list);
    const logistics = unwrapList(r.logistics_info_list);
    return {
      orderStatus: String(r.order_status ?? ""),
      logisticsStatus: String(r.logistics_status ?? ""),
      productIds: children.map((c) => String(c.product_id)),
      tracking: logistics
        .filter((l) => l?.logistics_no)
        .map((l) => ({ number: String(l.logistics_no), carrier: String(l.logistics_service ?? "AliExpress") })),
    };
  }
}
