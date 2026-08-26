"""Download and transform the Kaggle Retail Markdown Optimization dataset.

Dataset: arbaaztamboli/retail-markdown-optimization-discounts-and-sales
URL: https://www.kaggle.com/datasets/arbaaztamboli/retail-markdown-optimization-discounts-and-sales

This script:
  1. Downloads the dataset via kagglehub (public, no API key needed).
  2. Transforms the Kaggle columns into the format expected by this project:
     product_id, category, date, price, cost, competitor_price,
     inventory, units_sold, discount_pct
  3. Writes the result to backend/sample_sales.csv (used by the backend
     pipeline) and to data/raw/kaggle_sales.csv (used by the src/ pipeline).

Usage:
    python -m scripts.download_kaggle
"""
from __future__ import annotations

import math
import random
from pathlib import Path

import pandas as pd
import numpy as np

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_CSV = PROJECT_ROOT / "backend" / "sample_sales.csv"
RAW_DIR = PROJECT_ROOT / "data" / "raw"
RAW_CSV = RAW_DIR / "kaggle_sales.csv"

RAW_DIR.mkdir(parents=True, exist_ok=True)


def download_kaggle_dataset() -> Path:
    """Download via kagglehub and return the path to the CSV file."""
    import kagglehub

    path = kagglehub.dataset_download(
        "arbaaztamboli/retail-markdown-optimization-discounts-and-sales"
    )
    csv_files = list(Path(path).glob("*.csv"))
    if not csv_files:
        raise FileNotFoundError(f"No CSV found in downloaded dataset at {path}")
    return csv_files[0]


def transform(df: pd.DataFrame) -> pd.DataFrame:
    """Transform Kaggle columns into the project's schema with extra features.

    The Kaggle dataset captures how markdowns (discounts) boost sales:
    - Historical_Sales is the baseline demand at Original_Price.
    - Sales_After_M1..4 show demand AFTER each markdown round is applied.
    - Markdown_1..4 are the discount percentages per round.

    We use Sales_After_M4 as units_sold (final demand after all markdowns)
    and apply the effective discounted price so the model can learn the
    price-to-demand relationship.

    All original Kaggle features that carry predictive signal are passed
    through so the ML pipeline (which handles one-hot encoding of
    categoricals) can use them.

    Kaggle columns:
      Product_ID, Category, Brand, Season, Product_Name,
      Original_Price, Competitor_Price, Seasonality_Factor,
      Markdown_1..4, Historical_Sales, Sales_After_M1..4,
      Stock_Level, Promotion_Type, Customer Ratings, Return Rate,
      Optimal Discount

    Output columns (project schema + extras):
      product_id, category, brand, season, product_name,
      price, cost, competitor_price, inventory, units_sold,
      discount_pct, date, seasonality_factor,
      historical_sales, markdown_1..4,
      promotion_type, customer_rating, return_rate
    """
    rng = np.random.default_rng(42)
    n = len(df)

    # --- Map columns ---
    product_ids = ["P" + str(int(x)).zfill(4) for x in df["Product_ID"]]
    categories = df["Category"].astype(str).values

    # Original price
    orig_prices = df["Original_Price"].to_numpy(dtype=float)

    # Effective price: apply the average markdown to get the price the
    # customer actually pays.  This creates the price variation the
    # model needs to learn price-demand elasticity.
    avg_markdown = df[["Markdown_1", "Markdown_2", "Markdown_3", "Markdown_4"]].mean(axis=1).to_numpy()
    effective_price = np.round(orig_prices * (1.0 - avg_markdown), 2)
    effective_price = np.maximum(effective_price, 0.50)  # floor

    # cost: derive from Original_Price at a realistic 30-55% margin
    cost_margin = rng.uniform(0.30, 0.55, n)
    costs = np.round(orig_prices * cost_margin, 2)

    # competitor_price
    comp_prices = df["Competitor_Price"].to_numpy(dtype=float)

    # inventory: Stock_Level
    inventory = df["Stock_Level"].to_numpy(dtype=int)

    # units_sold: Sales_After_M4
    units_sold = df["Sales_After_M4"].to_numpy(dtype=int)

    # discount_pct: average markdown expressed as a percentage
    discount_pct = np.round(avg_markdown * 100, 1)

    # date: synthetic daily dates spread across 2025
    start = pd.Timestamp("2025-01-01")
    day_offsets = rng.integers(0, 365, size=n)
    dates = [start + pd.Timedelta(days=int(d)) for d in day_offsets]

    out = pd.DataFrame({
        "product_id": product_ids,
        "category": categories,
        "brand": df["Brand"].astype(str).values,
        "season": df["Season"].astype(str).values,
        "product_name": df["Product_Name"].astype(str).values,
        "date": [d.strftime("%Y-%m-%d") for d in dates],
        "price": effective_price,
        "cost": costs,
        "competitor_price": np.round(comp_prices, 2),
        "seasonality_factor": df["Seasonality_Factor"].to_numpy(dtype=float),
        "inventory": inventory,
        "historical_sales": df["Historical_Sales"].to_numpy(dtype=int),
        "markdown_1": df["Markdown_1"].to_numpy(dtype=float),
        "markdown_2": df["Markdown_2"].to_numpy(dtype=float),
        "markdown_3": df["Markdown_3"].to_numpy(dtype=float),
        "markdown_4": df["Markdown_4"].to_numpy(dtype=float),
        "promotion_type": df["Promotion_Type"].astype(str).values,
        "customer_rating": df["Customer Ratings"].to_numpy(dtype=float),
        "return_rate": df["Return Rate"].to_numpy(dtype=float),
        "units_sold": units_sold,
        "discount_pct": discount_pct,
    })

    return out


def main() -> None:
    print("Step 1/3 — Downloading Kaggle dataset ...")
    csv_path = download_kaggle_dataset()
    print(f"  Downloaded: {csv_path}")

    print("Step 2/3 — Loading raw CSV ...")
    raw = pd.read_csv(csv_path)
    print(f"  {len(raw):,} rows, {len(raw.columns)} columns")

    print("Step 3/3 — Transforming to project schema ...")
    transformed = transform(raw)

    # Write backend CSV (used by the FastAPI upload pipeline)
    transformed.to_csv(BACKEND_CSV, index=False)
    print(f"  Written: {BACKEND_CSV}  ({len(transformed):,} rows)")

    # Write raw CSV (used by src/ training pipeline)
    transformed.to_csv(RAW_CSV, index=False)
    print(f"  Written: {RAW_CSV}  ({len(transformed):,} rows)")

    print("\nDone. You can now train with:")
    print("  cd backend && python -m uvicorn main:app --reload")
    print("  Then upload data/raw/kaggle_sales.csv via the dashboard,")
    print("  or use: python -m scripts.train_kaggle")


if __name__ == "__main__":
    main()
