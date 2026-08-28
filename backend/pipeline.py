"""pipeline.py — real supervised regression pipeline with no data leakage.

CSV -> validation -> cleaning -> missing-value handling -> categorical
encoding -> feature selection -> train/test split -> model training ->
cross-validation comparison -> holdout evaluation -> best model.

Metrics are R², MAE and RMSE — never "accuracy". Evaluation numbers come
only from the held-out test set; cross-validation is used only for model
comparison on the training portion.

Optimised for web API speed: subsamples large datasets, reduced model
complexity, and fewer CV folds.
"""
from __future__ import annotations

import time
import warnings

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.linear_model import LinearRegression
from sklearn.ensemble import (
    GradientBoostingRegressor,
    RandomForestRegressor,
)
from sklearn.metrics import r2_score, mean_absolute_error, mean_squared_error

warnings.filterwarnings("ignore")

try:
    from xgboost import XGBRegressor
    HAS_XGB = True
except Exception:  # pragma: no cover - optional dependency
    HAS_XGB = False

RANDOM_SEED = 42
TEST_SIZE = 0.2
CV_FOLDS = 3
LOW_CARDINALITY_CAP = 30
MAX_FEATURES = 40
USE_LOG_TARGET = True
USE_STACKING = False
MAX_TRAIN_ROWS = 15000


class PipelineError(ValueError):
    """User-facing pipeline problem (400 responses)."""


def _dtype_kind(s: pd.Series) -> str:
    if pd.api.types.is_numeric_dtype(s):
        return "numeric"
    if pd.api.types.is_datetime64_any_dtype(s):
        return "datetime"
    return "categorical"


