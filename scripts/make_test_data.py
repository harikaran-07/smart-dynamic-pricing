"""Generate backend/test_pricing_data.csv — the ground-truth pricing fixture.

5 products, 365 daily rows each, plus 10 exact duplicates (1,835 rows).

    product  elasticity  cost  base price  R² target
    P001       -0.80       9        20       0.09   (deliberately noisy)
    P002       -1.50      15        35       0.45
    P003       -2.20      22        50       0.55
    P004       -3.00       5        12       0.50
    P005       -1.20      40        80       0.40

Demand is generated from

    ln(units) = a + e·ln(price) + 0.4·ln(competitor) + 0.8·discount
                + day-of-week dummies + month dummies + residual

The residual is made orthogonal to the regressors, so ordinary least squares
recovers the true coefficients exactly while R² still equals the target. That
keeps "is the estimator accurate?" (elasticity) separate from "is the fit
strong?" (R² / reliability), which is what the acceptance tests check.

Run from the repo root:  python scripts/make_test_data.py
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

PRODUCTS = [
    # id, elasticity, cost, base_price, base_units, target_r2
    ("P001", -0.80, 9.0, 20.0, 40.0, 0.09),
    ("P002", -1.50, 15.0, 35.0, 35.0, 0.45),
    ("P003", -2.20, 22.0, 50.0, 30.0, 0.55),
    ("P004", -3.00, 5.0, 12.0, 45.0, 0.50),
    ("P005", -1.20, 40.0, 80.0, 25.0, 0.40),
]
DAYS = 365
COMPETITOR_COEF = 0.4
DISCOUNT_COEF = 0.8
SEED = 20260301


def _design(price, competitor, discount, dow, month):
    parts = [np.ones(len(price)), np.log(price), np.log(competitor), discount / 100.0]
    names = ["intercept", "log_price", "log_competitor", "discount"]
    for d in range(1, 7):                      # dow_0 is the baseline
        parts.append((dow == d).astype(float))
        names.append(f"dow_{d}")
    for m in range(2, 13):                     # month_1 is the baseline
        parts.append((month == m).astype(float))
        names.append(f"month_{m}")
    return np.column_stack(parts), names


def _orthogonal_residual(rng, X, n):
    r0 = rng.normal(size=n)
    beta, *_ = np.linalg.lstsq(X, r0, rcond=None)
    r = r0 - X @ beta
    return r / np.linalg.norm(r)


def generate() -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    frames = []
    start = pd.Timestamp("2025-01-01")

    for pid, elasticity, cost, base_price, base_units, target_r2 in PRODUCTS:
        dates = pd.date_range(start, periods=DAYS, freq="D")
        price = base_price * np.exp(rng.normal(0, 0.15, DAYS))
        price = np.clip(price, base_price * 0.75, base_price * 1.30)
        price = np.round(price, 2)
        competitor = np.round(base_price * np.exp(rng.normal(0.03, 0.10, DAYS)), 2)
        discount = rng.choice([0, 5, 10, 15], size=DAYS)
        dow = dates.dayofweek.to_numpy()
        month = dates.month.to_numpy()

        X, _ = _design(price, competitor, discount, dow, month)
        beta_true = np.zeros(X.shape[1])
        beta_true[0] = (np.log(base_units)
                        - elasticity * np.log(base_price)
                        - COMPETITOR_COEF * np.log(base_price))
        beta_true[1] = elasticity
        beta_true[2] = COMPETITOR_COEF
        beta_true[3] = DISCOUNT_COEF
        base = X @ beta_true

        r = _orthogonal_residual(rng, X, DAYS)
        # R² of the *fitted* model equals target_r2. Because the residual is
        # orthogonal to the regressors: ss_res = s²|r|², ss_tot = ss_base + ss_res,
        # so R² = s²|r|² / (ss_base + s²|r|²)  =>  s²|r|² = (1-t)/t · ss_base.
        ss_base = float(((base - base.mean()) ** 2).sum())
        s = np.sqrt((1 - target_r2) / target_r2 * ss_base
                    / float((r ** 2).sum()))
        log_units = base + s * r

        units = np.round(np.exp(log_units), 1)
        units = np.maximum(units, 0.5)

        frames.append(pd.DataFrame({
            "product_id": pid,
            "date": dates.strftime("%Y-%m-%d"),
            "price": price,
            "cost": cost,
            "competitor_price": competitor,
            "discount_pct": discount,
            "inventory": rng.integers(400, 1200, DAYS),
            "units_sold": units,
        }))

    df = pd.concat(frames, ignore_index=True)

    # 10 exact duplicates (2 per product), appended at the end
    dup_idx = rng.choice(len(df), size=10, replace=False)
    df = pd.concat([df, df.iloc[dup_idx]], ignore_index=True)
    return df


def main() -> None:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    df = generate()
    out = os.path.join(root, "test_pricing_data.csv")
    df.to_csv(out, index=False)
    print(f"wrote {out}: {len(df)} rows, {df['product_id'].nunique()} products, "
          f"{int(df.duplicated().sum())} duplicates")


if __name__ == "__main__":
    main()
