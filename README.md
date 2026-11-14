# Smart Dynamic Pricing

A dataset-driven pricing dashboard. Upload a sales history and the FastAPI backend fits a
demand curve per product, recommends a price, and shows the evidence behind it: elasticity
with a confidence interval, R², reliability, applied business rules and a sensitivity table.

The browser only parses and previews data. **Every price, metric and simulation is computed
by the backend** — there is no in-browser pricing model and no fabricated output.

## What it does

- **Upload & Analytics** — CSV upload, column mapping, data-quality score, backend model
  comparison (Linear / Random Forest / Gradient Boosting / XGBoost), feature importances,
  actual-vs-predicted and descriptive analytics (revenue, profit, seasonality, inventory).
- **Predict** — 5-step flow (Upload → Profile → Train → Price → Results). The
  recommendations table, chart, CSV export and product detail all come from the backend;
  the detail panel shows the candidate curve, binding rules and a ±10% sensitivity table.
- **Portfolio** — every product ranked by the size of the recommended change, with the
  current price taken as the median of the last 14 days.
- **Decision tools** — a real tabular Q-learning agent and a multi-round negotiation
  simulation, both run on the backend against the fitted demand curve. Both are labelled
  as simulations.

## Tech stack

Python 3.12 · pandas · NumPy · scikit-learn · XGBoost · FastAPI · uvicorn · plain-JS dashboard
(no build step) · Fraunces + Inter from Google Fonts.

## Project layout

```
backend/
  main.py             # FastAPI app, routes, static dashboard mount
  dataset.py          # CSV parsing, profiling, quality score
  pipeline.py         # model comparison, date features, random + time split
  pricing.py          # log-log demand model, optimiser, portfolio, Q-learning, negotiation
dashboard/
  index.html          # shell, design tokens, navigation, decision tools
  engine.js           # parsing, column mapping, cleaning, descriptive analytics
  analytics.js        # Upload & Analytics tabs
  predict.js          # dataset-only Predict + Portfolio pages
  upload.js           # upload flow, toasts, cross-module refresh
  ml.js               # backend pipeline panels
  charts.js           # canvas charts, colours from CSS variables
scripts/
  make_test_data.py   # regenerates test_pricing_data.csv
  test_engine.js      # engine + analytics harness
  test_dashboard_boot.js  # DOM-shim boot test with a mocked backend
  test_live_pages.js  # live asset/boot smoke test
  check_live_site.py  # tolerance-based acceptance check against a running service
  screenshots.py      # Playwright captures at 1280px and 390px
tests/
  test_backend_pricing.py  # pytest suite for the pricing/pipeline backend
test_pricing_data.csv      # 1,835-row fixture, 5 products, 10 duplicates
screenshots/               # captured pages
src/                       # legacy experiment package (not used by the deployed app)
```

## Run locally

```bash
pip install -r backend/requirements.txt
cd backend
python -m uvicorn main:app --reload
# dashboard + API on http://127.0.0.1:8000
```

The dashboard starts empty and pings `/api/health` on load; the action buttons stay disabled
until the API answers (Render free instances take 35–60 s to wake).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | readiness probe used by the dashboard gate |
| POST | `/api/dataset/upload` | parse a CSV, score quality, suggest the target |
| POST | `/api/pipeline/train` | train/compare models, random and time-split R² |
| POST | `/api/pricing/recommend` | demand model, optimal price, rules, sensitivity |
| POST | `/api/pricing/portfolio` | per-product recommendations |
| POST | `/api/rl-price` | tabular Q-learning price (simulation) |
| POST | `/api/negotiate` | multi-round negotiation with a margin floor (simulation) |
| GET | `/api/dataset/sample` | raw rows for the observed-data charts |

Example:

```bash
curl -X POST http://127.0.0.1:8000/api/pricing/recommend \
  -H "Content-Type: application/json" \
  -d '{"dataset_id":"...","objective":"profit",
       "row":{"product_id":"P002","price":35,"cost":15,"competitor_price":36,
              "discount_pct":5,"inventory":120,"units_sold":40,"date":"2025-12-01"}}'
```

The response contains `demand_model` (elasticity, standard error, 95% CI, p-value, R², n),
`current`, `optimal`, `rules` (only rules that actually bound), `reliability`
(High/Medium/Low with the reason) and `sensitivity` for −10…+10% price moves.

### Pricing rules

- Objective defaults to **profit** when a cost column exists; revenue is available and
  reports the profit change, warning when profit falls.
- Prices never exceed +20% of the current price and never fall below cost.
- Reliability is **Low** when R² < 0.10, the elasticity CI includes 0, or n < 30;
  **High** only when R² ≥ 0.30, n ≥ 150, the CI excludes 0 and elasticity ∈ [−3, −0.3].
- Duplicates are dropped before fitting; a date column becomes month, day-of-week,
  is-weekend and sin/cos day-of-year features, and a chronological split is reported
  alongside the random split.

## Tests

```bash
python -m pytest tests/test_backend_pricing.py -q
node scripts/test_engine.js
node scripts/test_dashboard_boot.js
python scripts/check_live_site.py --base http://127.0.0.1:8000
python scripts/screenshots.py            # needs `python -m playwright install chromium`
```

`scripts/check_live_site.py` is tolerance-based: it regenerates the fixture expectations
(elasticity ±0.3, profit price within ±5% of the theoretical optimum, P001 not High,
competitor/discount sensitivity, 14-day median, negotiation floor) and can be pointed at a
deployed service, e.g. `--base https://smart-dynamic-pricing.onrender.com`.

## Deploy

`backend/render.yaml` describes the Render web service (root `backend`, start
`uvicorn main:app --host 0.0.0.0 --port $PORT`, health check `/api/health`). The dashboard is
served by the same app. When hosted separately (GitHub Pages), `window.API_BASE` is the only
setting that changes; the dashboard then talks to the Render origin and shows a Retry button
if it is unreachable.
