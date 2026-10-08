// Raster-to-vector pipeline: decode -> resample -> color quantize (OKLab k-means)
// -> clean up anti-aliasing and speckles -> trace each color layer with Potrace.
const sharp = require("sharp");
const Potrace = require("potrace/lib/Potrace");
const Bitmap = require("potrace/lib/types/Bitmap");

const NONE = 255;

const DETAIL_PRESETS = {
  low: { workSize: 1000, minRegion: 0.0004, turdSize: 8, optTolerance: 0.4 },
  medium: { workSize: 1400, minRegion: 0.00012, turdSize: 4, optTolerance: 0.2 },
  high: { workSize: 1600, minRegion: 0.00003, turdSize: 2, optTolerance: 0.1 },
};

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToOklab(r, g, b) {
  const lr = SRGB_TO_LINEAR[r];
  const lg = SRGB_TO_LINEAR[g];
  const lb = SRGB_TO_LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function dist2(a, b) {
  const d0 = a[0] - b[0];
  const d1 = a[1] - b[1];
  const d2 = a[2] - b[2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

// Deterministic PRNG so the same image always produces the same vector.
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function kmeans(samples, k, rand) {
  const n = samples.length;
  if (n === 0) return [];
  k = Math.min(k, n);

  // k-means++ seeding
  const centers = [samples[Math.floor(rand() * n)].slice()];
  const d = new Float64Array(n).fill(Infinity);
  while (centers.length < k) {
    const last = centers[centers.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dd = dist2(samples[i], last);
      if (dd < d[i]) d[i] = dd;
      total += d[i];
    }
    if (total === 0) break;
    let target = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= d[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centers.push(samples[pick].slice());
  }

  const assign = new Int32Array(n);
  for (let iter = 0; iter < 20; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dd = dist2(samples[i], centers[c]);
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      if (assign[i] !== best) moved++;
      assign[i] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const s = sums[assign[i]];
      s[0] += samples[i][0];
      s[1] += samples[i][1];
      s[2] += samples[i][2];
      s[3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3]) centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
    if (iter > 0 && moved < n * 0.001) break;
  }

  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;
  return centers.map((c, i) => ({ lab: c, weight: counts[i] })).filter((c) => c.weight > 0);
}

// Repeatedly merge the closest pair of clusters while they are closer than
// `threshold` (OKLab distance) or while there are more than `maxColors`.
function mergeClusters(clusters, threshold, maxColors) {
  clusters = clusters.map((c) => ({ ...c }));
  const t2 = threshold * threshold;
  for (;;) {
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const dd = dist2(clusters[i].lab, clusters[j].lab);
        if (dd < bd) {
          bd = dd;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0 || (bd >= t2 && clusters.length <= maxColors)) break;
    const a = clusters[bi];
    const b = clusters[bj];
    const w = a.weight + b.weight;
    a.lab = [0, 1, 2].map((k) => (a.lab[k] * a.weight + b.lab[k] * b.weight) / w);
    a.weight = w;
    clusters.splice(bj, 1);
  }
  return clusters;
}

// Squared distance from a color to the closest palette color or to the closest
// blend of two palette colors (what anti-aliasing between them produces).
function mixError(p, clusters) {
  let best = Infinity;
  for (let a = 0; a < clusters.length; a++) {
    const A = clusters[a].lab;
    const d = dist2(p, A);
    if (d < best) best = d;
    for (let b = a + 1; b < clusters.length; b++) {
      const B = clusters[b].lab;
      const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
      if (!len2) continue;
      let t = ((p[0] - A[0]) * ab[0] + (p[1] - A[1]) * ab[1] + (p[2] - A[2]) * ab[2]) / len2;
      t = Math.max(0, Math.min(1, t));
      const dd = dist2(p, [A[0] + ab[0] * t, A[1] + ab[1] * t, A[2] + ab[2] * t]);
      if (dd < best) best = dd;
    }
  }
  return best;
}

function assignLabels(lab, opaque, centers) {
  const n = opaque.length;
  const labels = new Uint8Array(n).fill(NONE);
  const cache = new Map();
  for (let i = 0; i < n; i++) {
    if (!opaque[i]) continue;
    const key = lab.keys[i];
    let best = cache.get(key);
    if (best === undefined) {
      const p = [lab.L[i], lab.A[i], lab.B[i]];
      let bestD = Infinity;
      best = 0;
      for (let c = 0; c < centers.length; c++) {
        const dd = dist2(p, centers[c]);
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      cache.set(key, best);
    }
    labels[i] = best;
  }
  return labels;
}

// A pixel is "flat" when it matches its neighbors one source pixel away
// (`offset` working pixels, since small images are upscaled). Anti-aliased edges
// and blur are not flat; their in-between colors must not become design colors.
function findFlatPixels(lab, opaque, width, height, threshold, offset) {
  const n = width * height;
  const flat = new Uint8Array(n);
  const t2 = threshold * threshold;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!opaque[i]) continue;
      let ok = 1;
      for (let dy = -offset; dy <= offset && ok; dy += offset) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -offset; dx <= offset; dx += offset) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (!opaque[j]) continue;
          const d0 = lab.L[i] - lab.L[j];
          const d1 = lab.A[i] - lab.A[j];
          const d2 = lab.B[i] - lab.B[j];
          if (d0 * d0 + d1 * d1 + d2 * d2 > t2) {
            ok = 0;
            break;
          }
        }
      }
      flat[i] = ok;
    }
  }
  return flat;
}

