// api/story.js
import { GoogleGenAI } from "@google/genai";

/* ===============================
  CORS (프론트: GitHub Pages)
================================ */
function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

/** Gemini가 가끔 JSON 주변에 텍스트를 붙이면 제거 */
function extractJson(text) {
    if (!text) return null;
    const t = String(text).trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();

    const first = t.indexOf("{");
    const last = t.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    const sliced = t.slice(first, last + 1);
    try { return JSON.parse(sliced); } catch { return null; }
}

/** 간단 검증 + 기본값 보정 */
function normalizePayload(p, prevState) {
    const stats = prevState?.stats || { hp: 7, luck: 3, sanity: 5 };

    const next = {
        sceneId: typeof p?.sceneId === "string" ? p.sceneId : (prevState?.at || "scene_001"),
        text: typeof p?.text === "string" ? p.text : (prevState?.pending?.text || ""),
        choices: Array.isArray(p?.choices) ? p.choices.slice(0, 3) : (prevState?.pending?.choices || []),
        stats: {
            hp: clamp(Number(p?.stats?.hp ?? stats.hp), 0, 10),
            luck: clamp(Number(p?.stats?.luck ?? stats.luck), 0, 10),
            sanity: clamp(Number(p?.stats?.sanity ?? stats.sanity), 0, 10)
        },
        flags: (p?.flags && typeof p.flags === "object") ? p.flags : (prevState?.flags || {}),
        mood: typeof p?.mood === "string" ? p.mood : (prevState?.pending?.mood || "neutral"),
        beatTag: typeof p?.beatTag === "string" ? p.beatTag : (prevState?.pending?.beatTag || "unknown"),
        isEnding: !!p?.isEnding
    };

    // choice label/id 보정
    next.choices = next.choices.map((c, i) => {
        const id = (c?.id && typeof c.id === "string") ? c.id : ["A", "B", "C"][i];
        const label = (c?.label && typeof c.label === "string") ? c.label : `선택지 ${id}`;
        const delta = (c?.delta && typeof c.delta === "object") ? c.delta : undefined;
        return delta ? { id, label, delta } : { id, label };
    });

    // 3개 미만이면 채우기
    while (next.choices.length < 3) {
        const id = ["A", "B", "C"][next.choices.length];
        next.choices.push({ id, label: `선택지 ${id}` });
    }

    return next;
}

/* ===============================
  Gemini 설정
================================ */
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const RESPONSE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        sceneId: { type: "string" },
        text: { type: "string" },
        choices: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    delta: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            hp: { type: "integer" },
                            luck: { type: "integer" },
                            sanity: { type: "integer" }
                        }
                    }
                },
                required: ["id", "label"]
            }
        },
        stats: {
            type: "object",
            additionalProperties: false,
            properties: {
                hp: { type: "integer" },
                luck: { type: "integer" },
                sanity: { type: "integer" }
            },
            required: ["hp", "luck", "sanity"]
        },
        flags: { type: "object" },
        mood: {
            type: "string",
            enum: ["neutral", "happy", "angry", "scared", "thinking"]
        },
        beatTag: { type: "string" },
        isEnding: { type: "boolean" }
    },
    required: ["sceneId", "text", "choices", "stats", "flags", "mood", "beatTag", "isEnding"]
};

const SYSTEM_INSTRUCTION = `
너는 모바일 인터랙티브 스토리 엔진이다.
세계관/스토리 라인은 '해리 포터 1권(마법사의 돌)'의 주요 사건 순서(대사건의 흐름)를 유지한다.
단, 주인공은 '해리'가 아니라 '베르 블랙(Ver Black)'이 해리의 역할을 수행한다.
기타 주요 인물(덤블도어/맥고나걸/해그리드/론/헤르미온느/말포이/스네이프/퀴렐 등)은 원작처럼 등장한다.

[주인공 설정]
- 성: 블랙. 그러나 블랙 가문과 거리가 먼 사촌이며 머글의 피가 진하게 섞였다.
- 외형: 검은 머리의 미소녀, 아름다움이 두드러진다(과장 금지, 상황에 맞게 자연스럽게 묘사).
- 재능: 마법 재능이 매우 뛰어나 주변 인물들이 감탄한다.
- 연애/설렘: 가능하되, 메인 사건 진행을 방해하지 말고 가볍게 텐션만(선택지 중 1개 정도에 반영 가능).

[진행 규칙(매우 중요)]
1) 진행이 느리면 안 된다. 매 턴은 "사건 전개 → 즉시 선택" 리듬으로 6~10문장 내로 끝낸다.
2) 질문/선택지의 의미가 반복되면 안 된다. 같은 선택을 다른 말로 묻는 행위를 금지한다.
3) 매 턴 선택지는 정확히 3개(A/B/C)이며, 서로 성격이 확실히 달라야 한다:
   - A: 정면 돌파/용기
   - B: 신중/관찰/협상
   - C: 규칙 위반/꼼수/유혹(대신 리스크)
4) 직전 2~3턴의 beatTag와 유사한 상황을 반복하지 말고, 이야기를 한 단계 앞으로 민다.
5) 잔혹/노골적 성적 묘사 금지. (로맨스는 분위기/대사 중심으로만)

[출력 형식]
- 오직 JSON만 출력한다. (설명/머리말/코드펜스 금지)
- 반드시 RESPONSE_SCHEMA를 만족한다.
`;

