export interface Config {
  port: number;
  dbPath: string;
  publicBaseUrl: string;
  adminToken: string;
  shopify: {
    shop: string;
    adminToken: string;
    webhookSecret: string;
    apiVersion: string;
  };
  ae: {
    appKey: string;
    appSecret: string;
    payCurrency: string;
    orderMemo: string;
    authorizeUrl: string;
  };
  orders: {
    dryRun: boolean;
    autoPay: {
      enabled: boolean;
      /** Max. celková cena objednávky v měně e-shopu (např. Kč) pro automatickou platbu. */
      maxOrderTotal: number;
      /** Max. počet automaticky placených objednávek za posledních 24 h. */
      maxPerDay: number;
    };
    pollSeconds: number;
  };
  tracking: {
    intervalMinutes: number;
    notifyCustomer: boolean;
    unpaidWarnHours: number;
    /** {number} se nahradí číslem zásilky. Prázdné = bez URL. */
    urlTemplate: string;
  };
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const missing: string[] = [];
  const req = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) missing.push(k);
    return v ?? "";
  };
  const opt = (k: string, d: string): string => env[k]?.trim() || d;
  const num = (k: string, d: number): number => {
    const raw = env[k]?.trim();
    if (!raw) return d;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} musí být nezáporné číslo, je "${raw}"`);
    return n;
  };
  const bool = (k: string, d: boolean): boolean => {
    const raw = env[k]?.trim().toLowerCase();
    if (!raw) return d;
    if (["1", "true", "yes", "ano"].includes(raw)) return true;
    if (["0", "false", "no", "ne"].includes(raw)) return false;
    throw new Error(`${k} musí být true/false, je "${raw}"`);
  };

  const cfg: Config = {
    port: num("PORT", 3000),
    dbPath: opt("DB_PATH", "./dropship.db"),
    publicBaseUrl: req("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    adminToken: req("ADMIN_TOKEN"),
    shopify: {
      shop: req("SHOPIFY_SHOP"),
      adminToken: req("SHOPIFY_ADMIN_TOKEN"),
      webhookSecret: req("SHOPIFY_WEBHOOK_SECRET"),
      apiVersion: opt("SHOPIFY_API_VERSION", "2026-10"),
    },
    ae: {
      appKey: req("AE_APP_KEY"),
      appSecret: req("AE_APP_SECRET"),
      payCurrency: opt("AE_PAY_CURRENCY", "USD"),
      orderMemo: opt(
        "AE_ORDER_MEMO",
        "Dropshipping order. Please do not include invoice, price or promotional material.",
      ),
      authorizeUrl: opt("AE_AUTHORIZE_URL", "https://api-sg.aliexpress.com/oauth/authorize"),
    },
    orders: {
      dryRun: bool("DRY_RUN", true),
      autoPay: {
        enabled: bool("AUTO_PAY", false),
        maxOrderTotal: num("AUTO_PAY_MAX_ORDER_TOTAL", 1500),
        maxPerDay: num("AUTO_PAY_MAX_PER_DAY", 10),
      },
      pollSeconds: num("ORDER_POLL_SECONDS", 60),
    },
    tracking: {
      intervalMinutes: num("TRACKING_INTERVAL_MINUTES", 60),
      notifyCustomer: bool("TRACKING_NOTIFY_CUSTOMER", true),
      unpaidWarnHours: num("UNPAID_WARN_HOURS", 6),
      urlTemplate: opt("TRACKING_URL_TEMPLATE", "https://t.17track.net/en#nums={number}"),
    },
  };

  if (missing.length) throw new Error(`Chybí proměnné prostředí: ${missing.join(", ")}`);
  if (cfg.adminToken.length < 24) throw new Error("ADMIN_TOKEN musí mít aspoň 24 znaků");
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(cfg.shopify.shop))
    throw new Error('SHOPIFY_SHOP musí být ve tvaru "nazev.myshopify.com"');
  return cfg;
}
