"""End-to-end pipeline: data -> features -> models -> artifacts."""
from __future__ import annotations

import json

import joblib

from .config import (
    MODEL_DIR,
    ARIMA_ARTIFACT,
    DEMAND_ARTIFACT,
    SEG_ARTIFACT,
    TE_ARTIFACT,
)
from .data import preprocess
from .models import demand, negotiation, segmentation, time_series


def run(tune: bool = False) -> dict:
    print("[1/5] loading Kaggle dataset ...")
    from .config import SALES_CSV, DATA_DIR
    import pandas as pd
    if not SALES_CSV.exists():
        raise FileNotFoundError(
            f"Dataset not found at {SALES_CSV}. "
            "Run: python -m scripts.download_kaggle"
        )
    sales = pd.read_csv(SALES_CSV)
    print(f"  Loaded {len(sales):,} rows from {SALES_CSV.name}")

    # Generate customers/weather if missing (for segmentation/negotiation)
    from .config import CUSTOMERS_CSV, WEATHER_CSV
    if not CUSTOMERS_CSV.exists():
        print("  Generating synthetic customers for segmentation ...")
        import numpy as np
        rng = np.random.default_rng(42)
        n_cust = 2000
        categories = ["Electronics", "Apparel", "Home & Kitchen", "Sports", "Beauty"]
        pid = [f"P{i:03d}" for i in range(1, 21)]
        customers = pd.DataFrame({
            "customer_id": [f"c-{i:03d}" for i in range(1, n_cust + 1)],
            "loyalty_score": np.round(rng.normal(45, 25, n_cust), 1).clip(0, 100),
            "purchase_count": rng.integers(0, 150, n_cust),
            "avg_sales": np.round(rng.uniform(0.5, 3, n_cust), 2),
            "region": rng.choice(["North", "South", "East", "West"], n_cust),
            "preferred_category": rng.choice(categories, n_cust),
            "fav_product": rng.choice(pid, n_cust),
        })
        customers.to_csv(CUSTOMERS_CSV, index=False)
    if not WEATHER_CSV.exists():
        print("  Generating synthetic weather for feature engineering ...")
        dates = pd.date_range("2025-01-01", periods=365, freq="D")
        weather = pd.DataFrame({
            "date": dates,
            "temperature_c": np.round(10 + 20 * np.sin(2 * np.pi * (dates.dayofyear - 60) / 365) + rng.normal(0, 3, 365), 1),
            "rainfall_mm": np.round(rng.exponential(2, 365).clip(0, 15), 1),
        })
        weather.to_csv(WEATHER_CSV, index=False)

    print("[2/5] feature engineering ...")
    feats = preprocess.engineer_sales_features(sales)
    feats.to_csv(preprocess.SALES_PROCESSED, index=False)

    print("[3/5] training demand models ...")
    fitted, summary = demand.train_and_evaluate(feats)
    joblib.dump(fitted, DEMAND_ARTIFACT)
    (MODEL_DIR / "summary.json").write_text(
        json.dumps({"models": summary.to_dict()}))
    print(summary)

    print("[4/5] ARIMA baselines ...")
    arima_results = time_series.main(sales)
    joblib.dump(arima_results, ARIMA_ARTIFACT)

    print("[5/5] customer segmentation + negotiation agent ...")
    cust = preprocess.load_customers()
    seg_df, seg_artifacts = segmentation.segment(cust)
    seg_df.to_csv(preprocess.CUSTOMERS_PROCESSED, index=False)
    joblib.dump(seg_artifacts, SEG_ARTIFACT)
    joblib.dump(negotiation.train_agent(), TE_ARTIFACT)

    print("done.")
    return {"features": len(feats), "model_summary": summary.to_dict()}


if __name__ == "__main__":
    run()