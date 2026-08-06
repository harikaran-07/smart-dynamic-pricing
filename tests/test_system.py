"""End-to-end + unit tests for the Smart Dynamic Pricing system.

Run from the project root:
    .venv\\Scripts\\python.exe -m pytest tests -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.data.generate_data import build_products, generate_customers, generate_sales
from src.data.preprocess import engineer_sales_features
from src.models import demand, negotiation, pricing, rl_agent, segmentation

products = build_products()
sales = generate_sales(products)
feats = engineer_sales_features(sales)


def test_generate_sales_shape():
    assert len(sales) > 1000
    assert sales["units_sold"].min() >= 0
    assert set(["product_id", "price", "inventory", "units_sold"]).issubset(sales.columns)


def test_feature_engineering_has_lags():
    assert "units_lag1" in feats.columns
    assert not feats["units_lag1"].isna().all()


def test_demand_models_train_and_improve():
    fitted, summary = demand.train_and_evaluate(feats)
    assert set(summary.index) == set(demand.make_pipelines().keys())
    assert summary.loc["xgboost", "r2"] >= summary.loc["linear", "r2"]
    assert fitted["xgboost"] is not None


def test_optimizer_recommendation_sane():
    pipe = demand.make_pipelines()["xgboost"]
    X, y = demand.prepare_dataset(feats)
    pipe.fit(X, y)
    rec = pricing.recommend_price(
        pipe, "P001", base_price=30.0, cost=15.0, competitor_price=28.0,
        category_mean=50.0, inventory=40, doy=180, dow=2,
    )
    assert rec["recommended_price"] >= rec["cost"]
    assert rec["expected_revenue"] >= 0
    assert rec["product_id"] == "P001"


def test_segmentation_assigns_tiers():
    cust = generate_customers(100, seed=1)
    seg, artifacts = segmentation.segment(cust, n_clusters=4)
    assert set(seg["segment_label"]) <= {"Bargain seeker", "Regular", "Loyal", "Premium"}
    assert set(seg["loyalty_tier"]) == {"Gold", "Silver", "Bronze", "New"}
    assert "kmeans" in artifacts


def test_negotiation_respects_budget():
    agent = negotiation.train_agent(seed=7)
    cust = {"loyalty_score": 80.0, "purchase_count": 20.0, "avg_sales": 25.0,
            "segment_label": "Loyal", "loyalty_tier": "Gold"}
    res = negotiation.negotiate(agent, customer=cust, base_price=20.0,
                                recommended_price=25.0, budget=12.0)
    # agent floor ~20% discount -> ~20, above a 12 budget => no deal
    assert res["agreed"] is False
    # generous budget => deal and price within budget
    res2 = negotiation.negotiate(agent, customer=cust, base_price=20.0,
                                 recommended_price=25.0, budget=25.0)
    assert res2["agreed"] is True
    assert res2["final_price"] <= 25.0 + 1e-6


def test_rl_agent_learns_and_recommends():
    agent = rl_agent.train_agent(episodes=500, seed=3)
    assert agent.q.shape == (3, 3, 3, len(rl_agent.ACTION_MULTIPLIERS))
    res = rl_agent.recommend_price_rl(
        agent, base_price=30.0, cost=15.0, competitor_price=28.0,
        inventory=40, demand_pressure=0.6, recommended_price=32.0,
    )
    assert res["method"] == "rl"
    assert res["price"] > 0
    assert res["action_index"] in range(len(rl_agent.ACTION_MULTIPLIERS))
    assert len(res["q_values"]) == len(rl_agent.ACTION_MULTIPLIERS)


def test_api_live_paths():
    c = TestClient(app)
    assert c.get("/api/health").status_code == 200
    assert c.get("/").status_code == 200
    assert c.get("/api/overview").status_code in (200, 503)
    assert c.get("/api/products").status_code in (200, 503)
    # explain endpoint: 200 when the report exists, 404 otherwise, 503 when untrained
    assert c.get("/api/explain").status_code in (200, 404, 503)
    r = c.post("/api/price", json={"product_id": "P001", "inventory": 40})
    assert r.status_code in (200, 503)
    assert c.post("/api/rl-price", json={"product_id": "P001", "inventory": 40}).status_code in (200, 503)
    assert c.post("/api/price", json={"product_id": "NOPE", "inventory": 1}).status_code in (404, 503)