"""Time-series demand baseline using statsmodels ARIMA on daily aggregates."""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from ..config import ARIMA_ARTIFACT

warnings.filterwarnings("ignore")


def fit_arima_on_series(series: pd.Series, order=(1, 0, 1)) -> dict:
    """Fit ARIMA and return the fitted result + out-of-sample forecast length."""
    from statsmodels.tsa.arima.model import ARIMA  # deferred import (heavy)

    model = ARIMA(series.astype(float), order=order,
                  enforce_stationarity=False, enforce_invertibility=False)
    fit = model.fit()
    return {"summ": str(fit.summary()), "aic": float(fit.aic),
            "last_train": float(series.iloc[-1])}


def build_daily_series(sales: pd.DataFrame) -> pd.Series:
    return sales.set_index("date")["units_sold"].sort_index().resample("D").sum()


def train_all(sales: pd.DataFrame, products: list[str]) -> dict[str, dict]:
    results: dict[str, dict] = {}
    for pid in products:
        sub = sales[sales["product_id"] == pid]
        if len(sub) < 60:
            continue
        series = sub.set_index("date")["units_sold"].sort_index().resample("D").sum()
        try:
            results[pid] = fit_arima_on_series(series)
        except Exception as _exc:  # pragma: no cover
            continue
    return results


def fit_arima_on_series(series: pd.Series) -> dict:
    from statsmodels.tsa.arima.model import ARIMA

    model = ARIMA(series.astype(float), order=(1, 0, 1))
    fit = model.fit()
    return {
        "aic": float(fit.aic),
        "recent_trend": _dampened_trend(series),
        "last_units": int(series.iloc[-1]) if len(series) else 0,
    }


def _dampened_trend(series: pd.Series) -> float:
    if len(series) < 7:
        return 0.0
    recent = series.tail(7).mean()
    older = series.tail(14).head(7).mean()
    return float(np.clip((recent - older) / max(older, 1e-6), -0.2, 0.2))


def save_results(results: dict) -> None:
    import pickle
    with open(ARIMA_ARTIFACT, "wb") as fh:
        pickle.dump(results, fh)


def main(sales: pd.DataFrame) -> dict:
    products = sorted(sales["product_id"].unique())
    results = train_all(sales, products)
    save_results(results)
    return results