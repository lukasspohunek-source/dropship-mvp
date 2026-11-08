// Dropship správa – jednostránkové rozhraní nad /admin API. Bez frameworku, žádné innerHTML s daty.
const $ = (s, r = document) => r.querySelector(s);
const TOKEN_KEY = "dropship_admin_token";
const state = { tab: "dashboard", sub: {}, shops: [], health: null };

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* privátní režim */ }
}

/** Bezpečné vytváření DOM: řetězce jsou vždy text. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** Přidá obsah do prvku; pole zploští, null/false vynechá (Element.append by je vypsal jako text). */
function put(el, ...children) {
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
}

async function api(path, opts = {}) {
  const res = await fetch(`/admin${path}`, {
    method: opts.method || "GET",
    headers: { Authorization: `Bearer ${getToken()}`, ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    logout();
    throw new Error("Neplatný token");
  }
  if (res.status === 204) return null;
  if (opts.raw) {
    if (!res.ok) throw new Error(`Chyba ${res.status}`);
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Chyba ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `show${err ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), err ? 6000 : 2500);
}

/** Obal pro akce: chyby zobrazí, po úspěchu toast a překreslení. */
async function act(fn, okMsg, after = rerender) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    if (after) await after(r);
    return r;
  } catch (e) {
    toast(e.message, true);
  }
}

function modal(...content) {
  const d = $("#modal");
  const body = $("#modalBody");
  // h() zploští pole a vynechá null – replaceChildren by je vypsal jako text.
  body.replaceChildren(h("div", { class: "row between" }, h("span"), h("button", { class: "link", onclick: closeModal }, "Zavřít ✕")), h("div", {}, ...content));
  if (!d.open) d.showModal();
}
function closeModal() {
  const d = $("#modal");
  if (d.open) d.close();
}

async function download(path, filename) {
  await act(async () => {
    const res = await api(path, { raw: true });
    const blob = await res.blob();
    const a = h("a", { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "Staženo", null);
}

// ---------- formuláře ----------

/** fields: [{name, label, type, value, options:[[value,label]], required, step, placeholder, hint}] */
function form(fields, submitLabel, onSubmit) {
  const inputs = {};
  const f = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      const v = {};
      for (const fd of fields) {
        const el = inputs[fd.name];
        if (fd.type === "checkbox") v[fd.name] = el.checked;
        else if (fd.type === "number") v[fd.name] = el.value === "" ? null : Number(el.value);
        else v[fd.name] = el.value.trim() === "" ? null : el.value.trim();
      }
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      try { await onSubmit(v, f); } finally { btn.disabled = false; }
    },
  });
  for (const fd of fields) {
    let el;
    if (fd.type === "select") el = h("select", { name: fd.name, required: fd.required }, fd.options.map(([val, lab]) => h("option", { value: val, selected: String(fd.value ?? "") === String(val) }, lab)));
    else if (fd.type === "textarea") el = h("textarea", { name: fd.name, required: fd.required, placeholder: fd.placeholder }, fd.value ?? "");
    else el = h("input", { name: fd.name, type: fd.type || "text", value: fd.value ?? "", checked: fd.type === "checkbox" ? fd.value : null, required: fd.required, step: fd.step, placeholder: fd.placeholder, autocomplete: fd.type === "password" ? "new-password" : "off" });
    inputs[fd.name] = el;
    f.append(fd.type === "checkbox" ? h("label", {}, el, fd.label) : h("label", {}, fd.label, el, fd.hint ? h("span", { class: "small muted" }, fd.hint) : null));
  }
  f.append(h("button", { type: "submit" }, submitLabel));
  return f;
}

/** České skloňování: plural(n, "objednávka", "objednávky", "objednávek"). */
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" }) : "–");
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("cs-CZ") : "–");
const money = (n, cur) => (n == null ? "–" : `${Number(n).toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} ${cur || ""}`.trim());
const shopName = (id) => state.shops.find((s) => s.id === id)?.name || `#${id}`;
const shopOptions = () => state.shops.map((s) => [s.id, `${s.name} (${s.currency})`]);
const kv = (pairs) => h("dl", { class: "kv" }, pairs.filter(Boolean).map(([k, v]) => [h("dt", {}, k), h("dd", {}, v ?? "–")]));

const STATUS = {
  RECEIVED: ["Přijato", ""], IGNORED: ["Ignorováno", ""], NEEDS_MAPPING: ["Chybí mapování", "warn"], NEEDS_ADDRESS: ["Chybí adresa", "warn"],
  NEEDS_APPROVAL: ["Ke schválení", "warn"], DRY_RUN: ["Zkušební", ""], PLACING: ["Odesílá se", ""], PLACED: ["Odesláno do AE", "ok"],
  PLACE_FAILED: ["AE odmítl", "err"], PLACE_UNCERTAIN: ["Nejisté – ověř v AE", "err"], FULFILLED: ["Vyřízeno", "ok"], CANCELLED: ["Zrušeno", ""],
};
const ATTENTION = ["NEEDS_MAPPING", "NEEDS_ADDRESS", "NEEDS_APPROVAL", "PLACE_FAILED", "PLACE_UNCERTAIN"];
const badge = (status) => h("span", { class: `badge ${(STATUS[status] || [])[1] || ""}` }, (STATUS[status] || [status])[0]);
const STAGES = { NEW: "Nový", CONTACTED: "Kontaktován", QUALIFIED: "Kvalifikován", PROPOSAL: "Nabídka", WON: "Vyhráno", LOST: "Prohráno" };
const TICKET_STATUS = { OPEN: "Otevřeno", WAITING_CUSTOMER: "Čeká na zákazníka", WAITING_SUPPLIER: "Čeká na dodavatele", RESOLVED: "Vyřízeno", REJECTED: "Zamítnuto" };
const TICKET_TYPE = { WITHDRAWAL: "Odstoupení (14 dní)", COMPLAINT: "Reklamace (30 dní)" };
const RESOLUTION = { REFUND: "Vrácení peněz", REPLACEMENT: "Výměna", REPAIR: "Oprava", DISCOUNT: "Sleva", NONE: "Bez plnění" };

// ---------- přehled ----------

async function viewDashboard(root) {
  const [d, c] = await Promise.all([api("/crm/dashboard"), api("/compliance/overview")]);
  const hl = state.health || {};
  put(root, 
    h("h1", {}, "Přehled"),
    !hl.aliexpressAuthorized ? h("div", { class: "alert err" }, "AliExpress není propojený. ", h("button", { class: "link", onclick: connectAe }, "Propojit")) : null,
    hl.dryRun ? h("div", { class: "alert" }, "Zkušební režim (DRY_RUN): objednávky se do AliExpressu neodesílají.") : null,
    h("div", { class: "grid" },
      stat("K řešení", d.needsAttention, () => go("orders", "attention")),
      stat("Reklamace otevřené", d.tickets.open, () => go("crm", "tickets")),
      stat("Reklamace po lhůtě", d.tickets.overdue, () => go("crm", "tickets")),
      stat("Úkoly po termínu", d.tasks.overdue, () => go("crm", "tasks")),
      stat("Úkoly dnes", d.tasks.today, () => go("crm", "tasks")),
      stat("Noví zákazníci (30 d)", d.newCustomers30d),
    ),
    h("h2", {}, "Tržby za 30 dní"),
    d.revenue30d.length
      ? h("div", { class: "grid" }, d.revenue30d.map((r) => stat(shopName(r.shop_id), money(r.total, r.currency), null, plural(r.orders, "objednávka", "objednávky", "objednávek"))))
      : h("p", { class: "muted" }, "Zatím žádné objednávky."),
    h("h2", {}, "Compliance"),
    c.gpsrIncompleteProducts ? h("div", { class: "alert" }, `${plural(c.gpsrIncompleteProducts, "produkt", "produkty", "produktů")} bez úplných údajů GPSR. `, h("button", { class: "link", onclick: () => go("products") }, "Zobrazit")) : null,
    c.shopsMissingSellerInfo.map((s) => h("div", { class: "alert" }, `${s.name}: chybí údaje prodávajícího (${s.sellerMissing.join(", ")}). `, h("button", { class: "link", onclick: () => go("settings", "seller") }, "Doplnit"))),
    c.ticketsOverdue ? h("div", { class: "alert err" }, `Po zákonné lhůtě: ${c.ticketsOverdue}× reklamace/odstoupení!`) : null,
    c.lateWithdrawals ? h("div", { class: "alert" }, `Odstoupení podané po 14 dnech: ${c.lateWithdrawals}× – posuď oprávněnost.`) : null,
    c.vat.map((w) => h("div", { class: "alert" }, w)),
    h("p", { class: "small muted" }, c.disclaimer),
  );
}
function stat(label, value, onclick, sub) {
  return h(onclick ? "button" : "div", { class: "stat", onclick }, h("span", { class: "small muted" }, label), h("b", {}, value ?? 0), sub ? h("span", { class: "small muted" }, sub) : null);
}

// ---------- objednávky ----------

async function viewOrders(root) {
  const filter = state.sub.orders || "attention";
  const all = await api(`/orders${filter !== "attention" && filter !== "all" ? `?status=${filter}` : ""}`);
  const list = filter === "attention" ? all.filter((o) => ATTENTION.includes(o.status)) : all;
  const chips = [["attention", "K řešení"], ["all", "Vše"], ["NEEDS_APPROVAL", "Ke schválení"], ["PLACED", "V AE"], ["FULFILLED", "Vyřízené"], ["DRY_RUN", "Zkušební"]];
  put(root, 
    h("h1", {}, "Objednávky"),
    h("div", { class: "chips" }, chips.map(([k, l]) => h("button", { class: k === filter ? "on" : "", onclick: () => go("orders", k) }, l))),
    list.length ? h("div", { class: "list" }, list.map((o) =>
      h("button", { class: "item", onclick: () => openOrder(o.id) },
        h("div", { class: "row between" }, h("span", { class: "title" }, o.name), badge(o.status)),
        h("div", { class: "small muted" }, `${shopName(o.shopId)} · ${money(o.totalPrice, o.currency)} · ${fmtDate(o.createdAt)}`),
        o.lastError ? h("div", { class: "small lvl-warn" }, o.lastError) : null,
      ))) : h("p", { class: "muted" }, "Nic tu není."),
  );
}

async function openOrder(id) {
  const o = await api(`/orders/${id}`);
  const s = o.status;
  const actions = h("div", { class: "row" });
  const add = (label, fn, cls) => actions.append(h("button", { class: cls, onclick: fn }, label));
  if (s === "NEEDS_APPROVAL") add("Schválit a zaplatit", () => confirm(`Schválit ${o.name} za ${money(o.totalPrice, o.currency)}?`) && act(() => api(`/orders/${id}/approve`, { method: "POST" }), "Schváleno", () => openOrder(id)), "primary");
  if (["PLACE_FAILED", "DRY_RUN", "NEEDS_ADDRESS", "NEEDS_MAPPING"].includes(s)) add("Zkusit znovu", () => act(() => api(`/orders/${id}/retry`, { method: "POST", body: {} }), "Zpracováno", () => openOrder(id)), "primary");
  if (s === "PLACE_UNCERTAIN") add("V AE nevznikla → znovu", () => confirm("Ověřil(a) jsi v AliExpressu, že objednávka NEVZNIKLA? Jinak vznikne dvakrát.") && act(() => api(`/orders/${id}/retry`, { method: "POST", body: { confirmNotPlaced: true } }), "Odesláno", () => openOrder(id)), "danger");
  if (["PLACE_UNCERTAIN", "PLACE_FAILED", "NEEDS_APPROVAL"].includes(s)) add("Označit jako odeslané", () => markPlaced(o));
  if (["NEEDS_ADDRESS", "PLACE_FAILED", "NEEDS_APPROVAL", "DRY_RUN"].includes(s)) add("Upravit adresu", () => editAddress(o));
  if (!["PLACING", "PLACED", "FULFILLED", "CANCELLED"].includes(s)) add("Zrušit", () => confirm("Zrušit objednávku lokálně?") && act(() => api(`/orders/${id}/cancel`, { method: "POST" }), "Zrušeno", () => openOrder(id)), "danger");
  add("Reklamace / odstoupení", () => newTicket({ orderId: id }));
  const a = o.address || {};
  modal(
    h("h2", {}, o.name, " ", badge(s)),
    o.lastError ? h("div", { class: "alert" }, o.lastError) : null,
    actions,
    kv([["E-shop", shopName(o.shopId)], ["Cena", money(o.totalPrice, o.currency)], ["E-mail", o.email], ["Zákazník", o.customerId ? h("button", { class: "link", onclick: () => openCustomer(o.customerId) }, `#${o.customerId}`) : "–"], ["AE objednávky", (o.aeOrderIds || []).join(", ") || "–"], ["Automatická platba", o.tryToPay ? "ano" : "ne"], ["Vytvořeno", fmtDate(o.createdAt)]]),
    h("h3", {}, "Adresa"),
    o.address ? h("p", {}, `${a.fullName}, ${a.address1}${a.address2 ? ", " + a.address2 : ""}, ${a.zip} ${a.city}, ${a.countryCode} · ${a.phone || "bez telefonu"}`) : h("p", { class: "muted" }, "Smazáno nebo chybí"),
    h("h3", {}, "Položky"),
    h("div", { class: "scroll" }, h("table", {}, h("tr", {}, h("th", {}, "Položka"), h("th", {}, "Ks"), h("th", {}, "Varianta"), h("th", {}, "")),
      (o.lines || []).map((l) => h("tr", {}, h("td", {}, l.title), h("td", {}, l.quantity), h("td", { class: "small" }, l.variantId || "–"),
        h("td", {}, s === "NEEDS_MAPPING" && l.variantId ? h("button", { class: "link", onclick: () => editMapping({ shopifyVariantId: l.variantId, shopId: o.shopId }, () => openOrder(id)) }, "Mapovat") : null))))),
    o.shipments?.length ? [h("h3", {}, "Zásilky"), o.shipments.map((sh) => h("div", { class: "card small" }, `AE ${sh.ae_order_id} · ${sh.ae_order_status || "?"} · ${sh.tracking_number ? `tracking ${sh.tracking_number} (${sh.carrier})` : "bez trackingu"}${sh.fulfilled_at ? " · vyřízeno v Shopify" : ""}${sh.last_error ? ` · chyba: ${sh.last_error}` : ""}`))] : null,
    h("h3", {}, "Historie"),
    h("div", { class: "events" }, (o.events || []).slice().reverse().map((e) => h("div", { class: `lvl-${e.level}` }, h("span", { class: "muted" }, fmtDate(e.created_at), " "), e.message))),
  );
}

function markPlaced(o) {
  modal(h("h2", {}, `Označit ${o.name} jako odeslané`), h("p", { class: "muted" }, "Zadej čísla objednávek z AliExpressu (oddělená čárkou)."),
    form([{ name: "ids", label: "AE čísla objednávek", required: true, placeholder: "8100000000000001" }], "Uložit", (v) =>
      act(() => api(`/orders/${o.id}/mark-placed`, { method: "POST", body: { aeOrderIds: v.ids.split(/[\s,;]+/).filter(Boolean) } }), "Uloženo", () => openOrder(o.id))));
}

function editAddress(o) {
  const a = o.address || {};
  modal(h("h2", {}, `Adresa ${o.name}`), h("p", { class: "small muted" }, "Změna v Shopify se sem nepropíše – oprav ji tady."),
    form([
      { name: "fullName", label: "Jméno", value: a.fullName, required: true }, { name: "address1", label: "Ulice", value: a.address1, required: true },
      { name: "address2", label: "Doplněk", value: a.address2 }, { name: "city", label: "Město", value: a.city, required: true },
      { name: "province", label: "Kraj / provincie", value: a.province }, { name: "zip", label: "PSČ", value: a.zip, required: true },
      { name: "countryCode", label: "Země (ISO)", value: a.countryCode, required: true }, { name: "phone", label: "Telefon", value: a.phone, required: true },
    ], "Uložit a zpracovat", (v) => act(() => api(`/orders/${o.id}/address`, { method: "PATCH", body: v }), "Uloženo", () => openOrder(o.id))));
}

function editMapping(m, after) {
  modal(h("h2", {}, `Mapování varianty ${m.shopifyVariantId || ""}`),
    h("p", { class: "small muted" }, "ID produktu je číslo v odkazu aliexpress.com/item/…html. SKU atribut je potřeba u produktů s variantami (lepší je import produktu)."),
    form([
      { name: "variantId", label: "ID varianty Shopify", value: m.shopifyVariantId, required: true },
      { name: "shopId", label: "E-shop", type: "select", options: shopOptions(), value: m.shopId },
      { name: "aeProductId", label: "ID produktu AliExpress", value: m.aeProductId, required: true },
      { name: "aeSkuAttr", label: "SKU atribut AE", value: m.aeSkuAttr, placeholder: "14:193#Black;5:100014064" },
      { name: "logisticsServiceName", label: "Doprava AE", value: m.logisticsServiceName, placeholder: "CAINIAO_STANDARD" },
    ], "Uložit", (v) => act(() => api(`/mappings/${encodeURIComponent(v.variantId)}`, { method: "PUT", body: { ...v, shopId: Number(v.shopId) } }), "Mapování uloženo", after || rerender)));
}

// ---------- produkty ----------

async function viewProducts(root) {
  const sub = state.sub.products || "catalog";
  put(root, h("div", { class: "subtabs" }, [["catalog", "Katalog"], ["ads", "Reklamy"], ["trends", "AI trendy"]].map(([k, l]) => h("button", { class: k === sub ? "on" : "", onclick: () => go("products", k) }, l))));
  if (sub === "trends") return viewTrends(root);
  if (sub === "ads") return viewAds(root);
  const [list, gaps] = await Promise.all([api("/products"), api("/compliance/gpsr")]);
  const gapIds = new Set(gaps.map((g) => g.id));
  put(root, 
    h("h1", {}, "Produkty"),
    h("div", { class: "card" }, h("h3", {}, "Import z AliExpressu"),
      state.shops.length ? form([
        { name: "shopId", label: "Do e-shopu", type: "select", options: shopOptions() },
        { name: "aeProduct", label: "Odkaz nebo ID produktu", required: true, placeholder: "https://www.aliexpress.com/item/1005….html" },
      ], "Importovat jako koncept", (v) => act(() => api("/products/import", { method: "POST", body: { shopId: Number(v.shopId), aeProduct: v.aeProduct } }), "Naimportováno – v Shopify je jako koncept"))
        : h("p", { class: "muted" }, "Nejdřív přidej e-shop v Nastavení.")),
    h("div", { class: "row" }, h("button", { onclick: () => act(() => api("/products/sync", { method: "POST" }), null, (r) => (toast(`Zkontrolováno ${r.products}, cen ${r.priceUpdates}, skladů ${r.stockUpdates}, chyb ${r.errors}`), rerender())) }, "Synchronizovat ceny a sklad"), h("button", { onclick: pricingPreview }, "Kalkulačka ceny")),
    h("div", { class: "list" }, list.map((p) => h("button", { class: "item", onclick: () => openProduct(p.id) },
      h("div", { class: "row between" }, h("span", { class: "title" }, p.title), h("span", { class: `badge ${p.status === "ACTIVE" ? "ok" : ""}` }, p.status === "ACTIVE" ? "Hlídá se" : "Pozastaveno")),
      h("div", { class: "small muted" }, `${shopName(p.shop_id)} · ${plural(p.variants, "varianta", "varianty", "variant")} · sync ${fmtDate(p.last_synced_at)}`),
      gapIds.has(p.id) ? h("div", { class: "small lvl-warn" }, "Chybí údaje GPSR") : null,
      p.last_error ? h("div", { class: "small lvl-error" }, p.last_error) : null))),
  );
}

async function openProduct(id) {
  const [{ product: p, variants }, g] = await Promise.all([api(`/products/${id}`), api(`/compliance/products/${id}/gpsr`)]);
  const gp = g.gpsr;
  modal(
    h("h2", {}, p.title),
    kv([["E-shop", shopName(p.shop_id)], ["AE produkt", p.ae_product_id], ["Shopify", p.shopify_product_gid], ["Poslední sync", fmtDate(p.last_synced_at)], ["Chyba", p.last_error]]),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: () => act(() => api(`/products/${id}/sync`, { method: "POST" }), "Synchronizováno", () => openProduct(id)) }, "Synchronizovat"),
      h("button", { onclick: () => act(() => api(`/products/${id}`, { method: "PATCH", body: { status: p.status === "ACTIVE" ? "PAUSED" : "ACTIVE" } }), "Uloženo", () => openProduct(id)) }, p.status === "ACTIVE" ? "Pozastavit hlídání" : "Obnovit hlídání")),
    h("h3", {}, "Varianty"),
    h("div", { class: "scroll" }, h("table", {}, h("tr", {}, h("th", {}, "Varianta"), h("th", {}, "Náklad"), h("th", {}, "Cena"), h("th", {}, "Sklad")),
      variants.map((v) => h("tr", {}, h("td", { class: "small" }, v.ae_sku_attr || v.shopify_variant_id), h("td", {}, v.last_cost ?? "–"), h("td", {}, v.last_price ?? "–"), h("td", {}, v.last_stock ?? "–"))))),
    h("h3", {}, "GPSR – bezpečnost výrobků"),
    g.missing.length ? h("div", { class: "alert" }, `Chybí: ${g.missing.join(", ")}`) : h("div", { class: "badge ok" }, "Údaje GPSR úplné"),
    form([
      { name: "mName", label: "Výrobce – název", value: gp.manufacturer.name }, { name: "mAddress", label: "Výrobce – poštovní adresa", value: gp.manufacturer.address },
      { name: "mContact", label: "Výrobce – e-mail / web", value: gp.manufacturer.contact }, { name: "inEu", label: "Výrobce sídlí v EU", type: "checkbox", value: gp.manufacturerInEu },
      { name: "rName", label: "Odpovědná osoba v EU – název", value: gp.euResponsible.name }, { name: "rAddress", label: "Odpovědná osoba – adresa", value: gp.euResponsible.address },
      { name: "rContact", label: "Odpovědná osoba – kontakt", value: gp.euResponsible.contact }, { name: "pid", label: "Identifikace (typ / model / šarže)", value: gp.productIdentifier },
      { name: "warnings", label: "Upozornění a bezpečnostní informace (česky)", type: "textarea", value: gp.warnings },
      { name: "ce", label: "Produkt nese označení CE", type: "checkbox", value: gp.ceMarking === true },
    ], "Uložit GPSR", (v) => act(() => api(`/compliance/products/${id}/gpsr`, { method: "PUT", body: {
      manufacturer: { name: v.mName, address: v.mAddress, contact: v.mContact }, manufacturerInEu: v.inEu,
      euResponsible: { name: v.rName, address: v.rAddress, contact: v.rContact }, productIdentifier: v.pid, warnings: v.warnings, ceMarking: v.ce,
    } }), "GPSR uloženo", () => openProduct(id))),
  );
}

function pricingPreview() {
  const out = h("p", {});
  modal(h("h2", {}, "Kalkulačka ceny"), form([
    { name: "shopId", label: "E-shop", type: "select", options: shopOptions() },
    { name: "cost", label: "Nákupní cena v měně AliExpressu", type: "number", step: "0.01", required: true },
  ], "Spočítat", async (v) => {
    const r = await act(() => api(`/pricing/preview?shopId=${v.shopId}&cost=${v.cost}`), null, null);
    if (r) out.replaceChildren(h("b", {}, money(r.price, r.currency)), ` (kurz ${r.rules.fxRate}, násobek ${r.rules.multiplier}, přirážka ${r.rules.fixedAdd})`);
  }), out);
}

// ---------- Reklamy ----------

const SEV = { critical: ["Kritické", "err"], warning: ["Pozor", "warn"], opportunity: ["Příležitost", "ok"], info: ["Info", ""] };
const PRIO = { 1: "Hned", 2: "Tento týden", 3: "Až bude čas" };

/** Celé jednotky měny – přehled zisku nepotřebuje haléře. */
const moneyR = (n, cur) => (n == null ? "–" : `${Math.round(n).toLocaleString("cs-CZ")} ${cur || ""}`.trim());

async function viewAds(root) {
  if (!state.shops.length) return put(root, h("p", { class: "muted" }, "Nejdřív přidej e-shop."));
  const shopId = state.adsShop || state.shops[0].id;
  const days = state.adsDays || 14;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86400e3).toISOString().slice(0, 10);
  const [st, stats, reports] = await Promise.all([api("/ads/status"), api(`/ads/stats?shopId=${shopId}&from=${from}&to=${to}`), api(`/ads/reports?shopId=${shopId}`)]);
  const report = reports[0] ? await api(`/ads/reports/${reports[0].id}`) : null;
  const cur = stats.currency;
  const t = stats.totals;
  const sel = h("select", { onchange: (e) => ((state.adsShop = Number(e.target.value)), rerender()) }, shopOptions().map(([v, l]) => h("option", { value: v, selected: v === shopId }, l)));
  const hasAcc = st.accounts.some((a) => a.shop_id === shopId);
  put(root,
    h("h1", {}, "Reklamy a zisk"),
    h("label", {}, "E-shop", sel),
    h("div", { class: "chips" }, [7, 14, 30].map((d) => h("button", { class: d === days ? "on" : "", onclick: () => ((state.adsDays = d), rerender()) }, `${d} dní`))),
    !st.meta ? h("div", { class: "alert" }, "Meta není napojená (chybí META_ACCESS_TOKEN) – zisk z objednávek se počítá, útrata je 0.") : null,
    st.meta && !hasAcc ? h("div", { class: "alert" }, "E-shop nemá reklamní účet. ", h("button", { class: "link", onclick: () => go("settings", "ads") }, "Přidat účet")) : null,
    stats.warnings.map((w) => h("div", { class: "alert" }, w)),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: () => act(() => api("/ads/analyze", { method: "POST", body: { shopId, days } }), "Analýza hotová") }, "Analyzovat a doporučit"),
      st.meta ? h("button", { onclick: () => act(() => api("/ads/sync", { method: "POST" }), null, (r) => (toast(`Načteno ${r.rows} řádků z ${r.accounts} účtů${r.errors ? `, chyb ${r.errors}` : ""}`), rerender())) }, "Načíst z Meta") : null),
    h("div", { class: "grid" },
      stat("Tržby bez DPH", moneyR(t.revenue, cur), null, plural(t.orders, "objednávka", "objednávky", "objednávek")),
      stat("Zisk před reklamou", moneyR(t.grossProfit, cur), null, `náklady ${moneyR(t.cogs, cur)} · poplatky ${moneyR(t.fees, cur)}`),
      stat("Útrata za reklamy", moneyR(t.spend, cur), null, t.unlinkedSpend ? `nepřiřazeno ${moneyR(t.unlinkedSpend, cur)}` : null),
      stat("Zisk po reklamě", moneyR(t.profitAfterAds, cur), null, t.mer ? `MER ${String(t.mer).replace(".", ",")}` : null)),
    costSourceNote(t.costSource),
    profitChart(stats.daily, cur),
    report ? reportBlock(report) : h("p", { class: "muted" }, "Zatím žádná analýza – spusť „Analyzovat a doporučit“. Automaticky běží jednou denně."),
    h("h2", {}, "Produkty"),
    h("div", { class: "scroll" }, h("table", {},
      h("tr", {}, h("th", {}, "Produkt"), h("th", {}, "Tržby"), h("th", {}, "Zisk"), h("th", {}, "Reklama"), h("th", {}, "Po reklamě"), h("th", {}, "ROAS / min.")),
      stats.products.map((p) => h("tr", {},
        h("td", {}, p.title, p.stockOut ? h("span", { class: "badge err" }, "vyprodáno") : null),
        h("td", { class: "num" }, moneyR(p.revenue, "")), h("td", { class: "num" }, moneyR(p.grossProfit, "")), h("td", { class: "num" }, moneyR(p.spend, "")),
        h("td", { class: `num ${p.profitAfterAds < 0 ? "lvl-error" : ""}` }, moneyR(p.profitAfterAds, "")),
        h("td", { class: "num" }, `${p.roas ?? "–"} / ${p.breakEvenRoas ?? "–"}`))))),
    h("p", { class: "small muted" }, `Částky v ${cur} bez DPH. „min.“ = ROAS, pod kterým produkt prodělává.`),
    h("h2", {}, "Kampaně"),
    stats.campaigns.length ? stats.campaigns.map((c) => h("div", { class: "card" },
      h("div", { class: "row between" }, h("span", { class: "title" }, c.name), c.linked ? h("span", { class: "badge ok" }, "přiřazeno") : h("button", { class: "link", onclick: () => linkCampaign(c) }, "Přiřadit k produktu")),
      h("div", { class: "small muted" }, `útrata ${moneyR(c.spend, cur)} · CTR ${c.ctrPct ?? "–"} % · CPC ${c.cpc != null ? moneyR(c.cpc, cur) : "–"} · Meta nákupy ${c.metaPurchases} · objednávky z UTM ${c.utmOrders}`))) : h("p", { class: "muted" }, "Žádná data z Meta za období."),
  );
}

