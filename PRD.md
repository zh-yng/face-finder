# Product Requirement Document (PRD)

**Project Name:** Local Face Clustering Container Engine  
**Document Version:** 1.0  
**Target Release:** MVP  
**Status:** Approved  

---

## 1. Executive Summary & Vision

### 1.1 Overview
The **Local Face Clustering Container Engine** is a privacy-first, containerized application designed to run on consumer laptops (macOS, Windows, Linux). It recursively scans a local directory for image files, detects human faces, computes high-dimensional vector embeddings, groups recurring faces into clusters (individuals), and presents a local web UI to browse and manage identified people—without sending any visual or metadata to the cloud.

### 1.2 Core Value Proposition
* **100% On-Device Privacy:** Zero network egress required. All detection, vector search, and image rendering occur on the host machine.
* **Non-Destructive File Access:** Source directories are mounted as read-only.
* **Lightweight Containerization:** One-command deployment (`docker compose up`) with automated environment setup and persistent storage management.

---

## 2. Target Users & Use Cases

### 2.1 Target Personas
1. **Privacy-Conscious Photographers:** Users managing thousands of personal or client photos locally who want automated face indexing without uploading photos to Google Photos, iCloud, or third-party cloud tools.
2. **Local Archivists & Digital Hobbyists:** Users looking to organize unstructured family photo drives using lightweight local AI tools.

### 2.2 Primary Use Cases
* **Initial Deep Scan:** Mounting a library of 10,000+ photos to automatically discover every recurring individual.
* **Incremental Library Updates:** Dropping new photos into a folder and having the background engine pick up new faces without re-scanning unchanged files.
* **Cluster Management:** Naming identified people, merging duplicate clusters, or removing false-positive face detections.

---

## 3. Technical Requirements & System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ HOST SYSTEM                                                                 │
│                                                                             │
│ ┌─────────────────────────┐               ┌──────────────────────────────┐ │
│ │ Local Photo Directory   │               │ Docker App Data Volume       │ │
│ │ (~/Pictures/Family)    │               │ (face_app_data)              │ │
│ └───────────┬─────────────┘               └──────────────▲───────────────┘ │
└─────────────┼────────────────────────────────────────────┼─────────────────┘
              │ READ-ONLY BIND MOUNT (:ro)                 │ READ-WRITE MOUNT
              ▼                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ DOCKER CONTAINER                                                            │
│                                                                             │
│ ┌───────────────────┐    ┌────────────────────┐    ┌──────────────────────┐ │
│ │ Ingestion & EXIF  ├─┬─►│ InsightFace Engine ├─┬─►│ SQLite + sqlite-vec  │ │
│ │ (Pathlib, Pillow) │ │  │ (SCRFD + ArcFace)  │ │  │ (Metadata & Vectors) │ │
│ └───────────────────┘ │  └────────────────────┘ │  └──────────┬───────────┘ │
│                       │                         │             │             │
│                       ▼                         ▼             ▼             │
│              ┌────────────────────────────────────────────────────┐         │
│              │ FastAPI Backend Engine                             │         │
│              └─────────────────────────┬──────────────────────────┘         │
│                                        │                                    │
│                                        ▼                                    │
│              ┌────────────────────────────────────────────────────┐         │
│              │ Streamlit / Single-Page Web App UI                 │         │
│              └────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Non-Functional Requirements (Performance & Hardware Constraints)

| Parameter | Minimum Requirement | Target / Optimal |
| :--- | :--- | :--- |
| **CPU Target** | 4-Core x86_64 or Apple Silicon (M-Series) | 8-Core CPU with OpenMP support |
| **RAM Footprint** | $\le 2.0 \text{ GB}$ operational memory | $\le 1.2 \text{ GB}$ idle |
| **Throughput** | $\ge 5 \text{ images/sec}$ (CPU inference) | $\ge 15\text{–}25 \text{ images/sec}$ |
| **Storage Overhead** | $< 50 \text{ MB}$ engine database footprint | Index metadata footprint $< 5\%$ of total photo size |

---

## 4. Functional Specifications & Feature Requirements

### 4.1 Ingestion & Scanning Engine (`EPIC-1`)

* **`FR-1.1` Directory Traversal:** The system shall recursively search the user-configured container mount point (`/data/photos`) for supported formats (`.jpg`, `.jpeg`, `.png`, `.webp`, `.heic`).
* **`FR-1.2` Non-Destructive Operation:** Photos must be accessed exclusively in read-only mode (`:ro`). The engine must strictly perform no write, rename, or delete actions on target media files.
* **`FR-1.3` EXIF Orientation Correction:** All ingested photos must automatically apply EXIF rotation flags prior to running face detection algorithms.
* **`FR-1.4` Hash Indexing & De-duplication:** 
  * Calculate SHA-256 digests or fast BLAKE3 file checksums combined with file modification timestamps (`mtime`).
  * Skip re-inference for previously processed files on successive system boots or re-scans.

### 4.2 Face Detection & Embedding Engine (`EPIC-2`)

* **`FR-2.1` Face Detection:** Utilize `SCRFD` (Sample and Computation Redistribution for Face Detection) ONNX Runtime model to locate faces, producing normalized bounding boxes and facial landmark points.
* **`FR-2.2` Embedding Generation:** Crop and align detected faces, feeding them to `ArcFace` / `MobileFaceNet` to output 512-dimensional floating-point vectors ($v \in \mathbb{R}^{512}$).
* **`FR-2.3` Low-Quality Filtering:** Automatically reject detected face crops whose resolution falls below $48 \times 48 \text{ pixels}$ or whose confidence score is $< 0.5$.
* **`FR-2.4` Thumbnail Generation:** Crop and store a square $150 \times 150 \text{ pixel}$ JPEG avatar thumbnail for each valid face in persistent app storage.

### 4.3 Vector Storage & Clustering (`EPIC-3`)

* **`FR-3.1` Embedded Storage:** Persist image metadata, bounding box coordinates, file path mappings, and 512-dimensional vector blobs inside an embedded `SQLite` database utilizing the `sqlite-vec` extension.
* **`FR-3.2` Unsupervised Clustering:**
  * Run `DBSCAN` (or `HDBSCAN`) on normalized vector embeddings using **Cosine Distance**.
  * Default hyperparameters: Epsilon $\epsilon = 0.6$ (distance threshold), `min_samples` $= 3$.
  * Tag remaining vectors that fall below density limits as unclustered noise/outliers.
* **`FR-3.3` Incremental Clustering:** Allow the user to manually trigger a re-cluster process after new batches of photos complete ingestion.

### 4.4 Web User Interface (`EPIC-4`)

* **`FR-4.1` People Grid View:** Display discovered individuals as visual cards, ordered by total face counts.
* **`FR-4.2` Person Detail Gallery:** Clicking a person card opens a gallery displaying all photo thumbnails where that individual appears.
* **`FR-4.3` Bounding Box Overlay:** Opening a full-screen photo view draws vector bounding boxes around detected faces, highlighting the selected person.
* **`FR-4.4` Human-in-the-Loop Management:**
  * **Naming:** Allow assignation of custom names to cluster IDs.
  * **Merging:** Provide a mechanism to select two distinct person cards and merge them into a single cluster.
  * **Removal:** Allow users to remove incorrect face instances from a named cluster, marking them as unassigned or noise.

---

## 5. Data Model & Schema Design

```sql
-- Track processed images to prevent redundant inference
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    file_hash TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Track discovered faces and bounding boxes
CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id INTEGER NOT NULL,
    bbox_x1 REAL NOT NULL,
    bbox_y1 REAL NOT NULL,
    bbox_x2 REAL NOT NULL,
    bbox_y2 REAL NOT NULL,
    det_score REAL NOT NULL,
    thumbnail_path TEXT NOT NULL,
    cluster_id INTEGER REFERENCES clusters(id),
    FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
);

-- sqlite-vec extension table for 512-dim face embeddings
CREATE VIRTUAL TABLE IF NOT EXISTS face_vectors USING vec0(
    face_id INTEGER PRIMARY KEY,
    embedding float[512]
);

-- Cluster definitions mapping faces to people
CREATE TABLE IF NOT EXISTS clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_name TEXT,
    representative_face_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(representative_face_id) REFERENCES faces(id)
);
```

---

## 6. Milestone & Delivery Roadmap

```
Week 1 - Core Ingestion      Week 2 - Vector Pipeline     Week 3 - Clustering Engine   Week 4 - UI & Polish
┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
│ • Docker Compose Setup  │  │ • InsightFace ONNX Build│  │ • SQLite-vec integration│  │ • Web Interface (Web UI)│
│ • Directory Traversal   │──► • Bounding Box Engine   │──► • DBSCAN Clustering     │──► • Cluster Merge/Edit │
│ • SHA256 De-duplication │  │ • Vector Extraction     │  │ • Incremental Updates   │  │ • End-to-End Validation │
└─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
```

---

## 7. Metrics & Success Criteria

1. **Precision / Recall Metric:** Achieve $> 90\%$ clustering accuracy (evaluated on benchmark datasets like LFW) using default DBSCAN cosine settings.
2. **Setup Friction Metric:** User successfully initiates scanning with zero coding prerequisites beyond running a single `docker compose up` command.
3. **Zero Data Leakage:** $100\%$ verifiable block on outbound network requests confirmed via container firewall testing (`network_mode: bridge` without external routing).
