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
  progress: document.getElementById("progress"),
  progressFill: document.getElementById("progressFill"),
  progressLabel: document.getElementById("progressLabel"),
  detailsCard: document.getElementById("detailsCard"),
  details: document.getElementById("details"),
  fonts: document.getElementById("fonts"),
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
let progressTimer = null;

// Status bar between the panels: red while the image uploads, yellow while
// the server traces it, green when the EPS is ready. The server doesn't report
// progress, so the yellow phase creeps toward 90% until the answer arrives.
// The truck drives from the left edge (0%) to the right edge (100%), and the
// purple road behind it fills in as it goes.
function moveTruck(percent) {
  els.progress.style.setProperty("--p", percent / 100);
  els.progressFill.style.width = `${percent}%`;
}

function setProgress(state, label, percent) {
  clearInterval(progressTimer);
  els.progress.dataset.state = state;
  els.progressLabel.textContent = label;
  if (percent != null) moveTruck(percent);
  if (state === "converting") {
    let current = percent;
    progressTimer = setInterval(() => {
      current += (90 - current) * 0.08;
      moveTruck(current);
    }, 300);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The browser can't show EPS, so rebuild the drawing as SVG from the EPS this
// tool writes (setrgbcolor / moveto / curveto / lineto / closepath / fill).
// Also counts shapes and curves for the detail summary.
function epsToSvg(eps) {
  const box = eps.match(/%%HiResBoundingBox: [\d.]+ [\d.]+ ([\d.]+) ([\d.]+)/) || eps.match(/%%BoundingBox: \d+ \d+ (\d+) (\d+)/);
  const width = Number(box[1]);
  const height = Number(box[2]);
  const y = (v) => (height - Number(v)).toFixed(2);
  const paths = [];
  let fill = "#000";
  let d = [];
  const stats = { shapes: 0, curves: 0, lines: 0 };
  for (const line of eps.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const op = parts[parts.length - 1];
    if (op === "setrgbcolor") {
      fill = "#" + parts.slice(0, 3).map((v) => Math.round(Number(v) * 255).toString(16).padStart(2, "0")).join("");
    } else if (op === "moveto") {
      d.push(`M${parts[0]} ${y(parts[1])}`);
      stats.shapes++;
    } else if (op === "lineto") {
      d.push(`L${parts[0]} ${y(parts[1])}`);
      stats.lines++;
    } else if (op === "curveto") {
      d.push(`C${parts[0]} ${y(parts[1])} ${parts[2]} ${y(parts[3])} ${parts[4]} ${y(parts[5])}`);
      stats.curves++;
    } else if (op === "closepath") {
      d.push("Z");
    } else if (op === "fill" && d.length) {
      paths.push(`<path fill="${fill}" d="${d.join("")}"/>`);
      d = [];
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${paths.join("")}</svg>`;
  return { svg, width, height, stats };
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Small JPEG of the original for font identification.
async function imageForFontCheck(file) {
  const { img, url } = await loadImage(file);
  const ratio = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * ratio);
  canvas.height = Math.round(img.naturalHeight * ratio);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  return canvas.toDataURL("image/jpeg", 0.9);
}

async function identifyFonts(file) {
  try {
    const image = await imageForFontCheck(file);
    const response = await fetch("/api/describe-artwork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Couldn't identify the fonts right now.");
    return data;
  } catch (error) {
    return { error: error.message };
  }
}

function renderFonts(data) {
  if (data.error) {
    els.fonts.innerHTML = `<p class="hint">${escapeHtml(data.error)}</p>`;
    return;
  }
  const intro = data.description ? `<p>${escapeHtml(data.description)}</p>` : "";
  if (!data.fonts.length) {
    els.fonts.innerHTML = intro + "<p class=\"hint\">No lettering found.</p>";
    return;
  }
  els.fonts.innerHTML =
    intro +
    data.fonts
      .map((f) => {
        const extra = [f.style, f.weight, f.effects].filter(Boolean).map(escapeHtml).join(", ");
        const alts = f.alternatives.length ? `<div class="hint">Similar: ${f.alternatives.map(escapeHtml).join(", ")}</div>` : "";
        return `
          <div class="font-row">
            <div>"${escapeHtml(f.text)}"</div>
            <div><span class="font-name">${escapeHtml(f.font || "Unknown")}</span> <span class="hint">(${escapeHtml(f.confidence)} confidence)</span></div>
            ${extra ? `<div class="hint">${extra}</div>` : ""}
            ${alts}
          </div>`;
      })
      .join("");
}

function renderDetails(data, drawing) {
  const label = (select) => select.options[select.selectedIndex].text;
  const inches = (pt) => (pt / 72).toFixed(2);
  const rows = [
    ["File", `${escapeHtml(data.fileName)} (${formatBytes(new Blob([data.eps]).size)})`],
    ["Format", "EPS (Encapsulated PostScript 3.0), 100% vector, no embedded image"],
    ["Size", `${Math.round(drawing.width)} x ${Math.round(drawing.height)} pt (${inches(drawing.width)} x ${inches(drawing.height)} in at 72 dpi; scales to any size)`],
    ["Colors", `${data.colors.length} solid RGB fills`],
    ["Shapes", `${drawing.stats.shapes.toLocaleString()} closed outlines`],
    ["Curves", `${drawing.stats.curves.toLocaleString()} Bezier curves, ${drawing.stats.lines.toLocaleString()} straight segments`],
    ["Settings", `${label(els.colors)} colors, ${label(els.detail)}, ${label(els.smoothness)}, ${label(els.layering)}`],
    ["Background", data.backgroundRemoved ? "Removed (transparent)" : "Kept"],
  ];
  els.details.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  els.detailsCard.hidden = false;
}

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
  els.detailsCard.hidden = true;
  els.convertBtn.disabled = false;
  setProgress("idle", "Ready to convert", 0);
  setStatus(file.name);
}

async function convert() {
  if (!currentFile) return;
  els.convertBtn.disabled = true;
  setStatus("Converting...", "info");
  els.vector.innerHTML = "";
  els.downloadCard.hidden = true;
  els.detailsCard.hidden = true;
  els.fonts.innerHTML = "<p class=\"hint\">Identifying fonts...</p>";
  setProgress("uploading", "Uploading image...", 8);
  const fontsPromise = identifyFonts(currentFile);
  try {
    const body = await prepareUpload(currentFile);
    const toConverting = setTimeout(() => setProgress("converting", "Converting to vector...", 30), 700);
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
    clearTimeout(toConverting);
    if (els.progress.dataset.state !== "converting") setProgress("converting", "Converting to vector...", 60);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || (response.status === 502 || response.status === 504
        ? "The conversion took too long. Try a lower detail level or fewer colors."
        : "Conversion failed. Please try again."));
    }
    showResult(data);
    setProgress("done", "Done! Your EPS is ready", 100);
    setStatus("Done", "good");
    fontsPromise.then(renderFonts);
  } catch (error) {
    setProgress("error", error.message, null);
    setStatus(error.message, "warning");
  } finally {
    els.convertBtn.disabled = false;
  }
}

function showResult(data) {
  lastResult = data;
  els.emailBtn.disabled = false;
  els.emailBtn.textContent = "Email EPS to justsayin@peoplescom.net";
  const drawing = epsToSvg(data.eps);
  els.vector.innerHTML = drawing.svg;
  renderDetails(data, drawing);
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
