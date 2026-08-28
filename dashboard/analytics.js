/* analytics.js — Advanced Analytics section for the Smart Dynamic Pricing dashboard.
 *
 * Renders tabs (Overview / Pricing / Profit / Seasonal / Inventory & Pricing) using
 * the PricingCharts canvas library and the PricingData engine. All charts update
 * automatically when a new dataset is uploaded or the model is refreshed.
 *
 * Exposes window.PricingAnalytics = { mount(), render(), refresh() }.
 */
(function (root) {
  "use strict";

  var P = null; // PricingData
  var C = null; // PricingCharts
  var M = null; // MONTH_NAMES
  var state = { tab: "overview", product: null, charts: [] };

  function css() {
    var s = document.createElement("style");
    s.textContent = `
    .px-panel{background:linear-gradient(180deg,var(--card),var(--card-2));border:1px solid var(--line);
      border-radius:var(--rad);box-shadow:var(--shadow);overflow:hidden}
    .px-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;
      padding:12px 16px;border-bottom:1px solid var(--line);background:rgba(8,12,24,.35)}
    .px-tabs{display:flex;flex-wrap:wrap;gap:4px}
    .px-tab{padding:8px 14px;border-radius:9px;border:1px solid transparent;background:transparent;
      color:var(--mut);font-size:13px;font-weight:700;cursor:pointer;margin:0;width:auto;box-shadow:none}
    .px-tab:hover{color:var(--txt);background:rgba(91,140,255,.08)}
    .px-tab.active{color:var(--txt);border-color:var(--line);background:#0c1220}
    .px-actions{display:flex;gap:8px;flex-wrap:wrap}
    .px-btn{margin:0;width:auto;padding:9px 14px;border-radius:9px;font-size:13px;font-weight:700;
      background:#0c1220;border:1px solid var(--line);color:var(--txt);box-shadow:none;cursor:pointer}
    .px-btn:hover{filter:none;border-color:var(--acc);color:var(--acc)}
    .px-btn.px-primary{background:linear-gradient(135deg,var(--acc),var(--acc-2));border:0;color:#fff}
    .px-content{padding:18px}
    .px-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}
    .px-card{background:linear-gradient(180deg,var(--card),var(--card-2));border:1px solid var(--line);
      border-radius:var(--rad);padding:18px;position:relative}
    .px-card.wide{grid-column:1/-1}
    .px-card h3,.px-card h4{margin:0 0 4px;font-size:14.5px;font-weight:700}
    .px-card .sub{font-size:12px;color:var(--faint);margin:0 0 12px}
    .px-chart{height:250px;margin-top:6px}
    .px-chart.tall{height:280px}
    .px-chart canvas{height:100%;width:100%}
    .px-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:12px 0}
    .px-kpi{background:#0c1220;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
    .px-kpi .k{font-size:11px;color:var(--faint)}
    .px-kpi .v{font-size:18px;font-weight:750;margin-top:3px}
    .px-kpi .v.ok{color:var(--ok)} .px-kpi .v.bad{color:var(--bad)}
    .px-summary{margin-top:12px;padding:12px 14px;border-radius:10px;background:rgba(91,140,255,.07);
      border:1px solid rgba(91,140,255,.2);font-size:13px;line-height:1.65;color:var(--mut)}
    .px-summary b{color:var(--txt)}
    .px-chips{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 4px}
    .px-chip{font-size:12px;padding:6px 11px;border-radius:999px;border:1px solid var(--line);
      background:#0c1220;color:var(--mut);font-weight:600}
    .px-chip b{color:var(--txt)}
    .px-chip.hi{color:var(--ok);border-color:rgba(52,211,153,.35)}
    .px-chip.lo{color:var(--bad);border-color:rgba(248,113,113,.35)}
    .px-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
    .px-row label{margin:0}
    .px-row select{width:auto;min-width:170px;margin:0}
    .px-accbar{margin-top:14px}
    .px-accbar .bar{height:10px}
    .px-err{margin-top:12px;padding:12px;border-radius:10px;background:rgba(248,113,113,.1);
      border:1px solid rgba(248,113,113,.3);color:var(--bad);font-size:13px}
    @media (max-width:560px){.px-toolbar{flex-direction:column;align-items:stretch}.px-actions{width:100%}
      .px-actions .px-btn{flex:1}}
    `;
    document.head.appendChild(s);
  }

  function fmt(n, d) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN", { maximumFractionDigits: d == null ? 0 : d });
  }
  function money(n, d) { return P.fmtMoney(n, d == null ? 0 : d); }

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function chartCard(title, sub, id, tall) {
    var card = el(
      '<div class="px-card">' +
      '<h4>' + title + '</h4><p class="sub">' + sub + '</p>' +
      '<div class="px-chart' + (tall ? " tall" : "") + '"><canvas></canvas></div></div>');
    return card;
  }

  function makeChart(canvas, opts) {
    var chart = new C.Chart(canvas, opts);
    state.charts.push(chart);
    return chart;
  }

  function monthSeries(obj) {
    var labels = [], data = [];
    for (var m = 1; m <= 12; m++) { labels.push(M[m - 1]); data.push(Math.round((obj[m] || 0) * 100) / 100); }
    return { labels: labels, data: data };
  }

  /* ---------------- Overview tab ---------------- */
  function renderOverview() {
    var a = P.analytics();
    var wrap = el('<div class="px-grid"></div>');

    var model = a.model;
    var report = P.report();
    var kpis =
      kpi("Dataset size", fmt(a.records), "") +
      kpi("Features", a.features, model.name) +
      kpi("Products", a.products, a.categories ? "categories" : "") +
      kpi("Months", a.months, "time span") +
      kpi("Missing values", fmt(report.missingValues), report.missingValues ? "filled via median" : "none found") +
      kpi("Duplicate records", fmt(report.duplicates), report.duplicates ? "exact duplicates" : "none found") +
      kpi("Model R²", model.r2, "MAE " + model.mae + " units") +
      kpi("Training time", model.trainingTimeMs + " ms", "client-side training");
    var card = el('<div class="px-card wide"><h3>Automatic Model Analysis</h3>' +
      '<p class="sub">Data cleaning, feature scaling and model training run automatically on the active dataset.</p>' +
      '<div class="px-kpis">' + kpis + '</div>' +
      '<div class="px-accbar"><div class="mb"><span>R² (share of variance explained)</span><b>' + model.r2 + '</b></div>' +
      '<div class="bar"><i style="width:' + Math.min(100, Math.round(Math.max(0, model.r2) * 100)) + '%"></i></div></div>' +
      '<div class="px-summary"><b>AI summary</b> — ' + P.insightText(a) + '</div></div>');
    wrap.appendChild(card);

    return wrap;
  }

  function chip(label, value, cls) {
    return '<span class="px-chip ' + (cls || "") + '">' + label + ': <b>' + value + '</b></span>';
  }

  /* ---------------- Profit tab ---------------- */
  function renderProfit() {
    var a = P.analytics();
    var wrap = el('<div class="px-grid"></div>');
    var byProfit = a.productList.slice().sort(function (x, y) { return y.profit - x.profit; });
    var byRevenue = a.productList.slice().sort(function (x, y) { return y.revenue - x.revenue; });
    var hiP = byProfit[0], loP = byProfit[byProfit.length - 1];
    var hiR = byRevenue[0], loR = byRevenue[byRevenue.length - 1];

    var highlights = el('<div class="px-card wide"><h4>Profit &amp; Revenue Leaders</h4><div class="px-chips">' +
      chip("Highest profit product", hiP.product_id + " (" + money(hiP.profit) + ")", "hi") +
      chip("Lowest profit product", loP.product_id + " (" + money(loP.profit) + ")", "lo") +
      chip("Highest revenue product", hiR.product_id + " (" + money(hiR.revenue) + ")", "hi") +
      chip("Lowest revenue product", loR.product_id + " (" + money(loR.revenue) + ")", "lo") +
      '</div></div>');
    wrap.appendChild(highlights);

    var rtm = monthSeries(a.revenue_monthly);
    var c1 = chartCard("Revenue Trend", "Monthly revenue across the catalogue");
    wrap.appendChild(c1);
    makeChart(c1.querySelector("canvas"), {
      xLabels: rtm.labels, title: "Revenue by month",
      series: [{ name: "Revenue", color: "#5b8cff", data: rtm.data, smooth: true, area: true }],
      yFmt: function (v) { return money(v, 0); },
    });

    var ptm = monthSeries(a.profit_monthly);
    var c2 = chartCard("Profit Trend", "Monthly profit across the catalogue");
    wrap.appendChild(c2);
    makeChart(c2.querySelector("canvas"), {
      xLabels: ptm.labels, title: "Profit by month",
      series: [{ name: "Profit", color: "#34d399", data: ptm.data, smooth: true, area: true }],
      yFmt: function (v) { return money(v, 0); },
    });

    var c3 = chartCard("Revenue vs Profit", "Dual-axis comparison of revenue and profit");
    wrap.appendChild(c3);
    makeChart(c3.querySelector("canvas"), {
      xLabels: rtm.labels, title: "Revenue vs Profit",
      series: [
        { name: "Revenue", color: "#5b8cff", data: rtm.data, smooth: true, area: true, axis: "left" },
        { name: "Profit", color: "#34d399", data: ptm.data, smooth: true, axis: "right" },
      ],
      yFmt: function (v) { return money(v, 0); },
    });

    var c4 = chartCard("Profit by Product", "Total profit per product — highest and lowest highlighted");
    wrap.appendChild(c4);
    var pbp = byProfit.map(function (p) { return p.profit; });
    makeChart(c4.querySelector("canvas"), {
      xLabels: byProfit.map(function (p) { return p.product_id; }),
      series: [{ name: "Profit", color: "#8b5cf6", type: "bar", data: pbp }],
      yFmt: function (v) { return money(v, 0); }, showValues: "bars",
    });

    var c5 = chartCard("Monthly Profit", "Profit by calendar month");
    wrap.appendChild(c5);
    makeChart(c5.querySelector("canvas"), {
      xLabels: ptm.labels,
      series: [{ name: "Profit", color: "#fbbf24", type: "bar", data: ptm.data }],
      yFmt: function (v) { return money(v, 0); }, showValues: "bars",
    });

    return wrap;
  }

  /* ---------------- Seasonal tab ---------------- */
  function renderSeasonal() {
    var a = P.analytics();
    var wrap = el('<div class="px-grid"></div>');

    var ms = monthSeries(a.monthly_sales);
    var seasons = a.seasons;
    var chips = el('<div class="px-card wide"><h4>Seasonal Signals</h4><div class="px-chips">' +
      chip("Best season", a.best_season + " (" + fmt(seasons[a.best_season]) + " units)", "hi") +
      chip("Worst season", a.worst_season + " (" + fmt(seasons[a.worst_season]) + " units)", "lo") +
      chip("Best month", M[+a.best_month - 1] + " (" + fmt(a.monthly_sales[a.best_month]) + ")", "hi") +
      chip("Lowest sales month", M[+a.worst_month - 1] + " (" + fmt(a.monthly_sales[a.worst_month]) + ")", "lo") +
      chip("Holiday uplift", "+" + a.holiday_impact_pct + "%", "") +
      chip("Weekend vs weekday", a.weekend_units + " vs " + a.weekday_units + " units/day", "") +
      '</div><div class="px-summary"><b>AI insight</b> — ' + seasonalInsight(a) + '</div></div>');
    wrap.appendChild(chips);

    var c1 = chartCard("Monthly Sales", "Units sold per month — best and worst months highlighted");
    wrap.appendChild(c1);
    makeChart(c1.querySelector("canvas"), {
      xLabels: ms.labels,
      series: [{ name: "Units", color: "#5b8cff", type: "bar", data: ms.data }],
      yFmt: function (v) { return fmt(v, 0); }, showValues: "bars",
    });

    var c3 = chartCard("Holiday Impact", "Average daily units on holiday vs regular days");
    wrap.appendChild(c3);
    makeChart(c3.querySelector("canvas"), {
      xLabels: ["Regular days", "Holidays"],
      series: [{ name: "Avg daily units", color: "#fbbf24", type: "bar", data: [a.nonholiday_units, a.holiday_units] }],
      yFmt: function (v) { return fmt(v, 1); }, showValues: "bars",
    });

    var fest = festivalSeries(a);
    var c4 = chartCard("Festival Impact", "Average daily units in festival months vs the rest of the year");
    wrap.appendChild(c4);
    makeChart(c4.querySelector("canvas"), {
      xLabels: fest.labels,
      series: [{ name: "Avg daily units", color: "#f472b6", type: "bar", data: fest.data }],
      yFmt: function (v) { return fmt(v, 1); }, showValues: "bars",
    });

    var c5 = chartCard("Weekend vs Weekday", "Average daily units split by day type");
    wrap.appendChild(c5);
    makeChart(c5.querySelector("canvas"), {
      xLabels: ["Weekday", "Weekend"],
      series: [{ name: "Avg daily units", color: "#8b5cf6", type: "bar", data: [a.weekday_units, a.weekend_units] }],
      yFmt: function (v) { return fmt(v, 1); }, showValues: "bars",
    });

    return wrap;
  }

  function festivalSeries(a) {
    var rows = P.rows();
    var festMonths = { 1: true, 4: true, 11: true, 12: true };
    var fest = 0, festN = 0, reg = 0, regN = 0, all = 0, allN = 0;
    rows.forEach(function (r) {
      all += r.units_sold; allN++;
      if (festMonths[r.month]) { fest += r.units_sold; festN++; }
      else { reg += r.units_sold; regN++; }
    });
    return {
      labels: ["Regular months", "Festival months"],
      data: [Math.round(reg / Math.max(1, regN) * 10) / 10, Math.round(fest / Math.max(1, festN) * 10) / 10],
    };
  }

  function seasonalInsight(a) {
    return "Sales are strongly seasonal: " + a.best_season + " outperforms " + a.worst_season + " by " +
      Math.round((a.seasons[a.best_season] / Math.max(1, a.seasons[a.worst_season]) - 1) * 100) +
      "%. Peak month is " + M[+a.best_month - 1] + ", and holiday periods lift average sales by " +
      a.holiday_impact_pct + "% — plan inventory and promotions around " + M[+a.best_month - 1] + ".";
  }

  /* ---------------- Inventory & Pricing tab ---------------- */
  function renderInventory() {
    var a = P.analytics();
    var wrap = el('<div class="px-grid"></div>');

    var invList = a.inventory.slice().sort(function (x, y) { return y.inventory - x.inventory; });
    var invLabels = invList.map(function (i) { return i.product_id; });
    var invData = invList.map(function (i) { return i.inventory; });
    var hiInv = invList[0], loInv = invList[invList.length - 1];

    var chips = el('<div class="px-card wide"><h4>Inventory Health</h4><div class="px-chips">' +
      chip("Highest stock", hiInv.product_id + " (" + fmt(hiInv.inventory) + " units)", "hi") +
      chip("Lowest stock", loInv.product_id + " (" + fmt(loInv.inventory) + " units)", "lo") +
      (a.low_stock.length ? chip("Sell-out risk", a.low_stock.map(function (x) { return x.product_id + " (" + x.days_left + "d)"; }).join(", "), "lo") : "") +
      (a.overstock.length ? chip("Overstocked", a.overstock.map(function (x) { return x.product_id + " (" + x.days_left + "d)"; }).join(", "), "") : "") +
      '</div></div>');
    wrap.appendChild(chips);

    var c1 = chartCard("Inventory by Product", "Current stock level per product — highest/lowest highlighted");
    wrap.appendChild(c1);
    makeChart(c1.querySelector("canvas"), {
      xLabels: invLabels,
      series: [{ name: "Inventory", color: "#5b8cff", type: "bar", data: invData }],
      yFmt: function (v) { return fmt(v, 0); }, showValues: "bars",
    });

    var c2 = chartCard("Sales Trend — " + state.product, "Daily units sold for the selected product");
    wrap.appendChild(c2);
    var s = P.salesSeries(state.product);
    makeChart(c2.querySelector("canvas"), {
      xLabels: s.dates.map(function (d) { return String(d).slice(5); }),
      series: [{ name: "Units sold", color: "#34d399", data: s.units_sold, smooth: true, area: true }],
      yFmt: function (v) { return fmt(v, 0); },
    });

    var c3 = chartCard("Price Trend — " + state.product, "Average selling price per month for the selected product");
    wrap.appendChild(c3);
    var pt = priceTrend(state.product);
    makeChart(c3.querySelector("canvas"), {
      xLabels: pt.labels,
      series: [{ name: "Avg price", color: "#fbbf24", data: pt.data, smooth: true, area: true }],
      yFmt: function (v) { return money(v, 2); },
    });

    var c4 = chartCard("Days of Stock Cover", "Days until stock-out at current sell-through rate");
    wrap.appendChild(c4);
    var invDl = invList.map(function (i) { return i.days_left; });
    makeChart(c4.querySelector("canvas"), {
      xLabels: invLabels,
      series: [{ name: "Days left", color: "#f87171", type: "bar", data: invDl }],
      yFmt: function (v) { return fmt(v, 0); }, showValues: "bars",
    });

    return wrap;
  }

  function priceTrend(pid) {
    var prod = P.analytics().productList.filter(function (p) { return p.product_id === pid; })[0];
    var labels = [], data = [];
    for (var m = 1; m <= 12; m++) {
      labels.push(M[m - 1]);
      data.push(prod ? prod.base_price : null);
    }
    return { labels: labels, data: data };
  }

  /* ---------------- shared chrome ---------------- */
  function kpi(k, v, s) {
    return '<div class="px-kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
      (s ? '<div class="sub" style="font-size:11px;color:var(--faint);margin:2px 0 0">' + s + '</div>' : "") + '</div>';
  }

  /* ---------------- Dataset tab (analytics + model) ---------------- */
  function renderDataset() {
    var a = P.analytics();
    var report = P.report();
    var wrap = el('<div class="px-grid"></div>');

    var meta = P.meta();
    var name = (meta && meta.fileName) || "uploaded dataset";
    var stats = report.stats;
    var kpis =
      kpi("Dataset size", fmt(report.size), name) +
      kpi("Features", report.features, "8 modelled features") +
      kpi("Products", a.products, "in catalogue") +
      kpi("Missing values", fmt(report.missingValues), report.missingValues ? "filled via median" : "none found") +
      kpi("Duplicate records", fmt(report.duplicates), report.duplicates ? "exact duplicates" : "none found") +
      kpi("Rows in preview", report.preview.length, "first 8 shown");

    var statsGrid = '<div class="px-kpis">' +
      kpi("Price min / avg / max", money(stats.price.min) + " · " + money(stats.price.avg) + " · " + money(stats.price.max), "selling price") +
      kpi("Units min / avg / max", fmt(stats.units_sold.min) + " · " + fmt(stats.units_sold.avg, 1) + " · " + fmt(stats.units_sold.max), "units sold / day") +
      kpi("Inventory avg", fmt(stats.inventory.avg, 0), "range " + fmt(stats.inventory.min) + " – " + fmt(stats.inventory.max)) +
      '</div>';

    var previewRows = report.preview.map(function (r) {
      return '<tr><td><b>' + r.product_id + '</b></td><td>' + r.date + '</td><td>' + P.fmtMoney(r.price) +
        '</td><td>' + P.fmtMoney(r.cost) + '</td><td>' + P.fmtMoney(r.competitor_price) + '</td><td>' + fmt(r.inventory) +
        '</td><td>' + fmt(r.units_sold) + '</td></tr>';
    }).join("");
    var preview = '<div style="overflow:auto;max-height:240px"><table class="px-preview-table" style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px">' +
      '<thead><tr>' + ['Product','Date','Price','Cost','Competitor','Stock','Units'].map(function (h) { return '<th style="border:1px solid var(--line);padding:6px 8px;text-align:left;color:var(--acc)">' + h + '</th>'; }).join("") +
      '</tr></thead><tbody>' + (previewRows || '<tr><td colspan="7" style="border:1px solid var(--line);padding:6px;color:var(--faint)">No rows</td></tr>') + '</tbody></table></div>';

    var card = el('<div class="px-card wide"><h3>Dataset Analytics</h3>' +
      '<p class="sub">Size, quality checks, descriptive statistics and a preview of the active dataset.</p>' +
      '<div class="px-kpis">' + kpis + '</div>' +
      statsGrid +
      preview +
      (report.missingValues ? '<div class="px-summary"><b>Missing value handling</b> — ' + report.missingValues + ' missing value(s) were safely filled using the median of each column so the model can train.</div>' : "") +
      (report.duplicates ? '<div class="px-summary" style="background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.25)"><b>Duplicates</b> — ' + report.duplicates + ' duplicate record(s) detected. They are kept for analysis but reported for transparency.</div>' : "") +
      '</div>');
    wrap.appendChild(card);

    /* ML model card */
    var m = a.model;
    var modelCard = el('<div class="px-card wide"><h3>ML Model</h3><p class="sub">Real hold-out metrics from the client-side pricing model — no fake accuracy.</p>' +
      '<div class="px-kpis">' +
      kpi("Model used", m.name, m.backbone) +
      kpi("Training status", m.status, m.trainedAt ? new Date(m.trainedAt).toLocaleString() : "") +
      kpi("R² score", m.r2, "share of variance explained") +
      kpi("MAE", fmt(m.mae, 2) + " units", "mean absolute error") +
      kpi("RMSE", fmt(m.rmse, 2) + " units", "root mean squared error") +
      kpi("Train / test", fmt(m.trainSize) + " / " + fmt(m.testSize), "80 / 20 hold-out split") +
      kpi("Training time", fmt(m.trainingTimeMs) + " ms", "client-side") +
      '</div><div class="px-accbar"><div class="mb"><span>R² (variance explained)</span><b>' + m.r2 + '</b></div>' +
      '<div class="bar"><i style="width:' + Math.min(100, Math.round(Math.max(0, m.r2) * 100)) + '%"></i></div></div></div>');
    wrap.appendChild(modelCard);

    return wrap;
  }

  /* ---------------- Pricing tab (comparison charts) ---------------- */
  function renderPricing() {
    var a = P.analytics();
    var wrap = el('<div class="px-grid"></div>');
    var table = P.predictionTable();
    var labels = table.map(function (r) { return r.product_id; });
    var base = table.map(function (r) { return r.base_price; });
    var rec = table.map(function (r) { return r.recommended_price; });
    var revenue = table.map(function (r) { return r.expected_revenue; });
    var curRev = a.productList.map(function (p) { return Math.round(p.revenue / Math.max(1, a.months * 30)); });
    var curProfit = a.productList.map(function (p) { return Math.round(p.profit / Math.max(1, a.months * 30)); });

    /* Actual vs Recommended */
    var c1 = chartCard("Actual Price vs Recommended Price", "Current base price against the model recommendation — highest/lowest marked");
    wrap.appendChild(c1);
    makeChart(c1.querySelector("canvas"), {
      xLabels: labels,
      series: [
        { name: "Actual price", color: "#5b8cff", type: "bar", data: base },
        { name: "Recommended", color: "#34d399", type: "bar", data: rec },
      ],
      yFmt: function (v) { return P.fmtMoney(v, 0); },
    });

    /* Revenue comparison */
    var c3 = chartCard("Revenue Comparison", "Current daily revenue vs expected revenue at the recommended price");
    wrap.appendChild(c3);
    makeChart(c3.querySelector("canvas"), {
      xLabels: labels,
      series: [
        { name: "Current revenue", color: "#5b8cff", type: "bar", data: curRev },
        { name: "Expected revenue", color: "#34d399", type: "bar", data: revenue.map(function (v) { return Math.round(v); }) },
      ],
      yFmt: function (v) { return P.fmtMoney(v, 0); },
    });

    /* Profit comparison */
    var c4 = chartCard("Profit Comparison", "Current daily profit vs expected profit at the recommended price");
    wrap.appendChild(c4);
    var profitData = table.map(function (r, i) {
      return Math.round((r.recommended_price - a.productList[i].cost) * r.expected_demand);
    });
    makeChart(c4.querySelector("canvas"), {
      xLabels: labels,
      series: [
        { name: "Current profit", color: "#fbbf24", type: "bar", data: curProfit },
        { name: "Expected profit", color: "#34d399", type: "bar", data: profitData },
      ],
      yFmt: function (v) { return P.fmtMoney(v, 0); },
    });

    /* Sales/Demand trend */
    var c5 = chartCard("Sales Trend — " + state.product, "Daily units sold for the selected product (highest/lowest marked)");
    c5.classList.add("wide");
    wrap.appendChild(c5);
    var s = P.salesSeries(state.product);
    makeChart(c5.querySelector("canvas"), {
      xLabels: s.dates.map(function (d) { return String(d).slice(5); }),
      series: [{ name: "Units sold", color: "#5b8cff", data: s.units_sold, smooth: true, area: true }],
      yFmt: function (v) { return fmt(v, 0); },
    });

    /* Inventory vs Price */
    var c6 = chartCard("Inventory vs Price", "Stock level vs actual price per product (dual axis)");
    wrap.appendChild(c6);
    var invData = a.productList.map(function (p) { return p.inventory; });
    makeChart(c6.querySelector("canvas"), {
      xLabels: labels,
      series: [
        { name: "Inventory", color: "#f87171", type: "bar", data: invData, axis: "left" },
        { name: "Actual price", color: "#22d3ee", data: base, smooth: true, axis: "right" },
      ],
      yFmt: function (v) { return fmt(v, 0); },
      yFmtRight: function (v) { return P.fmtMoney(v, 0); },
    });

    /* Competitor vs Recommended */
    var c7 = chartCard("Competitor Price vs Recommended Price", "Competitor price compared to our recommended price per product");
    wrap.appendChild(c7);
    var comp = a.productList.map(function (p) { return p.competitor_price; });
    makeChart(c7.querySelector("canvas"), {
      xLabels: labels,
      series: [
        { name: "Competitor price", color: "#f472b6", data: comp, smooth: true },
        { name: "Recommended", color: "#34d399", data: rec, smooth: true },
      ],
      yFmt: function (v) { return P.fmtMoney(v, 0); },
    });

    return wrap;
  }

  function emptyState() {
    var d = document.createElement("div");
    d.className = "px-empty";
    d.innerHTML =
      '<div class="px-empty-box" style="text-align:center">' +
      '<h4>No dataset loaded</h4>' +
      '<p>Upload a CSV or Excel file with the <b>Upload Dataset</b> button to see analytics, revenue and pricing insights here.</p>' +
      '<button type="button" class="px-btn px-primary" style="margin:14px auto 0;display:block" onclick="PricingUI&amp;&amp;PricingUI.openModal&amp;&amp;PricingUI.openModal()">&#8593; Upload Dataset</button>' +
      '</div>';
    return d;
  }

  function renderTab(name) {
    var content = document.getElementById("px-content");
    state.charts.forEach(function (c) { try { c.destroy(); } catch (_) {} });
    state.charts = [];
    if (!content) return;
    var a = P.analytics();
    if (!a) {
      content.innerHTML = "";
      content.appendChild(emptyState());
      return;
    }
    var view = null;
    if (name === "overview") view = renderOverview();
    else if (name === "dataset") view = renderDataset();
    else if (name === "pricing") view = renderPricing();
    else if (name === "profit") view = renderProfit();
    else if (name === "seasonal") view = renderSeasonal();
    else if (name === "inventory") view = renderInventory();
    content.innerHTML = "";
    if (view) content.appendChild(view);
  }

  function mount() {
    var host = document.getElementById("px-root");
    if (!host) return;
    P = root.PricingData;
    C = root.PricingCharts;
    M = P.MONTH_NAMES;
    if (!P || !C) return;
    css();

    var a = P.analytics();
    state.product = a && a.productList[0] ? a.productList[0].product_id : "P001";

    var panel = el(
      '<div class="px-panel">' +
      '<div class="px-toolbar">' +
      '<div class="px-tabs">' +
      '<button class="px-tab active" data-tab="overview">Overview</button>' +
      '<button class="px-tab" data-tab="dataset">Dataset</button>' +
      '<button class="px-tab" data-tab="pricing">Pricing</button>' +
      '<button class="px-tab" data-tab="profit">Profit</button>' +
      '<button class="px-tab" data-tab="seasonal">Seasonal</button>' +
      '<button class="px-tab" data-tab="inventory">Inventory &amp; Stock</button>' +
      '</div>' +
      '<div class="px-actions">' +
      '<button class="px-btn" id="px-refresh">Refresh Model</button>' +
      '<button class="px-btn px-primary" id="px-export">Export Predictions (CSV)</button>' +
      '</div></div>' +
      '<div class="px-content" id="px-content"></div>' +
      '<div class="px-row" style="padding:0 18px 18px">' +
      '<label>Product for sales / price charts</label>' +
      '<select id="px-product"></select></div>' +
      '</div>');
    host.appendChild(panel);

    var sel = panel.querySelector("#px-product");
    if (a) {
      a.productList.forEach(function (p) { sel.add(new Option(p.product_id + " · " + p.category, p.product_id)); });
      sel.value = state.product;
    }
    sel.onchange = function () { state.product = sel.value; renderTab(state.tab); };

    panel.querySelector("#px-refresh").onclick = function () {
      var t0 = performance.now();
      P.refreshModel();
      renderTab(state.tab);
      root.PricingUI && root.PricingUI.toast("Model retrained", "Recomputed analytics in " + Math.round(performance.now() - t0) + " ms.", "ok");
    };
    panel.querySelector("#px-export").onclick = function () {
      var e = P.exportPredictions();
      P.download(e.name, e.csv);
      root.PricingUI && root.PricingUI.toast("Export ready", "Predictions CSV downloaded (" + e.name + ").", "ok");
    };

    panel.querySelectorAll(".px-tab").forEach(function (b) {
      b.onclick = function () {
        panel.querySelectorAll(".px-tab").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        state.tab = b.getAttribute("data-tab");
        renderTab(state.tab);
      };
    });

    renderTab(state.tab);
  }

  function render() { renderTab(state.tab); }

  root.PricingAnalytics = { mount: mount, render: render, refresh: render };
})(typeof window !== "undefined" ? window : globalThis);
