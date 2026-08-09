import os
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import cluster, db, ingest

PHOTOS_DIR = os.environ.get("PHOTOS_DIR", "/data/photos")
APP_DATA_DIR = os.environ.get("APP_DATA_DIR", "/data/app_data")
THUMB_DIR = os.path.join(APP_DATA_DIR, "thumbnails")

app = FastAPI(title="Local Face Clustering Engine")


@app.on_event("startup")
def _startup():
    db.init_db()


# ---------------------------------------------------------------- scanning --

@app.post("/api/scan")
def start_scan(background_tasks: BackgroundTasks):
    if ingest.SCAN_STATE["running"]:
        raise HTTPException(409, "A scan is already running.")
    if not os.path.isdir(PHOTOS_DIR):
        raise HTTPException(
            400,
            f"Photos directory not found at {PHOTOS_DIR}. "
            "Check your docker-compose.yml volume mapping.",
        )
    background_tasks.add_task(ingest.run_scan, PHOTOS_DIR)
    return {"status": "started"}


@app.get("/api/scan/status")
def scan_status():
    return ingest.SCAN_STATE


# ------------------------------------------------------------- clustering --

@app.post("/api/cluster")
def trigger_clustering():
    if ingest.SCAN_STATE["running"]:
        raise HTTPException(409, "Cannot cluster while a scan is running.")
    conn = db.get_conn()
    result = cluster.run_clustering(conn)
    return result


# ------------------------------------------------------------------ people --

@app.get("/api/people")
def list_people():
    conn = db.get_conn()
    rows = conn.execute(
        """
        SELECT c.id, c.person_name, c.representative_face_id,
               COUNT(f.id) AS face_count
        FROM clusters c
        JOIN faces f ON f.cluster_id = c.id AND f.removed = 0
        GROUP BY c.id
        ORDER BY face_count DESC
        """
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/people/{cluster_id}/faces")
def person_faces(cluster_id: int):
    conn = db.get_conn()
    rows = conn.execute(
        """
        SELECT f.id AS face_id, f.photo_id, f.thumbnail_path, f.det_score,
               f.bbox_x1, f.bbox_y1, f.bbox_x2, f.bbox_y2, p.file_path
        FROM faces f
        JOIN photos p ON p.id = f.photo_id
        WHERE f.cluster_id = ? AND f.removed = 0
        ORDER BY f.id
        """,
        (cluster_id,),
    ).fetchall()
    if not rows:
        # distinguish "empty cluster" from "cluster doesn't exist"
        exists = conn.execute(
            "SELECT 1 FROM clusters WHERE id = ?", (cluster_id,)
        ).fetchone()
        if not exists:
            raise HTTPException(404, "No such person.")
    return [dict(r) for r in rows]


class RenameBody(BaseModel):
    name: str


@app.post("/api/people/{cluster_id}/rename")
def rename_person(cluster_id: int, body: RenameBody):
    conn = db.get_conn()
    cur = conn.execute(
        "UPDATE clusters SET person_name = ? WHERE id = ?",
        (body.name.strip(), cluster_id),
    )
    conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "No such person.")
    return {"status": "ok"}


class MergeBody(BaseModel):
    source_id: int
    target_id: int


@app.post("/api/people/merge")
def merge_people(body: MergeBody):
    if body.source_id == body.target_id:
        raise HTTPException(400, "Cannot merge a person into themselves.")
    conn = db.get_conn()
    target = conn.execute(
        "SELECT * FROM clusters WHERE id = ?", (body.target_id,)
    ).fetchone()
    source = conn.execute(
        "SELECT * FROM clusters WHERE id = ?", (body.source_id,)
    ).fetchone()
    if not target or not source:
        raise HTTPException(404, "No such person.")

    conn.execute(
        "UPDATE faces SET cluster_id = ? WHERE cluster_id = ?",
        (body.target_id, body.source_id),
    )
    # keep target's name; if target has no name but source does, adopt it
    if not target["person_name"] and source["person_name"]:
        conn.execute(
            "UPDATE clusters SET person_name = ? WHERE id = ?",
            (source["person_name"], body.target_id),
        )
    conn.execute("DELETE FROM clusters WHERE id = ?", (body.source_id,))
    conn.commit()
    return {"status": "ok"}


