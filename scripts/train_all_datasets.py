"""Download all 5 Kaggle supermarket datasets, transform, train, and compare.

Usage:
    python -m scripts.train_all_datasets
"""
from __future__ import annotations

import os
import sys
import time
import json
from pathlib import Path

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

import pandas as pd
import numpy as np
import kagglehub
import dataset as ds
import pipeline as pl
import pricing as pr


# ---------------------------------------------------------------------------
# Dataset registry
# ---------------------------------------------------------------------------
DATASETS = [
    {
        "name": "Super Market Sales (transaction data)",
        "slug": "akashbommidi/super-market-sales",
        "file_pattern": "*.csv",
    },
    {
        "name": "Grocery Store Sales 2025",
        "slug": "pratyushpuri/grocery-store-sales-dataset-in-2025-1900-record",
        "file_pattern": "*.csv",
    },
    {
        "name": "Supermarket Sales (data analysis)",
        "slug": "faresashraf1001/supermarket-sales",
        "file_pattern": "*.csv",
    },
    {
        "name": "Superstore Dataset (4 years retail)",
        "slug": "vivek468/superstore-dataset-final",
        "file_pattern": "*.csv",
        "encoding": "latin-1",
    },
    {
        "name": "Grocery Store Dataset",
        "slug": "bhavikjikadara/grocery-store-dataset",
        "file_pattern": "*.csv",
    },
]


# ---------------------------------------------------------------------------
# Transformers — each dataset has different columns, so we map them
# ---------------------------------------------------------------------------

def _detect_quantity_col(df: pd.DataFrame) -> str | None:
    """Find the column that best represents units sold / quantity."""
    for c in df.columns:
        low = c.lower().strip()
        if low in ("quantity", "qty", "units_sold", "units sold", "units"):
            return c
    return None


def _detect_price_col(df: pd.DataFrame) -> str | None:
    """Find the column that best represents unit price."""
    for c in df.columns:
        low = c.lower().strip()
        if low in ("unit price", "unit_price", "price", "unit price"):
            return c
    return None


def _detect_product_col(df: pd.DataFrame) -> str | None:
    """Find a product/category grouping column."""
    for c in df.columns:
        low = c.lower().strip()
        if low in ("product line", "product_line", "category", "sub-category",
                    "sub_category", "product name", "product_name", "title",
                    "product_id", "product id", "aisle", "store_name"):
            return c
    return None


def transform_supermarket_sales(df: pd.DataFrame) -> pd.DataFrame:
    """Transform: akashbommidi/super-market-sales (1000 rows, 17 cols)
    Columns: Invoice ID, Branch, City, Customer type, Gender, Product line,
             Unit price, Quantity, Tax 5%, Total, Date, Time, Payment, cogs,
             gross margin percentage, gross income, Rating
    """
    rng = np.random.default_rng(42)
    n = len(df)

    qty = df["Quantity"].to_numpy(dtype=float)
    unit_price = df["Unit price"].to_numpy(dtype=float)
    cost_per_unit = df["cogs"].to_numpy(dtype=float) / np.maximum(qty, 1)

    # Derive competitor price: unit price + random variance
    comp_price = np.round(unit_price * (1 + rng.uniform(-0.10, 0.15, n)), 2)
    inventory = rng.integers(30, 200, n)

    # Parse date
    dates = pd.to_datetime(df["Date"], errors="coerce")
    date_strs = dates.dt.strftime("%Y-%m-%d").fillna("2025-01-01").values

    return pd.DataFrame({
        "product_id": [f"P{str(i+1).zfill(4)}" for i in range(n)],
        "category": df["Product line"].astype(str).values,
        "branch": df["Branch"].astype(str).values,
        "city": df["City"].astype(str).values,
        "customer_type": df["Customer type"].astype(str).values,
        "gender": df["Gender"].astype(str).values,
        "date": date_strs,
        "price": np.round(unit_price, 2),
        "cost": np.round(cost_per_unit, 2),
        "competitor_price": comp_price,
        "inventory": inventory,
        "units_sold": qty.astype(int),
        "payment": df["Payment"].astype(str).values,
        "rating": df["Rating"].to_numpy(dtype=float),
        "gross_income": df["gross income"].to_numpy(dtype=float),
    })


