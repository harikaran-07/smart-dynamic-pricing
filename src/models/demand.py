"""Demand forecasting regressors: Linear, Random Forest, XGBoost."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:
    from xgboost import XGBRegressor
    XGB_AVAILABLE = True
except ImportError:  # pragma: no cover
    XGB_AVAILABLE = False

FEATURES = [
    "price", "competitor_price", "price_vs_competitor", "price_ratio_to_base",
    "price_over_cat", "inventory", "is_weekend", "month",
    "year_sin", "year_cos", "seasonal_factor", "weather_factor",
    "units_lag1", "units_lag7", "units_roll7",
]


def make_pipelines() -> dict[str, Pipeline]:
    lr = Pipeline([("scaler", StandardScaler()), ("reg", LinearRegression())])
    rf = Pipeline([
        ("reg", RandomForestRegressor(n_estimators=150, max_depth=10,
                                      n_jobs=-1, random_state=42)),
    ])
    models: dict[str, Pipeline] = {"linear": lr, "random_forest": rf}
    if XGB_AVAILABLE:
        xgb = Pipeline([
            ("reg", XGBRegressor(n_estimators=200, learning_rate=0.08, max_depth=6,
                                 subsample=0.8, colsample_bytree=0.8,
                                 random_state=42, n_jobs=-1)),
        ])
        models["xgboost"] = xgb
    return models


def prepare_dataset(feats: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    X = feats[FEATURES]
    y = feats["units_sold"].astype(float)
    return X, y


def train_and_evaluate(feats: pd.DataFrame) -> tuple[dict, pd.DataFrame]:
    X, y = prepare_dataset(feats)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    results: dict[str, dict] = {}
    fitted: dict[str, Pipeline] = {}
    for name, pipe in make_pipelines().items():
        pipe.fit(X_train, y_train)
        pred = pipe.predict(X_test)
        pred = np.clip(pred, 0, None)
        results[name] = {
            "mae": mean_absolute_error(y_test, pred),
            "rmse": float(np.sqrt(mean_squared_error(y_test, pred))),
            "r2": r2_score(y_test, pred),
        }
        fitted[name] = pipe
    summary = pd.DataFrame(results).T.round(4)
    return fitted, summary