function costSourceNote(c) {
  if (!c || c.actual + c.estimated + c.missing === 0) return null;
  const parts = [c.actual ? `${c.actual}× skutečná částka z AliExpressu` : null, c.estimated ? `${c.estimated}× odhad (cena + doprava)` : null, c.missing ? `${c.missing}× bez ceny` : null].filter(Boolean);
  return h("p", { class: `small ${c.missing ? "lvl-warn" : "muted"}` }, `Náklady objednávek: ${parts.join(", ")}.`);
}

function profitChart(daily, cur) {
  const max = Math.max(1, ...daily.map((d) => Math.abs(d.profitAfterAds)));
  const bars = h("div", { class: "bars", role: "img", "aria-label": "Zisk po reklamě po dnech" }, daily.map((d) => {
    const b = h("div", { class: `bar ${d.profitAfterAds < 0 ? "neg" : "pos"}`, title: `${d.date}: ${money(d.profitAfterAds, cur)} (útrata ${money(d.spend, cur)})` });
    b.style.height = `${Math.max(2, Math.round((Math.abs(d.profitAfterAds) / max) * 100))}%`;
    return b;
  }));
  return h("div", { class: "card" }, h("div", { class: "small muted" }, "Zisk po reklamě po dnech"), bars);
}

function reportBlock(r) {
  return h("div", {},
    h("h2", {}, "Doporučení"),
    h("p", { class: "small muted" }, `Analýza ${fmtDate(r.createdAt)} za ${fmtDay(r.from)} – ${fmtDay(r.to)}`),
    r.ai ? h("div", { class: "card" }, h("p", {}, r.ai.summary),
      r.ai.actions.map((a) => h("div", { class: "action" },
        h("div", { class: "row between" }, h("span", { class: "title" }, a.title), h("span", { class: `badge ${a.priority === 1 ? "err" : a.priority === 2 ? "warn" : ""}` }, PRIO[a.priority])),
        h("div", { class: "small" }, a.why),
        a.steps.length ? h("ol", { class: "small" }, a.steps.map((x) => h("li", {}, x))) : null))) : null,
    r.aiError ? h("div", { class: "alert" }, `AI shrnutí se nepovedlo: ${r.aiError}. Níže jsou nálezy pravidel.`) : null,
    r.findings.length ? r.findings.map((f) => h("div", { class: "card" },
      h("div", { class: "row between" }, h("span", { class: "title" }, f.title), h("span", { class: `badge ${SEV[f.severity][1]}` }, SEV[f.severity][0])),
      h("div", { class: "small muted" }, f.ref.name),
      h("div", { class: "small" }, f.detail),
      h("div", { class: "small" }, h("b", {}, "Co udělat: "), f.action))) : h("p", { class: "muted" }, "Žádné nálezy – nic nehoří."),
  );
}

