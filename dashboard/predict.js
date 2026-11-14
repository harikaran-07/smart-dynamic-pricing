/* predict.js — Prediction Center (dataset mode only).
 *
 * Everything shown here comes from the backend:
 *   POST /api/pricing/portfolio  -> one row per product (current price, recommended
 *                                   price, change %, elasticity, R², reliability,
 *                                   expected demand / revenue / profit)
 *   POST /api/pricing/recommend  -> the selected product's candidate curve, rules,
 *                                   warnings and sensitivity table
 *
 * There is no in-browser price model and no fallback: if the backend cannot be
 * reached the page says so and offers a Retry button.
 *
 * Exposes window.PricingPredict = { mount(), render(), getMode() }.
 */
(function (root) {
  "use strict";

  var P = null; // PricingData
  var C = null; // PricingCharts
  var state = {
    objective: "profit",
    portfolio: null,
    detail: null,
    selected: null,
    loading: false,
    error: null,
    charts: [],
    token: 0,
  };

  function css() {
    var s = document.createElement("style");
    s.textContent = `
    .pp-panel{display:flex;flex-direction:column;gap:20px}
    .pp-panel > *{min-width:0}
    .pp-card{min-width:0;max-width:100%}
    .pp-steps{display:flex;gap:0;flex-wrap:wrap;background:var(--card);border:1px solid var(--border);
      border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow)}
    .pp-step{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--muted);font-weight:500}
    .pp-step .n{width:24px;height:24px;border-radius:50%;background:var(--bg);border:1px solid var(--border);
      display:grid;place-items:center;font-size:12px;font-weight:600;color:var(--muted);flex:none;
      font-family:var(--font-head)}
    .pp-step.done .n{background:var(--ok-bg);color:var(--ok-fg);border-color:var(--ok-bg)}
    .pp-step.active{color:var(--ink);font-weight:600}
    .pp-step.active .n{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
    .pp-arr{color:var(--border);margin:0 12px;font-size:14px}
    .pp-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
      padding:22px 24px;box-shadow:var(--shadow)}
    .pp-card + .pp-card{margin-top:0}
    .pp-card h3{margin:0 0 4px;font-size:17px;font-weight:600}
    .pp-card .sub{font-size:13px;color:var(--muted);margin:0 0 14px}
    .pp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:14px 0}
    .pp-kpi{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
    .pp-kpi .k{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
    .pp-kpi .v{font-family:var(--font-head);font-size:24px;font-weight:600;margin-top:4px}
    .pp-kpi .v.ok{color:var(--ok-fg)} .pp-kpi .v.bad{color:var(--bad-fg)}
    .pp-kpi .s{font-size:12px;color:var(--faint);margin-top:3px}
    .pp-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:5px 11px;
      border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--muted)}
    .pp-chip b{color:var(--ink);font-weight:600}
    .pp-chips{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 2px}
    .pp-scroll{overflow:auto;border:1px solid var(--border);border-radius:12px;max-height:420px}
    .pp-table{width:100%;min-width:640px;border-collapse:collapse;font-size:13.5px}
    .pp-table th{position:sticky;top:0;background:var(--card);color:var(--muted);font-size:12px;
      font-weight:600;text-transform:uppercase;letter-spacing:.5px;text-align:left;padding:11px 14px;
      border-bottom:1px solid var(--border);white-space:nowrap}
    .pp-table td{padding:11px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
    .pp-table tbody tr:last-child td{border-bottom:0}
    .pp-table tbody tr{cursor:pointer}
    .pp-table tbody tr:hover td{background:var(--bg)}
    .pp-table tbody tr.sel td{background:var(--bg);box-shadow:inset 3px 0 0 var(--accent)}
    .pp-table .up{color:var(--ok-fg)} .pp-table .down{color:var(--bad-fg)}
    .pp-chart{height:260px;margin-top:8px}
    .pp-chart canvas{height:100%;width:100%}
    .pp-reasons{display:grid;gap:8px;margin-top:14px}
    .pp-reason{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:12px;
      background:var(--bg);border:1px solid var(--border);font-size:13.5px;color:var(--ink);line-height:1.55}
    .pp-reason .ic{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;
      font-weight:700;font-size:12px;background:var(--card);border:1px solid var(--border)}
    .pp-reason.up .ic{background:var(--ok-bg);color:var(--ok-fg);border-color:var(--ok-bg)}
    .pp-reason.down .ic{background:var(--bad-bg);color:var(--bad-fg);border-color:var(--bad-bg)}
    .pp-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
    .pp-actions button{width:auto}
    .pp-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:end}
    .pp-form label{margin:0 0 6px}
    .pp-section-head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;
      margin:0 0 14px}
    .pp-section-head h3{margin:0;font-size:17px;font-weight:600}
    .pp-empty{padding:30px 20px;text-align:center;color:var(--muted);font-size:13.5px;
      border:1px dashed var(--border);border-radius:var(--radius);background:var(--card)}
    .pp-empty button{width:auto;margin:14px auto 0}
    .pp-toggle{display:inline-flex;gap:4px;padding:4px;border:1px solid var(--border);border-radius:999px;
      background:var(--bg)}
    .pp-toggle button{min-height:38px;padding:0 16px;border-radius:999px;background:transparent;
      color:var(--muted);font-family:var(--font-body);font-weight:600;font-size:13px}
    .pp-toggle button:hover{background:var(--card);color:var(--ink)}
    .pp-toggle button.active{background:var(--accent);color:var(--on-accent)}
    @media (max-width:560px){
      .pp-step .lbl{display:none} .pp-arr{margin:0 6px}
      .pp-actions button{width:100%}
      .pp-card,.pp-panel .pp-card{padding:18px}
    }
    @media (prefers-reduced-motion:reduce){ *{transition:none !important} }
    `;
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]);
    });
  }
  function n(v, d) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: d == null ? 0 : d });
  }
  function money(v, d) {
    return P ? P.fmtMoney(v, d == null ? 2 : d) : "$" + n(v, d);
  }
  function pct(v, d) {
    if (v == null || isNaN(v)) return "—";
    return (v > 0 ? "+" : "") + Number(v).toFixed(d == null ? 1 : d) + "%";
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
  function reliabilityPill(level) {
    var key = String(level || "").toLowerCase();
    var cls = key === "high" ? "rel-high" : key === "medium" ? "rel-medium" : "rel-low";
    return '<span class="rel ' + cls + '">' + esc(level || "—") + "</span>";
  }
  function chartColor(i) {
    if (C && C.color) return C.color(i);
    return "currentColor";
  }

  /* ------------------------- steps ------------------------- */
  function steps(active) {
    var list = ["Upload", "Profile", "Train", "Price", "Results"];
    return '<div class="pp-steps">' + list.map(function (label, i) {
      var cls = i < active ? "done" : i === active ? "active" : "";
      return '<div class="pp-step ' + cls + '"><span class="n">' + (i + 1) +
        '</span><span class="lbl">' + label + "</span></div>" +
        (i < list.length - 1 ? '<span class="pp-arr" aria-hidden="true">→</span>' : "");
    }).join("") + "</div>";
  }
  function currentStep() {
    var bk = root.PricingBackend;
    if (!bk || !bk.profile) return 1;
    if (!bk.train) return 2;
    return 4;
  }

  /* ------------------------- data access ------------------------- */
  function api() { return root.PricingApi && root.PricingApi.api; }
  function datasetId() {
    var bk = root.PricingBackend;
    return bk && bk.datasetId ? bk.datasetId : null;
  }

  function loadPortfolio() {
    var call = api();
    var id = datasetId();
    if (!call || !id) return Promise.reject(new Error(
      "The dataset has not been sent to the backend yet."));
    return call("/api/pricing/portfolio", {
      dataset_id: id,
      objective: state.objective,
      top: 50,
    });
  }

  /* The row is only *data entry* for the backend: the browser never prices it. */
  function productRow(pid) {
    var rows = P && P.rows();
    if (!rows || !rows.length) return null;
    var matches = rows.filter(function (r) { return r.product_id === pid; });
    if (!matches.length) matches = rows;
    var r = matches[matches.length - 1];
    return {
      product_id: r.product_id,
      price: r.price,
      cost: r.cost,
      competitor_price: r.competitor_price,
      inventory: r.inventory,
      units_sold: r.units_sold,
      discount_pct: r.discount,
      date: P.dateKey ? P.dateKey(r) : null,
    };
  }

  function loadDetail(pid) {
    var call = api();
    var id = datasetId();
    if (!call || !id) return Promise.reject(new Error("No backend dataset."));
    var row = productRow(pid);
    if (!row) return Promise.reject(new Error("No rows available for this product."));
    return call("/api/pricing/recommend", {
      dataset_id: id,
      objective: state.objective,
      row: row,
    });
  }

  /* ------------------------- report card ------------------------- */
  function reportCard() {
    var bk = root.PricingBackend || {};
    var profile = bk.profile || {};
    var train = bk.train || {};
    var best = train.best || null;
    var quality = profile.quality || null;
    var chips =
      '<div class="pp-chips">' +
      chip("Dataset", esc(bk.fileName || "uploaded")) +
      chip("Rows", n(profile.rows)) +
      chip("Target", esc(profile.suggested_target || "—")) +
      (profile.duplicates != null ? chip("Duplicates removed", n(profile.duplicates)) : "") +
      (quality ? chip("Data quality", quality.score + "/100 · " + esc(quality.label)) : "") +
      "</div>";

    var kpis = '<div class="pp-kpis">' +
      (best
        ? kpi("Best model", esc(best.name), "lowest hold-out RMSE") +
          kpi("Random-split R²", n(best.r2, 3), "80/20 hold-out") +
          kpi("Time-split R²", train.time_split ? n(train.time_split.r2, 3) : "—",
            "last 20% of dates held out") +
          kpi("MAE / RMSE", n(best.mae, 2) + " / " + n(best.rmse, 2), "units")
        : kpi("Model", "not trained", "upload again to retry"))
      + "</div>";

    return '<div class="pp-card"><h3>Dataset report</h3>' +
      '<p class="sub">Profiling and model metrics are computed by the backend on your uploaded CSV.</p>' +
      chips + kpis + "</div>";
  }
  function chip(label, value) {
    return '<span class="pp-chip">' + esc(label) + ": <b>" + value + "</b></span>";
  }
  function kpi(k, v, s) {
    return '<div class="pp-kpi"><div class="k">' + esc(k) + '</div><div class="v">' + v + "</div>" +
      (s ? '<div class="s">' + esc(s) + "</div>" : "") + "</div>";
  }

  /* ------------------------- prediction table ------------------------- */
  function portfolioTable(items) {
    if (!items || !items.length) {
      return '<div class="pp-empty">The backend found no product with a usable demand curve. ' +
        "Check that the CSV has price, units and several rows per product.</div>";
    }
    var rows = items.map(function (it, i) {
      var up = it.change_pct > 0, down = it.change_pct < 0;
      var sel = state.selected === it.product ? " class=\"sel\"" : "";
      return "<tr data-product=\"" + esc(it.product) + "\"" + sel + ">" +
        "<td><b>" + esc(it.product) + "</b></td>" +
        '<td class="num">' + money(it.current_price) + "</td>" +
        '<td class="num"><b>' + money(it.recommended_price) + "</b></td>" +
        '<td class="num ' + (up ? "up" : down ? "down" : "") + '">' +
          (up ? "▲ " : down ? "▼ " : "") + pct(it.change_pct) + "</td>" +
        '<td class="num">' + n(it.elasticity, 2) + "</td>" +
        '<td class="num">' + n(it.expected_demand, 1) + "</td>" +
        '<td class="num">' + money(it.expected_revenue, 0) + "</td>" +
        '<td class="num">' + (it.expected_profit != null ? money(it.expected_profit, 0) : "—") + "</td>" +
        "<td>" + reliabilityPill(it.reliability) + "</td></tr>";
    }).join("");
    return '<div class="pp-section-head"><h3>Recommendations</h3>' +
      '<span class="pp-chip">' + items.length + " products · objective: " +
      esc(state.objective) + "</span></div>" +
      '<div class="pp-scroll"><table class="pp-table"><thead><tr>' +
      ["Product", "Current", "Recommended", "Change", "Elasticity", "Demand/day",
        "Revenue/day", "Profit/day", "Reliability"].map(function (h, i) {
        return '<th' + (i > 0 ? ' class="num"' : "") + ">" + h + "</th>";
      }).join("") + "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<p style="font-size:12.5px;color:var(--muted);margin:10px 0 0">' +
      "Current price is the median of the last 14 days. Reliability is Low when R² &lt; 0.10, " +
      "the elasticity confidence interval includes zero, or there are fewer than 30 rows.</p>";
  }

  function priceChart(items) {
    if (!C || !items.length) return "";
    return '<div class="pp-card"><h3>Current vs recommended price</h3>' +
      '<p class="sub">Backend recommendation per product.</p>' +
      '<div class="pp-chart" id="pp-price-chart"><canvas></canvas></div></div>';
  }

  /* the chart must be attached to the live canvas, so it is drawn after the
   * card HTML is in the DOM (a detached canvas measures 0x0) */
  function attachPriceChart() {
    var items = state.portfolio && state.portfolio.items ? state.portfolio.items : [];
    if (!C || !items.length) return;
    var holder = document.getElementById("pp-price-chart");
    if (!holder) return;
    var canvas = holder.querySelector("canvas");
    if (!canvas) return;
    var chart = new C.Chart(canvas, {
      xLabels: items.map(function (it) { return it.product; }),
      series: [
        { name: "Current price", color: chartColor(1), type: "bar",
          data: items.map(function (it) { return it.current_price; }) },
        { name: "Recommended", color: chartColor(0), type: "bar",
          data: items.map(function (it) { return it.recommended_price; }) },
      ],
      yFmt: function (v) { return money(v, 0); },
      showValues: "bars",
    });
    state.charts.push(chart);
  }

  /* ------------------------- detail panel ------------------------- */
  function detailPanel(res) {
    if (!res || !res.supports_optimization) {
      return '<div class="pp-card"><h3>Product detail</h3>' +
        '<div class="note bad">' + esc(res && res.reason ? res.reason :
          "No recommendation available for this product.") + "</div></div>";
    }
    var opt = res.optimal, cur = res.current, dm = res.demand_model;
    var up = opt.change_pct > 0, down = opt.change_pct < 0;
    var hero =
      '<div class="hero"><div>' +
      '<div class="label">Recommended price</div>' +
      '<div class="hero-num">' + money(opt.price) + "</div>" +
      '<div class="meta">' + (up ? "▲" : down ? "▼" : "—") + " " + pct(opt.change_pct) +
      " vs " + money(cur.price) + " today · objective: " + esc(opt.objective) + "</div></div>" +
      '<div class="side">' + reliabilityPill(res.reliability.level) +
      "<br/>elasticity " + n(dm.elasticity, 2) +
      (dm.elasticity_ci95 ? " (95% CI " + n(dm.elasticity_ci95[0], 2) + " to " +
        n(dm.elasticity_ci95[1], 2) + ")" : "") +
      "<br/>R² " + n(dm.r2, 2) + " · " + n(dm.n_obs) + " rows</div></div>";

    var kpis = '<div class="pp-kpis">' +
      kpi("Units/day", n(opt.estimated_demand, 1), "today " + n(cur.estimated_demand, 1)) +
      kpi("Revenue/day", money(opt.estimated_revenue, 0), "today " + money(cur.estimated_revenue, 0)) +
      (opt.estimated_profit != null
        ? kpi("Profit/day", money(opt.estimated_profit, 0), "today " + money(cur.estimated_profit, 0))
        : "") +
      kpi("Margin", opt.margin_pct != null ? n(opt.margin_pct, 1) + "%" : "—",
        "at the recommended price") +
      "</div>";

    var rules = (res.rules && res.rules.length)
      ? '<div class="pp-reasons">' + res.rules.map(function (r) {
          return '<div class="pp-reason"><span class="ic">⚖</span><span><b>' +
            esc(r.rule) + "</b> — " + esc(r.detail) + "</span></div>";
        }).join("") + "</div>"
      : '<p class="note" style="margin-top:12px">No business rule clipped this recommendation.</p>';

    var warnings = (res.warnings && res.warnings.length)
      ? '<div class="pp-reasons">' + res.warnings.map(function (w) {
          return '<div class="pp-reason down"><span class="ic">!</span><span>' + esc(w) + "</span></div>";
        }).join("") + "</div>"
      : "";

    var reasons = (res.reasons || []).map(function (r) {
      return '<div class="pp-reason ' + esc(r.tone || "flat") + '"><span class="ic">' +
        esc(r.icon || "•") + "</span><span>" + esc(r.text) + "</span></div>";
    }).join("");

    var sens = res.sensitivity || [];
    var sensTable = sens.length
      ? '<div class="pp-scroll" style="max-height:none;margin-top:10px"><table class="pp-table"><thead><tr>' +
        ["Price change", "Price", "Demand/day", "Revenue/day", "Profit/day", "Profit change"]
          .map(function (h, i) { return '<th' + (i ? ' class="num"' : "") + ">" + h + "</th>"; }).join("") +
        "</tr></thead><tbody>" + sens.map(function (s) {
          return "<tr><td>" + pct(s.price_change_pct) + "</td>" +
            '<td class="num">' + money(s.price) + "</td>" +
            '<td class="num">' + n(s.demand, 1) + "</td>" +
            '<td class="num">' + money(s.revenue, 0) + "</td>" +
            '<td class="num">' + (s.profit != null ? money(s.profit, 0) : "—") + "</td>" +
            '<td class="num">' + (s.profit_change_pct != null ? pct(s.profit_change_pct) : "—") + "</td></tr>";
        }).join("") + "</tbody></table></div>"
      : "";

    return '<div class="pp-card"><h3>Product detail — ' + esc(state.selected) + "</h3>" +
      '<p class="sub">Candidate prices come from the fitted demand curve; the sensitivity table moves ' +
      "the recommended price by ±10%.</p>" +
      hero + kpis +
      '<h4 style="margin:18px 0 6px;font-size:14px">Applied business rules</h4>' + rules +
      warnings +
      '<h4 style="margin:18px 0 6px;font-size:14px">Why this price</h4>' +
      '<div class="pp-reasons">' + reasons + "</div>" +
      '<h4 style="margin:18px 0 6px;font-size:14px">Sensitivity</h4>' + sensTable +
      '<p style="font-size:12.5px;color:var(--muted);margin:12px 0 0">' + esc(res.caveat || "") + "</p>" +
      '<div class="pp-chart" id="pp-detail-chart"><canvas></canvas></div>' +
      '<p style="font-size:12.5px;color:var(--muted);margin:6px 0 0">Demand curve over the candidate ' +
      "grid the optimiser searched (left axis: units/day, right axis: revenue).</p>" +
      "</div>";
  }

  function detailChart(res) {
    var canvas = document.getElementById("pp-detail-chart");
    if (!canvas || !C || !res || !res.candidates || !res.candidates.length) return;
    var cand = res.candidates;
    // downsample to keep the chart readable
    var step = Math.max(1, Math.floor(cand.length / 70));
    var sample = cand.filter(function (_, i) { return i % step === 0; });
    var chart = new C.Chart(canvas.querySelector("canvas"), {
      xLabels: sample.map(function (c) { return money(c.price, 0); }),
      series: [
        { name: "Units/day", color: chartColor(2), data: sample.map(function (c) { return c.estimated_demand; }) },
        { name: "Revenue", color: chartColor(3), axis: "right",
          data: sample.map(function (c) { return c.estimated_revenue; }) },
      ],
      yFmt: function (v) { return n(v, 0); },
      yFmtRight: function (v) { return money(v, 0); },
      title: "Price sweep (" + cand.length + " candidates)",
    });
    state.charts.push(chart);
  }

  /* ------------------------- render ------------------------- */
  function errorCard(message) {
    return '<div class="pp-card"><h3>Backend unavailable</h3>' +
      '<div class="note bad" style="margin-bottom:14px">' + esc(message) + "</div>" +
      '<p class="sub">Recommendations are computed by the backend; there is no in-browser fallback, ' +
      "so nothing here would be accurate without it.</p>" +
      '<div class="pp-actions"><button type="button" id="pp-retry">Retry</button></div></div>';
  }

  function contentHtml() {
    if (!P || !P.active()) {
      return '<div class="pp-empty">No dataset loaded yet.<br/>Upload a sales CSV to train the models ' +
        "and get price recommendations.<br/>" +
        '<button type="button" class="ds-upload-btn" id="pp-upload">↑ Upload Dataset</button></div>';
    }
    var bk = root.PricingBackend;
    if (!bk || !bk.datasetId) {
      return errorCard(bk && bk.offline
        ? "The dataset could not be sent to the backend, so no model was trained."
        : "The dataset has not been sent to the backend yet.");
    }
    if (state.error) return reportCard() + errorCard(state.error);
    if (!state.portfolio) return '<div class="pp-card"><p class="sub">Loading recommendations from the backend…</p></div>';

    var items = state.portfolio.items || [];
    return reportCard() +
      '<div class="pp-card">' + portfolioTable(items) +
      '<div class="pp-actions"><button type="button" class="btn-secondary" id="pp-export">Download predictions (CSV)</button>' +
      '<button type="button" class="btn-secondary" id="pp-refresh">Refresh</button></div></div>' +
      priceChart(items) +
      (state.detail ? detailPanel(state.detail) : "");
  }

  function bind() {
    var host = document.getElementById("pp-content");
    if (!host) return;
    var up = host.querySelector("#pp-upload");
    if (up) up.onclick = function () { root.PricingUI && root.PricingUI.openModal && root.PricingUI.openModal(); };
    var retry = host.querySelector("#pp-retry");
    if (retry) retry.onclick = function () { fetchAll(true); };
    var refresh = host.querySelector("#pp-refresh");
    if (refresh) refresh.onclick = function () { fetchAll(true); };

    host.querySelectorAll(".pp-table tbody tr[data-product]").forEach(function (tr) {
      tr.onclick = function () { selectProduct(tr.getAttribute("data-product")); };
    });

    host.querySelectorAll(".pp-toggle button").forEach(function (b) {
      b.onclick = function () {
        var objective = b.getAttribute("data-objective");
        if (objective === state.objective) return;
        state.objective = objective;
        state.detail = null;
        fetchAll(true);
      };
    });

    var exp = host.querySelector("#pp-export");
    if (exp) exp.onclick = exportCsv;

    if (state.detail) detailChart(state.detail);
    attachPriceChart();
  }

  function paint() {
    var host = document.getElementById("pp-content");
    if (!host) return;
    destroyCharts();
    host.innerHTML = contentHtml();
    bind();
  }

  function fetchAll(force) {
    if (state.loading && !force) return;
    if (!P || !P.active() || !datasetId()) { paint(); return; }
    var token = ++state.token;
    state.loading = true;
    state.error = null;
    if (force) { state.portfolio = null; state.detail = null; }
    paint();

    loadPortfolio().then(function (port) {
      if (token !== state.token) return;
      state.portfolio = port;
      state.loading = false;
      var items = port.items || [];
      var wanted = state.selected && items.some(function (i) { return i.product === state.selected; })
        ? state.selected : (items[0] ? items[0].product : null);
      if (!wanted) { paint(); return; }
      return selectProduct(wanted, token);
    }).catch(function (e) {
      if (token !== state.token) return;
      state.loading = false;
      state.portfolio = null;
      state.error = e && e.message ? e.message : String(e);
      paint();
    });
  }

  function selectProduct(pid, token) {
    if (token == null) token = state.token;
    state.selected = pid;
    paint();
    return loadDetail(pid).then(function (res) {
      if (token !== state.token) return;
      state.detail = res;
      paint();
      renderSteps();
    }).catch(function (e) {
      if (token !== state.token) return;
      state.detail = { supports_optimization: false, reason: e && e.message ? e.message : String(e) };
      paint();
    });
  }

  function exportCsv() {
    if (!state.portfolio || !state.portfolio.items) return;
    var headers = ["product", "current_price", "recommended_price", "change_pct", "elasticity",
      "expected_demand", "expected_revenue", "expected_profit", "reliability"];
    var rows = state.portfolio.items.map(function (it) {
      return [it.product, it.current_price, it.recommended_price, it.change_pct, it.elasticity,
        it.expected_demand, it.expected_revenue, it.expected_profit == null ? "" : it.expected_profit,
        it.reliability];
    });
    var csv = P.toCSV(headers, rows);
    P.download("smart-pricing-predictions-" + new Date().toISOString().slice(0, 10) + ".csv", csv);
    if (root.PricingUI && root.PricingUI.toast) {
      root.PricingUI.toast("Export ready", "Backend predictions downloaded as CSV.", "ok");
    }
  }

  /* ------------------------- mount ------------------------- */
  function renderSteps() {
    var host = document.getElementById("pp-steps");
    if (!host) return;
    host.innerHTML = steps(currentStep());
  }

  function render() {
    var host = document.getElementById("pp-content");
    if (!host) {
      var legacy = document.getElementById("predict-root");
      if (!legacy) return;
    }
    renderSteps();
    if (!P || !P.active()) { state.portfolio = null; state.detail = null; paint(); return; }
    if (state.portfolio) paint();
    else fetchAll(false);
  }

  function mount() {
    var host = document.getElementById("predict-root");
    if (!host) return;
    P = root.PricingData;
    C = root.PricingCharts;
    if (!P) return;
    css();

    var panel = el(
      '<div class="pp-panel">' +
      '<div id="pp-steps"></div>' +
      '<div class="pp-card" style="padding:16px 20px"><div class="pp-section-head" style="margin:0">' +
      '<h3>Objective</h3>' +
      '<div class="pp-toggle" role="group" aria-label="Objective">' +
      '<button type="button" class="active" data-objective="profit">Maximise profit</button>' +
      '<button type="button" data-objective="revenue">Maximise revenue</button>' +
      "</div></div></div>" +
      '<div id="pp-content"></div>' +
      "</div>");

    // re-bind the objective toggle (lives outside #pp-content)
    panel.querySelectorAll(".pp-toggle button").forEach(function (b) {
      b.onclick = function () {
        var objective = b.getAttribute("data-objective");
        if (objective === state.objective) return;
        state.objective = objective;
        panel.querySelectorAll(".pp-toggle button").forEach(function (x) {
          x.classList.toggle("active", x === b);
        });
        state.detail = null;
        state.selected = null;
        fetchAll(true);
      };
    });

    host.appendChild(panel);
    renderSteps();

    document.addEventListener("pricing-api-ready", function () {
      if (P.active() && datasetId()) fetchAll(true);
      paint();
    });
    document.addEventListener("pricing-api-state", function (e) {
      // keep the retry button usable even while the API is down
      var retry = document.getElementById("pp-retry");
      if (retry) retry.disabled = false;
      if (e.detail && !e.detail.ready) state.error = state.error || null;
    });

    render();
  }

  /* --------------------------- Portfolio page -------------------------- */
  function renderPortfolio() {
    var host = document.getElementById("portfolio-root");
    if (!host) return;
    if (!P) P = root.PricingData;
    if (!P || !P.active()) {
      host.innerHTML = '<div class="pp-card"><div class="pp-empty">Upload a dataset on the Upload ' +
        "&amp; Analytics page to see portfolio recommendations.</div></div>";
      return;
    }
    if (state.error) {
      host.innerHTML = '<div class="pp-card"><div class="pp-error">' + esc(state.error.message) +
        '</div><button type="button" class="pp-btn" id="pf-retry">Retry</button></div>';
      var b = document.getElementById("pf-retry");
      if (b) b.onclick = function () { state.error = null; fetchAll(true); };
      return;
    }
    if (!state.portfolio) {
      host.innerHTML = '<div class="pp-card"><div class="pp-empty">Calculating portfolio ' +
        "recommendations…</div></div>";
      return;
    }
    var raw = state.portfolio && state.portfolio.items ? state.portfolio.items : state.portfolio;
    var items = Array.isArray(raw) ? raw : [];
    var total = items.reduce(function (acc, it) {
      if (it.expected_profit == null || it.current_profit == null) return acc;
      return acc + (it.expected_profit - it.current_profit);
    }, 0);
    var raised = items.filter(function (it) { return it.change_pct > 0; }).length;
    host.innerHTML = '<div class="pp-panel"><div class="pp-card" style="padding:18px 20px">' +
      '<div class="pp-kpis">' +
      kpi("Products", n(items.length), "with a usable demand curve") +
      kpi("Price increases", n(raised), "of " + n(items.length) + " recommendations") +
      (total ? kpi("Daily profit impact", money(total, 0), "sum of the portfolio at the recommended prices") : "") +
      "</div></div>" + portfolioTable(items) + "</div>";
  }

  root.PricingPredict = {
    mount: mount,
    renderPortfolio: renderPortfolio,
    render: render,
    refresh: render,
    getMode: function () { return "dataset"; },
    productRow: productRow,
  };
})(typeof window !== "undefined" ? window : globalThis);
