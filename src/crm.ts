import { Router } from "express";
import type { Repo } from "./db.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { idParam, oneOf, optDate, optNum, optStr, reqStr } from "./http.js";
import type { IncomingOrder } from "./types.js";

export const LEAD_STAGES = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL", "WON", "LOST"] as const;
export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH"] as const;
export const TICKET_TYPES = ["WITHDRAWAL", "COMPLAINT"] as const;
export const TICKET_STATUSES = ["OPEN", "WAITING_CUSTOMER", "WAITING_SUPPLIER", "RESOLVED", "REJECTED"] as const;
export const TICKET_RESOLUTIONS = ["REFUND", "REPLACEMENT", "REPAIR", "DISCOUNT", "NONE"] as const;
export const ENTITY_TYPES = ["customer", "lead", "order", "ticket"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

/** Zákonné lhůty (CZ, spotřebitel). Ověř s právníkem pro svůj případ. */
export const WITHDRAWAL_DAYS = 14; // odstoupení do 14 dnů od převzetí; vrácení peněz do 14 dnů od odstoupení
export const COMPLAINT_DAYS = 30; // vyřízení reklamace do 30 dnů od uplatnění

const CLOSED_ORDER = ["FULFILLED", "CANCELLED", "IGNORED", "DRY_RUN"];

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Ochrana proti CSV injection v Excelu.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export interface SegmentFilter {
  tagsAny?: string[];
  country?: string;
  shopId?: number;
  minOrders?: number;
  lastOrderWithinDays?: number;
  lastOrderOlderThanDays?: number;
  marketingOnly?: boolean;
}

export function parseSegmentFilter(f: any): SegmentFilter {
  if (f == null || typeof f !== "object") throw new ValidationError("filter musí být objekt");
  const out: SegmentFilter = {};
  if (f.tagsAny != null) {
    if (!Array.isArray(f.tagsAny)) throw new ValidationError("filter.tagsAny musí být pole");
    out.tagsAny = f.tagsAny.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  if (f.country != null) out.country = String(f.country).toUpperCase();
  for (const k of ["shopId", "minOrders", "lastOrderWithinDays", "lastOrderOlderThanDays"] as const) {
    const n = optNum(f[k], `filter.${k}`);
    if (n != null) out[k] = n;
  }
  if (f.marketingOnly != null) out.marketingOnly = Boolean(f.marketingOnly);
  return out;
}

const normTags = (v: unknown): string => {
  const arr = Array.isArray(v) ? v : String(v ?? "").split(",");
  return [...new Set(arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].join(",");
};

export class CrmService {
  constructor(private repo: Repo, private now: () => Date = () => new Date()) {}

  private db() {
    return this.repo.db;
  }
  private ts() {
    return this.now().toISOString();
  }
  private today() {
    return this.ts().slice(0, 10);
  }

  // ---------- zákazníci ----------

  /** Z nové objednávky založí/aktualizuje zákazníka a propojí ho s objednávkou. */
  recordOrder(orderId: number, o: IncomingOrder): number | null {
    const c = o.customer;
    const email = (c?.email ?? o.email)?.trim().toLowerCase() || null;
    if (!email) return null;
    const t = this.ts();
    const existing = this.db().prepare("SELECT * FROM customers WHERE email = ?").get(email) as any;
    let id: number;
    if (existing) {
      if (existing.anonymized_at) return null;
      id = existing.id;
      this.db()
        .prepare(
          `UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone), country = COALESCE(?, country),
             city = COALESCE(?, city), updated_at = ? WHERE id = ?`,
        )
        .run(c?.name ?? null, c?.phone ?? null, o.address?.countryCode ?? null, o.address?.city ?? null, t, id);
    } else {
      const r = this.db()
        .prepare(
          `INSERT INTO customers (email, name, phone, country, city, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'shopify', ?, ?)`,
        )
        .run(email, c?.name ?? o.address?.fullName ?? null, c?.phone ?? o.address?.phone ?? null, o.address?.countryCode ?? null, o.address?.city ?? null, t, t);
      id = Number(r.lastInsertRowid);
    }
    // Souhlas: poslední objednávka rozhoduje. Bez souhlasu raději neposílat (GDPR).
    if (c) {
      if (c.acceptsMarketing)
        this.db()
          .prepare("UPDATE customers SET accepts_marketing = 1, marketing_consent_at = ?, marketing_consent_source = ? WHERE id = ?")
          .run(c.consentAt ?? t, `shopify objednávka ${o.name}`, id);
      else
        this.db()
          .prepare("UPDATE customers SET accepts_marketing = 0, marketing_consent_at = ?, marketing_consent_source = ? WHERE id = ? AND accepts_marketing = 1")
          .run(t, `odvoláno – objednávka ${o.name} bez souhlasu`, id);
    }
    this.repo.setOrderCustomer(orderId, id);
    return id;
  }

  private stats = `
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status NOT IN ('CANCELLED','IGNORED')) AS orders_count,
    (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = c.id) AS last_order_at,
    (SELECT json_group_object(cur, total) FROM (SELECT o.currency AS cur, ROUND(SUM(o.total_price), 2) AS total
       FROM orders o WHERE o.customer_id = c.id AND o.status NOT IN ('CANCELLED','IGNORED') GROUP BY o.currency)) AS spent_json`;

  private present(r: any) {
    if (!r) return r;
    const { spent_json, tags, accepts_marketing, ...rest } = r;
    return {
      ...rest,
      acceptsMarketing: accepts_marketing === 1,
      tags: tags ? String(tags).split(",") : [],
      spent: spent_json ? JSON.parse(spent_json) : {},
    };
  }

  listCustomers(f: { q?: string; tag?: string } = {}) {
    const where = ["c.anonymized_at IS NULL"];
    const args: string[] = [];
    if (f.q) {
      where.push("(c.email LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.company LIKE ?)");
      const q = `%${f.q}%`;
      args.push(q, q, q, q);
    }
    if (f.tag) {
      where.push("(',' || c.tags || ',') LIKE ?");
      args.push(`%,${f.tag.toLowerCase()},%`);
    }
    return this.db()
      .prepare(`SELECT c.*, ${this.stats} FROM customers c WHERE ${where.join(" AND ")} ORDER BY c.id DESC LIMIT 500`)
      .all(...args)
      .map((r) => this.present(r));
  }

  getCustomer(id: number) {
    const c = this.db().prepare(`SELECT c.*, ${this.stats} FROM customers c WHERE c.id = ?`).get(id);
    if (!c) throw new NotFoundError(`Zákazník ${id} neexistuje`);
    return {
      ...this.present(c),
      orders: this.repo.listOrders({ customerId: id }).map((o) => ({
        id: o.id, shopId: o.shop_id, name: o.name, status: o.status, totalPrice: o.total_price, currency: o.currency, createdAt: o.created_at,
      })),
      notes: this.listNotes("customer", id),
      tasks: this.listTasks({ entityType: "customer", entityId: id }),
      tickets: this.listTickets({ customerId: id }),
      leads: this.db().prepare("SELECT * FROM leads WHERE customer_id = ?").all(id),
    };
  }

  createCustomer(b: any) {
    const email = optStr(b?.email, "email", 320)?.toLowerCase() ?? null;
    if (email && !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(email)) throw new ValidationError("Neplatný e-mail");
    if (email && this.db().prepare("SELECT 1 FROM customers WHERE email = ?").get(email)) throw new ConflictError("Zákazník s tímto e-mailem už existuje");
    const t = this.ts();
    const consent = b?.acceptsMarketing === true;
    const r = this.db()
      .prepare(
        `INSERT INTO customers (email, name, phone, company, country, city, accepts_marketing, marketing_consent_at,
           marketing_consent_source, tags, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
      )
      .run(
        email,
        reqStr(b?.name, "name", 200),
        optStr(b?.phone, "phone", 50),
        optStr(b?.company, "company", 200),
        optStr(b?.country, "country", 2)?.toUpperCase() ?? null,
        optStr(b?.city, "city", 100),
        consent ? 1 : 0,
        consent ? t : null,
        consent ? reqStr(b?.consentSource, "consentSource (kde a jak souhlas udělil)", 300) : null,
        normTags(b?.tags),
        t,
        t,
      );
    return this.getCustomer(Number(r.lastInsertRowid));
  }

  updateCustomer(id: number, b: any) {
    const cur = this.getCustomer(id) as any;
    if (cur.anonymized_at) throw new ConflictError("Zákazník je anonymizovaný");
    const t = this.ts();
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [k, col, max] of [["name", "name", 200], ["phone", "phone", 50], ["company", "company", 200], ["city", "city", 100]] as const)
      if (k in (b ?? {})) (sets.push(`${col} = ?`), args.push(optStr(b[k], k, max)));
    if ("country" in (b ?? {})) (sets.push("country = ?"), args.push(optStr(b.country, "country", 2)?.toUpperCase() ?? null));
    if ("tags" in (b ?? {})) (sets.push("tags = ?"), args.push(normTags(b.tags)));
    if ("acceptsMarketing" in (b ?? {})) {
      const yes = b.acceptsMarketing === true;
      sets.push("accepts_marketing = ?", "marketing_consent_at = ?", "marketing_consent_source = ?");
      args.push(yes ? 1 : 0, t, yes ? reqStr(b.consentSource, "consentSource", 300) : optStr(b.consentSource, "consentSource", 300) ?? "odvoláno ručně");
    }
    if (!sets.length) return cur;
    this.db().prepare(`UPDATE customers SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, t, id);
    return this.getCustomer(id);
  }

  /** GDPR čl. 17: anonymizace. Účetní doklady zůstávají v Shopify (zákonná archivace). */
  anonymize(id: number) {
    const c = this.getCustomer(id) as any;
    if (c.anonymized_at) return c;
    const active = this.db()
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status NOT IN (${CLOSED_ORDER.map(() => "?").join(",")})`)
      .get(id, ...CLOSED_ORDER) as { n: number };
    if (Number(active.n) > 0) throw new ConflictError("Zákazník má rozpracované objednávky – anonymizuj až po jejich vyřízení");
    const openTickets = this.db().prepare("SELECT COUNT(*) AS n FROM tickets WHERE customer_id = ? AND closed_at IS NULL").get(id) as { n: number };
    if (Number(openTickets.n) > 0) throw new ConflictError("Zákazník má otevřenou reklamaci/odstoupení");
    const t = this.ts();
    this.db().exec("BEGIN");
    try {
      this.db()
        .prepare(
          `UPDATE customers SET email = NULL, name = 'Anonymizováno', phone = NULL, company = NULL, city = NULL, tags = '',
             accepts_marketing = 0, marketing_consent_at = NULL, marketing_consent_source = NULL, anonymized_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(t, t, id);
      this.db().prepare("UPDATE orders SET email = NULL, address_json = NULL, updated_at = ? WHERE customer_id = ?").run(t, id);
      this.db().prepare("DELETE FROM notes WHERE entity_type = 'customer' AND entity_id = ?").run(id);
      this.db().prepare("UPDATE leads SET name = 'Anonymizováno', email = NULL, phone = NULL, company = NULL WHERE customer_id = ?").run(id);
      this.db().exec("COMMIT");
    } catch (e) {
      this.db().exec("ROLLBACK");
      throw e;
    }
    this.repo.log(null, "info", `Zákazník #${id} anonymizován (GDPR)`);
    return this.getCustomer(id);
  }

  /** GDPR čl. 15: kompletní export údajů o zákazníkovi. */
  exportCustomerData(id: number) {
    const c = this.getCustomer(id) as any;
    const orders = this.repo.listOrders({ customerId: id }).map((o) => ({
      ...o,
      address: o.address_json ? JSON.parse(o.address_json) : null,
      lines: JSON.parse(o.lines_json),
      address_json: undefined,
      lines_json: undefined,
      supplier_lines_json: undefined,
    }));
    return { exportedAt: this.ts(), customer: { ...c, orders: undefined }, orders, notes: c.notes, tasks: c.tasks, tickets: c.tickets, leads: c.leads };
  }

  // ---------- poznámky ----------

  private assertEntity(type: EntityType, id: number) {
    const table = { customer: "customers", lead: "leads", order: "orders", ticket: "tickets" }[type];
    if (!this.db().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw new NotFoundError(`${type} ${id} neexistuje`);
  }

  addNote(type: EntityType, entityId: number, body: string) {
    this.assertEntity(type, entityId);
    const r = this.db()
      .prepare("INSERT INTO notes (entity_type, entity_id, body, created_at) VALUES (?, ?, ?, ?)")
      .run(type, entityId, reqStr(body, "body", 10000), this.ts());
    return this.db().prepare("SELECT * FROM notes WHERE id = ?").get(Number(r.lastInsertRowid));
  }

  listNotes(type: EntityType, entityId: number) {
    return this.db().prepare("SELECT * FROM notes WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC").all(type, entityId);
  }

  deleteNote(id: number) {
    if (Number(this.db().prepare("DELETE FROM notes WHERE id = ?").run(id).changes) === 0) throw new NotFoundError("Poznámka neexistuje");
  }

  // ---------- úkoly ----------

  createTask(b: any) {
    const entityType = b?.entityType != null ? oneOf(b.entityType, ENTITY_TYPES, "entityType") : null;
    const entityId = entityType ? Number(b.entityId) : null;
    if (entityType) this.assertEntity(entityType, entityId!);
    const r = this.db()
      .prepare(
        `INSERT INTO tasks (title, description, due_date, priority, status, entity_type, entity_id, assignee, created_at)
         VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      )
      .run(
        reqStr(b?.title, "title", 300),
        optStr(b?.description, "description"),
        optDate(b?.dueDate, "dueDate"),
        b?.priority != null ? oneOf(b.priority, TASK_PRIORITIES, "priority") : "NORMAL",
        entityType,
        entityId,
        optStr(b?.assignee, "assignee", 100),
        this.ts(),
      );
    return this.getTask(Number(r.lastInsertRowid));
  }

  getTask(id: number) {
    const t = this.db().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!t) throw new NotFoundError(`Úkol ${id} neexistuje`);
    return t;
  }

  updateTask(id: number, b: any) {
    this.getTask(id);
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if ("title" in b) (sets.push("title = ?"), args.push(reqStr(b.title, "title", 300)));
    if ("description" in b) (sets.push("description = ?"), args.push(optStr(b.description, "description")));
    if ("dueDate" in b) (sets.push("due_date = ?"), args.push(optDate(b.dueDate, "dueDate")));
    if ("priority" in b) (sets.push("priority = ?"), args.push(oneOf(b.priority, TASK_PRIORITIES, "priority")));
    if ("assignee" in b) (sets.push("assignee = ?"), args.push(optStr(b.assignee, "assignee", 100)));
    if ("status" in b) {
      const st = oneOf(b.status, ["OPEN", "DONE"] as const, "status");
      sets.push("status = ?", "done_at = ?");
      args.push(st, st === "DONE" ? this.ts() : null);
    }
    if (sets.length) this.db().prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    return this.getTask(id);
  }

  deleteTask(id: number) {
    if (Number(this.db().prepare("DELETE FROM tasks WHERE id = ?").run(id).changes) === 0) throw new NotFoundError("Úkol neexistuje");
  }

  listTasks(f: { status?: string; due?: "overdue" | "today" | "week"; entityType?: string; entityId?: number } = {}) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.entityType) (where.push("entity_type = ? AND entity_id = ?"), args.push(f.entityType, f.entityId ?? 0));
    const today = this.today();
    if (f.due === "overdue") (where.push("status = 'OPEN' AND due_date < ?"), args.push(today));
    if (f.due === "today") (where.push("status = 'OPEN' AND due_date = ?"), args.push(today));
    if (f.due === "week") (where.push("status = 'OPEN' AND due_date BETWEEN ? AND ?"), args.push(today, addDays(today, 7)));
    return this.db()
      .prepare(
        `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY status, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, CASE priority WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END, id`,
      )
      .all(...args);
  }

  // ---------- leady ----------

  createLead(b: any) {
    const t = this.ts();
    const r = this.db()
      .prepare(
        `INSERT INTO leads (name, company, email, phone, source, stage, value, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reqStr(b?.name, "name", 200),
        optStr(b?.company, "company", 200),
        optStr(b?.email, "email", 320)?.toLowerCase() ?? null,
        optStr(b?.phone, "phone", 50),
        optStr(b?.source, "source", 100),
        b?.stage != null ? oneOf(b.stage, LEAD_STAGES, "stage") : "NEW",
        optNum(b?.value, "value"),
        optStr(b?.currency, "currency", 3)?.toUpperCase() ?? null,
        t,
        t,
      );
    return this.getLead(Number(r.lastInsertRowid));
  }

  getLead(id: number) {
    const l = this.db().prepare("SELECT * FROM leads WHERE id = ?").get(id);
    if (!l) throw new NotFoundError(`Lead ${id} neexistuje`);
    return { ...(l as object), notes: this.listNotes("lead", id), tasks: this.listTasks({ entityType: "lead", entityId: id }) };
  }

  updateLead(id: number, b: any) {
    this.getLead(id);
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [k, max] of [["name", 200], ["company", 200], ["phone", 50], ["source", 100]] as const)
      if (k in b) (sets.push(`${k} = ?`), args.push(k === "name" ? reqStr(b[k], k, max) : optStr(b[k], k, max)));
    if ("email" in b) (sets.push("email = ?"), args.push(optStr(b.email, "email", 320)?.toLowerCase() ?? null));
    if ("value" in b) (sets.push("value = ?"), args.push(optNum(b.value, "value")));
    if ("currency" in b) (sets.push("currency = ?"), args.push(optStr(b.currency, "currency", 3)?.toUpperCase() ?? null));
    if ("stage" in b) {
      const st = oneOf(b.stage, LEAD_STAGES, "stage");
      if (st === "LOST" && !optStr(b.lostReason, "lostReason")) throw new ValidationError("U prohraného leadu vyplň lostReason");
      sets.push("stage = ?", "lost_reason = ?");
      args.push(st, st === "LOST" ? optStr(b.lostReason, "lostReason") : null);
    }
    if (sets.length) this.db().prepare(`UPDATE leads SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, this.ts(), id);
    return this.getLead(id);
  }

  listLeads(stage?: string) {
    return stage
      ? this.db().prepare("SELECT * FROM leads WHERE stage = ? ORDER BY updated_at DESC").all(stage)
      : this.db().prepare("SELECT * FROM leads ORDER BY updated_at DESC").all();
  }

  /** Lead → zákazník (podle e-mailu propojí existujícího). */
  convertLead(id: number) {
    const l = this.getLead(id) as any;
    if (l.customer_id) return this.getCustomer(l.customer_id);
    let customerId: number;
    const existing = l.email ? (this.db().prepare("SELECT id FROM customers WHERE email = ?").get(l.email) as { id: number } | undefined) : undefined;
    if (existing) customerId = existing.id;
    else {
      const t = this.ts();
      const r = this.db()
        .prepare("INSERT INTO customers (email, name, phone, company, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'lead', ?, ?)")
        .run(l.email, l.name, l.phone, l.company, t, t);
      customerId = Number(r.lastInsertRowid);
    }
    this.db().prepare("UPDATE leads SET customer_id = ?, stage = 'WON', updated_at = ? WHERE id = ?").run(customerId, this.ts(), id);
    return this.getCustomer(customerId);
  }

  // ---------- reklamace a odstoupení ----------

  createTicket(b: any) {
    const type = oneOf(b?.type, TICKET_TYPES, "type");
    const orderId = b?.orderId != null ? Number(b.orderId) : null;
    let customerId = b?.customerId != null ? Number(b.customerId) : null;
    if (orderId) {
      const o = this.repo.getOrder(orderId);
      if (!o) throw new NotFoundError(`Objednávka ${orderId} neexistuje`);
      customerId ??= o.customer_id;
    }
    if (customerId) this.assertEntity("customer", customerId);
    if (!orderId && !customerId) throw new ValidationError("Zadej orderId nebo customerId");
    const filed = optDate(b?.filedAt, "filedAt") ?? this.today();
    const delivered = optDate(b?.deliveredAt, "deliveredAt");
    const deadline = addDays(filed, type === "WITHDRAWAL" ? WITHDRAWAL_DAYS : COMPLAINT_DAYS);
    const late = type === "WITHDRAWAL" && delivered != null && filed > addDays(delivered, WITHDRAWAL_DAYS) ? 1 : 0;
    const t = this.ts();
    const r = this.db()
      .prepare(
        `INSERT INTO tickets (type, order_id, customer_id, status, reason, delivered_at, filed_at, deadline, late_filing, created_at, updated_at)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(type, orderId, customerId, reqStr(b?.reason, "reason", 5000), delivered, filed, deadline, late, t, t);
    const id = Number(r.lastInsertRowid);
    if (orderId)
      this.repo.log(orderId, late ? "warn" : "info", `${type === "WITHDRAWAL" ? "Odstoupení" : "Reklamace"} #${id}, lhůta do ${deadline}${late ? " – POZOR: podáno po 14 dnech od doručení" : ""}`);
    return this.getTicket(id);
  }

  getTicket(id: number) {
    const tk = this.db().prepare("SELECT * FROM tickets WHERE id = ?").get(id) as any;
    if (!tk) throw new NotFoundError(`Reklamace ${id} neexistuje`);
    return { ...tk, overdue: !tk.closed_at && tk.deadline < this.today(), notes: this.listNotes("ticket", id) };
  }

  updateTicket(id: number, b: any) {
    const cur = this.getTicket(id);
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if ("resolution" in b) (sets.push("resolution = ?"), args.push(b.resolution == null ? null : oneOf(b.resolution, TICKET_RESOLUTIONS, "resolution")));
    if ("refundAmount" in b) (sets.push("refund_amount = ?"), args.push(optNum(b.refundAmount, "refundAmount")));
    if ("aeDisputeId" in b) (sets.push("ae_dispute_id = ?"), args.push(optStr(b.aeDisputeId, "aeDisputeId", 100)));
    if ("deliveredAt" in b) {
      const d = optDate(b.deliveredAt, "deliveredAt");
      sets.push("delivered_at = ?", "late_filing = ?");
      args.push(d, cur.type === "WITHDRAWAL" && d != null && cur.filed_at > addDays(d, WITHDRAWAL_DAYS) ? 1 : 0);
    }
    if ("status" in b) {
      const st = oneOf(b.status, TICKET_STATUSES, "status");
      const closing = st === "RESOLVED" || st === "REJECTED";
      if (st === "RESOLVED" && !(b.resolution ?? cur.resolution)) throw new ValidationError("Při vyřízení vyplň resolution");
      if (st === "REJECTED" && !optStr(b.note, "note")) throw new ValidationError("Zamítnutí musí mít odůvodnění v poli note");
      sets.push("status = ?", "closed_at = ?");
      args.push(st, closing ? this.ts() : null);
    }
    if (sets.length) this.db().prepare(`UPDATE tickets SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, this.ts(), id);
    if (optStr(b.note, "note")) this.addNote("ticket", id, b.note);
    return this.getTicket(id);
  }

  listTickets(f: { status?: string; open?: boolean; overdue?: boolean; customerId?: number } = {}) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.open) where.push("closed_at IS NULL");
    if (f.overdue) (where.push("closed_at IS NULL AND deadline < ?"), args.push(this.today()));
    if (f.customerId) (where.push("customer_id = ?"), args.push(f.customerId));
    const today = this.today();
    return (
      this.db()
        .prepare(`SELECT * FROM tickets ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY closed_at IS NOT NULL, deadline, id`)
        .all(...args) as any[]
    ).map((t) => ({ ...t, overdue: !t.closed_at && t.deadline < today }));
  }

  // ---------- segmenty ----------

  createSegment(b: any) {
    const filter = parseSegmentFilter(b?.filter ?? {});
    const r = this.db()
      .prepare("INSERT INTO segments (name, filter_json, created_at) VALUES (?, ?, ?)")
      .run(reqStr(b?.name, "name", 200), JSON.stringify(filter), this.ts());
    return this.getSegment(Number(r.lastInsertRowid));
  }

  getSegment(id: number) {
    const s = this.db().prepare("SELECT * FROM segments WHERE id = ?").get(id) as any;
    if (!s) throw new NotFoundError(`Segment ${id} neexistuje`);
    const filter = JSON.parse(s.filter_json) as SegmentFilter;
    return { id: s.id, name: s.name, filter, createdAt: s.created_at, size: this.segmentMembers(filter).length };
  }

  listSegments() {
    return (this.db().prepare("SELECT id FROM segments ORDER BY id").all() as { id: number }[]).map((r) => this.getSegment(r.id));
  }

  deleteSegment(id: number) {
    if (Number(this.db().prepare("DELETE FROM segments WHERE id = ?").run(id).changes) === 0) throw new NotFoundError("Segment neexistuje");
  }

  segmentMembers(f: SegmentFilter) {
    const where = ["c.anonymized_at IS NULL", "c.email IS NOT NULL"];
    const args: (string | number)[] = [];
    if (f.marketingOnly !== false) where.push("c.accepts_marketing = 1");
    if (f.country) (where.push("c.country = ?"), args.push(f.country));
    if (f.tagsAny?.length) {
      where.push(`(${f.tagsAny.map(() => "(',' || c.tags || ',') LIKE ?").join(" OR ")})`);
      args.push(...f.tagsAny.map((t) => `%,${t},%`));
    }
    if (f.shopId) (where.push("EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.shop_id = ?)"), args.push(f.shopId));
    const rows = this.db()
      .prepare(`SELECT c.*, ${this.stats} FROM customers c WHERE ${where.join(" AND ")} ORDER BY c.id`)
      .all(...args) as any[];
    const now = this.now().getTime();
    const ageDays = (iso: string | null) => (iso ? (now - Date.parse(iso)) / 86400_000 : Infinity);
    return rows
      .filter((r) => f.minOrders == null || Number(r.orders_count) >= f.minOrders)
      .filter((r) => f.lastOrderWithinDays == null || ageDays(r.last_order_at) <= f.lastOrderWithinDays)
      .filter((r) => f.lastOrderOlderThanDays == null || (r.last_order_at && ageDays(r.last_order_at) > f.lastOrderOlderThanDays))
      .map((r) => this.present(r));
  }

  /** CSV pro e-mailový nástroj – VŽDY jen zákazníci se souhlasem s marketingem. */
  segmentCsv(id: number): string {
    const seg = this.getSegment(id);
    const members = this.segmentMembers({ ...seg.filter, marketingOnly: true });
    const head = ["email", "name", "country", "orders", "last_order_at", "tags", "consent_at", "consent_source"];
    const lines = members.map((m: any) =>
      [m.email, m.name, m.country, m.orders_count, m.last_order_at, m.tags.join(" "), m.marketing_consent_at, m.marketing_consent_source].map(csvCell).join(","),
    );
    this.repo.log(null, "info", `Export segmentu „${seg.name}“: ${members.length} kontaktů`);
    return [head.join(","), ...lines].join("\n") + "\n";
  }

  // ---------- přehled ----------

  dashboard() {
    const today = this.today();
    const since30 = new Date(this.now().getTime() - 30 * 86400_000).toISOString();
    const q = <T>(sql: string, ...a: (string | number)[]) => this.db().prepare(sql).all(...a).map((r) => ({ ...r })) as T[];
    const one = (sql: string, ...a: (string | number)[]) => Number((this.db().prepare(sql).get(...a) as { n: number }).n);
    return {
      ordersByStatus: Object.fromEntries(q<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").map((r) => [r.status, r.n])),
      needsAttention: one("SELECT COUNT(*) AS n FROM orders WHERE status IN ('NEEDS_MAPPING','NEEDS_ADDRESS','NEEDS_APPROVAL','PLACE_FAILED','PLACE_UNCERTAIN')"),
      revenue30d: q<{ shop_id: number; currency: string; total: number; orders: number }>(
        `SELECT shop_id, currency, ROUND(SUM(total_price), 2) AS total, COUNT(*) AS orders FROM orders
         WHERE created_at >= ? AND status NOT IN ('CANCELLED','IGNORED') GROUP BY shop_id, currency`,
        since30,
      ),
      newCustomers30d: one("SELECT COUNT(*) AS n FROM customers WHERE created_at >= ?", since30),
      tickets: {
        open: one("SELECT COUNT(*) AS n FROM tickets WHERE closed_at IS NULL"),
        overdue: one("SELECT COUNT(*) AS n FROM tickets WHERE closed_at IS NULL AND deadline < ?", today),
        dueIn3Days: one("SELECT COUNT(*) AS n FROM tickets WHERE closed_at IS NULL AND deadline BETWEEN ? AND ?", today, addDays(today, 3)),
      },
      tasks: {
        overdue: one("SELECT COUNT(*) AS n FROM tasks WHERE status = 'OPEN' AND due_date < ?", today),
        today: one("SELECT COUNT(*) AS n FROM tasks WHERE status = 'OPEN' AND due_date = ?", today),
      },
      pipeline: q<{ stage: string; n: number; value: number }>(
        "SELECT stage, COUNT(*) AS n, ROUND(COALESCE(SUM(value), 0), 2) AS value FROM leads GROUP BY stage",
      ),
    };
  }
}

// ---------- HTTP ----------

export function crmRouter(crm: CrmService): Router {
  const r = Router();
  const qs = (v: unknown) => (typeof v === "string" && v ? v : undefined);

  r.get("/crm/dashboard", (_q, res) => void res.json(crm.dashboard()));

  r.get("/crm/customers", (q, res) => void res.json(crm.listCustomers({ q: qs(q.query.q), tag: qs(q.query.tag) })));
  r.post("/crm/customers", (q, res) => void res.status(201).json(crm.createCustomer(q.body)));
  r.get("/crm/customers/:id", (q, res) => void res.json(crm.getCustomer(idParam(q))));
  r.patch("/crm/customers/:id", (q, res) => void res.json(crm.updateCustomer(idParam(q), q.body ?? {})));
  r.post("/crm/customers/:id/anonymize", (q, res) => void res.json(crm.anonymize(idParam(q))));
  r.get("/crm/customers/:id/export", (q, res) => {
    const id = idParam(q);
    res.setHeader("Content-Disposition", `attachment; filename="zakaznik-${id}.json"`);
    res.json(crm.exportCustomerData(id));
  });

  r.post("/crm/notes", (q, res) =>
    void res.status(201).json(crm.addNote(oneOf(q.body?.entityType, ENTITY_TYPES, "entityType"), Number(q.body?.entityId), q.body?.body)),
  );
  r.delete("/crm/notes/:id", (q, res) => {
    crm.deleteNote(idParam(q));
    res.status(204).end();
  });

  r.get("/crm/tasks", (q, res) =>
    void res.json(
      crm.listTasks({
        status: qs(q.query.status),
        due: q.query.due ? oneOf(q.query.due, ["overdue", "today", "week"] as const, "due") : undefined,
      }),
    ),
  );
  r.post("/crm/tasks", (q, res) => void res.status(201).json(crm.createTask(q.body)));
  r.patch("/crm/tasks/:id", (q, res) => void res.json(crm.updateTask(idParam(q), q.body ?? {})));
  r.delete("/crm/tasks/:id", (q, res) => {
    crm.deleteTask(idParam(q));
    res.status(204).end();
  });

  r.get("/crm/leads", (q, res) => void res.json(crm.listLeads(qs(q.query.stage))));
  r.post("/crm/leads", (q, res) => void res.status(201).json(crm.createLead(q.body)));
  r.get("/crm/leads/:id", (q, res) => void res.json(crm.getLead(idParam(q))));
  r.patch("/crm/leads/:id", (q, res) => void res.json(crm.updateLead(idParam(q), q.body ?? {})));
  r.post("/crm/leads/:id/convert", (q, res) => void res.json(crm.convertLead(idParam(q))));

  r.get("/crm/tickets", (q, res) =>
    void res.json(crm.listTickets({ status: qs(q.query.status), open: q.query.open === "1", overdue: q.query.overdue === "1" })),
  );
  r.post("/crm/tickets", (q, res) => void res.status(201).json(crm.createTicket(q.body)));
  r.get("/crm/tickets/:id", (q, res) => void res.json(crm.getTicket(idParam(q))));
  r.patch("/crm/tickets/:id", (q, res) => void res.json(crm.updateTicket(idParam(q), q.body ?? {})));

  r.get("/crm/segments", (_q, res) => void res.json(crm.listSegments()));
  r.post("/crm/segments", (q, res) => void res.status(201).json(crm.createSegment(q.body)));
  r.get("/crm/segments/:id", (q, res) => void res.json(crm.getSegment(idParam(q))));
  r.get("/crm/segments/:id/members", (q, res) => {
    const s = crm.getSegment(idParam(q));
    res.json(crm.segmentMembers(s.filter));
  });
  r.get("/crm/segments/:id/export.csv", (q, res) => {
    const id = idParam(q);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="segment-${id}.csv"`);
    res.send("﻿" + crm.segmentCsv(id));
  });
  r.delete("/crm/segments/:id", (q, res) => {
    crm.deleteSegment(idParam(q));
    res.status(204).end();
  });
  return r;
}