// Label edge pixels using only the colors of flat regions within `reach`
// pixels, so the band between red and white splits cleanly at its midpoint
// (red or white) instead of turning pink or orange.
function labelEdgesFromRegions(labels, flat, lab, opaque, centers, width, height, reach) {
  const n = width * height;
  const cand = new Uint32Array(n);
  // Colors that only occur in thin details have no flat pixels; they are
  // always allowed.
  let always = 0;
  const flatCounts = new Array(centers.length).fill(0);
  for (let i = 0; i < n; i++) if (flat[i]) flatCounts[labels[i]]++;
  for (let c = 0; c < centers.length; c++) if (flatCounts[c] < 20) always = (always | (1 << c)) >>> 0;
  for (let c = 0; c < centers.length; c++) {
    const own = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (flat[i] && labels[i] === c) {
        own[i] = 1;
        any = true;
      }
    }
    if (!any) continue;
    const near = dilate(own, width, height, reach);
    const bit = (1 << c) >>> 0;
    for (let i = 0; i < n; i++) if (near[i]) cand[i] = (cand[i] | bit) >>> 0;
  }
  for (let i = 0; i < n; i++) {
    if (!opaque[i] || flat[i]) continue;
    const mask = (cand[i] | always) >>> 0 || 0xffffffff;
    const p = [lab.L[i], lab.A[i], lab.B[i]];
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < centers.length; c++) {
      if (!((mask >>> c) & 1)) continue;
      const dd = dist2(p, centers[c]);
      if (dd < bestD) {
        bestD = dd;
        best = c;
      }
    }
    labels[i] = best;
  }
  return labels;
}

// 3x3 majority filter: smooths jagged single-pixel noise along edges.
function majorityFilter(labels, width, height) {
  const out = new Uint8Array(labels);
  const counts = new Uint8Array(256);
  const seen = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      seen.length = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const l = labels[i + dy * width + dx];
          if (counts[l]++ === 0) seen.push(l);
        }
      }
      let best = labels[i];
      let bestCount = counts[best];
      for (const l of seen) {
        if (counts[l] > bestCount) {
          best = l;
          bestCount = counts[l];
        }
        counts[l] = 0;
      }
      if (bestCount >= 5) out[i] = best;
    }
  }
  return out;
}

