const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { handler } = require("../netlify/functions/convert-to-eps/convert-to-eps");

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
  <rect width="400" height="300" fill="#ffffff"/>
  <circle cx="200" cy="150" r="110" fill="#c8102e"/>
  <circle cx="200" cy="150" r="60" fill="#ffffff"/>
  <rect x="20" y="20" width="80" height="50" fill="#002868"/>
</svg>`;

async function convert(format, query = {}) {
  const image = await sharp(Buffer.from(LOGO_SVG))[format]().toBuffer();
  const res = await handler({
    httpMethod: "POST",
    body: image.toString("base64"),
    isBase64Encoded: true,
    queryStringParameters: { name: "logo.png", ...query },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test("converts a PNG into vector-only EPS", async () => {
  const { status, body } = await convert("png");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.fileName, "logo.eps");
  assert.match(body.eps, /^%!PS-Adobe-3.0 EPSF-3.0\n/);
  assert.match(body.eps, /%%BoundingBox: 0 0 400 300/);
  assert.match(body.eps, /curveto/);
  assert.doesNotMatch(body.eps, /\b(image|colorimage|imagemask)\b/);
  assert.match(body.eps, /%%EOF\n$/);
  const hexes = body.colors.map((c) => c.hex).sort();
  assert.deepStrictEqual(hexes, ["#002868", "#c8102e", "#ffffff"]);
  assert.strictEqual(body.backgroundRemoved, true);
});

test("keeps inner areas that match the background color", async () => {
  const { body } = await convert("png");
  assert.ok(body.colors.some((c) => c.hex === "#ffffff"), "inner white ring should be its own layer");
});

test("handles JPEG input and a fixed color count", async () => {
  const { status, body } = await convert("jpeg", { colors: "2", removeBackground: "false" });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.colors.length, 2);
});

test("rejects non-images and wrong methods", async () => {
  const bad = await handler({ httpMethod: "POST", body: Buffer.from("hello").toString("base64"), isBase64Encoded: true });
  assert.strictEqual(bad.statusCode, 422);
  const get = await handler({ httpMethod: "GET" });
  assert.strictEqual(get.statusCode, 405);
});
