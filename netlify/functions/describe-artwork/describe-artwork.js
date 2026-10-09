// Best-guess description of the lettering in an uploaded logo: the text, the
// font (or closest match) and its style. Traced vectors keep no font data, so
// this looks at the original image with OpenAI vision, like analyze-scan does.
// Needs OPENAI_API_KEY in Netlify; without it the page just says so.
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const PROMPT = [
  "This image is a logo or artwork being converted to embroidery.",
  "Identify each distinct block of lettering. For each give the exact text, the most likely font name",
  "(or the closest well-known match), the style category (e.g. slab serif, western, script, sans serif),",
  "weight, and any effects (distressed, outline, shadow, arched).",
  "Also give a one-sentence description of the artwork.",
  "Return JSON only, shaped like:",
  '{"description":"","fonts":[{"text":"","font":"","alternatives":["",""],"style":"","weight":"","effects":"","confidence":"high|medium|low"}]}',
  "If there is no lettering, return an empty fonts array.",
].join(" ");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(503, { error: "Font identification isn't set up. Add OPENAI_API_KEY in Netlify." });
  }

  let image;
  try {
    image = JSON.parse(event.body || "{}").image;
  } catch {
    return json(400, { error: "Invalid request." });
  }
  if (typeof image !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(image) || image.length > MAX_IMAGE_CHARS) {
    return json(400, { error: "Send the image as a PNG, JPEG or WebP data URL." });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: PROMPT },
            { type: "input_image", image_url: image, detail: "high" },
          ],
        },
      ],
      temperature: 0.2,
      max_output_tokens: 700,
    }),
  });
  if (!response.ok) {
    console.error("describe-artwork failed", response.status, await response.text().catch(() => ""));
    return json(502, { error: "Couldn't identify the fonts right now." });
  }

  const data = await response.json();
  const text = (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("")
    .replace(/^```(?:json)?\s*|\s*```$/g, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(502, { error: "Couldn't identify the fonts right now." });
  }

  const str = (v, max = 120) => String(v ?? "").slice(0, max);
  const fonts = (Array.isArray(parsed.fonts) ? parsed.fonts : []).slice(0, 8).map((f) => ({
    text: str(f.text),
    font: str(f.font, 80),
    alternatives: (Array.isArray(f.alternatives) ? f.alternatives : []).slice(0, 3).map((a) => str(a, 60)),
    style: str(f.style, 60),
    weight: str(f.weight, 40),
    effects: str(f.effects, 80),
    confidence: ["high", "medium", "low"].includes(f.confidence) ? f.confidence : "low",
  }));
  return json(200, { description: str(parsed.description, 300), fonts });
};
