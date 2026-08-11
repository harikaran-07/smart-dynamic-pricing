/* Boot smoke test: loads charts.js, engine.js, analytics.js, upload.js and
 * assistant.js against a minimal DOM/canvas shim and verifies the dashboard
 * analytics + upload modules mount without throwing, then that an upload flow
 * (parse -> map -> normalize -> applyUpload) refreshes everything end-to-end.
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

// read + evaluate scripts in order in the shared global scope
function load(file) {
  const src = fs.readFileSync(path.join(ROOT, "dashboard", file), "utf8");
  new Function("window", "document", "Option", src)(win, doc, globalThis.Option);
}

(async () => {
  load("charts.js");
  load("engine.js");
  load("analytics.js");
  load("predict.js");
  load("upload.js");
  load("ml.js");

  assert(typeof win.PricingCharts === "object" && typeof win.PricingCharts.Chart === "function", "PricingCharts.Chart defined");
  assert(typeof win.PricingData === "object" && typeof win.PricingData.analytics === "function", "PricingData defined");
  assert(typeof win.PricingData.setCurrency === "function" && typeof win.PricingData.fmtMoney === "function", "currency API exposed (setCurrency/fmtMoney)");

  let bootErr = null;
  try { win.PricingAnalytics.mount(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingAnalytics.mount() boots without throwing" + (bootErr ? " — " + bootErr.message : ""));
  assert(els["px-root"].children.length > 0, "analytics panel rendered into #px-root");
  assert(win.PricingData.analytics() !== null, "analytics available immediately in Demo Mode");
  assert(win.PricingData.source() === "demo", "engine defaults to Demo Mode");
  assert(win.PricingML && typeof win.PricingML.render === "function", "PricingML module exposes render()");
  win.PricingML.render();
  assert(doc.getElementById("ml-steps").innerHTML.indexOf("ml-step") >= 0, "ML pipeline stepper rendered");
  assert(doc.getElementById("ml-root").children.length > 0, "ML pipeline panels rendered for demo mode");
  win.PricingML.renderPrice();
  assert(doc.getElementById("ml-price-root").children.length > 0, "ML price panel rendered for demo mode");
  assert(els["px-content"].children.length > 0, "analytics panel shows an empty state without data");

  bootErr = null;
  try { win.PricingPredict.mount(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingPredict.mount() boots without throwing" + (bootErr ? " — " + bootErr.message : ""));
  assert(els["predict-root"].children.length > 0, "prediction center rendered into #predict-root");
  assert(typeof win.PricingPredict.getMode === "function" && win.PricingPredict.getMode() === "dataset", "prediction center defaults to Dataset Mode");

  bootErr = null;
  try { win.PricingPredict.setMode("manual"); win.PricingPredict.render(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingPredict Manual Mode renders without throwing" + (bootErr ? " — " + bootErr.message : ""));
  bootErr = null;
  try { win.PricingPredict.setMode("dataset"); win.PricingPredict.render(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingPredict back to Dataset Mode renders" + (bootErr ? " — " + bootErr.message : ""));

  bootErr = null;
  try { win.PricingUI.boot(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingUI.boot() boots without throwing" + (bootErr ? " — " + bootErr.message : ""));
  assert(typeof els["data-source"].onclick === "function", "Upload Dataset button wired");

  // switch tabs through the analytics panel
  const tabs = [];
  try {
    const panel = els["px-root"].children[0];
    tabs.length; // (shim children are generic)
  } catch (_) {}

  // upload flow end-to-end (parse -> map -> normalize -> applyUpload)
  const P = win.PricingData;
  const csv = "product,order_date,selling_price,qty\nA1,2026-03-01,20,5\nA2,2026-03-02,30,7";
  const parsed = P.parseCSV(csv);
  const mapping = P.suggestMapping(parsed.headers);
  const norm = P.normalizeRows(parsed.rows, mapping);
  P.applyUpload(norm.rows, { fileName: "t.csv" });
  assert(P.active(), "uploaded dataset active after applyUpload");
  const a = P.analytics();
  assert(a.records === 2 && a.products === 2, "analytics reflects uploaded rows (" + a.records + "/" + a.products + ")");
  assert(win.PricingData.assistantBundle() && win.PricingData.assistantBundle().products.length === 2, "assistant bundle built from uploaded data");
  assert(/A1/.test(P.insightText(a)), "AI summary mentions uploaded product");

  // currency: INR lakh formatting + exchange rate
  const cur = P.setCurrency("INR", 83);
  assert(cur.code === "INR" && cur.symbol === "₹" && cur.rate === 83, "setCurrency switches to INR with custom rate");
  assert(P.fmtMoney(125000, 0) === "₹1,03,75,000", "INR formats lakh grouping (₹1,03,75,000 for 125000 USD)");
  assert(/₹/.test(P.fmtMoney(49.99, 2)), "INR symbol appears in fmtMoney");
  P.setCurrency("USD", 1);
  assert(P.fmtMoney(49.99, 2) === "$49.99", "USD formats with $ symbol");

  // new dataset analytics functions
  const report = P.report();
  assert(typeof report.size === "number" && typeof report.duplicates === "number", "report exposes size + duplicates");
  assert(report.stats && report.stats.price && report.stats.price.min >= 0, "report exposes basic statistics (min/max/avg)");
  assert(Array.isArray(report.preview) && report.preview.length >= 1, "report includes a dataset preview");

  const reasons = P.recommendReasons(P.analytics().productList[0], { inventory: 50, demand_pressure: 0.5 });
  assert(Array.isArray(reasons.reasons) && reasons.reasons.length >= 3, "recommendReasons returns dynamic explanations");
  assert(typeof reasons.recommended_price === "number" && typeof reasons.delta_pct === "number", "recommendReasons returns price + delta");

  const predTable = P.predictionTable();
  assert(Array.isArray(predTable) && predTable.length === a.products, "predictionTable returns one row per product");
  assert(predTable[0].recommended_price > 0 && predTable[0].price_change_pct !== undefined, "prediction rows carry recommended price + change");

  // upload.js refreshEverything wiring
  let refreshed = false;
  win.PricingAnalytics.render = function () { refreshed = true; };
  try { win.PricingUI.refreshEverything(); } catch (e) { console.error("refresh threw:", e); }
  assert(refreshed, "refreshEverything() calls PricingAnalytics.render");

  // ---- ML upload-mode panels (backend-shaped state + stubbed fetch) ----
  const fetchCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = function (url) {
    fetchCalls.push(String(url));
    const u = String(url);
    let body;
    if (u.indexOf("/api/pricing/portfolio") >= 0) {
      body = { items: [
        { product: "A1", current_price: 20, recommended_price: 18, change_pct: -10, expected_demand: 6,
          expected_revenue: 108, expected_profit: 36, elasticity: -1.2, reliability: "High" },
        { product: "A2", current_price: 30, recommended_price: 33, change_pct: 10, expected_demand: 4,
          expected_revenue: 132, expected_profit: 44, elasticity: -1.5, reliability: "Medium" } ] };
    } else if (u.indexOf("/api/pricing/recommend") >= 0) {
      body = {
        supports_optimization: true, currency: "USD",
        current: { price: 20, estimated_demand: 5 },
        optimal: { price: 18, estimated_demand: 6, estimated_revenue: 108, estimated_profit: 36,
          change_pct: -10, objective: "revenue" },
        demand_model: { kind: "pooled", r2: 0.5, n_obs: 200, elasticity: -1.2 },
        reliability: { level: "High", score: 7, max: 9, reasons: ["Solid history: 200 rows.", "Good demand fit."] },
        rules: [{ rule: "max-single-step-increase", applied: true, detail: "Sweep capped at +20%." }],
        reasons: [{ icon: "\u2192", text: "Lower price raises demand." }],
        caveat: "ML-based estimate.",
      };
    } else {
      body = {
        rows: [
          { product_id: "A1", price: 20, units_sold: 5, order_date: "2026-03-01" },
          { product_id: "A1", price: 30, units_sold: 7, order_date: "2026-03-02" },
          { product_id: "A2", price: 25, units_sold: 6, order_date: "2026-03-01" },
        ],
        pricing_columns: { price: "price", units: "units_sold", group: "product_id" },
      };
    }
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } });
  };

  const fakeProfile = {
    rows: 200, total_missing: 3, duplicates: 1, suggested_target: "units_sold", dataset_id: "abc123",
    quality: { score: 92, label: "Excellent", issues: ["2 missing values", "1 duplicate row"] },
  };
  const fakeTrain = {
    best: { name: "Random Forest", r2: 0.61, mae: 3.2, rmse: 4.1 },
    metrics_explained: { r2: "r2 explained", mae: "mae explained", rmse: "rmse explained" },
    dataset: { rows: 200, features: 12, target: "units_sold" },
    models: [
      { name: "Linear Regression", r2: 0.5, mae: 3.4, rmse: 4.5, cv_r2_mean: 0.48, cv_r2_std: 0.02 },
      { name: "Random Forest", r2: 0.61, mae: 3.2, rmse: 4.1, cv_r2_mean: 0.6, cv_r2_std: 0.03 },
      { name: "Gradient Boosting", r2: 0.6, mae: 3.3, rmse: 4.2, cv_r2_mean: 0.59, cv_r2_std: 0.03 },
      { name: "XGBoost", r2: 0.59, mae: 3.35, rmse: 4.25, cv_r2_mean: 0.58, cv_r2_std: 0.04 },
    ],
    feature_importance: [{ feature: "price", importance: 0.5 }],
    test_predictions: [{ actual: 10, predicted: 9.2 }],
    predictions_table: [{ product_id: "A1", actual: 5, predicted: 4.8 }],
  };
  win.PricingBackend = { profile: fakeProfile, train: fakeTrain, datasetId: "abc123", fileName: "t.csv", offline: false };

  bootErr = null;
  try { win.PricingML.render(); } catch (e) { bootErr = e; }
  assert(!bootErr, "ML upload-mode panels render without throwing" + (bootErr ? " \u2014 " + bootErr.message : ""));
  const upHost = doc.getElementById("ml-root").children[doc.getElementById("ml-root").children.length - 1];
  assert(upHost.innerHTML.indexOf("Dataset quality") >= 0, "quality card rendered in upload mode");
  assert(upHost.innerHTML.indexOf("Model comparison") >= 0, "model comparison table rendered in upload mode");
  assert(upHost.innerHTML.indexOf("Portfolio") >= 0, "portfolio section present in upload mode");
  await new Promise(r => setTimeout(r, 80));
  assert(fetchCalls.some(u => u.indexOf("/api/pricing/portfolio") >= 0), "portfolio endpoint fetched");
  assert(fetchCalls.some(u => u.indexOf("/api/dataset/sample") >= 0), "sample endpoint fetched");
  const portWrap = upHost._qs["#ml-up-portfolio-wrap"];
  const portHtml = portWrap.innerHTML;
  assert(portHtml.indexOf("<table") >= 0 && portHtml.indexOf("Reliability") >= 0 && portHtml.indexOf("High") >= 0,
    "portfolio table populated from backend data");
  assert(win.__mlCharts && win.__mlCharts["ml-up-portfolio"], "portfolio chart (current vs recommended) drawn");
  const dataWrap = upHost._qs["#ml-up-data-wrap"];
  assert(dataWrap.innerHTML.indexOf("Demand vs price") >= 0, "demand-vs-price chart populated from sample data");
  assert(dataWrap.innerHTML.indexOf("ml-up-trend-prod") >= 0, "trend product selector populated");

  bootErr = null;
  try { win.PricingML.renderPrice(); } catch (e) { bootErr = e; }
  assert(!bootErr, "ML upload price panel renders without throwing" + (bootErr ? " \u2014 " + bootErr.message : ""));
  const priceHost = doc.getElementById("ml-price-root").children[doc.getElementById("ml-price-root").children.length - 1];
  const runBtn = priceHost._qs["#ml-up-price-run"];
  bootErr = null;
  try { runBtn._onclick(); } catch (e) { bootErr = e; }
  await new Promise(r => setTimeout(r, 40));
  assert(!bootErr, "upload price recommendation click does not throw" + (bootErr ? " \u2014 " + bootErr.message : ""));
  const out = priceHost._qs["#ml-up-price-out"];
  const outHtml = out.children.map(c => c.innerHTML).join(" ") + out.innerHTML;
  assert(outHtml.indexOf("Estimated profit") >= 0 && outHtml.indexOf("Reliability") >= 0,
    "price panel shows estimated profit + reliability badge");
  assert(out.innerHTML.indexOf("Business rules applied") >= 0, "price panel lists applied business rules");

  win.PricingBackend = { profile: null, train: null, datasetId: null, fileName: "t.csv", offline: true };
  bootErr = null;
  try { win.PricingML.render(); } catch (e) { bootErr = e; }
  assert(!bootErr, "ML offline fallback renders without throwing" + (bootErr ? " \u2014 " + bootErr.message : ""));
  globalThis.fetch = realFetch;

  process.exit(fails ? 1 : 0);
})();
