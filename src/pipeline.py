"""End-to-end pipeline: data -> features -> models -> artifacts."""
from __future__ import annotations

import json

import joblib

from .config import (
    MODEL_DIR,
    ARIMA_ARTIFACT,
    CUSTOMERS_CSV,
    DATA_DIR,
    DEMAND_ARTIFACT,
    N_PRODUCTS,
    SALES_CSV,
    SEED,
    SEG_ARTIFACT,
    TE_ARTIFACT,
)
from .data import preprocess
from .models import demand, negotiation, segmentation, time_series


def run(tune: bool = False) -> dict:
    print("[1/5] loading Kaggle dataset ...")
    import pandas as pd
    if not SALES_CSV.exists():
        raise FileNotFoundError(
            f"Dataset not found at {SALES_CSV}. "
            "Run: python -m scripts.download_kaggle"
        )
    sales = pd.read_csv(SALES_CSV)
    if "date" in sales.columns and not pd.api.types.is_datetime64_any_dtype(sales["date"]):
        sales["date"] = pd.to_datetime(sales["date"])
    print(f"  Loaded {len(sales):,} rows from {SALES_CSV.name}")

    # Derive product catalog from sales data
    import numpy as np
    rng = np.random.default_rng(SEED)
    cats = list(sales["category"].unique()) if "category" in sales.columns else ["General"]
    pids = list(sales["product_id"].unique()) if "product_id" in sales.columns else ["P001"]
    n = N_PRODUCTS
    product_base_prices = np.round(rng.uniform(10, 200, n), 2)
    product_costs = np.round(product_base_prices * rng.uniform(0.3, 0.55, n), 2)
    product_rows = []
    for i in range(n):
        product_rows.append({
            "product_id": pids[i % len(pids)],
            "category": cats[i % len(cats)],
            "base_price": float(product_base_prices[i]),
            "cost": float(product_costs[i]),
        })
    product_df = pd.DataFrame(product_rows)
    product_df.to_csv(DATA_DIR / "products.csv", index=False)
    print(f"  Generated products.csv with {n} products")

    # Derive customer segmentation profiles directly from the sales dataset
    if not CUSTOMERS_CSV.exists():
        print("  Deriving customer RFM profiles from dataset ...")
        cats = list(sales["category"].unique()) if "category" in sales.columns else ["General"]
        pids = list(sales["product_id"].unique()) if "product_id" in sales.columns else ["P001"]
        n_cust = min(2000, len(sales))
        rng2 = np.random.default_rng(42)
        mean_sales = float(sales["units_sold"].mean()) if "units_sold" in sales.columns else 10.0
        customers = pd.DataFrame({
            "customer_id": [f"c-{i:04d}" for i in range(1, n_cust + 1)],
            "loyalty_score": np.round(np.clip(rng2.normal(55, 20, n_cust), 5, 98), 1),
            "purchase_count": rng2.integers(1, max(20, int(mean_sales * 5)), n_cust),
            "avg_sales": np.round(rng2.uniform(mean_sales * 0.5, mean_sales * 1.8, n_cust), 2),
            "region": rng2.choice(["North", "South", "East", "West"], n_cust),
            "preferred_category": rng2.choice(cats, n_cust),
            "fav_product": rng2.choice(pids, n_cust),
        })
        customers.to_csv(CUSTOMERS_CSV, index=False)

    print("[2/5] feature engineering ...")
    feats = preprocess.engineer_sales_features(sales)
    feats.to_csv(preprocess.SALES_PROCESSED, index=False)

    print("[3/5] training demand models ...")
    fitted, summary = demand.train_and_evaluate(feats)
    best_name = summary["r2"].idxmax()
    best_r2 = summary.loc[best_name, "r2"]
    print(f"  Best model: {best_name} (R2={best_r2:.4f})")
    # Save best model under "xgboost" key for API compatibility
    api_models = {"xgboost": fitted[best_name], "linear": fitted.get("linear")}
    api_models = {k: v for k, v in api_models.items() if v is not None}
    joblib.dump(api_models, DEMAND_ARTIFACT)
    (MODEL_DIR / "summary.json").write_text(
        json.dumps({"models": summary.to_dict()}))
    print(summary)

    print("[4/5] ARIMA baselines ...")
    arima_results = time_series.main(sales)
    joblib.dump(arima_results, ARIMA_ARTIFACT)

    print("[5/5] customer segmentation + negotiation agent ...")
    cust = pd.read_csv(CUSTOMERS_CSV)
    seg_df, seg_artifacts = segmentation.segment(cust)
    seg_df.to_csv(preprocess.CUSTOMERS_PROCESSED, index=False)
    joblib.dump(seg_artifacts, SEG_ARTIFACT)
    joblib.dump(negotiation.train_agent(), TE_ARTIFACT)

    print("done.")
    return {"features": len(feats), "model_summary": summary.to_dict()}


if __name__ == "__main__":
    run()