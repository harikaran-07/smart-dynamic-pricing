import sys
from pathlib import Path
BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
import pandas as pd, numpy as np, time, json, joblib
from src.data.preprocess import engineer_sales_features
from src.models.demand import train_and_evaluate
from src.config import DEMAND_ARTIFACT, MODEL_DIR

print("Loading...")
sales = pd.read_csv(BASE/"data/raw/kaggle_sales.csv")
sales["date"] = pd.to_datetime(sales["date"])
print(f"Rows {len(sales):,} products {sales['product_id'].nunique()}")
# sample 50k for quick test
sales = sales.sample(50000, random_state=42).sort_values(["product_id","date"])
print(f"Sampled {len(sales):,}")
t0=time.time()
feats = engineer_sales_features(sales)
print(f"Feats {feats.shape} t={time.time()-t0:.1f}s")
t0=time.time()
fitted, summary = train_and_evaluate(feats)
print(summary)
print(f"Best {summary['r2'].idxmax()} {summary['r2'].max():.4f} t={time.time()-t0:.1f}s")
# save best
best = summary["r2"].idxmax()
api = {"xgboost": fitted.get(best), "linear": fitted.get("linear")}
api = {k:v for k,v in api.items() if v is not None}
joblib.dump(api, DEMAND_ARTIFACT)
(MODEL_DIR/"summary.json").write_text(json.dumps({"models": summary.to_dict()}))
print("saved")
