/* ml.js — ML Pipeline module for the Smart Dynamic Pricing dashboard.
 *
 * Renders the honest ML story for both modes:
 *   Demo Mode   — client-side: Linear Regression vs Seasonal Baseline,
 *                 feature strengths, actual-vs-predicted, client
 *                 recommendations (clearly labelled as demo estimates).
 *   Upload Mode — results of the backend pipeline: model comparison,
 *                 best-model metrics with plain-language labels, feature
 *                 importances, test-set actual-vs-predicted, per-row
 *                 prediction table and the "why this price" optimisation
 *                 (with the statistical caveat).
 *
 * Exposes window.PricingML.
 */
(function (root) {
  "use strict";

  function backend() { return root.PricingBackend || null; }
  var P = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]);
    });
  }
  function fmt(n, d) {
    if (n == null || isNaN(n)) return "\u2014";
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 2 : d });
  }
  function money(n) { return P ? P.fmtMoney(n) : "$" + fmt(n); }
  function chart() { return root.PricingCharts && root.PricingCharts.Chart ? root.PricingCharts.Chart : null; }

  function destroyChart(id) {
    var c = root.__mlCharts || (root.__mlCharts = {});
    if (c[id]) { try { c[id].destroy(); } catch (_) {} c[id] = null; }
  }
  function draw(id, opts, host) {
    destroyChart(id);
    var C = chart();
    if (!C) return;
    root.__mlCharts[id] = new C(host || document.getElementById(id), opts);
  }

  var STEPS_DEMO = [
    ["Dataset", "Demo dataset generated in-browser (4,380 sales rows)"],
    ["Preprocessing", "Missing values & duplicates analysed in-browser"],
    ["Model comparison", "Linear Regression vs Seasonal Baseline on the same split"],
    ["Training", "Best in-browser model trained & evaluated"],
    ["Pricing", "Recommendations from the fitted demand curve"],
  ];
  var STEPS_UPLOAD = [
    ["Dataset", "CSV uploaded, validated & parsed by the backend"],
    ["Preprocessing", "Missing values, duplicates & target selection"],
    ["Model comparison", "Linear / Random Forest / XGBoost with 5-fold cross-validation"],
    ["Training", "Best model trained & hold-out metrics computed"],
    ["Pricing", "Price sweep over the fitted demand curve, revenue or profit objective"],
  ];

  /* Render the pipeline stepper. doneCount = number of completed steps. */
  function steps(mode, doneCount) {
    var list = mode === "upload" ? STEPS_UPLOAD : STEPS_DEMO;
    var html = '<div class="ml-steps">';
    list.forEach(function (st, i) {
      var cls = "ml-step";
      if (i < doneCount) cls += " done";
      else if (i === doneCount) cls += " active";
      html += '<div class="' + cls + '"><span class="ml-dot"></span><div class="ml-step-txt"><b>' +
        esc(st[0]) + "</b><i>" + esc(st[1]) + "</i></div></div>";
    });
    html += "</div>";
    return html;
  }

  function panel(title, sub) {
    return '<div class="card"><h3>' + esc(title) + "</h3>" +
      (sub ? '<p class="sub">' + esc(sub) + "</p>" : "") +
      '<div class="ml-body"></div></div>';
  }

  function metricRow(k, v, note) {
    return '<div class="ml-row"><span>' + esc(k) + "</span><b>" + v + "</b>" +
      (note ? "<i>" + esc(note) + "</i>" : "") + "</div>";
  }

  /* ------------------------------------------------------------------ */
  /* Demo-mode rendering                                                 */
  /* ------------------------------------------------------------------ */
  function demoBestModel() {
    var a = P.analytics();
    var lin = a.model;
    var base = P.trainBaseline(P.rows());
    var best = lin.r2 >= base.r2 ? lin : base;
    var models = [
      { name: lin.name, r2: lin.r2, mae: lin.mae, rmse: lin.rmse, time: lin.trainingTimeMs, best: best === lin },
      { name: base.name, r2: base.r2, mae: base.mae, rmse: base.rmse, time: base.trainingTimeMs, best: best === base },
    ];
    return { best: best, models: models, lin: lin, base: base };
  }

  function renderComparisonChart(models, hostId) {
    var names = models.map(function (m) { return m.name; }).map(function (n, i) { return "M" + (i + 1); });
    draw(hostId, {
      xLabels: names,
      series: [
        { name: "R\u00B2", color: "#5b8cff", type: "bar", data: models.map(function (m) { return m.r2; }) },
        { name: "RMSE (units)", color: "#8b5cf6", type: "bar", data: models.map(function (m) { return m.rmse; }) },
      ],
      yFmt: function (v) { return fmt(v, 3); },
      title: "Model comparison",
    });
  }

  function compareTable(models) {
    var rows = models.map(function (m) {
      return "<tr" + (m.best ? " class='ml-best'" : "") + "><td>" + esc(m.name) + (m.best ? " <span class='badge'>BEST</span>" : "") +
        "</td><td>" + fmt(m.r2, 4) + "</td><td>" + fmt(m.mae, 2) + "</td><td>" + fmt(m.rmse, 2) +
        "</td><td>" + fmt(m.time, 1) + " ms</td></tr>";
    }).join("");
    return '<table class="ml-table"><thead><tr><th>Model</th><th>R\u00B2</th><th>MAE</th><th>RMSE</th><th>Train time</th></tr></thead><tbody>' + rows + "</tbody></table>";
  }

  function featureStrengthChart() {
    var i = P.explain(); // [{feature, importance}]
    if (!i || !i.length) return "";
    var feats = i.slice(0, 8);
    draw("ml-demo-imp", {
      xLabels: feats.map(function (f) { return f.feature; }),
      series: [{ name: "|coef|", color: "#5b8cff", type: "bar", data: feats.map(function (f) { return f.importance; }) }],
      yFmt: function (v) { return fmt(v, 3); },
      title: "Feature strength (|standardised coefficient|)",
    });
    return "";
  }

  function avpDemo(pid) {
    var s = P.demandSeries(pid, 30, 14);
    if (!s.dates.length) return "";
    draw("ml-demo-avp", {
      xLabels: s.dates.map(function (d) { return String(d).slice(5); }),
      series: [
        { name: "Actual", color: "#5b8cff", data: s.actual, smooth: true, area: true },
        { name: "Predicted", color: "#34d399", data: s.predicted, smooth: true },
      ],
      yFmt: function (v) { return fmt(v, 1); },
      title: "Actual vs predicted demand (last 30 days + 14-day forecast)",
    });
    return "";
  }

  function demoPanel(rootEl) {
    var ml = demoBestModel();
    var host = document.createElement("div");
    host.className = "ml-host";
    host.innerHTML =
      '<div class="ml-model-summary">' +
      metricRow("Best model", "<b>" + esc(ml.best.name) + "</b>", "lowest hold-out RMSE, evaluated on a deterministic 80/20 split") +
      metricRow("R\u00B2", fmt(ml.best.r2, 4), "share of demand variance explained on unseen rows (0 = no better than the mean)") +
      metricRow("MAE", fmt(ml.best.mae, 2) + " units", "average absolute error") +
      metricRow("RMSE", fmt(ml.best.rmse, 2) + " units", "root mean squared error \u2014 penalises large errors more") +
      metricRow("Trained on", fmt(ml.best.trainSize) + " rows \u00B7 tested on " + fmt(ml.best.testSize), "split computed in-browser, same split for both models") +
      "</div>" +
      '<div class="ml-grid2">' +
      '<div class="ml-col"><h4>Model comparison</h4><div class="ml-compare">' + compareTable(ml.models) + "</div>" +
      "<div class='ml-chartbox'><canvas id='ml-demo-compare'></canvas></div></div>" +
      '<div class="ml-col"><h4>Feature strength</h4><div class="ml-chartbox"><canvas id="ml-demo-imp"></canvas></div></div>' +
      "</div>" +
      '<div class="ml-avp"><h4>Demand forecast (demo estimate)</h4>' +
      "<label style='margin:8px 0 4px'>Product</label>" +
      '<select id="ml-demo-prod"></select>' +
      '<div class="ml-chartbox"><canvas id="ml-demo-avp"></canvas></div></div>';
    rootEl.innerHTML = "";
    rootEl.appendChild(host);

    var prods = P.analytics().productList.map(function (p) { return p.product_id; });
    var sel = host.querySelector("#ml-demo-prod");
    prods.forEach(function (id) { sel.add(new Option(id, id)); });
    sel.value = prods[0];
    var refreshAvp = function () { avpDemo(sel.value); };
    sel.onchange = refreshAvp;

    renderComparisonChart(ml.models, "ml-demo-compare");
    featureStrengthChart();
    refreshAvp();
  }

  /* ------------------------------------------------------------------ */
  /* Upload-mode rendering                                               */
  /* ------------------------------------------------------------------ */
  function uploadCompareChart(models) {
    draw("ml-up-compare", {
      xLabels: models.map(function (m, i) { return "M" + (i + 1); }),
      series: [
        { name: "R\u00B2", color: "#5b8cff", type: "bar", data: models.map(function (m) { return m.r2; }) },
        { name: "RMSE (units)", color: "#8b5cf6", type: "bar", data: models.map(function (m) { return m.rmse; }) },
      ],
      yFmt: function (v) { return fmt(v, 3); },
      title: "Hold-out + cross-validation comparison",
    });
  }

  function uploadCompareTable(models, bestName) {
    var rows = models.map(function (m) {
      var isBest = m.name === bestName;
      return "<tr" + (isBest ? " class='ml-best'" : "") + "><td>" + esc(m.name) + (isBest ? " <span class='badge'>BEST</span>" : "") +
        "</td><td>" + fmt(m.r2, 4) + "</td><td>" + fmt(m.mae, 2) + "</td><td>" + fmt(m.rmse, 2) +
        "</td><td>CV R\u00B2 " + fmt(m.cv_r2_mean, 3) + " \u00B1 " + fmt(m.cv_r2_std, 3) + "</td></tr>";
    }).join("");
    return '<table class="ml-table"><thead><tr><th>Model</th><th>R\u00B2</th><th>MAE</th><th>RMSE</th><th>5-fold CV</th></tr></thead><tbody>' + rows + "</tbody></table>";
  }

  function featureImportanceChart(imp) {
    var top = imp.slice(0, 10);
    draw("ml-up-imp", {
      xLabels: top.map(function (f) { return f.feature; }),
      series: [{ name: "Importance", color: "#8b5cf6", type: "bar", data: top.map(function (f) { return f.importance; }) }],
      yFmt: function (v) { return fmt(v, 3); },
      title: "Feature importances (normalised to sum 1)",
    });
  }

  function uploadAvp(train) {
    var tp = train.test_predictions || [];
    if (!tp.length) return;
    var n = Math.min(tp.length, 60);
    var labels = [];
    for (var i = 0; i < n; i++) labels.push("row " + (i + 1));
    draw("ml-up-avp", {
      xLabels: labels,
      series: [
        { name: "Actual", color: "#5b8cff", data: tp.slice(0, n).map(function (r) { return r.actual; }) },
        { name: "Predicted", color: "#34d399", data: tp.slice(0, n).map(function (r) { return r.predicted; }) },
      ],
      yFmt: function (v) { return fmt(v, 1); },
      title: "Hold-out rows: actual vs predicted (first " + n + ")",
    });
  }

  function predictionsTable(train) {
    var rows = train.predictions_table || [];
    if (!rows.length) return "<p class='ml-empty'>No rows to show.</p>";
    var headers = Object.keys(rows[0]);
    var head = headers.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("");
    var body = rows.map(function (r) {
      return "<tr>" + headers.map(function (h) { return "<td>" + esc(r[h]) + "</td>"; }).join("") + "</tr>";
    }).join("");
    return '<div style="overflow:auto;max-height:280px"><table class="ml-table"><thead><tr>' + head +
      "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function uploadPanel(rootEl) {
    var tr = BACKEND.train;
    var host = document.createElement("div");
    host.className = "ml-host";
    host.innerHTML =
      '<div class="ml-model-summary">' +
      metricRow("Best model", "<b>" + esc(tr.best.name) + "</b>", "lowest hold-out RMSE, ties broken by R\u00B2") +
      metricRow("R\u00B2", fmt(tr.best.r2, 4), esc(String((tr.metrics_explained && tr.metrics_explained.r2) || "R\u00B2 = share of target variance explained (0 = no better than the mean)."))) +
      metricRow("MAE", fmt(tr.best.mae, 2) + " units", esc(String((tr.metrics_explained && tr.metrics_explained.mae) || ""))) +
      metricRow("RMSE", fmt(tr.best.rmse, 2) + " units", esc(String((tr.metrics_explained && tr.metrics_explained.rmse) || ""))) +
      metricRow("Dataset", fmt(tr.dataset.rows) + " rows \u00B7 " + fmt(tr.dataset.features) + " engineered features", "target: " + esc(tr.dataset.target)) +
      "</div>" +
      '<div class="ml-grid2">' +
      '<div class="ml-col"><h4>Model comparison</h4><div class="ml-compare">' + uploadCompareTable(tr.models, tr.best.name) + "</div>" +
      "<div class='ml-chartbox'><canvas id='ml-up-compare'></canvas></div></div>" +
      '<div class="ml-col"><h4>Feature importances</h4><div class="ml-chartbox"><canvas id="ml-up-imp"></canvas></div></div>' +
      "</div>" +
      '<div class="ml-avp"><h4>Hold-out actual vs predicted</h4>' +
      '<div class="ml-chartbox"><canvas id="ml-up-avp"></canvas></div></div>' +
      '<div class="ml-tbl"><h4>Per-row predictions (first ' + tr.predictions_table.length + " of test set, sampled)</h4>" + predictionsTable(tr) + "</div>";
    rootEl.innerHTML = "";
    rootEl.appendChild(host);
    uploadCompareChart(tr.models);
    featureImportanceChart(tr.feature_importance || []);
    uploadAvp(tr);
  }

  /* ------------------------------------------------------------------ */
  /* Price recommendation (handled per mode)                             */
  /* ------------------------------------------------------------------ */
  function pricePanelDemo(rootEl) {
    var host = document.createElement("div");
    host.className = "ml-host ml-price";
    host.innerHTML =
      '<div class="ml-grid2"><div class="ml-col">' +
      "<label>Product ID</label><select id='ml-demo-price-prod'></select>" +
      "<label>Objective</label><select id='ml-demo-price-obj'><option value='revenue'>Maximise revenue</option><option value='profit'>Maximise profit</option></select>" +
      '<button id="ml-demo-price-run" class="ml-btn">Recommend price</button>' +
      "</div><div class='ml-col'><div id='ml-demo-price-out' class='result empty'>Run a recommendation to see why this price.</div></div></div>";
    rootEl.innerHTML = "";
    rootEl.appendChild(host);
    var prods = P.analytics().productList.map(function (p) { return p.product_id; });
    var sel = host.querySelector("#ml-demo-price-prod");
    prods.forEach(function (id) { sel.add(new Option(id, id)); });
    host.querySelector("#ml-demo-price-run").onclick = function () {
      var prodId = sel.value;
      var obj = host.querySelector("#ml-demo-price-obj").value;
      var prod = P.productById(prodId);
      var rec = P.optimizePrice(prod, { objective: obj, inventory: prod.inventory, competitor_price: prod.competitor_price });
      var why = P.recommendReasons(prod, { objective: obj, inventory: prod.inventory, competitor_price: prod.competitor_price });
      var reasons = why.reasons;
      var rc = resultEl(host.querySelector("#ml-demo-price-out"));
      rc.head("Demo recommendation", "objective \u00B7 " + rec.objective);
      rc.row("Current price", money(prod.base_price));
      rc.row("Recommended price", money(rec.recommended_price), "hero");
      rc.row("Expected demand", fmt(rec.expected_demand) + " units/day");
      rc.row("Expected revenue", money(rec.expected_revenue));
      rc.row("Expected profit", money(rec.expected_profit));
      rc.row("Change", rec.price_change_pct + "%");
      host.querySelector("#ml-demo-price-out").insertAdjacentHTML("beforeend",
        '<div class="ml-reasons">' + reasons.map(function (r) {
          return '<div class="ml-reason"><span>' + esc(r.icon || "\u2022") + "</span><p>" + esc(r.text) + "</p></div>";
        }).join("") + "</div>" +
        '<p class="ml-caveat">Demo estimate from the in-browser model \u2014 not a guarantee.</p>');
    };
  }

  function uploadPriceAction(objSel, prodSel, out) {
    var obj = objSel.value;
    var prodId = prodSel.value;
    var rows = P.rows();
    var row = rows.filter(function (r) { return r.product_id === prodId; }).pop() || rows[0];
    if (!row) { showErr(out, "No dataset rows available."); return; }
    var payload = { dataset_id: BACKEND.datasetId, objective: obj, row: row };
    var btn = out.closest(".ml-price").querySelector(".ml-btn");
    btn.disabled = true; btn.textContent = "Optimising\u2026";
    root.PricingUI.spinner(true);
    fetch("/api/pricing/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.detail || r.statusText); return j; });
    }).then(function (res) {
      btn.disabled = false; btn.textContent = "Recommend price";
      root.PricingUI.spinner(false);
      var rc = resultEl(out);
      if (!res.supports_optimization) {
        rc.head("Not supported", "");
        rc.row("Status", "Price optimisation is not possible: " + esc(res.reason || "insufficient data"));
        return;
      }
      rc.head("Backend recommendation", "objective \u00B7 " + res.optimal.objective + " \u00B7 " + res.currency);
      rc.row("Current price", money(res.current.price));
      rc.row("Recommended price", money(res.optimal.price), "hero");
      rc.row("Estimated demand", fmt(res.optimal.estimated_demand) + " units");
      rc.row("Estimated revenue", money(res.optimal.estimated_revenue));
      rc.row("Change", fmt(res.optimal.change_pct, 1) + "% \u00B7 " + fmt(res.demand_model.elasticity, 2) + " elasticity");
      out.insertAdjacentHTML("beforeend",
        '<div class="ml-reasons">' + (res.reasons || []).map(function (r) {
          return '<div class="ml-reason"><span>' + esc(r.icon || "\u2022") + "</span><p>" + esc(r.text) + "</p></div>";
        }).join("") + "</div>" +
        '<p class="ml-caveat">' + esc(res.caveat || "ML-based estimate, not guaranteed.") + "</p>");
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = "Recommend price";
      root.PricingUI.spinner(false);
      showErr(out, e && e.message ? e.message : String(e));
      toast("Backend offline", "Upload Mode needs the backend. Running in Demo Mode works offline.", "err");
    });
  }

  function pricePanelUpload(rootEl) {
    var host = document.createElement("div");
    host.className = "ml-host ml-price";
    host.innerHTML =
      '<div class="ml-grid2"><div class="ml-col">' +
      "<label>Product</label><select id='ml-up-price-prod'></select>" +
      "<label>Objective</label><select id='ml-up-price-obj'><option value='revenue'>Maximise revenue</option><option value='profit'>Maximise profit</option></select>" +
      '<button id="ml-up-price-run" class="ml-btn">Recommend price</button>' +
      "</div><div class='ml-col'><div id='ml-up-price-out' class='result empty'>Recommend a price to see why this price.</div></div></div>";
    rootEl.innerHTML = "";
    rootEl.appendChild(host);
    var prods = P.analytics().productList.map(function (p) { return p.product_id; });
    var sel = host.querySelector("#ml-up-price-prod");
    prods.forEach(function (id) { sel.add(new Option(id, id)); });
    var run = host.querySelector("#ml-up-price-run");
    run.onclick = function () {
      uploadPriceAction(host.querySelector("#ml-up-price-obj"), sel, host.querySelector("#ml-up-price-out"));
    };
  }

  /* ---------- small helpers (duplicated locally to stay standalone) -- */
  function resultEl(container) {
    container.classList.remove("empty");
    container.innerHTML = "";
    return {
      head: function (left, right) {
        var h = document.createElement("div"); h.className = "res-head";
        h.innerHTML = "<span>" + left + "</span><span>" + esc(right || "") + "</span>";
        container.appendChild(h);
      },
      row: function (k, v, cls) {
        var r = document.createElement("div"); r.className = "res-row";
        r.innerHTML = '<span class="k">' + esc(k) + '</span><span class="v ' + (cls || "") + '">' + v + "</span>";
        container.appendChild(r);
      },
    };
  }
  function showErr(el, msg) {
    el.innerHTML = '<div class="err-box">' + esc(msg) + "</div>";
  }
  function toast(t, d, type) {
    if (root.PricingUI && root.PricingUI.toast) root.PricingUI.toast(t, d, type);
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                          */
  /* ------------------------------------------------------------------ */
  function render() {
    P = root.PricingData;
    if (!P) return;
    var bk = backend();
    var isUp = bk && bk.train;
    var offline = bk && bk.offline && !bk.train;
    var stepsEl = document.getElementById("ml-steps");
    if (stepsEl) {
      if (offline) stepsEl.innerHTML = steps("upload", 2) +
        '<p class="ml-empty" style="margin:10px 2px 0">Backend unreachable \u2014 dataset mirrored in-browser; switch to Demo Mode or restart the backend to run the full ML pipeline.</p>';
      else stepsEl.innerHTML = steps(isUp ? "upload" : "demo", isUp ? 4 : 4);
    }
    var body = document.getElementById("ml-root");
    if (!body) return;
    body.className = "ml-body";
    if (isUp) uploadPanel(body);
    else if (offline) {
      body.innerHTML = '<div class="ml-empty" style="padding:14px">Backend ML pipeline offline. The uploaded dataset is available in the in-browser panels (Analytics, Prediction Center, Decision Engine), which use the client-side model as a transparent mirror of the same data.</div>';
      destroyChart("ml-up-compare"); destroyChart("ml-up-imp"); destroyChart("ml-up-avp");
    } else demoPanel(body);
  }

  function renderPrice() {
    P = root.PricingData;
    if (!P) return;
    var el = document.getElementById("ml-price-root");
    if (!el) return;
    if (backend() && backend().train) pricePanelUpload(el);
    else pricePanelDemo(el);
  }

  root.PricingML = { render: render, renderPrice: renderPrice, steps: steps };
})(typeof window !== "undefined" ? window : globalThis);