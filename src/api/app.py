"""FastAPI application exposing the Smart Dynamic Pricing + negotiation endpoints
and serving a lightweight dashboard."""
from __future__ import annotations

import json

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..config import (
    ARIMA_ARTIFACT,
    CUSTOMERS_PROCESSED,
    DASHBOARD_DIR,
    DATA_DIR,
    DEMAND_ARTIFACT,
    MODEL_DIR,
    REPORT_JSON,
    SALES_PROCESSED,
    SEG_ARTIFACT,
    TE_ARTIFACT,
)
from ..models import negotiation, pricing, rl_agent

app = FastAPI(title="Smart Dynamic Pricing API", version="1.0.0")

# ---- load artifacts once at boot -----------------------------------------
try:
    DEMAND_MODELS = joblib.load(DEMAND_ARTIFACT)
    SEG = joblib.load(SEG_ARTIFACT)
    NEG_AGENT = joblib.load(TE_ARTIFACT)
    CUSTOMERS = pd.read_csv(CUSTOMERS_PROCESSED)
    PRODUCTS = pd.read_csv(DATA_DIR / "products.csv")
    CAN_SERVE = True
except FileNotFoundError:
    DEMAND_MODELS, SEG, NEG_AGENT, CUSTOMERS, PRODUCTS = None, None, None, None, None
    CAN_SERVE = False

_PREF_BACKBONE = "xgboost" if DEMAND_MODELS and "xgboost" in DEMAND_MODELS else "random_forest"

# RL price agent trains fast at boot; independent of the demand-model artifacts.
RL_AGENT = rl_agent.train_agent()


def _model_summary() -> dict:
    path = MODEL_DIR / "summary.json"
    if path.exists():
        return json.loads(path.read_text())
    return {}


def _customer_segments() -> dict:
    if CUSTOMERS is None or "segment_label" not in CUSTOMERS:
        return {}
    return CUSTOMERS["segment_label"].value_counts().to_dict()


class PriceRequest(BaseModel):
    product_id: str
    inventory: int = Field(default=50, ge=0)
    competitor_price: float | None = Field(default=None)
    demand_pressure: float = Field(default=0.5, ge=0, le=1)


class NegotiateRequest(BaseModel):
    customer_id: str
    product_id: str
    max_budget: float | None = Field(default=None, gt=0)
    demand_pressure: float = Field(default=0.5, ge=0, le=1)
    inventory: int = Field(default=50, ge=0)


@app.get("/", response_class=HTMLResponse)
def dashboard():
    return FileResponse(DASHBOARD_DIR / "index.html")


@app.get("/api/health")
def health():
    return {"status": "ok", "models_ready": CAN_SERVE}


@app.get("/api/overview")
def overview():
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet.")
    sales = pd.read_csv(SALES_PROCESSED, parse_dates=["date"])
    last_day = sales["date"].max()
    recent = sales[sales["date"] >= last_day - pd.Timedelta(days=30)]
    try:
        with open(ARIMA_ARTIFACT, "rb") as fh:
            arima = len(__import__("pickle").load(fh))
    except Exception:
        arima = 0
    return {
        "generated_on": str(last_day.date()),
        "model_backbone": _PREF_BACKBONE,
        "model_metrics": _model_summary(),
        "products": int(len(PRODUCTS)),
        "customers": int(len(CUSTOMERS)),
        "total_sales_rows": int(len(sales)),
        "sales_last_30d": int(recent["units_sold"].sum()),
        "avg_daily_units": round(float(recent["units_sold"].mean()), 1),
        "avg_price": round(float(recent["price"].mean()), 2),
        "segments": _customer_segments(),
        "arima_series_fitted": arima,
    }


@app.get("/api/explain")
def explain():
    """Model explainability: winner, metrics, and top features."""
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet.")
    if not REPORT_JSON.exists():
        raise HTTPException(404, "Report not generated. Run scripts/generate_report.py")
    return json.loads(REPORT_JSON.read_text())


