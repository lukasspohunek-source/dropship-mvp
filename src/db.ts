import { DatabaseSync } from "node:sqlite";
import { SCHEMA, SCHEMA_VERSION } from "./schema.js";
import type { IncomingOrder, Mapping, OrderStatus, SupplierLine } from "./types.js";



export interface OrderRow {
  id: number;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  source_name: string | null;
  shop_id: number;
  customer_id: number | null;
  total_tax: number;
  country_code: string | null;
  shopify_order_id: string;
  shopify_order_gid: string;
  name: string;
  currency: string;
  total_price: number;
  email: string | null;
  address_json: string | null;
  lines_json: string;
  supplier_lines_json: string | null;
  status: OrderStatus;
  try_to_pay: number;
  ae_order_ids_json: string | null;
  last_error: string | null;
  placed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShipmentRow {
  id: number;
  order_id: number;
  ae_order_id: string;
  ae_order_status: string | null;
  logistics_status: string | null;
  tracking_number: string | null;
  carrier: string | null;
  fulfillment_ids_json: string | null;
  fulfilled_at: string | null;
  unpaid_warned: number;
  last_error: string | null;
  updated_at: string;
}

export interface EventRow {
  id: number;
  order_id: number | null;
  level: "info" | "warn" | "error";
  message: string;
  created_at: string;
}

export class Repo {
  readonly db: DatabaseSync;

  constructor(path: string, private now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const v = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    const hasOrders = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'").get();
    if (v === 0 && hasOrders)
      throw new Error("Databáze je ze staré verze 0.1 bez podpory více e-shopů – smaž soubor DB (MVP ještě neběželo v produkci)");
    if (v > SCHEMA_VERSION) throw new Error(`Databáze má novější schéma (${v}) než aplikace (${SCHEMA_VERSION})`);
    this.db.exec("BEGIN");
    try {
      this.db.exec(SCHEMA);
      // v1 → v2: přibyla tabulka trend_runs (vytvoří ji CREATE TABLE IF NOT EXISTS výše).
      // v2 → v3: UTM a zdroj u objednávek (nové tabulky reklam vytvoří SCHEMA).
      if (v > 0 && v < 3)
        for (const c of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "source_name"]) this.ensureColumn("orders", c, "TEXT");
      // v3 → v4: skutečná částka zaplacená AliExpressu (zboží + doprava) u zásilky.
      if (v > 0 && v < 4) for (const [c, t] of [["ae_amount", "REAL"], ["ae_currency", "TEXT"]]) this.ensureColumn("shipments", c!, t!);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_orders_utm_campaign ON orders(utm_campaign)");
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  now_(): string {
    return this.ts();
  }

  private ts(): string {
    return this.now().toISOString();
  }

  close(): void {
    this.db.close();
  }

  // ---------- orders ----------

  /** Vloží objednávku, pokud ještě neexistuje (Shopify webhooky opakuje). */
  insertOrder(o: IncomingOrder, shopId: number): { id: number; created: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM orders WHERE shopify_order_id = ?")
      .get(o.shopifyOrderId) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
    const t = this.ts();
    const r = this.db
      .prepare(
        `INSERT INTO orders (shop_id, shopify_order_id, shopify_order_gid, name, currency, total_price, total_tax,
           country_code, email, address_json, lines_json, utm_source, utm_medium, utm_campaign, utm_content, source_name,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?)`,
      )
      .run(
        shopId,
        o.shopifyOrderId,
        o.shopifyOrderGid,
        o.name,
        o.currency,
        o.totalPrice,
        o.totalTax,
        o.address?.countryCode ?? null,
        o.email,
        o.address ? JSON.stringify(o.address) : null,
        JSON.stringify(o.lines),
        o.attribution?.utmSource ?? null,
        o.attribution?.utmMedium ?? null,
        o.attribution?.utmCampaign ?? null,
        o.attribution?.utmContent ?? null,
        o.attribution?.sourceName ?? null,
        t,
        t,
      );
    return { id: Number(r.lastInsertRowid), created: true };
  }

  getOrder(id: number): OrderRow | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  }

