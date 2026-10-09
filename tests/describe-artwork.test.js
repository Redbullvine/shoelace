const test = require("node:test");
const assert = require("node:assert");
const { handler } = require("../netlify/functions/describe-artwork/describe-artwork");

const IMAGE = "data:image/jpeg;base64,AAAA";
const post = (body) => handler({ httpMethod: "POST", body: JSON.stringify(body) });

test("says when font identification isn't configured", async () => {
  delete process.env.OPENAI_API_KEY;
  const res = await post({ image: IMAGE });
  assert.strictEqual(res.statusCode, 503);
});

test("returns cleaned font guesses from the vision model", async (t) => {
  process.env.OPENAI_API_KEY = "test";
  let sent;
  t.mock.method(global, "fetch", async (url, init) => {
    sent = JSON.parse(init.body);
    const reply = '```json\n{"description":"Texas flag logo","fonts":[{"text":"UNDERGROUND","font":"Rockwell Extra Bold","alternatives":["Clarendon"],"style":"slab serif","weight":"black","effects":"distressed","confidence":"medium"}]}\n```';
    return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: reply }] }] }), { status: 200 });
  });
  const res = await post({ image: IMAGE });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.fonts[0].font, "Rockwell Extra Bold");
  assert.strictEqual(body.fonts[0].confidence, "medium");
  assert.strictEqual(sent.input[0].content[1].image_url, IMAGE);
});

test("rejects anything that isn't an image data URL", async () => {
  process.env.OPENAI_API_KEY = "test";
  const res = await post({ image: "https://example.com/x.png" });
  assert.strictEqual(res.statusCode, 400);
});
