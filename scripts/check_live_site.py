"""Live acceptance check against the deployed Render service.

Tolerance-based: it re-derives the expected values from the local fixture and
compares them with what the deployed API returns, instead of pinning exact
numbers that drift with retraining.

    python scripts/check_live_site.py
    python scripts/check_live_site.py --base http://127.0.0.1:8000

Checks
  * /api/health answers
  * the dashboard HTML carries the Warm Sand tokens and the Google Fonts link
  * uploading test_pricing_data.csv trains models and reports a time-split R2
  * per product through /api/pricing/recommend: elasticity within +/-0.3 of the
    true value, profit price within +/-5% of the theoretical optimum, +20% cap
    and cost floor respected, P001 not rated High
  * competitor / discount changes move the model output
  * portfolio current price equals the 14-day median, negotiation + RL answer
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "test_pricing_data.csv"

TRUTH = {
    "P001": {"elasticity": -0.80, "cost": 9.0},
    "P002": {"elasticity": -1.50, "cost": 15.0},
    "P003": {"elasticity": -2.20, "cost": 22.0},
    "P004": {"elasticity": -3.00, "cost": 5.0},
    "P005": {"elasticity": -1.20, "cost": 40.0},
}

fails = 0

try:                      # Windows consoles default to cp1252
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:         # pragma: no cover
    pass


def ok(cond: bool, msg: str) -> None:
    global fails
    if cond:
        print("  [OK]   " + msg)
    else:
        print("  [FAIL] " + msg)
        fails += 1


def request(base: str, path: str, body=None, timeout: int = 120, raw=False):
    url = base.rstrip("/") + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        payload = res.read()
        if raw:
            return payload.decode("utf-8", "replace")
        return json.loads(payload.decode())


def upload_csv(base: str) -> dict:
    """POST the fixture as multipart/form-data without extra dependencies."""
    boundary = "----smartpricingboundary"
    head = (
        "--" + boundary + "\r\n"
        'Content-Disposition: form-data; name="file"; filename="test_pricing_data.csv"\r\n'
        "Content-Type: text/csv\r\n\r\n"
    ).encode()
    tail = ("\r\n--" + boundary + "--\r\n").encode()
    body = head + CSV_PATH.read_bytes() + tail
    req = urllib.request.Request(
        base.rstrip("/") + "/api/dataset/upload", data=body,
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
        method="POST")
    with urllib.request.urlopen(req, timeout=180) as res:
        return json.loads(res.read().decode())


def wait_for_health(base: str, attempts: int = 20) -> bool:
    """Render free-plan cold starts take ~35-60 s."""
    for i in range(attempts):
        try:
            h = request(base, "/api/health", timeout=20)
            if h.get("status") == "ok":
                print(f"  health ok after {i * 5}s")
                return True
        except Exception as exc:      # noqa: BLE001 - any transport error means "not ready"
            print(f"  waiting for the server ({i * 5}s): {type(exc).__name__}")
        time.sleep(5)
    return False


def theoretical_optimum(elasticity: float, cost: float, price: float) -> float:
    if elasticity < -1:
        return min(cost * elasticity / (1 + elasticity), 1.2 * price)
    return 1.2 * price


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://smart-dynamic-pricing.onrender.com")
    args = ap.parse_args()
    base = args.base

    print(f"== live check: {base} ==")
    if not CSV_PATH.exists():
        print("missing test_pricing_data.csv - run python scripts/make_test_data.py")
        return 2

    print("== health ==")
    if not wait_for_health(base):
        print("  [FAIL] server did not become healthy")
        return 1

    print("== dashboard page ==")
    try:
        html = request(base, "/", raw=True)
        ok("--bg:#F6EFE6" in html, "warm sand background token present")
        ok("Fraunces" in html and "fonts.googleapis.com" in html, "Fraunces font linked")
        ok("Upload &amp; Analytics" in html and "Portfolio" in html, "nav pages present")
        ok("Manual Mode" not in html, "no Manual Mode switcher in the page")
    except Exception as exc:      # noqa: BLE001
        ok(False, f"dashboard page unreachable: {exc}")

    print("== upload + train ==")
    try:
        profile = upload_csv(base)
        dataset_id = profile["dataset_id"]
        ok(profile["rows"] == 1835, f"uploaded rows = {profile.get('rows')}")
        target = profile.get("suggested_target") or "units_sold"
        train = request(base, "/api/pipeline/train",
                        {"dataset_id": dataset_id, "target": target}, timeout=300)
        ok(train["best"]["r2"] is not None, f"best model {train['best']['name']} R2 {train['best']['r2']}")
        ok(train.get("time_split") is not None, "time-split R2 reported")
        if train.get("time_split"):
            print(f"         random-split R2 {train['random_split']['r2']} | "
                  f"time-split R2 {train['time_split']['r2']}")
        ok(train["dataset"]["duplicates_removed"] == 10,
           f"duplicates removed = {train['dataset']['duplicates_removed']}")
        ok(any(f.startswith("date_") for f in train["dataset"]["feature_names"]),
           "date column turned into features")
    except Exception as exc:      # noqa: BLE001
        ok(False, f"upload/train failed: {exc}")
        print("\nFAILURES:", fails)
        return 1

    print("== recommendations (tolerance-based) ==")
    import csv as _csv

    rows = {}
    with CSV_PATH.open(newline="", encoding="utf-8") as fh:
        for r in _csv.DictReader(fh):
            rows[r["product_id"]] = r          # last row wins

    for pid, truth in TRUTH.items():
        row = {
            "product_id": pid,
            "price": float(rows[pid]["price"]),
            "cost": float(rows[pid]["cost"]),
            "competitor_price": float(rows[pid]["competitor_price"]),
            "discount_pct": float(rows[pid]["discount_pct"]),
            "inventory": float(rows[pid]["inventory"]),
            "units_sold": float(rows[pid]["units_sold"]),
            "date": rows[pid]["date"],
        }
        try:
            body = request(base, "/api/pricing/recommend",
                           {"dataset_id": dataset_id, "objective": "profit", "row": row})
        except Exception as exc:  # noqa: BLE001
            ok(False, f"{pid}: recommend failed: {exc}")
            continue
        dm = body["demand_model"]
        est = dm["elasticity"]
        price = body["optimal"]["price"]
        current = body["current"]["price"]
        target = theoretical_optimum(est, truth["cost"], current)
        ok(abs(est - truth["elasticity"]) <= 0.3,
           f"{pid} elasticity {est} (true {truth['elasticity']})")
        ok(target <= 0 or abs(price - target) / target <= 0.05,
           f"{pid} price {price} vs theory {round(target, 2)}")
        ok(price <= current * 1.2 + 1e-6, f"{pid} price {price} <= +20% of {current}")
        ok(price >= truth["cost"] - 1e-6, f"{pid} price {price} >= cost {truth['cost']}")
        if pid == "P001":
            ok(body["reliability"]["level"] != "High",
               f"P001 reliability {body['reliability']['level']} (R2 {dm['r2']})")
            ok(dm["r2"] < 0.10, f"P001 R2 {dm['r2']} below 0.10")

    print("== competitor / discount sensitivity ==")
    base_row = {
        "product_id": "P003", "price": float(rows["P003"]["price"]),
        "cost": float(rows["P003"]["cost"]),
        "competitor_price": float(rows["P003"]["competitor_price"]),
        "discount_pct": float(rows["P003"]["discount_pct"]),
        "inventory": float(rows["P003"]["inventory"]),
        "units_sold": float(rows["P003"]["units_sold"]),
        "date": rows["P003"]["date"],
    }
    try:
        a = request(base, "/api/pricing/recommend",
                    {"dataset_id": dataset_id, "objective": "profit", "row": base_row})
        b = request(base, "/api/pricing/recommend",
                    {"dataset_id": dataset_id, "objective": "profit",
                     "row": dict(base_row, competitor_price=base_row["competitor_price"] * 1.2)})
        c = request(base, "/api/pricing/recommend",
                    {"dataset_id": dataset_id, "objective": "profit",
                     "row": dict(base_row, discount_pct=15.0)})
        ok(a["optimal"]["estimated_demand"] != b["optimal"]["estimated_demand"],
           "changing the competitor price changes the output")
        ok(a["optimal"]["estimated_demand"] != c["optimal"]["estimated_demand"],
           "changing the discount changes the output")
    except Exception as exc:      # noqa: BLE001
        ok(False, f"sensitivity checks failed: {exc}")

    print("== portfolio / negotiation / RL ==")
    try:
        port = request(base, "/api/pricing/portfolio",
                       {"dataset_id": dataset_id, "objective": "profit", "top": 10})
        ok(bool(port["items"]), f"portfolio returned {len(port['items'])} products")
        p002 = next((i for i in port["items"] if i["product"] == "P002"), None)
        if p002:
            recent = []
            with CSV_PATH.open(newline="", encoding="utf-8") as fh:
                for r in _csv.DictReader(fh):
                    if r["product_id"] == "P002":
                        recent.append(r)
            last_date = max(r["date"] for r in recent)
            cutoff = sorted({r["date"] for r in recent if r["date"] <= last_date})[-14]
            window = [float(r["price"]) for r in recent if r["date"] >= cutoff]
            window.sort()
            med = (window[len(window) // 2] if len(window) % 2
                   else (window[len(window) // 2 - 1] + window[len(window) // 2]) / 2)
            ok(abs(p002["current_price"] - med) <= 0.02,
               f"P002 current price {p002['current_price']} = 14-day median {round(med, 2)}")
        neg = request(base, "/api/negotiate",
                      {"list_price": 35, "cost": 15, "budget": 30, "min_margin_pct": 20})
        ok(neg["mode"] == "simulation" and neg["final_price"] >= neg["floor_price"] - 1e-9,
           f"negotiation floor respected (final {neg.get('final_price')}, floor {neg['floor_price']})")
        rl = request(base, "/api/rl-price", {"dataset_id": dataset_id, "row": base_row})
        ok(rl["learning_steps"] > 0 and any(v != 0 for v in rl["q_values"]),
           f"Q-learning returned a trained table ({rl['learning_steps']} steps)")
    except Exception as exc:      # noqa: BLE001
        ok(False, f"portfolio/negotiation/RL failed: {exc}")

    print()
    print("FAILURES:", fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
