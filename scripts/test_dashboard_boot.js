/* Boot + dataset-flow smoke test.
 *
 * Loads charts.js, engine.js, analytics.js, predict.js, upload.js and ml.js
 * against a minimal DOM/canvas shim, then drives the Predict page with a
 * mocked backend and checks that the table it paints is exactly the backend
 * portfolio response (no browser-side price model).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error("  ✗ " + msg); fails++; }
  else console.log("  ✓ " + msg);
}

/* ---------- minimal DOM / canvas shim ---------- */
function makeCtx() {
  return new Proxy({
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "",
    globalAlpha: 1, setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() {}, closePath() {}, stroke() {}, fill() {}, fillRect() {}, rect() {}, arc() {},
    fillText() {}, setLineDash() {}, save() {}, restore() {}, translate() {},
    measureText(t) { return { width: String(t).length * 6 }; },
    createLinearGradient() { return { addColorStop() {} }; },
  }, { get(t, k) { return k in t ? t[k] : function () {}; }, set(t, k, v) { t[k] = v; return true; } });
}

function makeEl(tag) {
  return {
    tagName: tag || "div", children: [], style: {}, options: [], _value: "", textContent: "",
    disabled: false, className: "", checked: false, scrollTop: 0, scrollHeight: 0,
    _innerHTML: "", _parent: null, _qs: {}, _onchange: null, _onclick: null,
    classList: { add() {}, remove() {}, toggle() {} },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = String(v); },
    appendChild(c) { if (c) { c._parent = this; this.children.push(c); } return c; },
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } },
    add(o) { this.options.push(o); },
    addEventListener() {},
    focus() {}, click() {},
    get value() { return this.options.length ? String(this.options[0].value) : this._value; },
    set value(v) { this._value = String(v); },
    querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = makeEl("div"); return this._qs[sel]; },
    querySelectorAll() { return []; },
    closest() { if (!this._closestHost) this._closestHost = makeEl("div"); return this._closestHost; },
    setAttribute() {}, getAttribute() { return null; },
    insertAdjacentHTML(pos, html) { this._innerHTML += String(html); },
    getContext() { return makeCtx(); },
    get clientWidth() { return 320; },
    get clientHeight() { return 240; },
    width: 320, height: 240,
    set onchange(f) { this._onchange = f; }, get onchange() { return this._onchange; },
    set onclick(f) { this._onclick = f; }, get onclick() { return this._onclick; },
    set onkeydown(f) { this._onkeydown = f; }, get onkeydown() { return this._onkeydown; },
  };
}

const els = {};
const doc = {
  head: { appendChild() {} },
  body: makeEl("body"),
  documentElement: makeEl("html"),
  getElementById(id) { if (!els[id]) els[id] = makeEl("div"); return els[id]; },
  createElement(tag) {
    if (tag === "template") return { content: { firstChild: makeEl("div") } };
    return makeEl(tag);
  },
  addEventListener() {},
};
globalThis.Option = function (text, value) { this.text = text; this.value = value; };
globalThis.ResizeObserver = function () { return { observe() {}, disconnect() {} }; };
globalThis.URL = { createObjectURL() { return "blob:x"; }, revokeObjectURL() {} };
globalThis.Blob = function () {};
globalThis.FileReader = function () {};
const win = globalThis;

function load(file) {
  const src = fs.readFileSync(path.join(ROOT, "dashboard", file), "utf8");
  new Function("window", "document", "Option", src)(win, doc, globalThis.Option);
}

