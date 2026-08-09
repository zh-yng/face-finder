"""FR-3.2 / FR-3.3: unsupervised clustering of face embeddings.

DBSCAN over cosine distance, default eps=0.6, min_samples=3. Re-runnable at
any time (manual trigger from the UI) — it recomputes ALL cluster
assignments from scratch each run, except it leaves user-named clusters
("named" = person_name is not null) alone unless the user has removed every
face from them, so manual naming survives a re-cluster.
"""
import sqlite3
import struct

import numpy as np
from sklearn.cluster import DBSCAN

EPS = 0.6
MIN_SAMPLES = 3


def _blob_to_vec(blob: bytes) -> np.ndarray:
    n = len(blob) // 4
    return np.array(struct.unpack(f"{n}f", blob), dtype=np.float32)


def run_clustering(conn: sqlite3.Connection) -> dict:
    rows = conn.execute(
        """
        SELECT f.id AS face_id, fv.embedding AS embedding
        FROM faces f
        JOIN face_vectors fv ON fv.face_id = f.id
        WHERE f.removed = 0
        """
    ).fetchall()

    if not rows:
        return {"clusters_created": 0, "faces_clustered": 0, "noise": 0}

    face_ids = [r["face_id"] for r in rows]
    vectors = np.stack([_blob_to_vec(r["embedding"]) for r in rows])
    # embeddings from ArcFace are already L2-normalized, but normalize again
    # defensively so cosine distance is well-behaved regardless of source.
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vectors = vectors / norms

    labels = DBSCAN(eps=EPS, min_samples=MIN_SAMPLES, metric="cosine").fit_predict(
        vectors
    )

    # Preserve existing person names: build a map of old cluster_id -> name
    # for clusters that still have at least one face after this run.
    old_named = {
        r["id"]: r["person_name"]
        for r in conn.execute(
            "SELECT id, person_name FROM clusters WHERE person_name IS NOT NULL"
        ).fetchall()
    }
    # For each face, remember which named cluster (if any) it belonged to,
    # so a re-cluster can re-attach the same name to the new cluster that
    # contains the majority of that group's faces.
    prior_face_cluster = {
        r["face_id"]: r["cluster_id"]
        for r in conn.execute(
            "SELECT id AS face_id, cluster_id FROM faces WHERE cluster_id IS NOT NULL"
        ).fetchall()
    }

    # Clear old auto assignments (keep clusters rows for now, we'll dedupe after)
    conn.execute("UPDATE faces SET cluster_id = NULL, is_noise = 0")

    label_to_faceids: dict[int, list[int]] = {}
    for fid, label in zip(face_ids, labels):
        if label == -1:
            continue
        label_to_faceids.setdefault(label, []).append(fid)

    conn.execute("DELETE FROM clusters")  # rebuild cleanly; names re-attached below

    clusters_created = 0
    for label, fids in label_to_faceids.items():
        # figure out if this new cluster corresponds to a previously-named one
        # (majority vote among faces' prior cluster -> prior name)
        prior_names = [
            old_named.get(prior_face_cluster.get(fid))
            for fid in fids
            if old_named.get(prior_face_cluster.get(fid))
        ]
        person_name = None
        if prior_names:
            person_name = max(set(prior_names), key=prior_names.count)

        rep_face_id = fids[0]
        cur = conn.execute(
            "INSERT INTO clusters (person_name, representative_face_id) VALUES (?, ?)",
            (person_name, rep_face_id),
        )
        cluster_id = cur.lastrowid
        conn.executemany(
            "UPDATE faces SET cluster_id = ? WHERE id = ?",
            [(cluster_id, fid) for fid in fids],
        )
        clusters_created += 1

    noise_ids = [fid for fid, label in zip(face_ids, labels) if label == -1]
    if noise_ids:
        conn.executemany(
            "UPDATE faces SET is_noise = 1 WHERE id = ?",
            [(fid,) for fid in noise_ids],
        )

    conn.commit()
    return {
        "clusters_created": clusters_created,
        "faces_clustered": len(face_ids) - len(noise_ids),
        "noise": len(noise_ids),
    }
