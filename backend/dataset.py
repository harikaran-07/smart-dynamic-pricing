"""dataset.py — upload validation, secure parsing and dataset profiling.

Security rules enforced:
  - only .csv files (never executable content is parsed)
  - 10 MB size limit
  - filename sanitization (basename only, control chars stripped)
  - malformed CSV rows are skipped, never crash the server
"""
from __future__ import annotations

import re
import io
import math

import pandas as pd

MAX_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_ROWS = 300_000
PREVIEW_ROWS = 10
LOW_CARDINALITY_CAP = 30          # categoricals above this are dropped in training
TARGET_CANDIDATE_MIN_UNIQUE = 5   # a target column needs variance to be useful


def sanitize_filename(name: str) -> str:
    """Return a safe display name: path stripped, weird characters removed."""
    base = str(name or "upload.csv").replace("\\", "/").split("/")[-1]
    base = re.sub(r"[^A-Za-z0-9._ -]", "_", base)
    return base[:80] or "upload.csv"


def read_bytes_limit(data: bytes) -> int:
    return len(data)


class DatasetError(ValueError):
    """Raised for user-facing dataset problems (400 responses)."""


def parse_csv(data: bytes) -> pd.DataFrame:
    """Parse uploaded CSV bytes into a DataFrame. Raises DatasetError."""
    if read_bytes_limit(data) > MAX_BYTES:
        raise DatasetError(
            "File is larger than the 10 MB limit. Please upload a smaller CSV."
        )
    text = None
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise DatasetError("Could not decode the file. Please upload a UTF-8 CSV.")

    try:
        df = pd.read_csv(
            io.StringIO(text),
            engine="python",
            on_bad_lines="skip",
            skip_blank_lines=True,
        )
    except Exception as exc:  # pandas raises various parse errors
        raise DatasetError(
            "The file could not be parsed as CSV: " + str(exc)[:150]
        ) from exc

    if df is None or df.empty or len(df.columns) == 0:
        raise DatasetError("The CSV has no columns. Add a header row and try again.")
    if len(df) == 0:
        raise DatasetError("The CSV has no data rows — only a header was found.")
    if len(df) > MAX_ROWS:
        raise DatasetError(
            f"The CSV has {len(df):,} rows, above the {MAX_ROWS:,} row limit."
        )

    df.columns = [str(c).strip() or f"col_{i}" for i, c in enumerate(df.columns)]
    df.columns = [re.sub(r"\s+", "_", c) for c in df.columns]
    df.columns = [c if c else f"col_{i}" for i, c in enumerate(df.columns)]
    return df


def _col_kind(col: pd.Series) -> str:
    if pd.api.types.is_numeric_dtype(col):
        return "numeric"
    if pd.api.types.is_datetime64_any_dtype(col):
        return "datetime"
    return "categorical"


def profile(df: pd.DataFrame, preferred_target: str | None = None) -> dict:
    """Build the dataset profile returned to the frontend. When a demand /
    units column is detected it is boosted to become the suggested target."""
    rows, cols = len(df), len(df.columns)

    data_types = {}
    for c in df.columns:
        try:
            data_types[c] = _col_kind(df[c])
        except Exception:
            data_types[c] = "categorical"

    missing = {c: int(df[c].isna().sum()) for c in df.columns}
    total_missing = sum(missing.values())
    duplicates = int(df.duplicated().sum())

    numeric_cols = [c for c, t in data_types.items() if t == "numeric"]
    categorical_cols = [c for c, t in data_types.items() if t == "categorical"]
    datetime_cols = [c for c, t in data_types.items() if t == "datetime"]

    preview = df.head(PREVIEW_ROWS).replace({float("nan"): None}).to_dict(orient="records")
    # JSON-safe conversion of any remaining exotic types
    preview = [_json_safe(r) for r in preview]

    # target candidates: numeric non-id columns with variance
    target_candidates = []
    for c in numeric_cols:
        try:
            s = df[c].dropna()
            if len(s) < TARGET_CANDIDATE_MIN_UNIQUE:
                continue
            if s.nunique() < TARGET_CANDIDATE_MIN_UNIQUE:
                continue
            if len(df) and s.nunique() <= 1:
                continue
        except Exception:
            continue
        score, note = _score_target(df, c)
        target_candidates.append(
            {"column": c, "type": "numeric", "cardinality": int(s.nunique()),
             "suitability": score, "note": note}
        )
    target_candidates.sort(key=lambda t: -t["suitability"])

    # boost the detected demand column so it becomes the suggested target
    if preferred_target is None:
        try:
            import pricing as _pricing
        except ImportError:
            try:
                from . import pricing as _pricing
            except Exception:
                _pricing = None
        if _pricing is not None:
            preferred_target = _pricing.detect_columns(df).get("units")
    if preferred_target:
        for t in target_candidates:
            if t["column"] == preferred_target:
                t["suitability"] = min(1.0, round(t["suitability"] + 0.3, 2))
        target_candidates.sort(key=lambda t: -t["suitability"])
    suggested_target = target_candidates[0]["column"] if target_candidates else None

    messages = []
    if total_missing:
        messages.append(f"{total_missing:,} missing value(s) will be filled automatically.")
    if duplicates:
        messages.append(f"{duplicates:,} duplicate row(s) will be removed before training.")
    if not target_candidates:
        messages.append(
            "No suitable numeric target column found — training is not possible "
            "until the CSV includes a numeric column (e.g. units_sold)."
        )
    if rows < 50:
        messages.append(
            f"Only {rows:,} rows — results will be noisy. More data improves reliability."
        )

    return {
        "filename": None,  # filled by caller
        "rows": rows,
        "columns": cols,
        "data_types": data_types,
        "missing": missing,
        "total_missing": total_missing,
        "duplicates": duplicates,
        "preview": preview,
        "numeric_columns": numeric_cols,
        "categorical_columns": categorical_cols,
        "datetime_columns": datetime_cols,
        "target_candidates": target_candidates,
        "suggested_target": suggested_target,
        "messages": messages,
    }


