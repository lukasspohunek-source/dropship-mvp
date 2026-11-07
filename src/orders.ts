import type { OrderRow, Repo } from "./db.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { IncomingOrder, OrderLine, OrderStatus, ShippingAddress, Supplier, SupplierLine } from "./types.js";

export interface OrderConfig {
  dryRun: boolean;
  /** Globální: hlavní vypínač a denní limit přes všechny e-shopy. */
  autoPay: { enabled: boolean; maxPerDay: number };
}

/** Stavy, ze kterých smí běžné zpracování pokračovat. */
const PROCESSABLE: OrderStatus[] = ["RECEIVED", "NEEDS_MAPPING", "NEEDS_ADDRESS", "PLACE_FAILED"];

export function missingAddressFields(a: ShippingAddress | null): string[] {
  if (!a) return ["shipping_address"];
  const miss: string[] = [];
  if (!a.fullName) miss.push("jméno");
  if (!a.address1) miss.push("ulice");
  if (!a.city) miss.push("město");
  if (!a.zip) miss.push("PSČ");
  if (!/^[A-Z]{2}$/.test(a.countryCode)) miss.push("země");
  if (!a.phone || a.phone.replace(/\D/g, "").length < 6) miss.push("telefon");
  return miss;
}

export { ConflictError, NotFoundError, ValidationError } from "./errors.js";

export class OrderService {
  /** Zabraňuje souběžnému zpracování stejné objednávky v rámci procesu. */
  private busy = new Set<number>();

  constructor(
    private repo: Repo,
    private supplier: Supplier,
    private cfg: OrderConfig,
    /** Limit automatické platby jedné objednávky v měně daného e-shopu. */
    private shopMaxTotal: (shopId: number) => number,
    private now: () => Date = () => new Date(),
  ) {}

  ingest(o: IncomingOrder, shopId: number): { id: number; created: boolean } {
    const r = this.repo.insertOrder(o, shopId);
    if (r.created) this.repo.log(r.id, "info", `Přijata objednávka ${o.name} (${o.totalPrice} ${o.currency})`);
    return r;
  }

  async processPending(): Promise<void> {
    for (const id of this.repo.idsByStatus("RECEIVED")) await this.process(id);
  }

  /** Po přidání mapování zkusí znovu objednávky, které na něj čekaly. */
  async reprocessWaitingForMapping(): Promise<void> {
    for (const id of this.repo.idsByStatus("NEEDS_MAPPING")) await this.process(id);
  }

  async approve(id: number): Promise<OrderStatus> {
    const o = this.mustGet(id);
    if (o.status !== "NEEDS_APPROVAL") throw new ConflictError(`Objednávka je ve stavu ${o.status}, ne NEEDS_APPROVAL`);
    this.repo.log(id, "info", "Ručně schváleno k zaplacení");
    return this.process(id, { approved: true });
  }

  async retry(id: number, opts: { confirmNotPlaced?: boolean } = {}): Promise<OrderStatus> {
    const o = this.mustGet(id);
    if (o.status === "PLACE_UNCERTAIN") {
      if (!opts.confirmNotPlaced)
        throw new ConflictError(
          "Stav PLACE_UNCERTAIN: nejdřív v AliExpressu ověř, že objednávka NEVZNIKLA, pak pošli confirmNotPlaced=true. Pokud vznikla, použij mark-placed.",
        );
      this.repo.log(id, "warn", "Potvrzeno, že v AE objednávka nevznikla – zkouším znovu");
      this.repo.setStatus(id, "RECEIVED");
    } else if (o.status === "DRY_RUN") {
      this.repo.setStatus(id, "RECEIVED");
    } else if (!PROCESSABLE.includes(o.status)) {
      throw new ConflictError(`Objednávku ve stavu ${o.status} nelze opakovat`);
    }
    return this.process(id);
  }

