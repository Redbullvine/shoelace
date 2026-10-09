// Emails a converted EPS file as an attachment through Resend (resend.com).
// Netlify environment variables:
//   RESEND_API_KEY  required, from resend.com > API Keys
//   EMAIL_FROM      required, a sender on a domain verified in Resend,
//                   e.g. "Shoelace <eps@yourdomain.com>"
//   EMAIL_TO        optional, defaults to justsayin@peoplescom.net
// The recipient is fixed on the server so this endpoint can't be used to mail
// anyone else.
const DEFAULT_TO = "justsayin@peoplescom.net";
const MAX_EPS_BYTES = 4.5 * 1024 * 1024;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const to = process.env.EMAIL_TO || DEFAULT_TO;
  if (!apiKey || !from) {
    return json(503, { error: "Email isn't set up yet. Add RESEND_API_KEY and EMAIL_FROM in Netlify." });
  }

  let payload;
  try {
    payload = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request." });
  }

  const eps = typeof payload.eps === "string" ? payload.eps : "";
  if (!eps.startsWith("%!PS-Adobe")) {
    return json(400, { error: "Convert an image first, then email the EPS." });
  }
  if (Buffer.byteLength(eps) > MAX_EPS_BYTES) {
    return json(413, { error: "This EPS is too large to email. Try fewer colors or a lower detail level." });
  }

  const fileName = (String(payload.fileName || "artwork.eps").replace(/[^\w.\- ()]/g, "_").slice(0, 100) || "artwork.eps")
    .replace(/(\.eps)?$/i, ".eps");
  const colors = Array.isArray(payload.colors) ? payload.colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 32) : [];
  const lines = [
    `Attached is ${fileName}, converted with the Shoelace Image to EPS tool.`,
    colors.length ? `Thread colors (${colors.length}): ${colors.join(", ")}` : "",
  ].filter(Boolean);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `EPS artwork: ${fileName}`,
      text: lines.join("\n\n"),
      attachments: [{ filename: fileName, content: Buffer.from(eps).toString("base64") }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("email-eps failed", response.status, detail);
    return json(502, { error: "The email service rejected the message. Check the Resend settings in Netlify." });
  }

  return json(200, { sentTo: to });
};
