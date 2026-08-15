"""FastAPI application exposing the Smart Dynamic Pricing + negotiation endpoints
and serving a lightweight dashboard."""
from __future__ import annotations

import json

import joblib
import numpy as np
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
from ..models.pricing import _make_row

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

_PREF_BACKBONE = "xgboost" if DEMAND_MODELS and "xgboost" in DEMAND_MODELS else "linear"

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


class ManualRequest(BaseModel):
    product_name: str = "Manual Product"
    category: str = "General"
    price: float = Field(gt=0)
    cost: float = Field(gt=0)
    inventory: int = Field(default=50, ge=0)
    competitor: float | None = Field(default=None, gt=0)
    discount_pct: float = Field(default=0, ge=0, le=50)
    demand_pressure: float = Field(default=0.5, ge=0, le=1)
    marketing_spend: float = Field(default=0, ge=0)
    customer_rating: float = Field(default=4.0, ge=0, le=5)
    season: str = "Normal"
    holiday: bool = False
    weekend: bool = False
    month: int = Field(default=1, ge=1, le=12)
    dow: int = Field(default=0, ge=0, le=6)


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


# ---------- AI Assistant support endpoints --------------------------------

def _product_rows() -> list:
    if PRODUCTS is None or "base_price" not in PRODUCTS:
        return []
    rows = []
    for _, r in PRODUCTS.iterrows():
        rows.append({
            "product_id": str(r["product_id"]),
            "base_price": float(r["base_price"]),
            "cost": float(r["cost"]),
            "category": str(r.get("category", "General")),
        })
    return rows


def _customer_rows(n: int = 200) -> list:
    if CUSTOMERS is None:
        return []
    out = []
    for _, r in CUSTOMERS.head(n).iterrows():
        out.append({
            "customer_id": str(r["customer_id"]),
            "loyalty_score": float(r.get("loyalty_score", 0)),
            "purchase_count": int(r.get("purchase_count", 0)),
            "avg_sales": float(r.get("avg_sales", 0)),
            "region": str(r.get("region", "Unknown")),
            "preferred_category": str(r.get("preferred_category", "General")),
            "segment_label": str(r.get("segment_label", "Regular")),
            "loyalty_tier": str(r.get("loyalty_tier", "New")),
        })
    return out


def _insights() -> dict:
    """Aggregates across the processed sales history for the assistant."""
    sales = pd.read_csv(SALES_PROCESSED, parse_dates=["date"])
    sales["profit"] = (sales["price"] - sales["cost"]) * sales["units_sold"]
    sales["revenue"] = sales["price"] * sales["units_sold"]

    g = sales.groupby("product_id")
    profit_by = g["profit"].sum().sort_values(ascending=False)
    revenue_by = g["revenue"].sum().sort_values(ascending=False)

    latest = sales.sort_values("date").groupby("product_id").tail(1)
    avg_daily = g["units_sold"].mean()
    latest = latest.copy()
    latest["avg_daily"] = latest["product_id"].map(avg_daily)
    latest["days_left"] = latest["inventory"] / latest["avg_daily"].clip(lower=0.1)

    def flag(row):
        if row["days_left"] < 7:
            return "low_stock"
        if row["days_left"] > 90 or row["inventory"] > 250:
            return "overstock"
        return "ok"

    latest["flag"] = latest.apply(flag, axis=1)

    monthly = sales.groupby("month")["units_sold"].sum()
    wd = sales.groupby("is_weekend")["units_sold"].mean()
    rev_cat = sales.groupby("category")["revenue"].sum().sort_values(ascending=False)
    prof_cat = sales.groupby("category")["profit"].sum().sort_values(ascending=False)

    recent7 = sales[sales["date"] >= sales["date"].max() - pd.Timedelta(days=7)]
    prev7 = sales[(sales["date"] >= sales["date"].max() - pd.Timedelta(days=14))
                  & (sales["date"] < sales["date"].max() - pd.Timedelta(days=7))]
    r7 = recent7.groupby("product_id")["units_sold"].sum()
    p7 = prev7.groupby("product_id")["units_sold"].sum()
    trend = (r7 - p7.reindex(r7.index).fillna(0)).sort_values(ascending=False)

    def inv_json(sub, key):
        return [{
            "product_id": str(r["product_id"]), "inventory": int(r["inventory"]),
            "avg_daily": round(float(r["avg_daily"]), 1),
            "days_left": round(float(r["days_left"]), 1),
        } for _, r in sub[sub["flag"] == key].head(6).iterrows()]

    return {
        "product_count": int(len(PRODUCTS)) if PRODUCTS is not None else 0,
        "top_revenue": [{
            "product_id": str(i), "revenue": round(float(v), 2),
            "profit": round(float(profit_by.get(i, 0)), 2),
        } for i, v in revenue_by.head(5).items()],
        "top_profit": [{
            "product_id": str(i), "profit": round(float(v), 2),
            "revenue": round(float(revenue_by.get(i, 0)), 2),
        } for i, v in profit_by.head(5).items()],
        "best_revenue_category": {"name": str(rev_cat.index[0]), "revenue": round(float(rev_cat.iloc[0]), 2)},
        "best_profit_category": {"name": str(prof_cat.index[0]), "profit": round(float(prof_cat.iloc[0]), 2)},
        "monthly_sales": {str(int(k)): int(v) for k, v in monthly.items()},
        "best_month": int(monthly.idxmax()),
        "weekday_units": round(float(wd.get(0, 0)), 1),
        "weekend_units": round(float(wd.get(1, 0)), 1),
        "inventory": [{
            "product_id": str(r["product_id"]), "inventory": int(r["inventory"]),
            "avg_daily": round(float(r["avg_daily"]), 1),
            "days_left": round(float(r["days_left"]), 1),
        } for _, r in latest.sort_values("days_left").head(8).iterrows()],
        "low_stock": inv_json(latest, "low_stock"),
        "overstock": inv_json(latest, "overstock"),
        "trend_products": {str(k): int(v) for k, v in trend.head(6).items()},
        "segments": _customer_segments(),
    }