  /** Ruční vyřešení PLACE_UNCERTAIN, když objednávka v AE ve skutečnosti vznikla. */
  markPlacedManually(id: number, aeOrderIds: string[]): void {
    const o = this.mustGet(id);
    if (!["PLACE_UNCERTAIN", "PLACE_FAILED", "NEEDS_APPROVAL"].includes(o.status))
      throw new ConflictError(`Objednávku ve stavu ${o.status} nelze ručně označit`);
    if (!aeOrderIds.length || aeOrderIds.some((x) => !/^\d+$/.test(x)))
      throw new ValidationError("aeOrderIds musí být neprázdné pole číselných ID");
    const mapped = this.mapLines(JSON.parse(o.lines_json) as OrderLine[]);
    this.repo.markPlaced(id, aeOrderIds, mapped.lines, false);
    this.repo.log(id, "info", `Ručně označeno jako odesláno do AE: ${aeOrderIds.join(", ")}`);
  }

  /** Oprava adresy (kopie z webhooku se změnou v Shopify neaktualizuje). */
  async updateAddress(id: number, patch: Partial<ShippingAddress>): Promise<OrderStatus> {
    const o = this.mustGet(id);
    if (!["NEEDS_ADDRESS", "PLACE_FAILED", "NEEDS_APPROVAL", "DRY_RUN"].includes(o.status))
      throw new ConflictError(`Adresu objednávky ve stavu ${o.status} nelze měnit`);
    const current = o.address_json ? (JSON.parse(o.address_json) as ShippingAddress) : null;
    const keys: (keyof ShippingAddress)[] = ["fullName", "address1", "address2", "city", "province", "zip", "countryCode", "phone"];
    const next = { ...(current ?? {}) } as Record<string, string | null>;
    for (const k of keys) {
      if (!(k in patch)) continue;
      const v = patch[k];
      if (v != null && typeof v !== "string") throw new ValidationError(`${k} musí být text`);
      next[k] = v == null || v.trim() === "" ? null : k === "countryCode" ? v.trim().toUpperCase() : v.trim();
    }
    const addr: ShippingAddress = {
      fullName: next.fullName ?? "",
      address1: next.address1 ?? "",
      address2: next.address2 ?? null,
      city: next.city ?? "",
      province: next.province ?? null,
      zip: next.zip ?? "",
      countryCode: next.countryCode ?? "",
      phone: next.phone ?? null,
    };
    this.repo.updateAddress(id, JSON.stringify(addr));
    this.repo.log(id, "info", `Adresa upravena ručně (${Object.keys(patch).join(", ")})`);
    // Schvalovaná objednávka zůstává čekat na schválení; ostatní se zkusí znovu.
    if (o.status === "NEEDS_APPROVAL") return o.status;
    return this.retry(id);
  }

  cancel(id: number): void {
    const o = this.mustGet(id);
    if (["PLACING", "PLACED", "FULFILLED"].includes(o.status))
      throw new ConflictError(`Objednávku ve stavu ${o.status} nelze zrušit jen lokálně – zruš ji v AliExpressu`);
    this.repo.setStatus(id, "CANCELLED");
    this.repo.log(id, "info", "Zrušeno (lokálně)");
  }

  async process(id: number, opts: { approved?: boolean } = {}): Promise<OrderStatus> {
    if (this.busy.has(id)) return this.mustGet(id).status;
    this.busy.add(id);
    try {
      return await this.doProcess(id, opts);
    } finally {
      this.busy.delete(id);
    }
  }

