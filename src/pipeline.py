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
from .data import generate_data, preprocess
from .models import demand, negotiation, segmentation, time_series


def run(tune: bool = False) -> dict:
    print("[1/5] generating data ...")
    products = generate_data.build_products()
    sales = generate_data.generate_sales(products)
    from .config import SALES_CSV, WEATHER_CSV, CUSTOMERS_CSV, DATA_DIR
    sales.to_csv(SALES_CSV, index=False)
    generate_data.generate_weather().to_csv(WEATHER_CSV, index=False)
    generate_data.generate_customers().to_csv(CUSTOMERS_CSV, index=False)
    products.to_csv(DATA_DIR / "products.csv", index=False)

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