async function linkCampaign(c) {
  const products = await api(`/products?shopId=${state.adsShop || state.shops[0].id}`);
  modal(h("h2", {}, "Přiřadit kampaň"), h("p", {}, c.name),
    products.length ? form([{ name: "productId", label: "Produkt", type: "select", options: products.map((p) => [p.id, p.title]) }], "Přiřadit", (v) =>
      act(() => api("/ads/links", { method: "PUT", body: { level: "campaign", metaId: c.campaignId, productId: Number(v.productId) } }), "Přiřazeno", () => (closeModal(), rerender())))
      : h("p", { class: "muted" }, "E-shop nemá žádné naimportované produkty."));
}

// ---------- AI trendy ----------

const RUN_STATUS = { RUNNING: ["Běží…", "warn"], DONE: ["Hotovo", "ok"], FAILED: ["Chyba", "err"] };

async function viewTrends(root) {
  const [st, runs] = await Promise.all([api("/trends/status"), api("/trends/runs")]);
  put(root,
    h("h1", {}, "AI trendy"),
    !st.ai ? h("div", { class: "alert" }, "AI vyhodnocení je vypnuté (chybí ANTHROPIC_API_KEY) – uvidíš jen surové signály.") : null,
    h("div", { class: "card small" },
      h("div", {}, "Zdroje: ", st.sources.length ? st.sources.map((x) => h("span", { class: "badge" }, x.label)) : "žádné – vyplň klíče v .env", st.aliexpress ? h("span", { class: "badge" }, "AliExpress bestsellery") : null),
      st.sources.filter((x) => x.caveat).map((x) => h("div", { class: "muted" }, `${x.label}: ${x.caveat}`)),
      h("div", { class: "muted" }, `Limit ${st.maxRunsPerDay} běhů denně – každý běh stojí kredity API.`)),
    state.shops.length ? form([
      { name: "shopId", label: "Pro e-shop (země a měna)", type: "select", options: shopOptions() },
      { name: "seeds", label: "Témata (čárkou, max. 5)", required: true, placeholder: "lampa, organizér, pes, kuchyně" },
    ], "Spustit hledání", (v) => act(() => api("/trends/runs", { method: "POST", body: { shopId: Number(v.shopId), seeds: v.seeds } }), "Spuštěno – trvá 1–3 minuty", (r) => openRun(r.id))) : h("p", { class: "muted" }, "Nejdřív přidej e-shop."),
    h("h2", {}, "Předchozí běhy"),
    h("div", { class: "list" }, runs.map((r) => h("button", { class: "item", onclick: () => openRun(r.id) },
      h("div", { class: "row between" }, h("span", { class: "title" }, r.seeds.join(", ")), h("span", { class: `badge ${RUN_STATUS[r.status][1]}` }, RUN_STATUS[r.status][0])),
      h("div", { class: "small muted" }, `${shopName(r.shopId)} · ${fmtDate(r.createdAt)}`)))),
  );
}

