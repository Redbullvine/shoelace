const DB_NAME = "shoelace-db";
const DB_VERSION = 1;
const STORE_SCANS = "scans";
const STORE_QUEUE = "queue";
const STORE_DRAFT = "draft";

const page = document.body.dataset.page;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_SCANS)) {
        db.createObjectStore(STORE_SCANS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFT)) {
        db.createObjectStore(STORE_DRAFT, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

async function getDraft() {
  const result = await withStore(STORE_DRAFT, "readonly", (store) => store.get("draft"));
  return result instanceof IDBRequest ? result.result : result;
}

async function saveDraft(draft) {
  const record = { ...draft, id: "draft" };
  await withStore(STORE_DRAFT, "readwrite", (store) => store.put(record));
}

async function clearDraft() {
  await withStore(STORE_DRAFT, "readwrite", (store) => store.delete("draft"));
}

async function addScan(scan) {
  await withStore(STORE_SCANS, "readwrite", (store) => store.put(scan));
}

async function getScan(id) {
  const result = await withStore(STORE_SCANS, "readonly", (store) => store.get(id));
  return result instanceof IDBRequest ? result.result : result;
}

async function getAllScans() {
  const result = await withStore(STORE_SCANS, "readonly", (store) => store.getAll());
  return result instanceof IDBRequest ? result.result : result;
}

async function addQueueItem(item) {
  await withStore(STORE_QUEUE, "readwrite", (store) => store.put(item));
}

async function getQueueItems() {
  const result = await withStore(STORE_QUEUE, "readonly", (store) => store.getAll());
  return result instanceof IDBRequest ? result.result : result;
}

async function deleteQueueItem(id) {
  await withStore(STORE_QUEUE, "readwrite", (store) => store.delete(id));
}

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function updateStatus(el, text, tone = "") {
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

async function syncQueue() {
  const queueStatus = document.getElementById("queueStatus") || document.getElementById("syncStatus");
  if (!navigator.onLine) {
    updateStatus(queueStatus, "Offline - queued", "warning");
    return;
  }
  const items = await getQueueItems();
  if (!items.length) {
    updateStatus(queueStatus, "Queue idle", "good");
    return;
  }
  updateStatus(queueStatus, `Syncing ${items.length}...`, "info");
  for (const item of items) {
    try {
      const result = await postAnalyze(item.payload);
      result.status = computeStatus(result);
      const scan = await getScan(item.scanId);
      if (scan) {
        scan.result = result;
        scan.status = result.status;
        scan.syncedAt = new Date().toISOString();
        await addScan(scan);
      }
      await deleteQueueItem(item.id);
    } catch (error) {
      updateStatus(queueStatus, "Sync paused - check connection", "warning");
      return;
    }
  }
  updateStatus(queueStatus, "Queue synced", "good");
}

async function postAnalyze(payload) {
  const response = await fetch("/api/analyze-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Analyze failed");
  }
  return response.json();
}

function computeStatus(result) {
  const confidences = result.items.map((item) => item.confidence);
  const min = confidences.length ? Math.min(...confidences) : 0;
  if (min < 0.55) return "Needs Better Photo";
  if (min < 0.7) return "Needs Review";
  return "Ready";
}

function photoCard(photo) {
  return `
    <div class="photo-row" data-photo-id="${photo.id}">
      <img src="${photo.dataUrl}" alt="Captured label" />
      <div class="photo-fields">
        <div>
          <span class="badge">${photo.unreadable ? "Unreadable" : "Label"}</span>
        </div>
        <label class="label">Manual part # (optional)</label>
        <input class="input manual-part" value="${photo.manualPart || ""}" placeholder="e.g. ADC-1234" />
        <label class="label">Mark unreadable</label>
        <input type="checkbox" class="unreadable" ${photo.unreadable ? "checked" : ""} />
      </div>
    </div>
  `;
}

async function initNewScan() {
  const input = document.getElementById("photoInput");
  const thumbGrid = document.getElementById("thumbGrid");
  const clearBtn = document.getElementById("clearDraft");
  const toReview = document.getElementById("toReview");

  let draft = (await getDraft()) || { photos: [], locationTag: "", notes: "" };

  async function render() {
    draft = (await getDraft()) || { photos: [], locationTag: "", notes: "" };
    thumbGrid.innerHTML = draft.photos
      .map(
        (photo) => `
          <div class="thumb">
            <img src="${photo.dataUrl}" alt="Captured" />
            <button type="button" data-remove="${photo.id}">Remove</button>
          </div>
        `
      )
      .join("");
  }

  thumbGrid.addEventListener("click", async (event) => {
    if (event.target.matches("button[data-remove]")) {
      const id = event.target.dataset.remove;
      draft.photos = draft.photos.filter((photo) => photo.id !== id);
      await saveDraft(draft);
      await render();
    }
  });

  input.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const newPhotos = [];
    for (const file of files) {
      const dataUrl = await readFileAsDataUrl(file);
      newPhotos.push({
        id: uid("photo"),
        name: file.name,
        dataUrl,
        addedAt: new Date().toISOString(),
        manualPart: "",
        unreadable: false,
      });
    }
    draft.photos = [...draft.photos, ...newPhotos];
    await saveDraft(draft);
    input.value = "";
    await render();
  });

  clearBtn.addEventListener("click", async () => {
    await clearDraft();
    draft = { photos: [], locationTag: "", notes: "" };
    await render();
  });

  toReview.addEventListener("click", async () => {
    if (!draft.photos.length) {
      alert("Add at least one photo to continue.");
      return;
    }
    window.location.href = "review.html";
  });

  await render();
  updateStatus(document.getElementById("syncStatus"), navigator.onLine ? "Online" : "Offline - queued");
}