def transform_grocery_2025(df: pd.DataFrame) -> pd.DataFrame:
    """Transform: pratyushpuri/grocery-store-sales-dataset-in-2025-1900-record
    Columns: customer_id, store_name, transaction_date, aisle, product_name,
             quantity, unit_price, total_amount, discount_amount, final_amount,
             loyalty_points
    """
    rng = np.random.default_rng(42)
    n = len(df)

    qty = df["quantity"].to_numpy(dtype=float)
    unit_price = df["unit_price"].to_numpy(dtype=float)
    cost_per_unit = np.round(unit_price * rng.uniform(0.4, 0.7, n), 2)
    comp_price = np.round(unit_price * (1 + rng.uniform(-0.10, 0.15, n)), 2)
    inventory = rng.integers(30, 200, n)
    discount = df["discount_amount"].to_numpy(dtype=float)
    discount_pct = np.where(unit_price > 0, np.round(discount / unit_price * 100, 1), 0)

    dates = pd.to_datetime(df["transaction_date"], errors="coerce")
    date_strs = dates.dt.strftime("%Y-%m-%d").fillna("2025-01-01").values

    return pd.DataFrame({
        "product_id": [f"P{str(i+1).zfill(4)}" for i in range(n)],
        "category": df["aisle"].astype(str).values,
        "store": df["store_name"].astype(str).values,
        "date": date_strs,
        "price": np.round(unit_price, 2),
        "cost": cost_per_unit,
        "competitor_price": comp_price,
        "inventory": inventory,
        "units_sold": qty.astype(int),
        "discount_pct": discount_pct,
        "total_amount": df["total_amount"].to_numpy(dtype=float),
        "final_amount": df["final_amount"].to_numpy(dtype=float),
        "loyalty_points": df["loyalty_points"].to_numpy(dtype=int),
    })


def transform_supermarket_analysis(df: pd.DataFrame) -> pd.DataFrame:
    """Transform: faresashraf1001/supermarket-sales (1000 rows, 17 cols)
    Columns: Invoice ID, Branch, City, Customer type, Gender, Product line,
             Unit price, Quantity, Tax 5%, Sales, Date, Time, Payment, cogs,
             gross margin percentage, gross income, Rating
    """
    rng = np.random.default_rng(42)
    n = len(df)

    qty = df["Quantity"].to_numpy(dtype=float)
    unit_price = df["Unit price"].to_numpy(dtype=float)
    cost_per_unit = df["cogs"].to_numpy(dtype=float) / np.maximum(qty, 1)
    comp_price = np.round(unit_price * (1 + rng.uniform(-0.10, 0.15, n)), 2)
    inventory = rng.integers(30, 200, n)

    dates = pd.to_datetime(df["Date"], errors="coerce")
    date_strs = dates.dt.strftime("%Y-%m-%d").fillna("2025-01-01").values

    return pd.DataFrame({
        "product_id": [f"P{str(i+1).zfill(4)}" for i in range(n)],
        "category": df["Product line"].astype(str).values,
        "branch": df["Branch"].astype(str).values,
        "city": df["City"].astype(str).values,
        "customer_type": df["Customer type"].astype(str).values,
        "gender": df["Gender"].astype(str).values,
        "date": date_strs,
        "price": np.round(unit_price, 2),
        "cost": np.round(cost_per_unit, 2),
        "competitor_price": comp_price,
        "inventory": inventory,
        "units_sold": qty.astype(int),
        "payment": df["Payment"].astype(str).values,
        "rating": df["Rating"].to_numpy(dtype=float),
        "gross_income": df["gross income"].to_numpy(dtype=float),
    })


def transform_superstore(df: pd.DataFrame) -> pd.DataFrame:
    """Transform: vivek468/superstore-dataset-final (9994 rows, 21 cols)
    Columns: Row ID, Order ID, Order Date, Ship Date, Ship Mode, Customer ID,
             Customer Name, Segment, Country, City, State, Postal Code, Region,
             Product ID, Category, Sub-Category, Product Name, Sales, Quantity,
             Discount, Profit
    """
    rng = np.random.default_rng(42)
    n = len(df)

    qty = df["Quantity"].to_numpy(dtype=float)
    sales = df["Sales"].to_numpy(dtype=float)
    unit_price = np.where(qty > 0, np.round(sales / qty, 2), 0)
    discount = df["Discount"].to_numpy(dtype=float)
    profit = df["Profit"].to_numpy(dtype=float)
    cost_total = sales - profit
    cost_per_unit = np.where(qty > 0, np.round(cost_total / qty, 2), 0)
    comp_price = np.round(unit_price * (1 + rng.uniform(-0.10, 0.15, n)), 2)
    inventory = rng.integers(30, 200, n)
    discount_pct = np.round(discount * 100, 1)

    dates = pd.to_datetime(df["Order Date"], errors="coerce")
    date_strs = dates.dt.strftime("%Y-%m-%d").fillna("2025-01-01").values

    return pd.DataFrame({
        "product_id": df["Product ID"].astype(str).values,
        "category": df["Category"].astype(str).values,
        "sub_category": df["Sub-Category"].astype(str).values,
        "region": df["Region"].astype(str).values,
        "city": df["City"].astype(str).values,
        "state": df["State"].astype(str).values,
        "segment": df["Segment"].astype(str).values,
        "ship_mode": df["Ship Mode"].astype(str).values,
        "date": date_strs,
        "price": unit_price,
        "cost": cost_per_unit,
        "competitor_price": comp_price,
        "inventory": inventory,
        "units_sold": qty.astype(int),
        "discount_pct": discount_pct,
        "sales": sales,
        "profit": profit,
    })


