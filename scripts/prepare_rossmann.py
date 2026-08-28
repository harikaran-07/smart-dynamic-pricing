"""Convert Rossmann Store Sales into the pipeline's kaggle_sales.csv schema.

Rossmann columns → pipeline schema:
  Store          → product_id  (each store = one "product")
  Date           → date
  Sales          → units_sold  (target: revenue per store-day)
  Customers      → customer_count (feature: demand pressure)
  DayOfWeek      → is_weekend, dow
  Promo          → promo (binary)
  StateHoliday   → state_holiday (binary)
  SchoolHoliday  → school_holiday (binary)
  StoreType      → category (store type a/b/c/d)
  Assortment     → assortment (a/b/c)
  CompetitionDistance → competitor_price (distance as competition proxy)
  Promo2         → promo2 (ongoing promo)
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "kaggle2"
OUT = Path(__file__).resolve().parent.parent / "data" / "raw" / "kaggle_sales.csv"


def main():
    print("Loading Rossmann data ...")
    train = pd.read_csv(DATA_DIR / "train.csv", low_memory=False, parse_dates=["Date"])
    store = pd.read_csv(DATA_DIR / "store.csv")

    print(f"  Train: {len(train):,} rows, Store: {len(store):,} stores")

    # Merge store metadata
    df = train.merge(store, on="Store", how="left")

    # Only keep open days with sales > 0
    df = df[(df["Open"] == 1) & (df["Sales"] > 0)].copy()
    print(f"  After filtering open days: {len(df):,} rows")

    # Sample for manageable size (take all, but could downsample)
    # Keep all 1M rows for best accuracy

    # --- Map to pipeline schema ---
    # product_id = Store (each store is a product)
    df["product_id"] = "S" + df["Store"].astype(str).str.zfill(4)

    # date
    df["date"] = df["Date"]

    # price: derive average price per transaction (Sales / Customers)
    # Avoid division by zero
    df["price"] = np.where(df["Customers"] > 0,
                           df["Sales"] / df["Customers"],
                           df["Sales"].median() / max(df["Customers"].median(), 1))
    df["price"] = df["price"].round(2)

    # competitor_price: CompetitionDistance as competition intensity proxy
    # Scale to similar range as price
    comp_dist = df["CompetitionDistance"].fillna(df["CompetitionDistance"].median())
    price_median = df["price"].median()
    # Normalize: closer competition = higher competitor_price
    max_dist = comp_dist.max()
    df["competitor_price"] = (1 - comp_dist / max_dist) * price_median * 2
    df["competitor_price"] = df["competitor_price"].round(2)

    # category: StoreType
    df["category"] = df["StoreType"].fillna("a")

    # units_sold: Sales (revenue per store-day)
    df["units_sold"] = df["Sales"]

    # inventory: large number (stores don't run out)
    df["inventory"] = 500

    # seasonal_factor: day-of-year pattern
    doy = df["date"].dt.dayofyear
    df["seasonal_factor"] = (1.0 + 0.35 * np.sin(2 * np.pi * (doy - 60) / 365.25)).round(4)

    # weather_factor: constant (no weather data)
    df["weather_factor"] = 1.0

    # promo: binary
    df["promo"] = df["Promo"].astype(int)

    # state_holiday: binary
    df["state_holiday"] = (df["StateHoliday"].astype(str) != "0").astype(int)

    # school_holiday: binary
    df["school_holiday"] = df["SchoolHoliday"].astype(int)

    # promotion_type: from Promo2
    df["promotion_type"] = np.where(df["Promo2"] == 1, "ongoing", "none")

    # brand: StoreType + Assortment as brand proxy
    df["brand"] = df["category"] + "_" + df["Assortment"].fillna("a")

    # product_name: store label
    df["product_name"] = "Store " + df["Store"].astype(str)

    # season: map month to season
    month = df["date"].dt.month
    df["season"] = np.where(month.isin([3, 4, 5]), "Spring",
                   np.where(month.isin([6, 7, 8]), "Summer",
                   np.where(month.isin([9, 10, 11]), "Fall", "Winter")))

    # Select output columns
    out_cols = [
        "product_id", "date", "price", "competitor_price", "category",
        "units_sold", "inventory", "seasonal_factor", "weather_factor",
        "promo", "state_holiday", "school_holiday", "promotion_type",
        "brand", "product_name", "season",
    ]

    out_df = df[out_cols].copy()
    out_df = out_df.sort_values(["product_id", "date"]).reset_index(drop=True)

    # Save
    out_df.to_csv(OUT, index=False)
    print(f"  Saved {len(out_df):,} rows to {OUT}")
    print(f"  Products (stores): {out_df['product_id'].nunique()}")
    print(f"  Date range: {out_df['date'].min()} to {out_df['date'].max()}")
    print(f"  Avg Sales: {out_df['units_sold'].mean():.0f}")
    print(f"  Avg Price: {out_df['price'].mean():.2f}")


if __name__ == "__main__":
    main()
