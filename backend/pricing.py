"""pricing.py — demand estimation, rule-constrained price recommendation,
manual scenario calculator, tabular Q-learning and negotiation.

Everything returned to the dashboard is computed from the uploaded data or
from inputs the user explicitly supplied. Values that are assumptions are
labelled as assumptions; nothing is invented.

Demand model (per product, pooled when a product has too little history):

    ln(units) = a + b*ln(price) + c*ln(competitor_price) + d*discount
                + day-of-week dummies + month dummies

`b` is the price elasticity of demand and is reported together with its
standard error, 95% confidence interval and p-value.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

MIN_GROUP_ROWS = 20        # enough observations per product to fit its own curve
CANDIDATE_STEPS = 400      # price grid resolution (>= 200 required)
PRICE_GRID_MIN = 0.5       # sweep from 50% ..
PRICE_GRID_MAX = 1.2       # .. to 120% of the current price
DEMAND_CEILING_MULT = 3.0  # bounded extrapolation above observed demand
MAX_ELASTICITY = -0.01     # slope must be more negative than this to be usable
Z95 = 1.959963984540054

# Business rules (keep price recommendations realistic):
MAX_PRICE_INCREASE_PCT = 20.0   # never recommend more than +20% in one step
MIN_PRICE_FALLBACK_MULT = 0.5   # without a cost column, never go below 50% of current
MAX_PORTFOLIO_GROUPS = 100      # cap for per-product portfolio analysis
PORTFOLIO_MEDIAN_DAYS = 14      # current price = median of the last 14 days

DEFAULT_MIN_MARGIN_PCT = 20.0
ACTION_MULTIPLIERS = [0.85, 0.92, 1.0, 1.08, 1.15]
RL_INV_BUCKETS = 3
RL_PRESSURE_BUCKETS = 3
RL_GAP_BUCKETS = 3


@dataclass
class DemandModel:
    kind: str                       # "product" | "category" | "pooled" | "unsupported"
    elasticity: float
    intercept: float                # log-demand intercept at the row's controls
    r2: float
    n_obs: int
    ceiling: float                  # demand cap in units/day
    se: float | None = None
    ci_low: float | None = None
    ci_high: float | None = None
    p_value: float | None = None
    controls: list[dict] = field(default_factory=list)


class PricingError(ValueError):
    """User-facing pricing problem (400 responses)."""


# --------------------------------------------------------------------------
# column detection
# --------------------------------------------------------------------------
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
    date = pick(["order date", "sale date", "transaction date", "date", "day"],
                fallback=None)
    return {
        "price": price, "cost": cost, "units": units, "competitor": competitor,
        "inventory": inventory, "discount": discount, "group": group, "date": date,
    }


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _n(v, default):
    if v is None:
        return default
    try:
        f = float(v)
        return f if np.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _median_price(df: pd.DataFrame, price_col: str) -> float | None:
    s = pd.to_numeric(df[price_col], errors="coerce").dropna()
    return float(s.median()) if len(s) else None


def _num(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def _date_series(df: pd.DataFrame, cols: dict) -> pd.Series | None:
    """Parse the detected date column; fall back to any parseable date column."""
    candidates = []
    if cols.get("date"):
        candidates.append(cols["date"])
    candidates += [c for c in df.columns
                   if "date" in str(c).lower() and c not in candidates]
    for c in candidates:
        try:
            dt = pd.to_datetime(df[c], errors="coerce")
        except Exception:
            continue
        if dt.notna().mean() > 0.5:
            return dt
    return None


def _dummies(series: pd.Series, prefix: str, drop_first: bool = True) -> pd.DataFrame:
    """One-hot encode a small integer-coded category, dropping one level."""
    d = pd.get_dummies(series.astype("Int64").astype(str), prefix=prefix,
                       dummy_na=False, dtype=float)
    if drop_first and len(d.columns) > 1:
        d = d.drop(columns=sorted(d.columns)[0])
    return d


def _p_value(t_stat: float | None, dof: int) -> float | None:
    if t_stat is None or dof <= 0:
        return None
    # normal approximation of the two-sided t test (dof is large in practice)
    return float(math.erfc(abs(t_stat) / math.sqrt(2.0)))


# --------------------------------------------------------------------------
# demand estimation
# --------------------------------------------------------------------------
def _subset(df: pd.DataFrame, cols: dict, group_key: str | None,
            group_val) -> pd.DataFrame:
    sub = df
    if group_key:
        sub = sub[sub[group_key].astype(str) == str(group_val)]
    if cols["units"]:
        sub = sub[_num(sub[cols["units"]]).gt(0)]
    if cols["price"]:
        sub = sub[_num(sub[cols["price"]]).gt(0)]
    return sub.drop_duplicates()


def _design_matrix(sub: pd.DataFrame, cols: dict):
    """Build (X, y, names, control_names) for the log-log demand model."""
    price = _num(sub[cols["price"]])
    units = _num(sub[cols["units"]])
    mask = price.gt(0) & units.gt(0) & price.notna() & units.notna()
    sub = sub[mask]
    price = price[mask]
    units = units[mask]
    if len(sub) < 8:
        return None

    parts = [np.ones(len(sub)), np.log(price.to_numpy())]
    names = ["intercept", "log_price"]
    controls = ["log_price"]

    if cols["competitor"]:
        comp = _num(sub[cols["competitor"]])
        ok = comp.gt(0)
        if ok.any() and comp[ok].nunique() > 1:
            values = np.where(ok, np.log(comp.where(ok, 1.0)), np.log(comp[ok].median()))
            parts.append(values)
            names.append("log_competitor")
            controls.append("log_competitor")

    if cols["discount"]:
        disc = _num(sub[cols["discount"]])
        if disc.notna().sum() > 0 and disc.nunique() > 1:
            scale = 0.01 if disc.max() > 1 else 1.0
            values = disc.fillna(disc.median()).to_numpy() * scale
            parts.append(values)
            names.append("discount")
            controls.append("discount")

    dt = _date_series(sub, cols)
    if dt is not None and dt.notna().mean() > 0.5:
        dow = dt.dt.dayofweek
        month = dt.dt.month
        if dow.nunique() > 1:
            dd = _dummies(dow, "dow")
            for c in dd.columns:
                parts.append(dd[c].to_numpy())
                names.append(c)
        if month.nunique() > 1:
            mm = _dummies(month, "month")
            for c in mm.columns:
                parts.append(mm[c].to_numpy())
                names.append(c)

    X = np.column_stack(parts)
    y = np.log(units.to_numpy())
    return X, y, names, controls


def _control_values(row: dict, sub: pd.DataFrame, cols: dict,
                    controls: list[str]) -> dict:
    """Values of every non-price regressor for the row being priced."""
    out = {}
    if "log_competitor" in controls:
        comp = _n(row.get(cols["competitor"]), None) if cols["competitor"] else None
        if comp is None or comp <= 0:
            series = _num(sub[cols["competitor"]]).dropna()
            series = series[series > 0]
            comp = float(series.median()) if len(series) else None
        out["log_competitor"] = math.log(comp) if comp and comp > 0 else 0.0

    if "discount" in controls:
        disc = _n(row.get(cols["discount"]), None) if cols["discount"] else None
        if disc is None:
            series = _num(sub[cols["discount"]]).dropna()
            disc = float(series.median()) if len(series) else 0.0
        out["discount"] = disc * (0.01 if abs(disc) > 1 else 1.0)

    dt = _date_series(sub, cols)
    if dt is not None and dt.notna().mean() > 0.5:
        # use the row's date, else the last observed date
        row_date = pd.to_datetime(row.get(cols["date"]) if cols.get("date") else None,
                                  errors="coerce")
        if pd.isna(row_date):
            row_date = dt.dropna().iloc[-1]
        dow_col = "dow_" + str(int(row_date.dayofweek))
        month_col = "month_" + str(int(row_date.month))
        # dummies dropped one level: the first level is the baseline (zero)
        out[dow_col] = 1.0
        out[month_col] = 1.0
    return out


def build_demand_model(df: pd.DataFrame, cols: dict, row: dict,
                       group_key: str | None = None,
                       group_val=None,
                       kind: str = "product") -> DemandModel:
    """Fit the log-log demand model for one product (or a category pool)."""
    sub = _subset(df, cols, group_key, group_val)
    if len(sub) < MIN_GROUP_ROWS:
        return DemandModel("unsupported", 0.0, 0.0, 0.0, len(sub), 0.0)

    design = _design_matrix(sub, cols)
    if design is None:
        return DemandModel("unsupported", 0.0, 0.0, 0.0, len(sub), 0.0)
    X, y, names, controls = design
    n, k = X.shape
    if n <= k + 2:
        return DemandModel("unsupported", 0.0, 0.0, 0.0, n, 0.0)

    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    yhat = X @ beta
    resid = y - yhat
    ss_res = float((resid ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else 0.0

    elasticity = float(beta[names.index("log_price")])
    dof = max(n - k, 1)
    sigma2 = ss_res / dof
    se = None
    ci_low = ci_high = None
    p_value = None
    try:
        xtx_inv = np.linalg.pinv(X.T @ X)
        se = float(math.sqrt(max(sigma2 * xtx_inv[1, 1], 0.0)))
        ci_low = elasticity - Z95 * se
        ci_high = elasticity + Z95 * se
        p_value = _p_value(elasticity / se if se > 0 else None, dof)
    except Exception:  # pragma: no cover - numerical edge case
        pass

    if elasticity >= MAX_ELASTICITY:
        return DemandModel("unsupported", 0.0, 0.0, 0.0, n, 0.0)

    control_names = [n for n in names if n not in ("intercept", "log_price")]
    control_values = _control_values(row, sub, cols, control_names)
    intercept = float(beta[0])
    control_report = []
    for name in control_names:
        coef = float(beta[names.index(name)])
        value = float(control_values.get(name, 0.0) or 0.0)
        intercept += coef * value
        # keep the report readable: only the named economic controls
        if name in ("log_competitor", "discount"):
            control_report.append({"control": name, "coefficient": round(coef, 4),
                                   "value": round(value, 4)})

    observed_max = float(_num(sub[cols["units"]]).max())
    inventory = _n(row.get(cols["inventory"]), None) if cols["inventory"] else None
    ceiling = max(DEMAND_CEILING_MULT * observed_max, float(inventory or 0))

    return DemandModel(
        kind=kind, elasticity=elasticity, intercept=intercept, r2=r2, n_obs=n,
        ceiling=ceiling, se=se, ci_low=ci_low, ci_high=ci_high,
        p_value=p_value, controls=control_report,
    )


def demand_at(model: DemandModel, price: float) -> float:
    if model.kind == "unsupported" or price <= 0:
        return 0.0
    d = math.exp(model.intercept) * (price ** model.elasticity)
    if not np.isfinite(d):
        return 0.0
    return float(min(max(d, 0.0), model.ceiling))


# --------------------------------------------------------------------------
# reliability
# --------------------------------------------------------------------------
def reliability(model: DemandModel) -> dict:
    """Reliability label from the fitted curve — never a marketing score.

    Low    : R² < 0.10, or the 95% CI of the elasticity includes 0, or n < 30.
    High   : R² >= 0.30 AND n >= 150 AND the CI excludes 0 AND
             elasticity is inside [-3, -0.3].
    Medium : everything else.
    """
    reasons = []
    ci_includes_zero = True
    if model.ci_low is not None and model.ci_high is not None:
        ci_includes_zero = model.ci_low <= 0.0 <= model.ci_high

    reasons.append(f"Elasticity {model.elasticity:.2f} fitted on {model.n_obs} rows.")
    if model.se is not None and model.ci_low is not None:
        reasons.append(
            f"95% CI {model.ci_low:.2f} to {model.ci_high:.2f}"
            + (f", p = {model.p_value:.3f}" if model.p_value is not None else "")
            + "."
        )
    reasons.append(f"R² {model.r2:.2f} on the log-log curve.")

    low = model.r2 < 0.10 or ci_includes_zero or model.n_obs < 30
    high = (model.r2 >= 0.30 and model.n_obs >= 150 and not ci_includes_zero
            and -3.0 <= model.elasticity <= -0.3)

    if low:
        why = []
        if model.r2 < 0.10:
            why.append(f"R² {model.r2:.2f} is below 0.10")
        if ci_includes_zero:
            why.append("the 95% CI of the elasticity includes zero")
        if model.n_obs < 30:
            why.append(f"only {model.n_obs} observations")
        reasons.append("Low confidence: " + "; ".join(why) + ".")
        level = "Low"
    elif high:
        reasons.append("High confidence: good fit, enough history, significant "
                       "elasticity in a plausible range.")
        level = "High"
    else:
        missing = []
        if model.r2 < 0.30:
            missing.append(f"R² {model.r2:.2f} < 0.30")
        if model.n_obs < 150:
            missing.append(f"{model.n_obs} rows < 150")
        if not (-3.0 <= model.elasticity <= -0.3):
            missing.append(f"elasticity {model.elasticity:.2f} outside [-3, -0.3]")
        if missing:
            reasons.append("Medium confidence: " + "; ".join(missing) + ".")
        level = "Medium"

    return {"level": level, "score": None, "max": None, "reasons": reasons}


# --------------------------------------------------------------------------
# recommendation from an uploaded dataset
# --------------------------------------------------------------------------
def _unsupported(reason: str) -> dict:
    return {
        "supports_optimization": False, "reason": reason,
        "current": None, "candidates": [], "optimal": None,
        "reasons": [], "demand_model": None, "caveat": None,
        "rules": [], "warnings": [reason],
    }


def _fit_with_fallback(df: pd.DataFrame, cols: dict, row: dict):
    group_key = cols.get("group")
    group_val = str(row.get(group_key, "") or "") if group_key else None
    model = build_demand_model(df, cols, row, group_key, group_val, "product")
    if model.kind != "unsupported":
        return model
    if group_key:
        pooled = build_demand_model(df, cols, row, None, None, "category")
        if pooled.kind != "unsupported":
            return pooled
    return build_demand_model(df, cols, row, None, None, "pooled")


def recommend(df: pd.DataFrame, cols: dict, row: dict,
              objective: str = "profit") -> dict:
    """Compute the price recommendation for one product row."""
    if not cols["price"] or not cols["units"]:
        return _unsupported(
            "This dataset has no price column and/or no units-sold column, so "
            "reliable price optimisation is not possible. It can still be used "
            "for sales prediction."
        )

    df = df.drop_duplicates()
    price_col, units_col = cols["price"], cols["units"]
    cur_price = _n(row.get(price_col), None) or _median_price(df, price_col)
    cur_cost = _n(row.get(cols["cost"]), None) if cols["cost"] else None
    cur_inv = _n(row.get(cols["inventory"]), None) if cols["inventory"] else None
    cur_comp = _n(row.get(cols["competitor"]), None) if cols["competitor"] else None

    if not cur_price or cur_price <= 0:
        return _unsupported(
            "A current price could not be determined for this product."
        )

    model = _fit_with_fallback(df, cols, row)
    if model.kind == "unsupported":
        return _unsupported(
            "Not enough price/sales variation was found in this dataset to fit "
            "a pricing curve. The data is suitable for prediction but "
            "insufficient for reliable dynamic-price optimisation."
        )

    warnings: list[str] = []
    objective = (objective or "profit").lower()
    has_cost = bool(cur_cost and cur_cost > 0)
    if objective == "profit" and not has_cost:
        warnings.append(
            "No cost column: profit cannot be computed, so revenue is maximised instead."
        )
        objective = "revenue"
    if not has_cost:
        warnings.append(
            "Without a cost column the profit objective is unavailable and there "
            "is no cost floor."
        )

    floor = cur_cost if has_cost else cur_price * MIN_PRICE_FALLBACK_MULT
    cap = cur_price * (1 + MAX_PRICE_INCREASE_PCT / 100.0)
    lo = max(cur_price * PRICE_GRID_MIN, floor)
    hi = cap
    if lo > hi:                       # cost floor above the +20% cap
        warnings.append(
            f"The cost floor {floor:.2f} is above the +{MAX_PRICE_INCREASE_PCT:.0f}% "
            f"cap {cap:.2f}; the recommendation is clamped to the cap."
        )
        lo = hi

    prices = np.linspace(lo, hi, CANDIDATE_STEPS)
    candidates = []
    for p in prices:
        d = demand_at(model, float(p))
        if cur_inv and cur_inv > 0:
            d = min(d, float(cur_inv))
        revenue = p * d
        cand = {
            "price": round(float(p), 2),
            "estimated_demand": round(float(d), 3),
            "estimated_revenue": round(float(revenue), 2),
        }
        if has_cost:
            cand["estimated_profit"] = round(float((p - cur_cost) * d), 2)
        candidates.append(cand)

    if objective == "profit" and has_cost:
        scored = [((c["price"] - cur_cost) * c["estimated_demand"], c) for c in candidates]
    else:
        scored = [(c["estimated_revenue"], c) for c in candidates]
    best_score, optimal = max(scored, key=lambda s: s[0])

    cur_demand = demand_at(model, cur_price)
    if cur_inv and cur_inv > 0:
        cur_demand = min(cur_demand, float(cur_inv))
    cur_revenue = cur_price * cur_demand
    cur_profit = (cur_price - cur_cost) * cur_demand if has_cost else None

    opt_price = float(optimal["price"])
    opt_demand = float(optimal["estimated_demand"])
    opt_revenue = opt_price * opt_demand
    opt_profit = (opt_price - cur_cost) * opt_demand if has_cost else None
    change_pct = round((opt_price - cur_price) / cur_price * 100, 1)

    # ---- rules: listed only when they actually bound the result ----------
    rules = []
    if has_cost and opt_price <= lo + 1e-9 and lo > cur_price * PRICE_GRID_MIN + 1e-12:
        rules.append({
            "rule": "price-floor-at-cost",
            "applied": True,
            "detail": f"The recommendation sits on the cost floor {cur_cost:.2f}: no "
                      "candidate below cost is allowed because that would be loss-making.",
        })
    if opt_price >= hi - 1e-9:
        rules.append({
            "rule": "max-single-step-increase",
            "applied": True,
            "detail": f"The recommendation sits on the +{MAX_PRICE_INCREASE_PCT:.0f}% cap "
                      f"({cur_price:.2f} → {cap:.2f}); prices are never raised more than that in one step.",
        })
    if model.ceiling and abs(opt_demand - model.ceiling) < 1e-6:
        rules.append({
            "rule": "demand-ceiling",
            "applied": True,
            "detail": f"Estimated demand at the recommended price is capped at "
                      f"{model.ceiling:.0f} units/day (inventory / bounded extrapolation).",
        })

    # ---- warnings --------------------------------------------------------
    if has_cost and cur_cost >= cur_price:
        warnings.append(
            f"Cost ({cur_cost:.2f}) is not below the current price ({cur_price:.2f}): "
            "the product is currently loss-making."
        )
    if objective == "revenue" and has_cost and opt_profit is not None and cur_profit:
        profit_change = (opt_profit - cur_profit) / abs(cur_profit) * 100
        if opt_profit < cur_profit:
            warnings.append(
                f"Revenue objective: profit is expected to fall from {cur_profit:.2f} "
                f"to {opt_profit:.2f} ({profit_change:+.1f}%)."
            )
    if model.elasticity > -1:
        warnings.append(
            f"Elasticity is {model.elasticity:.2f} (inelastic): raising the price "
            "increases revenue over the tested range."
        )

    # sensitivity around the recommendation, computed from the fitted curve
    sensitivity = []
    for delta in (-10, -5, 0, 5, 10):
        p = opt_price * (1 + delta / 100.0)
        d = demand_at(model, p)
        if cur_inv and cur_inv > 0:
            d = min(d, float(cur_inv))
        prof = (p - cur_cost) * d if has_cost else None
        sensitivity.append({
            "price_change_pct": delta,
            "price": round(p, 2),
            "demand": round(d, 3),
            "revenue": round(p * d, 2),
            **({"profit": round(prof, 2)} if prof is not None else {}),
            **({"profit_change_pct": round((prof - opt_profit) / abs(opt_profit) * 100, 1)
               if opt_profit else None} if prof is not None else {}),
        })

    reasons = build_reasons(
        model=model, cur_price=cur_price, opt_price=opt_price,
        cur_demand=cur_demand, opt_demand=opt_demand,
        cur_revenue=cur_revenue, opt_revenue=opt_revenue,
        cur_profit=cur_profit, opt_profit=opt_profit,
        cost=cur_cost, inventory=cur_inv, competitor=cur_comp,
        objective=objective, rules=rules,
    )

    payload = {
        "price": round(opt_price, 2),
        "estimated_demand": round(opt_demand, 3),
        "estimated_revenue": round(opt_revenue, 2),
        "change_pct": change_pct,
        "objective": objective,
    }
    if opt_profit is not None:
        payload["estimated_profit"] = round(opt_profit, 2)
        payload["margin_pct"] = round((opt_price - cur_cost) / opt_price * 100, 1)
        payload["profit_change_pct"] = (
            round((opt_profit - cur_profit) / abs(cur_profit) * 100, 1)
            if cur_profit else None
        )

    return {
        "supports_optimization": True,
        "reason": None,
        "demand_model": {
            "kind": model.kind,
            "r2": round(model.r2, 3),
            "n_obs": model.n_obs,
            "elasticity": round(model.elasticity, 3),
            "elasticity_se": round(model.se, 3) if model.se is not None else None,
            "elasticity_ci95": (
                [round(model.ci_low, 3), round(model.ci_high, 3)]
                if model.ci_low is not None else None
            ),
            "elasticity_p_value": (
                round(model.p_value, 4) if model.p_value is not None else None
            ),
            "controls": model.controls,
        },
        "reliability": reliability(model),
        "rules": rules,
        "warnings": warnings,
        "sensitivity": sensitivity,
        "current": {
            "price": round(float(cur_price), 2),
            "estimated_demand": round(float(cur_demand), 3),
            "estimated_revenue": round(float(cur_revenue), 2),
            **({"estimated_profit": round(float(cur_profit), 2),
                "margin_pct": round((cur_price - cur_cost) / cur_price * 100, 1)}
               if has_cost else {}),
        },
        "candidates": candidates,
        "optimal": payload,
        "reasons": reasons,
        "caveat": (
            "This is a statistical estimate from the uploaded history, not a "
            "guarantee. Validate the change with a small live test first."
        ),
    }


def build_reasons(model: DemandModel, cur_price: float, opt_price: float,
                  cur_demand: float, opt_demand: float,
                  cur_revenue: float, opt_revenue: float,
                  cur_profit: float | None, opt_profit: float | None,
                  cost: float | None, inventory: float | None,
                  competitor: float | None, objective: str,
                  rules: list | None = None) -> list[dict]:
    """Plain-language reasons built only from the computed numbers."""
    reasons = []
    delta_pct = (opt_price - cur_price) / cur_price * 100
    if abs(delta_pct) < 0.05:
        reasons.append({"icon": "→", "tone": "flat",
                        "text": "The current price is already the best point on the "
                                f"fitted curve for the {objective} objective."})
    else:
        direction = "raise" if delta_pct > 0 else "lower"
        reasons.append({
            "icon": "↗" if delta_pct > 0 else "↘",
            "tone": "up" if delta_pct > 0 else "down",
            "text": f"The model {direction}s the price by {abs(delta_pct):.1f}% "
                    f"({cur_price:.2f} → {opt_price:.2f}) to maximise {objective}.",
        })

    demand_change = (opt_demand - cur_demand) / cur_demand * 100 if cur_demand else 0.0
    reasons.append({
        "icon": "↑" if demand_change > 0 else "↓",
        "tone": "up" if demand_change > 0 else "down",
        "text": f"Estimated demand moves from {cur_demand:.1f} to {opt_demand:.1f} "
                f"units/day ({demand_change:+.1f}%) at the recommended price.",
    })

    reasons.append({
        "icon": "◎", "tone": "flat",
        "text": f"Estimated {objective} changes from "
                f"{(cur_profit if objective == 'profit' else cur_revenue):.2f} to "
                f"{(opt_profit if objective == 'profit' else opt_revenue):.2f} per day.",
    })

    if cost:
        margin = (opt_price - cost) / opt_price * 100 if opt_price else 0.0
        reasons.append({
            "icon": "✓", "tone": "up" if margin > 0 else "down",
            "text": f"Margin at the recommended price is {margin:.1f}% "
                    f"(price {opt_price:.2f}, cost {cost:.2f}).",
        })

    if competitor and competitor > 0:
        gap = (opt_price - competitor) / competitor * 100
        reasons.append({
            "icon": "→", "tone": "flat",
            "text": f"The recommended price sits {gap:+.1f}% vs the competitor "
                    f"({competitor:.2f}); the competitor price is a guardrail, not a "
                    "driver of the fitted curve.",
        })

    if inventory and inventory > 0:
        days = inventory / opt_demand if opt_demand > 0 else float("inf")
        reasons.append({
            "icon": "▦", "tone": "flat",
            "text": f"Inventory of {inventory:.0f} units covers about {days:.1f} days "
                    f"at the estimated demand of {opt_demand:.1f} units/day.",
        })

    reasons.append({
        "icon": "ℹ", "tone": "flat",
        "text": f"Demand curve: {model.kind} log-log fit on {model.n_obs} rows, "
                f"elasticity {model.elasticity:.2f}, R² {model.r2:.2f}.",
    })
    for rule in (rules or []):
        reasons.append({"icon": "⚖", "tone": "flat",
                        "text": f"Business rule applied: {rule['detail']}"})
    return reasons


# --------------------------------------------------------------------------
# portfolio
# --------------------------------------------------------------------------
def _recent_row(sub: pd.DataFrame, cols: dict) -> dict:
    """Aggregate row for a product: current price = median of the last 14 days."""
    sub = sub.copy()
    if cols.get("date"):
        dt = pd.to_datetime(sub[cols["date"]], errors="coerce")
        if dt.notna().any():
            cutoff = dt.max() - pd.Timedelta(days=PORTFOLIO_MEDIAN_DAYS - 1)
            recent = sub[dt >= cutoff]
            if len(recent) < 3:
                recent = sub.tail(max(3, PORTFOLIO_MEDIAN_DAYS))
        else:
            recent = sub.tail(PORTFOLIO_MEDIAN_DAYS)
    else:
        recent = sub.tail(PORTFOLIO_MEDIAN_DAYS)

    def med(col, scale=1.0):
        if not col or col not in sub.columns:
            return None
        s = _num(recent[col]).dropna()
        return float(s.median()) * scale if len(s) else None

    row = {}
    if cols["price"]:
        row[cols["price"]] = med(cols["price"])
    if cols["cost"]:
        row[cols["cost"]] = med(cols["cost"])
    if cols["units"]:
        s = _num(recent[cols["units"]]).dropna()
        row[cols["units"]] = float(s.mean()) if len(s) else None
    if cols["competitor"]:
        row[cols["competitor"]] = med(cols["competitor"])
    if cols["discount"]:
        row[cols["discount"]] = med(cols["discount"])
    if cols["inventory"]:
        s = _num(recent[cols["inventory"]]).dropna()
        row[cols["inventory"]] = float(s.iloc[-1]) if len(s) else None
    if cols["date"]:
        last = pd.to_datetime(recent[cols["date"]], errors="coerce").dropna()
        row[cols["date"]] = last.iloc[-1] if len(last) else None
    if cols["group"]:
        row[cols["group"]] = str(sub[cols["group"]].iloc[-1])
    return {k: v for k, v in row.items() if v is not None}


def portfolio(df: pd.DataFrame, cols: dict, objective: str = "profit",
              top: int = 10) -> dict:
    """Per-product recommendations across the catalogue.

    The current price of each product is the median price of the last 14 days
    (not the last row), so a single odd transaction cannot move the baseline.
    """
    if not cols["price"] or not cols["units"]:
        return {"items": [], "supported": 0, "total": 0,
                "note": "No price or units column — portfolio pricing is unavailable."}
    df = df.drop_duplicates()
    items = []
    seen = 0

    if cols["group"]:
        group_col = cols["group"]
        unique = [str(v) for v in df[group_col].dropna().unique()[:MAX_PORTFOLIO_GROUPS]]
        for g in unique:
            sub = df[df[group_col].astype(str) == g]
            if not len(sub):
                continue
            row = _recent_row(sub, cols)
            if not row.get(cols["price"]):
                continue
            rec = recommend(df, cols, row, objective=objective)
            if not rec.get("supports_optimization"):
                continue
            items.append({
                "product": g,
                "current_price": rec["current"]["price"],
                "recommended_price": rec["optimal"]["price"],
                "change_pct": rec["optimal"]["change_pct"],
                "expected_demand": rec["optimal"]["estimated_demand"],
                "expected_revenue": rec["optimal"]["estimated_revenue"],
                "expected_profit": rec["optimal"].get("estimated_profit"),
                "current_revenue": rec["current"].get("estimated_revenue"),
                "current_profit": rec["current"].get("estimated_profit"),
                "elasticity": rec["demand_model"]["elasticity"],
                "reliability": rec["reliability"]["level"],
            })
            seen += 1
    else:
        row = _recent_row(df, cols)
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
                "current_revenue": rec["current"].get("estimated_revenue"),
                "current_profit": rec["current"].get("estimated_profit"),
                "elasticity": rec["demand_model"]["elasticity"],
                "reliability": rec["reliability"]["level"],
            })
            seen = 1

    items.sort(key=lambda it: abs(it["change_pct"]), reverse=True)
    return {"items": items[:top], "supported": seen, "total": seen, "note": None}


# --------------------------------------------------------------------------
# tabular Q-learning (trained here, not hard-coded)
# --------------------------------------------------------------------------
def _bucket(value: float, edges: list[float]) -> int:
    for i, edge in enumerate(edges):
        if value < edge:
            return i
    return len(edges)


def _rl_state(inventory: float, base_demand: float, gap: float) -> tuple[int, int, int]:
    days_cover = inventory / base_demand if base_demand > 0 else 99.0
    inv_b = _bucket(days_cover, [7.0, 30.0])
    pressure = min(1.0, base_demand / max(inventory / 7.0, 1e-9)) if inventory > 0 else 0.0
    pre_b = _bucket(pressure, [0.33, 0.66])
    gap_b = _bucket(gap, [-0.10, 0.10])
    return int(inv_b), int(pre_b), int(gap_b)


def q_learn(model: DemandModel, current_price: float, cost: float,
            inventory: float, competitor: float | None,
            episodes: int = 1200, steps_per_episode: int = 20,
            seed: int = 7) -> dict:
    """Train a tabular Q-learning agent on the fitted demand model.

    States : (inventory bucket, demand-pressure bucket, competitor-gap bucket)
    Actions: price multipliers applied to the current price
    Reward : profit over one simulated day (price - cost) x units sold

    The Q-table below is the trained result of this call; no values are
    pre-set anywhere in the code.
    """
    import time as _time

    started = _time.perf_counter()
    rng = np.random.default_rng(seed)
    base = float(current_price)
    floor = max(float(cost) if cost else 0.0, base * MIN_PRICE_FALLBACK_MULT)
    cap = base * (1 + MAX_PRICE_INCREASE_PCT / 100.0)
    gaps_base = ((base - competitor) / competitor) if competitor else 0.0

    q = np.zeros((RL_INV_BUCKETS, RL_PRESSURE_BUCKETS, RL_GAP_BUCKETS,
                  len(ACTION_MULTIPLIERS)))
    alpha, gamma, eps = 0.20, 0.85, 0.25
    steps = 0
    base_demand = demand_at(model, base) or 1.0

    for _episode in range(episodes):
        inv = max(1.0, float(inventory) * float(rng.uniform(0.4, 1.4)))
        gap = gaps_base + float(rng.normal(0, 0.05))
        for _step in range(steps_per_episode):
            demand_now = demand_at(model, base) * (1.0 + float(rng.normal(0, 0.05)))
            demand_now = max(demand_now, 1e-6)
            state = _rl_state(inv, demand_now, gap)
            if rng.random() < eps:
                action = int(rng.integers(len(ACTION_MULTIPLIERS)))
            else:
                action = int(np.argmax(q[state]))

            price = min(max(base * ACTION_MULTIPLIERS[action], floor), cap)
            demand = min(demand_at(model, price), inv)
            reward = (price - floor) * demand
            inv = max(0.0, inv - demand)
            gap = float(np.clip(gap + rng.normal(0, 0.02), -0.5, 0.5))
            next_state = _rl_state(max(inv, 1.0), demand_now, gap)
            td = reward + gamma * float(np.max(q[next_state])) - q[state][action]
            q[state][action] += alpha * td
            steps += 1

    # greedy action for the row's actual state
    state = _rl_state(float(inventory), base_demand, gaps_base)
    action = int(np.argmax(q[state]))
    price = min(max(base * ACTION_MULTIPLIERS[action], floor), cap)
    demand = min(demand_at(model, price), float(inventory))
    elapsed = _time.perf_counter() - started

    return {
        "method": "q-learning",
        "price": round(float(price), 2),
        "base_price": round(base, 2),
        "action_index": action,
        "action_multiplier": ACTION_MULTIPLIERS[action],
        "action_prices": [round(float(min(max(base * m, floor), cap)), 2)
                          for m in ACTION_MULTIPLIERS],
        "q_values": [round(float(v), 4) for v in q[state]],
        "q_table": np.round(q, 4).tolist(),
        "state": {
            "inventory": round(float(inventory), 2),
            "inventory_bucket": state[0],
            "demand_pressure_bucket": state[1],
            "competitor_gap_bucket": state[2],
            "competitor_gap_pct": round(gaps_base * 100, 1),
            "base_demand": round(float(base_demand), 2),
        },
        "learning_steps": steps,
        "episodes": episodes,
        "train_seconds": round(elapsed, 3),
        "estimated_demand": round(float(demand), 2),
        "estimated_profit": round(float((price - floor) * demand), 2),
        "cost_floor": round(float(floor), 2),
        "caveat": ("The Q-table is trained here on the fitted demand curve for this "
                   "product; it is a simulation, not a live learning system."),
    }


# --------------------------------------------------------------------------
# negotiation
# --------------------------------------------------------------------------
def negotiate(list_price: float, cost: float, budget: float | None = None,
              min_margin_pct: float = DEFAULT_MIN_MARGIN_PCT,
              max_rounds: int = 5, concession_rate: float = 0.20) -> dict:
    """Multi-round price negotiation simulation.

    Rule: the agent never offers below cost * (1 + min_margin). Each round it
    gives up `concession_rate` of the remaining gap between its current offer
    and that floor. The customer states a budget up front (no synthetic
    personas); the negotiation stops when the offer fits the budget or the
    floor is reached.
    """
    list_price = float(list_price)
    cost = float(cost or 0.0)
    min_margin_pct = float(min_margin_pct if min_margin_pct is not None
                          else DEFAULT_MIN_MARGIN_PCT)
    if list_price <= 0:
        raise PricingError("List price must be greater than zero.")
    if cost < 0:
        raise PricingError("Cost cannot be negative.")
    if min_margin_pct < 0:
        raise PricingError("Minimum margin cannot be negative.")
    if budget is not None and float(budget) <= 0:
        raise PricingError("Budget must be greater than zero.")

    floor = cost * (1 + min_margin_pct / 100.0)
    if floor > list_price:
        floor = list_price

    offer = list_price
    transcript = []
    agreed = False
    note = None
    rounds = 0

    for r in range(1, int(max_rounds) + 1):
        rounds = r
        if budget is not None and float(budget) < floor - 1e-9:
            transcript.append({
                "round": r, "agent_offer": round(offer, 2),
                "customer_budget": round(float(budget), 2),
                "accepted": False,
                "note": "Budget is below the minimum profitable price.",
            })
            note = f"Budget {float(budget):.2f} is below the floor {floor:.2f}."
            break

        if budget is not None and float(budget) >= offer - 1e-9:
            agreed = True
            transcript.append({
                "round": r, "agent_offer": round(offer, 2),
                "customer_budget": round(float(budget), 2),
                "accepted": True, "note": "Budget covers the current offer.",
            })
            break

        new_offer = max(floor, offer - (offer - floor) * concession_rate)
        transcript.append({
            "round": r,
            "agent_offer": round(new_offer, 2),
            "agent_previous_offer": round(offer, 2),
            "customer_budget": round(float(budget), 2) if budget is not None else None,
            "accepted": False,
            "note": f"Conceded {concession_rate * 100:.0f}% of the remaining gap to the floor.",
        })
        offer = new_offer

        if budget is not None and float(budget) >= offer - 1e-9:
            agreed = True
            transcript[-1]["accepted"] = True
            transcript[-1]["note"] = "Counter-offer fits the budget."
            break
        if abs(offer - floor) < 1e-9:
            if budget is None:
                agreed = True
                transcript[-1]["accepted"] = True
                transcript[-1]["note"] = "Reached the minimum profitable price."
            else:
                note = f"Reached the floor {floor:.2f} above the budget {float(budget):.2f}."
            break

    final_price = offer if agreed else None
    discount_pct = (
        round((list_price - final_price) / list_price * 100, 1)
        if final_price is not None else None
    )
    return {
        "mode": "simulation",
        "agreed": agreed,
        "rounds": rounds,
        "list_price": round(list_price, 2),
        "final_price": round(final_price, 2) if final_price is not None else None,
        "discount_pct": discount_pct,
        "savings": round(list_price - final_price, 2) if final_price is not None else None,
        "budget": round(float(budget), 2) if budget is not None else None,
        "floor_price": round(floor, 2),
        "min_margin_pct": min_margin_pct,
        "concession_rule": (f"Each round concedes {concession_rate * 100:.0f}% of the "
                            "remaining gap to the floor price."),
        "transcript": transcript,
        "note": note,
    }
