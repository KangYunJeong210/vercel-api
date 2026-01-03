import { GoogleGenAI } from "@google/genai";

/* ===============================
   CORS
================================ */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* ===============================
   Helpers
================================ */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    return null;
  }
}

function getResultText(result) {
  if (typeof result?.text === "string") return result.text;
  if (result?.response?.text) return result.response.text();
  const parts = result?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map(p => p.text || "").join("");
  return "";
}

function normalizePayload(p, prev) {
  const stats = prev?.stats || { hp: 7, luck: 3, sanity: 5 };

  const out = {
    sceneId: p?.sceneId || prev?.at || "scene_001",
    text: p?.text || prev?.pending?.text || "",
    choices: Array.isArray(p?.choices) ? p.choices.slice(0, 3) : prev?.pending?.choices || [],
    stats: {
      hp: clamp(Number(p?.stats?.hp ?? stats.hp), 0, 10),
      luck: clamp(Number(p?.stats?.luck ?? stats.luck), 0, 10),
      sanity: clamp(Number(p?.stats?.sanity ?? stats.sanity), 0, 10)
    },
    flags: typeof p?.flags === "object" ? p.flags : prev?.flags || {},
    mood: p?.mood || prev?.pending?.mood || "neutral",
    beatTag: p?.beatTag || prev?.pending?.beatTag || "unknown",
    isEnding: !!p?.isEnding
  };

  // choice normalize
  out.choices = out.choices.map((c, i) => ({
    id: c?.id || ["A", "B", "C"][i],
    label: c?.label || `선택지 ${["A", "B", "C"][i]}`,
    delta: c?.delta
  }));

  while (out.choices.length < 3) {
    const id = ["A", "B", "C"][out.choices.length];
    out.choices.push({ id, label: `선택지 ${id}` });
  }

  return out;
}

/* ===============================
   Gemini
================================ */
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM = `
You are a Harry Potter story engine.

The protagonist is Ver Black:
- A distant cousin of the Black family
- Strong muggle blood
- Black-haired beautiful girl
- Extremely talented at magic

She replaces Harry Potter's role.
All major events of Philosopher's Stone must follow the original storyline order.

Rules:
- Never repeat the same question or similar choice.
- Every turn must progress the main plot.
- Always output 3 very different choices (A/B/C).
- 6~10 sentences per scene.
- Keep story moving fast.

Output ONLY JSON.
`;

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);

    const state = body.state || {};
    const picked = body.picked || null;

    const prompt = `
Current state:
${JSON.stringify(state)}

Player picked: ${picked || "none"}

Generate next scene.
Return JSON in this format:
{
 "sceneId": "scene_xxx",
 "text": "story",
 "choices": [
  {"id":"A","label":"..."},
  {"id":"B","label":"..."},
  {"id":"C","label":"..."}
 ],
 "stats":{"hp":7,"luck":3,"sanity":5},
 "flags":{},
 "mood":"neutral|happy|angry|scared|thinking",
 "beatTag":"keyword",
 "isEnding":false
}
`;

    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: "application/json",
        temperature: 0.9,
        maxOutputTokens: 800
      }
    });

    const raw = getResultText(result);
    const parsed = extractJson(raw);

    if (!parsed) {
      return res.status(500).json({
        error: "Bad AI response",
        raw: raw.slice(0, 500)
      });
    }

    const finalPayload = normalizePayload(parsed, state);
    res.status(200).json(finalPayload);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Story generation failed",
      detail: String(err.message || err)
    });
  }
}