async function initReview() {
  const reviewPhotos = document.getElementById("reviewPhotos");
  const locationTagInput = document.getElementById("locationTag");
  const notesInput = document.getElementById("notes");
  const submitBtn = document.getElementById("submitScan");

  let draft = (await getDraft()) || { photos: [], locationTag: "", notes: "" };
  if (!draft.photos.length) {
    reviewPhotos.innerHTML = "<p>No draft photos found. Start a new scan.</p>";
    submitBtn.disabled = true;
    return;
  }

  locationTagInput.value = draft.locationTag || "";
  notesInput.value = draft.notes || "";

  reviewPhotos.innerHTML = draft.photos.map(photoCard).join("");

  reviewPhotos.addEventListener("input", async (event) => {
    const row = event.target.closest(".photo-row");
    if (!row) return;
    const photoId = row.dataset.photoId;
    const manualInput = row.querySelector(".manual-part");
    const unreadableInput = row.querySelector(".unreadable");
    draft.photos = draft.photos.map((photo) =>
      photo.id === photoId
        ? { ...photo, manualPart: manualInput.value.trim(), unreadable: unreadableInput.checked }
        : photo
    );
    await saveDraft({ ...draft, locationTag: locationTagInput.value.trim(), notes: notesInput.value.trim() });
  });

  locationTagInput.addEventListener("input", async () => {
    draft.locationTag = locationTagInput.value.trim();
    await saveDraft(draft);
  });

  notesInput.addEventListener("input", async () => {
    draft.notes = notesInput.value.trim();
    await saveDraft(draft);
  });

  submitBtn.addEventListener("click", async () => {
    draft = (await getDraft()) || draft;
    if (!draft.locationTag) {
      alert("Location tag is required.");
      return;
    }
    const scanId = uid("scan");
    const now = new Date().toISOString();
    const payload = {
      scanId,
      locationTag: draft.locationTag,
      notes: draft.notes,
      manualParts: draft.photos
        .filter((photo) => photo.manualPart)
        .map((photo) => photo.manualPart),
      photos: draft.photos.map((photo) => photo.dataUrl),
      photoCount: draft.photos.length,
    };

    const scan = {
      id: scanId,
      createdAt: now,
      locationTag: draft.locationTag,
      notes: draft.notes,
      photos: draft.photos,
      status: navigator.onLine ? "Analyzing" : "Queued",
      result: null,
    };

    await addScan(scan);
    await clearDraft();

    if (navigator.onLine) {
      try {
        const result = await postAnalyze(payload);
        result.status = computeStatus(result);
        scan.result = result;
        scan.status = result.status;
        scan.syncedAt = new Date().toISOString();
        await addScan(scan);
      } catch (error) {
        await addQueueItem({ id: uid("queue"), scanId, payload, createdAt: now });
        scan.status = "Queued";
        await addScan(scan);
      }
    } else {
      await addQueueItem({ id: uid("queue"), scanId, payload, createdAt: now });
    }

    window.location.href = `result.html?id=${scanId}`;
  });
}

