# dropship-mvp

Samostatný server, který automatizuje dropshipping **Shopify → AliExpress → tracking zpět do Shopify**.

```
Shopify (zaplacená objednávka)
  └─ webhook orders/paid ──► dropship-mvp ──► AliExpress ds.order.create (volitelně try_to_pay)
                                  │
                                  └─ každou hodinu: AE order.get → číslo zásilky
                                       └─► Shopify fulfillmentCreate + e-mail zákazníkovi
```

Část 1 (tento kód): objednávky, platby s limity, tracking, ruční zásahy přes admin API.
Část 2 (zatím chybí): import produktů z AE, hlídání cen a skladu, webové rozhraní pro schvalování.

## Bezpečnost – výchozí stav nic neodešle

| Proměnná | Výchozí | Význam |
|---|---|---|
| `DRY_RUN` | `true` | Do AliExpressu se nic neodešle, jen se zapíše, co by se odeslalo. |
| `AUTO_PAY` | `false` | Objednávky vzniknou **nezaplacené**, platíš je ručně v AliExpressu. |
| `AUTO_PAY_MAX_ORDER_TOTAL` | `1500` | S `AUTO_PAY=true`: dražší objednávka (v měně e-shopu) čeká na schválení. |
| `AUTO_PAY_MAX_PER_DAY` | `10` | S `AUTO_PAY=true`: po vyčerpání čekají další objednávky na schválení. |

Při chybě sítě nebo nejasné odpovědi se objednávka **nikdy automaticky neopakuje** (stav `PLACE_UNCERTAIN`),
aby nevznikla dvakrát. Musíš ji zkontrolovat v AliExpressu a vyřešit ručně (viz níže).

## Požadavky

