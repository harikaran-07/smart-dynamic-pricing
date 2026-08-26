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
- **Prediction Center** — a dedicated two-mode panel: **Dataset Mode** (upload/analyze a
  dataset, review data quality & model metrics, and browse a per-product prediction table
  with CSV export) and **Manual Mode** (enter price, demand, sales, inventory, competitor,
  quantity and season to get KPI cards, a recommended price and dynamic reasoning).
- **Currency support** — switch between USD ($) and INR (₹) from the header; INR uses
  Indian digit grouping (e.g. ₹1,25,000) and the exchange rate is configurable. Every
  price/revenue/profit value updates across all panels.
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

# 2) download the Kaggle dataset (creates data/raw/kaggle_sales.csv)
python -m scripts.download_kaggle

# 3) train models (creates models/*.joblib)
python -m scripts.train_kaggle

# 4) launch the API
python -m src.api.app
# open http://127.0.0.1:8000  (Swagger: /docs, dashboard: /)
```

## Project layout

```
src/
  config.py            # paths + hyperparams
  data/
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
  test_engine.js          # Node harness for the upload/analytics/model pipeline
  test_dashboard_boot.js  # Node DOM-shim boot test for charts/engine/analytics/upload
dashboard/
  index.html           # monitor dashboard (served by the API)
  charts.js            # professional canvas charting (tooltips, zoom, bands, markers)
  engine.js            # data pipeline: CSV/Excel, mapping, cleaning, client ML, analytics, currency
  analytics.js         # Advanced Analytics (Overview / Dataset / Pricing / Profit / Seasonal / Inventory)
  predict.js           # Prediction Center: Dataset + Manual modes, KPI cards, recommendation panel
  upload.js            # Data Source control + upload workflow + toasts/overlay
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

# manual-mode prediction (no dataset product needed)
curl -X POST http://127.0.0.1:8000/api/manual \
  -H "Content-Type: application/json" \
  -d '{"product_name":"Wireless Headphones","category":"Electronics","price":49.99,"cost":22.0,"inventory":50,"competitor":55.0,"discount_pct":10,"demand_pressure":0.5,"marketing_spend":120,"customer_rating":4.2,"season":"Festival","holiday":true,"weekend":1,"month":10,"dow":5}'
```

Dashboard: open `http://127.0.0.1:8000/` for live price recommendations, AI negotiation,
model performance and a sales-history chart. Interactives: Swagger at `/docs`.

## GitHub Pages

The dashboard starts empty: every panel asks you to **Upload Dataset** until a CSV
is applied. Without the backend, the dataset is mirrored in-browser (analytics,
Prediction Center, Decision Engine use a transparent client-side model of the same
data); the ML Pipeline and price recommendations need the backend, which is detected
via `window.API_BASE` (set it to your Render URL when hosting on Pages).

### Data Source & upload

The header **Data Source** control opens an **Upload Dataset** flow (CSV / Excel):

- files are parsed (Excel via the lazily-loaded SheetJS CDN) with a progress bar,
- columns are auto-detected and mapped to required features (fuzzy matching + manual
  mapping dropdowns; missing required columns produce clear validation errors),
- a preview of the first 10 rows is shown,
- the pipeline then **cleans missing values, scales numeric features and trains a
  client-side demand model**, reporting dataset size, features, products, records,
  missing values, R²/MAE/RMSE and training time plus an AI-generated summary,
- every prediction and chart switches to the uploaded dataset until the dashboard
  is reset.

### Prediction Center (Dataset & Manual modes)

The **Prediction Center** (Dataset & Manual modes) offers a 5-step workflow
(Select Mode → Enter/Upload Data → Analyze → Predict → View Results):

- **Dataset Mode** — shows dataset analytics (size, features, missing values, duplicates,
  min/max/avg statistics and a row preview), the trained **ML model card** (model used,
  training status, R², MAE, RMSE, train/test split, training time) and a **prediction
  table** with the recommended price, change %, expected demand and revenue per product,
  plus a CSV download button.
- **Manual Mode** — an independent form (current price, demand, sales, inventory,
  competitor price, quantity, season, month, day type) with a **Predict Price** button
  that produces professional KPI cards (Recommended Price, Expected Demand, Expected
  Revenue, Expected Profit, Price Change, Confidence), the explanation
  *"The recommended price is based on demand, inventory, competitor pricing, and
  historical sales patterns"*, and a dynamic **Pricing Recommendation** panel that
  explains each factor (demand pressure, inventory, competitor price, season, margin).

