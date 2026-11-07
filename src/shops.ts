import type { SecretBox } from "./crypto.js";
import type { Repo } from "./db.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { ShopifyStore } from "./shopify.js";

export interface PricingRules {
  /** Kolik jednotek měny e-shopu stojí 1 jednotka měny AliExpressu (např. 23 Kč za 1 USD). */
  fxRate: number;
  /** Násobek nákladů (≥ 1). */
  multiplier: number;
  /** Pevná přirážka v měně e-shopu (balné, poplatky). */
  fixedAdd: number;
  /** Zaokrouhlení nahoru na násobek (např. 10) … */
  roundStep: number;
  /** … mínus offset (např. 1 → 299, 349). */
  roundOffset: number;
  /** Kolik kusů z dostupného skladu dodavatele nezobrazovat. */
  stockBuffer: number;
  /** Max. zobrazený sklad. */
  stockCap: number;
  /** Varovat při změně ceny o víc než X %. */
  priceAlertPct: number;
}

export interface Shop {
  id: number;
  domain: string;
  name: string;
  currency: string;
  country: string;
  apiVersion: string;
  locationGid: string | null;
  autoPayMaxOrderTotal: number;
  pricing: PricingRules;
  active: boolean;
  createdAt: string;
}

export interface ShopInput {
  domain: string;
  name: string;
  currency: string;
  country: string;
  adminToken: string;
  webhookSecret: string;
  apiVersion?: string;
  locationGid?: string | null;
  autoPayMaxOrderTotal?: number;
  pricing?: Partial<PricingRules>;
  active?: boolean;
}

export interface ShopDefaults {
  apiVersion: string;
  autoPayMaxOrderTotal: number;
  pricing: PricingRules;
}

interface ShopRow {
  id: number;
  domain: string;
  name: string;
  currency: string;
  country: string;
  admin_token_enc: string;
  webhook_secret_enc: string;
  api_version: string;
  location_gid: string | null;
  auto_pay_max_order_total: number;
  pricing_json: string;
  active: number;
  created_at: string;
}

export function validatePricing(p: PricingRules): void {
  const nonNeg = ["fixedAdd", "roundStep", "roundOffset", "stockBuffer", "stockCap", "priceAlertPct"] as const;
  for (const k of nonNeg)
    if (typeof p[k] !== "number" || !Number.isFinite(p[k]) || p[k] < 0) throw new ValidationError(`pricing.${k} musí být číslo ≥ 0`);
  if (!(p.fxRate > 0)) throw new ValidationError("pricing.fxRate musí být > 0");
  if (!(p.multiplier >= 1)) throw new ValidationError("pricing.multiplier musí být ≥ 1 (jinak prodáváš pod nákupní cenou)");
  if (p.roundStep > 0 && p.roundOffset >= p.roundStep) throw new ValidationError("pricing.roundOffset musí být menší než roundStep");
}

export class ShopService {
  private stores = new Map<number, ShopifyStore>();