// Merge connected regions smaller than minArea into the neighbor color they
// touch most, so JPEG noise and specks don't become tiny vector islands.
function removeSmallRegions(labels, width, height, minArea) {
  const n = width * height;
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const region = [];
  let compId = 0;
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1) continue;
    const l = labels[start];
    let sp = 0;
    stack[sp++] = start;
    comp[start] = compId;
    region.length = 0;
    const neighborCounts = new Map();
    while (sp) {
      const i = stack[--sp];
      region.push(i);
      const x = i % width;
      const nbrs = [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        i >= width ? i - width : -1,
        i < n - width ? i + width : -1,
      ];
      for (const j of nbrs) {
        if (j < 0) continue;
        if (labels[j] === l) {
          if (comp[j] === -1) {
            comp[j] = compId;
            stack[sp++] = j;
          }
        } else {
          neighborCounts.set(labels[j], (neighborCounts.get(labels[j]) || 0) + 1);
        }
      }
    }
    if (region.length < minArea && neighborCounts.size) {
      let best = l;
      let bestCount = -1;
      for (const [nl, count] of neighborCounts) {
        if (count > bestCount) {
          best = nl;
          bestCount = count;
        }
      }
      for (const i of region) labels[i] = best;
    }
    compId++;
  }
  return labels;
}

// After cleanup, two labels can end up describing the same visible color
// (e.g. JPEG noise split one black into two). Fold them together.
function mergeSimilarLabels(labels, lab, count, threshold) {
  const sums = Array.from({ length: count }, () => [0, 0, 0, 0]);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l === NONE) continue;
    sums[l][0] += lab.L[i];
    sums[l][1] += lab.A[i];
    sums[l][2] += lab.B[i];
    sums[l][3]++;
  }
  const clusters = sums
    .map((s, index) => ({ index, members: [index], weight: s[3], lab: [s[0] / s[3], s[1] / s[3], s[2] / s[3]] }))
    .filter((c) => c.weight > 0);
  const t2 = threshold * threshold;
  for (;;) {
    let bi = -1;
    let bj = -1;
    let bd = t2;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const dd = dist2(clusters[i].lab, clusters[j].lab);
        if (dd < bd) {
          bd = dd;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0) break;
    const a = clusters[bi];
    const b = clusters[bj];
    const w = a.weight + b.weight;
    a.lab = [0, 1, 2].map((k) => (a.lab[k] * a.weight + b.lab[k] * b.weight) / w);
    a.weight = w;
    a.members.push(...b.members);
    clusters.splice(bj, 1);
  }
  const remap = new Uint8Array(256).map((_, i) => i);
  for (const c of clusters) for (const m of c.members) remap[m] = c.index;
  for (let i = 0; i < labels.length; i++) labels[i] = remap[labels[i]];
}

// The background is the color covering most of the image border. Only the
// part of it connected to the border is removed, so same-colored areas inside
// the design (the white of an "O", a white ring) are kept.
function removeBackgroundRegion(labels, width, height) {
  const counts = new Map();
  let total = 0;
  const border = [];
  for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
  for (const i of border) {
    counts.set(labels[i], (counts.get(labels[i]) || 0) + 1);
    total++;
  }
  let bg = NONE;
  let bgCount = 0;
  for (const [l, c] of counts) {
    if (l !== NONE && c > bgCount) {
      bg = l;
      bgCount = c;
    }
  }
  if (bg === NONE || bgCount / total < 0.6) return false;

  const n = width * height;
  const stack = new Int32Array(n);
  let sp = 0;
  for (const i of border) {
    if (labels[i] === bg) {
      labels[i] = NONE;
      stack[sp++] = i;
    }
  }
  while (sp) {
    const i = stack[--sp];
    const x = i % width;
    if (x > 0 && labels[i - 1] === bg) (labels[i - 1] = NONE), (stack[sp++] = i - 1);
    if (x < width - 1 && labels[i + 1] === bg) (labels[i + 1] = NONE), (stack[sp++] = i + 1);
    if (i >= width && labels[i - width] === bg) (labels[i - width] = NONE), (stack[sp++] = i - width);
    if (i < n - width && labels[i + width] === bg) (labels[i + width] = NONE), (stack[sp++] = i + width);
  }
  return true;
}

