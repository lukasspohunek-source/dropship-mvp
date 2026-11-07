import { validatePricing, type PricingRules } from "./shops.js";

export interface Config {
  port: number;
  dbPath: string;
  publicBaseUrl: string;
  adminToken: string;
  /** Klíč pro šifrování tokenů e-shopů v DB. Při ztrátě je nutné tokeny zadat znovu. */
  secretKey: string;
  shopify: {
    apiVersion: string;
    /** Volitelně: první e-shop založený z proměnných prostředí při startu. */
    bootstrap: { domain: string; adminToken: string; webhookSecret: string; name: string; currency: string; country: string } | null;
  };
  pricingDefaults: PricingRules;
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
      /** Výchozí limit jedné objednávky pro nově přidané e-shopy (v jejich měně). */
      maxOrderTotal: number;
      /** Max. počet automaticky placených objednávek za posledních 24 h. */
      maxPerDay: number;
    };
    pollSeconds: number;
  };
  catalog: {
    /** Jak často hlídat ceny a sklad u dodavatele. */
    syncHours: number;
  };
  compliance: { sellerCountry: string; fxToEur: Record<string, number>; retentionYears: number };
  trends: {
    /** Claude API: klíč čte SDK z ANTHROPIC_API_KEY. */
    aiEnabled: boolean;
    model: string;
    serpApiKey: string | null;
    brightData: { apiKey: string; tiktokDatasetId: string | null; instagramDatasetId: string | null; unlockerZone: string | null } | null;
    seznam: boolean;
    aeFeeds: string[];
    maxRunsPerDay: number;
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
    secretKey: req("SECRET_KEY"),
    shopify: {
      apiVersion: opt("SHOPIFY_API_VERSION", "2026-10"),
      bootstrap: env.SHOPIFY_SHOP?.trim()
        ? {
            domain: env.SHOPIFY_SHOP.trim().toLowerCase(),
            adminToken: req("SHOPIFY_ADMIN_TOKEN"),
            webhookSecret: req("SHOPIFY_WEBHOOK_SECRET"),
            name: opt("SHOPIFY_SHOP_NAME", env.SHOPIFY_SHOP.trim()),
            currency: opt("SHOPIFY_SHOP_CURRENCY", "CZK").toUpperCase(),
            country: opt("SHOPIFY_SHOP_COUNTRY", "CZ").toUpperCase(),
          }
        : null,
    },
    pricingDefaults: {
      fxRate: num("PRICE_FX_RATE", 23),
      multiplier: num("PRICE_MULTIPLIER", 2.2),
      fixedAdd: num("PRICE_FIXED_ADD", 0),
      roundStep: num("PRICE_ROUND_STEP", 10),
      roundOffset: num("PRICE_ROUND_OFFSET", 1),
      stockBuffer: num("STOCK_BUFFER", 2),
      stockCap: num("STOCK_CAP", 50),
      priceAlertPct: num("PRICE_ALERT_PCT", 15),
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
    catalog: {
      syncHours: num("CATALOG_SYNC_HOURS", 6),
    },
    trends: {
      aiEnabled: Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()),
      model: opt("TRENDS_MODEL", "claude-opus-5-5"),
      serpApiKey: env.SERPAPI_KEY?.trim() || null,
      brightData: env.BRIGHTDATA_API_KEY?.trim()
        ? {
            apiKey: env.BRIGHTDATA_API_KEY.trim(),
            tiktokDatasetId: env.BRIGHTDATA_TIKTOK_DATASET_ID?.trim() || null,
            instagramDatasetId: env.BRIGHTDATA_INSTAGRAM_DATASET_ID?.trim() || null,
            unlockerZone: env.BRIGHTDATA_UNLOCKER_ZONE?.trim() || null,
          }
        : null,
      seznam: bool("TRENDS_SEZNAM", true),
      aeFeeds: opt("AE_TREND_FEEDS", "").split(",").map((s) => s.trim()).filter(Boolean),
      maxRunsPerDay: num("TRENDS_MAX_RUNS_PER_DAY", 10),
    },
    compliance: {
      sellerCountry: opt("SELLER_COUNTRY", "CZ").toUpperCase(),
      fxToEur: parseFx(opt("OSS_FX_TO_EUR", '{"EUR":1,"CZK":0.04}')),
      retentionYears: num("RETENTION_YEARS", 0),
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
  if (cfg.secretKey.length < 32) throw new Error("SECRET_KEY musí mít aspoň 32 znaků");
  validatePricing(cfg.pricingDefaults);
  return cfg;
}

function parseFx(raw: string): Record<string, number> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error('OSS_FX_TO_EUR musí být JSON, např. {"EUR":1,"CZK":0.04}');
  }
  if (!v || typeof v !== "object" || Object.values(v).some((x) => typeof x !== "number" || !(x > 0)))
    throw new Error("OSS_FX_TO_EUR: každý kurz musí být kladné číslo");
  return Object.fromEntries(Object.entries(v as Record<string, number>).map(([k, x]) => [k.toUpperCase(), x]));
}
