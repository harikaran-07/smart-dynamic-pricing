"""AI Negotiation Agent.

Given a customer (loyalty, purchase history) and a product (demand pressure,
inventory), simulate an iterative price negotiation. The agent decides how much
discount it can offer so the deal stays profitable, and personalises the offer
based on the customer segment.

Model used: a compact regression that maps (loyalty, purchase_count, demand_pressure,
competitor_gap, inventory, willingness_budget) -> max discount % they should accept,
trained on simulated bargain data (gradient boosting).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

FEATURES = [
    "loyalty_score", "purchase_count", "avg_sales",
    "demand_pressure", "competitor_gap", "inventory",
    "budget_ratio",
]


def simulate_bargains(n: int = 3000, seed: int = 42) -> pd.DataFrame:
    """Create synthetic negotiation outcomes for training the discount agent."""
    rng = np.random.default_rng(seed)
    rows = []
    for _ in range(n):
        loyalty = float(rng.uniform(0, 100))
        purchases = float(rng.poisson(1 + loyalty / 20))
        avg_sales = float(rng.uniform(2, 40) + loyalty * 0.1)
        demand_pressure = float(rng.uniform(0, 1))       # 0 low .. 1 very high
        competitor_gap = float(rng.uniform(-0.3, 0.3))   # frac gap vs competitor
        inventory = float(rng.uniform(1, 150))
        budget_ratio = float(rng.uniform(0.5, 1.5))      # customer budget vs price

        # discount the customer is *willing* to accept (their walk-away)
        willingness = (
            0.45 - 0.30 * (loyalty / 100)          # loyal customers accept less
            - 0.10 * (purchases / 50)
            + 0.15 * demand_pressure
            + 0.05 * competitor_gap
            + 0.15 * (inventory / 150)
        )
        willingness = float(np.clip(willingness, 0.02, 0.5))
        # agent's max *profitable* discount, guided by the same features
        margin = float(rng.uniform(0.25, 0.55))
        agent_max = min(margin * 0.8 + demand_pressure * 0.15, 0.4)
        # final deal = min(customer willingness, agent max) + negotiation slack
        deal = min(willingness, agent_max) * float(rng.uniform(0.8, 1.0))
        rows.append({
            "loyalty_score": loyalty, "purchase_count": purchases,
            "avg_sales": avg_sales, "demand_pressure": demand_pressure,
            "competitor_gap": competitor_gap, "inventory": inventory,
            "budget_ratio": budget_ratio,
            "deal_discount": float(np.clip(deal, 0, 0.45)),
        })
    return pd.DataFrame(rows)


def train_agent(seed: int = 42) -> GradientBoostingRegressor:
    data = simulate_bargains(seed=seed)
    X = data[FEATURES]
    y = data["deal_discount"]
    model = GradientBoostingRegressor(
        n_estimators=150, learning_rate=0.1, max_depth=4, random_state=seed
    )
    model.fit(X, y)
    return model


def negotiate(
    model: GradientBoostingRegressor,
    customer: dict,
    base_price: float,
    recommended_price: float,
    demand_pressure: float = 0.5,
    competitor_price: float | None = None,
    inventory: int = 50,
    max_rounds: int = 3,
    budget: float | None = None,
) -> dict:
    """Run a negotiation between customer and the agent.

    Customer starts with an asking discount; agent counters with a personalised
    offer bounded by its profit floor. A customer `budget` (walk-away max price)
    is respected: the deal only closes if the final price is at or below it.
    Returns the final agreed price.
    """
    comp = competitor_price if competitor_price else base_price
    comp_gap = (recommended_price - comp) / max(comp, 1e-6)

    row = pd.DataFrame([{
        "loyalty_score": customer.get("loyalty_score", 50),
        "purchase_count": customer.get("purchase_count", 5),
        "avg_sales": customer.get("avg_sales", 15),
        "demand_pressure": demand_pressure,
        "competitor_gap": float(np.clip(comp_gap, -0.3, 0.3)),
        "inventory": inventory,
        "budget_ratio": customer.get("budget_ratio", 0.95),
    }])
    max_discount = float(np.clip(model.predict(row)[0], 0.02, 0.4))

    transcript = []
    round_idx = 0
    while round_idx < max_rounds:
        customer_ask = 0.10 + 0.15 * (1 - customer.get("loyalty_score", 50) / 100)
        agent_offer = max_discount * (0.7 + 0.15 * round_idx)
        round_idx += 1
        accepted = agent_offer >= customer_ask * 0.8
        transcript.append({
            "round": round_idx,
            "customer_ask_discount": round(float(customer_ask), 3),
            "agent_offer_discount": round(float(agent_offer), 3),
            "accepted": bool(accepted),
        })
        if accepted:
            break

    final_discount = transcript[-1]["agent_offer_discount"] if accepted else 0.0
    final_price = round(recommended_price * (1 - final_discount), 2)

    # respect the customer's walk-away budget
    over_budget = budget is not None and final_price > budget
    if over_budget:
        # find the discount that would bring price within budget
        needed_discount = 1 - budget / recommended_price
        if needed_discount <= max_discount:
            final_discount = round(needed_discount + 0.01, 3)
            final_price = round(recommended_price * (1 - final_discount), 2)
            accepted = True
            transcript.append({
                "round": round_idx,
                "customer_ask_discount": round(float(customer_ask), 3),
                "agent_offer_discount": final_discount,
                "accepted": True,
                "note": "countered to match customer budget",
            })
        else:
            accepted = False
            transcript.append({
                "round": round_idx,
                "customer_ask_discount": round(float(customer_ask), 3),
                "agent_offer_discount": round(float(max_discount), 3),
                "accepted": False,
                "note": "customer budget below profitable floor",
            })

    return {
        "agreed": bool(accepted),
        "rounds": round_idx,
        "final_price": final_price,
        "discount_pct": round(final_discount * 100, 1),
        "customer_segment": customer.get("segment_label", "Regular"),
        "loyalty_tier": customer.get("loyalty_tier", "New"),
        "savings": round(recommended_price - final_price, 2),
        "budget": budget,
        "transcript": transcript,
    }