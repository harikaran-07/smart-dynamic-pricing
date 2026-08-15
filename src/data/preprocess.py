"""Feature engineering for the sales history and customer data.

Data leakage prevention:
  - When the target is 'sales', columns that directly calculate sales
    (tax, cogs, gross_income) are flagged and excluded from features.
  - The original columns are preserved; only their use as ML features is controlled."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..config import (
    CUSTOMERS_CSV,
    CUSTOMERS_PROCESSED,
    SALES_CSV,
    SALES_PROCESSED,
)


# Column name normalization: map variants to canonical names
_COLUMN_ALIASES = {
    # Price column variants
    "unit price": "price",
    "unit_price": "price",
    "unit price ": "price",
    "unit price\t": "price",
    # Quantity/demand column variants
    "quantity": "units",
    "units sold": "units",
    "units": "units",
    "qty": "units",
    "demand": "units",
    # Tax column variants (marked for leakage exclusion)
    "tax 5%": "tax_5pct",
    "tax 5 pct": "tax_5pct",
    "tax": "tax_5pct",
    # COGS column variants (marked for leakage exclusion)
    "cogs": "cogs",
    "cost": "cogs",
    "cost of goods sold": "cogs",
    # Gross income column variants (marked for leakage exclusion)
    "gross income": "gross_income",
    "gross_profit": "gross_income",
    # Branch/city/customer variants
    "branch": "branch",
    "city": "city",
    "customer type": "customer_type",
    "customer_type": "customer_type",
    "gender": "gender",
    # Product line variants
    "product line": "product_line",
    "product_line": "product_line",
    "product": "product_line",
}


def _normalize_column_name(col_name: str) -> str:
    """Normalize a column name to its canonical form."""
    low = str(col_name).lower().strip()
    return _COLUMN_ALIASES.get(low, low)


def _detect_leakage_columns(df: pd.DataFrame, target: str = "sales") -> dict:
    """Detect columns that directly calculate the target, which would cause data leakage.

    For supermarket data, Sales ≈ Unit price × Quantity × 1.05 (with 5% tax).
    Therefore: tax_5pct, cogs, gross_income should NOT be used as features
    when predicting sales.

    Returns:
        - 'leaked': columns that were directly calculating the target
        - 'safe': columns safe to use as features
        - 'warning': message describing the leakage
    """
    leaked = []
    safe = []

    # The relationship: Sales = Unit price × Quantity × (1 + tax_rate)
    # Common column name patterns:
    tax_variants = ["tax 5%", "tax 5 pct", "tax", "tax_pct", "tax5"]
    cogs_variants = ["cogs", "cost of goods sold", "cost", "cogs"]
    gross_income_variants = ["gross income", "gross_profit", "profit"]

    # Check if target column exists
    if target not in df.columns and target.capitalize() not in df.columns:
        return {"leaked": [], "safe": [], "warning": f"Target column '{target}' not found"}

    # Normalize column names for checking
    cols_lower = {str(c).lower().strip(): c for c in df.columns}

    # Detect tax column
    tax_col = None
    for variant in tax_variants:
        if variant in cols_lower:
            tax_col = cols_lower[variant]
            break

    # Detect cogs column
    cogs_col = None
    for variant in cogs_variants:
        if variant in cols_lower:
            cogs_col = cols_lower[variant]
            break

    # Detect gross income column
    gross_col = None
    for variant in gross_income_variants:
        if variant in cols_lower:
            gross_col = cols_lower[variant]
            break

    # Leakage detection logic
    # If we have tax, cogs, or gross_income AND sales, there's leakage risk
    has_target = target in df.columns or target.capitalize() in df.columns

    if has_target and tax_col is not None and tax_col in df.columns:
        # tax_5pct is derived from sales, so using it as a feature is leakage
        leaked.append({"column": tax_col, "reason": "tax_5pct is directly calculated from sales"})
        safe.append({"column": tax_col, "reason": "Excluded to prevent data leakage"})

    if has_target and cogs_col is not None and cogs_col in df.columns:
        # cogs is derived from sales/cost structure, using it as feature is leakage
        leaked.append({"column": cogs_col, "reason": "cogs is directly related to sales structure"})
        safe.append({"column": cogs_col, "reason": "Excluded to prevent data leakage"})

    if has_target and gross_col is not None and gross_col in df.columns:
        # gross_income = sales - costs, directly tied to sales
        leaked.append({"column": gross_col, "reason": "gross_income is directly calculated from sales"})
        safe.append({"column": gross_col, "reason": "Excluded to prevent data leakage"})

    warning_msg = ""
    if leaked:
        warning_parts = []
        for item in leaked:
            warning_parts.append(f"[LEAK] {item['column']}: {item['reason']}")
        warning_msg = "Potential data leakage detected:\n" + "\n".join(warning_parts)

    return {
        "leaked": leaked,
        "safe": safe,
        "warning": warning_msg if warning_msg else "No data leakage detected - all columns are safe to use as features",
    }


def _standardize_columns(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Standardize column names using the alias mapping.

    This helps the pipeline recognize columns even if capitalization or
    spacing differs (e.g., 'Unit price', 'unit_price', 'Unit Price').

    Returns a DataFrame with renamed columns and an alias mapping dict.
    """
    new_cols = []
    alias_map = {}
    for col in df.columns:
        normalized = _normalize_column_name(col)
        alias_map[col] = normalized
        # Only rename if the normalized name differs from original
        if normalized != col:
            new_cols.append(normalized)
        else:
            new_cols.append(col)
    df_std = df.copy()
    df_std.columns = new_cols
    return df_std, alias_map


