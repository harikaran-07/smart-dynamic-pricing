/* Node harness for the data pipeline (engine.js):
 *   - empty state until a dataset is uploaded (no built-in demo data)
 *   - CSV parsing, column detection/mapping, validation
 *   - normalisation + cleaning (missing values)
 *   - analytics aggregation (monthly, seasonal, profit, inventory)
 *   - client-side model metrics for the analytics cards (no price recommendations)
 *   - insight text + CSV helpers
 *
 * Price recommendation, RL, negotiation and synthetic customers were removed
 * from the browser; those live in the backend and are covered by pytest.
 */
"use strict";
const P = require("../dashboard/engine.js");

let fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error("  ✗ " + msg); fails++; }
  else console.log("  ✓ " + msg);
}

// ---- empty state until upload (no built-in demo data) ----------------
assert(P.source() === "" && !P.active(), "engine starts empty (no demo data)");
assert(P.analytics() === null, "no analytics before a dataset is uploaded");
assert(P.rows() === null, "no rows before upload");
assert(P.insightText(null) === "", "insightText handles null analytics");
assert(P.report() === null || P.report().size === 0, "empty report before upload");

// ---- removed browser-side pricing is really gone --------------------
assert(typeof P.manualPredict === "undefined", "manualPredict removed from the browser");
assert(typeof P.rlPrice === "undefined", "rlPrice removed from the browser");
assert(typeof P.negotiate === "undefined", "negotiate removed from the browser");
assert(typeof P.synthCustomers === "undefined", "synthetic customers removed");
assert(typeof P.optimizePrice === "undefined", "client price optimisation removed");
assert(typeof P.predictionTable === "undefined", "client prediction table removed");
assert(typeof P.customerList === "undefined", "customerList removed");
assert(typeof P.exportPredictions === "undefined", "client prediction export removed");
assert(typeof P.dateKey === "function", "dateKey exposed for backend rows");

// ---- CSV parsing ----------------------------------------------------
const csv = 'product_id,date,price,cost,units_sold\n' +
  'P001,2026-01-05,50,25,10\n' +
  'P002,15/06/2026,"49.99",22,8\n' +
  'P003,2026-11-10,12,5,3\n';
const parsed = P.parseCSV(csv);
assert(parsed.headers.length === 5, "CSV headers parsed (" + parsed.headers.join(",") + ")");
assert(parsed.rows.length === 3, "CSV rows parsed (" + parsed.rows.length + ")");
assert(parsed.rows[1].price === "49.99", "quoted CSV field unquoted");

// ---- mapping & validation -------------------------------------------
const map = P.suggestMapping(["product", "date", "selling_price", "qty"]);
assert(map.product_id === 0 && map.date === 1 && map.price === 2 && map.units_sold === 3,
  "fuzzy mapping suggests product/date/price/qty (" + JSON.stringify(map) + ")");
const vMissing = P.validateColumns(["date", "price"], { date: 0, price: 1 });
assert(vMissing.missing.some(m => m.field === "product_id") && vMissing.missing.some(m => m.field === "units_sold"),
  "validation flags missing product_id and units_sold");
const vOk = P.validateColumns(["product_id", "date", "price", "units_sold"], { product_id: 0, date: 1, price: 2, units_sold: 3 });
assert(vOk.ok, "validation passes when all required columns mapped");

// ---- normalisation + cleaning ----------------------------------------
const fullMap = P.suggestMapping(parsed.headers);
const norm = P.normalizeRows(parsed.rows, fullMap);
assert(norm.rows.length === 3, "all rows normalised (" + norm.rows.length + ")");
assert(norm.rows.every(r => r.units_sold > 0 && r.price > 0 && r.cost > 0), "normalised rows carry numeric price/cost/units");
assert(norm.rows[1].month === 6 && norm.rows[1].date.d === 15, "day-first dd/mm/yyyy parsed (15/06/2026)");
assert(norm.rows[2].month === 11 && norm.rows[2].holiday === 1, "month-derived holiday flagged for November");
assert(P.dateKey(norm.rows[1]) === "2026-06-15", "dateKey gives the ISO date for backend rows");
const messy = P.normalizeRows(parsed.rows.concat([{ product_id: "P004", date: "2026-01-08", price: "bad", cost: "9", units_sold: "5" }]), fullMap);
assert(messy.rows.length === 3, "rows with invalid price are dropped during normalisation");

