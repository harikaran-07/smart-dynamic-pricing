"""Generate an explainability report for the demand models.

Produces:
  - reports/feature_importance.png   (bar chart of the winning model's importances)
  - reports/pred_vs_actual.png       (scatter for the winning model)
  - reports/model_comparison.png     (RMSE / R2 bar chart across models)
  - reports/report.json              (metrics + feature importance, used by /api/explain)

Run from the project root:
    .venv\\Scripts\\python.exe scripts\\generate_report.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import joblib
import matplotlib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

matplotlib.use("Agg")

from src.config import (  # noqa: E402
    DEMAND_ARTIFACT,
    REPORT_JSON,
    REPORTS_DIR,
    SALES_PROCESSED,
)
from src.models.demand import FEATURES, prepare_dataset  # noqa: E402


def _estimator(model):
    return model.named_steps["reg"] if hasattr(model, "named_steps") else model


def _importances(model: object) -> list[float]:
    est = _estimator(model)
    if hasattr(est, "feature_importances_"):
        return list(est.feature_importances_)
    if hasattr(est, "coef_"):
        return list(np.abs(est.coef_))
    return [0.0] * len(FEATURES)


def _evaluate(model, X: pd.DataFrame, y: pd.Series) -> dict:
    pred = np.clip(model.predict(X), 0, None)
    return {
        "mae": float(mean_absolute_error(y, pred)),
        "rmse": float(np.sqrt(mean_squared_error(y, pred))),
        "r2": float(r2_score(y, pred)),
    }


def main() -> None:
    models = joblib.load(DEMAND_ARTIFACT)
    feats = pd.read_csv(SALES_PROCESSED)
    X, y = prepare_dataset(feats)

    metrics = {name: _evaluate(m, X, y) for name, m in models.items()}
    winner = min(models, key=lambda n: metrics[n]["rmse"])
    model = models[winner]
    importance = _importances(model)
    order = np.argsort(importance)[::-1]

    # feature importance bar chart
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.barh([FEATURES[i] for i in order], [importance[i] for i in order], color="#4f8cff")
    ax.set_title(f"Feature importance ({winner})")
    ax.set_xlabel("Importance")
    fig.tight_layout()
    fig.savefig(REPORTS_DIR / "feature_importance.png", dpi=120)
    plt.close(fig)

    # predicted vs actual
    pred = np.clip(model.predict(X), 0, None)
    fig, ax = plt.subplots(figsize=(6, 6))
    lim = [0, float(np.percentile(np.r_[y.to_numpy(), pred], 99))]
    ax.scatter(y, pred, s=6, alpha=0.3, color="#3ddc97")
    ax.plot(lim, lim, "--", color="#ff5470", lw=1)
    ax.set_xlim(*lim)
    ax.set_ylim(*lim)
    ax.set_xlabel("Actual units")
    ax.set_ylabel("Predicted units")
    ax.set_title(f"Predicted vs Actual ({winner})")
    fig.tight_layout()
    fig.savefig(REPORTS_DIR / "pred_vs_actual.png", dpi=120)
    plt.close(fig)

    # model comparison
    names = list(models)
    fig, ax = plt.subplots(figsize=(9, 5))
    x = np.arange(len(names))
    ax.bar(x - 0.19, [metrics[n]["rmse"] for n in names], 0.38, label="RMSE", color="#ffb020")
    ax.bar(x + 0.19, [metrics[n]["r2"] for n in names], 0.38, label="R2", color="#4f8cff")
    ax.set_xticks(x)
    ax.set_xticklabels(names)
    ax.set_ylabel("score")
    ax.legend()
    ax.set_title("Demand model comparison")
    fig.tight_layout()
    fig.savefig(REPORTS_DIR / "model_comparison.png", dpi=120)
    plt.close(fig)

    report = {
        "winner": winner,
        "metrics": metrics,
        "feature_importance": {
            FEATURES[i]: round(float(importance[i]), 5) for i in range(len(FEATURES))
        },
        "top_features": [
            {"feature": FEATURES[i], "importance": round(float(importance[i]), 5)}
            for i in order[:10]
        ],
        "n_features": int(len(FEATURES)),
    }
    REPORT_JSON.write_text(json.dumps(report, indent=2, default=str))
    print(f"Report written to {REPORTS_DIR}")
    print("Winner:", winner, "| RMSE:", round(metrics[winner]["rmse"], 4),
          "| R2:", round(metrics[winner]["r2"], 4))
    print("Top 5 features:", [t["feature"] for t in report["top_features"][:5]])


if __name__ == "__main__":
    main()