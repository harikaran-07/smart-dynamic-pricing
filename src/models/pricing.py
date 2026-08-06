"""Price optimizer.

For a given product and live context, grid-search candidate prices, predict unit
demand for each using the trained demand regressor, then pick the price that
maximises expected revenue = price * min(demand, inventory).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

_recommend_features = [
    "price", "competitor_price", "price_vs_competitor", "price_ratio_to_base",
    "price_over_cat", "inventory", "is_weekend", "month",
    "year_sin", "year_cos", "seasonal_factor", "weather_factor",
    "units_lag1", "units_lag7", "units_roll7",
]


def recommend_price(model, product_id, base_price, cost, competitor_price,
                    category_mean, inventory, dow, doy,
                    live_recent_demand: float | None = None,
                    n_grid: int = 40) -> dict:
    grid = np.linspace(max(cost * 1.0, base_price * 0.8, competitor_price * 0.9),
                       max(cost * 1.0 + 0.01, min(base_price * 1.3, competitor_price * 1.25)),
                       n_grid)
    best = {"price": base_price, "revenue": -np.inf, "demand": 0.0}
    for p in grid:
        row = _make_row(p, base_price, competitor_price, category_mean, inventory, dow, doy)
        if live_recent_demand is not None:
            row["units_lag1"] = live_recent_demand
            row["units_lag7"] = live_recent_demand
            row["units_roll7"] = live_recent_demand
        d = _predict(model, row)
        sellable = min(d, inventory)
        revenue = p * sellable
        if revenue > best["revenue"]:
            best = dict(price=float(p), revenue=float(revenue), demand=float(sellable))

    price = round(best["price"] - 0.01, 2)
    return {
        "product_id": product_id,
        "recommended_price": price,
        "cost": cost,
        "expected_demand": round(best["demand"], 1),
        "expected_revenue": round(price * best["demand"], 2),
        "competitor_price": competitor_price,
        "inventory": inventory,
        "currency": "USD",
    }


def _make_row(p, base, comp, cat, inventory, dow, doy) -> dict:
    is_weekend = 1 if dow >= 5 else 0
    month = int(((doy - 1) // 30) % 12) + 1
    seasonal = 1.0 + 0.35 * np.sin(2 * np.pi * (doy - 60) / 365.25)
    return {
        "price": p,
        "competitor_price": comp,
        "price_vs_competitor": p - comp,
        "price_ratio_to_base": p / base,
        "price_over_cat": p - cat,
        "inventory": inventory,
        "is_weekend": 1 if dow >= 5 else 0,
        "month": month,
        "year_sin": np.sin(2 * np.pi * doy / 365.25),
        "year_cos": np.cos(2 * np.pi * doy / 365.25),
        "seasonal_factor": seasonal,
        "weather_factor": 1.0,
        "units_lag1": 12.0,
        "units_lag7": 12.0,
        "units_roll7": 12.0,
    }


def _predict(model, row: dict) -> float:
    df = pd.DataFrame([row])
    return float(np.clip(model.predict(df[_recommend_features])[0], 0, None))