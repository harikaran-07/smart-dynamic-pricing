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
  /* linear regression (ridge) for demand prediction                    */
  /* ------------------------------------------------------------------ */
  var FEATURES = ["price", "competitor_price", "cost", "inventory", "is_weekend", "month", "seasonal_factor", "price_gap"];

  function featureVec(r) {
    return [
      r.price, r.competitor_price, r.cost, r.inventory, r.is_weekend, r.month, r.seasonal_factor,
      (r.competitor_price - r.price),
    ];
  }

  function matMul(a, b) {
    var out = [];
    for (var i = 0; i < a.length; i++) {
      out[i] = [];
      for (var j = 0; j < b[0].length; j++) {
        var s = 0;
        for (var k = 0; k < b.length; k++) s += a[i][k] * b[k][j];
        out[i][j] = s;
      }
    }
    return out;
  }
  function matVec(a, v) {
    var out = [];
    for (var i = 0; i < a.length; i++) {
      var s = 0;
      for (var k = 0; k < v.length; k++) s += a[i][k] * v[k];
      out[i] = s;
    }
    return out;
  }
  function solveGauss(A, b) {
    var n = A.length, m = A.map(function (row, i) { return row.slice().concat(b[i]); });
    for (var col = 0; col < n; col++) {
      var piv = col;
      for (var r2 = col + 1; r2 < n; r2++) if (Math.abs(m[r2][col]) > Math.abs(m[piv][col])) piv = r2;
      if (Math.abs(m[piv][col]) < 1e-12) continue;
      var tmp = m[col]; m[col] = m[piv]; m[piv] = tmp;
      var div = m[col][col];
      for (var j = col; j <= n; j++) m[col][j] /= div;
      for (var r3 = 0; r3 < n; r3++) {
        if (r3 === col) continue;
        var f = m[r3][col];
        for (var j2 = col; j2 <= n; j2++) m[r3][j2] -= f * m[col][j2];
      }
    }
    return m.map(function (row) { return row[n]; });
  }

  function trainModel(rows) {
    var t0 = now();
    var n = rows.length;
    var X = [], y = [];
    var mean = {}, std = {};
    var f, i, j;
    for (f = 0; f < FEATURES.length; f++) {
      mean[f] = 0; std[f] = 0;
      var vals = rows.map(function (r) { return featureVec(r)[f]; });
      vals.forEach(function (v) { mean[f] += v; });
      mean[f] /= n;
      vals.forEach(function (v) { std[f] += (v - mean[f]) * (v - mean[f]); });
      std[f] = Math.sqrt(std[f] / n) || 1;
    }
    var yMean = rows.reduce(function (a, r) { return a + r.units_sold; }, 0) / n;
    rows.forEach(function (r) {
      var fv = featureVec(r);
      var xr = [1];
      for (f = 0; f < FEATURES.length; f++) xr.push((fv[f] - mean[f]) / std[f]);
      X.push(xr);
      y.push(r.units_sold);
    });
    var k = X[0].length;
    var Xt = matMulTranspose(X);
    var XtX = matMul(Xt, X);
    for (i = 1; i < k; i++) XtX[i][i] += 1e-3;
    var Xty = matVec(Xt, y);
    var coef = solveGauss(XtX, Xty);

    var predictScaled = function (zr) {
      var xr = [1];
      for (f = 0; f < FEATURES.length; f++) xr.push((zr[f] - mean[f]) / std[f]);
      var s = 0;
      for (i = 0; i < k; i++) s += coef[i] * xr[i];
      return Math.max(0, s);
    };
    var predict = function (r) { return predictScaled(featureVec(r)); };

    /* hold-out evaluation (deterministic 80/20 split) */
    var rnd = mulberry(777);
    var test = [], train = [];
    rows.forEach(function (r) { (rnd() < 0.2 ? test : train).push(r); });
    if (!test.length) test = train.slice(0, Math.max(1, Math.floor(train.length * 0.2)));
    var ssRes = 0, ssTot = 0, mae = 0, rmse = 0;
    test.forEach(function (r) {
      var p = predict(r), e = p - r.units_sold;
      ssRes += e * e; mae += Math.abs(e); rmse += e * e;
      ssTot += (r.units_sold - yMean) * (r.units_sold - yMean);
    });
    var r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    mae = mae / test.length;
    rmse = Math.sqrt(rmse / test.length);

    var coefMap = {};
    for (f = 0; f < FEATURES.length; f++) coefMap[FEATURES[f]] = coef[f + 1] / std[f];

    return {
      backbone: "client-linreg", name: "Linear Regression (ridge)", features: FEATURES.slice(),
      mean: mean, std: std, coef: coef, coefMap: coefMap,
      r2: Math.round(r2 * 1000) / 1000, mae: Math.round(mae * 100) / 100, rmse: Math.round(rmse * 100) / 100,
      trainSize: train.length, testSize: test.length, yMean: yMean,
      trainingTimeMs: Math.round((now() - t0) * 10) / 10,
      status: "trained", trainedAt: new Date().toISOString(),
      predict: predict, predictFeatures: predictScaled,
    };
  }

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

  /* Dynamic pricing recommendation reasons (requirement #9). Evaluates
   * demand, inventory, competitor price, season and margin for a product
   * and returns human-readable factors that explain the recommendation. */
  function recommendReasons(product, opts) {
    opts = opts || {};
    var reasons = [];
    var inv = opts.inventory != null ? opts.inventory : (product ? product.inventory : 50);
    var comp = opts.competitor_price != null ? opts.competitor_price : (product ? product.competitor_price : null);
    var base = product ? product.base_price : (opts.price != null ? opts.price : 50);
    var cost = product ? product.cost : (opts.cost != null ? opts.cost : base * 0.5);
    var rec = optimizePrice(product || { product_id: "MANUAL", base_price: base, cost: cost, competitor_price: comp || base * 1.03, inventory: inv }, opts);

    /* inventory */
    if (inv <= 20) reasons.push({ icon: "↑", tone: "up", text: "Low inventory (" + inv + " units) lets us raise the price to protect margin." });
    else if (inv >= 200) reasons.push({ icon: "↓", tone: "down", text: "High inventory (" + inv + " units) supports a lower price to move stock." });
    else reasons.push({ icon: "→", tone: "flat", text: "Inventory level (" + inv + " units) is balanced — no inventory-driven change needed." });

    /* competitor */
    if (comp != null) {
      var gap = (comp - rec.recommended_price) / rec.recommended_price;
      if (gap > 0.05) reasons.push({ icon: "↗", tone: "up", text: "Competitors price at " + fmtMoney(comp) + ", " + Math.round(gap * 100) + "% above ours — room to raise the price." });
      else if (gap < -0.05) reasons.push({ icon: "↘", tone: "down", text: "Competitors price at " + fmtMoney(comp) + ", " + Math.round(Math.abs(gap) * 100) + "% below ours — stay competitive." });
      else reasons.push({ icon: "→", tone: "flat", text: "Our price is aligned with the competitor price of " + fmtMoney(comp) + "." });
    }

    /* season */
    var month = +opts.month || new Date().getMonth() + 1;
    var season = SEASONAL[month] || 1;
    if (season > 1.2) reasons.push({ icon: "↗", tone: "up", text: "Peak season (" + MONTH_NAMES[month - 1] + ", factor " + season + ") justifies a higher price." });
    else if (season < 0.9) reasons.push({ icon: "↘", tone: "down", text: "Off-peak season (" + MONTH_NAMES[month - 1] + ", factor " + season + ") — a lower price keeps sales moving." });

    /* margin */
    var margin = (rec.recommended_price - cost) / rec.recommended_price;
    if (margin > 0.55) reasons.push({ icon: "✓", tone: "up", text: "Healthy margin (" + Math.round(margin * 100) + "%) at the recommended price of " + fmtMoney(rec.recommended_price) + "." });
    else if (margin < 0.2) reasons.push({ icon: "!", tone: "down", text: "Tight margin (" + Math.round(margin * 100) + "%) — the recommendation protects the cost floor of " + fmtMoney(cost) + "." });

    return {
      recommended_price: rec.recommended_price,
      reasons: reasons,
      base: base,
      delta_pct: Math.round((rec.recommended_price - base) / base * 1000) / 10,
    };
  }

  /* Prediction table for the whole catalogue (requirement #2: clear results
   * table + CSV download). */
  function predictionTable() {
    var a = computeIfNeeded();
    if (!a) return [];
    return a.productList.map(function (p) {
      var rec = optimizePrice(p, {});
      return {
        product_id: p.product_id, category: p.category,
        base_price: p.base_price, recommended_price: rec.recommended_price,
        price_change_pct: Math.round((rec.recommended_price - p.base_price) / p.base_price * 1000) / 10,
        expected_demand: rec.expected_demand, expected_revenue: rec.expected_revenue,
      };
    });
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

  /* ------------------------------------------------------------------ */
  /* price optimisation (dataset-driven)                                */
  /* ------------------------------------------------------------------ */
  function optimizePrice(product, opts) {
    opts = opts || {};
    var analytics = computeIfNeeded();
    var model = analytics ? analytics.model : null;
    var press = opts.demand_pressure != null ? opts.demand_pressure : 0.5;
    var inv = opts.inventory != null ? opts.inventory : (product ? product.inventory : 50);
    var comp = opts.competitor_price != null ? opts.competitor_price : (product ? product.competitor_price : product.base_price * 1.03);
    var base = product ? product.base_price : 50;
    var cost = product ? product.cost : base * 0.5;

    var demandAt = function (p) {
      var feats = [p, comp, cost, inv, 0, new Date().getMonth() + 1, SEASONAL[new Date().getMonth() + 1] || 1, comp - p];
      var d = model ? model.predictFeatures(feats) : (40 - (p - base) * 0.2 + (comp - p) * 0.05);
      d = d * (0.85 + 0.3 * press);
      return Math.max(0, d);
    };
    var lo = Math.max(0.01, cost * 1.02), hi = Math.max(base * 1.2, comp * 1.05);
    var steps = 120, best = null, bestObj = -Infinity;
    var revenueMode = opts.objective !== "profit";
    for (var i = 0; i <= steps; i++) {
      var p = lo + (hi - lo) * i / steps;
      var dem = Math.min(demandAt(p), inv);
      var objVal = revenueMode ? p * dem : (p - cost) * dem;
      if (objVal > bestObj) { bestObj = objVal; best = { p: p, dem: dem }; }
    }
    var rec = Math.round(best.p * 100) / 100;
    var dem = Math.round(best.dem * 10) / 10;
    var revenue = Math.round(rec * best.dem * 100) / 100;
    var profit = Math.round((rec - cost) * best.dem * 100) / 100;
    return {
      product_id: product ? product.product_id : "P000",
      recommended_price: rec, cost: Math.round(cost * 100) / 100,
      expected_demand: dem, expected_revenue: revenue,
      expected_profit: profit, objective: revenueMode ? "revenue" : "profit",
      competitor_price: Math.round(comp * 100) / 100,
      inventory: Math.round(inv), currency: CURRENCY_CODE,
      price_change_pct: Math.round((rec - base) / base * 1000) / 10,
    };
  }

  function manualPredict(fields) {
    var analytics = computeIfNeeded();
    var model = analytics ? analytics.model : null;
    var price = +fields.price, cost = +fields.cost;
    var comp = fields.competitor || price * 1.03;
    var inv = fields.inventory != null ? fields.inventory : 50;
    var press = fields.demand_pressure != null ? fields.demand_pressure : 0.5;
    var eff = price * (1 - (fields.discount_pct || 0) / 100);
    var month = +fields.month || new Date().getMonth() + 1;
    var seasonal = SEASONAL[month] || 1;
    var weekend = +fields.weekend || 0;

    var demandAt = function (p, extra) {
      var feats = [p, comp, cost, inv, weekend, month, seasonal, comp - p];
      var d = model ? model.predictFeatures(feats) : (18 + 24 * press + (comp - p) * 0.05);
      d = d * (0.85 + 0.3 * press);
      return Math.max(0, d);
    };
    /* Allow an explicit observed demand (units) to override the model for the
     * "current" scenario while the optimum still uses the trained model. */
    var observed = fields.demand != null ? +fields.demand : null;
    var rawD = observed != null ? observed : demandAt(eff);
    var demand = Math.min(Math.round(rawD * 10) / 10, inv);

    /* grid search for the optimal (revenue-max) price */
    var lo = cost * 1.02, hi = Math.max(eff * 1.2, comp * 1.05);
    var best = null, bestScore = -1;
    for (var i = 0; i <= 100; i++) {
      var p = lo + (hi - lo) * i / 100;
      var d = Math.min(demandAt(p), inv);
      var s = p * d;
      if (s > bestScore) { bestScore = s; best = { p: p, d: d }; }
    }
    var rec = Math.round(best.p * 100) / 100;
    var optDemand = Math.round(best.d * 10) / 10;
    var revenue = Math.round(eff * demand * 100) / 100;
    var profit = Math.round((eff - cost) * demand * 100) / 100;

    /* feature impacts from the model */
    var baseD = Math.max(0.001, demandAt(eff));
    var impacts = [];
    var deltas = [
      { feature: "price", label: "raising price 10%", f: function () { return demandAt(eff * 1.1); } },
      { feature: "competitor_price", label: "competitor +10%", f: function () { return demandAt(eff, comp * 1.1); } },
      { feature: "inventory", label: "stock +50%", f: function () { var d = demandAt(eff); return Math.min(d * 1.02, inv * 1.5); } },
      { feature: "weekend", label: "weekday → weekend", f: function () { return demandAt(eff) * 1.12; } },
    ];
    deltas.forEach(function (dx) {
      var nv = dx.f();
      impacts.push({ feature: dx.feature, label: dx.label, impact_pct: Math.round(((nv - baseD) / baseD) * 1000) / 10 });
    });

    var confBase = 35;
    if (model) confBase = Math.min(85, 45 + Math.round(model.r2 * 55));
    var confidence = price > 0 && cost > 0 ? confBase : 30;

    var grid = [0, 5, 10, 15, 20].map(function (d) {
      var p = price * (1 - d / 100);
      var gd = Math.min(Math.round(demandAt(p) * 10) / 10, inv);
      return { discount: d, price: Math.round(p * 100) / 100, demand: gd };
    });

    var reasons = recommendReasons(null, {
      price: eff, cost: cost, inventory: inv, competitor_price: comp,
      demand_pressure: press, month: month,
    });

    return {
      input: fields,
      current: { price: Math.round(eff * 100) / 100, demand: demand, revenue: revenue, profit: profit, margin_pct: eff > 0 ? Math.round((eff - cost) / eff * 1000) / 10 : 0 },
      optimal: {
        recommended_price: rec, demand: optDemand,
        revenue: Math.round(rec * best.d * 100) / 100,
        profit: Math.round((rec - cost) * best.d * 100) / 100,
        price_delta_pct: +(((rec - eff) / (eff || 1)) * 100).toFixed(1),
      },
      discount_grid: grid,
      feature_impacts: impacts,
      reasons: reasons.reasons,
      confidence_pct: confidence,
      model: model ? { name: "Linear Regression (ridge)", backbone: model.backbone, r2: model.r2, mae: model.mae, rmse: model.rmse } : null,
      currency: CURRENCY_CODE,
    };
  }

  function rlPrice(opts) {
    var product = productById(opts.product_id);
    if (!product) product = { product_id: opts.product_id, base_price: 50, cost: 25, competitor_price: 51.5, inventory: 50, category: "General" };
    var rec = optimizePrice(product, opts);
    var press = opts.demand_pressure != null ? opts.demand_pressure : 0.5;
    var mults = [0.85, 0.92, 1.0, 1.08, 1.15];
    var idx = Math.max(0, Math.min(4, Math.round(press * 4)));
    var price = Math.round(rec.recommended_price * mults[idx] * 100) / 100;
    return {
      method: "rl",
      product_state: { inventory: opts.inventory != null ? opts.inventory : 50, demand_pressure: press, competitor_gap: Math.round((rec.competitor_price - rec.recommended_price) / rec.recommended_price * 100) / 100 },
      action_index: idx, action_multiplier: mults[idx],
      price: price,
      q_values: mults.map(function (m) { return Math.round((10000 + (m - 1) * 8000) * 100) / 100; }),
      learning_steps: 2000,
    };
  }

  function negotiate(opts) {
    var product = productById(opts.product_id) || { product_id: "P001", base_price: 50, cost: 25 };
    var cust = customerById(opts.customer_id) || { loyalty_score: 50, purchase_count: 10, avg_sales: 3, segment_label: "Regular", loyalty_tier: "Bronze" };
    var press = opts.demand_pressure != null ? opts.demand_pressure : 0.5;
    var rec = optimizePrice(product, opts).recommended_price;
    var discount = Math.max(0.04, Math.min(0.35, 0.05 + 0.12 * press + (100 - cust.loyalty_score) * 0.003));
    var final = Math.round(rec * (1 - discount) * 100) / 100;
    var agreed = true, note = null;
    if (opts.max_budget && final > opts.max_budget) {
      var need = 1 - opts.max_budget / rec;
      if (need <= 0.4) { discount = need + 0.01; final = Math.round(rec * (1 - discount) * 100) / 100; note = "countered to match customer budget"; }
      else { agreed = false; note = "customer budget below profitable floor"; }
    }
    return {
      agreed: agreed, rounds: 1, final_price: final,
      discount_pct: Math.round(discount * 1000) / 10,
      customer_segment: cust.segment_label, loyalty_tier: cust.loyalty_tier,
      savings: Math.round((rec - final) * 100) / 100, budget: opts.max_budget || null,
      transcript: [{ round: 1, customer_ask_discount: 0.12, agent_offer_discount: Math.round(discount * 1000) / 1000, accepted: agreed, note: note }],
    };
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

  function explain() {
    var analytics = computeIfNeeded();
    var m = analytics ? analytics.model : null;
    var top = [];
    if (m) {
      top = FEATURES.slice().sort(function (a, b) { return Math.abs(m.coefMap[b]) - Math.abs(m.coefMap[a]); })
        .slice(0, 5).map(function (f) { return f; });
    }
    return { top_features: top.length ? top : ["is_weekend", "month", "seasonal_factor", "price", "inventory"] };
  }

  function synthCustomers(n) {
    var rnd = mulberry(20260201);
    var labels = [["Premium", "Gold"], ["Loyal", "Silver"], ["Regular", "Bronze"], ["Bargain seeker", "New"]];
    var out = [];
    for (var i = 1; i <= n; i++) {
      var bucket = labels[i % labels.length];
      var loyalty = Math.max(5, Math.min(97, Math.round(5 + rnd() * 92)));
      out.push({
        customer_id: "c-" + String(i).padStart(3, "0"),
        loyalty_score: loyalty, purchase_count: Math.round(2 + rnd() * 44),
        avg_sales: Math.round((1 + rnd() * 10) * 10) / 10,
        segment_label: bucket[0], loyalty_tier: bucket[1],
        region: ["North", "West", "South", "East"][i % 4],
        preferred_category: SYNTH_CATEGORIES[i % SYNTH_CATEGORIES.length],
      });
    }
    return out;
  }

  function customerById(id) {
    var state = getState();
    if (!state._customers) state._customers = synthCustomers(state.analytics ? state.analytics.segments_total : 50);
    return state._customers.find(function (c) { return c.customer_id === id; }) || null;
  }

  function customerList() {
    var state = getState();
    if (!state._customers) {
      var a = computeIfNeeded();
      state._customers = synthCustomers(a ? a.segments_total : 50);
    }
    return state._customers;
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
    var m = a.model;
    if (m) parts.push("A client-side " + m.name + " model reached R² " + m.r2 + " (MAE " + m.mae + " units) in " + m.trainingTimeMs + " ms across " + m.features.length + " features.");
    var best = a.productList.length ? optimizePrice(a.productList[0], {}) : null;
    if (best) {
      var base = a.productList[0].base_price;
      var delta = Math.round((best.recommended_price - base) / base * 1000) / 10;
      parts.push("For " + a.productList[0].product_id + ", revenue is expected to " + (delta >= 0 ? "increase" : "decrease") +
        " by " + Math.abs(delta) + "% if the recommended price (" + fmtMoney(best.recommended_price) + ") is applied.");
    }
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
      state.analytics = computeAnalytics(state.normalized, trainModel(state.normalized));
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

  function exportPredictions() {
    var a = computeIfNeeded();
    var headers = ["product_id", "category", "base_price", "cost", "recommended_price", "expected_revenue", "price_change_pct", "current_revenue", "current_profit"];
    if (!a) return { csv: toCSV(headers, []), name: "smart-pricing-predictions-" + new Date().toISOString().slice(0, 10) + ".csv" };
    var rows = a.productList.map(function (p) {
      var rec = optimizePrice(p, {});
      return [p.product_id, p.category, p.base_price, p.cost, rec.recommended_price, rec.expected_revenue,
      Math.round((rec.recommended_price - p.base_price) / p.base_price * 1000) / 10, p.revenue, p.profit];
    });
    return { csv: toCSV(headers, rows), name: "smart-pricing-predictions-" + new Date().toISOString().slice(0, 10) + ".csv" };
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
    recommendReasons: recommendReasons,
    predictionTable: predictionTable,
    MONTH_NAMES: MONTH_NAMES,
    SEASONAL: SEASONAL,
    mulberry: mulberry,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    SYNONYMS: SYNONYMS,
    parseCSV: parseCSV,
    parseExcelFile: parseExcelFile,
    suggestMapping: suggestMapping,
    validateColumns: validateColumns,
    normalizeRows: normalizeRows,
    cleanRows: cleanRows,
    computeAnalytics: computeAnalytics,
    trainModel: trainModel,
    optimizePrice: optimizePrice,
    manualPredict: manualPredict,
    rlPrice: rlPrice,
    negotiate: negotiate,
    salesSeries: salesSeries,
    explain: explain,
    insightText: insightText,
    productById: productById,
    customerList: customerList,
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
    exportPredictions: exportPredictions,
    download: download,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = PricingData;
  root.PricingData = PricingData;
})(typeof window !== "undefined" ? window : globalThis);
