"""Feature engineering for the sales history and customer data."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..config import (
    CUSTOMERS_CSV,
    CUSTOMERS_PROCESSED,
    SALES_CSV,
    SALES_PROCESSED,
)


def load_sales(csv: str = SALES_CSV) -> pd.DataFrame:
    df = pd.read_csv(csv, parse_dates=["date"])
    return df


def engineer_sales_features(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    d["dow"] = d["date"].dt.dayofweek
    d["is_weekend"] = (d["dow"] >= 5).astype(int)
    d["doy"] = d["date"].dt.dayofyear
    d["month"] = d["date"].dt.month
    # continuous sinusoidal year-cycle feature (0..2pi)
    d["year_sin"] = np.sin(2 * np.pi * d.loc[:, "doy"] / 365.25)
    d["year_cos"] = np.cos(2 * np.pi * d.loc[:, "doy"] / 365.25)

    # price position vs competitor
    d["price_vs_competitor"] = d["price"] - d["competitor_price"]
    d["price_ratio_to_base"] = d["price"] / d.groupby("product_id")["price"].transform("mean")

    # category mean price as gap feature
    d["cat_mean_price"] = d.groupby("category")["price"].transform("mean")
    d["price_over_cat"] = d["price"] - d["cat_mean_price"]

    # lagged demand features per product
    d = d.sort_values(["product_id", "date"])
    g = d.groupby("product_id")["units_sold"]
    d["units_lag1"] = g.shift(1)
    d["units_lag7"] = g.shift(7)
    d["units_roll7"] = g.shift(1).transform(lambda s: s.rolling(7, min_periods=1).mean())

    # drop first rows with NaN lags
    d = d.dropna(subset=["units_lag1", "units_lag7"])
    return d


def load_customers() -> pd.DataFrame:
    return pd.read_csv(CUSTOMERS_CSV)


def main() -> None:
    sales = load_sales()
    feats = engineer_sales_features(sales)
    feats.to_csv(SALES_PROCESSED, index=False)
    print(f"Sales features -> {SALES_PROCESSED} ({len(feats):,} rows)")

    cust = load_customers()
    cust.to_csv(CUSTOMERS_PROCESSED, index=False)
    print(f"Customers -> {CUSTOMERS_PROCESSED}")


if __name__ == "__main__":
    main()