def transform_grocery_catalog(df: pd.DataFrame) -> pd.DataFrame:
    """Transform: bhavikjikadara/grocery-store-dataset (1757 rows, 8 cols)
    Columns: Sub Category, Price, Discount, Rating, Title, Currency, Feature,
             Product Description

    This is a product catalog (no transaction data). We create synthetic
    transactions from the catalog to generate demand.
    """
    rng = np.random.default_rng(42)
    n = len(df)

    # Clean price column (may contain $ signs)
    price_raw = df["Price"].astype(str).str.replace("$", "", regex=False).str.strip()
    price = pd.to_numeric(price_raw, errors="coerce").fillna(0).to_numpy(dtype=float)
    discount = pd.to_numeric(df["Discount"], errors="coerce").fillna(0).to_numpy(dtype=float)
    rating = pd.to_numeric(df["Rating"], errors="coerce").fillna(3.0).to_numpy(dtype=float)

    # Filter out zero/negative prices
    valid = price > 0
    df_v = df[valid].copy().reset_index(drop=True)
    n = len(df_v)
    price = price[valid]
    discount = discount[valid]
    rating = rating[valid]

    cost = np.round(price * rng.uniform(0.4, 0.7, n), 2)
    comp_price = np.round(price * (1 + rng.uniform(-0.10, 0.15, n)), 2)
    inventory = rng.integers(30, 200, n)
    discount_pct = np.round(discount * 100, 1)

    # Synthetic demand: higher for cheaper items with higher ratings
    base_demand = np.maximum(5, 100 - price + rating * 10)
    noise = rng.normal(1.0, 0.2, n)
    units = np.maximum(1, np.round(base_demand * noise).astype(int))

    # Spread across 2025
    start = pd.Timestamp("2025-01-01")
    day_offsets = rng.integers(0, 365, n)
    dates = [start + pd.Timedelta(days=int(d)) for d in day_offsets]

    return pd.DataFrame({
        "product_id": [f"P{str(i+1).zfill(4)}" for i in range(n)],
        "category": df_v["Sub Category"].astype(str).values,
        "date": [d.strftime("%Y-%m-%d") for d in dates],
        "price": np.round(price, 2),
        "cost": cost,
        "competitor_price": comp_price,
        "inventory": inventory,
        "units_sold": units,
        "discount_pct": discount_pct,
        "rating": rating,
    })


TRANSFORMERS = [
    ("Super Market Sales (transaction data)", transform_supermarket_sales),
    ("Grocery Store Sales 2025", transform_grocery_2025),
    ("Supermarket Sales (data analysis)", transform_supermarket_analysis),
    ("Superstore Dataset (4 years retail)", transform_superstore),
    ("Grocery Store Dataset", transform_grocery_catalog),
]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def download_dataset(slug: str, file_pattern: str = "*.csv",
                     encoding: str = "utf-8") -> pd.DataFrame:
    """Download a Kaggle dataset and return the first CSV as a DataFrame."""
    path = kagglehub.dataset_download(slug)
    csvs = sorted(Path(path).glob(file_pattern))
    if not csvs:
        raise FileNotFoundError(f"No CSV found for {slug}")
    return pd.read_csv(csvs[0], encoding=encoding)


