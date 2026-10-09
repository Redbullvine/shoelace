const test = require("node:test");
const assert = require("node:assert");
const { handler } = require("../netlify/functions/email-eps/email-eps");

const EPS = "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n%%EOF\n";
const post = (body) => handler({ httpMethod: "POST", body: JSON.stringify(body) });

test("explains missing setup instead of failing silently", async () => {
  delete process.env.RESEND_API_KEY;
  const res = await post({ eps: EPS });
  assert.strictEqual(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /RESEND_API_KEY/);
});

test("sends the EPS as an attachment to the fixed recipient", async (t) => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_FROM = "Shoelace <eps@example.com>";
  delete process.env.EMAIL_TO;
  let sent;
  t.mock.method(global, "fetch", async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: "1" }), { status: 200 });
  });
  const res = await post({ eps: EPS, fileName: "logo.eps", colors: ["#c8102e", "bad"], to: "someone@else.com" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(sent.url, "https://api.resend.com/emails");
  assert.strictEqual(sent.init.headers.Authorization, "Bearer test-key");
  assert.deepStrictEqual(sent.body.to, ["justsayin@peoplescom.net"]);
  assert.strictEqual(sent.body.attachments[0].filename, "logo.eps");
  assert.strictEqual(Buffer.from(sent.body.attachments[0].content, "base64").toString(), EPS);
  assert.match(sent.body.text, /#c8102e/);
  assert.doesNotMatch(sent.body.text, /bad/);
});

test("rejects requests without an EPS", async () => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_FROM = "x@example.com";
  const res = await post({ eps: "hello" });
  assert.strictEqual(res.statusCode, 400);
});
