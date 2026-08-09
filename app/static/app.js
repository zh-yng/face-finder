const $ = (sel) => document.querySelector(sel);

const peopleView = $("#peopleView");
const galleryView = $("#galleryView");
const peopleGrid = $("#peopleGrid");
const peopleEmpty = $("#peopleEmpty");
const galleryGrid = $("#galleryGrid");
const scanStatusEl = $("#scanStatus");

let currentClusterId = null;
let peopleCache = [];
let scanPollTimer = null;

// ---------------------------------------------------------------- toast ---
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2600);
}

// ------------------------------------------------------------- API calls --
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

// ------------------------------------------------------------- scanning ---
$("#scanBtn").addEventListener("click", async () => {
  try {
    await api("/api/scan", { method: "POST" });
    pollScanStatus();
  } catch (e) {
    toast("Scan failed to start: " + e.message);
  }
});

$("#clusterBtn").addEventListener("click", async () => {
  $("#clusterBtn").disabled = true;
  try {
    const r = await api("/api/cluster", { method: "POST" });
    toast(`Re-clustered: ${r.clusters_created} people, ${r.faces_clustered} faces, ${r.noise} unclustered`);
    await loadPeople();
  } catch (e) {
    toast("Clustering failed: " + e.message);
  } finally {
    $("#clusterBtn").disabled = false;
  }
});

async function pollScanStatus() {
  clearInterval(scanPollTimer);
  scanPollTimer = setInterval(async () => {
    const s = await api("/api/scan/status");
    renderScanStatus(s);
    if (!s.running) {
      clearInterval(scanPollTimer);
      if (s.finished_at) {
        toast(`Scan complete: ${s.new_photos} new photos, ${s.faces_found} faces found`);
        loadPeople();
      }
    }
  }, 1200);
}

function renderScanStatus(s) {
  if (s.running) {
    scanStatusEl.className = "status-pill running";
    scanStatusEl.textContent = `scanning ${s.processed}/${s.total_found}`;
  } else if (s.errors > 0 && s.finished_at) {
    scanStatusEl.className = "status-pill error";
    scanStatusEl.textContent = `done, ${s.errors} error(s)`;
  } else if (s.finished_at) {
    scanStatusEl.className = "status-pill done";
    const ms = Math.round((s.finished_at - s.started_at) * 1000);
    scanStatusEl.textContent = `done in ${ms}ms`;
  } else {
    scanStatusEl.className = "status-pill idle";
    scanStatusEl.textContent = "idle";
  }
}

// --------------------------------------------------------------- people ---
async function loadPeople() {
  peopleCache = await api("/api/people");
  peopleGrid.innerHTML = "";
  peopleEmpty.classList.toggle("hidden", peopleCache.length > 0);
  for (const p of peopleCache) {
    const card = document.createElement("div");
    card.className = "person-card";
    card.innerHTML = `
      <span class="tab">#${p.id}</span>
      <img class="thumb" src="/api/thumbnail/${p.representative_face_id}" />
      <div class="meta">
        <div class="name ${p.person_name ? "" : "unnamed"}">${p.person_name || "Unnamed"}</div>
        <div class="count">${p.face_count} face${p.face_count === 1 ? "" : "s"}</div>
      </div>`;
    card.addEventListener("click", () => openGallery(p.id));
    peopleGrid.appendChild(card);
  }
}

// -------------------------------------------------------------- gallery ---
async function openGallery(clusterId) {
  currentClusterId = clusterId;
  const person = peopleCache.find((p) => p.id === clusterId);
  $("#nameInput").value = person?.person_name || "";
  peopleView.classList.add("hidden");
  galleryView.classList.remove("hidden");
  await refreshGallery();
}

async function refreshGallery() {
  const faces = await api(`/api/people/${currentClusterId}/faces`);
  galleryGrid.innerHTML = "";
  for (const f of faces) {
    const card = document.createElement("div");
    card.className = "face-card";
    card.innerHTML = `
      <img src="/api/thumbnail/${f.face_id}" />
      <button class="face-remove" title="Not this person / false detection">&times;</button>`;
    card.querySelector("img").addEventListener("click", () => openPhotoModal(f));
    card.querySelector(".face-remove").addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/faces/${f.face_id}/remove`, { method: "POST" });
      toast("Removed from cluster");
      refreshGallery();
    });
    galleryGrid.appendChild(card);
  }
}

$("#backBtn").addEventListener("click", () => {
  galleryView.classList.add("hidden");
  peopleView.classList.remove("hidden");
  loadPeople();
});

$("#saveNameBtn").addEventListener("click", async () => {
  const name = $("#nameInput").value.trim();
  await api(`/api/people/${currentClusterId}/rename`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  toast("Saved");
});

// --------------------------------------------------------------- merging --
$("#mergeModeBtn").addEventListener("click", async () => {
  const list = $("#mergeList");
  list.innerHTML = "";
  const others = peopleCache.filter((p) => p.id !== currentClusterId);
  if (others.length === 0) {
    list.innerHTML = `<p class="empty-sub">No other people to merge into.</p>`;
  }
  for (const p of others) {
    const row = document.createElement("div");
    row.className = "merge-row";
    row.innerHTML = `<img src="/api/thumbnail/${p.representative_face_id}" />
      <span>${p.person_name || "Unnamed"} · ${p.face_count} faces</span>`;
    row.addEventListener("click", async () => {
      await api("/api/people/merge", {
        method: "POST",
        body: JSON.stringify({ source_id: currentClusterId, target_id: p.id }),
      });
      toast("Merged");
      $("#mergeModal").classList.add("hidden");
      galleryView.classList.add("hidden");
      peopleView.classList.remove("hidden");
      await loadPeople();
    });
    list.appendChild(row);
  }
  $("#mergeModal").classList.remove("hidden");
});
$("#closeMergeModal").addEventListener("click", () => $("#mergeModal").classList.add("hidden"));

// ------------------------------------------------------------ photo view --
async function openPhotoModal(face) {
  const detail = await api(`/api/photos/${face.photo_id}`);
  const img = $("#modalImg");
  img.src = `/api/image?path=${encodeURIComponent(detail.photo.file_path)}`;
  $("#modalFaceInfo").textContent = detail.photo.file_path;

  img.onload = () => drawBoxes(detail);
  $("#photoModal").classList.remove("hidden");
}

function drawBoxes(detail) {
  const img = $("#modalImg");
  const svg = $("#bboxLayer");
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${detail.photo.width} ${detail.photo.height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  for (const f of detail.faces) {
    const isCurrent = f.cluster_id === currentClusterId;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", f.bbox_x1);
    rect.setAttribute("y", f.bbox_y1);
    rect.setAttribute("width", f.bbox_x2 - f.bbox_x1);
    rect.setAttribute("height", f.bbox_y2 - f.bbox_y1);
    rect.setAttribute("fill", "none");
    rect.setAttribute("stroke", isCurrent ? "#e8a33d" : "#5a5f6a");
    rect.setAttribute("stroke-width", isCurrent ? 4 : 2);
    svg.appendChild(rect);

    if (f.person_name) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", f.bbox_x1);
      label.setAttribute("y", Math.max(f.bbox_y1 - 8, 12));
      label.setAttribute("fill", isCurrent ? "#e8a33d" : "#9a9ea8");
      label.setAttribute("font-size", "18");
      label.textContent = f.person_name;
      svg.appendChild(label);
    }
  }
}

$("#closeModal").addEventListener("click", () => $("#photoModal").classList.add("hidden"));
$("#photoModal").querySelector(".modal-backdrop").addEventListener("click", () => {
  $("#photoModal").classList.add("hidden");
});
$("#mergeModal").querySelector(".modal-backdrop").addEventListener("click", () => {
  $("#mergeModal").classList.add("hidden");
});

// ------------------------------------------------------------------ init --
(async function init() {
  const s = await api("/api/scan/status");
  renderScanStatus(s);
  if (s.running) pollScanStatus();
  await loadPeople();
})();
