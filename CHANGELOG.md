# Changelog

## 2026-11-14 — dataset-only pricing, real backend features, warm-sand redesign

### Removed

- **Manual Mode**, entirely: the Predict-page switcher, its form, KPI cards, confidence
  score, step text, CSS, `engine.manualPredict()` and the browser-side manual calculator.
- `POST /api/pricing/manual` and `pricing.manual_predict()` — dead once Manual Mode was
  gone. `POST /api/price` (the legacy product-id endpoint) and the `src/` experiment
  package are untouched and unused by the deployed app.
- The in-browser price optimiser and "model tournament" (`optimizePrice`,
  `predictionTable` price model, `trainModel`, `explain`) — the browser no longer fits or
  prices anything.
- Fake RL output (`price × fixed multiplier`, hard-coded `q_values`, `learning_steps: 2000`)
  and random synthetic customers in the negotiation flow.
- The invented weekend impact (`×1.12`) and the `confidence_pct` formula.
- Dead `check_live_site.py` assertions based on exact numbers.

### Changed

- **Dataset Mode is backend-driven.** After upload the page calls `/api/dataset/upload`,
  `/api/pricing/portfolio` (Profit / Revenue toggle) and `/api/pipeline/train`; the table,
  chart, CSV export and product detail render those responses. If the API is unreachable
  the page shows a readable error and a Retry button — it never falls back to a browser
  model.
- **Demand model**: log-log fit with competitor price, discount, day-of-week and month
  controls; returns elasticity with standard error, 95% CI, p-value and n.
- **Price search**: 400-step grid (was 14) with a +20% cap and a cost floor; rules are only
  listed when they bind.
- **Reliability** now follows the R²/CI/n rule set, so a no-signal product (R² 0.09) is
  rated Low instead of High.
- **Portfolio** "current price" is the median of the last 14 days, not the last row.
- **Pipeline** drops duplicates, converts dates into month / day-of-week / is-weekend /
  sin-cos(day-of-year) features and reports both a random-split and a time-split R².
- **Reinforcement learning**: real tabular Q-learning on the backend (inventory, demand
  pressure, competitor-gap states; price-multiplier actions; profit reward) — ~24,000 steps
  in ~1.3 s, returning the trained Q-table and step count.
- **Negotiation** moved to the backend: multi-round concession that always respects
  `price ≥ cost × (1 + min_margin)`, takes the customer's budget as input and labels itself
  a simulation.
- **Health gate**: the dashboard pings `/api/health`, shows "Waking server (up to ~60 s)…"
  with backoff and keeps action buttons disabled until the API is ready.
- **UI redesign** to "Warm Sand & Terracotta": single token block in `:root`, Fraunces +
  Inter from one Google Fonts link, 64px nav, 1180px content width, cream cards, dark hero
  banner, terracotta accents, accessible pills that pair colour with text, 44px touch
  targets and a stacked/scrolling layout down to 360px.
- Charts read their palette from CSS variables, so no colour literals remain outside the
  token block.

### Added

- `tests/test_backend_pricing.py` — 15 pytest cases covering the fixture's true
  elasticities, the theoretical profit optimum, the +20% cap and cost floor, reliability
  thresholds, competitor/discount sensitivity, the 14-day median, date features,
  time-split reporting, Q-learning and the negotiation floor.
- `scripts/make_test_data.py` and `test_pricing_data.csv` (1,835 rows, 5 products,
  10 duplicates).
- `scripts/check_live_site.py` — tolerance-based acceptance check (local or deployed).
- `scripts/screenshots.py` and `screenshots/*.png` — every page at 1280px and 390px.
- `scripts/test_live_pages.js` rewritten to boot the served assets against a DOM shim.

### Fixed

- Recommendations for a product with a flat price history no longer come from a
  price-insensitive in-browser model.
- Revenue objective reports the profit change and warns when profit falls.
- Dashboard no longer claims accuracy, confidence or impacts it cannot compute.
