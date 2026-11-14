/* ml.js — ML Pipeline module for the Smart Dynamic Pricing dashboard.
 *
 * Upload-only: renders the honest ML story from the backend pipeline —
 * model comparison, best-model metrics with plain-language labels, feature
 * importances, test-set actual-vs-predicted, per-row prediction table,
 * the "why this price" optimisation (with the statistical caveat) and the
 * portfolio / demand-curve charts.
 *
 * Exposes window.PricingML.
 */
(function (root) {
  "use strict";

  function backend() { return root.PricingBackend || null; }
  var P = null;
  var BACKEND = null;

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
  function col(i) {
    return (root.PricingCharts && root.PricingCharts.color)
      ? root.PricingCharts.color(i) : "currentColor";
  }
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

  var STEPS_UPLOAD = [
    ["Dataset", "CSV uploaded, validated & parsed by the backend"],
    ["Preprocessing", "Missing values, duplicates & target selection"],
    ["Model comparison", "Linear / Random Forest / Gradient Boosting / XGBoost with 5-fold cross-validation"],
    ["Training", "Best model trained & hold-out metrics computed"],
    ["Pricing", "Price sweep over the fitted curve, revenue or profit objective"],
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
  /* Upload-mode rendering                                               */
  /* ------------------------------------------------------------------ */
  function uploadCompareChart(models) {
    draw("ml-up-compare", {
      xLabels: models.map(function (m, i) { return "M" + (i + 1); }),
      series: [
        { name: "R\u00B2", color: col(0), type: "bar", data: models.map(function (m) { return m.r2; }) },
        { name: "RMSE (units)", color: col(4), type: "bar", data: models.map(function (m) { return m.rmse; }) },
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
        "</td><td>Cross-val R\u00B2 " + fmt(m.cv_r2_mean, 3) + " \u00B1 " + fmt(m.cv_r2_std, 3) + "</td></tr>";
    }).join("");
    return '<table class="ml-table"><thead><tr><th>Model</th><th>R\u00B2</th><th>MAE</th><th>RMSE</th><th>5-fold cross-val</th></tr></thead><tbody>' + rows + "</tbody></table>";
  }

  function featureImportanceChart(imp) {
    var top = imp.slice(0, 10);
    draw("ml-up-imp", {
      xLabels: top.map(function (f) { return f.feature; }),
      series: [{ name: "Importance", color: col(4), type: "bar", data: top.map(function (f) { return f.importance; }) }],
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
      showValues: "maxmin",
      series: [
        { name: "Actual", color: col(0), data: tp.slice(0, n).map(function (r) { return r.actual; }) },
        { name: "Predicted", color: col(2), data: tp.slice(0, n).map(function (r) { return r.predicted; }) },
      ],
      yFmt: function (v) { return fmt(v, 1); },
      title: "Hold-out rows: actual vs predicted (first " + n + ")",
    });
  }

  function predictionsTable(train) {
    var rows = train.predictions_table || [];
    if (!rows.length) return "<p class='ml-empty'>No rows to show.</p>";
    var headers = Object.keys(rows[0]).filter(function (h) {
      return rows[0][h] == null || typeof rows[0][h] !== "object";
    });
    var head = headers.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("");
    var body = rows.map(function (r) {
      return "<tr>" + headers.map(function (h) {
        var v = r[h];
        if (v && typeof v === "object") v = JSON.stringify(v);
        return "<td>" + esc(v) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    return '<div style="overflow:auto;max-height:280px"><table class="ml-table"><thead><tr>' + head +
      "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function qualityCard(profile) {
    if (!profile || !profile.quality) return "";
    var q = profile.quality;
    var tone = q.score >= 85 ? "var(--ok)" : q.score >= 50 ? "var(--warn)" : "var(--bad)";
    var html = '<div class="ml-quality">' +
      '<div class="ml-q-score" style="--qc:' + tone + '"><b>' + q.score + '</b><span>/100</span></div>' +
      '<div class="ml-q-body"><h3>Dataset quality: ' + esc(q.label) + "</h3>" +
      "<p>" + fmt(profile.rows) + " rows \u00B7 " + fmt(profile.total_missing || 0) + " missing \u00B7 " +
      fmt(profile.duplicates || 0) + " duplicates \u00B7 target: <b>" + esc(profile.suggested_target || "\u2014") + "</b></p>" +
      (q.issues && q.issues.length
        ? "<ul>" + q.issues.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>"
        : "<p class='ml-empty'>No data-quality issues detected.</p>") +
      "</div></div>";
    return html;
  }

  function uploadPanel(rootEl) {
    var tr = BACKEND.train;
    var host = document.createElement("div");
    host.className = "ml-host";
    host.innerHTML =
      qualityCard(BACKEND.profile) +
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
      '<div class="ml-tbl"><h4>Per-row predictions (first ' + tr.predictions_table.length + " of test set, sampled)</h4>" + predictionsTable(tr) + "</div>" +
      '<div class="ml-tbl" id="ml-up-portfolio-wrap"><h4>Portfolio: top products needing price changes</h4>' +
      '<div class="ml-empty">Loading recommendations\u2026</div></div>';
    rootEl.innerHTML = "";
    rootEl.appendChild(host);
    uploadCompareChart(tr.models);
    featureImportanceChart(tr.feature_importance || []);
    uploadAvp(tr);
    loadUploadExtras(host);
  }

  /* Portfolio chart (current vs recommended) — data comes from the backend. */
  function loadUploadExtras(host) {
    var bk = backend();
    if (!bk) return;
    var portWrap = host.querySelector("#ml-up-portfolio-wrap");
    fetch((window.API_BASE || "") + "/api/pricing/portfolio?dataset_id=" + encodeURIComponent(bk.datasetId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_id: bk.datasetId, objective: "revenue", top: 10 }),
    }).then(function (r) { return r.json(); }).then(function (port) {
      if (portWrap) {
        if (!port.items || !port.items.length) {
          portWrap.innerHTML = "<h4>Portfolio: top products needing price changes</h4>" +
            '<p class="ml-empty">' + esc(port.note || "No products with a usable fitted curve.") + "</p>";
          return;
        }
        var labels = port.items.map(function (it) { return it.product; });
        portWrap.innerHTML = "<h4>Portfolio: top products needing price changes</h4>" +
          '<div class="ml-chartbox"><canvas id="ml-up-portfolio"></canvas></div>' +
          '<table class="ml-table" style="margin-top:10px"><thead><tr><th>Product</th><th>Current</th><th>Recommended</th>' +
          "<th>Change</th><th>Est. revenue</th><th>Est. profit</th><th>Reliability</th></tr></thead><tbody>" +
          port.items.map(function (it) {
            return "<tr><td>" + esc(it.product) + "</td><td>" + money(it.current_price) + "</td><td><b>" +
              money(it.recommended_price) + "</b></td><td>" + fmt(it.change_pct, 1) + "%</td><td>" +
              money(it.expected_revenue) + "</td><td>" +
              (it.expected_profit != null ? money(it.expected_profit) : "\u2014") + "</td><td>" +
              esc(it.reliability) + "</td></tr>";
          }).join("") + "</tbody></table>";
        draw("ml-up-portfolio", {
          xLabels: labels,
          showValues: "maxmin",
          series: [
            { name: "Current", color: col(1), type: "bar", data: port.items.map(function (it) { return it.current_price; }) },
            { name: "Recommended", color: col(2), type: "bar", data: port.items.map(function (it) { return it.recommended_price; }) },
          ],
          yFmt: function (v) { return money(v, 0); },
          title: "Current vs recommended price",
        });
      }
    }).catch(function () {
      if (portWrap) portWrap.innerHTML = "<h4>Portfolio</h4>" +
        '<p class="ml-empty">Portfolio recommendations unavailable (backend offline).</p>';
    });
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
  var EMPTY_ML =
    '<div class="ml-empty" style="padding:20px;background:var(--card);border:1px solid var(--border);' +
    'border-radius:var(--radius)">' +
    "<p>Upload a CSV dataset to run the ML pipeline. The backend compares Linear Regression, " +
    "Random Forest, Gradient Boosting and XGBoost (5-fold cross-validation plus hold-out " +
    "metrics) and drives rule-constrained price recommendations.</p>" +
    '<button type="button" class="ds-upload-btn" style="margin-top:14px" ' +
    'onclick="PricingUI&amp;&amp;PricingUI.openModal&amp;&amp;PricingUI.openModal()">' +
    "&#8593; Upload Dataset</button></div>";

  function render() {
    P = root.PricingData;
    if (!P) return;
    BACKEND = backend();
    var bk = backend();
    var isUp = bk && bk.train;
    var offline = bk && bk.offline && !bk.train;
    var stepsEl = document.getElementById("ml-steps");
    if (stepsEl) {
      if (!P.active()) stepsEl.innerHTML = "";
      else if (offline) stepsEl.innerHTML = steps("upload", 2) +
        '<p class="ml-empty" style="margin:10px 2px 0">Backend unreachable \u2014 dataset mirrored in-browser; restart the backend and re-upload to run the full ML pipeline.</p>';
      else stepsEl.innerHTML = steps("upload", isUp ? 4 : 2);
    }
    var body = document.getElementById("ml-root");
    if (!body) return;
    body.className = "ml-body";
    if (!P.active()) body.innerHTML = EMPTY_ML;
    else if (isUp) uploadPanel(body);
    else if (offline) {
      body.innerHTML = '<div class="ml-empty" style="padding:14px">Backend ML pipeline offline. The uploaded rows are still ' +
        "available for descriptive analytics, but model metrics and price recommendations need the backend.</div>";
      destroyChart("ml-up-compare"); destroyChart("ml-up-imp"); destroyChart("ml-up-avp");
    }
  }

  root.PricingML = { render: render, steps: steps };
})(typeof window !== "undefined" ? window : globalThis);