/* ---------- mocked backend (the values the table must show) ---------- */
const BACKEND_PORTFOLIO = {
  items: [
    { product: "A1", current_price: 20, recommended_price: 18.4, change_pct: -8, expected_demand: 6.1,
      expected_revenue: 112.24, expected_profit: 53.68, elasticity: -1.2, reliability: "High" },
    { product: "A2", current_price: 30, recommended_price: 33, change_pct: 10, expected_demand: 4.2,
      expected_revenue: 138.6, expected_profit: 44.1, elasticity: -0.7, reliability: "Low" },
  ],
  supported: 2, total: 2, note: null,
};
const BACKEND_RECOMMEND = {
  supports_optimization: true, reason: null, currency: "USD",
  current: { price: 20, estimated_demand: 5, estimated_revenue: 100, estimated_profit: 50 },
  optimal: { price: 18.4, estimated_demand: 6.1, estimated_revenue: 112.24, estimated_profit: 53.68,
    change_pct: -8, objective: "profit", profit_change_pct: 7.4 },
  demand_model: { kind: "product", r2: 0.42, n_obs: 200, elasticity: -1.2,
    elasticity_ci95: [-1.5, -0.9], elasticity_p_value: 0.001, controls: [] },
  reliability: { level: "High", score: null, max: null, reasons: ["R² 0.42."] },
  rules: [{ rule: "max-single-step-increase", applied: true, detail: "Capped at +20%." }],
  warnings: [],
  sensitivity: [
    { price_change_pct: -10, price: 16.56, demand: 7.2, revenue: 119.2, profit: 61.2, profit_change_pct: 14.0 },
    { price_change_pct: -5, price: 17.48, demand: 6.6, revenue: 115.4, profit: 57.1, profit_change_pct: 6.4 },
    { price_change_pct: 0, price: 18.4, demand: 6.1, revenue: 112.24, profit: 53.68, profit_change_pct: 0 },
    { price_change_pct: 5, price: 19.32, demand: 5.6, revenue: 108.2, profit: 50.0, profit_change_pct: -6.9 },
    { price_change_pct: 10, price: 20.24, demand: 5.2, revenue: 105.2, profit: 46.8, profit_change_pct: -12.8 },
  ],
  candidates: Array.from({ length: 400 }, function (_, i) {
    var p = 16 + i * 0.01;
    return { price: p, estimated_demand: 6.2 - i * 0.004, estimated_revenue: p * (6.2 - i * 0.004) };
  }),
  reasons: [{ icon: "↘", tone: "down", text: "Lower price raises demand." }],
  caveat: "Statistical estimate from the uploaded history.",
};

const calls = [];
win.PricingApi = {
  api: function (route, body) {
    calls.push({ route: route, body: body });
    if (route === "/api/pricing/portfolio") return Promise.resolve(BACKEND_PORTFOLIO);
    if (route === "/api/pricing/recommend") return Promise.resolve(BACKEND_RECOMMEND);
    return Promise.resolve({});
  },
};

(async () => {
  load("charts.js");
  load("engine.js");
  load("analytics.js");
  load("predict.js");
  load("upload.js");
  load("ml.js");

  assert(typeof win.PricingCharts === "object" && typeof win.PricingCharts.Chart === "function", "PricingCharts.Chart defined");
  assert(typeof win.PricingCharts.color === "function", "chart colours resolved from tokens (color())");
  assert(typeof win.PricingData === "object" && typeof win.PricingData.analytics === "function", "PricingData defined");
  assert(typeof win.PricingData.setCurrency === "function" && typeof win.PricingData.fmtMoney === "function", "currency API exposed (setCurrency/fmtMoney)");

  let bootErr = null;
  try { win.PricingAnalytics.mount(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingAnalytics.mount() boots without throwing" + (bootErr ? " — " + bootErr.message : ""));
  assert(els["px-root"].children.length > 0, "analytics panel rendered into #px-root");
  assert(win.PricingData.analytics() === null, "no analytics until a dataset is uploaded");
  assert(win.PricingData.source() === "", "engine starts empty (no demo data)");
  assert(win.PricingML && typeof win.PricingML.render === "function", "PricingML module exposes render()");
  assert(typeof win.PricingML.renderPrice === "undefined", "ML price panel removed (Predict owns it)");
  win.PricingML.render();
  assert(doc.getElementById("ml-steps").innerHTML === "", "ML pipeline stepper empty before upload");
  assert(doc.getElementById("ml-root").innerHTML.indexOf("Upload a CSV dataset") >= 0, "ML pipeline shows upload empty state");
  assert(els["px-content"].children.length > 0, "analytics panel shows an empty state without data");

  /* ---------- Predict page: dataset-only ---------- */
  bootErr = null;
  try { win.PricingPredict.mount(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingPredict.mount() boots without throwing" + (bootErr ? " — " + bootErr.message : ""));
  assert(els["predict-root"].children.length > 0, "prediction center rendered into #predict-root");
  assert(win.PricingPredict.getMode() === "dataset", "prediction center is dataset-only");
  assert(typeof win.PricingPredict.setMode === "undefined", "no manual-mode switch remains");
  assert(els["pp-content"].innerHTML.indexOf("No dataset loaded") >= 0, "Predict shows the upload empty state");

  /* upload a tiny dataset (parsing stays in the browser) */
  const P = win.PricingData;
  const csv = "product,order_date,selling_price,qty\nA1,2026-03-01,20,5\nA2,2026-03-02,30,7";
  const parsed = P.parseCSV(csv);
  const mapping = P.suggestMapping(parsed.headers);
  const norm = P.normalizeRows(parsed.rows, mapping);
  P.applyUpload(norm.rows, { fileName: "t.csv" });
  assert(P.active(), "uploaded dataset active after applyUpload");
  const a = P.analytics();
  assert(a.records === 2 && a.products === 2, "analytics reflects uploaded rows (" + a.records + "/" + a.products + ")");

  /* the backend answers with the portfolio + detail */
  win.PricingBackend = {
    profile: { rows: 2, duplicates: 0, suggested_target: "units_sold",
      quality: { score: 88, label: "Excellent", issues: [] } },
    train: { best: { name: "Random Forest", r2: 0.61, mae: 3.2, rmse: 4.1 },
      time_split: { r2: 0.54, note: "last 20% held out" } },
    datasetId: "abc123", fileName: "t.csv", offline: false,
  };

  win.PricingPredict.render();
  await new Promise((r) => setTimeout(r, 80));

  const html = els["pp-content"].innerHTML;
  assert(calls.some((c) => c.route === "/api/pricing/portfolio"), "portfolio endpoint called");
  assert(calls.some((c) => c.route === "/api/pricing/recommend"), "recommend endpoint called for the detail panel");

  // every recommended price in the backend response is in the table
  const money = (v) => P.fmtMoney(v, 2);
  assert(html.indexOf(money(BACKEND_PORTFOLIO.items[0].recommended_price)) >= 0,
    "table shows backend recommended price for A1 (" + money(BACKEND_PORTFOLIO.items[0].recommended_price) + ")");
  assert(html.indexOf(money(BACKEND_PORTFOLIO.items[1].recommended_price)) >= 0,
    "table shows backend recommended price for A2 (" + money(BACKEND_PORTFOLIO.items[1].recommended_price) + ")");
  assert(html.indexOf("High") >= 0 && html.indexOf("Low") >= 0, "reliability labels come from the backend");
  assert(html.indexOf("Random Forest") >= 0, "model card names the backend champion");
  assert(html.indexOf("54") >= 0 || html.indexOf("0.54") >= 0, "time-split R² reported");

  // the detail panel uses the backend recommend response
  assert(html.indexOf("Why this price") >= 0, "detail panel explains the recommendation");
  assert(html.indexOf("Sensitivity") >= 0, "detail panel includes the sensitivity table");
  assert(html.indexOf("max-single-step-increase") >= 0, "applied business rules listed");
  assert(html.indexOf(money(BACKEND_RECOMMEND.sensitivity[0].price)) >= 0, "sensitivity rows painted");

  // no manual-mode strings survive anywhere in the rendered page
  assert(html.indexOf("Manual Mode") === -1 && html.indexOf("Predict Price") === -1, "no manual-mode UI remains");

  /* backend offline: clear message, no fallback numbers */
  win.PricingBackend = { profile: null, train: null, datasetId: null, fileName: "t.csv", offline: true };
  win.PricingPredict.render();
  await new Promise((r) => setTimeout(r, 30));
  const offlineHtml = els["pp-content"].innerHTML;
  assert(offlineHtml.indexOf("Backend unavailable") >= 0 || offlineHtml.indexOf("could not be sent") >= 0,
    "offline dataset shows a backend error, not fake prices");
  assert(offlineHtml.indexOf("Retry") >= 0 || offlineHtml.indexOf("could not be sent") >= 0,
    "offline state offers a way forward");

  /* upload UI wiring */
  bootErr = null;
  try { win.PricingUI.boot(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingUI.boot() boots without throwing" + (bootErr ? " — " + bootErr.message : ""));
  assert(typeof els["data-source"].onclick === "function", "Upload Dataset button wired");
  assert(typeof win.PricingUI.openModal === "function", "PricingUI.openModal exposes the upload flow");

  /* currency: INR lakh formatting + exchange rate */
  const cur = P.setCurrency("INR", 83);
  assert(cur.code === "INR" && cur.symbol === "₹" && cur.rate === 83, "setCurrency switches to INR with custom rate");
  assert(P.fmtMoney(125000, 0) === "₹1,03,75,000", "INR formats lakh grouping");
  P.setCurrency("USD", 1);
  assert(P.fmtMoney(49.99, 2) === "$49.99", "USD formats with $ symbol");

  /* dataset report */
  const report = P.report();
  assert(typeof report.size === "number" && typeof report.duplicates === "number", "report exposes size + duplicates");
  assert(report.stats && report.stats.price && report.stats.price.min >= 0, "report exposes basic statistics");

  /* upload.js refresh wiring */
  let refreshed = false;
  win.PricingAnalytics.render = function () { refreshed = true; };
  try { win.PricingUI.refreshEverything(); } catch (e) { console.error("refresh threw:", e); }
  assert(refreshed, "refreshEverything() calls PricingAnalytics.render");

  process.exit(fails ? 1 : 0);
})();
