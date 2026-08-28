"""Train on Rossmann data: 100K sample, skip ARIMA, save artifacts."""
import sys, time, json, joblib
from pathlib import Path
BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

import pandas as pd
import numpy as np
from src.data.preprocess import engineer_sales_features
from src.models.demand import train_and_evaluate, FEATURES
from src.config import DEMAND_ARTIFACT, MODEL_DIR, DATA_DIR, SEG_ARTIFACT, TE_ARTIFACT, CUSTOMERS_CSV, CUSTOMERS_PROCESSED
from src.models import segmentation, negotiation

print("[1] Loading Rossmann...")
sales = pd.read_csv(DATA_DIR / "kaggle_sales.csv")
sales["date"] = pd.to_datetime(sales["date"])
print(f"  {len(sales):,} rows, {sales['product_id'].nunique()} products")

print("[2] Sampling 175K...")
sales = sales.sample(175000, random_state=42).sort_values(["product_id", "date"]).reset_index(drop=True)

print("[3] Feature engineering...")
t0 = time.time()
feats = engineer_sales_features(sales)
print(f"  {len(feats):,} rows, {feats.shape[1]} cols ({time.time()-t0:.1f}s)")

print("[4] Training models...")
t0 = time.time()
fitted, summary = train_and_evaluate(feats)
print(f"  Done ({time.time()-t0:.1f}s)")
print(summary)
best = summary["r2"].idxmax()
print(f"  Best: {best} R2={summary.loc[best,'r2']:.4f}")

print("[5] Saving artifacts...")
api = {"xgboost": fitted.get(best), "linear": fitted.get("linear")}
api = {k: v for k, v in api.items() if v is not None}
joblib.dump(api, DEMAND_ARTIFACT)
(MODEL_DIR / "summary.json").write_text(json.dumps({"models": summary.to_dict()}))
print(f"  Saved {DEMAND_ARTIFACT}")

# Generate products.csv from data
pids = sorted(sales["product_id"].unique())
cats = sorted(sales["category"].unique()) if "category" in sales.columns else ["a"]
rng = np.random.default_rng(42)
n = len(pids)
prices = np.round(sales.groupby("product_id")["price"].mean().reindex(pids).values, 2)
costs = np.round(prices * rng.uniform(0.3, 0.55, n), 2)
pdf = pd.DataFrame({"product_id": pids, "category": [cats[i % len(cats)] for i in range(n)],
                     "base_price": prices, "cost": costs})
pdf.to_csv(DATA_DIR / "products.csv", index=False)
print(f"  Saved products.csv ({n} products)")

# Generate customers
if not CUSTOMERS_CSV.exists():
    n_cust = min(2000, len(sales))
    rng2 = np.random.default_rng(42)
    mean_sales = float(sales["units_sold"].mean())
    customers = pd.DataFrame({
        "customer_id": [f"c-{i:04d}" for i in range(1, n_cust + 1)],
        "loyalty_score": np.round(np.clip(rng2.normal(55, 20, n_cust), 5, 98), 1),
        "purchase_count": rng2.integers(1, max(20, int(mean_sales * 5)), n_cust),
        "avg_sales": np.round(rng2.uniform(mean_sales * 0.5, mean_sales * 1.8, n_cust), 2),
        "region": rng2.choice(["North", "South", "East", "West"], n_cust),
        "preferred_category": rng2.choice(cats, n_cust),
        "fav_product": rng2.choice(pids[:min(20, n)], n_cust),
    })
    customers.to_csv(CUSTOMERS_CSV, index=False)
    print(f"  Saved customers.csv")

# Segmentation + negotiation
cust = pd.read_csv(CUSTOMERS_CSV)
seg_df, seg_artifacts = segmentation.segment(cust)
seg_df.to_csv(CUSTOMERS_PROCESSED, index=False)
joblib.dump(seg_artifacts, SEG_ARTIFACT)
joblib.dump(negotiation.train_agent(), TE_ARTIFACT)
print("  Saved segmentation + negotiation artifacts")

print("DONE")
