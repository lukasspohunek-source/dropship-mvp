import { randomBytes } from "node:crypto";
import { DropshipperClient } from "ae_sdk";
import type { Repo } from "./db.js";
import type { PlaceResult, ShippingAddress, Supplier, SupplierLine, SupplierOrderInfo } from "./types.js";

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

export class AliExpressSupplier implements Supplier {
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
