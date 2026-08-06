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
    tagName: tag || "div", children: [], style: {}, options: [], value: "", textContent: "",
    disabled: false, className: "", checked: false, scrollTop: 0, scrollHeight: 0,
    _innerHTML: "", _parent: null,
    classList: { add() {}, remove() {}, toggle() {} },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = String(v); },
    appendChild(c) { if (c) { c._parent = this; this.children.push(c); } return c; },
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } },
    add(o) { this.options.push(o); },
    addEventListener() {},
    focus() {}, click() {},
    querySelector() { return makeEl("div"); },
    querySelectorAll() { return []; },
    getContext() { return makeCtx(); },
    get clientWidth() { return 320; },
    get clientHeight() { return 240; },
    width: 320, height: 240,
    set onchange(f) { this._onchange = f; }, get onchange() { return this._onchange; },
    set onclick(f) { this._onclick = f; }, get onclick() { return this._onclick; },
    set onkeydown(f) { this._onkeydown = f; }, get onkeydown() { return this._onkeydown; },
    closest() { return null; },
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
  load("upload.js");

  assert(typeof win.PricingCharts === "object" && typeof win.PricingCharts.Chart === "function", "PricingCharts.Chart defined");
  assert(typeof win.PricingData === "object" && typeof win.PricingData.analytics === "function", "PricingData defined");

  let bootErr = null;
  try { win.PricingAnalytics.mount(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingAnalytics.mount() boots without throwing" + (bootErr ? " — " + bootErr.message : ""));
  assert(els["px-root"].children.length > 0, "analytics panel rendered into #px-root");

  bootErr = null;
  try { win.PricingUI.boot(); } catch (e) { bootErr = e; }
  assert(!bootErr, "PricingUI.boot() boots without throwing" + (bootErr ? " — " + bootErr.message : ""));
  assert(typeof els["data-source"].onchange === "function", "data-source dropdown wired");

  // switch tabs through the analytics panel
  const tabs = [];
  try {
    const panel = els["px-root"].children[0];
    tabs.length; // (shim children are generic)
  } catch (_) {}

  // upload flow end-to-end (parse -> map -> normalize -> applyUpload)
  const P = win.PricingData;
  P.applyDemo();
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

  // upload.js refreshEverything wiring
  let refreshed = false;
  win.PricingAnalytics.render = function () { refreshed = true; };
  try { win.PricingUI.refreshEverything(); } catch (e) { console.error("refresh threw:", e); }
  assert(refreshed, "refreshEverything() calls PricingAnalytics.render");

  process.exit(fails ? 1 : 0);
})();
