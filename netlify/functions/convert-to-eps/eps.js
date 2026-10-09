// Writers for the traced layers. EPS uses only core PostScript operators
// (moveto/lineto/curveto/closepath/fill) so embroidery digitizing software with
// simple EPS importers can read it, not just Illustrator.

function num(value) {
  return (Math.round(value * 100) / 100).toString();
}

function hex(color) {
  return "#" + color.map((c) => c.toString(16).padStart(2, "0")).join("");
}

function toEps({ width, height, layers }, { title = "Vectorized artwork" } = {}) {
  const safeTitle = String(title).replace(/[^\x20-\x7e]/g, "").replace(/[()\\]/g, "").slice(0, 120);
  const out = [
    "%!PS-Adobe-3.0 EPSF-3.0",
    "%%Creator: Shoelace Vectorizer",
    `%%Title: (${safeTitle})`,
    `%%CreationDate: (${new Date().toISOString()})`,
    `%%BoundingBox: 0 0 ${Math.ceil(width)} ${Math.ceil(height)}`,
    `%%HiResBoundingBox: 0 0 ${num(width)} ${num(height)}`,
    "%%DocumentData: Clean7Bit",
    "%%LanguageLevel: 2",
    "%%Pages: 1",
    "%%EndComments",
    "%%BeginProlog",
    "%%EndProlog",
    "%%Page: 1 1",
    "gsave",
  ];
  // PostScript's origin is bottom-left, so flip y.
  const pt = ([x, y]) => `${num(x)} ${num(height - y)}`;
  layers.forEach((layer, i) => {
    const [r, g, b] = layer.color.map((c) => num(c / 255));
    out.push(`% Layer ${i + 1} ${hex(layer.color)}`);
    out.push(`${r} ${g} ${b} setrgbcolor`);
    out.push("newpath");
    for (const path of layer.paths) {
      out.push(`${pt(path.start)} moveto`);
      for (const seg of path.segments) {
        if (seg.type === "C") out.push(`${seg.points.map(pt).join(" ")} curveto`);
        else out.push(`${pt(seg.points[0])} lineto`);
      }
      out.push("closepath");
    }
    out.push("fill");
  });
  out.push("grestore", "showpage", "%%Trailer", "%%EOF", "");
  return out.join("\n");
}

// Browser preview only (the browser can't render EPS); same geometry as the EPS.
function toSvg({ width, height, layers }) {
  const pt = ([x, y]) => `${num(x)} ${num(y)}`;
  const paths = layers.map((layer) => {
    const d = layer.paths
      .map((path) => {
        const parts = [`M${pt(path.start)}`];
        for (const seg of path.segments) {
          parts.push(seg.type === "C" ? `C${seg.points.map(pt).join(" ")}` : `L${pt(seg.points[0])}`);
        }
        return parts.join("") + "Z";
      })
      .join("");
    return `<path fill="${hex(layer.color)}" d="${d}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}">${paths.join("")}</svg>`;
}

module.exports = { toEps, toSvg, hex };