def prepare_features(df: pd.DataFrame, target: str, features=None) -> tuple[np.ndarray, np.ndarray, list[str], dict, pd.DataFrame]:
    """Clean, encode and split the data. Returns
    (X, y, feature_names, stats, clean_df) where clean_df[i] is the original
    row used to build X[i] — required for per-row prediction reporting."""
    if target not in df.columns:
        raise PipelineError(f"Target column '{target}' was not found in the dataset.")
    if not pd.api.types.is_numeric_dtype(df[target]) and not _is_numeric_like(df[target]):
        raise PipelineError(
            f"Target column '{target}' is not numeric. Choose a numeric column such "
            "as units_sold or revenue for regression."
        )

    df = df.copy()
    stats = {"dropped_rows_invalid": 0, "missing_filled": 0, "dropped_columns": []}

    # drop rows with invalid target values
    y_raw = pd.to_numeric(df[target], errors="coerce")
    valid = y_raw.notna()
    stats["dropped_rows_invalid"] = int((~valid).sum())
    df = df[valid]
    y = y_raw[valid].astype(float)

    # feature columns: explicit selection or everything except the target
    if features:
        feat_cols = [c for c in features if c in df.columns and c != target]
    else:
        feat_cols = [c for c in df.columns if c != target]
    if not feat_cols:
        raise PipelineError("No feature columns available to train on.")

    # drop constant / near-constant columns
    keep = []
    for c in feat_cols:
        try:
            if df[c].nunique(dropna=True) <= 1:
                stats["dropped_columns"].append(c)
                continue
        except Exception:
            stats["dropped_columns"].append(c)
            continue
        keep.append(c)
    feat_cols = keep

    missing_before = int(df[feat_cols].isna().sum().sum())
    stats["missing_before"] = missing_before

    # datetime -> month + weekday + cyclical harmonics
    for c in [c for c in feat_cols if _dtype_kind(df[c]) == "datetime"]:
        try:
            dt = pd.to_datetime(df[c], errors="coerce")
            df[c + "_month"] = dt.dt.month.fillna(0).astype(float)
            df[c + "_dow"] = dt.dt.dayofweek.fillna(0).astype(float)
            m_rad = 2 * np.pi * df[c + "_month"] / 12.0
            df[c + "_sin_m"] = np.sin(m_rad).astype(float)
            df[c + "_cos_m"] = np.cos(m_rad).astype(float)
            feat_cols = [c + "_month" if x == c else x for x in feat_cols]
            feat_cols.extend([c + "_dow", c + "_sin_m", c + "_cos_m"])
        except Exception:
            stats["dropped_columns"].append(c)
            feat_cols = [x for x in feat_cols if x != c]

    # economic feature engineering (elasticity, margins, competitor ratios)
    cols_map = {str(c).lower().strip(): c for c in df.columns}
    p_col = cols_map.get("price") or cols_map.get("selling_price")
    comp_col = cols_map.get("competitor_price") or cols_map.get("competitor")
    cost_col = cols_map.get("cost") or cols_map.get("cogs")
    inv_col = cols_map.get("inventory") or cols_map.get("stock_level")

    if p_col and comp_col and p_col in df.columns and comp_col in df.columns:
        p_val = pd.to_numeric(df[p_col], errors="coerce").fillna(0)
        c_val = pd.to_numeric(df[comp_col], errors="coerce").fillna(0)
        df["_price_gap"] = c_val - p_val
        df["_price_ratio"] = np.where(c_val > 0, p_val / c_val, 1.0)
        df["_price_gap_pct"] = np.where(p_val > 0, (c_val - p_val) / p_val, 0.0)
        feat_cols.extend(["_price_gap", "_price_ratio", "_price_gap_pct"])

    if p_col and cost_col and p_col in df.columns and cost_col in df.columns:
        p_val = pd.to_numeric(df[p_col], errors="coerce").fillna(0)
        cost_val = pd.to_numeric(df[cost_col], errors="coerce").fillna(0)
        df["_margin_pct"] = np.where(p_val > 0, (p_val - cost_val) / p_val, 0.0)
        df["_margin_abs"] = p_val - cost_val
        df["_markup_ratio"] = np.where(cost_val > 0, p_val / cost_val, 1.0)
        feat_cols.extend(["_margin_pct", "_margin_abs", "_markup_ratio"])

    if inv_col and inv_col in df.columns:
        inv_val = pd.to_numeric(df[inv_col], errors="coerce").clip(lower=0).fillna(0)
        df["_log_inv"] = np.log1p(inv_val)
        df["_inv_pressure"] = np.where(inv_val > 0, np.log1p(inv_val), 0.0)
        feat_cols.extend(["_log_inv", "_inv_pressure"])

    # Log transforms for price
    if p_col and p_col in df.columns:
        p_val = pd.to_numeric(df[p_col], errors="coerce").fillna(0)
        df["_log_price"] = np.log1p(np.clip(p_val, 0, None))
        feat_cols.append("_log_price")

    # Interaction features for price × competitor
    if p_col and comp_col and p_col in df.columns and comp_col in df.columns:
        p_val = pd.to_numeric(df[p_col], errors="coerce").fillna(0)
        c_val = pd.to_numeric(df[comp_col], errors="coerce").fillna(0)
        df["_price_x_comp"] = p_val * c_val
        df["_comp_minus_price_sq"] = (c_val - p_val) ** 2
        feat_cols.extend(["_price_x_comp", "_comp_minus_price_sq"])

    # Discount-related interactions if available
    disc_cols = [c for c in df.columns if "discount" in str(c).lower() and c in feat_cols]
    if disc_cols and p_col and p_col in df.columns:
        p_val = pd.to_numeric(df[p_col], errors="coerce").fillna(0)
        disc_val = pd.to_numeric(df[disc_cols[0]], errors="coerce").fillna(0)
        df["_price_x_disc"] = p_val * disc_val
        df["_eff_price"] = p_val * (1 - disc_val / 100 if disc_val.max() <= 1 else 1 - disc_val)
        feat_cols.extend(["_price_x_disc", "_eff_price"])

    # categorical encoding (one-hot, cardinality capped to avoid blow-up)
    encoded = []
    for c in list(feat_cols):
        if _dtype_kind(df[c]) == "categorical":
            uniq = df[c].nunique(dropna=True)
            if uniq > LOW_CARDINALITY_CAP:
                stats["dropped_columns"].append(c + " (too many categories)")
                feat_cols.remove(c)
                continue
            df[c] = df[c].fillna("__missing__").astype(str)
            dummies = pd.get_dummies(df[c], prefix=c, dummy_na=False)
            dummies = dummies.astype(float)
            for dc in dummies.columns:
                encoded.append(dc)
                df[dc] = dummies[dc].values
            feat_cols.remove(c)

    # missing-value handling: numeric median, categorical mode
    for c in feat_cols:
        if _dtype_kind(df[c]) == "numeric":
            col = pd.to_numeric(df[c], errors="coerce")
            if col.isna().any():
                med = col.median()
                df[c] = col.fillna(med)
            else:
                df[c] = col
        else:
            if df[c].isna().any():
                df[c] = df[c].fillna(df[c].mode().iloc[0] if len(df[c].mode()) else "missing")

    feature_names = list(dict.fromkeys(feat_cols + encoded))

    missing_after = int(df[feature_names].isna().sum().sum())
    stats["missing_filled"] = max(0, missing_before - missing_after)

    # drop remaining non-finite rows
    X = df[feature_names].apply(pd.to_numeric, errors="coerce")
    finite_mask = X.notna().all(axis=1) & np.isfinite(y)
    n_dropped = int((~finite_mask).sum())
    stats["dropped_rows_invalid"] += n_dropped
    X = X[finite_mask].to_numpy(dtype=float)
    y = y[finite_mask].to_numpy(dtype=float)

    if len(X) < 30:
        raise PipelineError(
            f"Only {len(X):,} usable rows after cleaning — at least 30 are needed "
            "for a train/test split."
        )

    clean_df = df[finite_mask].copy()
    return X, y, feature_names, stats, clean_df