let runPoll;
async function openRun(id) {
  clearTimeout(runPoll);
  const r = await api(`/trends/runs/${id}`);
  const res = r.result;
  modal(
    h("h2", {}, r.seeds.join(", "), " ", h("span", { class: `badge ${RUN_STATUS[r.status][1]}` }, RUN_STATUS[r.status][0])),
    r.status === "RUNNING" ? h("p", { class: "muted" }, "Sbírám signály a vyhodnocuji… stránka se obnoví sama.") : null,
    r.error ? h("div", { class: "alert err" }, r.error) : null,
    Object.entries(r.sourceErrors || {}).map(([k, v]) => h("div", { class: "alert" }, `${k}: ${v}`)),
    res ? h("p", {}, res.summary) : null,
    res?.candidates?.map((c, i) => h("div", { class: "card" },
      h("div", { class: "row between" }, h("span", { class: "title" }, c.name), h("span", { class: `badge ${c.score >= 70 ? "ok" : c.score >= 40 ? "warn" : ""}` }, `skóre ${c.score}`)),
      h("p", { class: "small" }, c.why),
      c.ourPrice != null ? h("div", { class: "small" }, `Náklad ${money(c.costInShopCurrency, shopCurrency(r.shopId))} → naše cena ${money(c.ourPrice, shopCurrency(r.shopId))} · marže ${Number(c.marginPct).toLocaleString("cs-CZ")} %`) : null,
      c.expectedSellPrice != null ? h("div", { class: "small muted" }, `Konkurence kolem ${money(c.expectedSellPrice, shopCurrency(r.shopId))}`) : null,
      c.evidence.length ? h("ul", { class: "small muted" }, c.evidence.map((e) => h("li", {}, e))) : null,
      c.risks.length ? h("div", { class: "small lvl-warn" }, "Rizika: ", c.risks.join("; ")) : null,
      h("div", { class: "row" },
        c.aeProductId ? h("button", { class: "primary", onclick: () => act(() => api(`/trends/runs/${id}/candidates/${i}/import`, { method: "POST" }), "Naimportováno jako koncept") }, "Importovat do Shopify") : null,
        h("a", { href: c.aeSearchUrl, target: "_blank", rel: "noopener noreferrer" }, "Hledat na AliExpressu")))),
    r.data ? h("details", {}, h("summary", {}, `Surová data: ${r.data.signals.length} signálů, ${r.data.aeProducts.length} produktů AE`),
      h("div", { class: "scroll" }, h("table", {}, r.data.signals.slice(0, 200).map((x) => h("tr", {}, h("td", { class: "small" }, x.source), h("td", {}, x.term.slice(0, 120)), h("td", {}, x.score)))))) : null,
  );
  if (r.status === "RUNNING") runPoll = setTimeout(() => $("#modal").open && openRun(id), 5000);
}
const shopCurrency = (id) => state.shops.find((s) => s.id === id)?.currency || "";

