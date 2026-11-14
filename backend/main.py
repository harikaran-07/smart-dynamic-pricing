"""main.py — FastAPI backend for the Smart Dynamic Pricing dashboard.

Frontend -> Backend API -> dataset processing -> ML model -> prediction /
optimization -> JSON response -> frontend dashboard.

Deployable on Render (see render.yaml). No API keys or secrets required.
"""
from __future__ import annotations

import os
import uuid

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import dataset as ds
import pipeline as pl
import pricing as pr

def _json_safe(row: dict) -> dict:
    out = {}
    for k, v in row.items():
        try:
            if v is None or isinstance(v, (str, int, float, bool)):
                out[k] = v
            else:
                out[k] = str(v)
        except Exception:
            out[k] = str(v)
    return out

_STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dashboard"))

app = FastAPI(
    title="Smart Dynamic Pricing API",
    version="1.0.0",
    description="Dataset profiling with quality scoring, real ML regression pipeline "
                "(Linear / Random Forest / Gradient Boosting / XGBoost) with cross-validation "
                "and rule-constrained dynamic price recommendations.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # public dashboard demo — no credentials are ever sent
    allow_methods=["*"],
    allow_headers=["*"],
)

# in-memory dataset store (single instance per Render worker is fine for a demo)
STORE: dict[str, dict] = {}


class TrainRequest(BaseModel):
    dataset_id: str
    target: str
    features: list[str] | None = None


class PricingRequest(BaseModel):
    dataset_id: str
    row: dict = Field(default_factory=dict)
    objective: str = "profit"


class RLRequest(BaseModel):
    dataset_id: str
    row: dict = Field(default_factory=dict)


class NegotiateRequest(BaseModel):
    list_price: float
    cost: float = 0.0
    budget: float | None = None
    min_margin_pct: float = 20.0
    max_rounds: int = 5


def _get_df(dataset_id: str):
    rec = STORE.get(dataset_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Dataset not found — upload it again.")
    return rec["df"], rec


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "smart-pricing-api",
        "models_ready": True,
        "pricing_mode": "dataset",
        "ml": {
            "linear": True,
            "xgboost": pl.HAS_XGB,
        },
        "xgboost_available": pl.HAS_XGB,
    }


@app.get("/api/datasets/{dataset_id}")
def get_dataset(dataset_id: str):
    df, rec = _get_df(dataset_id)
    profile = dict(rec["profile"])
    profile["dataset_id"] = dataset_id
    return profile


@app.post("/api/dataset/upload")
async def upload_dataset(file: UploadFile = File(...)):
    filename = ds.sanitize_filename(file.filename or "upload.csv")
    if not filename.lower().endswith(".csv"):
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Only .csv files are accepted — never "
                   "upload executable or spreadsheet binaries.",
        )
    try:
        data = await file.read()
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail="Could not read the uploaded file.") from exc
    if len(data) > ds.MAX_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds the 10 MB limit.")

    try:
        df = ds.parse_csv(data)
    except ds.DatasetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    dataset_id = uuid.uuid4().hex[:12]
    profile = ds.profile(df)
    profile["filename"] = filename
    profile["pricing_columns"] = pr.detect_columns(df)
    STORE[dataset_id] = {"df": df, "profile": profile, "filename": filename}
    profile["dataset_id"] = dataset_id
    return profile


@app.post("/api/pipeline/train")
def train(req: TrainRequest):
    df, rec = _get_df(req.dataset_id)
    try:
        result = pl.run_pipeline(df, req.target, req.features)
    except pl.PipelineError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(
            status_code=500,
            detail="Model training failed: " + str(exc)[:200],
        ) from exc
    result["dataset"]["filename"] = rec["filename"]
    result["dataset"]["pricing_columns"] = pr.detect_columns(df)
    return result


@app.post("/api/pricing/recommend")
def recommend(req: PricingRequest):
    df, rec = _get_df(req.dataset_id)
    cols = pr.detect_columns(df)
    try:
        result = pr.recommend(df, cols, req.row, objective=req.objective)
    except pr.PricingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result["currency"] = "USD"  # display currency is handled by the frontend
    return result


@app.post("/api/rl-price")
def rl_price(req: RLRequest):
    """Tabular Q-learning trained on the demand curve fitted from the dataset."""
    df, _ = _get_df(req.dataset_id)
    cols = pr.detect_columns(df)
    row = req.row or {}
    if not row:
        raise HTTPException(status_code=400, detail="A product row is required.")
    price = pr._n(row.get(cols["price"]), None) if cols["price"] else None
    if not price or price <= 0:
        raise HTTPException(status_code=400, detail="The row has no usable price.")
    cost = pr._n(row.get(cols["cost"]), 0.0) if cols["cost"] else 0.0
    inventory = pr._n(row.get(cols["inventory"]), None) if cols["inventory"] else None
    if not inventory or inventory <= 0:
        inventory = max(10.0, price * 10)
    competitor = pr._n(row.get(cols["competitor"]), None) if cols["competitor"] else None
    model = pr._fit_with_fallback(df, cols, row)
    if model.kind == "unsupported":
        raise HTTPException(
            status_code=400,
            detail="No usable demand curve in this dataset — the RL agent needs one.",
        )
    result = pr.q_learn(model, price, cost or 0.0, inventory, competitor)
    result["demand_model"] = {
        "kind": model.kind,
        "elasticity": round(model.elasticity, 3),
        "r2": round(model.r2, 3),
        "n_obs": model.n_obs,
    }
    return result


@app.post("/api/negotiate")
def negotiate(req: NegotiateRequest):
    """Multi-round negotiation simulation with a hard minimum margin."""
    try:
        return pr.negotiate(
            list_price=req.list_price,
            cost=req.cost,
            budget=req.budget,
            min_margin_pct=req.min_margin_pct,
            max_rounds=req.max_rounds,
        )
    except pr.PricingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class PortfolioRequest(BaseModel):
    dataset_id: str
    objective: str = "profit"
    top: int = 10


@app.post("/api/pricing/portfolio")
def portfolio(req: PortfolioRequest):
    df, rec = _get_df(req.dataset_id)
    cols = pr.detect_columns(df)
    result = pr.portfolio(df, cols, objective=req.objective, top=req.top)
    result["currency"] = "USD"
    result["objective"] = req.objective
    return result


@app.get("/api/dataset/sample")
def dataset_sample(dataset_id: str, n: int = 500):
    """Raw rows for dashboard charts (price/demand scatter, history trends)."""
    df, _ = _get_df(dataset_id)
    n = max(20, min(int(n), 2000))
    cols = pr.detect_columns(df)
    keep = set()
    for role in ("price", "cost", "units", "competitor", "inventory", "discount", "group"):
        if cols.get(role):
            keep.add(cols[role])
    # date columns for time trends
    for c in df.columns:
        if "date" in str(c).lower() and c not in keep:
            keep.add(c)
            break
    keep_list = [c for c in df.columns if c in keep]
    sample = df.tail(n).copy()
    sample = sample[keep_list] if keep_list else sample
    sample = sample.replace({float("nan"): None, float("inf"): None})
    rows_json = [_json_safe(r) for r in sample.to_dict(orient="records")]
    return {"columns": list(sample.columns), "rows": rows_json,
            "pricing_columns": cols}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)


# Serve the dashboard from the same origin as the API (no CORS / secrets
# involved). Registered after all API routes so /api/* always wins.
if os.path.isdir(_STATIC_DIR):
    app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="dashboard")