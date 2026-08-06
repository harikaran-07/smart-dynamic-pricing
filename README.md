# Smart Dynamic Pricing System (ML)

Machine-learning based dynamic pricing system that recommends optimal product prices in
real time using demand forecasting, inventory, competitor monitoring, seasonality,
customer segmentation and an AI negotiation agent.

## Features

- **Demand forecasting** — XGBoost / Random Forest / Linear regression + ARIMA time-series baseline.
- **Competitor-aware pricing** — prices react to competitor movements & price elasticity.
- **Inventory-aware price adjustments** — markdowns when stock is high / scarce; uplift when supply is tight.
- **Seasonal & festival optimization** — one-hot season features and event uplift multipliers.
- **Customer segmentation & loyalty scoring** — K-Means clusters + loyalty score.
- **AI Negotiation Agent** — simulates a customer-agent bargain and returns a personalized discount
  based on loyalty, purchase history, demand pressure and a "churn risk" willingness-to-buy.
- **REST API (FastAPI)** with live price recommendation and negotiation endpoints.
- **Dashboard** — a lightweight HTML/JS monitor (served by the API) for price changes vs sales.

## Tech stack

Python 3.12 · pandas · NumPy · scikit-learn · XGBoost · statsmodels · FastAPI · uvicorn · React-like plain JS dashboard.

## Getting started

```bash
# 1) create venv and install
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt

# 2) generate synthetic data (creates data/raw/*.csv via src/data/generate.py)
python -m src.data.generate_data

# 3) train models (creates models/*.joblib)
python -m src.training.train

# 4) launch the API
python -m src.api.app
# open http://127.0.0.1:8000  (Swagger: /docs, dashboard: /)
```

## Project layout

```
src/
  config.py            # paths + hyperparams
  data/
    generate_data.py   # synthetic sales/weather/competitor generator
    preprocess.py      # feature engineering
  models/
    demand.py          # forecasting regressors
    time_series.py     # ARIMA baseline
segmentation.py    # K-Means + loyalty scoring
  negotiation.py     # AI negotiation agent
  rl_agent.py        # reinforcement-learning price agent (Q-learning)
    pricing.py         # price optimizer
  pipeline.py          # end-to-end orchestration
  api/
    app.py             # FastAPI app + dashboard
  training/
    train.py           # train/eval + save artifacts
scripts/
  run.ps1              # start the API on Windows
  smoke_test.py        # quick API verification
dashboard/
  index.html           # monitor dashboard (served by the API)
```

## API examples

```bash
# monitoring / overview metrics + model performance
curl http://127.0.0.1:8000/api/overview

# sales history for a product (30 days by default)
curl "http://127.0.0.1:8000/api/sales/P001?days=30"

# get a recommended price for a product
curl -X POST http://127.0.0.1:8000/api/price \
  -H "Content-Type: application/json" \
  -d '{"product_id":"P001","inventory":43,"competitor_price":29.9,"demand_pressure":0.6}'

# negotiate a deal as a customer
curl -X POST http://127.0.0.1:8000/api/negotiate \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"c-102","product_id":"P001","demand_pressure":0.7}'

# price recommendation from the reinforcement-learning agent
curl -X POST http://127.0.0.1:8000/api/rl-price \
  -H "Content-Type: application/json" \
  -d '{"product_id":"P001","inventory":43,"demand_pressure":0.6}'
```

Dashboard: open `http://127.0.0.1:8000/` for live price recommendations, AI negotiation,
model performance and a sales-history chart. Interactives: Swagger at `/docs`.

## Tests

```bash
.venv\\Scripts\\python.exe -m pytest -q
```

Covers data generation, feature engineering, demand models, price optimizer,
segmentation, budget-aware negotiation, the RL agent and the API surface.

## Explainability

Generate feature-importance charts, predicted-vs-actual and model-comparison
figures plus a `reports/report.json` summary:

```bash
.venv\\Scripts\\python.exe scripts\\generate_report.py
```

Serve them over the API (read by the dashboard):

```bash
curl http://127.0.0.1:8000/api/explain
```

Works on the current synthetic run: **XGBoost** is the best demand model
(R² ≈ 0.79); top drivers are `is_weekend`, `units_roll7` (recent demand),
`seasonal_factor`, `inventory` and `weather_factor`.

## Verification

Trains end-to-end (`python -m src.training.train`) producing demand models
(Linear / Random Forest / XGBoost — XGBoost best, R² ≈ 0.67), ARIMA baselines,
customer segments and the negotiation agent. A smoke test is available at
`scripts/smoke_test.py`; the API boots and serves the dashboard + all endpoints.