// ---------- CRM ----------

const CRM_TABS = [["customers", "Zákazníci"], ["leads", "Leady"], ["tasks", "Úkoly"], ["tickets", "Reklamace"], ["segments", "Segmenty"]];

async function viewCrm(root) {
  const sub = state.sub.crm || "customers";
  put(root, h("h1", {}, "CRM"), h("div", { class: "subtabs" }, CRM_TABS.map(([k, l]) => h("button", { class: k === sub ? "on" : "", onclick: () => go("crm", k) }, l))));
  await { customers: crmCustomers, leads: crmLeads, tasks: crmTasks, tickets: crmTickets, segments: crmSegments }[sub](root);
}

async function crmCustomers(root) {
  const q = state.custQuery || "";
  const list = await api(`/crm/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const search = h("input", { type: "search", placeholder: "Hledat jméno, e-mail, telefon…", value: q });
  put(root, 
    h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), (state.custQuery = search.value.trim()), rerender()) }, search, h("button", { type: "submit" }, "Hledat")),
    h("div", { class: "row" }, h("button", { onclick: newCustomer }, "+ Zákazník")),
    h("div", { class: "list" }, list.map((c) => h("button", { class: "item", onclick: () => openCustomer(c.id) },
      h("div", { class: "row between" }, h("span", { class: "title" }, c.name || c.email), c.acceptsMarketing ? h("span", { class: "badge ok" }, "Souhlas") : null),
      h("div", { class: "small muted" }, `${c.email || "bez e-mailu"} · ${plural(c.orders_count, "objednávka", "objednávky", "objednávek")} · ${Object.entries(c.spent).map(([k, v]) => money(v, k)).join(", ") || "0"}`),
      c.tags.length ? h("div", { class: "small" }, c.tags.map((t) => h("span", { class: "badge" }, t))) : null))),
  );
}

function newCustomer() {
  modal(h("h2", {}, "Nový zákazník"), form([
    { name: "name", label: "Jméno", required: true }, { name: "email", label: "E-mail", type: "email" }, { name: "phone", label: "Telefon" },
    { name: "company", label: "Firma" }, { name: "country", label: "Země (ISO)" }, { name: "city", label: "Město" }, { name: "tags", label: "Štítky (čárkou)" },
    { name: "acceptsMarketing", label: "Souhlasí s marketingem", type: "checkbox" }, { name: "consentSource", label: "Kde a jak souhlas udělil (povinné při souhlasu)" },
  ], "Uložit", (v) => act(() => api("/crm/customers", { method: "POST", body: v }), "Uloženo", (c) => openCustomer(c.id))));
}

async function openCustomer(id) {
  const c = await api(`/crm/customers/${id}`);
  const anon = !!c.anonymized_at;
  modal(
    h("h2", {}, c.name || c.email || `Zákazník #${id}`),
    anon ? h("div", { class: "alert" }, `Anonymizováno ${fmtDate(c.anonymized_at)}`) : null,
    kv([["E-mail", c.email], ["Telefon", c.phone], ["Firma", c.company], ["Místo", [c.city, c.country].filter(Boolean).join(", ")], ["Objednávky", c.orders_count], ["Útrata", Object.entries(c.spent).map(([k, v]) => money(v, k)).join(", ")], ["Marketing", c.acceptsMarketing ? `ano (${fmtDate(c.marketing_consent_at)}, ${c.marketing_consent_source})` : `ne${c.marketing_consent_source ? ` (${c.marketing_consent_source})` : ""}`], ["Štítky", c.tags.join(", ")], ["Zdroj", c.source]]),
    !anon ? h("div", { class: "row" },
      h("button", { onclick: () => editCustomer(c) }, "Upravit"),
      h("button", { onclick: () => newTicket({ customerId: id }) }, "Reklamace"),
      h("button", { onclick: () => newTask({ entityType: "customer", entityId: id }, () => openCustomer(id)) }, "Úkol"),
      h("button", { onclick: () => download(`/crm/customers/${id}/export`, `zakaznik-${id}.json`) }, "Export dat (GDPR)"),
      h("button", { class: "danger", onclick: () => prompt("Anonymizace je nevratná. Napiš ANONYMIZOVAT:") === "ANONYMIZOVAT" && act(() => api(`/crm/customers/${id}/anonymize`, { method: "POST" }), "Anonymizováno", () => openCustomer(id)) }, "Anonymizovat")) : null,
    h("h3", {}, "Objednávky"),
    c.orders.length ? c.orders.map((o) => h("button", { class: "item", onclick: () => openOrder(o.id) }, h("div", { class: "row between" }, h("span", {}, `${o.name} · ${shopName(o.shopId)} · ${money(o.totalPrice, o.currency)}`), badge(o.status)))) : h("p", { class: "muted" }, "Žádné"),
    c.tickets.length ? [h("h3", {}, "Reklamace"), c.tickets.map((t) => ticketItem(t))] : null,
    c.tasks.length ? [h("h3", {}, "Úkoly"), c.tasks.map((t) => taskItem(t, () => openCustomer(id)))] : null,
    notesBlock("customer", id, c.notes, () => openCustomer(id), anon),
  );
}

function editCustomer(c) {
  modal(h("h2", {}, "Upravit zákazníka"), form([
    { name: "name", label: "Jméno", value: c.name }, { name: "phone", label: "Telefon", value: c.phone }, { name: "company", label: "Firma", value: c.company },
    { name: "country", label: "Země (ISO)", value: c.country }, { name: "city", label: "Město", value: c.city }, { name: "tags", label: "Štítky (čárkou)", value: c.tags.join(", ") },
    { name: "acceptsMarketing", label: "Souhlasí s marketingem", type: "checkbox", value: c.acceptsMarketing }, { name: "consentSource", label: "Zdroj souhlasu / důvod odvolání" },
  ], "Uložit", (v) => {
    const body = { ...v };
    if (v.acceptsMarketing === c.acceptsMarketing) { delete body.acceptsMarketing; delete body.consentSource; }
    return act(() => api(`/crm/customers/${c.id}`, { method: "PATCH", body }), "Uloženo", () => openCustomer(c.id));
  }));
}

function notesBlock(type, id, notes, after, readOnly) {
  return [
    h("h3", {}, "Poznámky"),
    !readOnly ? form([{ name: "body", label: "Nová poznámka", type: "textarea", required: true }], "Přidat", (v) => act(() => api("/crm/notes", { method: "POST", body: { entityType: type, entityId: id, body: v.body } }), "Přidáno", after)) : null,
    (notes || []).map((n) => h("div", { class: "card small" }, h("div", { class: "row between" }, h("span", { class: "muted" }, fmtDate(n.created_at)), h("button", { class: "link", onclick: () => confirm("Smazat poznámku?") && act(() => api(`/crm/notes/${n.id}`, { method: "DELETE" }), "Smazáno", after) }, "smazat")), n.body)),
  ];
}

async function crmLeads(root) {
  const stage = state.leadStage || "";
  const list = await api(`/crm/leads${stage ? `?stage=${stage}` : ""}`);
  put(root, 
    h("div", { class: "chips" }, h("button", { class: stage ? "" : "on", onclick: () => ((state.leadStage = ""), rerender()) }, "Vše"), Object.entries(STAGES).map(([k, l]) => h("button", { class: k === stage ? "on" : "", onclick: () => ((state.leadStage = k), rerender()) }, l))),
    h("button", { onclick: newLead }, "+ Lead"),
    h("div", { class: "list" }, list.map((l) => h("button", { class: "item", onclick: () => openLead(l.id) },
      h("div", { class: "row between" }, h("span", { class: "title" }, l.name), h("span", { class: "badge" }, STAGES[l.stage])),
      h("div", { class: "small muted" }, [l.company, l.email, l.value != null ? money(l.value, l.currency) : null, l.source].filter(Boolean).join(" · "))))),
  );
}