@app.get("/api/products/detail")
def products_detail():
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet.")
    return _product_rows()


@app.get("/api/customers/detail")
def customers_detail():
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet.")
    return _customer_rows()


@app.get("/api/insights")
def insights():
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet.")
    return _insights()


def _manual_demand(model, p, base, comp, cat, inventory, dow, doy, live) -> float:
    df = _make_row(p, base, comp, cat, inventory, dow, doy)
    if live is not None:
        df["units_lag1"] = live
        df["units_lag7"] = live
        df["units_roll7"] = live
    return float(np.clip(model.predict(pd.DataFrame([df]))[0], 0, None))


@app.post("/api/manual")
def manual_predict(req: ManualRequest):
    """Dataset-free prediction for a manually entered product."""
    if not CAN_SERVE:
        raise HTTPException(503, "Models not trained yet. Run `python -m src.training.train`.")
    model = DEMAND_MODELS[_PREF_BACKBONE]
    comp = req.competitor or req.price
    cat_mean = float(PRODUCTS["base_price"].mean()) if PRODUCTS is not None else req.price
    doy = (req.month - 1) * 30 + 15
    live = req.demand_pressure * 20
    eff = round(req.price * (1 - req.discount_pct / 100), 2)
    inv = req.inventory

    demand = _manual_demand(model, eff, req.price, comp, cat_mean, inv, req.dow, doy, live)
    demand = min(demand, inv)
    revenue = round(eff * demand, 2)
    profit = round((eff - req.cost) * demand, 2)

    opt = pricing.recommend_price(
        model=model, product_id=req.product_name or "Manual",
        base_price=req.price, cost=req.cost, competitor_price=comp,
        category_mean=cat_mean, inventory=inv, dow=req.dow, doy=doy,
        live_recent_demand=live,
    )
    opt_price = float(opt["recommended_price"])
    opt_demand = min(float(opt["expected_demand"]), inv)
    opt_revenue = round(opt_price * opt_demand, 2)
    opt_profit = round((opt_price - req.cost) * opt_demand, 2)

    # sensitivity: % change in demand for representative perturbations
    def d_at(p, c, inv_, wk):
        row = _make_row(p, req.price, c, cat_mean, inv_, req.dow, doy)
        row["is_weekend"] = wk
        if live is not None:
            row["units_lag1"] = live; row["units_lag7"] = live; row["units_roll7"] = live
        return max(0.0, float(model.predict(pd.DataFrame([row]))[0]))

    base_d = d_at(eff, comp, inv, 1 if req.weekend else 0)
    pct = lambda a, b: round((a - b) / b * 100, 1) if b > 0 else 0.0
    impacts = [
        {"feature": "price", "impact_pct": pct(d_at(eff * 1.1, comp, inv, 1 if req.weekend else 0), base_d),
         "label": "raising price 10%"},
        {"feature": "competitor_price", "impact_pct": pct(d_at(eff, comp * 1.1, inv, 1 if req.weekend else 0), base_d),
         "label": "competitor +10%"},
        {"feature": "inventory", "impact_pct": pct(d_at(eff, comp, inv * 1.5, 1 if req.weekend else 0), base_d),
         "label": "stock +50%"},
        {"feature": "weekend", "impact_pct": pct(d_at(eff, comp, inv, 1), d_at(eff, comp, inv, 0)),
         "label": "weekday → weekend"},
    ]
    impacts.sort(key=lambda x: abs(x["impact_pct"]), reverse=True)

    # confidence: strong when price sits near typical levels & margin is healthy
    score = 0.55
    if 0.7 * comp <= eff <= 1.3 * comp:
        score += 0.2
    if req.price <= 2.5 * req.cost:
        score += 0.15
    if 10 <= inv <= 200:
        score += 0.1
    score = round(min(score, 0.97), 2)

    return {
        "input": req.model_dump(),
        "current": {
            "price": eff, "demand": round(demand, 1), "revenue": revenue,
            "profit": profit, "margin_pct": round((eff - req.cost) / eff * 100, 1) if eff > 0 else 0,
        },
        "optimal": {
            "recommended_price": opt_price, "demand": round(opt_demand, 1),
            "revenue": opt_revenue, "profit": opt_profit,
            "price_delta_pct": round((opt_price - eff) / eff * 100, 1) if eff > 0 else 0,
        },
        "discount_grid": [
            {
                "discount": d, "price": round(req.price * (1 - d / 100), 2),
                "demand": round(min(_manual_demand(model, req.price * (1 - d / 100), req.price, comp, cat_mean, inv, req.dow, doy, live), inv), 1),
            } for d in [0, 5, 10, 15, 20]
        ],
        "feature_impacts": impacts,
        "confidence_pct": int(score * 100),
        "currency": "USD",
    }


@app.get("/{path:path}", include_in_schema=False)
def dashboard_static(path: str):
    if path == "" or path == "index.html":
        return FileResponse(DASHBOARD_DIR / "index.html")
    candidate = (DASHBOARD_DIR / path).resolve()
    if candidate.is_relative_to(DASHBOARD_DIR.resolve()) and candidate.is_file():
        return FileResponse(candidate)
    raise HTTPException(404, "Not found")


def main() -> None:
    import uvicorn

    uvicorn.run("src.api.app:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()