# ------------------------------------------------------------------ faces --

@app.post("/api/faces/{face_id}/remove")
def remove_face(face_id: int):
    """FR-4.4 Removal: mark a false-positive face instance as unassigned."""
    conn = db.get_conn()
    cur = conn.execute(
        "UPDATE faces SET removed = 1, cluster_id = NULL WHERE id = ?", (face_id,)
    )
    conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "No such face.")
    return {"status": "ok"}


@app.get("/api/photos/intersect")
def photos_intersect(cluster_ids: str):
    """FR: given a comma-separated list of cluster ids, return every photo
    that contains a non-removed face from ALL of those clusters — used to
    find photos where several specific people appear together."""
    try:
        ids = [int(x) for x in cluster_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(400, "cluster_ids must be a comma-separated list of integers.")
    ids = sorted(set(ids))
    if not ids:
        raise HTTPException(400, "cluster_ids required.")

    conn = db.get_conn()
    placeholders = ",".join("?" for _ in ids)
    photo_rows = conn.execute(
        f"""
        SELECT f.photo_id
        FROM faces f
        WHERE f.cluster_id IN ({placeholders}) AND f.removed = 0
        GROUP BY f.photo_id
        HAVING COUNT(DISTINCT f.cluster_id) = ?
        """,
        (*ids, len(ids)),
    ).fetchall()
    photo_ids = [r["photo_id"] for r in photo_rows]
    if not photo_ids:
        return []

    ph_placeholders = ",".join("?" for _ in photo_ids)
    photos = conn.execute(
        f"SELECT * FROM photos WHERE id IN ({ph_placeholders})", photo_ids
    ).fetchall()
    faces = conn.execute(
        f"""
        SELECT f.id AS face_id, f.photo_id, f.cluster_id, f.thumbnail_path
        FROM faces f
        WHERE f.photo_id IN ({ph_placeholders})
          AND f.cluster_id IN ({placeholders})
          AND f.removed = 0
        """,
        (*photo_ids, *ids),
    ).fetchall()
    faces_by_photo = {}
    for f in faces:
        faces_by_photo.setdefault(f["photo_id"], []).append(dict(f))

    return [
        {"photo": dict(p), "faces": faces_by_photo.get(p["id"], [])}
        for p in photos
    ]


# ----------------------------------------------------------------- photos --

@app.get("/api/photos/{photo_id}")
def photo_detail(photo_id: int):
    conn = db.get_conn()
    photo = conn.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()
    if not photo:
        raise HTTPException(404, "No such photo.")
    faces = conn.execute(
        """
        SELECT f.id AS face_id, f.bbox_x1, f.bbox_y1, f.bbox_x2, f.bbox_y2,
               f.cluster_id, c.person_name
        FROM faces f
        LEFT JOIN clusters c ON c.id = f.cluster_id
        WHERE f.photo_id = ? AND f.removed = 0
        """,
        (photo_id,),
    ).fetchall()
    return {"photo": dict(photo), "faces": [dict(r) for r in faces]}


@app.get("/api/image")
def get_image(path: str):
    """Serve a source photo. Path is relative to PHOTOS_DIR and is resolved
    + checked to stay inside PHOTOS_DIR to prevent path traversal, since
    source photos are read-only and must never be reachable outside the
    mounted library (FR-1.2)."""
    root = Path(PHOTOS_DIR).resolve()
    target = (root / path).resolve()
    if root not in target.parents and target != root:
        raise HTTPException(403, "Path outside photo library.")
    if not target.is_file():
        raise HTTPException(404, "File not found.")
    return FileResponse(target)


@app.get("/api/thumbnail/{face_id}")
def get_thumbnail(face_id: int):
    conn = db.get_conn()
    row = conn.execute(
        "SELECT thumbnail_path FROM faces WHERE id = ?", (face_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "No such face.")
    target = Path(THUMB_DIR) / row["thumbnail_path"]
    if not target.is_file():
        raise HTTPException(404, "Thumbnail not found.")
    return FileResponse(target)


# ------------------------------------------------------------------- root --
# Serve the single-page UI. Mounted last so it doesn't shadow /api routes.
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
