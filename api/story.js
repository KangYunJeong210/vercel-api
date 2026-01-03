// api/story.js
import { GoogleGenAI } from "@google/genai";

/* ===============================
   CORS (GitHub Pages + localhost + origin:null 대응)
================================ */
function setCors(req, res) {
  const origin = req.headers.origin;

  // origin이 있으면 그대로 반사(가장 호환성 좋음)
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    // 일부 환경(file:// 등)에서 Origin 헤더가 없을 수 있음
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/* ===============================
   Helpers
================================ */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** 모델이 가끔 JSON 앞뒤로 텍스트를 붙여도 객체만 뽑아내기 */
function extractJson(text) {
  if (!text) return null;

  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const sliced = t.slice(first, last + 1);
  try {
    return JSON.parse(sliced);
  } catch {
    return null;
  }
}

/** SDK 응답에서 텍스트 안전하게 꺼내기 */
function getResultText(result) {
  if (typeof result?.text === "string") return result.text;

  if (result?.response?.text && typeof result.response.text === "function") {
    try {
      return result.response.text();
    } catch {}
  }

  const parts = result?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text || "").join("");

  return "";
}

function isRetryable(errMsg, status) {
  const m = String(errMsg || "");
  return (
    status === 429 ||
    status === 408 ||
    (status >= 500 && status <= 599) ||
    /rate|quota|429|timeout|temporar|overload|unavailable|econnreset|network|fetch failed/i.test(m)
  );
}

/** 출력 형태 보정 (stats 범위 / choices 3개 / mood 값 등) */
function normalizePayload(p, prevState) {
  const prev = prevState || {};
  const prevStats = prev.stats || { hp: 7, luck: 3, sanity: 5 };

  const moodAllow = new Set(["neutral", "happy", "angry", "scared", "thinking"]);
  const mood = moodAllow.has(p?.mood) ? p.mood : (prev?.pending?.mood || "neutral");

  const out = {
    sceneId: typeof p?.sceneId === "string" ? p.sceneId : (prev?.at || "scene_001"),
    text: typeof p?.text === "string" ? p.text : (prev?.pending?.text || ""),
    choices: Array.isArray(p?.choices) ? p.choices.slice(0, 3) : (prev?.pending?.choices || []),
    stats: {
      hp: clamp(Number(p?.stats?.hp ?? prevStats.hp), 0, 10),
      luck: clamp(Number(p?.stats?.luck ?? prevStats.luck), 0, 10),
      sanity: clamp(Number(p?.stats?.sanity ?? prevStats.sanity), 0, 10),
    },
    flags: (p?.flags && typeof p.flags === "object") ? p.flags : (prev?.flags || {}),
    mood,
    beatTag: typeof p?.beatTag === "string" ? p.beatTag : (prev?.pending?.beatTag || "unknown"),
    isEnding: !!p?.isEnding,
  };

  const ABC = ["A", "B", "C"];
  out.choices = out.choices.map((c, i) => {
    const id = (c?.id && typeof c.id === "string") ? c.id : ABC[i];
    const label = (c?.label && typeof c.label === "string") ? c.label : `선택지 ${id}`;
    const delta = (c?.delta && typeof c.delta === "object") ? c.delta : undefined;
    return delta ? { id, label, delta } : { id, label };
  });

  while (out.choices.length < 3) {
    const id = ABC[out.choices.length];
    out.choices.push({ id, label: `선택지 ${id}` });
  }

  return out;
}

/* ===============================
   Story Engine Prompt
================================ */
const SYSTEM_INSTRUCTION = `
너는 모바일 인터랙티브 스토리 엔진이다.

[세계관/스토리]
- 해리 포터 1권(마법사의 돌)의 '주요 사건 순서(대사건의 흐름)'는 유지한다.
- 단, 주인공은 해리가 아니라 '베르 블랙(Ver Black)'이 해리의 역할을 수행한다.
- 덤블도어/맥고나걸/해그리드/론/헤르미온느/말포이/스네이프/퀴렐 등 주요 인물은 원작처럼 등장한다.

[주인공 설정]
- 블랙 성을 가졌지만 블랙 가문과 거리가 먼 사촌이며 머글 피가 진하게 섞였다.
- 검은 머리의 미소녀, 아름다움은 상황에 맞게 자연스럽게(과장 금지).
- 마법 재능이 매우 뛰어나 주변 인물들이 감탄한다.
- 로맨스 텐션은 가능하지만 메인 사건 진행을 방해하지 말고 가볍게(선택지 중 1개 정도에만 반영 가능).

[진행 규칙(매우 중요)]
1) 느리면 안 된다. 매 턴은 "사건 전개 → 즉시 선택" 리듬으로 6~10문장 내.
2) 질문/선택지 의미 반복 금지(같은 말 바꿔 묻기 금지).
3) 선택지는 항상 3개(A/B/C)이며 결이 확실히 달라야 한다:
   - A: 정면 돌파/용기
   - B: 신중/관찰/협상
   - C: 규칙 위반/꼼수/유혹(대신 리스크)
4) 직전 2~3턴의 비트(beatTag)와 유사한 상황 반복 금지. 이야기를 한 단계 앞으로 민다.
5) 잔혹/노골적 성적 묘사 금지.

[출력]
- 오직 JSON만 출력(설명/머리말/코드펜스 금지)
- 아래 형식을 반드시 지켜라:

{
  "sceneId": "scene_014",
  "text": "6~10문장 스토리",
  "choices": [
    { "id":"A", "label":"..." , "delta": { "hp":-1, "luck":0, "sanity":+1 } },
    { "id":"B", "label":"..." , "delta": { "hp":0, "luck":+1, "sanity":0 } },
    { "id":"C", "label":"..." , "delta": { "hp":0, "luck":+2, "sanity":-1 } }
  ],
  "stats": { "hp": 0~10, "luck": 0~10, "sanity": 0~10 },
  "flags": { "any": "json" },
  "mood": "neutral|happy|angry|scared|thinking",
  "beatTag": "짧은키워드",
  "isEnding": false
}
`;

