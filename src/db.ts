import { DatabaseSync } from "node:sqlite";
import type { IncomingOrder, Mapping, OrderStatus, SupplierLine } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_order_id TEXT NOT NULL UNIQUE,
  shopify_order_gid TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_price REAL NOT NULL,
  email TEXT,
  address_json TEXT,
  lines_json TEXT NOT NULL,
  supplier_lines_json TEXT,
  status TEXT NOT NULL,
  try_to_pay INTEGER NOT NULL DEFAULT 0,
  ae_order_ids_json TEXT,
  last_error TEXT,
  placed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  ae_order_id TEXT NOT NULL UNIQUE,
  ae_order_status TEXT,
  logistics_status TEXT,
  tracking_number TEXT,
  carrier TEXT,
  fulfillment_ids_json TEXT,
  fulfilled_at TEXT,
  unpaid_warned INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mappings (
  shopify_variant_id TEXT PRIMARY KEY,
  ae_product_id TEXT NOT NULL,
  ae_sku_attr TEXT,
  logistics_service_name TEXT,
  note TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface OrderRow {
  id: number;
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
    this.db.exec(SCHEMA);
  }

  private ts(): string {
    return this.now().toISOString();
  }

  close(): void {
    this.db.close();
  }

  // ---------- orders ----------

  /** Vloží objednávku, pokud ještě neexistuje (Shopify webhooky opakuje). */
  insertOrder(o: IncomingOrder): { id: number; created: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM orders WHERE shopify_order_id = ?")
      .get(o.shopifyOrderId) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
    const t = this.ts();
    const r = this.db
      .prepare(
        `INSERT INTO orders (shopify_order_id, shopify_order_gid, name, currency, total_price, email,
           address_json, lines_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?)`,
      )
      .run(
        o.shopifyOrderId,
        o.shopifyOrderGid,
        o.name,
        o.currency,
        o.totalPrice,
        o.email,
        o.address ? JSON.stringify(o.address) : null,
        JSON.stringify(o.lines),
        t,
        t,
      );
    return { id: Number(r.lastInsertRowid), created: true };
  }

  getOrder(id: number): OrderRow | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  }

  listOrders(status?: string, limit = 100): OrderRow[] {
    if (status)
      return this.db
        .prepare("SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT ?")
        .all(status, limit) as unknown as OrderRow[];
    return this.db
      .prepare("SELECT * FROM orders ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as OrderRow[];
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
    s: { aeOrderStatus: string; logisticsStatus: string; trackingNumber: string | null; carrier: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE shipments SET ae_order_status = ?, logistics_status = ?, tracking_number = ?, carrier = ?,
           last_error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(s.aeOrderStatus, s.logisticsStatus, s.trackingNumber, s.carrier, this.ts(), id);
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
      | Record<string, string | null>
      | undefined;
    return r ? rowToMapping(r) : undefined;
  }

  listMappings(): Mapping[] {
    return (
      this.db.prepare("SELECT * FROM mappings ORDER BY shopify_variant_id").all() as Record<string, string | null>[]
    ).map(rowToMapping);
  }

  upsertMapping(m: Mapping): void {
    this.db
      .prepare(
        `INSERT INTO mappings (shopify_variant_id, ae_product_id, ae_sku_attr, logistics_service_name, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(shopify_variant_id) DO UPDATE SET ae_product_id = excluded.ae_product_id,
           ae_sku_attr = excluded.ae_sku_attr, logistics_service_name = excluded.logistics_service_name,
           note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(m.shopifyVariantId, m.aeProductId, m.aeSkuAttr, m.logisticsServiceName, m.note, this.ts());
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

function rowToMapping(r: Record<string, string | null>): Mapping {
  return {
    shopifyVariantId: String(r.shopify_variant_id),
    aeProductId: String(r.ae_product_id),
    aeSkuAttr: r.ae_sku_attr ?? null,
    logisticsServiceName: r.logistics_service_name ?? null,
    note: r.note ?? null,
  };
}