// Square dilation by `radius` pixels (separable running max).
function dilate(mask, width, height, radius) {
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let last = -Infinity;
    for (let x = 0; x < width + radius; x++) {
      if (x < width && mask[row + x]) last = x;
      const t = x - radius;
      if (t >= 0 && t < width && x - last <= 2 * radius) tmp[row + t] = 1;
    }
  }
  for (let x = 0; x < width; x++) {
    let last = -Infinity;
    for (let y = 0; y < height + radius; y++) {
      if (y < height && tmp[y * width + x]) last = y;
      const t = y - radius;
      if (t >= 0 && t < height && y - last <= 2 * radius) out[t * width + x] = 1;
    }
  }
  return out;
}

function tracePaths(mask, width, height, preset, smoothness) {
  const bitmap = new Bitmap(width, height);
  for (let i = 0; i < mask.length; i++) bitmap.data[i] = mask[i] ? 0 : 255;
  const potrace = new Potrace({
    turdSize: preset.turdSize,
    alphaMax: smoothness,
    optCurve: true,
    optTolerance: preset.optTolerance,
    threshold: 128,
    blackOnWhite: true,
  });
  potrace._luminanceData = bitmap;
  potrace._imageLoaded = true;
  potrace._bmToPathlist();
  potrace._processPath();
  return potrace._pathlist.map((path) => {
    const curve = path.curve;
    const start = curve.c[(curve.n - 1) * 3 + 2];
    const segments = [];
    for (let i = 0; i < curve.n; i++) {
      const c0 = curve.c[i * 3];
      const c1 = curve.c[i * 3 + 1];
      const c2 = curve.c[i * 3 + 2];
      if (curve.tag[i] === "CURVE") {
        segments.push({ type: "C", points: [[c0.x, c0.y], [c1.x, c1.y], [c2.x, c2.y]] });
      } else {
        segments.push({ type: "L", points: [[c1.x, c1.y]] });
        segments.push({ type: "L", points: [[c2.x, c2.y]] });
      }
    }
    return { start: [start.x, start.y], segments };
  });
}

function signedArea(path) {
  let area = 0;
  let prev = path.start;
  for (const seg of path.segments) {
    const p = seg.points[seg.points.length - 1];
    area += prev[0] * p[1] - p[0] * prev[1];
    prev = p;
  }
  return area / 2;
}

