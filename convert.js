// Image to EPS page: uploads one image to the convert-to-eps Netlify function
// and shows the traced result next to the original.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_SIDE = 3000;

const els = {
  input: document.getElementById("imageInput"),
  dropzone: document.getElementById("dropzone"),
  convertBtn: document.getElementById("convertBtn"),
  status: document.getElementById("convertStatus"),
  results: document.getElementById("results"),
  original: document.getElementById("originalPreview"),
  vector: document.getElementById("vectorPreview"),
  downloadCard: document.getElementById("downloadCard"),
  downloadBtn: document.getElementById("downloadBtn"),
  emailBtn: document.getElementById("emailBtn"),
  swatches: document.getElementById("swatches"),
  meta: document.getElementById("resultMeta"),
  colors: document.getElementById("colors"),
  detail: document.getElementById("detail"),
  smoothness: document.getElementById("smoothness"),
  layering: document.getElementById("layering"),
  removeBackground: document.getElementById("removeBackground"),
};

let currentFile = null;
let downloadUrl = null;
let lastResult = null;

function setStatus(text, tone = "") {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file is not an image the browser can open."));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Netlify functions accept about 6 MB per request, so very large photos are
// scaled down in the browser first. PNG keeps edges crisp; JPEG is the fallback.
async function prepareUpload(file) {
  if (file.size <= MAX_UPLOAD_BYTES) return file;
  const { img, url } = await loadImage(file);
  const ratio = Math.min(1, MAX_UPLOAD_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * ratio);
  canvas.height = Math.round(img.naturalHeight * ratio);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  const png = await canvasToBlob(canvas, "image/png");
  if (png && png.size <= MAX_UPLOAD_BYTES) return png;
  return canvasToBlob(canvas, "image/jpeg", 0.92);
}

async function selectFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setStatus("Please choose an image file", "warning");
    return;
  }
  currentFile = file;
  if (els.original.src) URL.revokeObjectURL(els.original.src);
  els.original.src = URL.createObjectURL(file);
  els.vector.innerHTML = "";
  els.results.hidden = false;
  els.downloadCard.hidden = true;
  els.convertBtn.disabled = false;
  setStatus(file.name);
}

async function convert() {
  if (!currentFile) return;
  els.convertBtn.disabled = true;
  setStatus("Converting...", "info");
  try {
    const body = await prepareUpload(currentFile);
    const params = new URLSearchParams({
      name: currentFile.name,
      colors: els.colors.value,
      detail: els.detail.value,
      smoothness: els.smoothness.value,
      layering: els.layering.value,
      removeBackground: String(els.removeBackground.checked),
    });
    const response = await fetch(`/api/convert-to-eps?${params}`, {
      method: "POST",
      headers: { "Content-Type": body.type || "application/octet-stream" },
      body,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || (response.status === 502 || response.status === 504
        ? "The conversion took too long. Try a lower detail level or fewer colors."
        : "Conversion failed. Please try again."));
    }
    showResult(data);
    setStatus("Done", "good");
  } catch (error) {
    setStatus(error.message, "warning");
  } finally {
    els.convertBtn.disabled = false;
  }
}

function showResult(data) {
  lastResult = data;
  els.emailBtn.disabled = false;
  els.emailBtn.textContent = "Email EPS to justsayin@peoplescom.net";
  els.vector.innerHTML = data.svg || "<p class=\"hint\">Preview too large to show. The EPS is ready to download.</p>";
  els.swatches.innerHTML = data.colors
    .map(
      (color) => `
        <div class="swatch">
          <span class="chip" style="background:${color.hex}"></span>
          <span>${color.hex.toUpperCase()}</span>
          <span class="hint">${(color.area * 100).toFixed(1)}%</span>
        </div>
      `
    )
    .join("");
  els.meta.textContent = `${data.colors.length} color${data.colors.length === 1 ? "" : "s"}, ${data.width} x ${data.height} pt` +
    (data.backgroundRemoved ? ", background removed" : "");

  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([data.eps], { type: "application/postscript" }));
  els.downloadBtn.href = downloadUrl;
  els.downloadBtn.download = data.fileName;
  els.downloadCard.hidden = false;
}

async function emailEps() {
  if (!lastResult) return;
  els.emailBtn.disabled = true;
  els.emailBtn.textContent = "Sending...";
  try {
    const response = await fetch("/api/email-eps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: lastResult.fileName,
        eps: lastResult.eps,
        colors: lastResult.colors.map((color) => color.hex),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Email failed. Please try again.");
    els.emailBtn.textContent = `Sent to ${data.sentTo}`;
    setStatus("Emailed", "good");
  } catch (error) {
    els.emailBtn.disabled = false;
    els.emailBtn.textContent = "Email EPS to justsayin@peoplescom.net";
    setStatus(error.message, "warning");
  }
}

els.emailBtn.addEventListener("click", emailEps);
els.input.addEventListener("change", (event) => selectFile(event.target.files[0]));
els.convertBtn.addEventListener("click", convert);

["dragenter", "dragover"].forEach((type) =>
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("dragging");
  })
);
["dragleave", "drop"].forEach((type) =>
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("dragging");
  })
);
els.dropzone.addEventListener("drop", (event) => selectFile(event.dataTransfer.files[0]));
