"""Demand forecasting regressors: Linear Regression, XGBoost, LightGBM, CatBoost."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:
    from xgboost import XGBRegressor
    XGB_AVAILABLE = True
except ImportError:
    XGB_AVAILABLE = False

try:
    from lightgbm import LGBMRegressor
    LGB_AVAILABLE = True
except ImportError:
    LGB_AVAILABLE = False

try:
    from catboost import CatBoostRegressor
    CB_AVAILABLE = True
except ImportError:
    CB_AVAILABLE = False

FEATURES = [
    "price", "competitor_price", "price_vs_competitor", "price_ratio_to_base",
    "price_over_cat", "inventory", "is_weekend", "month",
    "year_sin", "year_cos", "seasonal_factor", "weather_factor",
    "units_lag1", "units_lag2", "units_lag3", "units_lag7", "units_lag14",
    "units_roll7", "units_roll14", "price_change_1", "price_change_7",
    "promo", "state_holiday", "school_holiday",
]


def make_pipelines() -> dict[str, Pipeline]:
    lr = Pipeline([("scaler", StandardScaler()), ("reg", LinearRegression())])
    rf = Pipeline([
        ("reg", RandomForestRegressor(
            n_estimators=300, max_depth=12, min_samples_leaf=5,
            random_state=42, n_jobs=-1))
    ])
    gb = Pipeline([
        ("reg", GradientBoostingRegressor(
            n_estimators=300, learning_rate=0.05, max_depth=6,
            subsample=0.85, random_state=42))
    ])
    models: dict[str, Pipeline] = {
        "linear": lr,
        "random_forest": rf,
        "gradient_boosting": gb,
    }
    if XGB_AVAILABLE:
        models["xgboost"] = Pipeline([
            ("reg", XGBRegressor(
                n_estimators=1000, learning_rate=0.025, max_depth=12,
                subsample=0.9, colsample_bytree=0.9,
                reg_alpha=0.05, reg_lambda=0.8,
                random_state=42, n_jobs=-1, verbosity=0)),
        ])
    if LGB_AVAILABLE:
        models["lightgbm"] = Pipeline([
            ("reg", LGBMRegressor(
                n_estimators=1000, learning_rate=0.025, max_depth=12,
                subsample=0.9, colsample_bytree=0.9,
                reg_alpha=0.05, reg_lambda=0.8,
                random_state=42, n_jobs=-1, verbosity=-1)),
        ])
    if CB_AVAILABLE:
        models["catboost"] = Pipeline([
            ("reg", CatBoostRegressor(
                iterations=1000, learning_rate=0.025, depth=12,
                l2_leaf_reg=2.0, random_seed=42, verbose=0)),
        ])
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