  constructor(
    private repo: Repo,
    private box: SecretBox,
    private defaults: ShopDefaults,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private toShop(r: ShopRow): Shop {
    return {
      id: r.id,
      domain: r.domain,
      name: r.name,
      currency: r.currency,
      country: r.country,
      apiVersion: r.api_version,
      locationGid: r.location_gid,
      autoPayMaxOrderTotal: r.auto_pay_max_order_total,
      pricing: { ...this.defaults.pricing, ...(JSON.parse(r.pricing_json) as Partial<PricingRules>) },
      active: r.active === 1,
      createdAt: r.created_at,
    };
  }

  private row(id: number): ShopRow {
    const r = this.repo.db.prepare("SELECT * FROM shops WHERE id = ?").get(id) as ShopRow | undefined;
    if (!r) throw new NotFoundError(`E-shop ${id} neexistuje`);
    return r;
  }

  list(): Shop[] {
    return (this.repo.db.prepare("SELECT * FROM shops ORDER BY id").all() as unknown as ShopRow[]).map((r) => this.toShop(r));
  }

  get(id: number): Shop {
    return this.toShop(this.row(id));
  }

  /** Pro ověření webhooku: e-shop + dešifrovaný webhook secret. */
  findForWebhook(domain: string): { shop: Shop; webhookSecret: string } | undefined {
    const r = this.repo.db.prepare("SELECT * FROM shops WHERE domain = ?").get(domain) as ShopRow | undefined;
    if (!r) return undefined;
    return { shop: this.toShop(r), webhookSecret: this.box.open(r.webhook_secret_enc) };
  }

  create(input: ShopInput): Shop {
    const v = this.validate(input, true);
    if (this.repo.db.prepare("SELECT 1 FROM shops WHERE domain = ?").get(v.domain))
      throw new ConflictError(`E-shop ${v.domain} už existuje`);
    const t = this.repo.now_();
    const r = this.repo.db
      .prepare(
        `INSERT INTO shops (domain, name, currency, country, admin_token_enc, webhook_secret_enc, api_version, location_gid,
           auto_pay_max_order_total, pricing_json, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.domain,
        v.name,
        v.currency,
        v.country,
        this.box.seal(input.adminToken),
        this.box.seal(input.webhookSecret),
        input.apiVersion ?? this.defaults.apiVersion,
        input.locationGid ?? null,
        input.autoPayMaxOrderTotal ?? this.defaults.autoPayMaxOrderTotal,
        JSON.stringify(input.pricing ?? {}),
        input.active === false ? 0 : 1,
        t,
        t,
      );
    const id = Number(r.lastInsertRowid);
    this.repo.log(null, "info", `Přidán e-shop ${v.domain} (#${id})`);
    return this.get(id);
  }

  update(id: number, patch: Partial<ShopInput>): Shop {
    const cur = this.row(id);
    const merged = { ...this.toShop(cur), ...patch, pricing: { ...JSON.parse(cur.pricing_json), ...(patch.pricing ?? {}) } };
    this.validate(merged as ShopInput, false);
    if (patch.domain && patch.domain !== cur.domain) throw new ValidationError("Doménu e-shopu nelze měnit – přidej nový e-shop");
    this.repo.db
      .prepare(
        `UPDATE shops SET name = ?, currency = ?, country = ?, api_version = ?, location_gid = ?, auto_pay_max_order_total = ?,
           pricing_json = ?, active = ?, admin_token_enc = ?, webhook_secret_enc = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.currency,
        merged.country,
        merged.apiVersion,
        merged.locationGid ?? null,
        merged.autoPayMaxOrderTotal,
        JSON.stringify(merged.pricing),
        merged.active === false ? 0 : 1,
        patch.adminToken ? this.box.seal(patch.adminToken) : cur.admin_token_enc,
        patch.webhookSecret ? this.box.seal(patch.webhookSecret) : cur.webhook_secret_enc,
        this.repo.now_(),
        id,
      );
    this.stores.delete(id);
    this.repo.log(null, "info", `Upraven e-shop ${cur.domain} (${Object.keys(patch).filter((k) => !/token|secret/i.test(k)).join(", ")})`);
    return this.get(id);
  }

  setLocation(id: number, gid: string): void {
    this.repo.db.prepare("UPDATE shops SET location_gid = ?, updated_at = ? WHERE id = ?").run(gid, this.repo.now_(), id);
  }

  store(id: number): ShopifyStore {
    let s = this.stores.get(id);
    if (!s) {
      const r = this.row(id);
      s = new ShopifyStore({ shop: r.domain, adminToken: this.box.open(r.admin_token_enc), apiVersion: r.api_version }, this.fetchImpl);
      this.stores.set(id, s);
    }
    return s;
  }

  private validate(i: ShopInput, isNew: boolean) {
    const domain = String(i.domain ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(domain)) throw new ValidationError('domain musí být ve tvaru "nazev.myshopify.com"');
    const name = String(i.name ?? "").trim();
    if (!name) throw new ValidationError("name je povinné");
    const currency = String(i.currency ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError("currency musí být kód ISO 4217, např. CZK");
    const country = String(i.country ?? "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new ValidationError("country musí být kód ISO 3166, např. CZ");
    if (isNew && (!i.adminToken || !i.webhookSecret)) throw new ValidationError("adminToken a webhookSecret jsou povinné");
    const max = i.autoPayMaxOrderTotal ?? this.defaults.autoPayMaxOrderTotal;
    if (!(typeof max === "number" && max >= 0)) throw new ValidationError("autoPayMaxOrderTotal musí být číslo ≥ 0");
    validatePricing({ ...this.defaults.pricing, ...(i.pricing ?? {}) });
    i.currency = currency;
    i.country = country;
    return { domain, name, currency, country };
  }
}