- Node.js **22.13+** (používá vestavěné `node:sqlite`, žádná databázová služba)
- Veřejná HTTPS adresa (VPS, Railway, Render, Fly.io…); SQLite soubor musí být na trvalém disku
- Shopify e-shop + vlastní aplikace (custom app)
- Účet na [AliExpress Open Platform](https://openservice.aliexpress.com/) se schválenou aplikací s oprávněním Dropshipping API

## Nastavení

### 1. Shopify
1. Admin → Settings → Apps and sales channels → Develop apps → vytvoř aplikaci.
2. Admin API scopes: `read_orders`, `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`.
3. Nainstaluj aplikaci a zkopíruj Admin API access token → `SHOPIFY_ADMIN_TOKEN`; API secret key → `SHOPIFY_WEBHOOK_SECRET`.
4. Webhook: topic **Order payment** (`orders/paid`), formát JSON, URL `https://<PUBLIC_BASE_URL>/webhooks/shopify/orders-paid`.
   > Webhook vytvořený ručně v Settings → Notifications se podepisuje jiným klíčem (zobrazí se tam). Ten pak dej do `SHOPIFY_WEBHOOK_SECRET`.

### 2. AliExpress
1. Zaregistruj se jako vývojář, vytvoř aplikaci a požádej o Dropshipping API. Schválení trvá.
2. `AE_APP_KEY` a `AE_APP_SECRET` z konzole aplikace; callback URL v aplikaci nastav na
   `https://<PUBLIC_BASE_URL>/ae/oauth/callback`.
3. Ve svém AliExpress účtu měj uloženou platební metodu (kvůli `try_to_pay`).

### 3. Spuštění
```bash
cp .env.example .env      # vyplň hodnoty
npm ci
npm test                  # testy bez sítě
npm run build
npm start
```

### 4. Propojení AliExpress účtu (jednou, pak se token obnovuje sám)
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/admin/ae/oauth-url
# otevři vrácenou URL v prohlížeči, přihlas se do AliExpressu, potvrď
curl https://<host>/health     # "aliexpressAuthorized": true
```

## Mapování produktů

Každá varianta v Shopify musí mít přiřazený produkt AliExpress. Bez toho objednávka čeká ve stavu `NEEDS_MAPPING`
a po přidání mapování se automaticky zpracuje.

```bash
curl -X PUT https://<host>/admin/mappings/<shopify_variant_id> \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"aeProductId":"1005001234567890","aeSkuAttr":"14:200003699;5:361386","logisticsServiceName":"CAINIAO_STANDARD"}'
```
- `shopify_variant_id`: číselné ID varianty (Shopify admin → produkt → varianta, číslo v URL).
- `aeProductId`: číslo z URL produktu na AliExpressu.
- `aeSkuAttr`: konkrétní varianta u dodavatele (barva/velikost). Najdeš ji v odpovědi `aliexpress.ds.product.get`. Import přijde v části 2.
- `logisticsServiceName`: způsob dopravy; prázdné = AE vybere výchozí.

## Stavy objednávky

| Stav | Co znamená | Co udělat |
|---|---|---|
| `RECEIVED` | přijato, zpracuje se do minuty | nic |
| `NEEDS_MAPPING` | varianta bez mapování | přidej mapování |
| `NEEDS_ADDRESS` | chybí telefon, PSČ apod. | `PATCH /admin/orders/:id/address` (změna v Shopify se sem nepropíše) |
| `NEEDS_APPROVAL` | nad limitem platby | `approve` nebo `cancel` |
| `DRY_RUN` | zkušební režim | po vypnutí `DRY_RUN` → `retry` |
| `PLACED` | vytvořeno v AE, čeká na zásilku | nic |
| `PLACE_FAILED` | AE odmítl (důvod v `lastError`) | oprav příčinu, `retry` |
| `PLACE_UNCERTAIN` | **nevíme, jestli vznikla** | zkontroluj v AE, pak `mark-placed` nebo `retry` s potvrzením |
| `FULFILLED` | tracking je v Shopify | hotovo |
| `IGNORED` / `CANCELLED` | nic k odeslání / zrušeno | – |

## Admin API (vše s `Authorization: Bearer $ADMIN_TOKEN`)

```
GET  /admin/orders[?status=NEEDS_APPROVAL]
GET  /admin/orders/:id                     detail + zásilky + historie událostí
POST /admin/orders/:id/approve
POST /admin/orders/:id/retry               {"confirmNotPlaced": true} jen pro PLACE_UNCERTAIN
POST /admin/orders/:id/mark-placed         {"aeOrderIds": ["8100..."]}
PATCH /admin/orders/:id/address            {"phone": "+420 777 123 456"} – opraví a zkusí znovu
POST /admin/orders/:id/cancel              jen lokálně, ne v AE
GET  /admin/mappings
PUT  /admin/mappings/:variantId
DELETE /admin/mappings/:variantId
POST /admin/tracking/sync                  spustí kontrolu zásilek hned
GET  /admin/ae/oauth-url
GET  /health                               bez autorizace
```

## Ověř na prvních reálných objednávkách (s DRY_RUN=false a AUTO_PAY=false)

Tyto body nešlo ověřit bez schváleného AE účtu. Kód je na ně připravený, ale ber je jako otevřené:

1. **Provincie u CZ adres.** AE provincii vyžaduje a Shopify ji u CZ často nemá, proto se posílá město. Pokud AE vrátí
   `B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL`, je potřeba mapovat na kraj.
2. **Parametr pro `aliexpress.trade.ds.order.get`.** Posílá se `order_id` i `single_order_query`; po ověření jeden odstraň (`src/aliexpress.ts`).
3. **`try_to_pay`.** Jaké platební metody AE takto strhne a jak se pozná nezaplacená objednávka.
   Kód varuje, pokud je AE objednávka déle než `UNPAID_WARN_HOURS` ve stavu `PLACE_ORDER_SUCCESS`.
4. **OAuth URL** (`AE_AUTHORIZE_URL`) podle konzole tvé aplikace.

Doporučený postup: `DRY_RUN=true` (pár dní, kontroluj události) → `DRY_RUN=false, AUTO_PAY=false` (platíš ručně) → `AUTO_PAY=true` s nízkým limitem.

## Omezení MVP

- Jeden proces, jeden e-shop. Pro více instancí by zámek musel být v DB serveru (Postgres).
- Zrušení nebo vrácení objednávky se do AE nepropisuje, řeš ručně.
- Kontroluje se jen první číslo zásilky z každé AE objednávky.
- Legislativa (GPSR, 14denní lhůta na vrácení, clo na zásilky do EU) zůstává na tobě jako prodejci.
