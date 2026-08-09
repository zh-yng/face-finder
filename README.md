# 🕵️‍♀️ Face Finder: A Free, Local Face Clustering Engine

<table>
<tr>
<td width="60%">

Last year, I changed my trusty phone of 7+ years: archiving **100K+** photos to a local disk 😅!
And while my iPhone may have built-in People features now, my laptop does not. All I wanted was to choose a
friend's face and wish them happy birthday 🎉 without uploading
my entire life to the cloud!

So... I built Face Finder. Just provide a directory, and buffalo_sc will
detect + cluster every face: allowing you to pick from the people you know instead of filesystem hell.
You can name them, merge duplicates, and even search for photos of 2+ people together!

**100% local, and nothing leaves the container. Neat, huh?** 🔒📴

</td>
<td width="40%">

<img width="450" alt="Screenshot 2026-08-10 at 12 58 37 AM" src="https://github.com/user-attachments/assets/8887a286-e8b6-4319-960c-99ba3c4736fc" />
<p><em>As you can probably tell from my terrible naming skills, these AREN'T actually my friends.</em></p>

</td>
</tr>
</table>

## ✨ What you need before starting

* 🐳 Docker Desktop (macOS/Windows) or Docker Engine + Compose plugin (Linux).
* 💪 At least 4 CPU cores / 4 GB RAM free for Docker.
* 🖼️ A local folder (with subfolders? sure!) of photos you want to label by face.

## 1️⃣ Get the project onto your machine

Unzip the project archive you were given, or `git clone` it, then open a
terminal in the project's root folder — the one containing `docker-compose.yml`.

## 2️⃣ Point it at your photo folder

Two ways, pick one:

**Option A — env var (recommended, no file edits) 🌱:**

```bash
export PHOTOS_HOST_DIR=/absolute/path/to/your/photos
```

(Windows PowerShell: `$env:PHOTOS_HOST_DIR="C:\Users\you\Pictures\Family"`)

**Option B — edit `docker-compose.yml` directly ✍️:**

```yaml
volumes:
  - /absolute/path/to/your/photos:/data/photos:ro
```

Either way, this mount is read-only (`:ro`) 🛡️ — the engine cannot modify,
rename, or delete your source files.

## 3️⃣ Build and start the container

```bash
docker compose up --build
```

First build takes a few minutes ⏳ — it installs dependencies and downloads
the SCRFD/ArcFace model weights **once, at build time**. After that, the
container never needs network access again 🚫🌐.

Leave this terminal running. Once you see `Uvicorn running on
http://0.0.0.0:8000`, it's ready ✅.

## 4️⃣ Open the web UI

Go to **http://localhost:8000** in your browser 🌍.

## 5️⃣ Run your first scan

1. Click **Scan library** 📸. Progress shows in the status pill top-right.
   For 10,000+ photos on CPU, budget roughly 10–30 minutes depending on
   your machine (target throughput is 5–25 images/sec per the spec).
2. When it finishes, click **Re-cluster** 🧩. This groups all detected faces
   into people using DBSCAN over cosine distance.
3. The **People** grid populates with a card per detected individual 👤,
   sorted by how many photos they appear in.

## 6️⃣ Manage identified people

* 🖱️ **Open a person** — click their card to see every photo they appear in.
* 🏷️ **Name them** — type a name in the field at the top of their gallery,
  click **Save name**.
* 🔀 **Merge duplicates** — if the same person got split into two cards,
  open one, click **Merge into…**, and pick the other. Their faces
  combine into one card.
* ❌ **Remove a bad match** — hover a face thumbnail in someone's gallery
  and click the **×** in the corner to unassign that one face (it won't
  delete the photo, just the association).
* 🔍 **See where a face was detected** — click any thumbnail to open the
  full photo with a bounding box drawn around the selected person
  (highlighted) and any other detected faces (dimmed).

## 6️⃣b. Multi-face search ("Find together") 👯

Want photos containing several specific people at once — not just one?
Perfect for finding that one group photo from a birthday party 🎂🥳.

1. Open any person's gallery.
2. Click **Find together…**. A panel opens listing every other identified
   person as a chip.
3. Click chips to pick who else must appear alongside the person whose
   gallery you're in. Selected chips highlight ✨.
4. Click **Apply filter**. The gallery narrows to only photos where *all*
   selected people appear together — an exact match, not "any of them."
   An active-filter bar appears above the grid showing who's selected.
5. Click **Clear filter** (in the bar, or **Clear** inside the panel) to
   drop back to that person's full gallery.

This runs entirely off already-indexed faces — no rescan or recluster
needed ⚡, works instantly against whatever's currently in the database.

## 7️⃣ Adding new photos later

Drop new files into the same folder, then click **Scan library** again 🔄.
Unchanged files are skipped via hash + modified-time comparison — only
new or changed files get re-processed. Click **Re-cluster** afterward to
fold any new faces into existing (or new) people.

## 🛑 Stopping / restarting

```bash
docker compose down      # stop, keep your indexed data
docker compose up        # restart without re-downloading models
docker compose down -v   # stop AND wipe the indexed database + thumbnails
```

Your index (SQLite DB + face thumbnails) lives in the named Docker volume
`face_app_data`, separate from your photos, so restarting the container
never touches your original files 🗂️.

## 📁 Project layout

```
docker-compose.yml     # orchestration: ro photo mount, rw data volume
Dockerfile              # build-time model download, runtime = zero egress
requirements.txt
app/
  main.py               # FastAPI routes (scan/cluster/people/photos/together)
  db.py                 # SQLite + sqlite-vec schema and connection
  ingest.py             # traversal, hashing, EXIF fix, thumbnailing
  face_engine.py         # SCRFD detection + ArcFace embedding (InsightFace)
  cluster.py             # DBSCAN over cosine distance
  static/                # single-page web UI (vanilla JS, no build step)
```

## 🎛️ Tuning clustering

Default DBSCAN settings live in `app/cluster.py`:

```python
EPS = 0.6          # cosine distance threshold — lower = stricter matches
MIN_SAMPLES = 3    # faces needed before a group counts as a "person"
```

If you're getting the same person split across multiple cards, raise
`EPS` slightly (e.g. 0.65) and rebuild. If different people are getting
merged together, lower it (e.g. 0.5). After editing, rebuild with
`docker compose up --build` and click **Re-cluster** in the UI — no
need to re-scan.

## 🎈 Now go wish someone happy birthday

Pull up their face, grab a photo, send it their way 🥳📩.