def load_sales(csv: str = SALES_CSV) -> pd.DataFrame:
    df = pd.read_csv(csv, parse_dates=["date"])
    return df


def engineer_sales_features(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    d["dow"] = d["date"].dt.dayofweek
    d["is_weekend"] = (d["dow"] >= 5).astype(int)
    d["doy"] = d["date"].dt.dayofyear
    d["month"] = d["date"].dt.month
    # continuous sinusoidal year-cycle feature (0..2pi)
    d["year_sin"] = np.sin(2 * np.pi * d.loc[:, "doy"] / 365.25)
    d["year_cos"] = np.cos(2 * np.pi * d.loc[:, "doy"] / 365.25)

    # price position vs competitor
    d["price_vs_competitor"] = d["price"] - d["competitor_price"]
    d["price_ratio_to_base"] = d["price"] / d.groupby("product_id")["price"].transform("mean")

    # category mean price as gap feature
    d["cat_mean_price"] = d.groupby("category")["price"].transform("mean")
    d["price_over_cat"] = d["price"] - d["cat_mean_price"]

    # lagged demand features per product
    d = d.sort_values(["product_id", "date"])
    g = d.groupby("product_id")["units_sold"]
    d["units_lag1"] = g.shift(1)
    d["units_lag7"] = g.shift(7)
    d["units_roll7"] = g.shift(1).transform(lambda s: s.rolling(7, min_periods=1).mean())

    # drop first rows with NaN lags
    d = d.dropna(subset=["units_lag1", "units_lag7"])

    # --- Data leakage prevention: flag columns that calculate the target ---
    leakage = _detect_leakage_columns(d, target="sales")
    # Store leakage info for the API/dashboard
    d["_leakage_warning"] = leakage["warning"]
    leaked_cols = [item["column"] for item in leakage["leaked"]]
    d["_leakage_columns"] = (",".join(leaked_cols) if leaked_cols else "none")
    # Do NOT remove the columns from the dataframe; just mark them
    # The API will decide whether to use them as features

    return d


def supermarket_analytics(df: pd.DataFrame) -> dict:
    """Generate supermarket-specific analytics from the processed sales data.

    Returns dictionaries with product, branch, time, and customer insights.
    """
    if df.empty:
        return {
            "product": {"best_selling": [], "worst_selling": [], "revenue_by_line": {}},
            "branch": {"best_performing": [], "worst_performing": [], "sales_by_branch": {}, "avg_revenue_by_branch": {}},
            "time": {"sales_by_date": [], "sales_by_hour": [], "peak_time": [], "low_demand_periods": []},
            "customer": {"member_vs_normal": [], "gender_based_sales": {}, "payment_distribution": []},
        }

    # Ensure required columns exist after normalization
    # Map common names
    col_map = {}
    for col in df.columns:
        low = str(col).lower().strip()
        if low in ("unit price", "unit_price", "price"):
            col_map[col] = "price"
        elif low in ("quantity", "units sold", "units", "qty", "demand"):
            col_map[col] = "quantity"
        elif low in ("sales",):
            col_map[col] = "sales"
        elif low in ("tax 5%", "tax 5 pct", "tax", "tax_pct"):
            col_map[col] = "tax_5pct"
        elif low in ("cogs", "cost", "cost of goods sold"):
            col_map[col] = "cogs"
        elif low in ("gross income", "gross_profit", "profit"):
            col_map[col] = "gross_income"
        elif low in ("branch", "city"):
            col_map[col] = "branch"
        elif low in ("customer type", "customer_type"):
            col_map[col] = "customer_type"
        elif low in ("gender",):
            col_map[col] = "gender"
        elif low in ("product line", "product_line", "product"):
            col_map[col] = "product_line"
        else:
            col_map[col] = col

    # Apply normalized names
    df = df.rename(columns=col_map)

    # Make sure we have essential columns
    essential = ["price", "quantity", "sales", "product_line", "branch"]
    missing = [c for c in essential if c not in df.columns]
    if missing:
        return {
            "product": {"best_selling": [], "worst_selling": [], "revenue_by_line": {}},
            "branch": {"best_performing": [], "worst_performing": [], "sales_by_branch": {}, "avg_revenue_by_branch": {}},
            "time": {"sales_by_date": [], "sales_by_hour": [], "peak_time": [], "low_demand_periods": []},
            "customer": {"member_vs_normal": [], "gender_based_sales": {}, "payment_distribution": []},
            "error": f"Missing essential columns: {missing}",
        }

    # Product Analysis
    product_revenue = df.groupby("product_line").agg(
        total_sales=("sales", "sum"),
        avg_price=("price", "mean"),
        avg_quantity=("quantity", "mean"),
        total_quantity=("quantity", "sum"),
    ).round(2)

    product_revenue["revenue"] = product_revenue["total_sales"]
    pr = product_revenue.reset_index()
    best_selling = pr.nlargest(3, "total_sales")[["product_line", "total_sales", "revenue"]].to_dict("records")
    worst_selling = pr.nsmallest(3, "total_sales")[["product_line", "total_sales", "revenue"]].to_dict("records")
    revenue_by_line = product_revenue["revenue"].to_dict()

    # Branch Analysis
    branch_sales = df.groupby("branch").agg(
        total_sales=("sales", "sum"),
        avg_revenue=("price", "mean"),
    ).round(2)

    best_performing = branch_sales.reset_index().nlargest(3, "total_sales")[["branch", "total_sales", "avg_revenue"]].to_dict("records")
    worst_performing = branch_sales.reset_index().nsmallest(3, "total_sales")[["branch", "total_sales", "avg_revenue"]].to_dict("records")
    sales_by_branch = branch_sales["total_sales"].to_dict()
    avg_revenue_by_branch = branch_sales["avg_revenue"].to_dict()

    # Time Analysis
    df_copy = df.copy()
    df_copy["date"] = pd.to_datetime(df_copy["date"])
    df_copy["hour"] = df_copy["time"].astype(int) if "time" in df.columns else 12

    sales_by_date = df_copy.groupby(df_copy["date"].dt.date)["sales"].sum().sort_index().tolist()
    sales_by_hour = df_copy.groupby("hour")["sales"].mean().round(2).to_dict()
    peak_hour = df_copy.groupby("hour")["sales"].mean().idxmax()
    low_demand_hour = df_copy.groupby("hour")["sales"].mean().idxmin()

    # Customer Analysis
    if "customer_type" in df.columns:
        member_sales = df.groupby("customer_type")["sales"].mean()
        member_vs_normal = member_sales.to_dict()
    else:
        member_vs_normal = {}

    gender_sales = {}
    if "gender" in df.columns:
        gender_sales = df.groupby("gender")["sales"].mean().round(2).to_dict()

    payment_col = None
    for c in df.columns:
        low = str(c).lower()
        if "payment" in low:
            payment_col = c
            break
    payment_distribution = {}
    if payment_col:
        payment_distribution = df.groupby(payment_col).size().to_dict()

    return {
        "product": {
            "best_selling": best_selling,
            "worst_selling": worst_selling,
            "revenue_by_line": revenue_by_line,
        },
        "branch": {
            "best_performing": best_performing,
            "worst_performing": worst_performing,
            "sales_by_branch": sales_by_branch,
            "avg_revenue_by_branch": avg_revenue_by_branch,
        },
        "time": {
            "sales_by_date": sales_by_date,
            "sales_by_hour": sales_by_hour,
            "peak_time": peak_hour,
            "low_demand_periods": low_demand_hour,
        },
        "customer": {
            "member_vs_normal": member_vs_normal,
            "gender_based_sales": gender_sales,
            "payment_distribution": payment_distribution,
        },
    }