/** 원작 큰 흐름 비트(참고용) */
const CANON_BEATS = [
  "letter",
  "hagrid_visit",
  "diagon_alley",
  "hogwarts_express",
  "sorting",
  "classes_begin",
  "troll",
  "quidditch",
  "mirror",
  "trapdoor",
  "stone_final",
];

function summarizeState(state, picked) {
  const s = state || {};
  const stats = s.stats || { hp: 7, luck: 3, sanity: 5 };
  const flags = s.flags || {};
  const last3Beats = Array.isArray(s.last3Beats) ? s.last3Beats.slice(-3) : [];
  const pending = s.pending || {};
  const lastChoices = Array.isArray(pending.choices) ? pending.choices : [];

  return {
    protagonist: {
      name: "베르 블랙",
      role: "해리의 역할",
      traits: ["블랙 성(머글 피 진함)", "검은 머리 미소녀", "마법 재능 매우 뛰어남"],
    },
    at: s.at || "scene_001",
    stats,
    flags,
    currentBeat: pending.beatTag || "unknown",
    last3Beats,
    lastStory: (pending.text || "").slice(0, 420),
    lastChoices: lastChoices.slice(0, 3).map((c) => ({ id: c.id, label: c.label })),
    picked: picked || null,
    canonBeats: CANON_BEATS,
  };
}

/* ===============================
   Gemini client
================================ */
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
  }

  // Vercel에서 body가 string으로 들어올 수도 있어서 방어
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }

  const state = body?.state || {};
  const picked = body?.picked || null;

  const summary = summarizeState(state, picked);

  const userPrompt = `
다음은 현재 게임 상태 요약 JSON이다. 이를 바탕으로 "다음 장면"을 생성하라.

필수 조건:
- 원작 1권의 큰 사건 흐름을 유지하되, 현재 상황에서 다음 비트로 자연스럽게 전진.
- last3Beats와 유사한 상황 반복 금지.
- text는 6~10문장.
- choices는 3개(A/B/C)이고 서로 결이 확실히 다르게.
- stats는 소폭 변동 가능(0~10).
- beatTag는 이번 장면의 핵심 키워드.
- mood는 지정된 값 중 하나.

상태 요약:
${JSON.stringify(summary)}
`;

  // ✅ 중간중간 오류(429/5xx/JSON깨짐) 줄이기: 서버 재시도 + 파싱 실패 시 재생성
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: userPrompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          temperature: 0.85,     // 너무 높으면 JSON 깨짐이 늘어남
          topP: 0.9,
          maxOutputTokens: 750,  // 너무 길면 깨질 확률↑
        },
      });

      const raw = getResultText(result);

      const parsed = (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return extractJson(raw);
        }
      })();

      // JSON이 깨졌으면 재생성으로 간주하고 재시도
      if (!parsed) {
        lastErr = new Error("Bad model output (json parse failed)");
        await sleep(250 * (attempt + 1));
        continue;
      }

      const normalized = normalizePayload(parsed, state);
      return res.status(200).json(normalized);
    } catch (err) {
      lastErr = err;

      const msg = String(err?.message || err);
      const status = Number(err?.status || err?.code || 0);

      if (isRetryable(msg, status) && attempt < 2) {
        // 지수 백오프: 0.4s → 0.9s
        await sleep(400 + attempt * 500);
        continue;
      }

      return res.status(500).json({
        error: "Story generation failed",
        detail: msg,
        hint: isRetryable(msg, status)
          ? "Temporary issue. Try again."
          : "Non-retryable error (check API key / request size).",
      });
    }
  }

  return res.status(502).json({
    error: "Story generation failed after retries",
    detail: String(lastErr?.message || lastErr || "unknown"),
  });
}