  listOrders(f: { status?: string; shopId?: number; customerId?: number } = {}, limit = 200): OrderRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.shopId) (where.push("shop_id = ?"), args.push(f.shopId));
    if (f.customerId) (where.push("customer_id = ?"), args.push(f.customerId));
    const sql = `SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit) as unknown as OrderRow[];
  }

  setOrderCustomer(orderId: number, customerId: number): void {
    this.db.prepare("UPDATE orders SET customer_id = ? WHERE id = ?").run(customerId, orderId);
  }

  idsByStatus(status: OrderStatus): number[] {
    return (
      this.db.prepare("SELECT id FROM orders WHERE status = ? ORDER BY id").all(status) as {
        id: number;
      }[]
    ).map((r) => r.id);
  }

  setStatus(id: number, status: OrderStatus, lastError: string | null = null): void {
    this.db
      .prepare("UPDATE orders SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(status, lastError, this.ts(), id);
  }

  /** Atomicky přepne stav jen z očekávaného stavu. Vrací false, pokud to mezitím udělal někdo jiný. */
  transition(id: number, from: OrderStatus, to: OrderStatus): boolean {
    const r = this.db
      .prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(to, this.ts(), id, from);
    return Number(r.changes) === 1;
  }

  markPlaced(id: number, aeOrderIds: string[], lines: SupplierLine[], tryToPay: boolean): void {
    const t = this.ts();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE orders SET status = 'PLACED', ae_order_ids_json = ?, supplier_lines_json = ?,
             try_to_pay = ?, placed_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify(aeOrderIds), JSON.stringify(lines), tryToPay ? 1 : 0, t, t, id);
      const ins = this.db.prepare(
        "INSERT OR IGNORE INTO shipments (order_id, ae_order_id, updated_at) VALUES (?, ?, ?)",
      );
      for (const ae of aeOrderIds) ins.run(id, ae, t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  updateAddress(id: number, addressJson: string): void {
    this.db.prepare("UPDATE orders SET address_json = ?, updated_at = ? WHERE id = ?").run(addressJson, this.ts(), id);
  }

  saveSupplierLines(id: number, lines: SupplierLine[]): void {
    this.db
      .prepare("UPDATE orders SET supplier_lines_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(lines), this.ts(), id);
  }

  countAutoPaidSince(sinceIso: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM orders WHERE try_to_pay = 1 AND placed_at >= ?")
      .get(sinceIso) as { n: number };
    return Number(r.n);
  }

  // ---------- shipments ----------

  openShipments(): ShipmentRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM shipments s JOIN orders o ON o.id = s.order_id
         WHERE s.fulfilled_at IS NULL AND o.status = 'PLACED' ORDER BY s.id`,
      )
      .all() as unknown as ShipmentRow[];
  }

  shipmentsForOrder(orderId: number): ShipmentRow[] {
    return this.db
      .prepare("SELECT * FROM shipments WHERE order_id = ? ORDER BY id")
      .all(orderId) as unknown as ShipmentRow[];
  }

  updateShipmentStatus(
    id: number,
    s: {
      aeOrderStatus: string;
      logisticsStatus: string;
      trackingNumber: string | null;
      carrier: string | null;
      aeAmount?: number | null;
      aeCurrency?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE shipments SET ae_order_status = ?, logistics_status = ?, tracking_number = ?, carrier = ?,
           ae_amount = COALESCE(?, ae_amount), ae_currency = COALESCE(?, ae_currency), last_error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(s.aeOrderStatus, s.logisticsStatus, s.trackingNumber, s.carrier, s.aeAmount ?? null, s.aeCurrency ?? null, this.ts(), id);
  }

  setShipmentError(id: number, err: string): void {
    this.db.prepare("UPDATE shipments SET last_error = ?, updated_at = ? WHERE id = ?").run(err, this.ts(), id);
  }

  markShipmentUnpaidWarned(id: number): void {
    this.db.prepare("UPDATE shipments SET unpaid_warned = 1 WHERE id = ?").run(id);
  }

  markShipmentFulfilled(id: number, fulfillmentIds: string[]): void {
    const t = this.ts();
    this.db
      .prepare("UPDATE shipments SET fulfillment_ids_json = ?, fulfilled_at = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(fulfillmentIds), t, t, id);
  }

  // ---------- mappings ----------

  getMapping(variantId: string): Mapping | undefined {
    const r = this.db.prepare("SELECT * FROM mappings WHERE shopify_variant_id = ?").get(variantId) as
      | Record<string, string | number | null>
      | undefined;
    return r ? rowToMapping(r) : undefined;
  }

  listMappings(): Mapping[] {
    return (
      this.db.prepare("SELECT * FROM mappings ORDER BY shopify_variant_id").all() as Record<string, string | number | null>[]
    ).map(rowToMapping);
  }

  upsertMapping(m: Mapping): void {
    this.db
      .prepare(
        `INSERT INTO mappings (shopify_variant_id, shop_id, ae_product_id, ae_sku_attr, logistics_service_name, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shopify_variant_id) DO UPDATE SET ae_product_id = excluded.ae_product_id,
           shop_id = COALESCE(excluded.shop_id, mappings.shop_id),
           ae_sku_attr = excluded.ae_sku_attr, logistics_service_name = excluded.logistics_service_name,
           note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(m.shopifyVariantId, m.shopId ?? null, m.aeProductId, m.aeSkuAttr, m.logisticsServiceName, m.note, this.ts());
  }

  deleteMapping(variantId: string): boolean {
    const r = this.db.prepare("DELETE FROM mappings WHERE shopify_variant_id = ?").run(variantId);
    return Number(r.changes) > 0;
  }

  // ---------- events ----------

  log(orderId: number | null, level: EventRow["level"], message: string): void {
    this.db
      .prepare("INSERT INTO events (order_id, level, message, created_at) VALUES (?, ?, ?, ?)")
      .run(orderId, level, message, this.ts());
    const line = `[${level}]${orderId != null ? ` order#${orderId}` : ""} ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  eventsForOrder(orderId: number): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE order_id = ? ORDER BY id")
      .all(orderId) as unknown as EventRow[];
  }

  // ---------- kv ----------

  getKv(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  deleteKv(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
}

function rowToMapping(r: Record<string, string | number | null>): Mapping {
  return {
    shopifyVariantId: String(r.shopify_variant_id),
    shopId: r.shop_id != null ? Number(r.shop_id) : null,
    aeProductId: String(r.ae_product_id),
    aeSkuAttr: (r.ae_sku_attr as string | null) ?? null,
    logisticsServiceName: (r.logistics_service_name as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    lastCost: r.last_cost == null ? null : Number(r.last_cost),
  };
}
