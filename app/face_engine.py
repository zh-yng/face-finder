"""FR-2.1 / FR-2.2 / FR-2.3: face detection + 512-d embedding generation.

Wraps InsightFace's "buffalo_l" pack, which bundles:
  - detector: SCRFD  (produces bbox + 5-point landmarks + det_score)
  - recognizer: ArcFace (produces a 512-d L2-normalizable embedding)

Model weights are baked into the Docker image at BUILD time (see Dockerfile),
so nothing here ever touches the network at runtime.
"""
import threading

import numpy as np
from insightface.app import FaceAnalysis

MIN_FACE_PX = 48          # FR-2.3
MIN_DET_SCORE = 0.5        # FR-2.3
EMBEDDING_DIM = 512

_lock = threading.Lock()
_app = None


def _get_app() -> FaceAnalysis:
    global _app
    if _app is None:
        with _lock:
            if _app is None:
                _app = FaceAnalysis(name="buffalo_l")
                # ctx_id=-1 -> CPU inference, matches the NFR CPU-only target.
                _app.prepare(ctx_id=-1, det_size=(640, 640))
    return _app


class DetectedFace:
    __slots__ = ("bbox", "det_score", "embedding")

    def __init__(self, bbox, det_score, embedding):
        self.bbox = bbox              # (x1, y1, x2, y2) in pixel coords
        self.det_score = det_score    # float
        self.embedding = embedding    # np.ndarray, shape (512,), L2-normalized


def detect_and_embed(bgr_image: np.ndarray) -> list[DetectedFace]:
    """Run SCRFD detection + ArcFace embedding on one image (BGR, as OpenCV
    loads it). Applies the low-quality filter from FR-2.3 and returns only
    faces that pass.
    """
    app = _get_app()
    raw_faces = app.get(bgr_image)

    results: list[DetectedFace] = []
    for f in raw_faces:
        x1, y1, x2, y2 = f.bbox
        w, h = x2 - x1, y2 - y1
        if w < MIN_FACE_PX or h < MIN_FACE_PX:
            continue
        if f.det_score is not None and f.det_score < MIN_DET_SCORE:
            continue

        emb = f.normed_embedding  # already L2-normalized 512-d vector
        if emb is None or emb.shape[0] != EMBEDDING_DIM:
            continue

        results.append(
            DetectedFace(
                bbox=(float(x1), float(y1), float(x2), float(y2)),
                det_score=float(f.det_score) if f.det_score is not None else 1.0,
                embedding=emb.astype(np.float32),
            )
        )
    return results