function newLead() {
  modal(h("h2", {}, "Nový lead"), form([
    { name: "name", label: "Jméno / název", required: true }, { name: "company", label: "Firma" }, { name: "email", label: "E-mail", type: "email" },
    { name: "phone", label: "Telefon" }, { name: "source", label: "Zdroj", placeholder: "Instagram, veletrh, doporučení…" },
    { name: "value", label: "Odhad hodnoty", type: "number", step: "0.01" }, { name: "currency", label: "Měna", value: "CZK" },
  ], "Uložit", (v) => act(() => api("/crm/leads", { method: "POST", body: v }), "Uloženo", (l) => openLead(l.id))));
}

async function openLead(id) {
  const l = await api(`/crm/leads/${id}`);
  modal(
    h("h2", {}, l.name, " ", h("span", { class: "badge" }, STAGES[l.stage])),
    kv([["Firma", l.company], ["E-mail", l.email], ["Telefon", l.phone], ["Zdroj", l.source], ["Hodnota", l.value != null ? money(l.value, l.currency) : "–"], ["Důvod prohry", l.lost_reason], ["Zákazník", l.customer_id ? h("button", { class: "link", onclick: () => openCustomer(l.customer_id) }, `#${l.customer_id}`) : "–"]]),
    form([
      { name: "stage", label: "Fáze", type: "select", options: Object.entries(STAGES), value: l.stage },
      { name: "lostReason", label: "Důvod prohry (u Prohráno povinné)", value: l.lost_reason },
      { name: "value", label: "Hodnota", type: "number", step: "0.01", value: l.value },
    ], "Uložit", (v) => act(() => api(`/crm/leads/${id}`, { method: "PATCH", body: v }), "Uloženo", () => openLead(id))),
    h("div", { class: "row" },
      !l.customer_id ? h("button", { class: "primary", onclick: () => act(() => api(`/crm/leads/${id}/convert`, { method: "POST" }), "Převedeno na zákazníka", (c) => openCustomer(c.id)) }, "Převést na zákazníka") : null,
      h("button", { onclick: () => newTask({ entityType: "lead", entityId: id }, () => openLead(id)) }, "Úkol")),
    l.tasks.length ? [h("h3", {}, "Úkoly"), l.tasks.map((t) => taskItem(t, () => openLead(id)))] : null,
    notesBlock("lead", id, l.notes, () => openLead(id)),
  );
}

async function crmTasks(root) {
  const f = state.taskFilter || "open";
  const q = { open: "?status=OPEN", overdue: "?due=overdue", today: "?due=today", week: "?due=week", done: "?status=DONE" }[f];
  const list = await api(`/crm/tasks${q}`);
  put(root, 
    h("div", { class: "chips" }, [["open", "Otevřené"], ["overdue", "Po termínu"], ["today", "Dnes"], ["week", "7 dní"], ["done", "Hotové"]].map(([k, l]) => h("button", { class: k === f ? "on" : "", onclick: () => ((state.taskFilter = k), rerender()) }, l))),
    h("button", { onclick: () => newTask({}) }, "+ Úkol"),
    h("div", {}, list.map((t) => taskItem(t, rerender))),
  );
}

