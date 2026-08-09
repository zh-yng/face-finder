FROM python:3.11-slim

# System deps for OpenCV / Pillow-HEIF / build tooling.
# build-essential + g++ + python3-dev + cmake needed because insightface
# compiles a small Cython extension (mesh_core) from source on install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    g++ \
    python3-dev \
    cmake \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libheif1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-fetch the InsightFace "buffalo_l" model pack (SCRFD detector + ArcFace
# recognizer) at BUILD time so the container needs zero network access at
# runtime. This is the only step in the whole image that touches the network.
RUN python - <<'PY'
import insightface
app = insightface.app.FaceAnalysis(name="buffalo_l")
app.prepare(ctx_id=-1)
print("Model pack cached at build time.")
PY

COPY app ./app

# Persistent app data (db, thumbnails) lives here — mounted as a named volume
RUN mkdir -p /data/app_data/thumbnails

ENV APP_DATA_DIR=/data/app_data \
    PHOTOS_DIR=/data/photos \
    DB_PATH=/data/app_data/faces.db \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# --network=none is enforced at the compose level, not here — the image
# itself has no code path that opens outbound sockets.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
