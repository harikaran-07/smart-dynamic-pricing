"""Synthetic data generator.

Creates a realistic daily product dataset with:
- base price + cost per product
- price elasticity (demand is price-elastic)
- inventory stock levels
- competitor price signal
- seasonality + festival uplift
- weather effect
- weekday seasonality
- daily sales (units sold)
Plus a customer table (loyalty / purchase history / spend) for segmentation and negotiation.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..config import (
    CUSTOMERS_CSV,
    N_DAYS_HISTORY,
    N_PRODUCTS,
    SALES_CSV,
    SEED,
    WEATHER_CSV,
    DATA_DIR,
)

CATEGORIES = [
    "Electronics", "Apparel", "Home & Kitchen", "Sports", "Beauty",
]

FESTIVAL_BUMPS = {15: 1.25, 100: 1.3, 260: 1.15, 355: 1.6}


def build_products(n_products: int = N_PRODUCTS, seed: int = SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    n = n_products
    base_price = np.round(rng.uniform(5, 150, n), 2)
    return pd.DataFrame({
        "product_id": [f"P{i:03d}" for i in range(1, n + 1)],
        "category": [CATEGORIES[i % len(CATEGORIES)] for i in range(n)],
        "base_price": base_price,
        "cost": np.round(base_price * rng.uniform(0.35, 0.6, n), 2),
        "elasticity": rng.uniform(-2.2, -0.8, n),
        "seasonality": rng.uniform(0.0, 0.5, n),
    })


def _seasonal_factor(doy: int, offset: int) -> float:
    f = 1.0 + 0.35 * np.sin(2 * np.pi * (doy - 60 + offset) / 365.25)
    for day, bump in FESTIVAL_BUMPS.items():
        if abs(doy - day) <= 2:
            f = max(f, bump)
    return float(f)


def generate_sales(
    products: pd.DataFrame,
    days: int = N_DAYS_HISTORY,
    seed: int = SEED,
) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2024-01-01", periods=days, freq="D")
    dow = dates.dayofweek.values
    doy = dates.dayofyear.values

    rows = []
    for i, row in products.iterrows():
        pid = row["product_id"]
        base = float(row["base_price"])
        cost = float(row["cost"])
        elast = float(row["elasticity"])
        seasonal_offset = int((i * 37) % 365)

        seasonal = np.array([_seasonal_factor(d, seasonal_offset) for d in doy])
        weekday = np.where(dow >= 5, 1.35, 1.0)
        weather = 1.0 + 0.18 * np.sin(2 * np.pi * (doy + 40 * (i + 1)) / 365)

        # historical price wanders around base
        price = base * (0.9 + 0.2 * rng.uniform(size=days))
        competitor = base * (1 + 0.12 * rng.normal(size=days))
        inventory = np.maximum(5, np.round(rng.normal(80, 30, days)).astype(int))
        # base latent demand (units at reference price) with random day noise
        baseline_demand = np.maximum(1.5, 30 + 6 * np.sin(2 * np.pi * (doy + seasonal_offset) / 45) + rng.normal(0, 6, days))

        log_price_ratio = elast * np.log(price / base)
        demand = baseline_demand * np.exp(log_price_ratio) * seasonal * weekday * weather
        units = np.clip(np.round(demand), 0, inventory).astype(int)

        for d in range(days):
            rows.append({
                "p": pid,
                "date": dates[d],
                "category": row["category"],
                "price": round(float(price[d]), 2),
                "cost": cost,
                "competitor_price": round(float(competitor[d]), 2),
                "inventory": int(inventory[d]),
                "units_sold": int(units[d]),
                "is_weekend": int(dow[d] >= 5),
                "month": int(dates[d].month),
                "seasonal_factor": round(float(seasonal[d]), 3),
                "weather_factor": round(float(weather[d]), 3),
            })
    return pd.DataFrame(rows).rename(columns={"p": "product_id"})


def generate_weather(days: int = N_DAYS_HISTORY, seed: int = SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2024-01-01", periods=days, freq="D")
    temp = 10 + 20 * np.sin(2 * np.pi * (dates.dayofyear - 60) / 365) + rng.normal(0, 3, days)
    rain = np.clip(rng.exponential(2, days), 0, 15)
    return pd.DataFrame({
        "date": dates,
        "temperature_c": np.round(temp, 1),
        "rainfall_mm": np.round(rain, 1),
    })


def generate_customers(n_customers: int = 2000, seed: int = SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    n = n_customers
    loyalty = np.clip(rng.normal(45, 25, n), 0, 100)
    purchases = np.clip((loyalty / 4 + rng.normal(2, 3, n)).astype(int), 0, 150)
    avg_spend = np.round(rng.uniform(0.5, 3, n) + loyalty * 0.05, 2)
    pid = [f"P{i:03d}" for i in range(1, N_PRODUCTS + 1)]
    return pd.DataFrame({
        "customer_id": [f"c-{i:03d}" for i in range(1, n + 1)],
        "loyalty_score": np.round(loyalty, 1),
        "purchase_count": purchases,
        "avg_sales": avg_spend,
        "region": rng.choice(["North", "South", "East", "West"], n),
        "preferred_category": rng.choice(CATEGORIES, n),
        "fav_product": rng.choice(pid, n),
    })


def main() -> None:
    products = build_products()
    sales = generate_sales(products)
    weather = generate_weather()
    customers = generate_customers()

    sales.to_csv(SALES_CSV, index=False)
    weather.to_csv(WEATHER_CSV, index=False)
    customers.to_csv(CUSTOMERS_CSV, index=False)
    products.to_csv(DATA_DIR / "products.csv", index=False)

    print(f"Wrote {len(sales):,} sales rows, {len(customers):,} customers, {len(weather)} weather days, "
          f"{len(products)} products.")


if __name__ == "__main__":
    main()