function taskItem(t, after) {
  const today = new Date().toISOString().slice(0, 10);
  const late = t.status === "OPEN" && t.due_date && t.due_date < today;
  return h("div", { class: "card row between" },
    h("label", { class: "row" }, h("input", { type: "checkbox", checked: t.status === "DONE", onchange: (e) => act(() => api(`/crm/tasks/${t.id}`, { method: "PATCH", body: { status: e.target.checked ? "DONE" : "OPEN" } }), null, after) }),
      h("span", {}, h("span", { class: "title" }, t.title), h("br"), h("span", { class: `small ${late ? "lvl-error" : "muted"}` }, `${fmtDay(t.due_date)}${t.priority === "HIGH" ? " · důležité" : ""}${t.assignee ? ` · ${t.assignee}` : ""}${t.entity_type ? ` · ${t.entity_type} #${t.entity_id}` : ""}`))),
    h("button", { class: "link", onclick: () => confirm("Smazat úkol?") && act(() => api(`/crm/tasks/${t.id}`, { method: "DELETE" }), "Smazáno", after) }, "smazat"));
}

function newTask(link, after) {
  modal(h("h2", {}, "Nový úkol"), form([
    { name: "title", label: "Co udělat", required: true }, { name: "dueDate", label: "Termín", type: "date" },
    { name: "priority", label: "Priorita", type: "select", options: [["NORMAL", "Normální"], ["HIGH", "Důležité"], ["LOW", "Nízká"]] },
    { name: "assignee", label: "Kdo" }, { name: "description", label: "Popis", type: "textarea" },
  ], "Uložit", (v) => act(() => api("/crm/tasks", { method: "POST", body: { ...v, ...link } }), "Uloženo", after || (() => (closeModal(), rerender())))));
}

async function crmTickets(root) {
  const f = state.ticketFilter || "open";
  const list = await api(`/crm/tickets${f === "open" ? "?open=1" : f === "overdue" ? "?overdue=1" : ""}`);
  put(root, 
    h("div", { class: "chips" }, [["open", "Otevřené"], ["overdue", "Po lhůtě"], ["all", "Vše"]].map(([k, l]) => h("button", { class: k === f ? "on" : "", onclick: () => ((state.ticketFilter = k), rerender()) }, l))),
    h("button", { onclick: () => newTicket({}) }, "+ Reklamace / odstoupení"),
    h("div", {}, list.map((t) => ticketItem(t))),
  );
}

function ticketItem(t) {
  return h("button", { class: "item", onclick: () => openTicket(t.id) },
    h("div", { class: "row between" }, h("span", { class: "title" }, `#${t.id} ${TICKET_TYPE[t.type]}`), h("span", { class: `badge ${t.overdue ? "err" : t.closed_at ? "ok" : "warn"}` }, t.overdue ? "PO LHŮTĚ" : TICKET_STATUS[t.status])),
    h("div", { class: "small muted" }, `lhůta ${fmtDay(t.deadline)} · podáno ${fmtDay(t.filed_at)}${t.order_id ? ` · objednávka #${t.order_id}` : ""}${t.late_filing ? " · podáno pozdě" : ""}`),
    h("div", { class: "small" }, t.reason));
}

function newTicket(link) {
  modal(h("h2", {}, "Reklamace / odstoupení"),
    h("p", { class: "small muted" }, "Odstoupení: spotřebitel do 14 dnů od převzetí, peníze vrátit do 14 dnů od odstoupení. Reklamace: vyřídit do 30 dnů."),
    form([
      { name: "type", label: "Typ", type: "select", options: Object.entries(TICKET_TYPE) },
      { name: "orderId", label: "Číslo objednávky (interní)", type: "number", value: link.orderId }, { name: "customerId", label: "Zákazník (interní ID)", type: "number", value: link.customerId },
      { name: "reason", label: "Důvod / popis vady", type: "textarea", required: true },
      { name: "deliveredAt", label: "Zboží převzato dne", type: "date" }, { name: "filedAt", label: "Uplatněno dne (prázdné = dnes)", type: "date" },
    ], "Založit", (v) => act(() => api("/crm/tickets", { method: "POST", body: v }), "Založeno", (t) => openTicket(t.id))));
}

async function openTicket(id) {
  const t = await api(`/crm/tickets/${id}`);
  modal(
    h("h2", {}, `#${t.id} ${TICKET_TYPE[t.type]}`),
    t.overdue ? h("div", { class: "alert err" }, `Zákonná lhůta vypršela ${fmtDay(t.deadline)}!`) : null,
    t.late_filing ? h("div", { class: "alert" }, "Odstoupení podáno po 14 dnech od převzetí – posuď oprávněnost.") : null,
    kv([["Stav", TICKET_STATUS[t.status]], ["Lhůta", fmtDay(t.deadline)], ["Uplatněno", fmtDay(t.filed_at)], ["Převzato", fmtDay(t.delivered_at)], ["Řešení", RESOLUTION[t.resolution]], ["Vráceno", t.refund_amount], ["Spor v AE", t.ae_dispute_id], ["Objednávka", t.order_id ? h("button", { class: "link", onclick: () => openOrder(t.order_id) }, `#${t.order_id}`) : "–"], ["Zákazník", t.customer_id ? h("button", { class: "link", onclick: () => openCustomer(t.customer_id) }, `#${t.customer_id}`) : "–"], ["Důvod", t.reason]]),
    form([
      { name: "status", label: "Stav", type: "select", options: Object.entries(TICKET_STATUS), value: t.status },
      { name: "resolution", label: "Řešení", type: "select", options: [["", "–"], ...Object.entries(RESOLUTION)], value: t.resolution || "" },
      { name: "refundAmount", label: "Vrácená částka", type: "number", step: "0.01", value: t.refund_amount },
      { name: "aeDisputeId", label: "Číslo sporu v AliExpressu", value: t.ae_dispute_id },
      { name: "deliveredAt", label: "Převzato dne", type: "date", value: t.delivered_at },
      { name: "note", label: "Poznámka (u zamítnutí povinné odůvodnění)", type: "textarea" },
    ], "Uložit", (v) => act(() => api(`/crm/tickets/${id}`, { method: "PATCH", body: v }), "Uloženo", () => openTicket(id))),
    t.notes.length ? [h("h3", {}, "Historie"), t.notes.map((n) => h("div", { class: "card small" }, h("span", { class: "muted" }, fmtDate(n.created_at), " "), n.body))] : null,
  );
}

async function crmSegments(root) {
  const list = await api("/crm/segments");
  put(root, 
    h("p", { class: "small muted" }, "Export CSV obsahuje vždy jen zákazníky se souhlasem s marketingem."),
    h("button", { onclick: newSegment }, "+ Segment"),
    h("div", {}, list.map((s) => h("div", { class: "card" },
      h("div", { class: "row between" }, h("span", { class: "title" }, s.name), h("span", { class: "badge" }, plural(s.size, "kontakt", "kontakty", "kontaktů"))),
      h("div", { class: "small muted" }, JSON.stringify(s.filter)),
      h("div", { class: "row" }, h("button", { onclick: () => download(`/crm/segments/${s.id}/export.csv`, `segment-${s.id}.csv`) }, "Stáhnout CSV"),
        h("button", { class: "link", onclick: () => confirm("Smazat segment?") && act(() => api(`/crm/segments/${s.id}`, { method: "DELETE" }), "Smazáno") }, "smazat"))))),
  );
}

function newSegment() {
  modal(h("h2", {}, "Nový segment"), form([
    { name: "name", label: "Název", required: true }, { name: "country", label: "Země (ISO)" }, { name: "tags", label: "Kterýkoli ze štítků (čárkou)" },
    { name: "shopId", label: "Nakoupil v e-shopu", type: "select", options: [["", "kdekoli"], ...shopOptions()] },
    { name: "minOrders", label: "Min. počet objednávek", type: "number" },
    { name: "lastOrderWithinDays", label: "Poslední objednávka za posledních N dní", type: "number" },
    { name: "lastOrderOlderThanDays", label: "Poslední objednávka starší než N dní (reaktivace)", type: "number" },
  ], "Uložit", (v) => act(() => api("/crm/segments", { method: "POST", body: { name: v.name, filter: {
    country: v.country || undefined, tagsAny: v.tags ? v.tags.split(",") : undefined, shopId: v.shopId ? Number(v.shopId) : undefined,
    minOrders: v.minOrders ?? undefined, lastOrderWithinDays: v.lastOrderWithinDays ?? undefined, lastOrderOlderThanDays: v.lastOrderOlderThanDays ?? undefined,
  } } }), "Uloženo", () => (closeModal(), rerender()))));
}

// ---------- nastavení ----------

const SET_TABS = [["shops", "E-shopy"], ["ads", "Reklamy"], ["seller", "Prodávající"], ["mappings", "Mapování"], ["vat", "DPH / OSS"], ["gdpr", "GDPR"], ["ae", "AliExpress"]];

async function viewSettings(root) {
  const sub = state.sub.settings || "shops";
  put(root, h("h1", {}, "Nastavení"), h("div", { class: "subtabs" }, SET_TABS.map(([k, l]) => h("button", { class: k === sub ? "on" : "", onclick: () => go("settings", k) }, l))));
  await { shops: setShops, ads: setAds, seller: setSeller, mappings: setMappings, vat: setVat, gdpr: setGdpr, ae: setAe }[sub](root);
}

const PRICING_FIELDS = (p = {}) => [
  { name: "fxRate", label: "Kurz (měna e-shopu za 1 USD)", type: "number", step: "0.0001", value: p.fxRate },
  { name: "shippingPerUnit", label: "Doprava z AliExpressu na kus (USD, odhad)", type: "number", step: "0.01", value: p.shippingPerUnit ?? 0 },
  { name: "multiplier", label: "Násobek nákladů (≥ 1)", type: "number", step: "0.01", value: p.multiplier },
  { name: "fixedAdd", label: "Pevná přirážka", type: "number", step: "0.01", value: p.fixedAdd },
  { name: "roundStep", label: "Zaokrouhlit nahoru na", type: "number", value: p.roundStep },
  { name: "roundOffset", label: "… mínus", type: "number", value: p.roundOffset },
  { name: "stockBuffer", label: "Rezerva skladu (ks)", type: "number", value: p.stockBuffer },
  { name: "stockCap", label: "Max. zobrazený sklad", type: "number", value: p.stockCap },
  { name: "priceAlertPct", label: "Varovat při změně ceny o víc než %", type: "number", value: p.priceAlertPct },
];
const pickPricing = (v) => Object.fromEntries(Object.entries(v).filter(([k, x]) => PRICING_FIELDS().some((f) => f.name === k) && x != null));

async function setShops(root) {
  put(root, 
    h("button", { onclick: () => shopForm(null) }, "+ Přidat e-shop"),
    state.shops.map((s) => h("button", { class: "item", onclick: () => shopForm(s) },
      h("div", { class: "row between" }, h("span", { class: "title" }, s.name), h("span", { class: `badge ${s.active ? "ok" : ""}` }, s.active ? "aktivní" : "vypnuto")),
      h("div", { class: "small muted" }, `${s.domain} · ${s.currency} · ${s.country} · limit platby ${money(s.autoPayMaxOrderTotal, s.currency)}`))),
    h("p", { class: "small muted" }, "Webhook pro všechny e-shopy: ", h("code", {}, `${location.origin}/webhooks/shopify/orders-paid`), " (téma Order payment)."),
  );
}

function shopForm(s) {
  const isNew = !s;
  modal(h("h2", {}, isNew ? "Nový e-shop" : s.name),
    h("p", { class: "small muted" }, "Tokeny se ukládají šifrovaně a zpět se nezobrazují. Při úpravě vyplň jen pokud je měníš."),
    form([
      ...(isNew ? [{ name: "domain", label: "Doména", required: true, placeholder: "nazev.myshopify.com" }] : []),
      { name: "name", label: "Název", value: s?.name, required: true },
      { name: "currency", label: "Měna", value: s?.currency || "CZK", required: true }, { name: "country", label: "Země (ISO)", value: s?.country || "CZ", required: true },
      { name: "adminToken", label: "Admin API token", type: "password", required: isNew }, { name: "webhookSecret", label: "Webhook secret", type: "password", required: isNew },
      { name: "autoPayMaxOrderTotal", label: "Limit automatické platby jedné objednávky", type: "number", value: s?.autoPayMaxOrderTotal },
      ...(isNew ? [] : [{ name: "active", label: "Aktivní", type: "checkbox", value: s.active }]),
      ...PRICING_FIELDS(s?.pricing),
    ], "Uložit", async (v) => {
      const body = { name: v.name, currency: v.currency, country: v.country, pricing: pickPricing(v) };
      if (v.autoPayMaxOrderTotal != null) body.autoPayMaxOrderTotal = v.autoPayMaxOrderTotal;
      if (v.adminToken) body.adminToken = v.adminToken;
      if (v.webhookSecret) body.webhookSecret = v.webhookSecret;
      if (isNew) body.domain = v.domain; else body.active = v.active;
      await act(() => api(isNew ? "/shops" : `/shops/${s.id}`, { method: isNew ? "POST" : "PATCH", body }), "Uloženo", async () => (await loadShops(), closeModal(), rerender()));
    }));
}

const UTM_TEMPLATE = "utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}";

async function setAds(root) {
  const [st, links] = await Promise.all([api("/ads/status"), api("/ads/links")]);
  put(root,
    !st.meta ? h("div", { class: "alert" }, "Chybí META_ACCESS_TOKEN v .env na serveru (token systémového uživatele s oprávněním ads_read).") : null,
    h("h3", {}, "Reklamní účty Meta"),
    st.accounts.map((a) => h("div", { class: "card row between" },
      h("span", {}, h("span", { class: "title" }, a.name || `act_${a.account_id}`), h("br"), h("span", { class: `small ${a.last_error ? "lvl-error" : "muted"}` }, `${shopName(a.shop_id)} · ${a.currency} · ${a.last_error ? a.last_error : `načteno ${fmtDate(a.last_synced_at)}`}`)),
      h("button", { class: "link", onclick: () => confirm("Odebrat účet? Stažená data zůstanou.") && act(() => api(`/ads/accounts/${a.id}`, { method: "DELETE" }), "Odebráno") }, "odebrat"))),
    st.meta ? form([
      { name: "shopId", label: "E-shop", type: "select", options: shopOptions() },
      { name: "accountId", label: "ID reklamního účtu", required: true, placeholder: "act_1234567890", hint: "Ads Manager → přepínač účtu → číslo účtu" },
    ], "Přidat účet", (v) => act(() => api("/ads/accounts", { method: "POST", body: { shopId: Number(v.shopId), accountId: v.accountId } }), "Účet přidán")) : null,
    h("h3", {}, "Měření objednávek z reklam (UTM)"),
    h("p", { class: "small muted" }, "V Meta Ads Manageru vlož u reklam do pole „Parametry URL“ tento text. Pak se objednávky spárují s kampaní i bez Pixelu:"),
    h("pre", {}, UTM_TEMPLATE),
    h("button", { onclick: () => navigator.clipboard?.writeText(UTM_TEMPLATE).then(() => toast("Zkopírováno"), () => toast("Kopírování se nepovedlo", true)) }, "Zkopírovat"),
    h("h3", {}, "Přiřazení reklam k produktům"),
    h("p", { class: "small muted" }, "Automaticky: když název kampaně, sady nebo reklamy obsahuje ID produktu z AliExpressu. Ručně: v Produkty → Reklamy → kampaň → Přiřadit."),
    links.length ? links.map((l) => h("div", { class: "card row between small" }, `${l.level} ${l.meta_id} → ${l.product_title}`, h("button", { class: "link", onclick: () => act(() => api(`/ads/links/${l.id}`, { method: "DELETE" }), "Odebráno") }, "odebrat"))) : h("p", { class: "muted small" }, "Žádná ruční přiřazení."),
  );
}

async function setSeller(root) {
  if (!state.shops.length) return put(root, h("p", { class: "muted" }, "Nejdřív přidej e-shop."));
  const shopId = state.sellerShop || state.shops[0].id;
  const r = await api(`/compliance/shops/${shopId}/seller`);
  const s = r.seller || {};
  const sel = h("select", { onchange: (e) => ((state.sellerShop = Number(e.target.value)), rerender()) }, shopOptions().map(([v, l]) => h("option", { value: v, selected: v === shopId }, l)));
  put(root, 
    h("label", {}, "E-shop", sel),
    r.missing.length ? h("div", { class: "alert" }, `Chybí: ${r.missing.join(", ")}`) : h("span", { class: "badge ok" }, "Údaje úplné"),
    form([
      { name: "legalName", label: "Obchodní firma / jméno", value: s.legalName }, { name: "address", label: "Sídlo", value: s.address },
      { name: "ico", label: "IČO", value: s.ico }, { name: "dic", label: "DIČ", value: s.dic }, { name: "email", label: "E-mail", value: s.email },
      { name: "phone", label: "Telefon", value: s.phone }, { name: "returnAddress", label: "Adresa pro vrácení zboží (v EU)", value: s.returnAddress },
    ], "Uložit", (v) => act(() => api(`/compliance/shops/${shopId}/seller`, { method: "PUT", body: v }), "Uloženo")),
    h("button", { onclick: async () => { const res = await act(() => api(`/compliance/shops/${shopId}/withdrawal-form`, { raw: true }), null, null); if (res) modal(h("h2", {}, "Formulář pro odstoupení"), h("pre", {}, await res.text())); } }, "Zobrazit formulář pro odstoupení"),
  );
}

async function setMappings(root) {
  const list = await api("/mappings");
  put(root, 
    h("p", { class: "small muted" }, "Produkty z importu se mapují automaticky. Ručně jen pro produkty založené mimo import."),
    h("button", { onclick: () => editMapping({}) }, "+ Mapování"),
    h("div", { class: "scroll" }, h("table", {}, h("tr", {}, h("th", {}, "Varianta"), h("th", {}, "E-shop"), h("th", {}, "AE produkt"), h("th", {}, "SKU"), h("th", {})),
      list.map((m) => h("tr", {}, h("td", {}, m.shopifyVariantId), h("td", {}, m.shopId ? shopName(m.shopId) : "–"), h("td", {}, m.aeProductId), h("td", { class: "small" }, m.aeSkuAttr || "–"),
        h("td", {}, h("button", { class: "link", onclick: () => editMapping(m) }, "upravit"), h("button", { class: "link", onclick: () => confirm("Smazat mapování?") && act(() => api(`/mappings/${m.shopifyVariantId}`, { method: "DELETE" }), "Smazáno") }, "smazat")))))),
  );
}

async function setVat(root) {
  const year = state.vatYear || new Date().getFullYear();
  const r = await api(`/compliance/vat?year=${year}`);
  put(root, 
    h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), (state.vatYear = Number(e.target.year.value)), rerender()) }, h("input", { name: "year", type: "number", value: year, min: 2021 }), h("button", { type: "submit" }, "Zobrazit")),
    r.warnings.map((w) => h("div", { class: "alert" }, w)),
    h("div", { class: "grid" }, stat("Prodej na dálku v EU (bez DPH)", `${r.euDistanceSales.netEur.toLocaleString("cs-CZ")} €`, null, `${r.euDistanceSales.percent} % z limitu ${r.euDistanceSales.thresholdEur.toLocaleString("cs-CZ")} €`), stat("Objednávky nad 150 €", r.ordersOverIossLimit.length)),
    h("div", { class: "scroll" }, h("table", {}, h("tr", {}, h("th", {}, "Země"), h("th", {}, "Obj."), h("th", {}, "Bez DPH €"), h("th", {}, "S DPH €"), h("th", {}, "")),
      r.countries.map((c) => h("tr", {}, h("td", {}, c.country), h("td", {}, c.orders), h("td", {}, c.netEur), h("td", {}, c.grossEur), h("td", { class: "small muted" }, c.domestic ? "domácí" : c.eu ? "EU" : "mimo EU"))))),
    h("h3", {}, "Poznámky"), h("ul", { class: "small muted" }, r.notes.map((n) => h("li", {}, n))),
  );
}