def _score_target(df: pd.DataFrame, col: str) -> tuple[float, str]:
    """0..1 suitability score for using `col` as the prediction target."""
    s = df[col].dropna()
    nunique = s.nunique()
    std = float(s.std()) if len(s) > 1 else 0.0
    mean = float(s.mean()) if len(s) else 0.0
    cv = std / mean if mean else 0.0  # coefficient of variation
    score = 0.0
    if cv < 1e-4:
        return 0.0, "constant or near-constant column — not useful as a target"
    if cv < 0.05:
        score += 0.15
    elif cv < 0.5:
        score += 0.4
    else:
        score += 0.55
    if nunique >= 100:
        score += 0.3
    elif nunique >= 20:
        score += 0.2
    else:
        score += 0.05
    if df[col].isna().mean() < 0.1:
        score += 0.15

    low = col.lower().replace("_", " ")
    # price-like columns are features, not training targets
    for token in ("price", "cost", "competitor", "inventory"):
        if token in low:
            score -= 0.25
            break
    return round(max(score, 0.0), 2), "numeric column with useful variance"


def price_relevant_columns(df: pd.DataFrame) -> dict:
    """Best-effort column detection for dynamic pricing (never invented)."""
    def _match(c, keys):
        c = str(c).lower().replace("_", " ")
        return any(k in c for k in keys)

    def _pick(keys):
        scored = []
        for c in df.columns:
            hits = sum(1 for k in keys if k in str(c).lower().replace("_", " "))
            if hits:
                scored.append((hits, c))
        return max(scored, default=(0, None))[1]

    price = _pick(["price", "selling price", "prc", "selling_price"])
    cost = _pick(["cost", "cogs", "unit cost", "product cost"])
    units = _pick(["qty", "quantity", "units", "sold", "demand", "units_sold"])
    competitor = _pick(["competitor", "comp price", "competitor_price"])
    inventory = _pick(["inventory", "stock", "inv"])
    discount = _pick(["discount", "disc"])
    group = _pick(["product id", "product_id", "sku", "product", "category"])
    return {
        "price": price, "cost": cost, "units": units, "competitor": competitor,
        "inventory": inventory, "discount": discount, "group": group,
    }


def _json_safe(row: dict) -> dict:
    out = {}
    for k, v in row.items():
        if isinstance(v, (pd.Timestamp,)):
            v = v.isoformat()
        elif isinstance(v, (pd.Int64Dtype, type(None))):
            pass
        elif isinstance(v, (float, int, str, bool)) or v is None:
            pass
        else:
            try:
                if isinstance(v, float) and math.isnan(v):
                    v = None
            except Exception:
                pass
            if not isinstance(v, (float, int, str, bool, type(None))):
                try:
                    v = str(v)
                except Exception:
                    v = None
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            v = None
        out[k] = v
    return out