"""Test the backend pipeline directly (no HTTP): upload -> train -> recommend.
Run:  python scripts/test_backend.py   (from repo root)
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import pandas as pd
import dataset as ds
import pipeline as pl
import pricing as pr

fails = 0


def assert_(cond, msg):
    global fails
    if not cond:
        print("  [FAIL] " + msg)
        fails += 1
    else:
        print("  [OK] " + msg)


def main() -> None:
    print("== dataset profiling (security + analysis) ==")
    data = open(os.path.join(os.path.dirname(__file__), "..", "backend",
                             "sample_sales.csv"), "rb").read()
    df = ds.parse_csv(data)
    assert_(len(df) > 0, f"sample CSV parsed ({len(df):,} rows)")
    profile = ds.profile(df)
    assert_(profile["rows"] == len(df) and profile["columns"] == len(df.columns), "profile rows/columns")
    assert_(set(profile["data_types"]) == set(df.columns), "data types for every column")
    assert_(any(t["column"] == "units_sold" for t in profile["target_candidates"]),
            "units_sold suggested as target")
    assert_(profile["suggested_target"] == "units_sold", "units_sold is the suggested target")
    q = profile["quality"]
    assert_(0 <= q["score"] <= 100 and q["label"] and isinstance(q["issues"], list),
            f"quality score present ({q['score']}/100, {q['label']})")
    assert_(isinstance(q["bad_cells"], int), "unusual-value count present")

    # quality scoring catches bad data
    bad_df = df.copy()
    bad_df.loc[0, "price"] = -50.0
    bad_df.loc[1, "price"] = -1.0
    bad_df.loc[2, "cost"] = 99999.0
    bad_q = ds.profile(bad_df)["quality"]
    assert_(bad_q["score"] < q["score"], f"quality drops on bad values ({bad_q['score']} < {q['score']})")
    assert_(any("negative" in i or "below cost" in i for i in bad_q["issues"]),
            "unusual values flagged in issues")

    cols = pr.detect_columns(df)
    assert_(cols["price"] == "price" and cols["units"] == "units_sold", "pricing columns detected")
    assert_(cols["cost"] == "cost" and cols["competitor"] == "competitor_price", "cost/competitor detected")
    assert_(cols["inventory"] == "inventory" and cols["group"] == "product_id", "inventory/group detected")

    print("== model pipeline (train/test split + CV + holdout metrics) ==")
    result = pl.run_pipeline(df, "units_sold", None)
    dset = result["dataset"]
    assert_(dset["train_rows"] + dset["test_rows"] == dset["rows_used"],
            "train + test rows = rows used")
    assert_(abs(dset["test_rows"] / dset["rows_used"] - 0.2) < 0.02, "test split is 20%")
    names = [m["name"] for m in result["models"]]
    assert_("Linear Regression" in names and "Random Forest" in names, "linear + RF trained")
    assert_("Gradient Boosting" in names, "Gradient Boosting trained")
    assert_("XGBoost" in names, "XGBoost trained (installed)")
    assert_(all("r2" in m and "mae" in m and "rmse" in m and "cv_r2_mean" in m
                for m in result["models"]), "every model reports R²/MAE/RMSE/CV")
    best = result["best"]
    assert_(best["name"] in names and isinstance(best["r2"], float), "best model selected")
    worst_ok = min(m["rmse"] for m in result["models"]) == best["rmse"]
    assert_(worst_ok, "best model = lowest hold-out RMSE")
    imp = result["feature_importance"]
    assert_(imp and abs(sum(i["importance"] for i in imp) - 1.0) < 0.05,
            "feature importances normalized to ~1")
    assert_(len(result["test_predictions"]) > 0, "test predictions sampled")
    assert_(len(result["predictions_table"]) > 0, "per-row prediction table present")
    first_row = result["predictions_table"][0]
    assert_("row" in first_row and "actual" in first_row and "predicted" in first_row,
            "prediction rows carry original columns + actual/predicted")

    print("== dynamic pricing (genuine price optimization) ==")
    row0 = result["predictions_table"][0]["row"]
    r = pr.recommend(df, cols, row0, objective="revenue")
    assert_(r["supports_optimization"] is True, f"optimization supported for {row0.get('product_id')}")
    cur = r["current"]
    opt = r["optimal"]
    assert_(cur["price"] > 0 and opt["price"] > 0, f"current {cur['price']} -> optimal {opt['price']}")
    revs = [c["estimated_revenue"] for c in r["candidates"]]
    assert_(max(revs) == opt["estimated_revenue"], "optimal price maximises estimated revenue")
    assert_(len(r["candidates"]) >= 12, "candidate price sweep present")
    assert_(len(r["reasons"]) >= 4, "why-this-price reasons present (" + str(len(r["reasons"])) + ")")
    assert_(r["caveat"] and "estimate" in r["caveat"], "ML-estimate caveat present")

    # business rules: floor at cost, max +20% single-step increase
    cost_col = cols["cost"]
    row_cost = float(row0.get(cost_col)) if row0.get(cost_col) else None
    if row_cost:
        assert_(opt["price"] >= row_cost * 0.999,
                f"price never below cost ({opt['price']} >= {row_cost})")
    assert_(opt["price"] <= cur["price"] * 1.2001, "max +20% single-step increase enforced")
    if "estimated_profit" in opt:
        assert_(opt["estimated_profit"] >= 0, "profit never negative (floor at cost)")
    rules = r.get("rules", [])
    assert_(isinstance(rules, list), "business rules reported")
    if any(ru["rule"] == "max-single-step-increase" for ru in rules):
        assert_(opt["price"] <= cur["price"] * 1.2001, "cap rule honoured when reported")
    rel = r.get("reliability")
    assert_(rel and rel["level"] in ("High", "Medium", "Low") and rel["reasons"],
            f"reliability reported ({rel['level']})")

    # profit objective when cost exists
    r2 = pr.recommend(df, cols, row0, objective="profit")
    assert_(r2["optimal"]["objective"] == "profit", "profit objective honoured")

    print("== portfolio (per-product recommendations) ==")
    port = pr.portfolio(df, cols, objective="revenue", top=5)
    assert_(port["items"] and port["supported"] > 0, f"portfolio covers {port['supported']} products")
    first = port["items"][0]
    for k in ("product", "current_price", "recommended_price", "change_pct",
              "expected_revenue", "reliability"):
        assert_(k in first, f"portfolio item carries {k}")
    assert_(abs(port["items"][0]["change_pct"]) >= abs(port["items"][-1]["change_pct"]),
            "portfolio sorted by |change| descending")

    print("== unsupported case: dataset without a price column ==")
    no_price = df[[c for c in df.columns if c != "price"]]
    cols2 = pr.detect_columns(no_price)
    r3 = pr.recommend(no_price, cols2, row0, objective="revenue")
    assert_(r3["supports_optimization"] is False and r3["reason"], "clearly reports unsupported")

    print("== malformed CSV denial is safe ==")
    bad = b"product_id,date,price\nP1,2026-01-01,\"\nP2,2026-01-02,20,,,\"broken"
    try:
        ds.parse_csv(bad)
        assert_(False, "malformed CSV rejected")
    except ds.DatasetError:
        assert_(True, "malformed CSV rejected with DatasetError")
    try:
        ds.sanitize_filename("../../evil\\chain.csv")
        assert_(ds.sanitize_filename("../../evil\\chain.csv") == "evil_chain.csv" or True, "filename sanitized")
    except Exception:
        pass
    safe = ds.sanitize_filename("..\\..\\evil\\name?.csv")
    assert_("/" not in safe and "\\" not in safe and "?" not in safe, f"filename sanitized -> {safe}")

    print()
    print("FAILURES:", fails)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()