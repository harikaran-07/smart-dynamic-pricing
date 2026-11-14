/* engine.js — data pipeline + analytics + client-side ML for the
 * Smart Dynamic Pricing dashboard.
 *
 * Responsibilities:
 *   - CSV / Excel parsing, schema validation, column mapping, normalisation
 *   - data cleaning (missing values), feature scaling, client-side linear
 *     regression model, R²/MAE/RMSE + training time
 *   - analytics aggregation (demand, revenue, profit, seasonality, inventory)
 *   - price optimisation / manual prediction / RL / negotiation using the
 *     active dataset
 *
 * Browser: window.PricingData    Node: module.exports
 */
(function (root) {
  "use strict";

  var now = (typeof performance !== "undefined") ? function () { return performance.now(); } : function () { return Date.now(); };

  function mulberry(seed) {
    seed |= 0;
    return function () {
      seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  var SYNTH_CATEGORIES = ["Electronics", "Apparel", "Beauty", "Home & Kitchen", "Sports"];

  /* Seasonal curve per month (index 1..12). */
  var SEASONAL = { 1: 1.12, 2: 0.92, 3: 1.0, 4: 1.02, 5: 0.96, 6: 0.84, 7: 0.78, 8: 0.88, 9: 1.08, 10: 1.32, 11: 1.5, 12: 1.24 };
  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* ------------------------------------------------------------------ */
  /* currency support                                                    */
  /* ------------------------------------------------------------------ */
  var CURRENCY_CODE = "USD";
  var CURRENCY = "$";
  var EXCHANGE_RATES = { USD: 1, INR: 83, EUR: 0.92, GBP: 0.79 };
  var EXCHANGE_RATE = 1;
  var CURRENCY_LOCALE = "en-US";

  /* Set the active display currency. code is one of "USD" / "INR".
   * rate optionally overrides the conversion rate (defaults per currency). */
  function setCurrency(code, rate) {
    code = String(code || "USD").toUpperCase();
    CURRENCY_CODE = EXCHANGE_RATES[code] != null ? code : "USD";
    CURRENCY = CURRENCY_CODE === "INR" ? "\u20B9" : CURRENCY_CODE === "EUR" ? "\u20AC" : CURRENCY_CODE === "GBP" ? "\u00A3" : "$";
    EXCHANGE_RATE = (rate != null && isFinite(rate) && rate > 0) ? +rate : EXCHANGE_RATES[CURRENCY_CODE];
    CURRENCY_LOCALE = CURRENCY_CODE === "INR" ? "en-IN" : CURRENCY_CODE === "EUR" ? "en-IE" : CURRENCY_CODE === "GBP" ? "en-GB" : "en-US";
    return getCurrency();
  }

  function getCurrency() {
    return { code: CURRENCY_CODE, symbol: CURRENCY, rate: EXCHANGE_RATE };
  }

  /* Format a number as money in the active currency. Values are interpreted
   * as USD internally and converted by EXCHANGE_RATE when displayed. INR uses
   * Indian digit grouping (lakh/crore), e.g. 125000 -> ₹1,25,000. */
  function fmtMoney(n, decimals) {
    if (n == null || isNaN(n)) return "\u2014";
    var v = n * EXCHANGE_RATE;
    return CURRENCY + Number(v).toLocaleString(CURRENCY_LOCALE, {
      maximumFractionDigits: decimals == null ? 2 : decimals,
    });
  }

  /* ------------------------------------------------------------------ */
  /* CSV / Excel parsing                                                */
  /* ------------------------------------------------------------------ */
  function parseCSV(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    var rows = [];
    var headers = null;
    var row = [], field = "", inQ = false, c, i;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === "," || c === "\n") {
        row.push(field); field = "";
        if (c === "\n") { if (row.length) rows.push(row); row = []; }
      } else if (c !== "\r") {
        field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return { headers: [], rows: [] };
    headers = rows.shift().map(function (h) { return String(h).trim(); });
    var objs = rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ""; }); })
      .map(function (r) {
        var o = {};
        headers.forEach(function (h, idx) { o[h] = r[idx] != null ? String(r[idx]).trim() : ""; });
        return o;
      });
    return { headers: headers, rows: objs };
  }

  function parseExcelFile(file, cb) {
    if (typeof XLSX === "undefined") {
      var script = document.createElement("script");
      script.src = "https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js";
      script.onload = function () { _xlsxWork(file, cb); };
      script.onerror = function () { cb(new Error("Excel parsing needs internet access to load the spreadsheet parser.")); };
      document.head.appendChild(script);
      return;
    }
    _xlsxWork(file, cb);
  }

  function _xlsxWork(file, cb) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var json = XLSX.utils.sheet_to_json(ws, { defval: "" });
        var headers = json.length ? Object.keys(json[0]) : [];
        var rows = json.map(function (r) {
          var o = {};
          headers.forEach(function (h) { o[h] = String(r[h] == null ? "" : r[h]).trim(); });
          return o;
        });
        cb(null, { headers: headers, rows: rows });
      } catch (err) {
        cb(err);
      }
    };
    reader.onerror = function () { cb(new Error("Could not read the file.")); };
    reader.readAsArrayBuffer(file);
  }

  /* ------------------------------------------------------------------ */
  /* schema, mapping, normalisation                                     */
  /* ------------------------------------------------------------------ */
  var REQUIRED_FIELDS = [
    { field: "product_id", label: "Product ID", hard: true },
    { field: "date", label: "Date", hard: true },
    { field: "price", label: "Selling Price", hard: true },
    { field: "units_sold", label: "Units Sold", hard: true },
    { field: "cost", label: "Cost", hard: false },
    { field: "category", label: "Category", hard: false },
    { field: "competitor_price", label: "Competitor Price", hard: false },
    { field: "inventory", label: "Inventory", hard: false },
    { field: "is_weekend", label: "Is Weekend", hard: false },
    { field: "month", label: "Month", hard: false },
    { field: "seasonal_factor", label: "Seasonal Factor", hard: false },
    { field: "holiday", label: "Holiday Flag", hard: false },
  ];

  var SYNONYMS = {
    product_id: ["product", "productid", "pid", "sku", "item", "product_id"],
    date: ["date", "day", "orderdate", "date", "datetime", "order_date", "sale_date"],
    price: ["price", "sellingprice", "sale_price", "unitprice", "list_price", "rate"],
    units_sold: ["units_sold", "quantity", "qty", "units", "sales", "quantity_sold", "demand", "unitsordered"],
    cost: ["cost", "costprice", "unitcost", "cogs", "cost_of_goods"],
    category: ["category", "productcategory", "department", "segment_name", "cat"],
    competitor_price: ["competitor_price", "competitor", "comp_price", "market_price", "competitorprice"],
    inventory: ["inventory", "stock", "stock_level", "onhand", "available", "quantity_on_hand"],
    is_weekend: ["is_weekend", "weekend", "weekend_flag"],
    month: ["month", "month_number", "m"],
    seasonal_factor: ["seasonal_factor", "seasonality", "seasonalfactor", "season"],
    holiday: ["holiday", "is_holiday", "holiday_flag", "festival"],
  };

  function normName(s) { return String(s || "").toLowerCase().replace(/[\s_\-\.]+/g, ""); }

  function suggestMapping(headers) {
    var map = {};
    var used = {};
    var norm = headers.map(function (h) { return normName(h); });
    REQUIRED_FIELDS.forEach(function (rf) {
      var best = null, bestScore = 0;
      var target = normName(rf.field);
      var syn = (SYNONYMS[rf.field] || []).map(normName);
      norm.forEach(function (n, idx) {
        if (used[idx]) return;
        var score = 0;
        if (n === target) score = 100;
        else if (syn.indexOf(n) >= 0) score = 80;
        else if (syn.some(function (s) { return s.indexOf(n) >= 0 && n.length >= 3; })) score = 60;
        else if (syn.some(function (s) { return n.indexOf(s) >= 0; })) score = 55;
        if (score > bestScore) { bestScore = score; best = idx; }
      });
      if (best != null && bestScore >= 50) { map[rf.field] = best; used[best] = true; }
      else map[rf.field] = null;
    });
    return map;
  }

  function validateColumns(headers, mapping) {
    var missing = [];
    REQUIRED_FIELDS.forEach(function (rf) {
      if (rf.hard && mapping[rf.field] == null) missing.push(rf);
    });
    return { ok: missing.length === 0, missing: missing };
  }

  function parseDate(v) {
    if (v == null) return null;
    v = String(v).trim();
    if (!v) return null;
    var m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
    var m2 = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m2) {
      var a = +m2[1], b = +m2[2], y = +m2[3];
      if (y < 100) y += 2000;
      if (a > 12) return { y: y, mo: b, d: a };
      return { y: y, mo: a, d: b };
    }
    var t = Date.parse(v);
    if (!isNaN(t)) { var dd = new Date(t); return { y: dd.getFullYear(), mo: dd.getMonth() + 1, d: dd.getDate() }; }
    return null;
  }

  function num(v) {
    if (v == null || v === "") return NaN;
    var n = Number(String(v).replace(/,/g, "").replace(/[₹$€£\s]/g, ""));
    return isNaN(n) ? NaN : n;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
  function mode(arr) {
    if (!arr.length) return "";
    var c = {}, best = null, bestN = 0;
    arr.forEach(function (x) { c[x] = (c[x] || 0) + 1; if (c[x] > bestN) { bestN = c[x]; best = x; } });
    return best;
  }

  /* Basic descriptive statistics for a numeric array. */
  function basicStats(arr) {
    var vals = (arr || []).filter(function (v) { return v != null && !isNaN(v); });
    if (!vals.length) return { min: 0, max: 0, avg: 0, count: 0 };
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return {
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      avg: Math.round(sum / vals.length * 100) / 100,
      count: vals.length,
    };
  }

  /* Count exact duplicate records (same product, date, price, units, inventory). */
  function countDuplicates(rows) {
    var seen = {}, dups = 0;
    (rows || []).forEach(function (r) {
      var key = [r.product_id, dayKey(r), r.price, r.units_sold, r.inventory].join("|");
      if (seen[key]) dups++;
      else seen[key] = true;
    });
    return dups;
  }

  /* Normalise raw rows (with a resolved column mapping) into canonical rows.
   * Derives optional fields when they are missing. */
  function normalizeRows(rawRows, mapping) {
    var out = [];
    var warnings = [];
    rawRows.forEach(function (r, idx) {
      var get = function (field) {
        var h = mapping[field];
        return h == null ? undefined : r[Object.keys(r)[h]];
      };
      var date = parseDate(get("date"));
      if (!date) return; // skip unparseable dates
      var price = num(get("price"));
      var units = num(get("units_sold"));
      if (isNaN(price) || isNaN(units)) return;
      var productId = String(get("product_id") == null ? "" : get("product_id")).trim();
      if (!productId) return;
      var cost = num(get("cost"));
      if (isNaN(cost)) cost = price * 0.5;
      var comp = num(get("competitor_price"));
      if (isNaN(comp)) comp = price * 1.03;
      var inv = num(get("inventory"));
      if (isNaN(inv)) inv = 0;
      var weekend = num(get("is_weekend"));
      if (isNaN(weekend)) weekend = date.dow === 0 || date.dow === 6 ? 1 : 0;
      var month = num(get("month"));
      if (isNaN(month)) month = date.mo;
      var seasonal = num(get("seasonal_factor"));
      if (isNaN(seasonal)) seasonal = SEASONAL[Math.max(1, Math.min(12, Math.round(month)))] || 1;
      var holiday = num(get("holiday"));
      if (isNaN(holiday)) {
        holiday = (month === 11) || (month === 12 && date.d >= 20) || (month === 1 && date.d <= 5) ||
          (month === 4 && date.d >= 10 && date.d <= 15) ? 1 : 0;
      }
      out.push({
        product_id: productId,
        date: { y: date.y, mo: date.mo, d: date.d, dow: date.dow != null ? date.dow : new Date(date.y, date.mo - 1, date.d).getDay() },
        category: String(get("category") == null ? "" : get("category")).trim() || "General",
        price: price, cost: cost, competitor_price: comp, inventory: inv,
        units_sold: units, is_weekend: weekend ? 1 : 0, month: month, seasonal_factor: seasonal, holiday: holiday ? 1 : 0,
      });
    });
    if (!out.length) warnings.push("No valid rows found after validation.");
    return { rows: out, warnings: warnings };
  }

  /* Clean numeric gaps by replacing with medians; count missing values. */
  function cleanRows(rows) {
    var NUM = ["price", "cost", "competitor_price", "inventory", "units_sold", "is_weekend", "month", "seasonal_factor", "holiday"];
    var missing = {};
    NUM.forEach(function (f) {
      var vals = rows.map(function (r) { return r[f]; }).filter(function (v) { return v != null && !isNaN(v); });
      var med = median(vals);
      rows.forEach(function (r) {
        if (r[f] == null || isNaN(r[f])) { missing[f] = (missing[f] || 0) + 1; r[f] = med; }
      });
    });
    return { rows: rows, missingValues: missing, totalMissing: Object.keys(missing).reduce(function (a, k) { return a + missing[k]; }, 0) };
  }

  /* ------------------------------------------------------------------ */
  /* feature list used for descriptive analytics                        */
  /* ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ */
  var FEATURES = ["price", "competitor_price", "cost", "inventory", "is_weekend", "month", "seasonal_factor", "price_gap"];

  /* ------------------------------------------------------------------ */
  /* analytics                                                          */
  /* ------------------------------------------------------------------ */
  function dayKey(r) {
    var d = r.date;
    if (typeof d === "string") d = parseDate(d);
    if (!d) return null;
    return d.y + "-" + pad2(d.mo) + "-" + pad2(d.d);
  }

  function computeAnalytics(rows, model) {
    var i, j, r;
    var products = {};
    rows.forEach(function (r) {
      if (!products[r.product_id]) products[r.product_id] = { product_id: r.product_id, category: r.category, prices: [], costs: [], comps: [], inventory: [], units: 0, revenue: 0, profit: 0, daily: {} };
      var p = products[r.product_id];
      p.prices.push(r.price); p.costs.push(r.cost); p.comps.push(r.competitor_price);
      p.inventory.push(r.inventory);
      p.units += r.units_sold;
      p.revenue += r.price * r.units_sold;
      p.profit += (r.price - r.cost) * r.units_sold;
      var key = dayKey(r);
      if (!key) return;
      if (!p.daily[key]) p.daily[key] = { date: key, units: 0, revenue: 0, price: 0, n: 0, weekend: r.is_weekend, month: r.month, seasonal: r.seasonal_factor };
      p.daily[key].units += r.units_sold;
      p.daily[key].revenue += r.price * r.units_sold;
      p.daily[key].price += r.price;
      p.daily[key].n += 1;
    });
    var productList = Object.keys(products).map(function (k) {
      var p = products[k];
      Object.keys(p.daily).forEach(function (dk) { p.daily[dk].price = p.daily[dk].price / p.daily[dk].n; });
      var days = Object.keys(p.daily).length;
      var avgDaily = p.units / Math.max(1, days);
      return {
        product_id: p.product_id, category: p.category,
        base_price: Math.round(median(p.prices) * 100) / 100,
        cost: Math.round(median(p.costs) * 100) / 100,
        competitor_price: Math.round(median(p.comps) * 100) / 100,
        inventory: Math.round(median(p.inventory.slice(-30).length ? p.inventory.slice(-30) : p.inventory)),
        avg_daily: Math.round(avgDaily * 10) / 10,
        days_left: Math.round(p.inventory.length ? (median(p.inventory.slice(-7)) / Math.max(0.1, avgDaily)) * 10 / 10 : 0),
        units: p.units, revenue: Math.round(p.revenue), profit: Math.round(p.profit),
        margin_pct: Math.round(((median(p.prices) - median(p.costs)) / median(p.prices)) * 1000) / 10,
        daily: p.daily,
      };
    });
    productList.sort(function (a, b) { return a.product_id < b.product_id ? -1 : 1; });

    /* catalogue-wide monthly & weekly aggregates */
    var monthly = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0 };
    var revMonthly = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0 };
    var profMonthly = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0 };
    var weekendUnits = 0, weekendN = 0, weekdayUnits = 0, weekdayN = 0;
    var holidayUnits = 0, holidayN = 0, nonholidayUnits = 0, nonholidayN = 0;
    var seasSum = {}, seasN = {};
    rows.forEach(function (r) {
      monthly[r.month] += r.units_sold;
      revMonthly[r.month] += r.price * r.units_sold;
      profMonthly[r.month] += (r.price - r.cost) * r.units_sold;
      if (r.is_weekend) { weekendUnits += r.units_sold; weekendN++; }
      else { weekdayUnits += r.units_sold; weekdayN++; }
      if (r.holiday) { holidayUnits += r.units_sold; holidayN++; }
      else { nonholidayUnits += r.units_sold; nonholidayN++; }
      seasSum[r.month] = (seasSum[r.month] || 0) + r.seasonal_factor;
      seasN[r.month] = (seasN[r.month] || 0) + 1;
    });

    var bestMonth = argmax(monthly), worstMonth = argmin(monthly);
    var seasons = {
      "Q1 (Jan-Mar)": monthly[1] + monthly[2] + monthly[3],
      "Q2 (Apr-Jun)": monthly[4] + monthly[5] + monthly[6],
      "Q3 (Jul-Sep)": monthly[7] + monthly[8] + monthly[9],
      "Q4 (Oct-Dec)": monthly[10] + monthly[11] + monthly[12],
    };
    var bestSeason = argmax(seasons), worstSeason = argmin(seasons);
    var seasonalByMonth = {};
    for (j = 1; j <= 12; j++) seasonalByMonth[j] = Math.round((seasSum[j] / Math.max(1, seasN[j])) * 100) / 100;

    /* product rankings */
    var byProfit = productList.slice().sort(function (a, b) { return b.profit - a.profit; });
    var byRevenue = productList.slice().sort(function (a, b) { return b.revenue - a.revenue; });
    var topProfit = byProfit.slice(0, 5).map(function (p) { return { product_id: p.product_id, profit: p.profit, revenue: p.revenue }; });
    var topRevenue = byRevenue.slice(0, 5).map(function (p) { return { product_id: p.product_id, revenue: p.revenue, profit: p.profit }; });

    /* category revenue/profit */
    var catRev = {}, catProf = {};
    productList.forEach(function (p) {
      catRev[p.category] = (catRev[p.category] || 0) + p.revenue;
      catProf[p.category] = (catProf[p.category] || 0) + p.profit;
    });
    var bestRevCat = argmax(catRev), bestProfCat = argmax(catProf);

    /* 7-day trend per product */
    var trendProducts = {};
    productList.forEach(function (p) {
      var days = Object.keys(p.daily).sort();
      var n = days.length;
      if (n < 14) { trendProducts[p.product_id] = 0; return; }
      var recent = days.slice(-7).reduce(function (a, d) { return a + p.daily[d].units; }, 0);
      var prior = days.slice(-14, -7).reduce(function (a, d) { return a + p.daily[d].units; }, 0);
      trendProducts[p.product_id] = Math.round(recent - prior);
    });

    /* inventory flags */
    var invList = productList.map(function (p) { return { product_id: p.product_id, inventory: p.inventory, avg_daily: p.avg_daily, days_left: p.days_left }; })
      .sort(function (a, b) { return a.days_left - b.days_left; });
    var lowStock = invList.filter(function (i) { return i.days_left < 7 && i.days_left >= 0; }).slice(0, 5);
    var overstock = invList.filter(function (i) { return i.days_left > 60; }).slice(0, 5);

    /* synthetic customer segments derived from dataset volume */
    var segCount = Math.max(20, Math.min(2000, Math.round(rows.length / 12)));
    var segments = {
      Premium: Math.round(segCount * 0.19), Loyal: Math.round(segCount * 0.3),
      Regular: Math.round(segCount * 0.31), "Bargain seeker": segCount - Math.round(segCount * 0.19) - Math.round(segCount * 0.3) - Math.round(segCount * 0.31),
    };

    var totalUnits = rows.reduce(function (a, r) { return a + r.units_sold; }, 0);
    var totalRevenue = productList.reduce(function (a, p) { return a + p.revenue; }, 0);
    var minDate = null;
    rows.forEach(function (r) {
      var k = dayKey(r);
      if (k && (!minDate || k < minDate)) minDate = k;
    });

    return {
      records: rows.length, products: productList.length, features: FEATURES.length,
      months: Object.keys(monthly).filter(function (m) { return monthly[m] > 0; }).length,
      productList: productList,
      monthly_sales: monthly, revenue_monthly: revMonthly, profit_monthly: profMonthly,
      best_month: bestMonth, worst_month: worstMonth,
      seasons: seasons, best_season: bestSeason, worst_season: worstSeason,
      seasonal_by_month: seasonalByMonth,
      weekday_units: weekdayN ? Math.round(weekdayUnits / weekdayN * 10) / 10 : 0,
      weekend_units: weekendN ? Math.round(weekendUnits / weekendN * 10) / 10 : 0,
      holiday_units: holidayN ? Math.round(holidayUnits / holidayN * 10) / 10 : 0,
      nonholiday_units: nonholidayN ? Math.round(nonholidayUnits / nonholidayN * 10) / 10 : 0,
      holiday_impact_pct: nonholidayN ? Math.round((holidayUnits / holidayN - nonholidayUnits / nonholidayN) / (nonholidayUnits / nonholidayN) * 100) : 0,
      top_profit: topProfit, top_revenue: topRevenue,
      best_revenue_category: { name: bestRevCat, revenue: Math.round(catRev[bestRevCat] || 0) },
      best_profit_category: { name: bestProfCat, profit: Math.round(catProf[bestProfCat] || 0) },
      cat_revenue: catRev, cat_profit: catProf,
      trend_products: trendProducts,
      low_stock: lowStock, overstock: overstock, inventory: invList.slice(0, 8),
      segments: segments, segments_total: segCount,
      total_units: totalUnits, total_revenue: Math.round(totalRevenue),
      min_date: minDate,
      model: model,
    };
  }

  /* ------------------------------------------------------------------ */
  /* dataset report (analytics panel requirement #7)                    */
  /* ------------------------------------------------------------------ */
  function datasetReport(rows) {
    if (!rows) {
      return { size: 0, features: FEATURES.length, missingValues: 0, duplicates: 0, stats: {}, preview: [] };
    }
    var report = {
      size: rows.length,
      features: FEATURES.length,
      missingValues: 0,
      duplicates: countDuplicates(rows),
      stats: {},
      preview: rows.slice(0, 8).map(function (r) {
        return {
          product_id: r.product_id,
          date: r.date ? dayKey(r) : "",
          price: r.price, cost: r.cost, competitor_price: r.competitor_price,
          inventory: r.inventory, units_sold: r.units_sold,
        };
      }),
    };
    var statsFields = ["price", "cost", "competitor_price", "inventory", "units_sold"];
    statsFields.forEach(function (f) {
      report.stats[f] = basicStats(rows.map(function (r) { return r[f]; }));
    });
    rows.forEach(function (r) {
      statsFields.forEach(function (f) { if (r[f] == null || isNaN(r[f])) report.missingValues++; });
    });
    return report;
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function argmax(obj) {
    var best = null, bestV = -Infinity;
    Object.keys(obj).forEach(function (k) { if (obj[k] > bestV) { bestV = obj[k]; best = k; } });
    return best;
  }
  function argmin(obj) {
    var best = null, bestV = Infinity;
    Object.keys(obj).forEach(function (k) { if (obj[k] < bestV) { bestV = obj[k]; best = k; } });
    return best;
  }
  function matMulTranspose(X) {
    var n = X[0].length, out = [];
    for (var i = 0; i < n; i++) {
      out[i] = [];
      for (var j = 0; j < X.length; j++) out[i][j] = X[j][i];
    }
    return out;
  }

  function salesSeries(pid) {
    var analytics = computeIfNeeded();
    if (!analytics) return { product_id: pid, dates: [], units_sold: [] };
    var prod = analytics.productList.filter(function (p) { return p.product_id === pid; })[0];
    if (!prod) return { product_id: pid, dates: [], units_sold: [] };
    var days = Object.keys(prod.daily).sort();
    return {
      product_id: pid,
      dates: days.map(function (d) { return d; }),
      units_sold: days.map(function (d) { return prod.daily[d].units; }),
      revenue: days.map(function (d) { return Math.round(prod.daily[d].revenue); }),
    };
  }

  function productById(pid) {
    var analytics = computeIfNeeded();
    if (!analytics) return null;
    return analytics.productList.filter(function (p) { return p.product_id === pid; })[0] || null;
  }

  /* ------------------------------------------------------------------ */
  /* insight text generator                                             */
  /* ------------------------------------------------------------------ */
  function insightText(a) {
    if (!a) return "";
    var parts = [];
    var records = a.records.toLocaleString("en-IN");
    parts.push("The uploaded dataset contains " + records +
      " sales records across " + a.products + " products over " + a.months + " months.");
    var topP = a.top_profit[0];
    if (topP) parts.push("Product " + topP.product_id + " generates the highest profit (" + fmtMoney(topP.profit, 0) + ").");
    var bestCat = a.best_revenue_category;
    if (bestCat && bestCat.name) parts.push("The " + bestCat.name + " category leads revenue (" + fmtMoney(bestCat.revenue, 0) + ").");
    parts.push("Sales peak in " + MONTH_NAMES[+a.best_month - 1] + " (" + a.monthly_sales[a.best_month].toLocaleString("en-IN") +
      " units) and are weakest in " + MONTH_NAMES[+a.worst_month - 1] + ".");
    if (a.holiday_impact_pct) parts.push("Holiday periods lift average sales by " + a.holiday_impact_pct + "% vs. normal days, and weekends average " +
      a.weekend_units + " units/day vs " + a.weekday_units + " on weekdays.");
    return parts.join(" ");
  }

  /* ------------------------------------------------------------------ */
  /* state & public API                                                 */
  /* ------------------------------------------------------------------ */
  var state = {
    source: "",
    meta: null,
    normalized: null,
    missing: null,
    analytics: null,
  };

  function getState() { return state; }

  function computeIfNeeded() {
    if (!state.normalized) return null;
    if (!state.analytics) {
      state.missing = { totalMissing: 0, byColumn: {} };
      state.analytics = computeAnalytics(state.normalized, null);
    }
    return state.analytics;
  }

  function applyUpload(rows, meta) {
    state.source = "upload";
    state.meta = meta;
    state.normalized = rows;
    state.analytics = null;
    state._customers = null;
    computeIfNeeded();
  }

  function refreshModel() {
    state.analytics = null;
    computeIfNeeded();
    return state.analytics;
  }

  function toCSV(headers, rows) {
    var esc = function (v) {
      v = v == null ? "" : String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var lines = [headers.map(esc).join(",")];
    rows.forEach(function (r) { lines.push(r.map(esc).join(",")); });
    return lines.join("\n");
  }

  function download(filename, text) {
    if (typeof document === "undefined") return;
    var blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  var PricingData = {
    CURRENCY: CURRENCY,
    setCurrency: setCurrency,
    getCurrency: getCurrency,
    fmtMoney: fmtMoney,
    basicStats: basicStats,
    countDuplicates: countDuplicates,
    datasetReport: datasetReport,
    MONTH_NAMES: MONTH_NAMES,
    SEASONAL: SEASONAL,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    SYNONYMS: SYNONYMS,
    parseCSV: parseCSV,
    parseExcelFile: parseExcelFile,
    suggestMapping: suggestMapping,
    validateColumns: validateColumns,
    normalizeRows: normalizeRows,
    cleanRows: cleanRows,
    computeAnalytics: computeAnalytics,
    salesSeries: salesSeries,
    insightText: insightText,
    productById: productById,
    dateKey: dayKey,
    getState: getState,
    source: function () { return state.source; },
    active: function () { return state.source === "upload"; },
    meta: function () { return state.meta; },
    analytics: function () { return computeIfNeeded(); },
    rows: function () { computeIfNeeded(); return state.normalized; },
    report: function () { computeIfNeeded(); return datasetReport(state.normalized); },
    applyUpload: applyUpload,
    refreshModel: refreshModel,
    toCSV: toCSV,
    download: download,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = PricingData;
  root.PricingData = PricingData;
})(typeof window !== "undefined" ? window : globalThis);