The **Advanced Analytics** section (Overview / **Dataset** / **Pricing** / Demand /
Profit / Seasonal / Inventory tabs) renders the revenue, profit, demand and seasonal
charts with tooltips, zoom/pan, legends, grid lines, confidence bands, reference lines,
and automatic highest/lowest markers. The **Pricing** tab adds Actual vs Recommended
Price, Demand vs Price, Revenue & Profit comparison, Sales/Demand trend, Inventory vs
Price and Competitor vs Recommended charts. Use **Refresh Model** to retrain and
**Export Predictions (CSV)** to download per-product price recommendations.

### Currency

The header **currency selector** switches between **USD ($)** and **INR (₹)**. All
prices, revenue and profit values update everywhere immediately. INR uses Indian digit
grouping (lakh/crore — e.g. ₹1,25,000) and an **exchange rate field** appears for INR so
the conversion (default 1 USD = 83 INR) can be adjusted.

Verify the new pipeline and modules with the Node harnesses:

```bash
node scripts/test_engine.js           # CSV/mapping/cleaning/model/analytics/forecast/currency
node scripts/test_dashboard_boot.js   # DOM-shim boot for charts/engine/analytics/predict/upload
python scripts/test_backend.py        # dataset quality / pipeline / pricing rules / portfolio
```

To publish: push this repo, enable **Settings → Pages** (deploy from the `main` branch,
root `/`), then open `https://<user>.github.io/smart-dynamic-pricing/`.

## Backend CSV pipeline & Render deployment

The `backend/` FastAPI app powers **Upload Mode** — the real ML pipeline:

- `POST /api/dataset/upload` — CSV upload (≤10 MB), secure parsing, auto column
  detection, data-quality scoring (0–100 with label + issues list),
- `POST /api/pipeline/train` — Linear Regression / Random Forest / Gradient Boosting /
  XGBoost on an 80/20 split with 5-fold cross-validation; honest hold-out metrics,
  feature importances, actual-vs-predicted and a per-row prediction table,
- `POST /api/pricing/recommend` — business-rule-constrained optimisation: never below
  cost (or 50% of current price when no cost column), never more than +20% in one step,
  per-candidate profit, a High/Medium/Low reliability score and plain-language reasons,
- `POST /api/pricing/portfolio` — per-product recommendations, largest changes first,
- `GET /api/dataset/sample` — raw rows for the demand-vs-price and trend charts.

Run it locally (from the `backend/` directory so the imports resolve):

```bash
pip install -r backend/requirements.txt
cd backend
python -m uvicorn main:app --reload
```

The dashboard and API are then served from the same origin (`http://127.0.0.1:8000`).
Verify with `python scripts/test_backend.py` (all suites green: 0 failures).

**Expected accuracy on the sample dataset** (regenerate with `python backend/make_sample_csv.py`):
hold-out R² ≈ 0.46 (XGBoost, best) / 0.46 (Gradient Boosting) / 0.42 (Random Forest) /
0.27 (Linear) with 5-fold CV agreeing (≈ 0.45); per-product log-log demand fits used
by the price optimizer reach R² 0.1–0.4 with elasticities between −0.8 and −1.6.
If a regeneration ever drops to R² ≈ 0, the dataset has lost its price→demand signal
(the generator must keep ±15% promo-cycle price variation and healthy volumes).

### Deploying to Render

1. Push the repo to GitHub.
2. On Render: **New → Blueprint** and import the repo (settings are already in
   `backend/render.yaml`), or create a **Web Service** with root directory `backend`:
   - build: `pip install -r requirements.txt`
   - start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - health check path: `/api/health`
3. When the dashboard is served from GitHub Pages (different origin), point it at the
   Render service in `dashboard/index.html`:

   ```js
   window.API_BASE = "https://smart-pricing-api.onrender.com";
   ```

   Every `/api/...` call is prefixed with `API_BASE` when set — leave it empty for
   same-origin local use, set it to the Render URL for the Pages deployment. If Render
   is unreachable, Upload Mode degrades to the in-browser mirror with a clear warning.

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