@app.get("/api/products")
def products():
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet.")
    return PRODUCTS["product_id"].tolist()


@app.get("/api/customers")
def customers():
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet.")
    return CUSTOMERS["customer_id"].head(200).tolist()


@app.get("/api/sales/{product_id}")
def sales_history(product_id: str, days: int = 30):
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet.")
    sales = pd.read_csv(SALES_PROCESSED, parse_dates=["date"])
    sub = sales[sales["product_id"] == product_id]
    if sub.empty:
        raise HTTPException(404, f"Unknown product {product_id}")
    tail = sub.sort_values("date").tail(days)
    return {
        "product_id": product_id,
        "dates": [d.isoformat() for d in tail["date"]],
        "units_sold": tail["units_sold"].tolist(),
        "price": tail["price"].tolist(),
    }


@app.post("/api/price")
def recommend_price(req: PriceRequest):
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet. Run `python -m src.training.train`.")
    prod = PRODUCTS[PRODUCTS["product_id"] == req.product_id]
    if prod.empty:
        raise HTTPException(404, f"Unknown product {req.product_id}")
    row = prod.iloc[0]
    today = pd.Timestamp.now()
    model = DEMAND_MODELS[_PREF_BACKBONE]
    return pricing.recommend_price(
        model=model,
        product_id=req.product_id,
        base_price=float(row["base_price"]),
        cost=float(row["cost"]),
        competitor_price=req.competitor_price or float(row["base_price"]),
        category_mean=float(PRODUCTS["base_price"].mean()),
        inventory=req.inventory,
        doy=int(today.dayofyear),
        dow=int(today.dayofweek),
        live_recent_demand=req.demand_pressure * 20,
    )


@app.post("/api/negotiate")
def negotiate(req: NegotiateRequest):
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet. Run `python -m src.training.train`.")
    cust = CUSTOMERS[CUSTOMERS["customer_id"] == req.customer_id]
    if cust.empty:
        cust = dict(loyalty_score=40.0, purchase_count=3.0, avg_sales=12.0,
                    segment_label="Regular", loyalty_tier="New")
    else:
        cust = cust.iloc[0].to_dict()
    p = PRODUCTS[PRODUCTS["product_id"] == req.product_id]
    if p.empty:
        raise HTTPException(404, f"Unknown product {req.product_id}")
    base = float(p.iloc[0]["base_price"])
    rec = recommend_price(PriceRequest(
        product_id=req.product_id,
        inventory=req.inventory,
        demand_pressure=req.demand_pressure,
    ))
    return negotiation.negotiate(
        NEG_AGENT, customer=cust, base_price=base,
        recommended_price=float(rec["recommended_price"]),
        demand_pressure=req.demand_pressure,
        competitor_price=float(rec["competitor_price"]),
        inventory=int(rec["inventory"]),
        budget=req.max_budget,
    )


@app.post("/api/rl-price")
def rl_price(req: PriceRequest):
    """Price recommendation from the reinforcement-learning agent."""
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet.")
    prod = PRODUCTS[PRODUCTS["product_id"] == req.product_id]
    if prod.empty:
        raise HTTPException(404, f"Unknown product {req.product_id}")
    row = prod.iloc[0]
    base = float(row["base_price"])
    comp = req.competitor_price or base
    # deterministic rec from the demand model to anchor the RL action space
    rec = recommend_price(req)
    return rl_agent.recommend_price_rl(
        RL_AGENT,
        base_price=base,
        cost=float(row["cost"]),
        competitor_price=comp,
        inventory=req.inventory,
        demand_pressure=req.demand_pressure,
        recommended_price=float(rec["recommended_price"]),
    )


app.mount("/dashboard", StaticFiles(directory=DASHBOARD_DIR), name="dashboard")


def main() -> None:
    import uvicorn

    uvicorn.run("src.api.app:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()