  private async doProcess(id: number, opts: { approved?: boolean }): Promise<OrderStatus> {
    const o = this.mustGet(id);
    const allowed = opts.approved ? o.status === "NEEDS_APPROVAL" : PROCESSABLE.includes(o.status);
    if (!allowed) return o.status;

    const lines = (JSON.parse(o.lines_json) as OrderLine[]).filter((l) => l.requiresShipping && l.quantity > 0);
    if (!lines.length) return this.set(o, "IGNORED", "Žádné položky k odeslání");

    const address = o.address_json ? (JSON.parse(o.address_json) as ShippingAddress) : null;
    const missing = missingAddressFields(address);
    if (missing.length) return this.set(o, "NEEDS_ADDRESS", `Chybí v adrese: ${missing.join(", ")}`);

    const mapped = this.mapLines(lines);
    if (mapped.unmapped.length)
      return this.set(o, "NEEDS_MAPPING", `Bez mapování na AliExpress: ${mapped.unmapped.join("; ")}`);

    // Rozhodnutí o platbě.
    let tryToPay = false;
    if (this.cfg.autoPay.enabled) {
      if (opts.approved) {
        tryToPay = true;
      } else {
        const since = new Date(this.now().getTime() - 24 * 3600 * 1000).toISOString();
        const paidToday = this.repo.countAutoPaidSince(since);
        const max = this.shopMaxTotal(o.shop_id);
        if (o.total_price > max)
          return this.set(o, "NEEDS_APPROVAL", `Cena ${o.total_price} ${o.currency} je nad limitem ${max} – čeká na schválení`);
        if (paidToday >= this.cfg.autoPay.maxPerDay)
          return this.set(
            o,
            "NEEDS_APPROVAL",
            `Denní limit ${this.cfg.autoPay.maxPerDay} automatických plateb vyčerpán – čeká na schválení`,
          );
        tryToPay = true;
      }
    }

    if (this.cfg.dryRun) {
      this.repo.saveSupplierLines(id, mapped.lines);
      const summary = mapped.lines.map((l) => `${l.quantity}× ${l.aeProductId}${l.aeSkuAttr ? `[${l.aeSkuAttr}]` : ""}`);
      return this.set(o, "DRY_RUN", `DRY_RUN: odeslalo by se ${summary.join(", ")}; try_to_pay=${tryToPay}`, "info");
    }

    // Zámek – mezi tímto bodem a výsledkem nesmí nic jiného objednávku odeslat.
    if (!this.repo.transition(id, o.status, "PLACING")) return this.mustGet(id).status;
    this.repo.log(id, "info", `Odesílám do AliExpressu (try_to_pay=${tryToPay})`);

    const r = await this.supplier.placeOrder({ address: address!, lines: mapped.lines, tryToPay });
    switch (r.kind) {
      case "ok":
        this.repo.markPlaced(id, r.aeOrderIds, mapped.lines, tryToPay);
        this.repo.log(id, "info", `Vytvořeno v AE: ${r.aeOrderIds.join(", ")}`);
        return "PLACED";
      case "rejected":
        return this.set(this.mustGet(id), "PLACE_FAILED", `AE odmítl: ${r.code} ${r.message}`.trim(), "error");
      case "uncertain":
        return this.set(
          this.mustGet(id),
          "PLACE_UNCERTAIN",
          `Nejisté, zda objednávka vznikla – zkontroluj v AE! ${r.message}`,
          "error",
        );
    }
  }

  private mapLines(lines: OrderLine[]): { lines: SupplierLine[]; unmapped: string[] } {
    const out: SupplierLine[] = [];
    const unmapped: string[] = [];
    for (const l of lines) {
      const m = l.variantId ? this.repo.getMapping(l.variantId) : undefined;
      if (!m) {
        unmapped.push(`${l.title} (variant ${l.variantId ?? "žádná"})`);
        continue;
      }
      out.push({
        lineItemGid: l.lineItemGid,
        title: l.title,
        quantity: l.quantity,
        aeProductId: m.aeProductId,
        aeSkuAttr: m.aeSkuAttr,
        logisticsServiceName: m.logisticsServiceName,
      });
    }
    return { lines: out, unmapped };
  }

  private set(o: OrderRow, status: OrderStatus, msg: string, level: "info" | "warn" | "error" = "warn"): OrderStatus {
    this.repo.setStatus(o.id, status, level === "info" ? null : msg);
    this.repo.log(o.id, level, msg);
    return status;
  }

  private mustGet(id: number): OrderRow {
    const o = this.repo.getOrder(id);
    if (!o) throw new NotFoundError(`Objednávka ${id} neexistuje`);
    return o;
  }
}
