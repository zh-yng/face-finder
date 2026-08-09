"""EPIC-1: ingestion & scanning engine.

FR-1.1 recursive traversal / supported formats
FR-1.2 strictly read-only access to source photos
FR-1.3 EXIF orientation correction before detection
FR-1.4 hash + mtime based de-duplication so re-scans skip unchanged files
FR-2.4 150x150 JPEG thumbnail per valid face
"""
import os
import sqlite3
import struct
import time
import traceback
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
import pillow_heif

from . import db, face_engine

pillow_heif.register_heif_opener()

SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
APP_DATA_DIR = os.environ.get("APP_DATA_DIR", "/data/app_data")
THUMB_DIR = os.path.join(APP_DATA_DIR, "thumbnails")
THUMB_SIZE = 150

# In-memory progress tracker, polled by GET /api/scan/status
SCAN_STATE = {
    "running": False,
    "total_found": 0,
    "processed": 0,
    "new_photos": 0,
    "skipped_unchanged": 0,
    "faces_found": 0,
    "errors": 0,
    "last_error": None,
    "started_at": None,
    "finished_at": None,
}


def _hash_file(path: Path) -> str:
    """FR-1.4: fast content hash. Uses blake3 if available, else sha256."""
    try:
        import blake3
        h = blake3.blake3()
    except ImportError:
        import hashlib
        h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _iter_supported_files(root: Path):
    for p in root.rglob("*"):
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS:
            yield p


def _vec_to_blob(vec: np.ndarray) -> bytes:
    return struct.pack(f"{vec.shape[0]}f", *vec.tolist())


def _save_thumbnail(pil_img: Image.Image, bbox, face_id: int) -> str:
    x1, y1, x2, y2 = [int(round(v)) for v in bbox]
    x1, y1 = max(x1, 0), max(y1, 0)
    x2, y2 = min(x2, pil_img.width), min(y2, pil_img.height)
    crop = pil_img.crop((x1, y1, x2, y2))
    # pad to square before resize so faces aren't stretched
    side = max(crop.width, crop.height)
    square = Image.new("RGB", (side, side), (20, 20, 20))
    square.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
    square = square.resize((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)

    os.makedirs(THUMB_DIR, exist_ok=True)
    rel_path = f"{face_id}.jpg"
    square.save(os.path.join(THUMB_DIR, rel_path), "JPEG", quality=88)
    return rel_path


def _process_one_photo(conn: sqlite3.Connection, path: Path, photos_root: Path):
    file_hash = _hash_file(path)
    rel_path = str(path.relative_to(photos_root))

    row = conn.execute(
        "SELECT id, file_hash FROM photos WHERE file_path = ?", (rel_path,)
    ).fetchone()
    if row is not None and row["file_hash"] == file_hash:
        SCAN_STATE["skipped_unchanged"] += 1
        return  # FR-1.4: unchanged since last scan, skip re-inference

    # FR-1.2 / FR-1.3: open read-only, correct EXIF orientation
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        width, height = im.size
        rgb_np = np.array(im)
        bgr_np = rgb_np[:, :, ::-1].copy()  # insightface expects BGR

        if row is None:
            cur = conn.execute(
                "INSERT INTO photos (file_path, file_hash, width, height) "
                "VALUES (?, ?, ?, ?)",
                (rel_path, file_hash, width, height),
            )
            photo_id = cur.lastrowid
            SCAN_STATE["new_photos"] += 1
        else:
            photo_id = row["id"]
            conn.execute(
                "UPDATE photos SET file_hash = ?, width = ?, height = ?, "
                "scanned_at = CURRENT_TIMESTAMP WHERE id = ?",
                (file_hash, width, height, photo_id),
            )
            # re-scanned file changed on disk -> drop stale faces, re-detect
            conn.execute("DELETE FROM faces WHERE photo_id = ?", (photo_id,))

        faces = face_engine.detect_and_embed(bgr_np)
        for f in faces:
            cur = conn.execute(
                "INSERT INTO faces (photo_id, bbox_x1, bbox_y1, bbox_x2, bbox_y2, "
                "det_score, thumbnail_path) VALUES (?, ?, ?, ?, ?, ?, '')",
                (photo_id, *f.bbox, f.det_score),
            )
            face_id = cur.lastrowid
            thumb_rel = _save_thumbnail(im, f.bbox, face_id)
            conn.execute(
                "UPDATE faces SET thumbnail_path = ? WHERE id = ?",
                (thumb_rel, face_id),
            )
            conn.execute(
                "INSERT INTO face_vectors (face_id, embedding) VALUES (?, ?)",
                (face_id, _vec_to_blob(f.embedding)),
            )
            SCAN_STATE["faces_found"] += 1

    conn.commit()


def run_scan(photos_dir: str):
    """FR-1.1: entry point for a full/incremental scan. Meant to run in a
    background task; updates SCAN_STATE as it goes so the UI can poll.
    """
    if SCAN_STATE["running"]:
        return
    SCAN_STATE.update(
        running=True, total_found=0, processed=0, new_photos=0,
        skipped_unchanged=0, faces_found=0, errors=0, last_error=None,
        started_at=time.time(), finished_at=None,
    )
    conn = db.get_conn()
    root = Path(photos_dir)
    try:
        files = list(_iter_supported_files(root))
        SCAN_STATE["total_found"] = len(files)
        for p in files:
            try:
                _process_one_photo(conn, p, root)
            except Exception as e:  # keep scanning even if one file is bad
                SCAN_STATE["errors"] += 1
                SCAN_STATE["last_error"] = f"{p.name}: {e}"
                traceback.print_exc()
            finally:
                SCAN_STATE["processed"] += 1
    finally:
        SCAN_STATE["running"] = False
        SCAN_STATE["finished_at"] = time.time()
