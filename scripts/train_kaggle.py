"""Train all models on the Kaggle dataset end-to-end.

This script:
  1. Downloads + transforms the Kaggle dataset (calls download_kaggle).
  2. Profiles the dataset (dataset.py quality scoring).
  3. Runs the ML regression pipeline (pipeline.py — Linear / RF / GB / XGBoost).
  4. Runs the pricing optimizer on every product (pricing.py).
  5. Prints a summary with model metrics and per-product recommendations.

Usage:
    python -m scripts.train_kaggle
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# Fix Unicode encoding on Windows (cp1252) so print() with special chars works
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Ensure the backend directory is on sys.path so its modules resolve
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

import pandas as pd  # noqa: E402
import dataset as ds  # noqa: E402
import pipeline as pl  # noqa: E402
import pricing as pr  # noqa: E402

# Import the Kaggle download helper
from scripts.download_kaggle import download_kaggle_dataset, transform  # noqa: E402


def main() -> None:
    t_start = time.perf_counter()

    # ── Step 1: Download & transform ──────────────────────────────────────
    print("=" * 70)
    print("  STEP 1 — Download & transform Kaggle dataset")
    print("=" * 70)
    csv_path = download_kaggle_dataset()
    raw = pd.read_csv(csv_path)
    df = transform(raw)
    print(f"  Rows: {len(df):,}  |  Columns: {list(df.columns)}")
    print()

    # ── Step 2: Profile the dataset ───────────────────────────────────────
    print("=" * 70)
    print("  STEP 2 — Dataset profiling & quality scoring")
    print("=" * 70)
    profile = ds.profile(df, preferred_target="units_sold")
    profile["filename"] = "kaggle_retail_markdown.csv"

    q = profile["quality"]
    print(f"  Quality score : {q['score']}/100  ({q['label']})")
    print(f"  Rows          : {profile['rows']:,}")
    print(f"  Columns       : {profile['columns']}")
    print(f"  Missing cells : {profile['total_missing']:,}")
    print(f"  Duplicates    : {profile['duplicates']:,}")
    print(f"  Suggested target: {profile['suggested_target']}")
    if q["issues"]:
        print("  Issues:")
        for issue in q["issues"][:5]:
            print(f"    • {issue}")
    print()

    # ── Step 3: Train ML pipeline ────────────────────────────────────────
    print("=" * 70)
    print("  STEP 3 — Training ML models (Linear / RF / GB / XGBoost)")
    print("=" * 70)
    target = "units_sold"
    # Exclude historical_sales from features to prevent data leakage:
    # Sales_After_M4 (units_sold) is derived from Historical_Sales.
    exclude_features = ["historical_sales"]
    feature_cols = [c for c in df.columns if c != target and c not in exclude_features]
    print(f"  Target: {target}")
    print(f"  Excluded (leakage): {exclude_features}")
    print(f"  80/20 split, 5-fold CV, random seed=42")
    print()

    t_train = time.perf_counter()
    result = pl.run_pipeline(df, target, features=feature_cols)
    train_seconds = time.perf_counter() - t_train

    # Print model comparison
    print(f"  {'Model':<25} {'R²':>8} {'MAE':>10} {'RMSE':>10} {'CV R²':>10}")
    print("  " + "-" * 65)
    for m in result["models"]:
        cv_str = f"{m['cv_r2_mean']:.4f}" if m["cv_r2_mean"] is not None else "N/A"
        print(f"  {m['name']:<25} {m['r2']:>8.4f} {m['mae']:>10.3f} "
              f"{m['rmse']:>10.3f} {cv_str:>10}")
    best = result["best"]
    print()
    print(f"  * Best model: {best['name']}")
    print(f"    R² = {best['r2']:.4f}  |  MAE = {best['mae']:.3f}  |  "
          f"RMSE = {best['rmse']:.3f}")
    print(f"    CV R² mean = {best['cv_r2_mean']:.4f} ± {best['cv_r2_std']:.4f}"
          if best["cv_r2_mean"] is not None else "")
    print(f"    Training time: {train_seconds:.1f}s")
    print()

    # Feature importance (top 10)
    fi = result.get("feature_importance", [])
    if fi:
        print("  Top 10 features:")
        for item in fi[:10]:
            bar = "#" * int(item["importance"] * 50)
            print(f"    {item['feature']:<30} {item['importance']:.4f}  {bar}")
    print()

    # ── Step 4: Pricing recommendations ──────────────────────────────────
    print("=" * 70)
    print("  STEP 4 — Dynamic pricing recommendations (per product)")
    print("=" * 70)
    cols = pr.detect_columns(df)
    print(f"  Detected columns: {json.dumps({k: v for k, v in cols.items() if v}, indent=4)}")
    print()

    portfolio = pr.portfolio(df, cols, objective="revenue", top=15)
    items = portfolio.get("items", [])
    if items:
        print(f"  {'Product':<15} {'Current':>10} {'Recommended':>12} "
              f"{'Change%':>10} {'Demand':>10} {'Revenue':>12} {'Elastic.':>10}")
        print("  " + "-" * 80)
        for it in items:
            print(f"  {it['product']:<15} {it['current_price']:>10.2f} "
                  f"{it['recommended_price']:>12.2f} {it['change_pct']:>9.1f}% "
                  f"{it['expected_demand']:>10.1f} {it['expected_revenue']:>12.2f} "
                  f"{it['elasticity']:>10.3f}")
    else:
        print("  No pricing recommendations available (insufficient price variation).")
    print()

    # ── Step 5: Single-product example ───────────────────────────────────
    print("=" * 70)
    print("  STEP 5 — Single-product recommendation example")
    print("=" * 70)
    if items:
        example_product = items[0]["product"]
        example_row = df[df[cols["group"]].astype(str) == str(example_product)].iloc[-1].to_dict()
        rec = pr.recommend(df, cols, example_row, objective="revenue")
        if rec.get("supports_optimization"):
            opt = rec["optimal"]
            print(f"  Product     : {example_product}")
            print(f"  Current     : ${rec['current']['price']:.2f}")
            print(f"  Recommended : ${opt['price']:.2f}  ({opt['change_pct']:+.1f}%)")
            print(f"  Exp. demand : {opt['estimated_demand']:.1f} units")
            print(f"  Exp. revenue: ${opt['estimated_revenue']:.2f}")
            print(f"  Reliability : {rec['reliability']['level']} "
                  f"({rec['reliability']['score']}/{rec['reliability']['max']})")
            if rec.get("reasons"):
                print("  Reasons:")
                for reason in rec["reasons"][:4]:
                    try:
                        print(f"    {reason['icon']} {reason['text'][:100]}")
                    except UnicodeEncodeError:
                        print(f"    > {reason['text'][:100]}")
        else:
            print(f"  Optimization not supported: {rec.get('reason', 'unknown')}")
    print()

    # ── Summary ──────────────────────────────────────────────────────────
    total = time.perf_counter() - t_start
    print("=" * 70)
    print(f"  DONE — total time: {total:.1f}s")
    print(f"  Dataset: Kaggle Retail Markdown Optimization ({len(df):,} rows)")
    print(f"  Best model: {best['name']} (R²={best['r2']:.4f})")
    print(f"  Products with recommendations: {portfolio.get('supported', 0)}"
          f"/{portfolio.get('total', 0)}")
    print("=" * 70)

    return result  # noqa: allow caller to capture


if __name__ == "__main__":
    main()
