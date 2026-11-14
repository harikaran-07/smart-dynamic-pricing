"""Customer segmentation (K-Means) + loyalty scoring."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler


def segment(customers: pd.DataFrame, n_clusters: int = 4, seed: int = 42) -> tuple:
    feats = customers[["loyalty_score", "purchase_count", "avg_sales"]].copy()
    scaler = StandardScaler()
    X = scaler.fit_transform(feats)
    km = KMeans(n_clusters=n_clusters, random_state=seed, n_init=10)
    labels = km.fit_predict(X)

    # order clusters by mean spend so cluster 0 = lowest value
    order = np.argsort(km.cluster_centers_[:, 2])
    remap = {old: new for new, old in enumerate(order)}
    labels = np.array([remap[l] for l in labels])

    df = customers.copy()
    df["segment"] = labels
    df["segment_label"] = df["segment"].map({
        0: "Bargain seeker", 1: "Regular", 2: "Loyal", 3: "Premium",
    })
    df["loyalty_tier"] = np.select(
        [df["loyalty_score"] >= 80, df["loyalty_score"] >= 50, df["loyalty_score"] >= 25],
        ["Gold", "Silver", "Bronze"], default="New"
    )
    return df, {"scaler": scaler, "kmeans": km}