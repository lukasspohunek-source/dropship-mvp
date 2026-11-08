/** Verze schématu; zvyš při změně a doplň migraci v db.ts. */
export const SCHEMA_VERSION = 3;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  country TEXT NOT NULL,
  admin_token_enc TEXT NOT NULL,
  webhook_secret_enc TEXT NOT NULL,
  api_version TEXT NOT NULL,
  location_gid TEXT,
  auto_pay_max_order_total REAL NOT NULL,
  pricing_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  name TEXT,
  phone TEXT,
  company TEXT,
  country TEXT,
  city TEXT,
  accepts_marketing INTEGER NOT NULL DEFAULT 0,
  marketing_consent_at TEXT,
  marketing_consent_source TEXT,
  tags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'shopify',
  anonymized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  customer_id INTEGER REFERENCES customers(id),
  shopify_order_id TEXT NOT NULL UNIQUE,
  shopify_order_gid TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_price REAL NOT NULL,
  total_tax REAL NOT NULL DEFAULT 0,
  country_code TEXT,
  email TEXT,
  address_json TEXT,
  lines_json TEXT NOT NULL,
  supplier_lines_json TEXT,
  status TEXT NOT NULL,
  try_to_pay INTEGER NOT NULL DEFAULT 0,
  ae_order_ids_json TEXT,
  last_error TEXT,
  placed_at TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  source_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id);

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
  delivered_at TEXT,
  unpaid_warned INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  ae_product_id TEXT NOT NULL,
  shopify_product_gid TEXT,
  title TEXT NOT NULL,
  ae_currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  gpsr_json TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, ae_product_id)
);

CREATE TABLE IF NOT EXISTS mappings (
  shopify_variant_id TEXT PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id),
  product_id INTEGER REFERENCES products(id),
  shopify_variant_gid TEXT,
  inventory_item_gid TEXT,
  ae_product_id TEXT NOT NULL,
  ae_sku_attr TEXT,
  ae_sku_id TEXT,
  logistics_service_name TEXT,
  note TEXT,
  last_cost REAL,
  last_price REAL,
  last_stock INTEGER,
  last_synced_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mappings_product ON mappings(product_id);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'OPEN',
  entity_type TEXT,
  entity_id INTEGER,
  assignee TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  source TEXT,
  stage TEXT NOT NULL DEFAULT 'NEW',
  value REAL,
  currency TEXT,
  lost_reason TEXT,
  customer_id INTEGER REFERENCES customers(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  customer_id INTEGER REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT,
  reason TEXT NOT NULL,
  delivered_at TEXT,
  filed_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  late_filing INTEGER NOT NULL DEFAULT 0,
  refund_amount REAL,
  ae_dispute_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);

CREATE TABLE IF NOT EXISTS trend_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  seeds_json TEXT NOT NULL,
  status TEXT NOT NULL,
  signals_json TEXT,
  source_errors_json TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS ad_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  platform TEXT NOT NULL DEFAULT 'meta',
  account_id TEXT NOT NULL,
  name TEXT,
  currency TEXT NOT NULL,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (platform, account_id)
);

CREATE TABLE IF NOT EXISTS ad_stats (
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  spend REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  purchases REAL NOT NULL DEFAULT 0,
  purchase_value REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, ad_id, date)
);
CREATE INDEX IF NOT EXISTS idx_ad_stats_account_date ON ad_stats(account_id, date);

CREATE TABLE IF NOT EXISTS ad_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  meta_id TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  created_at TEXT NOT NULL,
  UNIQUE (level, meta_id)
);

CREATE TABLE IF NOT EXISTS ad_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  ai_json TEXT,
  ai_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
