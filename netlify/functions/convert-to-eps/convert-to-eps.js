const { vectorize } = require("./vectorize");
const { toEps, hex } = require("./eps");

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_RESPONSE = 5.8 * 1024 * 1024;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// POST the raw image bytes (PNG, JPEG, WebP, GIF, TIFF, BMP, AVIF...) with
// options in the query string: colors=auto|2..32, detail=low|medium|high,
// smoothness=0..1.3, removeBackground=true|false, layering=overlap|stacked|cutouts, name=file.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }
  if (!event.body) {
    return json(400, { error: "Upload an image file." });
  }

  const input = Buffer.from(event.body, event.isBase64Encoded ? "base64" : "binary");
  if (input.length > MAX_BYTES) {
    return json(413, { error: "Image is too large. Keep uploads under 6 MB." });
  }

  const q = event.queryStringParameters || {};
  const name = String(q.name || "artwork").replace(/\.[^.]+$/, "") || "artwork";
  const options = {
    colors: q.colors && q.colors !== "auto" ? Number(q.colors) : "auto",
    detail: q.detail,
    smoothness: q.smoothness,
    removeBackground: q.removeBackground !== "false",
    layering: q.layering,
  };

  let result;
  try {
    result = await vectorize(input, options);
  } catch (error) {
    console.error("convert-to-eps failed", error);
    return json(422, { error: "Could not read that image. Try a PNG or JPEG." });
  }

  if (!result.layers.length) {
    return json(422, { error: "No shapes found in the image. Try turning off background removal." });
  }

  // Netlify caps function responses at 6 MB. The browser draws its preview
  // from the EPS itself, so only the EPS is sent.
  const eps = toEps(result, { title: name });
  if (eps.length > MAX_RESPONSE) {
    return json(413, { error: "This image makes a very large EPS. Try fewer colors or a lower detail level." });
  }

  return json(200, {
    fileName: `${name}.eps`,
    width: result.width,
    height: result.height,
    backgroundRemoved: result.backgroundRemoved,
    colors: result.layers.map((layer) => ({ hex: hex(layer.color), area: layer.area, paths: layer.paths.length })),
    eps,
  });
};
