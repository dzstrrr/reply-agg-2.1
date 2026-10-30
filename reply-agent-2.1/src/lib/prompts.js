// Build the system blocks + user message for the Anthropic call.
//
// The system prompt is split into three blocks, ordered most-stable first,
// so that a cache breakpoint can sit at the largest stable boundary:
//
//   [0] CORE      identical for every style and every request
//   [1] STYLE     name, description, forbidden list, manual examples
//                 -> cache_control sits here
//   [2] REQUEST   length rule, language rule, auto-learned examples
//
// Only blocks 0+1 form the cached prefix. Auto examples are deliberately
// kept out of it: they change after every pick, and a prefix that changes
// every call can never be reused.

import {
  PROMPT_MANUAL_EXAMPLES,
  PROMPT_AUTO_EXAMPLES,
  EXAMPLE_POST_MAX_CHARS,
  PARENT_POST_MAX_CHARS,
  REJECTED_KEEP_LAST
} from "./defaults.js";

function uniq(arr) {
  return [...new Set(arr.map((w) => w.trim()).filter(Boolean))];
}

function truncate(text, max) {
  const t = String(text || "").trim();
  return t.length <= max ? t : t.slice(0, max).trimEnd() + "\u2026";
}

const LENGTH_LINES = {
  short:
    "Each reply must be 2\u20136 words. A fragment or a short phrase, not a full sentence. " +
    "No punctuation at the end unless it's a question mark. " +
    'Examples of this length: "didn\'t ask", "this you?", "brave of you", "sounds like a you problem".',
  normal:
    "Each reply must be ONE or at most TWO short sentences, roughly 40\u2013120 characters. " +
    "Tight, punchy, no filler. " +
    'Examples of this length: "this is the worst take I\'ve read today", "It\'s definitely NOT because I used it".',
  long:
    "Keep each reply under 280 characters. You have room to develop one thought properly \u2014 " +
    "but it is still ONE point, not a list and not an essay."
};

const isAutoExample = (e) => e.source === "auto" || e.source === "rejected_all";

// Manual examples define the voice. Auto ones are the model's own output that
// the user approved, so letting them fill the whole budget makes the model
// train on itself and the voice drifts.
export function splitExamples(examples) {
  const all = Array.isArray(examples) ? examples : [];
  return {
    manual: all.filter((e) => !isAutoExample(e)).slice(-PROMPT_MANUAL_EXAMPLES),
    auto: all.filter(isAutoExample).slice(-PROMPT_AUTO_EXAMPLES)
  };
}

// `withRejected` = how many of the most recent entries keep their rejected
// alternatives. The rest are trimmed to post + reply.
function renderExamples(list, withRejected) {
  const lines = [];
  const cut = Math.max(0, list.length - withRejected);
  list.forEach((ex, i) => {
    lines.push("");
    lines.push(`Post: ${truncate(ex.post, EXAMPLE_POST_MAX_CHARS)}`);
    if (ex.reply) lines.push(`Reply: ${ex.reply}`);
    if (i >= cut && ex.rejected && ex.rejected.length) {
      for (const r of ex.rejected) lines.push(`Rejected alternative: ${r}`);
    }
  });
  return lines;
}

// ---------- Block 0: static core ----------
// Never interpolates anything. Byte-identical on every request, for every
// style, in every browser profile.

function coreBlock(includeUk) {
  const format = includeUk
    ? [
        "Output format: respond with ONLY a JSON object of the form",
        '{"variants": [{"text": "reply 1", "uk": "Ukrainian translation 1"}, {"text": "reply 2", "uk": "..."}, {"text": "reply 3", "uk": "..."}]}',
        'The "text" field is the reply itself. The "uk" field is a faithful Ukrainian translation of that reply, preserving tone. If the reply is already in Ukrainian, set "uk" to an empty string.'
      ]
    : [
        "Output format: respond with ONLY a JSON object of the form",
        '{"variants": [{"text": "reply 1"}, {"text": "reply 2"}, {"text": "reply 3"}]}',
        'Each "text" field is one reply. Do not add any other fields.'
      ];

  return [
    "You are a reply ghostwriter for X / Twitter.",
    "You write replies in the user's own voice, never generic.",
    "",
    "Hard rules:",
    "- Output 3 distinct reply variants. They should differ in angle, not just wording.",
    "- Each variant is one reply, ready to post. No quotes around it, no labels, no numbering.",
    "- Do not start with the poster's @handle.",
    "- Do not use hashtags unless the post itself uses them and one feels natural.",
    '- Sound like a real person. No corporate tone. No motivational filler. No "Great point!".',
    "",
    ...format,
    "No prose before or after the JSON."
  ].join("\n");
}

