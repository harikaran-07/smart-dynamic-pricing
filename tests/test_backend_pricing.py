"""Backend acceptance tests (FastAPI + pricing engine).

Ground truth fixture: ``test_pricing_data.csv`` at the repo root
(1,835 rows, 5 products, 10 duplicates).

    product  elasticity  cost  base price   R² target
    P001       -0.80       9        20        0.09
    P002       -1.50      15        35        0.45
    P003       -2.20      22        50        0.55
    P004       -3.00       5        12        0.50
    P005       -1.20      40        80        0.40

Run from the repo root:
    python -m pytest tests/test_backend_pricing.py -q
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import pricing as pr          # noqa: E402
import pipeline as pl         # noqa: E402
from main import app          # noqa: E402

CSV_PATH = ROOT / "test_pricing_data.csv"
TRUTH = {
    "P001": {"elasticity": -0.80, "cost": 9.0, "price": 20.0},
    "P002": {"elasticity": -1.50, "cost": 15.0, "price": 35.0},
    "P003": {"elasticity": -2.20, "cost": 22.0, "price": 50.0},
    "P004": {"elasticity": -3.00, "cost": 5.0, "price": 12.0},
    "P005": {"elasticity": -1.20, "cost": 40.0, "price": 80.0},
}


@pytest.fixture(scope="module")
def df() -> pd.DataFrame:
    assert CSV_PATH.exists(), "run: python scripts/make_test_data.py"
    return pd.read_csv(CSV_PATH)


@pytest.fixture(scope="module")
def cols(df):
    return pr.detect_columns(df)


@pytest.fixture(scope="module")
def client(df):
    c = TestClient(app)
    r = c.post(
        "/api/dataset/upload",
        files={"file": ("test_pricing_data.csv", CSV_PATH.read_bytes(), "text/csv")},
    )
    assert r.status_code == 200, r.text
    c.dataset_id = r.json()["dataset_id"]          # type: ignore[attr-defined]
    return c


def row_for(df, pid):
    row = df[df["product_id"] == pid].iloc[-1].to_dict()
    return {k: (float(v) if hasattr(v, "item") else v) for k, v in row.items()}


def theoretical_optimum(elasticity: float, cost: float, price: float) -> float:
    if elasticity < -1:
        return min(cost * elasticity / (1 + elasticity), 1.2 * price)
    return 1.2 * price


# --------------------------------------------------------------------------
# fixture + column detection
# --------------------------------------------------------------------------
def test_fixture_shape(df):
    assert len(df) == 1835
    assert df["product_id"].nunique() == 5
    assert int(df.duplicated().sum()) == 10


def test_columns_detected(cols):
    assert cols["price"] == "price"
    assert cols["units"] == "units_sold"
    assert cols["cost"] == "cost"
    assert cols["competitor"] == "competitor_price"
    assert cols["discount"] == "discount_pct"
    assert cols["inventory"] == "inventory"
    assert cols["group"] == "product_id"
    assert cols["date"] == "date"


def test_duplicates_dropped_before_fitting(df, cols):
    p001 = df[df["product_id"] == "P001"]
    model = pr.build_demand_model(df, cols, row_for(df, "P001"), "product_id", "P001")
    assert model.n_obs == len(p001.drop_duplicates())
    assert model.n_obs < len(p001)


# --------------------------------------------------------------------------
# acceptance through the HTTP endpoint
# --------------------------------------------------------------------------
def test_elasticity_within_tolerance(client):
    for pid, truth in TRUTH.items():
        r = client.post("/api/pricing/recommend", json={
            "dataset_id": client.dataset_id, "objective": "profit",
            "row": row_for(pd.read_csv(CSV_PATH), pid)})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["supports_optimization"] is True
        est = body["demand_model"]["elasticity"]
        assert abs(est - truth["elasticity"]) <= 0.3, (pid, est, truth["elasticity"])
        # standard error / CI / p-value are reported
        assert body["demand_model"]["elasticity_se"] is not None
        assert body["demand_model"]["elasticity_ci95"] is not None
        assert body["demand_model"]["elasticity_p_value"] is not None


def test_profit_price_within_five_percent_of_theory(client):
    data = pd.read_csv(CSV_PATH)
    for pid, truth in TRUTH.items():
        body = client.post("/api/pricing/recommend", json={
            "dataset_id": client.dataset_id, "objective": "profit",
            "row": row_for(data, pid)}).json()
        price = body["optimal"]["price"]
        current = body["current"]["price"]
        target = theoretical_optimum(body["demand_model"]["elasticity"], truth["cost"], current)
        assert abs(price - target) / target <= 0.05, (pid, price, target)


def test_price_bounds(client):
    data = pd.read_csv(CSV_PATH)
    for pid, truth in TRUTH.items():
        body = client.post("/api/pricing/recommend", json={
            "dataset_id": client.dataset_id, "objective": "profit",
            "row": row_for(data, pid)}).json()
        price = body["optimal"]["price"]
        current = body["current"]["price"]
        assert price <= current * 1.2 + 1e-6, (pid, price, current)
        assert price >= truth["cost"] - 1e-6, (pid, price, truth["cost"])


def test_p001_is_not_high_reliability(client):
    body = client.post("/api/pricing/recommend", json={
        "dataset_id": client.dataset_id, "objective": "profit",
        "row": row_for(pd.read_csv(CSV_PATH), "P001")}).json()
    assert body["demand_model"]["r2"] < 0.10
    assert body["reliability"]["level"] == "Low"


def test_competitor_and_discount_change_the_model(client):
    data = pd.read_csv(CSV_PATH)
    base_row = row_for(data, "P003")
    base = client.post("/api/pricing/recommend", json={
        "dataset_id": client.dataset_id, "objective": "profit", "row": base_row}).json()

    comp_row = dict(base_row, competitor_price=base_row["competitor_price"] * 1.20)
    comp = client.post("/api/pricing/recommend", json={
        "dataset_id": client.dataset_id, "objective": "profit", "row": comp_row}).json()

    disc_row = dict(base_row, discount_pct=15.0)
    disc = client.post("/api/pricing/recommend", json={
        "dataset_id": client.dataset_id, "objective": "profit", "row": disc_row}).json()

    assert comp["optimal"]["estimated_demand"] != base["optimal"]["estimated_demand"]
    assert disc["optimal"]["estimated_demand"] != base["optimal"]["estimated_demand"]


def test_rules_only_listed_when_they_clip(client):
    data = pd.read_csv(CSV_PATH)
    interior = client.post("/api/pricing/recommend", json={
        "dataset_id": client.dataset_id, "objective": "profit",
        "row": row_for(data, "P003")}).json()
    # P003's optimum is interior: no rule may claim to have clipped it
    assert interior["rules"] == []
    capped = client.post("/api/pricing/recommend", json={
        "dataset_id": client.dataset_id, "objective": "profit",
        "row": row_for(data, "P001")}).json()
    assert any(r["rule"] == "max-single-step-increase" for r in capped["rules"])


def test_revenue_objective_reports_profit_change(client):
    body = client.post("/api/pricing/recommend", json={
        "dataset_id": client.dataset_id, "objective": "revenue",
        "row": row_for(pd.read_csv(CSV_PATH), "P003")}).json()
    assert body["optimal"]["objective"] == "revenue"
    assert "profit_change_pct" in body["optimal"]


def test_portfolio_uses_fourteen_day_median(client):
    data = pd.read_csv(CSV_PATH)
    body = client.post("/api/pricing/portfolio", json={
        "dataset_id": client.dataset_id, "objective": "profit", "top": 10}).json()
    assert body["items"]
    p002 = next(i for i in body["items"] if i["product"] == "P002")
    sub = data[data["product_id"] == "P002"].drop_duplicates().copy()
    sub["date"] = pd.to_datetime(sub["date"])
    recent = sub[sub["date"] >= sub["date"].max() - pd.Timedelta(days=13)]
    median_14 = round(float(recent["price"].median()), 2)
    last_row = float(sub.iloc[-1]["price"])
    assert p002["current_price"] == pytest.approx(median_14, abs=0.01)
    assert median_14 != last_row


# --------------------------------------------------------------------------
# model training pipeline
# --------------------------------------------------------------------------
def test_pipeline_uses_dates_and_reports_both_splits(df):
    result = pl.run_pipeline(df, "units_sold", None)
    assert result["dataset"]["duplicates_removed"] == 10
    features = result["dataset"]["feature_names"]
    date_features = [f for f in features if f.startswith("date_")]
    assert {"date_month", "date_dow", "date_is_weekend",
            "date_sin_doy", "date_cos_doy"}.issubset(set(date_features))
    assert "date" not in result["dataset"]["dropped_columns"]
    assert result["random_split"]["r2"] is not None
    assert result["time_split"] is not None
    assert result["time_split"]["date_column"] == "date"
    assert result["time_split"]["test_rows"] < result["time_split"]["train_rows"]


# --------------------------------------------------------------------------
# RL agent, negotiation, health
# --------------------------------------------------------------------------
def test_q_learning_returns_a_real_table(df, cols):
    row = row_for(df, "P002")
    model = pr._fit_with_fallback(df, cols, row)
    result = pr.q_learn(model, row["price"], row["cost"], row["inventory"],
                        row["competitor_price"])
    assert result["learning_steps"] > 0
    assert len(result["q_table"]) == 3
    assert any(v != 0 for row_q in result["q_table"] for cell in row_q for v in cell)
    assert result["train_seconds"] < 5
    assert result["price"] <= row["price"] * 1.2 + 1e-6
    assert result["price"] >= result["cost_floor"] - 1e-6


def test_negotiation_respects_minimum_margin():
    res = pr.negotiate(50, 25, budget=38, min_margin_pct=20)
    assert res["floor_price"] == pytest.approx(30.0)
    assert res["agreed"] is True
    assert res["final_price"] >= res["floor_price"] - 1e-9
    assert len(res["transcript"]) >= 2
    assert res["mode"] == "simulation"

    refused = pr.negotiate(50, 25, budget=10)
    assert refused["agreed"] is False
    assert refused["final_price"] is None


def test_api_endpoints(client):
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/").status_code == 200
    data = pd.read_csv(CSV_PATH)
    r = client.post("/api/negotiate", json={
        "list_price": 35, "cost": 15, "budget": 30, "min_margin_pct": 20})
    assert r.status_code == 200
    assert r.json()["final_price"] >= 18
    rl = client.post("/api/rl-price", json={
        "dataset_id": client.dataset_id, "row": row_for(data, "P002")})
    assert rl.status_code == 200
    assert rl.json()["learning_steps"] > 0
    bad = client.post("/api/negotiate", json={"list_price": 0, "cost": 5})
    assert bad.status_code == 400