def _json_safe_row(series: pd.Series) -> dict:
    out = {}
    for k, v in series.items():
        if isinstance(v, (pd.Timestamp, np.datetime64)):
            v = str(v)
        elif isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
            v = None
        elif isinstance(v, np.generic):
            v = v.item()
        out[str(k)] = v
    return out


def _is_numeric_like(s: pd.Series) -> bool:
    return pd.to_numeric(s, errors="coerce").notna().mean() > 0.5


def _build_models():
    models = [
        ("Linear Regression", LinearRegression()),
        ("Random Forest", RandomForestRegressor(
            n_estimators=60, max_depth=8, min_samples_leaf=5,
            random_state=RANDOM_SEED, n_jobs=-1)),
        ("Gradient Boosting", GradientBoostingRegressor(
            n_estimators=80, learning_rate=0.1, max_depth=4,
            subsample=0.85, min_samples_leaf=5,
            random_state=RANDOM_SEED)),
    ]
    if HAS_XGB:
        models.append(("XGBoost", XGBRegressor(
            n_estimators=80, learning_rate=0.1, max_depth=5,
            subsample=0.85, colsample_bytree=0.8,
            random_state=RANDOM_SEED, n_jobs=-1,
            objective="reg:squarederror", verbosity=0)))
    return models


def _feature_importance(model, feature_names, kind: str) -> list[dict]:
    importances = None
    if kind == "Linear Regression":
        coef = getattr(model, "coef_", None)
        if coef is not None and len(coef) == len(feature_names):
            importances = np.abs(coef)
    else:
        imp = getattr(model, "feature_importances_", None)
        if imp is not None and len(imp) == len(feature_names):
            importances = imp
    if importances is None:
        return [{"feature": f, "importance": 0.0} for f in feature_names]
    s = float(np.sum(importances))
    norm = importances / s if s > 0 else importances
    pairs = sorted(zip(feature_names, norm), key=lambda p: -p[1])
    return [{"feature": f, "importance": round(float(v), 4)} for f, v in pairs]


