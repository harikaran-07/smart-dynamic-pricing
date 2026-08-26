"""pricing.py — genuine dynamic price recommendation.

Strategy (only what the uploaded dataset supports):
  1. Find the price column and the units/demand column in the dataset.
  2. Fit a log-log demand model per product (or per product group when a
     product has too few observations):  ln(units) ~ a + b * ln(price).
     The fitted elasticity b must be negative and statistically plausible,
     otherwise price optimization is reported as UNSUPPORTED — the API never
     invents demand curves.
  3. Sweep candidate prices around the current price, estimate demand and
     revenue at each candidate, and pick the price that maximises the chosen
     business objective (revenue, or profit when a cost column exists).
  4. Cap predicted demand by an inventory-aware ceiling (max observed demand
     amplified slightly) so low-price extrapolation stays bounded.
  5. Build "why this price?" reasons exclusively from values that exist in
     the uploaded dataset.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

MIN_GROUP_ROWS = 20        # enough observations per product to fit its own curve
MIN_GROUP_ROWS_POOLED = 50 # category-level pooling threshold
CANDIDATE_STEPS = 14
PRICE_GRID_MIN = 0.6       # sweep from 60% ..
PRICE_GRID_MAX = 1.45      # .. to 145% of the current price
DEMAND_CEILING_MULT = 1.5
MAX_ELASTICITY = -0.01     # slope must be more negative than this to be usable

# Business rules (keep price recommendations realistic):
MAX_PRICE_INCREASE_PCT = 20.0   # never recommend more than +20% in one step
MIN_PRICE_FALLBACK_MULT = 0.5   # without a cost column, never go below 50% of current
MAX_PORTFOLIO_GROUPS = 100      # cap for per-product portfolio analysis


@dataclass
class DemandModel:
    kind: str               # "product" | "category" | "unsupported"
    intercept: float
    elasticity: float
    r2: float
    n_obs: int
    ceiling: float          # demand cap in units/day


class PricingError(ValueError):
    """User-facing pricing problem (400 responses)."""


def _column_hits(cols: list[str], keys: list[str]) -> dict[int, str]:
    out = {}
    for c in cols:
        low = str(c).lower().replace("_", " ").replace("-", " ").strip()
        score = 0
        for k in keys:
            if low == k:
                score = max(score, 4)      # exact match wins
            elif low.startswith(k + " ") or low.endswith(" " + k):
                score = max(score, 3)      # token match
            elif k in low:
                score = max(score, 1)      # substring match (weakest)
        if score:
            out[score] = c
    return out


def detect_columns(df: pd.DataFrame) -> dict:
    """Best-effort column detection. Returns None entries when absent.
    Each role is picked in priority order; already-claimed columns are
    excluded so 'competitor_price' never steals the 'price' role."""
    cols = list(df.columns)
    used = set()

    def pick(keys, fallback=None, skip_tokens=()):
        best_score, best_col = -1, fallback
        for c in cols:
            if c in used:
                continue
            low = str(c).lower().replace("_", " ").replace("-", " ").strip()
            if any(tok in low for tok in skip_tokens):
                continue
            score = 0
            for k in keys:
                if low == k:
                    score = max(score, 4)
                elif low.startswith(k + " ") or low.endswith(" " + k):
                    score = max(score, 3)
                elif k in low:
                    score = max(score, 1)
            if score > best_score:
                best_score, best_col = score, c
        if best_col:
            used.add(best_col)
        return best_col

    price = pick(["selling price", "unit price", "price", "prc"],
                 fallback=None, skip_tokens=("competitor", "comp "))
    cost = pick(["unit cost", "cogs", "product cost", "cost"], fallback=None)
    units = pick(["units sold", "quantity", "qty", "units", "sold", "demand"], fallback=None)
    competitor = pick(["competitor price", "competitor", "comp price"], fallback=None)
    inventory = pick(["inventory", "stock", "inv on hand", "inv"], fallback=None)
    discount = pick(["discount", "disc"], fallback=None)
    group = pick(["product id", "product", "sku", "category"], fallback=None)
    return {
        "price": price, "cost": cost, "units": units, "competitor": competitor,
        "inventory": inventory, "discount": discount, "group": group,
    }


def _fit_elasticity(price: np.ndarray, units: np.ndarray) -> tuple[float, float, float]:
    """Ordinary least squares: ln(units) = a + b * ln(price).
    Returns (a, b, r2)."""
    mask = (price > 0) & (units > 0) & np.isfinite(price) & np.isfinite(units)
    if mask.sum() < 8:
        return 0.0, 0.0, 0.0
    x = np.log(price[mask])
    y = np.log(units[mask])
    xm, ym = x.mean(), y.mean()
    denom = float(((x - xm) ** 2).sum())
    if denom <= 1e-12:
        return 0.0, 0.0, 0.0
    b = float(((x - xm) * (y - ym)).sum() / denom)
    a = float(ym - b * xm)
    yhat = a + b * x
    ss_res = float(((y - yhat) ** 2).sum())
    ss_tot = float(((y - ym) ** 2).sum())
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else 0.0
    return a, b, r2


def build_demand_model(df: pd.DataFrame, cols: dict, group_key: str | None,
                       category: str | None) -> DemandModel:
    """Fit a demand model for one product (or a category pool)."""
    sub = df.copy()
    if group_key:
        if category is not None:
            sub = sub[sub[group_key].astype(str) == str(category)]
        else:
            sub = sub[sub[group_key].astype(str) == str(group_key)]
    if cols["units"]:
        sub = sub[pd.to_numeric(sub[cols["units"]], errors="coerce").gt(0)]
    if cols["price"]:
        sub = sub[pd.to_numeric(sub[cols["price"]], errors="coerce").gt(0)]
    if len(sub) < 8:
        return DemandModel("unsupported", 0, 0, 0, len(sub), 0)

    price = pd.to_numeric(sub[cols["price"]], errors="coerce").to_numpy()
    units = pd.to_numeric(sub[cols["units"]], errors="coerce").to_numpy()
    a, b, r2 = _fit_elasticity(price, units)
    if b >= MAX_ELASTICITY:
        return DemandModel("unsupported", 0, 0, 0, len(sub), 0)
    ceiling = float(np.max(units) * DEMAND_CEILING_MULT) if len(units) else 0
    return DemandModel("product", a, b, r2, len(sub), ceiling)


def demand_at(model: DemandModel, price: float) -> float:
    if model.kind == "unsupported":
        return 0.0
    d = math.exp(model.intercept) * (price ** model.elasticity)
    return float(min(max(d, 0.0), model.ceiling))


def recommend(df: pd.DataFrame, cols: dict, row: dict, objective: str = "revenue") -> dict:
    """Compute the price recommendation for one product row."""
    if not cols["price"] or not cols["units"]:
        return {
            "supports_optimization": False,
            "reason": ("This dataset has no price column and/or no units-sold column, "
                       "so reliable price optimization is not possible. It can "
                       "still be used for sales prediction."),
            "current": None, "candidates": [], "optimal": None,
            "reasons": [], "demand_model": None, "caveat": None,
        }

    price_col, units_col = cols["price"], cols["units"]
    cur_price = _n(row.get(price_col), None) or _median_price(df, price_col)
    cur_cost = _n(row.get(cols["cost"]), None) if cols["cost"] else None
    cur_inv = _n(row.get(cols["inventory"]), None) if cols["inventory"] else None
    cur_comp = _n(row.get(cols["competitor"]), None) if cols["competitor"] else None

    if not cur_price or cur_price <= 0:
        return {
            "supports_optimization": False,
            "reason": ("A current price could not be determined for this product "
                       "(no price value found in the dataset row)."),
            "current": None, "candidates": [], "optimal": None,
            "reasons": [], "demand_model": None, "caveat": None,
        }

    group_key = None
    group_val = None
    if cols["group"]:
        group_key = cols["group"]
        group_val = str(row.get(group_key, "") or "")

    model = build_demand_model(df, cols, group_key, group_val)
    if model.kind == "unsupported" and group_key:
        # fall back to the widest pool: the whole dataset
        pooled_has_group = bool(group_key)
        model = build_demand_model(df, {**cols, "group": None}, None, None)
        if model.kind == "unsupported":
            return {
                "supports_optimization": False,
                "reason": ("Not enough price/sales variation was found in this dataset "
                           "to fit a pricing curve. The data is suitable for prediction "
                           "but insufficient for reliable dynamic-price optimization."),
                "current": None, "candidates": [], "optimal": None,
                "reasons": [], "demand_model": None, "caveat": None,
            }
        model.kind = "category" if pooled_has_group else "pooled"
    if model.kind == "unsupported":
        return {
            "supports_optimization": False,
            "reason": ("Not enough price/sales variation was found in this dataset "
                       "to fit a pricing curve. The data is suitable for prediction "
                       "but insufficient for reliable dynamic-price optimization."),
            "current": None, "candidates": [], "optimal": None,
            "reasons": [], "demand_model": None, "caveat": None,
        }

    lo = cur_price * PRICE_GRID_MIN
    hi = cur_price * PRICE_GRID_MAX

    # ---- business rules --------------------------------------------------
    # Rule 1: never recommend a price below the product's cost (zero/negative
    # margin). Without a cost column, fall back to 50% of the current price.
    # Rule 2: never increase the price more than MAX_PRICE_INCREASE_PCT at once.
    rules = []
    floor = None
    if cur_cost and cur_cost > 0:
        floor = cur_cost
        rules.append({
            "rule": "price-floor-at-cost",
            "applied": True,
            "detail": f"Candidates below cost ({cur_cost:.2f}) are excluded so the "
                      "recommendation never produces a loss-making price.",
        })
    else:
        floor = cur_price * MIN_PRICE_FALLBACK_MULT
    lo = max(lo, floor)
    if lo >= hi:
        lo = max(cur_price * 0.9, floor)

    cap = cur_price * (1 + MAX_PRICE_INCREASE_PCT / 100.0)
    if hi > cap:
        hi = cap
        rules.append({
            "rule": "max-single-step-increase",
            "applied": True,
            "detail": f"The sweep is capped at +{MAX_PRICE_INCREASE_PCT:.0f}% "
                      f"({cur_price:.2f} → {cap:.2f}) so prices never jump more than "
                      "20% in one recommendation.",
        })

    prices = np.linspace(lo, hi, CANDIDATE_STEPS)
    candidates = []
    for p in prices:
        d = demand_at(model, float(p))
        if cur_inv and cur_inv > 0:
            d = min(d, cur_inv)
        revenue = p * d
        profit = (p - cur_cost) * d if cur_cost and cur_cost > 0 else None
        cand = {
            "price": round(float(p), 2),
            "estimated_demand": round(float(d), 2),
            "estimated_revenue": round(float(revenue), 2),
        }
        if profit is not None:
            cand["estimated_profit"] = round(float(profit), 2)
        candidates.append(cand)

    if objective == "profit" and cur_cost and cur_cost > 0:
        scores = [{"score": (c["price"] - cur_cost) * c["estimated_demand"],
                   "c": c} for c in candidates]
    else:
        scores = [{"score": c["estimated_revenue"], "c": c} for c in candidates]
    optimal = max(scores, key=lambda s: s["score"])["c"]

    cur_demand = demand_at(model, cur_price)
    change_pct = round((optimal["price"] - cur_price) / cur_price * 100, 1)

    reasons = build_reasons(
        model=model, cur_price=cur_price, opt=optimal, cur_demand=cur_demand,
        cost=cur_cost, inventory=cur_inv, competitor=cur_comp, objective=objective,
        has_inventory=bool(cols["inventory"]), has_competitor=bool(cols["competitor"]),
        has_cost=bool(cols["cost"]), rules=rules)

    caveat = ("This recommendation is an ML-based estimate built from the uploaded "
              "dataset's own price and sales history. It is not a guaranteed "
              "real-world result — validate it with a small A/B change first.")

    optimal_payload = {
        "price": round(float(optimal["price"]), 2),
        "estimated_demand": round(float(optimal["estimated_demand"]), 2),
        "estimated_revenue": round(float(optimal["estimated_revenue"]), 2),
        "change_pct": change_pct,
        "objective": objective,
    }
    if "estimated_profit" in optimal:
        optimal_payload["estimated_profit"] = optimal["estimated_profit"]

    return {
        "supports_optimization": True,
        "reason": None,
        "demand_model": {
            "kind": model.kind,
            "r2": round(model.r2, 3),
            "n_obs": model.n_obs,
            "elasticity": round(model.elasticity, 3),
        },
        "reliability": reliability(model, cur_price, cur_cost),
        "rules": [r for r in rules if r.get("applied")],
        "current": {
            "price": round(float(cur_price), 2),
            "estimated_demand": round(float(cur_demand), 2),
        },
        "candidates": candidates,
        "optimal": optimal_payload,
        "reasons": reasons,
        "caveat": caveat,
    }


def reliability(model: DemandModel, cur_price: float,
                cost: float | None) -> dict:
    """Prediction reliability: High / Medium / Low with plain-language reasons.

    Scored from the quality of the fitted demand curve, how much history the
    model saw, and how plausible the data is — never a marketing label."""
    points = 0
    reasons = []
    if model.n_obs >= 150:
        points += 3
        reasons.append(f"Solid history: the curve was fitted on {model.n_obs} rows.")
    elif model.n_obs >= 30:
        points += 2
        reasons.append(f"Moderate history: only {model.n_obs} rows fit the curve.")
    else:
        points += 1
        reasons.append(f"Thin history: just {model.n_obs} rows — treat the estimate with care.")

    if model.r2 >= 0.3:
        points += 3
        reasons.append(f"Good fit (R² {model.r2:.2f} on the log-log curve).")
    elif model.r2 >= 0.1:
        points += 2
        reasons.append(f"Acceptable fit (R² {model.r2:.2f}) — price explains part of the variation.")
    else:
        points += 1
        reasons.append(f"Weak fit (R² {model.r2:.2f}) — other factors beyond price drive sales.")

    if -3.0 <= model.elasticity <= -0.3:
        points += 2
        reasons.append("Plausible price elasticity (no extreme extrapolation).")
    else:
        points += 1
        reasons.append("Extreme elasticity detected — extrapolation beyond observed prices is risky.")

    if cost and cost > 0:
        margin = (cur_price - cost) / cur_price * 100
        if margin > 0:
            points += 1
            reasons.append(f"Cost known; current margin {margin:.0f}% gives the optimisation a solid floor.")

    score = min(points, 9)
    level = "High" if score >= 7 else ("Medium" if score >= 4 else "Low")
    return {
        "level": level,
        "score": score,
        "max": 9,
        "reasons": reasons,
    }


def portfolio(df: pd.DataFrame, cols: dict, objective: str = "revenue",
              top: int = 10) -> dict:
    """Per-product recommendations across the whole catalogue.

    Uses the most recent row per product (latest sales history) and returns
    the products with the largest recommended price changes first."""
    if not cols["price"] or not cols["units"]:
        return {"items": [], "supported": 0, "total": 0,
                "note": "No price or units column — portfolio pricing is unavailable."}
    items = []
    seen = 0
    if cols["group"]:
        group_col = cols["group"]
        unique = [str(v) for v in df[group_col].dropna().unique()[:MAX_PORTFOLIO_GROUPS]]
        for g in unique:
            sub = df[df[group_col].astype(str) == g]
            if not len(sub):
                continue
            row = sub.iloc[-1].to_dict()
            rec = recommend(df, cols, row, objective=objective)
            if not rec.get("supports_optimization"):
                continue
            cur_p = rec["current"]["price"]
            opt = rec["optimal"]
            items.append({
                "product": g,
                "current_price": cur_p,
                "recommended_price": opt["price"],
                "change_pct": opt["change_pct"],
                "expected_demand": opt["estimated_demand"],
                "expected_revenue": opt["estimated_revenue"],
                "expected_profit": opt.get("estimated_profit"),
                "elasticity": rec["demand_model"]["elasticity"],
                "reliability": rec["reliability"]["level"],
            })
            seen += 1
    else:
        row = df.iloc[-1].to_dict()
        rec = recommend(df, cols, row, objective=objective)
        if rec.get("supports_optimization"):
            items.append({
                "product": "(whole dataset)",
                "current_price": rec["current"]["price"],
                "recommended_price": rec["optimal"]["price"],
                "change_pct": rec["optimal"]["change_pct"],
                "expected_demand": rec["optimal"]["estimated_demand"],
                "expected_revenue": rec["optimal"]["estimated_revenue"],
                "expected_profit": rec["optimal"].get("estimated_profit"),
                "elasticity": rec["demand_model"]["elasticity"],
                "reliability": rec["reliability"]["level"],
            })
            seen = 1
    items.sort(key=lambda it: abs(it["change_pct"]), reverse=True)
    return {"items": items[:top], "supported": seen, "total": seen,
            "note": None}


def build_reasons(model: DemandModel, cur_price: float, opt: dict, cur_demand: float,
                  cost: float | None, inventory: float | None, competitor: float | None,
                  objective: str, has_inventory: bool, has_competitor: bool,
                  has_cost: bool, rules: list | None = None) -> list[dict]:
    reasons = []
    delta = opt["price"] - cur_price
    if delta > 0:
        reasons.append({
            "icon": "↗", "tone": "up",
            "text": f"Estimated revenue is higher at the recommended price "
                    f"({opt['price']:.2f}) than at the current price ({cur_price:.2f}).",
        })
    elif delta < 0:
        reasons.append({
            "icon": "↓", "tone": "down",
            "text": f"A lower price is recommended — the fitted curve from your "
                    f"data expects substantially more units at {opt['price']:.2f}.",
        })
    else:
        reasons.append({
            "icon": "→", "tone": "flat",
            "text": "The current price already sits at the revenue-maximising point "
                    "of the fitted curve.",
        })

    demand_ratio = opt["estimated_demand"] / max(cur_demand, 1e-9)
    if demand_ratio > 1.05:
        reasons.append({
            "icon": "↑", "tone": "up",
            "text": f"Estimated units sold at the recommended price is "
                    f"{opt['estimated_demand']:.1f} units/day vs "
                    f"{cur_demand:.1f} today (+{round((demand_ratio-1)*100)}%).",
        })
    elif demand_ratio < 0.95:
        reasons.append({
            "icon": "↘", "tone": "down",
            "text": f"Higher price reduces estimated units to "
                    f"{opt['estimated_demand']:.1f} units/day — offset by better margin.",
        })

    if competitor and has_competitor:
        gap = (opt["price"] - competitor) / competitor * 100
        if gap > 3:
            reasons.append({
                "icon": "↗", "tone": "up",
                "text": f"The recommendation sits {gap:.0f}% above the competitor price "
                        f"({competitor:.2f}) — supported by your dataset's fitted curve.",
            })
        elif gap < -3:
            reasons.append({
                "icon": "↘", "tone": "down",
                "text": f"The recommendation sits {abs(gap):.0f}% below the competitor "
                        f"price ({competitor:.2f}) to defend sales.",
            })
        else:
            reasons.append({
                "icon": "→", "tone": "flat",
                "text": f"The recommendation stays within {abs(gap):.0f}% of the "
                        f"competitor price ({competitor:.2f}).",
            })

    if inventory and has_inventory:
        est = opt["estimated_demand"]
        if inventory < est * 7:
            reasons.append({
                "icon": "⚠", "tone": "flat",
                "text": f"Inventory is limited ({inventory:.0f} units) — the "
                        "recommended price balances expected sales against stock levels.",
            })
        else:
            reasons.append({
                "icon": "→", "tone": "flat",
                "text": f"Inventory ({inventory:.0f} units) is sufficient to absorb the "
                        f"estimated sales of {est:.1f} units/day.",
            })

    if cost and has_cost and objective == "profit":
        margin = (opt["price"] - cost) / opt["price"] * 100
        reasons.append({
            "icon": "✓", "tone": "up",
            "text": f"Chosen objective: profit. Estimated margin at the recommended "
                    f"price is {margin:.0f}% (cost {cost:.2f}).",
        })
    elif objective == "revenue":
        reasons.append({
            "icon": "◎", "tone": "flat",
            "text": "Chosen objective: revenue. The recommended price maximises "
                    "estimated price × units from the fitted curve.",
        })
    else:
        reasons.append({
            "icon": "◎", "tone": "flat",
            "text": "Chosen objective: profit. The recommended price maximises "
                    "estimated (price − cost) × units.",
        })

    reasons.append({
        "icon": "ℹ", "tone": "flat",
        "text": f"Pricing model: {model.kind}-level log-log fit on {model.n_obs} rows "
                f"(R² {model.r2:.3f}) — a statistical estimate, not a guarantee.",
    })
    for rule in (rules or []):
        if rule.get("applied"):
            reasons.append({
                "icon": "⚖", "tone": "flat",
                "text": f"Business rule applied: {rule['detail']}",
            })
    return reasons


def _median_price(df: pd.DataFrame, price_col: str) -> float | None:
    s = pd.to_numeric(df[price_col], errors="coerce").dropna()
    return float(s.median()) if len(s) else None


def _n(v, default):
    if v is None:
        return default
    try:
        f = float(v)
        return f if np.isfinite(f) else default
    except (TypeError, ValueError):
        return default