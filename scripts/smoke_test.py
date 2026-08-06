import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from src.api.app import app

c = TestClient(app)
print("health:", c.get("/api/health").json())
ov = c.get("/api/overview").json()
print("overview keys:", sorted(ov.keys()))
print("overview metrics:", json.dumps(ov.get("model_metrics"), indent=0)[:160])
print("overview segments:", ov.get("segments"))
print("sales P001 last 7d:", c.get("/api/sales/P001", params={"days": 7}).json()["units_sold"][:3], "...")
r = c.post("/api/price", json={"product_id": "P001", "inventory": 43, "competitor_price": 29.9, "demand_pressure": 0.6})
print("price:", json.dumps(r.json()))
r2 = c.post("/api/negotiate", json={"customer_id": "c-102", "product_id": "P001", "demand_pressure": 0.7, "inventory": 20})
print("negotiate:", r2.status_code, json.dumps(r2.json()))
print("404 check:", c.post("/api/price", json={"product_id": "ZZZ", "inventory": 5}).status_code)