/** 원작 1권의 큰 흐름(너무 세밀 X, '비트'만) */
const CANON_BEATS = [
    "letter",           // 편지/호그와트 초대
    "hagrid_visit",     // 해그리드 등장
    "diagon_alley",     // 다이애건 앨리
    "hogwarts_express", // 호그와트 급행
    "sorting",          // 기숙사 배정
    "classes_begin",    // 수업 시작/스네이프 첫 인상
    "troll",            // 트롤 사건
    "quidditch",        // 퀴디치/빗자루
    "mirror",           // 소망의 거울
    "trapdoor",         // 3층 복도/함정
    "stone_final"       // 마지막 대결
];

function summarizeState(state, picked) {
    const safe = state || {};
    const stats = safe.stats || { hp: 7, luck: 3, sanity: 5 };
    const flags = safe.flags || {};
    const last3Beats = Array.isArray(safe.last3Beats) ? safe.last3Beats.slice(-3) : [];
    const lastChoices = Array.isArray(safe.pending?.choices) ? safe.pending.choices : [];

    return {
        protagonist: {
            name: "베르 블랙",
            role: "해리 포터의 역할을 수행",
            traits: ["블랙 성(머글 피 진함)", "검은 머리 미소녀", "마법 재능 매우 뛰어남"]
        },
        stats,
        flags,
        at: safe.at || safe.sceneId || "scene_001",
        currentBeat: safe.pending?.beatTag || safe.pending?.beat || "unknown",
        last3Beats,
        lastStory: (safe.pending?.text || "").slice(0, 420),
        lastChoices: lastChoices.map(c => ({ id: c.id, label: c.label })).slice(0, 3),
        picked: picked || null,
        canonBeats: CANON_BEATS
    };
}

/* ===============================
  Handler
================================ */
export default async function handler(req, res) {
    setCors(res);

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    let body = req.body;
    // Vercel에서 body가 문자열로 들어오는 경우 대비
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = null; }
    }

    const state = body?.state || null;
    const picked = body?.picked || null;

    const promptPayload = summarizeState(state, picked);

    const userPrompt = `
다음 JSON은 현재 게임 상태 요약이다. 이를 바탕으로 다음 장면을 생성하라.
- 원작 비트 흐름을 유지하되, 현재 beat에서 다음 beat로 자연스럽게 전진하라.
- last3Beats와 유사한 상황 반복 금지.
- 이번 턴에만 유효한 3개 선택지(A/B/C)를 생성하라(서로 성격이 확 다르게).
- stats는 선택/상황에 따라 소폭 변동 가능(0~10 범위 유지).
- beatTag는 이번 장면의 핵심 비트를 한 단어로.
- mood는 주인공의 표정(중립/기쁨/분노/겁/생각 중) 중 하나.
- text는 6~10문장, 사건을 한 단계 전진시킨다.
상태 요약:
${JSON.stringify(promptPayload)}
`;

    try {
        const result = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: userPrompt,
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.9,
                topP: 0.9,
                maxOutputTokens: 900,
                responseMimeType: "application/json",
                responseSchema: RESPONSE_SCHEMA
            }
        });

        // SDK 응답에서 텍스트 얻기(환경마다 접근자가 조금 다를 수 있어 안전하게)
        const text =
            result?.text ??
            result?.response?.text?.() ??
            result?.response?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ??
            "";

        const parsed = (() => {
            try { return JSON.parse(text); } catch { return extractJson(text); }
        })();

        if (!parsed) {
            return res.status(502).json({ error: "Bad model output", raw: String(text).slice(0, 800) });
        }

        const normalized = normalizePayload(parsed, state);

        return res.status(200).json(normalized);
    } catch (err) {
        console.error(err);
        return res.status(500).json({
            error: "Story generation failed",
            detail: String(err?.message || err)
        });
    }
}
