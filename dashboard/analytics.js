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

  /* series colours are resolved from the :root chart tokens */
  function col(i) { return (C && C.color) ? C.color(i) : "currentColor"; }

  function css() {
    var s = document.createElement("style");
    s.textContent = `
    .px-panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
      box-shadow:var(--shadow);overflow:hidden}
    .px-toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;
      padding:14px 18px;border-bottom:1px solid var(--border);background:var(--card)}
    .px-tabs{display:flex;flex-wrap:wrap;gap:4px;background:var(--bg);padding:4px;border-radius:999px;
      border:1px solid var(--border)}
    .px-tab{min-height:38px;padding:0 15px;border-radius:999px;background:transparent;color:var(--muted);
      font-family:var(--font-body);font-weight:600;font-size:13px;border:0}
    .px-tab:hover{color:var(--ink);background:var(--card)}
    .px-tab.active{background:var(--accent);color:var(--on-accent)}
    .px-actions{display:flex;gap:8px;flex-wrap:wrap}
    .px-actions button{min-height:44px;padding:0 16px;font-size:14px}
    .px-content{padding:20px}
    .px-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}
    .px-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
      padding:20px 22px;position:relative}
    .px-card.wide{grid-column:1/-1}
    .px-card h3{margin:0 0 4px;font-size:17px;font-weight:600}
    .px-card .sub{font-size:13px;color:var(--muted);margin:0 0 12px}
    .px-chart{height:250px;margin-top:6px}
    .px-chart.tall{height:280px}
    .px-chart canvas{height:100%;width:100%}
    .px-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:12px 0}
    .px-kpi{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
    .px-kpi .k{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
    .px-kpi .v{font-family:var(--font-head);font-size:22px;font-weight:600;margin-top:4px}
    .px-kpi .v.ok{color:var(--ok-fg)} .px-kpi .v.bad{color:var(--bad-fg)}
    .px-summary{margin-top:14px;padding:13px 15px;border-radius:12px;background:var(--bg);
      border:1px solid var(--border);font-size:13.5px;line-height:1.65;color:var(--ink)}
    .px-summary b{color:var(--ink)}
    .px-chips{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 4px}
    .px-chip{font-size:12.5px;padding:6px 12px;border-radius:999px;border:1px solid var(--border);
      background:var(--bg);color:var(--muted)}
    .px-chip b{color:var(--ink);font-weight:600}
    .px-chip.hi{background:var(--ok-bg);color:var(--ok-fg);border-color:var(--ok-bg)}
    .px-chip.hi b{color:var(--ok-fg)}
    .px-chip.lo{background:var(--bad-bg);color:var(--bad-fg);border-color:var(--bad-bg)}
    .px-chip.lo b{color:var(--bad-fg)}
    .px-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
    .px-row label{margin:0}
    .px-row select{width:auto;min-width:190px;margin:0}
    .px-accbar{margin-top:14px}
    .px-accbar .bar{height:10px;border-radius:999px;background:var(--bg);overflow:hidden}
    .px-accbar .bar i{display:block;height:100%;background:var(--accent)}
    .px-empty{padding:34px 20px;text-align:center;color:var(--muted);font-size:13.5px;
      border:1px dashed var(--border);border-radius:var(--radius);background:var(--card)}
    @media (max-width:560px){
      .px-toolbar{flex-direction:column;align-items:stretch}
      .px-actions{width:100%}
      .px-actions button{flex:1}
      .px-content{padding:14px}
      .px-grid{grid-template-columns:1fr}
    }
    @media (prefers-reduced-motion:reduce){ *{transition:none !important} }
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
      '<h3>' + title + '</h3><p class="sub">' + sub + '</p>' +
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

    var report = P.report();
    var kpis =
      kpi("Dataset size", fmt(a.records), "") +
      kpi("Columns used", a.features, "after cleaning") +
      kpi("Products", a.products, a.categories ? "categories" : "") +
      kpi("Months", a.months, "time span") +
      kpi("Missing values", fmt(report.missingValues), report.missingValues ? "filled via median" : "none found") +
      kpi("Duplicate records", fmt(report.duplicates), report.duplicates ? "dropped before fitting" : "none found") +
      kpi("Best month", a.best_month || "—", "highest unit sales") +
      kpi("Weekend effect", a.weekend_units + " u/day", "vs " + a.weekday_units + " on weekdays");
    var card = el('<div class="px-card wide"><h3>Dataset Overview</h3>' +
      '<p class="sub">Descriptive statistics of the active dataset. Predictive metrics and price recommendations come from the backend.</p>' +
      '<div class="px-kpis">' + kpis + '</div>' +
      '<div class="px-summary"><b>Summary</b> — ' + P.insightText(a) + '</div></div>');
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

    var highlights = el('<div class="px-card wide"><h3>Profit &amp; Revenue Leaders</h3><div class="px-chips">' +
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
      series: [{ name: "Revenue", color: col(0), data: rtm.data, smooth: true, area: true }],
      yFmt: function (v) { return money(v, 0); },
    });

    var ptm = monthSeries(a.profit_monthly);
    var c2 = chartCard("Profit Trend", "Monthly profit across the catalogue");
    wrap.appendChild(c2);
    makeChart(c2.querySelector("canvas"), {
      xLabels: ptm.labels, title: "Profit by month",
      series: [{ name: "Profit", color: col(2), data: ptm.data, smooth: true, area: true }],
      yFmt: function (v) { return money(v, 0); },
    });

    var c3 = chartCard("Revenue vs Profit", "Dual-axis comparison of revenue and profit");
    wrap.appendChild(c3);
    makeChart(c3.querySelector("canvas"), {
      xLabels: rtm.labels, title: "Revenue vs Profit",
      series: [
        { name: "Revenue", color: col(0), data: rtm.data, smooth: true, area: true, axis: "left" },
        { name: "Profit", color: col(2), data: ptm.data, smooth: true, axis: "right" },
      ],
      yFmt: function (v) { return money(v, 0); },
    });

    var c4 = chartCard("Profit by Product", "Total profit per product — highest and lowest highlighted");
    wrap.appendChild(c4);
    var pbp = byProfit.map(function (p) { return p.profit; });
    makeChart(c4.querySelector("canvas"), {
      xLabels: byProfit.map(function (p) { return p.product_id; }),
      series: [{ name: "Profit", color: col(4), type: "bar", data: pbp }],
      yFmt: function (v) { return money(v, 0); }, showValues: "bars",
    });

    var c5 = chartCard("Monthly Profit", "Profit by calendar month");
    wrap.appendChild(c5);
    makeChart(c5.querySelector("canvas"), {
      xLabels: ptm.labels,
      series: [{ name: "Profit", color: col(3), type: "bar", data: ptm.data }],
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
    var chips = el('<div class="px-card wide"><h3>Seasonal Signals</h3><div class="px-chips">' +
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
      series: [{ name: "Units", color: col(0), type: "bar", data: ms.data }],
      yFmt: function (v) { return fmt(v, 0); }, showValues: "bars",
    });

    var c3 = chartCard("Holiday Impact", "Average daily units on holiday vs regular days");
    wrap.appendChild(c3);
    makeChart(c3.querySelector("canvas"), {
      xLabels: ["Regular days", "Holidays"],
      series: [{ name: "Avg daily units", color: col(3), type: "bar", data: [a.nonholiday_units, a.holiday_units] }],
      yFmt: function (v) { return fmt(v, 1); }, showValues: "bars",
    });

    var fest = festivalSeries(a);
    var c4 = chartCard("Festival Impact", "Average daily units in festival months vs the rest of the year");
    wrap.appendChild(c4);
    makeChart(c4.querySelector("canvas"), {
      xLabels: fest.labels,
      series: [{ name: "Avg daily units", color: col(1), type: "bar", data: fest.data }],
      yFmt: function (v) { return fmt(v, 1); }, showValues: "bars",
    });

    var c5 = chartCard("Weekend vs Weekday", "Average daily units split by day type");
    wrap.appendChild(c5);
    makeChart(c5.querySelector("canvas"), {
      xLabels: ["Weekday", "Weekend"],
      series: [{ name: "Avg daily units", color: col(4), type: "bar", data: [a.weekday_units, a.weekend_units] }],
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

    var chips = el('<div class="px-card wide"><h3>Inventory Health</h3><div class="px-chips">' +
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
      series: [{ name: "Inventory", color: col(0), type: "bar", data: invData }],
      yFmt: function (v) { return fmt(v, 0); }, showValues: "bars",
    });

    var c2 = chartCard("Sales Trend — " + state.product, "Daily units sold for the selected product");
    wrap.appendChild(c2);
    var s = P.salesSeries(state.product);
    makeChart(c2.querySelector("canvas"), {
      xLabels: s.dates.map(function (d) { return String(d).slice(5); }),
      series: [{ name: "Units sold", color: col(2), data: s.units_sold, smooth: true, area: true }],
      yFmt: function (v) { return fmt(v, 0); },
    });

    var c3 = chartCard("Price Trend — " + state.product, "Average selling price per month for the selected product");
    wrap.appendChild(c3);
    var pt = priceTrend(state.product);
    makeChart(c3.querySelector("canvas"), {
      xLabels: pt.labels,
      series: [{ name: "Avg price", color: col(3), data: pt.data, smooth: true, area: true }],
      yFmt: function (v) { return money(v, 2); },
    });

    var c4 = chartCard("Days of Stock Cover", "Days until stock-out at current sell-through rate");
    wrap.appendChild(c4);
    var invDl = invList.map(function (i) { return i.days_left; });
    makeChart(c4.querySelector("canvas"), {
      xLabels: invLabels,
      series: [{ name: "Days left", color: col(4), type: "bar", data: invDl }],
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

    return wrap;
  }

  /* ---------------- Pricing tab (observed prices & demand) ----------------
   * No price is computed in the browser: every series below is a statistic of
   * the uploaded rows. Recommendations live on the Predict page and come from
   * the backend. */
  function renderPricing() {
    var a = P.analytics();
    var wrap = el('<div class="px-grid"></div>');
    var list = a.productList;
    var labels = list.map(function (p) { return p.product_id; });
    var prices = list.map(function (p) { return p.base_price; });
    var units = list.map(function (p) { return p.avg_daily; });
    var days = Math.max(1, a.months * 30);
    var revDay = list.map(function (p) { return Math.round(p.revenue / days); });
    var profDay = list.map(function (p) { return Math.round(p.profit / days); });
    var comp = list.map(function (p) { return p.competitor_price; });

    var c1 = chartCard("Price and demand by product",
      "Median observed price (left axis) against average daily units (right axis)");
    wrap.appendChild(c1);
    makeChart(c1.querySelector("canvas"), {
      xLabels: labels,
      series: [
        { name: "Median price", color: col(0), type: "bar", data: prices, axis: "left" },
        { name: "Units/day", color: col(2), data: units, axis: "right" },
      ],
      yFmt: function (v) { return money(v, 0); },
      yFmtRight: function (v) { return fmt(v, 1); },
    });

    var c2 = chartCard("Revenue and profit per day",
      "Observed daily revenue and profit per product (total / days in the data)");
    wrap.appendChild(c2);
    makeChart(c2.querySelector("canvas"), {
      xLabels: labels,
      series: [
        { name: "Revenue/day", color: col(0), type: "bar", data: revDay },
        { name: "Profit/day", color: col(2), type: "bar", data: profDay },
      ],
      yFmt: function (v) { return money(v, 0); },
    });

    var c3 = chartCard("Our price vs competitor price",
      "Median observed prices per product - the gap is descriptive, not a recommendation");
    wrap.appendChild(c3);
    makeChart(c3.querySelector("canvas"), {
      xLabels: labels,
      series: [
        { name: "Our price", color: col(0), data: prices, smooth: true },
        { name: "Competitor", color: col(1), data: comp, smooth: true },
      ],
      yFmt: function (v) { return money(v, 0); },
    });

    var c4 = chartCard("Price trend - " + state.product,
      "Average selling price per month for the selected product");
    c4.classList.add("wide");
    wrap.appendChild(c4);
    var pt = priceTrend(state.product);
    makeChart(c4.querySelector("canvas"), {
      xLabels: pt.labels,
      series: [{ name: "Average price", color: col(0), data: pt.data, smooth: true, area: true }],
      yFmt: function (v) { return money(v, 2); },
    });

    var c5 = chartCard("Units sold - " + state.product,
      "Daily units for the selected product (highest and lowest marked)");
    c5.classList.add("wide");
    wrap.appendChild(c5);
    var s = P.salesSeries(state.product);
    makeChart(c5.querySelector("canvas"), {
      xLabels: s.dates.map(function (d) { return String(d).slice(5); }),
      series: [{ name: "Units sold", color: col(2), data: s.units_sold, smooth: true, area: true }],
      yFmt: function (v) { return fmt(v, 0); },
    });

    return wrap;
  }

  function emptyState() {
    var d = document.createElement("div");
    d.className = "px-empty";
    d.innerHTML =
      '<div class="px-empty-box" style="text-align:center">' +
      '<h3>No dataset loaded</h3>' +
      '<p>Upload a CSV or Excel file with the <b>Upload Dataset</b> button to see analytics, revenue and pricing insights here.</p>' +
      '<button type="button" class="ds-upload-btn" style="margin:14px auto 0;display:block" onclick="PricingUI&amp;&amp;PricingUI.openModal&amp;&amp;PricingUI.openModal()">&#8593; Upload Dataset</button>' +
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
      '<button class="px-tab mode-btn active" type="button" data-tab="overview">Overview</button>' +
      '<button class="px-tab mode-btn" type="button" data-tab="dataset">Dataset</button>' +
      '<button class="px-tab mode-btn" type="button" data-tab="pricing">Pricing</button>' +
      '<button class="px-tab mode-btn" type="button" data-tab="profit">Profit</button>' +
      '<button class="px-tab mode-btn" type="button" data-tab="seasonal">Seasonal</button>' +
      '<button class="px-tab mode-btn" type="button" data-tab="inventory">Inventory &amp; Stock</button>' +
      '</div>' +
      '<div class="px-actions">' +
      '<button class="btn-secondary" type="button" id="px-refresh">Refresh analytics</button>' +
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

    panel.querySelectorAll(".mode-btn").forEach(function (b) {
      b.onclick = function () {
        panel.querySelectorAll(".mode-btn").forEach(function (x) { x.classList.remove("active"); });
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
