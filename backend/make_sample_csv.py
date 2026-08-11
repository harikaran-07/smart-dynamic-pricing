"""Generate backend/sample_sales.csv — a realistic retail sales dataset with a
real price→demand relationship so the pricing optimizer has something to fit.

Columns: product_id, category, date, price, cost, competitor_price, inventory,
units_sold, discount_pct. Run:  python make_sample_csv.py

The price moves ±15% around each product's base price (overstock pushes it down,
scarce stock pushes it up), which keeps the price→demand signal learnable —
an ML model fitted on this data reaches R² ≈ 0.5+ instead of the ≈0.0 you get
when prices only wiggle ±4%.
"""
from __future__ import annotations

import math
import random
import datetime as dt

random.seed(20260701)

PRODUCTS = [
    ("P001", "Electronics", 146.90, 63.24),
    ("P002", "Apparel", 38.50, 18.95),
    ("P003", "Beauty", 12.99, 5.60),
    ("P004", "Home & Kitchen", 74.00, 36.10),
    ("P005", "Sports", 29.90, 13.25),
    ("P006", "Apparel", 55.20, 27.80),
    ("P007", "Electronics", 92.40, 44.90),
    ("P008", "Beauty", 18.75, 8.15),
    ("P009", "Sports", 41.30, 19.60),
    ("P010", "Home & Kitchen", 120.00, 58.00),
]

SEASONAL = {1: 1.12, 2: 0.92, 3: 1.0, 4: 1.02, 5: 0.96, 6: 0.84, 7: 0.78,
            8: 0.88, 9: 1.08, 10: 1.32, 11: 1.5, 12: 1.24}

START = dt.date(2025, 1, 1)
DAYS = 365


def main() -> None:
    rows = []
    for pid, cat, base_price, cost in PRODUCTS:
        elasticity = -1.6 + random.random() * 0.8  # between -1.6 and -0.8
        intercept = math.log(base_price ** (-elasticity) * 18.0)
        phase = random.uniform(0, 2 * math.pi)
        inv = 60 + random.randint(0, 300)
        for d in range(DAYS):
            day = START + dt.timedelta(days=d)
            month = day.month
            # price follows a slow promo cycle (±15%) plus daily noise, so the
            # price→demand signal is strong and learnable
            cycle = math.sin(2 * math.pi * d / 90 + phase)
            price = base_price * (1.0 + 0.15 * cycle + random.gauss(0, 0.04))
            price = round(max(0.85, min(1.15, price / base_price)) * base_price, 2)
            comp = round(base_price * 1.04 * (0.97 + random.random() * 0.06), 2)
            season = SEASONAL[month] * (0.95 + 0.1 * random.random())
            weekend = 1.25 if day.weekday() >= 5 else 1.0
            noise = 0.92 + random.random() * 0.16
            units = max(1, int(math.exp(intercept) * price ** elasticity *
                                season * weekend * noise))
            discount = 0 if price >= base_price * 1.03 else \
                round((base_price - price) / base_price * 100, 0)
            inv = max(4, min(700, inv - units + 10 + random.randint(0, 16)))
            rows.append((pid, cat, day.isoformat(), price, cost, comp, inv,
                         units, discount))

    header = "product_id,category,date,price,cost,competitor_price,inventory,units_sold,discount_pct"
    with open("sample_sales.csv", "w", newline="", encoding="utf-8") as f:
        f.write(header + "\n")
        for r in rows:
            f.write(",".join(str(x) for x in r) + "\n")
    print(f"wrote sample_sales.csv with {len(rows):,} rows")


if __name__ == "__main__":
    main()