function polygonOf(path) {
  const pts = [path.start];
  let prev = path.start;
  for (const seg of path.segments) {
    if (seg.type === "C") {
      const [c1, c2, p] = seg.points;
      for (const t of [0.25, 0.5, 0.75]) {
        const u = 1 - t;
        pts.push([
          u * u * u * prev[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p[0],
          u * u * u * prev[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p[1],
        ]);
      }
    }
    prev = seg.points[seg.points.length - 1];
    pts.push(prev);
  }
  return pts;
}

function insidePolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Potrace returns holes (the counters of O, A, etc.) as separate outlines with
// the same winding as their parent. Paths in one layer never cross, so nesting
// depth decides: even depth is a shape, odd depth is a hole. Holes get the
// opposite winding so the plain nonzero `fill` used by EPS importers cuts them.
function orientByNesting(paths) {
  const polys = paths.map((p) => {
    const pts = polygonOf(p);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { pts, minX, minY, maxX, maxY, area: Math.abs(signedArea(p)) };
  });
  return paths.map((path, i) => {
    const a = polys[i];
    const probe = a.pts[0];
    let depth = 0;
    for (let j = 0; j < paths.length; j++) {
      const b = polys[j];
      if (j === i || b.area <= a.area) continue;
      if (a.minX < b.minX || a.maxX > b.maxX || a.minY < b.minY || a.maxY > b.maxY) continue;
      if (insidePolygon(probe, b.pts)) depth++;
    }
    return orient(path, depth % 2 === 0);
  });
}

function orient(path, outer) {
  if (signedArea(path) > 0 === outer) return path;
  const ends = [path.start, ...path.segments.map((s) => s.points[s.points.length - 1])];
  const segments = [];
  for (let k = path.segments.length - 1; k >= 0; k--) {
    const seg = path.segments[k];
    const to = ends[k];
    segments.push(seg.type === "C" ? { type: "C", points: [seg.points[1], seg.points[0], to] } : { type: "L", points: [to] });
  }
  return { start: path.start, segments };
}

/**
 * Convert a raster image buffer into color layers of closed Bezier paths.
 * Coordinates are in source-image pixels with the origin at the top left.
 */
async function vectorize(input, options = {}) {
  const preset = DETAIL_PRESETS[options.detail] || DETAIL_PRESETS.medium;
  const maxColors = Math.max(2, Math.min(32, Number(options.colors) || 16));
  const autoColors = !options.colors || options.colors === "auto";
  const smoothness = Number.isFinite(Number(options.smoothness)) ? Number(options.smoothness) : 1;
  const removeBackground = options.removeBackground !== false;
  const layering = ["stacked", "cutouts"].includes(options.layering) ? options.layering : "overlap";

  const image = sharp(input, { failOn: "none", limitInputPixels: 80_000_000 }).rotate();
  const meta = await image.metadata();
  let srcW = meta.width;
  let srcH = meta.height;
  if (meta.orientation && meta.orientation >= 5) [srcW, srcH] = [srcH, srcW];
  if (!srcW || !srcH) throw new Error("Could not read image dimensions");

  // Work at a fixed resolution: big photos are downsampled for speed, small
  // logos are upsampled so the tracer gets smooth anti-aliased edges to follow.
  const scale = preset.workSize / Math.max(srcW, srcH);
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  // JPEG and other lossy files carry block and ringing noise around edges; a
  // 3x3 median at source resolution removes it before anything is traced.
  let source = image;
  // (Large images skip it: downsampling to the working size averages it away.)
  if (["jpeg", "jpg", "webp", "heif", "avif"].includes(meta.format) && scale > 0.75) {
    const raw = await image.ensureAlpha().median(3).raw().toBuffer({ resolveWithObject: true });
    source = sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: 4 } });
  }
  const { data } = await source
    .resize(width, height, { kernel: "lanczos3", fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = width * height;
  const opaque = new Uint8Array(n);
  const lab = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), keys: new Uint32Array(n) };
  const labCache = new Map();
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    if (data[i * 4 + 3] < 128) continue;
    opaque[i] = 1;
    const key = (r << 16) | (g << 8) | b;
    lab.keys[i] = key;
    let v = labCache.get(key);
    if (!v) {
      v = rgbToOklab(r, g, b);
      labCache.set(key, v);
    }
    lab.L[i] = v[0];
    lab.A[i] = v[1];
    lab.B[i] = v[2];
  }

  const opaqueCount = opaque.reduce((a, b) => a + b, 0);
  if (!opaqueCount) throw new Error("Image is fully transparent");

  // Learn the palette from flat pixels only (unless the image is mostly
  // texture, e.g. a photo, where we have to use everything).
  const flat = findFlatPixels(lab, opaque, width, height, 0.035, Math.max(1, Math.round(scale)));
  const flatCount = flat.reduce((a, b) => a + b, 0);
  const useFlat = flatCount >= opaqueCount * 0.15;
  const pool = useFlat ? flat : opaque;
  const poolCount = useFlat ? flatCount : opaqueCount;
  const rand = mulberry32(0x5eed);
  const samples = [];
  const step = Math.max(1, Math.floor(poolCount / 60000));
  let seen = 0;
  for (let i = 0; i < n; i++) {
    if (!pool[i]) continue;
    if (seen++ % step === 0) samples.push([lab.L[i], lab.A[i], lab.B[i]]);
  }

  const cap = autoColors ? 16 : maxColors;
  let clusters = kmeans(samples, autoColors ? 24 : Math.max(maxColors * 2, 8), rand);
  clusters = mergeClusters(clusters, autoColors ? 0.07 : 0, cap);
  if (autoColors) {
    const kept = clusters.filter((c) => c.weight / samples.length >= 0.002);
    if (kept.length) clusters = kept;
  }

  // Thin details (small text, outlines) may have no flat pixels at all. Find
  // pixels the palette can't explain, either as one of its colors or as an
  // anti-aliased mix of two of them, and learn extra colors from those.
  if (useFlat) {
    const misfits = [];
    const allStep = Math.max(1, Math.floor(opaqueCount / 120000));
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!opaque[i] || flat[i] || k++ % allStep !== 0) continue;
      const p = [lab.L[i], lab.A[i], lab.B[i]];
      if (mixError(p, clusters) > 0.1 * 0.1) misfits.push(p);
    }
    const sampled = Math.ceil(opaqueCount / allStep);
    if (misfits.length > sampled * 0.002) {
      const scaleW = samples.length / sampled;
      const extra = mergeClusters(kmeans(misfits, 6, rand), 0.15, 6)
        .filter((c) => c.weight > sampled * 0.001)
        .map((c) => ({ lab: c.lab, weight: c.weight * scaleW }));
      // Drop extras that are just an anti-aliased blend of two other colors
      // (the gray halo around thin black text on white), least common first.
      extra.sort((a, b) => a.weight - b.weight);
      for (let i = 0; i < extra.length; ) {
        const others = [...clusters, ...extra.filter((_, j) => j !== i)];
        if (mixError(extra[i].lab, others) < 0.1 * 0.1) extra.splice(i, 1);
        else i++;
      }
      clusters = mergeClusters([...clusters, ...extra], autoColors ? 0.07 : 0, cap);
    }
  }

  const centers = clusters.map((c) => c.lab);
  let labels = assignLabels(lab, useFlat ? flat : opaque, centers);
  if (useFlat) labels = labelEdgesFromRegions(labels, flat, lab, opaque, centers, width, height, Math.ceil(3 * Math.max(1, scale)) + 2);

  labels = majorityFilter(labels, width, height);
  labels = removeSmallRegions(labels, width, height, Math.max(4, Math.round(n * preset.minRegion)));
  mergeSimilarLabels(labels, lab, centers.length, autoColors ? 0.06 : 0.03);

  const backgroundRemoved = removeBackground && removeBackgroundRegion(labels, width, height);

  // Final layer colors are the mean sRGB of each region (truer than centroids),
  // taken from its flat pixels when it has enough so edge blending can't tint it.
  const sums = centers.map(() => [0, 0, 0, 0]);
  const flatSums = centers.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l === NONE) continue;
    const target = flat[i] ? [sums[l], flatSums[l]] : [sums[l]];
    for (const t of target) {
      t[0] += data[i * 4];
      t[1] += data[i * 4 + 1];
      t[2] += data[i * 4 + 2];
      t[3]++;
    }
  }
  const order = sums
    .map((s, index) => ({ index, area: s[3] }))
    .filter((s) => s.area > 0)
    .sort((a, b) => b.area - a.area);

  // Layers are drawn largest first. "overlap" lets each color reach a little
  // under the colors drawn on top of it, so there are no hairline gaps between
  // touching shapes; "stacked" fills completely under everything above it;
  // "cutouts" keeps every color exactly to its own area.
  const overlapPx = Math.max(1, Math.round(1.5 * Math.max(1, scale)));
  const rank = new Uint8Array(centers.length).fill(NONE);
  order.forEach((o, r) => (rank[o.index] = r));
  const layers = [];
  const toSource = 1 / scale;
  for (let r = 0; r < order.length; r++) {
    const { index } = order[r];
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const l = labels[i];
      if (l === NONE) continue;
      mask[i] = layering === "stacked" ? rank[l] >= r : l === index;
    }
    if (layering === "overlap") {
      const grown = dilate(mask, width, height, overlapPx);
      for (let i = 0; i < n; i++) {
        const l = labels[i];
        if (grown[i] && l !== NONE && rank[l] > r) mask[i] = 1;
      }
    }
    const paths = orientByNesting(tracePaths(mask, width, height, preset, smoothness)).map((p) => ({
      start: [p.start[0] * toSource, p.start[1] * toSource],
      segments: p.segments.map((s) => ({ type: s.type, points: s.points.map(([x, y]) => [x * toSource, y * toSource]) })),
    }));
    if (!paths.length) continue;
    const s = flatSums[index][3] >= 50 ? flatSums[index] : sums[index];
    layers.push({
      color: [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])],
      area: sums[index][3] / n,
      paths,
    });
  }

  return { width: srcW, height: srcH, layers, backgroundRemoved };
}

module.exports = { vectorize };
