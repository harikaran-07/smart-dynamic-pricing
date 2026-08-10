/* Live smoke test: fetch the deployed dashboard assets from GitHub Pages
 * and boot them against the same DOM/canvas shim used by test_dashboard_boot.
 * Verifies Demo Mode boots in production and renders the ML Pipeline panels.
 */
"use strict";
const ROOT = "https://harikaran-07.github.io/smart-dynamic-pricing/";

let fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error("  ✗ " + msg); fails++; }
  else console.log("  ✓ " + msg);
}

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
    closest() { return null; },
  };
}

const els = {};
const doc = {
  head: { appendChild() {} },
  body: makeEl("body"),
  getElementById(id) { if (!els[id]) els[id] = makeEl("div"); return els[id]; },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {},
};
globalThis.Option = function (text, value) { this.text = text; this.value = value; };
globalThis.ResizeObserver = function () { return { observe() {}, disconnect() {} }; };
globalThis.Blob = function () {};
globalThis.FileReader = function () {};
const win = globalThis;

/* NOTE: globalThis.URL stays intact while downloading (Node's fetch needs
 * the real URL class); the blob-URL shim is installed right before eval. */
let URLShim = null;
function installURLShim() {
  if (URLShim) return;
  URLShim = { createObjectURL() { return "blob:x"; }, revokeObjectURL() {} };
  globalThis.URL = URLShim;
}

async function main() {
  const files = ["charts.js", "engine.js", "analytics.js", "predict.js", "upload.js", "ml.js", "assistant.js"];
  let ok = true;
  for (const f of files) {
    try {
      const r = await fetch(ROOT + f);
      if (!r.ok) { console.error("download failed: " + f + " " + r.status); ok = false; continue; }
      const src = await r.text();
      new Function("window", "document", "Option", src)(win, doc, globalThis.Option);
      console.log("  ✓ loaded " + f + " (" + (src.length / 1024).toFixed(1) + " KB)");
    } catch (e) { console.error("download failed: " + f + " " + e.message); ok = false; }
  }
  if (!ok) { console.error("ABORT: assets missing from Pages"); process.exit(1); }
  installURLShim();
  assert(win.PricingData.analytics() !== null, "demo analytics computed in production");
  assert(!!win.PricingML, "PricingML present on live Pages");
  win.PricingML.render();
  assert(doc.getElementById("ml-steps").innerHTML.indexOf("ml-step") >= 0, "stepper rendered on live Pages");
  assert(doc.getElementById("ml-root").children.length > 0, "ML demo panels rendered on live Pages");
  win.PricingML.renderPrice();
  assert(doc.getElementById("ml-price-root").children.length > 0, "ML price panel rendered on live Pages");
  const rep = win.PricingData.report();
  assert(rep.size > 0, "demo report has rows (size " + rep.size + ")");
  const tab = win.PricingData.predictionTable();
  assert(tab.length > 0, "prediction table covers " + tab.length + " products");
  win.PricingData.setCurrency("GBP", 0.79);
  assert(win.PricingData.getCurrency().symbol === "£", "GBP currency works live");
  win.PricingData.setCurrency("USD");

  console.log(fails === 0 ? "\nLIVE CHECK PASS" : "\nLIVE CHECK FAILED: " + fails);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });