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
let togetherSelected = new Set();
let togetherActive = false;

// ---------------------------------------------------------------- views ---
function switchView(toHide, toShow) {
  toHide.classList.add("view-fade-out");
  setTimeout(() => {
    toHide.classList.add("hidden");
    toHide.classList.remove("view-fade-out");
    toShow.classList.remove("hidden");
    toShow.classList.add("view-fade-out");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toShow.classList.remove("view-fade-out"));
    });
  }, 180);
}

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
      <div class="thumb-stack">
        <img class="thumb thumb-1" src="/api/thumbnail/${p.representative_face_id}" />
      </div>
      <div class="meta">
        <div class="name ${p.person_name ? "" : "unnamed"}">${p.person_name || "Unnamed"}</div>
        <div class="count">${p.face_count} face${p.face_count === 1 ? "" : "s"}</div>
      </div>`;
    card.addEventListener("click", () => openGallery(p.id));
    card.addEventListener("mouseenter", () => loadFanThumbs(p, card), { once: true });
    peopleGrid.appendChild(card);
  }
}

// fan out up to 3 face thumbs on hover
async function loadFanThumbs(person, card) {
  try {
    const faces = await api(`/api/people/${person.id}/faces`);
    const stack = card.querySelector(".thumb-stack");
    const extras = faces
      .map((f) => f.face_id)
      .filter((id) => id !== person.representative_face_id)
      .slice(0, 2);
    extras.forEach((faceId, i) => {
      const img = document.createElement("img");
      img.className = `thumb thumb-${i + 2}`;
      img.src = `/api/thumbnail/${faceId}`;
      stack.appendChild(img);
    });
  } catch (e) {
    // silent — fan-out is decorative, card still works without it
  }
}

// -------------------------------------------------------------- gallery ---
async function openGallery(clusterId) {
  currentClusterId = clusterId;
  togetherSelected = new Set();
  togetherActive = false;
  $("#togetherPanel").classList.add("hidden");
  $("#togetherActiveBar").classList.add("hidden");
  const person = peopleCache.find((p) => p.id === clusterId);
  $("#nameInput").value = person?.person_name || "";
  switchView(peopleView, galleryView);
  await refreshGallery();
}

async function refreshGallery() {
  if (togetherActive) {
    await refreshTogetherResults();
    return;
  }
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

// ------------------------------------------------------- find together ---
$("#togetherBtn").addEventListener("click", () => {
  const panel = $("#togetherPanel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) renderTogetherOptions();
});
$("#closeTogetherPanel").addEventListener("click", () => {
  $("#togetherPanel").classList.add("hidden");
});

function renderTogetherOptions() {
  const list = $("#togetherList");
  list.innerHTML = "";
  const others = peopleCache.filter((p) => p.id !== currentClusterId);
  if (others.length === 0) {
    list.innerHTML = `<p class="empty-sub">No other people to filter by yet.</p>`;
    return;
  }
  for (const p of others) {
    const chip = document.createElement("div");
    chip.className = "together-option" + (togetherSelected.has(p.id) ? " selected" : "");
    chip.innerHTML = `
      <img src="/api/thumbnail/${p.representative_face_id}" />
      <span>${p.person_name || "Unnamed"}</span>`;
    chip.addEventListener("click", () => {
      if (togetherSelected.has(p.id)) togetherSelected.delete(p.id);
      else togetherSelected.add(p.id);
      chip.classList.toggle("selected");
    });
    list.appendChild(chip);
  }
}

$("#applyTogetherBtn").addEventListener("click", async () => {
  if (togetherSelected.size === 0) {
    toast("Pick at least one other person first");
    return;
  }
  togetherActive = true;
  $("#togetherPanel").classList.add("hidden");
  const names = [...togetherSelected]
    .map((id) => peopleCache.find((p) => p.id === id)?.person_name || "Unnamed")
    .join(", ");
  $("#togetherActiveLabel").textContent = `Showing photos with this person + ${names}`;
  $("#togetherActiveBar").classList.remove("hidden");
  await refreshGallery();
});

function clearTogetherFilter() {
  togetherActive = false;
  togetherSelected = new Set();
  $("#togetherActiveBar").classList.add("hidden");
  refreshGallery();
}
$("#clearTogetherBtn").addEventListener("click", clearTogetherFilter);
$("#clearTogetherBar").addEventListener("click", clearTogetherFilter);

async function refreshTogetherResults() {
  const ids = [currentClusterId, ...togetherSelected].join(",");
  galleryGrid.innerHTML = "";
  let results;
  try {
    results = await api(`/api/photos/intersect?cluster_ids=${ids}`);
  } catch (e) {
    toast("Filter failed: " + e.message);
    return;
  }
  if (results.length === 0) {
    galleryGrid.innerHTML = `<p class="empty-sub">No photos found with everyone selected together.</p>`;
    return;
  }
  for (const r of results) {
    const face = r.faces.find((f) => f.cluster_id === currentClusterId) || r.faces[0];
    const card = document.createElement("div");
    card.className = "face-card";
    card.innerHTML = `<img src="/api/thumbnail/${face.face_id}" />`;
    card.querySelector("img").addEventListener("click", () => openPhotoModal(face));
    galleryGrid.appendChild(card);
  }
}

$("#backBtn").addEventListener("click", () => {
  switchView(galleryView, peopleView);
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
      switchView(galleryView, peopleView);
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
    rect.setAttribute("stroke", isCurrent ? "#e2963f" : "#6f6152");
    rect.setAttribute("stroke-width", isCurrent ? 4 : 2);
    svg.appendChild(rect);

    if (f.person_name) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", f.bbox_x1);
      label.setAttribute("y", Math.max(f.bbox_y1 - 8, 12));
      label.setAttribute("fill", isCurrent ? "#e2963f" : "#a8967d");
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
