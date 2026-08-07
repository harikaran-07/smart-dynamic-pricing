/* Node harness for the new data pipeline (engine.js):
 *   - demo dataset generation
 *   - CSV parsing, column detection/mapping, validation
 *   - normalisation + cleaning (missing values)
 *   - analytics aggregation (monthly, seasonal, profit, inventory)
 *   - client-side model training metrics (R²/MAE/RMSE/time)
 *   - price optimisation, manual prediction, RL, negotiation
 *   - demand forecast series (actual + prediction + confidence band)
 *   - assistant bundle + insight text + CSV export
 */
"use strict";
const P = require("../dashboard/engine.js");

let fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error("  ✗ " + msg); fails++; }
  else console.log("  ✓ " + msg);
}
function approx(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, msg + " (" + a + " ≈ " + b + ")");
}

// ---- demo dataset ---------------------------------------------------
const demo = P.generateDemoDataset();
assert(demo.length === 12 * 365, "demo dataset has 12 products × 365 days (" + demo.length + " rows)");
assert(demo.every(r => r.product_id && r.date && r.units_sold > 0 && r.price > 0), "demo rows have required fields");

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
assert(P.assistantBundle() !== null, "assistant bundle provided for uploaded datasets");
const a = P.analytics();
assert(a.records === 3 && a.products === 3, "analytics record/product counts from uploaded data");
assert(typeof a.model.r2 === "number" && a.model.r2 >= -1 && a.model.r2 <= 1, "model R² in valid range (" + a.model.r2 + ")");
assert(a.model.mae >= 0 && a.model.rmse >= 0, "model MAE/RMSE non-negative");
assert(a.model.trainingTimeMs >= 0, "training time recorded (" + a.model.trainingTimeMs + " ms)");
assert(a.best_month && a.monthly_sales[a.best_month] > 0, "best month identified");
assert(Array.isArray(a.top_profit) && a.top_profit.length, "top profit ranking present");
assert(a.low_stock && a.overstock && Array.isArray(a.inventory), "inventory risk flags present");
assert(a.segments && typeof a.segments.Premium === "number", "customer segments present");

// ---- price optimisation / manual / rl / negotiate / sales / explain ----
const prod = a.productList[0];
const rec = P.optimizePrice(prod, { inventory: 100, demand_pressure: 0.5 });
assert(rec.recommended_price > 0 && rec.expected_revenue > 0, "optimisePrice returns a positive recommendation");
assert(rec.product_id === prod.product_id, "optimisePrice scoped to the right product");
const man = P.manualPredict({ price: 49.99, cost: 22, inventory: 50, competitor: 55, discount_pct: 0, demand_pressure: 0.5, month: 11, weekend: 1 });
assert(man.current.demand >= 0 && man.current.revenue > 0, "manual prediction computes current scenario");
assert(man.optimal.recommended_price > 0 && typeof man.optimal.price_delta_pct === "number", "manual prediction computes optimal");
assert(man.discount_grid.length === 5 && man.feature_impacts.length >= 3, "manual discount grid + feature impacts present");
assert(Number.isInteger(man.confidence_pct), "manual confidence_pct integer");
const rl = P.rlPrice({ product_id: prod.product_id, inventory: 50, demand_pressure: 0.5 });
assert(rl.price > 0 && rl.action_index >= 0 && rl.q_values.length === 5, "rlPrice returns an action");
const neg = P.negotiate({ customer_id: "c-001", product_id: prod.product_id, demand_pressure: 0.5 });
assert(typeof neg.agreed === "boolean" && neg.final_price > 0, "negotiate returns a deal");
const sales = P.salesSeries(prod.product_id);
assert(Array.isArray(sales.units_sold) && sales.units_sold.length, "salesSeries returns daily units");
const ex = P.explain();
assert(Array.isArray(ex.top_features) && ex.top_features.length, "explain returns top features");

// ---- demand forecast series ------------------------------------------
const ds = P.demandSeries(prod.product_id, 1, 7);
assert(ds.dates.length === 8, "forecast series length = actual + horizon (" + ds.dates.length + ")");
assert(ds.actual.length === 8 && ds.predicted.length === 8, "forecast series arrays aligned");
assert(ds.actual.slice(-7).every(v => v == null), "forecast days have no actuals (null)");
assert(ds.lower.length === 8 && ds.upper.every((u, i) => u >= ds.lower[i]), "confidence band lower ≤ upper");
assert(ds.avg > 0, "average demand reference computed");

// ---- insight text + export --------------------------------------------
const txt = P.insightText(a);
assert(/sales records/.test(txt) && /products/.test(txt) && /recommended price/.test(txt), "AI summary covers records/products/recommendation");
const exp = P.exportPredictions();
assert(/product_id/.test(exp.csv) && exp.csv.split("\n").length === a.products + 1, "export CSV has header + one row per product");
assert(/smart-pricing-predictions/.test(exp.name), "export filename names the predictions file");

// ---- currency support ------------------------------------------------
const curInr = P.setCurrency("INR", 83);
assert(curInr.code === "INR" && curInr.symbol === "₹" && curInr.rate === 83, "setCurrency switches to INR with custom rate");
assert(P.fmtMoney(125000, 0) === "₹1,03,75,000", "INR lakh grouping (125000 USD × 83 → ₹1,03,75,000)");
assert(P.fmtMoney(49.99, 2) === "₹4,149.17", "INR conversion of 49.99 USD (" + P.fmtMoney(49.99, 2) + ")");
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

// ---- recommendation reasons ------------------------------------------
const rr = P.recommendReasons(prod, { inventory: 50, demand_pressure: 0.5, month: 11 });
assert(Array.isArray(rr.reasons) && rr.reasons.length >= 3, "recommendReasons returns explanations (" + rr.reasons.length + ")");
assert(rr.reasons.every(r => r.text && r.tone), "each reason has text + tone");
assert(rr.recommended_price > 0 && typeof rr.delta_pct === "number", "recommendReasons returns price + delta");
const rrHigh = P.recommendReasons(prod, { inventory: 10, demand_pressure: 0.9 });
assert(rrHigh.reasons.some(r => r.tone === "up"), "low inventory + high pressure produces upward reasons");

// ---- prediction table --------------------------------------------------
const ptab = P.predictionTable();
assert(ptab.length === a.products, "predictionTable covers every product (" + ptab.length + ")");
assert(ptab[0].recommended_price > 0 && typeof ptab[0].price_change_pct === "number", "prediction rows carry recommendation + change");

// ---- manual predict reasons + model ------------------------------------
const manR = P.manualPredict({ price: 49.99, cost: 22, inventory: 50, competitor: 55, demand_pressure: 0.5, month: 11 });
assert(Array.isArray(manR.reasons) && manR.reasons.length >= 3, "manual prediction includes dynamic reasons");
assert(manR.model && manR.model.name === "Linear Regression (ridge)", "manual prediction reports the model used");
assert(manR.optimal.recommended_price > 0, "manual prediction optimal preserved");

// ---- demo mode regression --------------------------------------------
P.applyDemo();
assert(!P.active() && P.source() === "demo", "reset returns to demo source");
assert(P.assistantBundle() === null, "no assistant bundle in demo mode (existing api() path preserved)");
const ad = P.analytics();
assert(ad.records === demo.length, "demo analytics restored (" + ad.records + " rows)");
assert(ad.holiday_impact_pct > 0 && ad.best_season === "Q4 (Oct-Dec)", "demo seasonality detected (holiday " + ad.holiday_impact_pct + "%)");

process.exit(fails ? 1 : 0);