async function initResult() {
  const params = new URLSearchParams(window.location.search);
  const scanId = params.get("id");
  const resultLocation = document.getElementById("resultLocation");
  const resultStatus = document.getElementById("resultStatus");
  const resultSummary = document.getElementById("resultSummary");
  const resultItems = document.getElementById("resultItems");
  const rawJson = document.getElementById("rawJson");
  const toggleRaw = document.getElementById("toggleRaw");

  if (!scanId) {
    resultSummary.textContent = "No scan selected.";
    return;
  }

  const scan = await getScan(scanId);
  if (!scan) {
    resultSummary.textContent = "Scan not found.";
    return;
  }

  resultLocation.textContent = `Location: ${scan.locationTag}`;
  resultStatus.textContent = scan.status;

  if (!scan.result) {
    resultSummary.innerHTML = `<p>Scan queued for analysis. We'll update when online.</p>`;
    resultItems.innerHTML = "";
    rawJson.textContent = JSON.stringify({ queued: true }, null, 2);
    toggleRaw.addEventListener("click", () => {
      rawJson.hidden = !rawJson.hidden;
    });
    return;
  }

  const result = scan.result;
  resultSummary.innerHTML = `
    <h3>Summary</h3>
    <p><strong>Overall confidence:</strong> ${(result.overallConfidence * 100).toFixed(0)}%</p>
    <p><strong>Sell first tags:</strong> ${result.sellFirstTags.join(", ")}</p>
    <p><strong>Suggested channels:</strong> ${result.suggestedChannels.join(", ")}</p>
  `;

  resultItems.innerHTML = `
    <h3>Items</h3>
    ${result.items
      .map(
        (item) => `
        <div class="list-item">
          <div>
            <div><strong>${item.part}</strong> - ${item.category}</div>
            <div>Qty est: ${item.qtyEstimate} | Confidence ${(item.confidence * 100).toFixed(0)}%</div>
          </div>
          <div>${item.priceRange}</div>
        </div>
      `
      )
      .join("")}
  `;

  rawJson.textContent = JSON.stringify(result, null, 2);
  toggleRaw.addEventListener("click", () => {
    rawJson.hidden = !rawJson.hidden;
  });
}

async function initSaved() {
  const list = document.getElementById("savedList");
  const exportBtn = document.getElementById("exportCsv");
  const syncBtn = document.getElementById("syncQueue");

  async function render() {
    const scans = (await getAllScans()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!scans.length) {
      list.innerHTML = "<p>No scans yet. Start a new scan.</p>";
      return;
    }
    list.innerHTML = scans
      .map(
        (scan) => `
          <div class="list-item">
            <div>
              <a href="result.html?id=${scan.id}">${scan.locationTag}</a>
              <div>${new Date(scan.createdAt).toLocaleString()}</div>
            </div>
            <div>${scan.status}</div>
          </div>
        `
      )
      .join("");
  }

  exportBtn.addEventListener("click", async () => {
    const scans = await getAllScans();
    const rows = [
      [
        "id",
        "createdAt",
        "locationTag",
        "notes",
        "status",
        "items",
        "sellFirstTags",
        "suggestedChannels",
      ],
    ];
    scans.forEach((scan) => {
      const items = scan.result?.items?.map((item) => `${item.part} (${item.qtyEstimate})`).join("; ") || "";
      rows.push([
        scan.id,
        scan.createdAt,
        scan.locationTag,
        scan.notes || "",
        scan.status,
        items,
        scan.result?.sellFirstTags?.join(";") || "",
        scan.result?.suggestedChannels?.join(";") || "",
      ]);
    });

    const csv = rows
      .map((row) =>
        row
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `shoelace-scans-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  syncBtn.addEventListener("click", async () => {
    await syncQueue();
    await render();
  });

  await render();
}

async function init() {
  window.addEventListener("online", syncQueue);
  if (["home", "new", "review", "saved", "result"].includes(page)) {
    await syncQueue();
  }

  if (page === "new") await initNewScan();
  if (page === "review") await initReview();
  if (page === "result") await initResult();
  if (page === "saved") await initSaved();
}

init();
