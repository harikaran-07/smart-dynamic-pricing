/* predict.js — Prediction Center for the Smart Dynamic Pricing dashboard.
 *
 * Provides two clean modes:
 *   Dataset Mode  : upload/use a dataset, analyse it, train the model, view a
 *                   clear prediction table and download it as CSV.
 *   Manual Mode   : enter price / demand / sales / inventory / competitor /
 *                   quantity / season manually and get KPI cards with a
 *                   recommended price, explanation and dynamic reasoning.
 *
 * Also renders the 5-step workflow indicator and honours the active currency
 * (USD / INR) via PricingData.setCurrency / fmtMoney.
 *
 * Exposes window.PricingPredict = { mount(), render() }.
 */
(function (root) {
  "use strict";

  var P = null; // PricingData
  var C = null; // PricingCharts
  var state = { mode: "dataset", product: null, manual: null, charts: [] };

  function css() {
    var s = document.createElement("style");
    s.textContent = `
    .pp-panel{background:linear-gradient(180deg,var(--card),var(--card-2));
      border:1px solid var(--line);border-radius:var(--rad);box-shadow:var(--shadow);overflow:hidden}
    .pp-steps{display:flex;gap:0;padding:16px 18px;border-bottom:1px solid var(--line);
      background:rgba(8,12,24,.35);flex-wrap:wrap}
    .pp-step{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mut);font-weight:600}
    .pp-step .n{width:22px;height:22px;border-radius:50%;background:#0c1220;border:1px solid var(--line);
      display:grid;place-items:center;font-size:11px;font-weight:800;color:var(--faint);flex:none}
    .pp-step.done .n{background:rgba(52,211,153,.16);color:var(--ok);border-color:rgba(52,211,153,.4)}
    .pp-step.active{color:var(--txt)}
    .pp-step.active .n{background:linear-gradient(135deg,var(--acc),var(--acc-2));color:#fff;border:0}
    .pp-step .a{font-size:10.5px;color:var(--faint);font-weight:500}
    .pp-arr{color:var(--line);margin:0 10px;font-size:13px}
    .pp-modes{display:flex;gap:6px;padding:14px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
    .pp-mode{padding:9px 18px;border-radius:10px;background:#0c1220;border:1px solid var(--line);
      color:var(--mut);font-size:13px;font-weight:700;cursor:pointer;margin:0;width:auto;box-shadow:none}
    .pp-mode:hover{color:var(--txt);border-color:var(--acc)}
    .pp-mode.active{background:linear-gradient(135deg,var(--acc),var(--acc-2));color:#fff;border:0}
    .pp-body{padding:18px}
    .pp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}
    .pp-card{background:linear-gradient(180deg,var(--card),var(--card-2));border:1px solid var(--line);
      border-radius:var(--rad);padding:18px}
    .pp-card.wide{grid-column:1/-1}
    .pp-card h4{margin:0 0 4px;font-size:14.5px;font-weight:700}
    .pp-card .sub{font-size:12px;color:var(--faint);margin:0 0 12px}
    .pp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0}
    .pp-kpi{background:#0c1220;border:1px solid var(--line);border-radius:12px;padding:13px 14px;position:relative;overflow:hidden}
    .pp-kpi::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--acc),var(--acc-2))}
    .pp-kpi .k{font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.5px}
    .pp-kpi .v{font-size:21px;font-weight:800;margin-top:5px}
    .pp-kpi .v.ok{color:var(--ok)} .pp-kpi .v.bad{color:var(--bad)} .pp-kpi .v.warn{color:var(--warn)}
    .pp-kpi .s{font-size:11px;color:var(--faint);margin-top:3px}
    .pp-table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
    .pp-table th,.pp-table td{border:1px solid var(--line);padding:7px 9px;text-align:left;white-space:nowrap}
    .pp-table th{background:#0c1220;color:var(--acc);font-size:11px;text-transform:uppercase;letter-spacing:.4px}
    .pp-table td{color:var(--mut)} .pp-table td b{color:var(--txt)}
    .pp-table .up{color:var(--ok)} .pp-table .down{color:var(--bad)}
    .pp-scroll{overflow:auto;max-height:340px}
    .pp-chart{height:250px;margin-top:6px}
    .pp-chart canvas{height:100%;width:100%}
    .pp-reasons{margin-top:14px;display:grid;gap:8px}
    .pp-reason{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;
      background:rgba(91,140,255,.06);border:1px solid rgba(91,140,255,.16);font-size:12.5px;color:var(--mut);line-height:1.5}
    .pp-reason .ic{flex:none;width:24px;height:24px;border-radius:8px;display:grid;place-items:center;
      font-weight:800;font-size:13px}
    .pp-reason.up .ic{background:rgba(52,211,153,.16);color:var(--ok)}
    .pp-reason.down .ic{background:rgba(248,113,113,.16);color:var(--bad)}
    .pp-reason.flat .ic{background:rgba(148,163,184,.14);color:var(--mut)}
    .pp-reason b{color:var(--txt)}
    .pp-reason.up{border-color:rgba(52,211,153,.25)}
    .pp-reason.down{border-color:rgba(248,113,113,.25)}
    .pp-expl{margin-top:14px;padding:12px 14px;border-radius:10px;background:rgba(91,140,255,.07);
      border:1px solid rgba(91,140,255,.2);font-size:13px;line-height:1.65;color:var(--mut)}
    .pp-expl b{color:var(--txt)}
    .pp-err{margin-top:12px;padding:12px;border-radius:10px;background:rgba(248,113,113,.1);
      border:1px solid rgba(248,113,113,.3);color:var(--bad);font-size:13px}
    .pp-meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
    .pp-chip{font-size:11.5px;padding:6px 11px;border-radius:999px;border:1px solid var(--line);
      background:#0c1220;color:var(--mut);font-weight:600}
    .pp-chip b{color:var(--txt)}
    .pp-chip.warn{color:var(--warn);border-color:rgba(251,191,36,.35)}
    .pp-empty{padding:26px;text-align:center;color:var(--faint);font-size:13px;border:1px dashed var(--line);
      border-radius:12px;margin-top:8px}
    .pp-btn{margin:0;width:auto;padding:11px 20px;border-radius:10px;font-size:13px;font-weight:700;
      background:linear-gradient(135deg,var(--acc),var(--acc-2));color:#fff;border:0;cursor:pointer;
      box-shadow:0 8px 20px rgba(91,140,255,.3)}
    .pp-btn:hover{filter:brightness(1.08)}
    .pp-btn.ghost{background:#0c1220;border:1px solid var(--line);color:var(--txt);box-shadow:none}
    .pp-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
    .pp-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
    .pp-form label{font-size:11.5px;margin:0 0 5px;color:var(--mut);font-weight:600}
    .pp-form input,.pp-form select{width:100%}
    @media (max-width:560px){.pp-step .a{display:none}.pp-arr{margin:0 6px}}
    `;
    document.head.appendChild(s);
  }

  function fmt(n, d) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN", { maximumFractionDigits: d == null ? 0 : d });
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]);
    });
  }
  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function destroyCharts() {
    state.charts.forEach(function (c) { try { c.destroy(); } catch (_) {} });
    state.charts = [];
  }

  /* ------------------- step indicator ------------------- */
  function steps(active) {
    var list = [
      ["Select Mode"], ["Enter/Upload Data"], ["Analyze"], ["Predict"], ["View Results"],
    ];
    return '<div class="pp-steps">' + list.map(function (st, i) {
      var cls = i < active ? "done" : i === active ? "active" : "";
      return '<div class="pp-step ' + cls + '"><span class="n">' + (i + 1) + '</span><span class="a">' + st[0] + '</span></div>' +
        (i < list.length - 1 ? '<span class="pp-arr">→</span>' : "");
    }).join("") + '</div>';
  }

  /* ------------------- dataset mode ------------------- */
  function renderDataset() {
    var wrap = el('<div class="pp-grid"></div>');
    var a = P.analytics();
    if (!a) {
      var empty = el('<div class="pp-card wide"><h4>No dataset loaded</h4>' +
        '<p class="sub">Upload a CSV or Excel file with the <b>Upload Dataset</b> button to train the model, run predictions and export results.</p></div>');
      wrap.appendChild(empty);
      return wrap;
    }
    var report = P.report();
    var meta = P.meta();
    var currency = P.getCurrency();

    /* dataset analytics card */
    var chips =
      '<div class="pp-meta">' +
      ppchip("Dataset", (meta && meta.fileName) || "—", "") +
      ppchip("Size", fmt(a.records) + " rows", "") +
      ppchip("Features", a.features, "") +
      ppchip("Products", a.products, "") +
      ppchip("Missing values", fmt(report.missingValues), report.missingValues ? "warn" : "") +
      ppchip("Duplicate records", fmt(report.duplicates), report.duplicates ? "warn" : "") +
      '</div>';

    var statsGrid = '<div class="pp-kpis">' +
      statKpi("Price (min)", P.fmtMoney(report.stats.price.min), "avg " + P.fmtMoney(report.stats.price.avg)) +
      statKpi("Price (max)", P.fmtMoney(report.stats.price.max), "median avg shown") +
      statKpi("Units/day (avg)", fmt(report.stats.units_sold.avg, 1), "min " + fmt(report.stats.units_sold.min) + " · max " + fmt(report.stats.units_sold.max)) +
      statKpi("Inventory (avg)", fmt(report.stats.inventory.avg, 0), "min " + fmt(report.stats.inventory.min) + " · max " + fmt(report.stats.inventory.max)) +
      '</div>';

    var previewRows = report.preview.map(function (r) {
      return '<tr><td><b>' + esc(r.product_id) + '</b></td><td>' + esc(r.date) + '</td><td>' + P.fmtMoney(r.price) +
        '</td><td>' + P.fmtMoney(r.cost) + '</td><td>' + P.fmtMoney(r.competitor_price) + '</td><td>' + fmt(r.inventory) +
        '</td><td>' + fmt(r.units_sold) + '</td></tr>';
    }).join("");
    var preview = '<div class="pp-scroll"><table class="pp-table"><thead><tr>' +
      ['Product', 'Date', 'Price', 'Cost', 'Competitor', 'Stock', 'Units'].map(function (h) { return '<th>' + h + '</th>'; }).join("") +
      '</tr></thead><tbody>' + (previewRows || '<tr><td colspan="7" style="text-align:center;color:var(--faint)">No rows</td></tr>') + '</tbody></table></div>';

    var dsCard = el('<div class="pp-card wide"><h4>Dataset Analytics</h4>' +
      '<p class="sub">Size, quality, basic statistics and a preview of the active dataset. Missing values are filled with the column median and duplicate rows are reported.</p>' +
      chips + statsGrid + preview +
      (report.missingValues ? '<div class="pp-expl"><b>Heads-up:</b> ' + report.missingValues + ' missing value(s) were detected and safely filled using the median of each column.</div>' : "") +
      '</div>');
    wrap.appendChild(dsCard);

    /* ML model card */
    var m = a.model;
    var modelCard = el('<div class="pp-card wide"><h4>ML Model</h4><p class="sub">Trained on the active dataset with real hold-out metrics — no synthetic accuracy.</p>' +
      '<div class="pp-kpis">' +
      statKpi("Model", esc(m.name), "backbone " + esc(m.backbone)) +
      statKpi("Training status", esc(m.status || "trained"), m.trainedAt ? "at " + new Date(m.trainedAt).toLocaleString() : "") +
      statKpi("R² score", m.r2, "share of variance explained") +
      statKpi("MAE", fmt(m.mae, 2) + " units", "mean absolute error") +
      statKpi("RMSE", fmt(m.rmse, 2) + " units", "root mean squared error") +
      statKpi("Train / test rows", fmt(m.trainSize) + " / " + fmt(m.testSize), "80 / 20 split") +
      statKpi("Training time", fmt(m.trainingTimeMs) + " ms", "client-side training") +
      statKpi("Features", fmt(m.features.length), m.features.join(", ")) +
      '</div></div>');
    wrap.appendChild(modelCard);

    /* prediction table */
    var rows = P.predictionTable();
    var tableHtml = rows.map(function (r) {
      var up = r.price_change_pct > 0, down = r.price_change_pct < 0;
      return '<tr><td><b>' + esc(r.product_id) + '</b></td><td>' + esc(r.category) + '</td><td>' + P.fmtMoney(r.base_price) +
        '</td><td><b>' + P.fmtMoney(r.recommended_price) + '</b></td>' +
        '<td class="' + (up ? "up" : down ? "down" : "") + '">' + (up ? "+" : "") + r.price_change_pct + '%</td>' +
        '<td>' + fmt(r.expected_demand, 1) + '</td><td>' + P.fmtMoney(r.expected_revenue, 0) + '</td></tr>';
    }).join("");
    var predCard = el('<div class="pp-card wide"><h4>Prediction Results</h4>' +
      '<p class="sub">Recommended price per product from the trained demand model. Use the currency selector to switch between USD ($) and INR (₹).</p>' +
      '<div class="pp-scroll"><table class="pp-table"><thead><tr>' +
      ['Product', 'Category', 'Base price', 'Recommended', 'Change', 'Expected demand', 'Expected revenue'].map(function (h) { return '<th>' + h + '</th>'; }).join("") +
      '</tr></thead><tbody>' + tableHtml + '</tbody></table></div>' +
      '<div class="pp-actions"><button class="pp-btn" id="pp-export">Download Predictions (CSV)</button>' +
      '<button class="pp-btn ghost" id="pp-refresh">Retrain Model</button></div></div>');
    wrap.appendChild(predCard);

    /* actual vs recommended chart */
    var chartCard = el('<div class="pp-card wide"><h4>Actual Price vs Recommended Price</h4>' +
      '<p class="sub">Current base price versus the model recommendation — highest and lowest are marked automatically.</p>' +
      '<div class="pp-chart"><canvas></canvas></div></div>');
    wrap.appendChild(chartCard);
    if (C) {
      var ch = new C.Chart(chartCard.querySelector("canvas"), {
        xLabels: rows.map(function (r) { return r.product_id; }),
        series: [
          { name: "Actual price", color: "#5b8cff", type: "bar", data: rows.map(function (r) { return r.base_price; }) },
          { name: "Recommended", color: "#34d399", type: "bar", data: rows.map(function (r) { return r.recommended_price; }) },
        ],
        yFmt: function (v) { return P.fmtMoney(v, 0); },
        showValues: "bars",
      });
      state.charts.push(ch);
    }

    wrap.querySelector("#pp-export").onclick = function () {
      var e = P.exportPredictions();
      P.download(e.name, e.csv);
      root.PricingUI && root.PricingUI.toast("Export ready", e.name + " downloaded.", "ok");
    };
    wrap.querySelector("#pp-refresh").onclick = function () {
      var t0 = performance.now();
      P.refreshModel();
      state.product = a.productList[0] ? a.productList[0].product_id : state.product;
      render();
      root.PricingUI && root.PricingUI.toast("Model retrained", "Recomputed in " + Math.round(performance.now() - t0) + " ms.", "ok");
    };

    return wrap;
  }

  function ppchip(label, value, tone) {
    return '<span class="pp-chip ' + (tone || "") + '">' + label + ': <b>' + value + '</b></span>';
  }
  function statKpi(k, v, s) {
    return '<div class="pp-kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
      (s ? '<div class="s">' + s + '</div>' : "") + '</div>';
  }

  /* ------------------- manual mode ------------------- */
  function manualForm() {
    var months = P.MONTH_NAMES.map(function (m, i) { return '<option value="' + (i + 1) + '">' + m + '</option>'; }).join("");
    return '<div class="pp-form">' +
      '<div><label>Current price</label><input id="pp-m-price" type="number" step="0.01" value="49.99" min="0"/></div>' +
      '<div><label>Demand (units/day)</label><input id="pp-m-demand" type="number" value="20" min="0"/></div>' +
      '<div><label>Sales (units)</label><input id="pp-m-sales" type="number" value="20" min="0"/></div>' +
      '<div><label>Inventory / stock</label><input id="pp-m-inv" type="number" value="50" min="0"/></div>' +
      '<div><label>Competitor price</label><input id="pp-m-comp" type="number" step="0.01" value="52.00" min="0"/></div>' +
      '<div><label>Quantity (order size)</label><input id="pp-m-qty" type="number" value="1" min="1"/></div>' +
      '<div><label>Cost (optional)</label><input id="pp-m-cost" type="number" step="0.01" placeholder="auto = 50% of price"/></div>' +
      '<div><label>Season</label><select id="pp-m-season">' +
      '<option value="normal">Normal</option><option value="festival" selected>Festival</option>' +
      '<option value="summer">Summer</option><option value="winter">Winter</option><option value="monsoon">Monsoon</option></select></div>' +
      '<div><label>Month</label><select id="pp-m-month">' + months + '</select></div>' +
      '<div><label>Day type</label><select id="pp-m-day"><option value="0">Weekday</option><option value="1">Weekend</option></select></div>' +
      '</div>';
  }

  function readManual() {
    return {
      price: +document.getElementById("pp-m-price").value || 0,
      demand: +document.getElementById("pp-m-demand").value,
      inventory: +document.getElementById("pp-m-inv").value,
      competitor: +document.getElementById("pp-m-comp").value,
      cost: document.getElementById("pp-m-cost").value ? +document.getElementById("pp-m-cost").value : undefined,
      month: +document.getElementById("pp-m-month").value,
      weekend: +document.getElementById("pp-m-day").value,
      season: document.getElementById("pp-m-season").value,
      quantity: +document.getElementById("pp-m-qty").value || 1,
    };
  }

  function renderManualResult(res, elHost) {
    var o = res.optimal, c = res.current;
    var delta = o.price_delta_pct;
    var up = delta > 0.01, down = delta < -0.01;
    var dirCls = up ? "ok" : down ? "bad" : "";
    var arrow = up ? "▲" : down ? "▼" : "—";
    var confidence = res.confidence_pct;

    var kpis =
      '<div class="pp-kpis">' +
      '<div class="pp-kpi"><div class="k">Recommended price</div><div class="v ok">' + P.fmtMoney(o.recommended_price) + '</div>' +
      '<div class="s">cost floor ' + P.fmtMoney(res.input.cost != null ? res.input.cost : o.recommended_price * 0.5) + '</div></div>' +
      '<div class="pp-kpi"><div class="k">Expected demand</div><div class="v">' + fmt(o.demand, 1) + ' units</div>' +
      '<div class="s">at the recommended price</div></div>' +
      '<div class="pp-kpi"><div class="k">Expected revenue</div><div class="v">' + P.fmtMoney(o.revenue, 0) + '</div>' +
      '<div class="s">' + P.fmtMoney(c.revenue, 0) + ' today</div></div>' +
      '<div class="pp-kpi"><div class="k">Expected profit</div><div class="v">' + P.fmtMoney(o.profit, 0) + '</div>' +
      '<div class="s">' + P.fmtMoney(c.profit, 0) + ' today</div></div>' +
      '<div class="pp-kpi"><div class="k">Price change</div><div class="v ' + dirCls + '">' + arrow + ' ' + (up ? "+" : "") + delta + '%</div>' +
      '<div class="s">' + P.fmtMoney(c.price) + ' → ' + P.fmtMoney(o.recommended_price) + '</div></div>' +
      '<div class="pp-kpi"><div class="k">Confidence</div><div class="v">' + confidence + '%</div>' +
      '<div class="s">model R² ' + (res.model ? res.model.r2 : "—") + '</div></div>' +
      '</div>';

    var reasons = (res.reasons || []).map(function (r) {
      return '<div class="pp-reason ' + esc(r.tone) + '"><span class="ic">' + esc(r.icon) + '</span><span>' + esc(r.text) + '</span></div>';
    }).join("");

    var curRev = Math.round(c.revenue * 100) / 100, curProf = Math.round(c.profit * 100) / 100;
    var optRev = Math.round(o.revenue * 100) / 100, optProf = Math.round(o.profit * 100) / 100;
    var revDelta = curRev ? Math.round((optRev - curRev) / curRev * 100) : 0;
    var profDelta = curProf ? Math.round((optProf - curProf) / curProf * 100) : 0;

    elHost.innerHTML =
      kpis +
      '<div class="pp-expl"><b>Why this price?</b> "The recommended price is based on demand, inventory, competitor pricing, and historical sales patterns." At the recommended price, revenue is expected to ' +
      (revDelta >= 0 ? "rise" : "fall") + ' by ' + Math.abs(revDelta) + '% and profit to ' + (profDelta >= 0 ? "rise" : "fall") + ' by ' +
      Math.abs(profDelta) + '% versus the current scenario.</div>' +
      '<div class="pp-card" style="padding:0"><h4 style="padding:16px 18px 0">Pricing Recommendation</h4>' +
      '<div class="pp-reasons" style="padding:0 18px 18px">' + (reasons || '<p style="color:var(--faint)">No factors to explain yet.</p>') + '</div></div>';
  }

  function renderManual() {
    var wrap = el('<div class="pp-grid"></div>');
    var formCard = el('<div class="pp-card"><h4>Manual Input</h4>' +
      '<p class="sub">Enter product details to get a price recommendation — works independently of any uploaded dataset.</p>' +
      manualForm() +
      '<div class="pp-actions"><button class="pp-btn" id="pp-predict">Predict Price</button></div>' +
      '<div class="pp-err" id="pp-manual-err" style="display:none"></div></div>');
    var resultCard = el('<div class="pp-card"><h4>Prediction Dashboard</h4>' +
      '<p class="sub">KPI results appear here after you press Predict Price.</p>' +
      '<div id="pp-result"><div class="pp-empty">No prediction yet — fill the form and press Predict Price.</div></div></div>');
    wrap.appendChild(formCard);
    wrap.appendChild(resultCard);

    var monthSel = formCard.querySelector("#pp-m-month");
    monthSel.value = String(new Date().getMonth() + 1);

    formCard.querySelector("#pp-predict").onclick = function () {
      var m = readManual();
      var err = formCard.querySelector("#pp-manual-err");
      if (!(m.price > 0)) {
        err.textContent = "Please enter a positive current price.";
        err.style.display = "block";
        return;
      }
      if (!(m.inventory > 0)) {
        err.textContent = "Inventory must be greater than zero.";
        err.style.display = "block";
        return;
      }
      err.style.display = "none";
      state.manual = m;
      try {
        var res = P.manualPredict(m);
        renderManualResult(res, resultCard.querySelector("#pp-result"));
      } catch (e) {
        err.textContent = e && e.message ? e.message : String(e);
        err.style.display = "block";
      }
    };

    return wrap;
  }

  /* ------------------- shared chrome ------------------- */
  function render() {
    var content = document.getElementById("pp-content");
    if (!content) return;
    destroyCharts();
    var view = state.mode === "dataset" ? renderDataset() : renderManual();
    content.innerHTML = "";
    if (view) content.appendChild(view);
  }

  function mount() {
    var host = document.getElementById("predict-root");
    if (!host) return;
    P = root.PricingData;
    C = root.PricingCharts;
    if (!P) return;
    css();

    var a = P.analytics();
    state.product = a && a.productList[0] ? a.productList[0].product_id : "P001";

    var panel = el(
      '<div class="pp-panel">' +
      '<div id="pp-steps"></div>' +
      '<div class="pp-modes">' +
      '<button class="pp-mode active" data-mode="dataset">Dataset Mode</button>' +
      '<button class="pp-mode" data-mode="manual">Manual Mode</button>' +
      '</div>' +
      '<div class="pp-body"><div id="pp-content"></div></div>' +
      '</div>');
    host.appendChild(panel);

    panel.querySelectorAll(".pp-mode").forEach(function (b) {
      b.onclick = function () {
        panel.querySelectorAll(".pp-mode").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        state.mode = b.getAttribute("data-mode");
        renderSteps();
        render();
      };
    });

    renderSteps();
    render();
  }

  function renderSteps() {
    var host = document.getElementById("pp-steps");
    if (!host) return;
    host.innerHTML = state.mode === "dataset"
      ? steps(1) + ' <span style="color:var(--faint);font-size:11px;margin-left:auto;align-self:center">Dataset Mode — analyze and predict from uploaded data</span>'
      : steps(1) + ' <span style="color:var(--faint);font-size:11px;margin-left:auto;align-self:center">Manual Mode — predict from entered values</span>';
  }

  root.PricingPredict = {
    mount: mount, render: render, refresh: render,
    getMode: function () { return state.mode; },
    setMode: function (m) { if (m === "dataset" || m === "manual") state.mode = m; },
  };
})(typeof window !== "undefined" ? window : globalThis);
