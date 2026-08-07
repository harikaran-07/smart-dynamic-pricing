/* Node harness that verifies:
 *  1. the inline demoAPI (extracted from dashboard/index.html) serves the new
 *     assistant endpoints (products/detail, customers/detail, insights, manual);
 *  2. the AICore engine returns well-formed 5-part answers for many intents.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { AICore } = require(path.join(__dirname, "..", "dashboard", "assistant.js"));
const ROOT = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(ROOT, "dashboard", "index.html"), "utf8");

let fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error("  ✗ " + msg); fails++; }
  else console.log("  ✓ " + msg);
}

// ---- extract the inline script (before assistant.js tag) --------------
const start = indexHtml.indexOf("<script>") + "<script>".length;
const end = indexHtml.indexOf("</script>", start);
let inline = indexHtml.slice(start, end);
inline = inline.replace(/^\s*init\(\);\s*health\(\);\s*$/m, ""); // don't run DOM boot

// ---- build a sandbox with the constants/functions we need -------------
const elProxy = new Proxy({}, {
  get(t, p) { if (typeof p === "string" && p !== "then") return () => ({}); return undefined; },
  set() { return true; },
  has() { return true; },
});
globalThis.document = {
  getElementById: () => elProxy, querySelector: () => elProxy, createElement: () => elProxy,
  head: { appendChild: () => {} }, addEventListener: () => {}, body: elProxy,
};
globalThis.window = globalThis;
const sandbox = {};
const fn = new Function(
  "module",
  inline + "\n;globalThis.__demo = { DEMO_PRODUCTS, DEMO_CUSTOMERS, demoApi, demoProduct, demoCustomer, mulberry, clamp };"
);
fn(sandbox);
const D = globalThis.__demo;

// ---- 1. new demo endpoints ---------------------------------------------
(async () => {
  console.log("demo endpoints (products/detail, customers/detail, insights, manual)");
  const pd = await D.demoApi("/api/products/detail");
  assert(Array.isArray(pd) && pd.length && pd[0].base_price > 0 && pd[0].cost > 0, "products/detail returns product rows");
  const cd = await D.demoApi("/api/customers/detail");
  assert(Array.isArray(cd) && cd.every(c => c.segment_label && c.loyalty_tier), "customers/detail returns segments");
  const ins = await D.demoApi("/api/insights");
  assert(ins.top_profit && ins.top_profit.length && ins.monthly_sales && ins.best_month, "insights aggregates present");
  assert(ins.low_stock && ins.overstock && Array.isArray(ins.inventory), "insights inventory flags present");
  const man = await D.demoApi("/api/manual", { price: 49.99, cost: 22, inventory: 50, demand_pressure: 0.5 });
  assert(man.current && man.current.revenue > 0 && man.current.price > 0, "manual returns current scenario");
  assert(man.optimal && man.optimal.recommended_price > 0 && typeof man.optimal.price_delta_pct === "number", "manual returns optimal");
  assert(Array.isArray(man.discount_grid) && man.discount_grid.length === 5 && man.discount_grid.every(x => x.discount != null), "manual discount_grid has 5 entries");
  assert(Array.isArray(man.feature_impacts) && man.feature_impacts.length >= 3, "manual feature impacts present");
  assert(Array.isArray(man.reasons) && man.reasons.length >= 3 && man.reasons.every(r => r.text && r.tone), "demo manual returns dynamic reasons");
  assert(man.model && man.model.name && typeof man.model.r2 === "number", "demo manual reports the model used");
  assert(Number.isInteger(man.confidence_pct) && man.confidence_pct >= 0, "manual confidence_pct is an integer");
})();

// ---- 2. AICore engine ----------------------------------------------------
const fakeD = {
  currency: "$",
  products: [
    { product_id: "P001", base_price: 146.9, cost: 63.24, category: "Electronics" },
    { product_id: "P010", base_price: 120.0, cost: 58.0, category: "Home & Kitchen" },
    { product_id: "P015", base_price: 49.9, cost: 23.0, category: "Sports" },
  ],
  customers: [{ customer_id: "c-001", loyalty_score: 88, purchase_count: 34, avg_sales: 8.9, segment_label: "Premium", loyalty_tier: "Gold" }],
  overview: { model_backbone: "xgboost", model_metrics: { models: { linear: { r2: .54 }, xgboost: { r2: .668 } } } },
  insights: {
    product_count: 3,
    top_profit: [{ product_id: "P001", profit: 48000 }],
    top_revenue: [{ product_id: "P001", revenue: 90000 }],
    best_revenue_category: { name: "Electronics", revenue: 90000 },
    best_profit_category: { name: "Electronics", profit: 48000 },
    monthly_sales: { 1: 100, 9: 200, 10: 400, 11: 500, 12: 300 },
    best_month: 11, weekday_units: 31.4, weekend_units: 40.7,
    inventory: [{ product_id: "P001", inventory: 5, avg_daily: 30, days_left: 0.16 }],
    low_stock: [{ product_id: "P001", inventory: 5, avg_daily: 30, days_left: 0.16 }],
    overstock: [{ product_id: "P002", inventory: 400, avg_daily: 3, days_left: 133 }],
    segments: { Regular: 1, Loyal: 1, "Bargain seeker": 1, Premium: 1 },
    trend_products: { P001: 214 },
  },
  price: async (r) => ({ product_id: r.product_id, recommended_price: 130.5, cost: 58, expected_demand: 34.5, expected_revenue: 4502.25, competitor_price: 120, inventory: 50 }),
  rl: async () => ({ action_index: 2, action_multiplier: 1.0, price: 120, product_state: { inventory: 50, demand_pressure: 0.5, competitor_gap: 0.08 }, q_values: [9000,12000,15000,11000,8000], learning_steps: 2000 }),
  manual: async (f) => { const d = f.discount_pct || 0; const eff = f.price * (1 - d / 100); return {
    input: f, current: { price: eff, demand: 30, revenue: eff * 30, profit: (eff - f.cost) * 30, margin_pct: 55 },
    optimal: { recommended_price: eff * .95, demand: 32, revenue: eff * .95 * 32, profit: (eff * .95 - f.cost) * 32, price_delta_pct: -5 },
    discount_grid: [], feature_impacts: [{ feature: "price", impact_pct: -6 }, { feature: "weekend", impact_pct: 8 }], confidence_pct: 70 } },
  negotiate: async () => ({}),
  sales: async () => ({ dates: [], units_sold: [28,30,32,34,36,38,40] }),
  explain: async () => ({ top_features: ["is_weekend", "units_roll7", "seasonal_factor"] }),
};

(async () => {
  console.log("== AICore engine (5-part responses) ==");
  const checks = [
    "Why is P010 priced at 800?",
    "Should I increase the price?",
    "Forecast next 30 days",
    "Which products need discounts?",
    "Which products are running out of stock?",
    "Which segment should get discounts?",
    "Which month performs best?",
    "Why did the RL agent recommend this action?",
    "Which model performs best?",
    "Best product to promote",
    "What if inventory drops to 20?",
  ];
  for (const q of checks) {
    const r = await AICore.answer(q, "dataset", { pid: "P001" }, fakeD);
    const ok = r.answer && r.reasoning && r.businessImpact && r.action && typeof r.confidencePct === "number" && r.confidence;
    assert(ok, `intent "${r.intent}" replies for: "${q}"`);
    if (!ok) console.error(JSON.stringify(r, null, 2).slice(0, 400));
  }
  const comp = await AICore.answer("Compare P010 with P015", "dataset", {}, fakeD);
  assert(comp.intent === "compare" && /P010/.test(comp.answer) && /P015/.test(comp.answer), "compare two products");
  const manual = await AICore.answer("Recommend the best price for maximum profit", "manual",
    { manual: { price: 49.99, cost: 22, inventory: 50, demand_pressure: 0.5, competitor: 55 } }, fakeD);
  assert(manual.intent === "manual_predict" && manual.answer && manual.confidencePct === 70, "manual predict reply");
  const whatif = await AICore.answer("What if inventory drops to 20?", "dataset", {}, fakeD);
  assert(whatif.intent === "whatif" && /profit|demand/i.test(whatif.answer), "what-if scenario reply");
})();

// ---- 3. browser bootstrap: run assistant.js's UI IIFE against a DOM shim --
(async () => {
  console.log("== assistant.js browser bootstrap (DOM shim) ==");
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  class El {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.style = {}; this.options = [];
      this._innerHTML = ""; this.onclick = null; this.onchange = null; this.onkeydown = null;
      this.value = ""; this.textContent = ""; this.disabled = false; this.className = "";
      this.checked = false; this.scrollTop = 0; this.scrollHeight = 0;
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) { this._innerHTML = String(v); }
    appendChild(c) { if (c) { c._parent = this; this.children.push(c); } return c; }
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } }
    add(o) { this.options.push(o); }
    focus() {}
    closest(sel) {
      const cls = String(this.className || "").split(/\s+/);
      return cls.includes(sel.replace(/^\./, "")) ? this : null;
    }
    addEventListener() {}
  }
  const els = {};
  const doc = {
    head: { appendChild() {} },
    getElementById(id) { if (!els[id]) els[id] = new El("div"); return els[id]; },
    createElement(t) { return new El(t); },
    addEventListener() {},
    querySelector() { return new El("div"); },
    body: new El("body"),
  };
  const Option = function (text, value) { this.text = text; this.value = value; };

  // api shim backed by the demo endpoints extracted from index.html
  const apiShim = async (path, body) => D.demoApi(path, body);

  // run assistant.js in a fresh scope where the IIFE bootstraps
  const src = fs.readFileSync(path.join(ROOT, "dashboard", "assistant.js"), "utf8");
  let bootError = null;
  try {
    new Function("document", "window", "api", "Option", src)(doc, {}, apiShim, Option);
  } catch (e) {
    bootError = e;
  }
  assert(!bootError, "assistant.js IIFE bootstraps without throwing" + (bootError ? " — " + bootError.message : ""));

  await sleep(60); // let init() buildD + welcome message resolve

  assert(typeof els["ai-tab-manual"].onclick === "function", "Manual tab handler attached");
  assert(typeof els["ai-tab-dataset"].onclick === "function", "Dataset tab handler attached");
  assert(typeof els["ai-send"].onclick === "function", "Send handler attached");
  assert(typeof els["ai-predict"].onclick === "function", "Predict handler attached");
  assert(typeof els["ai-ds-chips"].onclick === "function", "Chips handler attached");
  assert(els["ai-chat"].children.length >= 1, "welcome message rendered (" + els["ai-chat"].children.length + " msgs)");
  assert(els["m-category"].options.length > 0, "manual category populated (" + els["m-category"].options.length + " cats)");
  assert(els["m-month"].options.length === 12, "manual month populated (12)");

  // switch to Manual mode
  els["ai-tab-manual"].onclick();
  assert(els["ai-pane-manual"].style.display === "" && els["ai-pane-dataset"].style.display === "none",
    "switching to Manual mode shows the manual pane");

  // dataset question through the chat
  const before = els["ai-chat"].children.length;
  els["ai-input"].value = "Forecast next 30 days";
  els["ai-send"].onclick();
  await sleep(60);
  const bots = els["ai-chat"].children.filter(m => String(m.className).includes("bot"));
  const bot = bots[bots.length - 1];
  if (!(els["ai-chat"].children.length > before && bot && /Reasoning|Answer/.test(bot.innerHTML))) {
    console.error("  [debug] chat children:\n" + els["ai-chat"].children.map(c => String(c.className) + " :: " + String(c.innerHTML).slice(0, 90)).join("\n"));
  }
  assert(els["ai-chat"].children.length > before && bot && /Reasoning|Answer/.test(bot.innerHTML),
    "dataset chat question produces a 5-part bot reply");

  // manual predict
  doc.getElementById("m-price").value = "49.99"; doc.getElementById("m-cost").value = "22";
  doc.getElementById("m-inv").value = "50"; doc.getElementById("m-comp").value = "55";
  doc.getElementById("m-pressure").value = "0.5";
  const n0 = els["ai-chat"].children.length;
  els["ai-predict"].onclick();
  await sleep(60);
  const bots2 = els["ai-chat"].children.filter(m => String(m.className).includes("bot"));
  const last = bots2[bots2.length - 1];
  assert(els["ai-chat"].children.length > n0 && /Answer|Reasoning/.test(String(last.innerHTML)),
    "Manual predict posts a structured reply");

  process.exit(fails ? 1 : 0);
})();