async function setGdpr(root) {
  const cand = await api("/compliance/gdpr/retention");
  put(root, 
    h("p", {}, "Export dat a anonymizaci jednotlivého zákazníka najdeš v jeho kartě v CRM."),
    h("h3", {}, "Retence"),
    h("p", { class: "small muted" }, "Automatická anonymizace se zapíná proměnnou RETENTION_YEARS. Kandidáti podle aktuálního nastavení:"),
    cand.length ? [h("ul", {}, cand.map((c) => h("li", {}, `#${c.id} ${c.email || ""} – poslední objednávka ${fmtDate(c.lastOrderAt)}`))),
      h("button", { class: "danger", onclick: () => confirm(`Anonymizovat ${cand.length} zákazníků? Nevratné.`) && act(() => api("/compliance/gdpr/retention", { method: "POST" }), null, (r) => (toast(`Anonymizováno ${r.anonymized.length}, přeskočeno ${r.skipped.length}`), rerender())) }, "Anonymizovat nyní")]
      : h("p", { class: "muted" }, "Žádní kandidáti (nebo je retence vypnutá)."),
  );
}

async function setAe(root) {
  put(root, 
    kv([["Propojeno", state.health.aliexpressAuthorized ? "ano" : "ne"], ["Zkušební režim", state.health.dryRun ? "ano – nic se neodesílá" : "ne"], ["Automatická platba", state.health.autoPay ? "zapnutá" : "vypnutá"]]),
    h("button", { class: "primary", onclick: connectAe }, state.health.aliexpressAuthorized ? "Propojit znovu" : "Propojit AliExpress"),
    h("p", { class: "small muted" }, "DRY_RUN a AUTO_PAY se mění v .env na serveru (záměrně ne tady)."),
  );
}

async function connectAe() {
  const r = await act(() => api("/ae/oauth-url"), null, null);
  if (r) window.open(r.url, "_blank", "noopener");
}

// ---------- navigace ----------

const VIEWS = { dashboard: viewDashboard, orders: viewOrders, products: viewProducts, crm: viewCrm, settings: viewSettings };

function go(tab, sub) {
  state.tab = tab;
  if (sub) state.sub[tab] = sub;
  closeModal();
  try { history.replaceState(null, "", `#${tab}${state.sub[tab] ? "/" + state.sub[tab] : ""}`); } catch { /* ignore */ }
  void rerender();
}

let renderSeq = 0;
async function rerender() {
  const seq = ++renderSeq;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === state.tab);
  const root = h("div");
  try {
    state.health = await fetch("/health").then((r) => r.json());
    $("#mode").textContent = state.health.dryRun ? "ZKUŠEBNÍ" : state.health.autoPay ? "OSTRÝ + platby" : "OSTRÝ";
    $("#mode").className = `badge ${state.health.dryRun ? "" : state.health.autoPay ? "err" : "warn"}`;
    await VIEWS[state.tab](root);
  } catch (e) {
    put(root, h("div", { class: "alert err" }, e.message));
  }
  if (seq === renderSeq) $("#view").replaceChildren(root);
}

async function loadShops() {
  state.shops = await api("/shops");
}

function logout() {
  setToken("");
  $("#view").hidden = $("#tabs").hidden = $("#logout").hidden = true;
  $("#login").hidden = false;
}

async function start() {
  $("#login").hidden = true;
  $("#view").hidden = $("#tabs").hidden = $("#logout").hidden = false;
  const [tab, sub] = location.hash.slice(1).split("/");
  if (VIEWS[tab]) state.tab = tab;
  if (sub) state.sub[state.tab] = sub;
  try {
    await loadShops();
  } catch (e) {
    return toast(e.message, true);
  }
  void rerender();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  setToken($("#token").value.trim());
  try {
    await api("/shops");
    $("#token").value = "";
    void start();
  } catch (err) {
    toast(err.message, true);
  }
});
$("#logout").addEventListener("click", logout);
// Odkaz typu …/app/#settings/ads otevřený v už načtené stránce.
window.addEventListener("hashchange", () => {
  const [tab, sub] = location.hash.slice(1).split("/");
  if (!VIEWS[tab] || !getToken()) return;
  const same = tab === state.tab && (sub || undefined) === (state.sub[tab] || undefined);
  if (!same) go(tab, sub);
});
for (const b of document.querySelectorAll("#tabs button")) b.addEventListener("click", () => go(b.dataset.tab));
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

if (getToken()) void start();
else logout();