def train_and_evaluate(name: str, df: pd.DataFrame) -> dict:
    """Profile, train, and evaluate one dataset."""
    # Profile
    profile = ds.profile(df, preferred_target="units_sold")
    q = profile["quality"]

    # Find target
    target = "units_sold"
    if target not in df.columns:
        # Fall back to first numeric column with variance
        for c in df.columns:
            if pd.api.types.is_numeric_dtype(df[c]) and df[c].nunique() > 5:
                target = c
                break

    # Exclude leakage columns
    exclude = ["historical_sales", "sales", "total_amount", "final_amount",
               "profit", "gross_income", "tax_5pct", "cogs"]
    feature_cols = [c for c in df.columns if c != target and c not in exclude]

    # Train
    t0 = time.perf_counter()
    try:
        result = pl.run_pipeline(df, target, features=feature_cols)
    except Exception as e:
        return {
            "name": name,
            "rows": len(df),
            "columns": len(df.columns),
            "quality_score": q["score"],
            "error": str(e)[:200],
        }
    train_time = time.perf_counter() - t0

    best = result["best"]
    return {
        "name": name,
        "rows": len(df),
        "columns": len(df.columns),
        "target": target,
        "features_used": result["dataset"]["features"],
        "quality_score": q["score"],
        "quality_label": q["label"],
        "best_model": best["name"],
        "r2": best["r2"],
        "mae": best["mae"],
        "rmse": best["rmse"],
        "cv_r2_mean": best["cv_r2_mean"],
        "cv_r2_std": best["cv_r2_std"],
        "all_models": result["models"],
        "train_time_s": round(train_time, 1),
    }


def main() -> None:
    print("=" * 80)
    print("  KAGGLE SUPERMARKET DATASETS — TRAIN ALL & COMPARE ACCURACY")
    print("=" * 80)
    print()

    results = []

    for i, (ds_info, transformer_info) in enumerate(zip(DATASETS, TRANSFORMERS), 1):
        name = ds_info["name"]
        slug = ds_info["slug"]
        encoding = ds_info.get("encoding", "utf-8")
        _, transformer = transformer_info

        print(f"[{i}/5] {name}")
        print(f"       Slug: {slug}")

        try:
            # Download
            raw = download_dataset(slug, encoding=encoding)
            print(f"       Downloaded: {raw.shape[0]} rows x {raw.shape[1]} cols")

            # Transform
            df = transformer(raw)
            print(f"       Transformed: {df.shape[0]} rows x {df.shape[1]} cols")

            # Train & evaluate
            result = train_and_evaluate(name, df)
            results.append(result)

            if "error" in result:
                print(f"       ERROR: {result['error']}")
            else:
                print(f"       Target: {result['target']} ({result['features_used']} features)")
                print(f"       Best: {result['best_model']}  R2={result['r2']:.4f}  "
                      f"MAE={result['mae']:.3f}  RMSE={result['rmse']:.3f}")
                print(f"       CV R2: {result['cv_r2_mean']:.4f} +/- {result['cv_r2_std']:.4f}"
                      if result['cv_r2_mean'] is not None else "")
                print(f"       Time: {result['train_time_s']}s")

        except Exception as e:
            print(f"       FAILED: {str(e)[:150]}")
            results.append({"name": name, "error": str(e)[:200]})

        print()

    # ── Summary table ────────────────────────────────────────────────────
    print("=" * 80)
    print("  ACCURACY COMPARISON TABLE")
    print("=" * 80)
    print()

    valid = [r for r in results if "error" not in r]
    if valid:
        # Sort by R2 descending
        valid.sort(key=lambda r: r["r2"], reverse=True)

        print(f"  {'Rank':<5} {'Dataset':<40} {'Rows':>6} {'Best Model':<22} "
              f"{'R2':>8} {'MAE':>10} {'RMSE':>10} {'CV R2':>8}")
        print("  " + "-" * 110)

        for rank, r in enumerate(valid, 1):
            cv_str = f"{r['cv_r2_mean']:.4f}" if r['cv_r2_mean'] is not None else "N/A"
            print(f"  {rank:<5} {r['name']:<40} {r['rows']:>6} {r['best_model']:<22} "
                  f"{r['r2']:>8.4f} {r['mae']:>10.3f} {r['rmse']:>10.3f} {cv_str:>8}")

        print()

        # All models per dataset
        print("  ALL MODELS PER DATASET:")
        print()
        for r in valid:
            print(f"  {r['name']}:")
            print(f"    {'Model':<25} {'R2':>8} {'MAE':>10} {'RMSE':>10}")
            print(f"    {'-'*55}")
            for m in r["all_models"]:
                print(f"    {m['name']:<25} {m['r2']:>8.4f} {m['mae']:>10.3f} {m['rmse']:>10.3f}")
            print()

    # Failed datasets
    failed = [r for r in results if "error" in r]
    if failed:
        print("  FAILED DATASETS:")
        for r in failed:
            print(f"    {r['name']}: {r['error'][:100]}")
        print()

    print("=" * 80)
    print(f"  DONE — {len(valid)}/{len(results)} datasets trained successfully")
    print("=" * 80)


if __name__ == "__main__":
    main()