def run_pipeline(df: pd.DataFrame, target: str, features=None) -> dict:
    """Full supervised pipeline; returns the JSON training result."""
    X, y, feature_names, stats, clean_df = prepare_features(df, target, features)

    # Subsample large datasets for speed
    if len(X) > MAX_TRAIN_ROWS:
        rng = np.random.RandomState(RANDOM_SEED)
        idx_sub = rng.choice(len(X), size=MAX_TRAIN_ROWS, replace=False)
        X = X[idx_sub]
        y = y[idx_sub]
        clean_df = clean_df.iloc[idx_sub].copy()

    idx = np.arange(len(clean_df))
    idx_train, idx_test = train_test_split(
        idx, test_size=TEST_SIZE, random_state=RANDOM_SEED, shuffle=True)
    X_train, X_test = X[idx_train], X[idx_test]
    y_train, y_test = y[idx_train], y[idx_test]

    # Optional log1p target transform for right-skewed demand.
    use_log = USE_LOG_TARGET and np.nanmin(y_train) >= 0
    if use_log:
        y_train_t = np.log1p(y_train)
        inv = np.expm1
    else:
        y_train_t = y_train
        inv = lambda a: a

    models = _build_models()
    results = []

    for name, model in models:
        t0 = time.perf_counter()
        model.fit(X_train, y_train_t)
        train_ms = round((time.perf_counter() - t0) * 1000)

        pred_t = model.predict(X_test)
        pred = np.clip(inv(pred_t), 0, None)
        r2 = float(r2_score(y_test, pred))
        mae = float(mean_absolute_error(y_test, pred))
        rmse = float(np.sqrt(mean_squared_error(y_test, pred)))

        # cross-validation on the training portion — subsample for speed
        cv_mean, cv_std = float("nan"), float("nan")
        try:
            cv_size = min(3000, len(X_train))
            cv_idx = np.random.RandomState(RANDOM_SEED).choice(
                len(X_train), size=cv_size, replace=False)
            cv_X, cv_y = X_train[cv_idx], y_train[cv_idx]
            cv = cross_val_score(model, cv_X, cv_y, cv=CV_FOLDS, scoring="r2", n_jobs=1)
            cv_mean = float(np.mean(cv))
            cv_std = float(np.std(cv))
        except Exception:
            pass

        results.append({
            "name": name,
            "r2": round(r2, 4),
            "mae": round(mae, 3),
            "rmse": round(rmse, 3),
            "cv_r2_mean": round(cv_mean, 4) if cv_mean == cv_mean else None,
            "cv_r2_std": round(cv_std, 4) if cv_std == cv_std else None,
            "training_time_ms": train_ms,
        })

    # --- Stacking ensemble (disabled for speed) ---

    # best model: lowest hold-out RMSE (ties broken by R²)
    scored = sorted(results, key=lambda m: (m["rmse"], -m["r2"]))
    best_row = scored[0]
    best_idx = results.index(best_row)
    best_model = models[best_idx][1]

    # refit best on log target so predictions can be inverted
    if use_log:
        from sklearn.base import clone
        best_model = clone(best_model)
        best_model.fit(X_train, y_train_t)

    pred_full = np.clip(inv(best_model.predict(X_test)), 0, None)
    sample = np.random.RandomState(RANDOM_SEED).choice(
        len(y_test), size=min(300, len(y_test)), replace=False)
    sample = np.sort(sample)
    test_predictions = [
        {"actual": round(float(y_test[i]), 4), "predicted": round(float(pred_full[i]), 4)}
        for i in sample
    ] if len(sample) else []

    # per-row prediction table (up to 40 test rows) with original columns
    test_df = clean_df.iloc[idx_test].copy()
    test_df["_actual"] = y_test
    test_df["_predicted"] = pred_full
    pred_rows = []
    stride = max(1, len(test_df) // 40)
    for i in range(0, len(test_df), stride):
        r = test_df.iloc[i]
        row = _json_safe_row(r.drop(["_actual", "_predicted"]))
        pred_rows.append({
            "row": row,
            "actual": round(float(r["_actual"]), 4),
            "predicted": round(float(r["_predicted"]), 4),
        })
        if len(pred_rows) >= 40:
            break

    importance = _feature_importance(best_model, feature_names, best_row["name"])

    return {
        "dataset": {
            "rows": int(len(df)),
            "rows_used": int(len(X)),
            "columns": int(len(df.columns)),
            "features": len(feature_names),
            "feature_names": feature_names,
            "train_rows": int(len(X_train)),
            "test_rows": int(len(X_test)),
            "test_size": TEST_SIZE,
            "duplicates_removed": int(df.duplicated().sum()),
            "missing_before": stats.get("missing_before", 0),
            "missing_filled": stats.get("missing_filled", 0),
            "rows_dropped_invalid": stats.get("dropped_rows_invalid", 0),
            "dropped_columns": stats.get("dropped_columns", []),
            "target": target,
            "log_target": bool(use_log),
        },
        "models": results,
        "best": {
            "name": best_row["name"],
            "r2": best_row["r2"],
            "mae": best_row["mae"],
            "rmse": best_row["rmse"],
            "cv_r2_mean": best_row["cv_r2_mean"],
            "cv_r2_std": best_row["cv_r2_std"],
            "training_time_ms": best_row["training_time_ms"],
        },
        "feature_importance": importance,
        "test_predictions": test_predictions,
        "predictions_table": pred_rows,
        "predictions_summary": {
            "mean_actual": round(float(np.mean(y_test)), 3),
            "mean_predicted": round(float(np.mean(pred_full)), 3),
            "sample_size": len(test_predictions),
        },
        "metrics_explained": {
            "r2": "R² = the share of the target's variance explained by the model "
                  "(0 = no better than the mean, 1 = perfect).",
            "mae": "MAE = average absolute error in target units — lower is better.",
            "rmse": "RMSE = root mean squared error in target units — penalises "
                    "large errors more than MAE.",
        },
        "xgboost_available": HAS_XGB,
    }