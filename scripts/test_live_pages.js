/* Live smoke test: fetch the deployed dashboard assets and boot them against
 * the same DOM/canvas shim used by test_dashboard_boot.js. Verifies the
 * dataset-only experience in production: warm-sand tokens are present, no
 * manual mode remains, and the page starts empty (no built-in demo data).
 *
 *   node scripts/test_live_pages.js            (GitHub Pages)
 *   LIVE_ROOT=http://127.0.0.1:8000/ node scripts/test_live_pages.js
 */
"use strict";
const ROOT = process.env.LIVE_ROOT || "https://harikaran-07.github.io/smart-dynamic-pricing/";

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
    addEventListener() {}, focus() {}, click() {},
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
globalThis.Blob = function () {};
globalThis.FileReader = function () {};
const win = globalThis;

/* keep the real URL class for fetch, install a blob shim only for eval */
let URLShim = null;
function installURLShim() {
  if (URLShim) return;
  URLShim = { createObjectURL() { return "blob:x"; }, revokeObjectURL() {} };
  globalThis.URL = URLShim;
}

async function main() {
  let html = "";
  try {
    const r = await fetch(ROOT);
    html = await r.text();
    assert(r.ok, "dashboard index fetched (" + r.status + ")");
  } catch (e) {
    console.error("index download failed: " + e.message);
    process.exit(1);
  }
  assert(/--bg:#F6EFE6/i.test(html), "warm sand background token is deployed");
  assert(/Fraunces/.test(html) && /fonts\.googleapis\.com/.test(html), "Fraunces font linked");
  assert(/Upload &amp; Analytics/.test(html) && /Portfolio/.test(html), "nav pages present");
  assert(!/Manual Mode/.test(html), "no Manual Mode switcher");

  const files = ["charts.js", "engine.js", "analytics.js", "predict.js", "upload.js", "ml.js"];
  let ok = true;
  for (const f of files) {
    try {
      const r = await fetch(ROOT + f);
      if (!r.ok) { console.error("download failed: " + f + " " + r.status); ok = false; continue; }
      const src = await r.text();
      assert(!/manualPredict|predictionTable|confidence_pct|q_values:\s*\[/.test(src),
        f + " carries no browser pricing / fake Q-values");
      new Function("window", "document", "Option", src)(win, doc, globalThis.Option);
      console.log("  ✓ loaded " + f + " (" + (src.length / 1024).toFixed(1) + " KB)");
    } catch (e) { console.error("download failed: " + f + " " + e.message); ok = false; }
  }
  if (!ok) { console.error("ABORT: assets missing"); process.exit(1); }

  installURLShim();
  assert(win.PricingData.analytics() === null, "no built-in demo data on live pages (starts empty)");
  assert(win.PricingData.source() === "", "engine defaults to empty on live pages");
  assert(!!win.PricingML, "PricingML present");
  win.PricingML.render();
  assert(doc.getElementById("ml-steps").innerHTML === "", "stepper empty until upload");
  assert(doc.getElementById("ml-root").innerHTML.indexOf("Upload a CSV dataset") >= 0,
    "ML upload empty state rendered");
  const rep = win.PricingData.report();
  assert(rep.size === 0, "empty report before upload (size " + rep.size + ")");

  try { win.PricingPredict.mount(); } catch (e) { console.error(e); fails++; }
  assert(win.PricingPredict.getMode() === "dataset", "Predict is dataset-only");
  assert(typeof win.PricingPredict.setMode === "undefined", "no manual-mode switch");
  assert(els["pp-content"].innerHTML.indexOf("No dataset loaded") >= 0, "Predict empty state rendered");

  win.PricingData.setCurrency("GBP", 0.79);
  assert(win.PricingData.getCurrency().symbol === "£", "GBP currency works live");
  win.PricingData.setCurrency("USD");

  console.log(fails === 0 ? "\nLIVE CHECK PASS" : "\nLIVE CHECK FAILED: " + fails);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
