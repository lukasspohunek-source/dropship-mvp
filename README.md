# dropship-mvp

Samostatný server pro dropshipping **Shopify (více e-shopů) → AliExpress**: objednávky, platby s limity, tracking,
katalog s hlídáním cen a skladu, CRM, podpora legislativních povinností a webové rozhraní pro mobil.

```
Shopify e-shopy ── webhook orders/paid ──► dropship-mvp ──► AliExpress (ds.order.create, volitelně try_to_pay)
                                              │
       Shopify ◄── fulfillment + tracking ────┤  každou hodinu: stav AE objednávek
       Shopify ◄── ceny a sklad ──────────────┤  každých 6 h: ds.product.get
                                              └─ CRM, reklamace, GDPR, DPH report, rozhraní /app
```

**Vyzkoušení bez účtů:** `npm ci && npm run demo` a otevři http://localhost:3100/app/ (token `demo-token-0123456789-abcdef`).

## Co umí

| Oblast | Funkce |
|---|---|
| **Objednávky** | příjem z více e-shopů (každý vlastní secret), odeslání do AE, platba s limitem per e-shop + globálním denním limitem, schvalování dražších, ruční zásahy, žádné automatické opakování nejistých odeslání |
| **Tracking** | čísla zásilek z AE → Shopify fulfillment + e-mail zákazníkovi, rozdělené zásilky, varování na nezaplacené |
| **Katalog** | import produktu z AE podle odkazu (koncept v Shopify), cenové pravidlo per e-shop, nákupní cena do Shopify, hlídání cen a skladu, stažené produkty → sklad 0 |
| **CRM** | zákazníci z objednávek (napříč e-shopy), poznámky, úkoly, leady, reklamace a odstoupení se lhůtami, segmenty + CSV, přehled |
| **Compliance** | GPSR údaje u produktů, údaje prodávajícího, formulář pro odstoupení, GDPR export/anonymizace/retence, DPH report (OSS/IOSS) |
| **Reklamy** | útrata z Meta (Facebook/Instagram, jen čtení), skutečný zisk po reklamě po produktech a kampaních, graf po dnech, denní automatická analýza s doporučeními + AI shrnutí |
| **AI trendy** | signály z Google Trends/Shopping (SerpApi), Seznamu, Heureky, TikToku a Instagramu (Bright Data) + bestsellery AliExpressu → Claude vybere kandidáty, kód spočítá marži, import jedním klepnutím |
| **Rozhraní** | `/app` – mobilní web v designu POKOVO (tokeny z Pokovo-konfiguratory), přihlášení admin tokenem |

> Compliance funkce jsou **pomůcka**, ne právní ani daňové poradenství. Obchodní podmínky, GPSR a DPH si nech ověřit.

## Bezpečnost – výchozí stav nic neodešle

| Proměnná | Výchozí | Význam |
|---|---|---|
| `DRY_RUN` | `true` | Do AliExpressu se nic neodešle (globálně). |
| `AUTO_PAY` | `false` | Objednávky vzniknou nezaplacené, platíš ručně v AE (globálně). |
| `AUTO_PAY_MAX_PER_DAY` | `10` | Max. automatických plateb za 24 h **přes všechny e-shopy**. |
| limit e-shopu | `1500` | Max. cena jedné objednávky v měně e-shopu; nastavuje se u každého e-shopu. |

- Nejistý výsledek odeslání (výpadek sítě) → stav `PLACE_UNCERTAIN`, nikdy se sám neopakuje.
- Tokeny e-shopů jsou v DB šifrované (AES-256-GCM, klíč `SECRET_KEY`). Při ztrátě klíče je zadej znovu.
- Rozhraní: přísná CSP, data se vypisují jen jako text, token zůstává v prohlížeči.

## Požadavky

- Node.js **22.13+** (vestavěné `node:sqlite`, bez databázové služby)
- Veřejná HTTPS adresa, SQLite soubor na trvalém disku
- Účet na [AliExpress Open Platform](https://openservice.aliexpress.com/) se schválenou aplikací (Dropshipping API)

## Nastavení

### 1. Server
```bash
cp .env.example .env    # vyplň ADMIN_TOKEN, SECRET_KEY (openssl rand -hex 32), AE_*, PUBLIC_BASE_URL
npm ci
npm test
npm run build
npm start               # rozhraní: https://<host>/app/
```

### 2. Každý Shopify e-shop
1. Admin → Settings → Apps → Develop apps → nová aplikace.
2. Admin API scopes: `read_orders`, `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`,
   `write_products`, `write_inventory`, `read_locations`.
3. Webhook **Order payment** (`orders/paid`), JSON, URL `https://<host>/webhooks/shopify/orders-paid` – stejná pro všechny e-shopy.
4. V rozhraní **Nastavení → E-shopy → Přidat**: doména, měna, země, Admin API token, webhook secret, limit platby, ceník.

### 3. AliExpress
V rozhraní **Nastavení → AliExpress → Propojit** (OAuth, token se pak obnovuje sám). Callback URL aplikace v AE:
`https://<host>/ae/oauth/callback`. Pro `try_to_pay` měj v AE účtu uloženou platební metodu.

### 4. Compliance
- **Nastavení → Prodávající**: firma, IČO, sídlo, adresa pro vrácení (pro každý e-shop).
- **Produkty → detail → GPSR**: výrobce, odpovědná osoba v EU, upozornění. Přehled vidíš na úvodní stránce.
- `OSS_FX_TO_EUR` – kurzy pro DPH report; `RETENTION_YEARS` – automatická anonymizace (0 = vypnuto).

## Reklamy a zisk (Meta)

Produkty → Reklamy. Počítá **skutečný zisk**, který Meta nezná:

```
tržba bez DPH − nákup z AliExpressu (kurz e-shopu) − platební poplatky − vrácené peníze = zisk před reklamou
zisk před reklamou − útrata za reklamu = zisk po reklamě
potřebný ROAS = tržba / zisk před reklamou  (pod ním produkt prodělává)
```

**Nastavení**
1. Business Manager → Uživatelé systému → vytvoř uživatele, přiřaď reklamní účet, vygeneruj token s oprávněním `ads_read` → `META_ACCESS_TOKEN`.
2. Nastavení → Reklamy → přidej ID reklamního účtu (`act_…`) k e-shopu.
3. Do „Parametry URL“ reklam vlož `utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}`
   – objednávky se pak spárují s kampaní i bez Pixelu.
4. Přiřazení reklam k produktům: automaticky, když název kampaně/sady/reklamy obsahuje ID produktu z AliExpressu; jinak ručně.

**Doporučení** (pravidla, čísla počítá kód): produkt po reklamě prodělává · kampaň utrácí bez prodeje ·
reklama na vyprodaný produkt · vydělává → +20 % rozpočtu · nízká marže · prodává se i bez reklamy ·
slabá kreativa (CTR) · únava kreativy · Pixel hlásí víc nákupů než e-shop · nepřiřazená útrata.
AI (`ANTHROPIC_API_KEY`) je shrne do kroků; smí použít jen spočítaná čísla. Nic se nespouští ani nemění v Meta automaticky.

**Omezení**: náklad je podle poslední známé ceny z AliExpressu (ne z okamžiku objednávky); útrata v jiné měně
se přepočítá kurzy `OSS_FX_TO_EUR`; data z Meta se načítají za posledních 28 dní (Meta dopočítává konverze zpětně).

## AI trendy

Produkty → AI trendy → zadej témata (např. „lampa, organizér“). Běh trvá 1–3 minuty a stojí kredity API.

| Zdroj | Jak | Proměnná | Poznámka |
|---|---|---|---|
| AliExpress bestsellery | DS API `recommend.feed.get` | (AE účet) | oficiální, zdarma |
| Google Trends + Shopping | SerpApi | `SERPAPI_KEY` | placené, oficiální API |
| Seznam | našeptávač | `TRENDS_SEZNAM` | neoficiální, formát se může změnit |
| Heureka | Bright Data Web Unlocker | `BRIGHTDATA_API_KEY`, `BRIGHTDATA_UNLOCKER_ZONE` | scraping – v rozporu s podmínkami |
| TikTok, Instagram | Bright Data Web Scraper API | `BRIGHTDATA_*_DATASET_ID` | scraping – v rozporu s podmínkami, ID datasetu z katalogu Bright Data |
| Vyhodnocení | Claude API (`claude-opus-5-5`, strukturovaný výstup) | `ANTHROPIC_API_KEY` | bez klíče jen surové signály |

- Každý zdroj se zapne jen s vyplněným klíčem; výpadek jednoho nezastaví ostatní.
- AI smí přiřadit jen produkt ze seznamu AE bestsellerů – vymyšlená ID se zahodí. Marži počítá kód podle cenového pravidla e-shopu, ne AI.
- Signály z internetu jdou do AI jako data; AI má pokyn ignorovat instrukce v nich.
- Limit `TRENDS_MAX_RUNS_PER_DAY` (výchozí 10) chrání před nečekanými náklady.
- Neověřeno naostro (bez klíčů): tvar odpovědí SerpApi, Bright Data datasetů, Seznam našeptávače a AE feedů – parsování je tolerantní, ale první běhy zkontroluj v „Surová data“.

## Cenové pravidlo

```
prodejní cena = zaokrouhlit_nahoru(náklad_USD × kurz × násobek + přirážka, krok) − offset
příklad: 5,20 USD × 23 × 2,2 = 263,12 → 270 − 1 = 269 Kč
```
Cena nikdy neklesne pod náklad. Sklad v Shopify = min(strop, sklad dodavatele − rezerva).
Každý e-shop má vlastní pravidlo (SK e-shop v EUR má jiný kurz). Kurz aktualizuj ručně.

## Stavy objednávky

| Stav | Co udělat |
|---|---|
| `NEEDS_MAPPING` | importuj produkt nebo přidej mapování – pak se zpracuje sama |
| `NEEDS_ADDRESS` | oprav adresu v detailu objednávky (změna v Shopify se nepropíše) |
| `NEEDS_APPROVAL` | schval, nebo zruš |
| `PLACE_FAILED` | oprav příčinu (v detailu), zkus znovu |
| `PLACE_UNCERTAIN` | **ověř v AE**: vznikla → „Označit jako odeslané“; nevznikla → „V AE nevznikla → znovu“ |
| `PLACED` / `FULFILLED` | čeká na zásilku / hotovo |

## API

Vše pod `/admin` s hlavičkou `Authorization: Bearer $ADMIN_TOKEN`. Hlavní skupiny:
`/orders`, `/shops`, `/mappings`, `/products` (+ `/products/import`, `/products/sync`), `/tracking/sync`,
`/crm/{dashboard,customers,notes,tasks,leads,tickets,segments}`, `/compliance/{overview,gpsr,products/:id/gpsr,shops/:id/seller,shops/:id/withdrawal-form,gdpr/retention,vat}`,
`/ae/oauth-url`. Veřejné: `GET /health`, `POST /webhooks/shopify/orders-paid`, `GET /ae/oauth/callback`, `/app`.

## Ověř na prvních reálných objednávkách

Bez schváleného AE účtu nešlo ověřit. Kód je připravený, ale ber to jako otevřené body:

1. **Provincie u CZ adres** – posílá se město; při `B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL` mapovat na kraj.
2. **Parametr `aliexpress.trade.ds.order.get`** – posílá se `order_id` i `single_order_query`; po ověření jeden odstraň (`src/aliexpress.ts`).
3. **`try_to_pay`** – které platební metody AE strhne.
4. **Formát `sku_attr`** z `ds.product.get` vs. při objednávce – ověř na produktu s variantami.
5. **OAuth URL** (`AE_AUTHORIZE_URL`) podle konzole aplikace.

Postup: `DRY_RUN=true` → `DRY_RUN=false, AUTO_PAY=false` (platíš ručně) → `AUTO_PAY=true` s nízkými limity.

## Omezení

- Jeden proces (zámky v paměti + SQLite). Pro více instancí by bylo potřeba Postgres.
- Zrušení/vrácení se do AE nepropisuje – řeš ručně, evidenci vedeš v Reklamacích.
- Databáze z verze 0.1 (bez více e-shopů) se odmítne – MVP ještě neběželo v produkci.
