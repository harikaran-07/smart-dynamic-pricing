"""Dynamic pricing optimizer.

Uses the trained demand model to recommend the profit-maximising price.

Flow:
  1. Generate candidate prices around current price
  2. Predict demand at each candidate price using demand model
  3. Calculate expected profit = (price - cost) * predicted_demand
  4. Return price with highest predicted profit

Note: For full production use, load the trained XGBoost model and pass
actual product features. This implementation uses an elasticity-based
demand approximation for demonstration.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


# Typical price elasticity of demand for retail products
# (negative value: higher price → lower demand)
DEFAULT_ELASTICITY = -1.0

# Average baseline daily demand at base price
BASELINE_DEMAND = 60.0


def recommend_optimal_price(
    current_price: float,
    cost: float,
    price_range_pct: float = 0.15,   # ±15% around current price
    n_candidates: int = 11,          # number of price points to test (odd number)
    elasticity: float = DEFAULT_ELASTICITY,
) -> dict:
    """Recommend the profit-maximising price for a product.

    Uses a demand elasticity model to predict how demand changes
    with price, then selects the price that maximizes expected profit.

    Args:
        current_price: Current selling price (e.g., ₹100)
        cost: Product cost (COGS) per unit (e.g., ₹60)
        price_range_pct: Price variation range as fraction of current price
                         (0.15 = test prices from 85% to 115% of current)
        n_candidates: Number of price candidates to test (odd recommended
                      so there's a clear middle/Current price point)
        elasticity: Price elasticity of demand (typically -0.5 to -2.0
                    for most products). More negative = demand more
                    sensitive to price changes.

    Returns:
        dict with keys:
            - recommended_price: price with highest predicted profit
            - predicted_demand: demand at recommended price (units)
            - expected_profit: (recommended_price - cost) * predicted_demand
            - price_candidates: array of tested prices
            - demand_predictions: predicted demand at each candidate price
            - profit_predictions: predicted profit at each candidate price
            - price_range_tested: {min, max, current_price}

    Example:
        >>> result = recommend_optimal_price(current_price=100.0, cost=60.0)
        >>> print(f"Recommended: ₹{result['recommended_price']}")
        >>> print(f"Expected profit: ₹{result['expected_profit']}")
    """
    # Generate candidate prices around current price
    price_min = current_price * (1 - price_range_pct)
    price_max = current_price * (1 + price_range_pct)
    prices = np.linspace(price_min, price_max, n_candidates)

    # Predict demand at each candidate price using elasticity model
    # demand = BASELINE_DEMAND * (price / current_price) ^ elasticity
    # We normalize so that at current_price, demand = BASELINE_DEMAND
    demand_predictions = []
    profit_predictions = []

    for price in prices:
        # Elasticity-based demand prediction
        # If elasticity = -1, then 10% price increase → 10% demand decrease
        price_ratio = price / current_price
        predicted_demand = BASELINE_DEMAND * (price_ratio ** elasticity)
        predicted_demand = max(1, round(predicted_demand))  # at least 1 unit

        demand_predictions.append(predicted_demand)

        # Profit = (price - cost) * predicted_demand
        profit = (price - cost) * predicted_demand
        profit_predictions.append(profit)

    # Find price index with maximum predicted profit
    best_idx = int(np.argmax(profit_predictions))

    result = {
        "recommended_price": round(float(prices[best_idx]), 2),
        "predicted_demand": demand_predictions[best_idx],
        "expected_profit": round(float(profit_predictions[best_idx]), 2),
        "price_candidates": [round(float(p), 2) for p in prices],
        "demand_predictions": demand_predictions,
        "profit_predictions": profit_predictions,
        "price_range_tested": {
            "min": round(float(price_min), 2),
            "max": round(float(price_max), 2),
            "current_price": round(float(current_price), 2),
        },
    }

    return result


if __name__ == "__main__":
    # Demo usage when run directly
    result = recommend_optimal_price(
        current_price=100.0,
        cost=60.0,
        price_range_pct=0.20,  # test 20% range
        n_candidates=11,
    )
    print("=== Optimal Price Recommendation ===")
    print(f"Current price:      ₹{result['price_range_tested']['current_price']}")
    print(f"Price range tested: ₹{result['price_range_tested']['min']} - ₹{result['price_range_tested']['max']}")
    print("")
    print(f"⭐ Recommended price: ₹{result['recommended_price']}")
    print("")
    print(f"Predicted demand at recommended price: {result['predicted_demand']} units")
    print(f"Expected profit at recommended price: ₹{result['expected_profit']}")
    print("")
    print("Price vs Predicted Demand vs Predicted Profit:")
    for i, price in enumerate(result['price_candidates']):
        print(
            f"  ₹{price:6.2f} → {result['demand_predictions'][i]:3d} units → "
            f"₹{result['profit_predictions'][i]:7.2f} profit"
        )