// ---------- Block 1: the style ----------
// Changes only when the user edits the style in the popup. This is the block
// the cache breakpoint is attached to.

function styleBlock(style, globalForbidden, manualExamples) {
  const forbidden = uniq([...(globalForbidden || []), ...(style.forbiddenWords || [])]);
  const lines = [`Style name: ${style.name}`, `Style description: ${style.prompt}`];

  if (forbidden.length) {
    lines.push(
      "",
      `Never use these words or phrases (case-insensitive): ${forbidden.join(", ")}.`
    );
  }

  if (manualExamples.length) {
    lines.push("", "Examples of how the user replies in this style.");
    lines.push(...renderExamples(manualExamples, manualExamples.length));
  }

  return lines.join("\n");
}

// ---------- Block 2: this request ----------
// Length, language and auto-learned examples. Changes constantly, so it sits
// after the breakpoint.

function requestBlock(language, length, autoExamples) {
  const langLine =
    language === "uk"
      ? "Write the reply in Ukrainian."
      : language === "en"
      ? "Write the reply in English."
      : "Write the reply in the same language as the post.";

  const lines = [
    "Constraints for this reply:",
    `- ${LENGTH_LINES[length] || LENGTH_LINES.normal}`,
    `- ${langLine}`
  ];

  if (autoExamples.length) {
    lines.push(
      "",
      "Recent replies the user picked in this style.",
      "Where rejected alternatives are shown, the user saw them and chose the Reply over them \u2014 avoid the tone of the rejected ones.",
      "Where ONLY rejected alternatives are shown, the user found none of them acceptable for that kind of post \u2014 strongly avoid those patterns."
    );
    lines.push(...renderExamples(autoExamples, REJECTED_KEEP_LAST));
  }

  lines.push("", "Respond with ONLY the JSON object described above.");
  return lines.join("\n");
}

// Returns the `system` array for the Messages API. The cache breakpoint is
// always set: below the model's minimum cacheable length the API just ignores
// it at no extra cost, and it starts paying off by itself once a style grows
// past the threshold.
export function buildSystemBlocks({
  style,
  globalForbidden,
  language,
  length,
  includeUk,
  cache = true
}) {
  const { manual, auto } = splitExamples(style.examples);

  const stable = { type: "text", text: styleBlock(style, globalForbidden, manual) };
  if (cache) stable.cache_control = { type: "ephemeral" };

  return [
    { type: "text", text: coreBlock(includeUk) },
    stable,
    { type: "text", text: requestBlock(language, length, auto) }
  ];
}

export function buildUserMessage({ post, parentPost }) {
  if (parentPost) {
    return [
      "Parent post (context, do not reply to this one):",
      truncate(parentPost, PARENT_POST_MAX_CHARS),
      "",
      "Post to reply to:",
      post
    ].join("\n");
  }
  return `Post to reply to:\n${post}`;
}

// Whole-word match. A plain substring check would make "ai" kill "said" and
// "again". \b is ASCII-only in JS, so we use Unicode lookarounds instead —
// this works for Cyrillic too.
function forbiddenRegex(word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu");
  } catch (e) {
    return new RegExp(`\\b${esc}\\b`, "i");
  }
}

export function filterForbidden(variants, forbidden) {
  if (!forbidden || !forbidden.length) return variants;
  const patterns = uniq(forbidden).map(forbiddenRegex);
  return variants.filter((v) => {
    const text = String(v.text || "");
    return !patterns.some((re) => re.test(text));
  });
}