const dirty = [
  { product_id: "X1", date: "2026-01-01", price: 10, cost: 5, competitor_price: 11, inventory: 50, units_sold: 8, is_weekend: 0, month: 1, seasonal_factor: 1, holiday: 0 },
  { product_id: "X1", date: "2026-01-02", price: 10, cost: null, competitor_price: 11, inventory: null, units_sold: 9, is_weekend: 0, month: 1, seasonal_factor: 1, holiday: 0 },
];
const cleaned = P.cleanRows(dirty);
assert(cleaned.totalMissing === 2, "cleaning counts 2 missing values (" + cleaned.totalMissing + ")");
assert(cleaned.rows[1].cost > 0 && cleaned.rows[1].inventory >= 0, "missing numerics filled with median");

// ---- upload flow -> analytics ----------------------------------------
const upRows = P.normalizeRows(parsed.rows, fullMap).rows;
P.applyUpload(upRows, { fileName: "t.csv", headers: parsed.headers, rowsParsed: 3 });
assert(P.active() && P.source() === "upload", "uploaded dataset becomes the active source");
const a = P.analytics();
assert(a.records === 3 && a.products === 3, "analytics record/product counts from uploaded data");
assert(a.model === null, "browser trains no model (backend is the only model source)");
assert(typeof P.trainModel === "undefined", "no client-side model trainer is exported");
assert(typeof P.explain === "undefined", "no client-side coefficient explanation is exported");
assert(a.best_month && a.monthly_sales[a.best_month] > 0, "best month identified");
assert(Array.isArray(a.top_profit) && a.top_profit.length, "top profit ranking present");
assert(a.low_stock && a.overstock && Array.isArray(a.inventory), "inventory risk flags present");
assert(a.segments && typeof a.segments.Premium === "number", "customer segments present");
assert(!a.productList.some(p => "recommended_price" in p), "analytics products carry no browser-computed price");

// ---- sales series ------------------------------------------------------
const sales = P.salesSeries(a.productList[0].product_id);
assert(Array.isArray(sales.units_sold) && sales.units_sold.length, "salesSeries returns daily units");

// ---- insight text + CSV helpers ---------------------------------------
const txt = P.insightText(a);
assert(/sales records/.test(txt) && /products/.test(txt), "AI summary covers records/products");
assert(/uploaded dataset/.test(txt), "insight text names the uploaded dataset");
assert(!/recommended price/.test(txt), "insight text makes no price recommendation");
const csvOut = P.toCSV(["a", "b"], [[1, "x,y"]]);
assert(csvOut.split("\n").length === 2 && /"x,y"/.test(csvOut), "toCSV quotes commas");

// ---- currency support (USD / INR / EUR / GBP) ------------------------
const curInr = P.setCurrency("INR", 83);
assert(curInr.code === "INR" && curInr.symbol === "₹" && curInr.rate === 83, "setCurrency switches to INR with custom rate");
assert(P.fmtMoney(125000, 0) === "₹1,03,75,000", "INR lakh grouping (125000 USD × 83 → ₹1,03,75,000)");
assert(P.fmtMoney(49.99, 2) === "₹4,149.17", "INR conversion of 49.99 USD (" + P.fmtMoney(49.99, 2) + ")");
const curEur = P.setCurrency("EUR", 0.92);
assert(curEur.code === "EUR" && curEur.symbol === "€" && P.fmtMoney(49.99, 2) === "€45.99", "EUR symbol + custom rate applied");
const curGbp = P.setCurrency("GBP", 0.79);
assert(curGbp.code === "GBP" && curGbp.symbol === "£" && P.fmtMoney(49.99, 2) === "£39.49", "GBP symbol + custom rate applied");
const curUsd = P.setCurrency("USD");
assert(curUsd.code === "USD" && curUsd.rate === 1, "setCurrency back to USD resets rate");
assert(P.fmtMoney(49.99, 2) === "$49.99", "USD formatting with $");
assert(P.fmtMoney(null) === "—", "fmtMoney handles null");

// ---- dataset report (analytics requirement) ---------------------------
const rep = P.report();
assert(rep.size === a.records, "report size matches records");
assert(typeof rep.duplicates === "number" && rep.duplicates >= 0, "report counts duplicate records (" + rep.duplicates + ")");
assert(typeof rep.missingValues === "number", "report counts missing values (" + rep.missingValues + ")");
assert(rep.stats.price.min <= rep.stats.price.max, "report price min ≤ max");
assert(rep.stats.units_sold.avg > 0, "report units average present");
assert(Array.isArray(rep.preview) && rep.preview.length >= 1, "report includes dataset preview");
assert(rep.preview[0].product_id && typeof rep.preview[0].price === "number", "preview rows carry product + price");

process.exit(fails ? 1 : 0);
