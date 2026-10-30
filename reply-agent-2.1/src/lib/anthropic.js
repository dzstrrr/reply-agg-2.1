// Call to the Anthropic Messages API from the background worker.
//
// Two transports:
//   direct  - straight to api.anthropic.com with the user's key
//   gateway - to a Worker the user runs, with a per-profile token
//
// The gateway exists because an antidetect browser routes every request
// through the profile proxy, and Anthropic answers many proxy exit IPs with
// 403 "Request not allowed". An extension cannot opt out of the browser
// proxy, so the call goes somewhere that isn't geo-restricted instead.
// It also keeps the Anthropic key out of every cloned browser profile.

import { buildSystemBlocks, buildUserMessage, filterForbidden } from "./prompts.js";
import { get, getGlobalForbidden, getStyle } from "./storage.js";
import {
  STORAGE_KEYS,
  DEFAULT_MODEL,
  DEFAULT_INCLUDE_UK,
  MAX_TOKENS_BY_LENGTH,
  DIRECT_ENDPOINT
} from "./defaults.js";

async function resolveTransport() {
  const endpoint = ((await get(STORAGE_KEYS.ENDPOINT)) || "").trim();

  if (!endpoint || endpoint === DIRECT_ENDPOINT) {
    const apiKey = await get(STORAGE_KEYS.API_KEY);
    if (!apiKey) {
      throw new Error("API key is not set. Open the extension popup and add it under Settings.");
    }
    return {
      url: DIRECT_ENDPOINT,
      via: "direct",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      }
    };
  }

  const token = ((await get(STORAGE_KEYS.GATEWAY_TOKEN)) || "").trim();
  if (!token) {
    throw new Error("Gateway endpoint is set but the gateway token is empty. Add it under Settings.");
  }
  return {
    url: endpoint,
    via: "gateway",
    headers: { "Content-Type": "application/json", "x-ra-token": token }
  };
}

export async function generateReplies({ styleId, post, parentPost, length }) {
  const transport = await resolveTransport();

  const model = (await get(STORAGE_KEYS.MODEL)) || DEFAULT_MODEL;
  const language = (await get(STORAGE_KEYS.LANGUAGE)) || "auto";
  const includeUkRaw = await get(STORAGE_KEYS.INCLUDE_UK);
  const includeUk = includeUkRaw === undefined ? DEFAULT_INCLUDE_UK : !!includeUkRaw;
  const style = await getStyle(styleId);
  if (!style) throw new Error(`Style "${styleId}" not found.`);

  const globalForbidden = await getGlobalForbidden();
  const system = buildSystemBlocks({
    style,
    globalForbidden,
    language,
    length: length || "normal",
    includeUk
  });
  const userMessage = buildUserMessage({ post, parentPost });

  const body = {
    model,
    // Scaled to the tier so a runaway response can't cost 5x what it should.
    max_tokens: MAX_TOKENS_BY_LENGTH[length] || MAX_TOKENS_BY_LENGTH.normal,
    system,
    messages: [{ role: "user", content: userMessage }]
  };

  let res;
  try {
    res = await fetch(transport.url, {
      method: "POST",
      headers: transport.headers,
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error(
      `Network error reaching ${new URL(transport.url).host}: ${e.message || e}`
    );
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403 && /request not allowed/i.test(text)) {
      throw new Error(
        "403 Request not allowed \u2014 this is an IP block, not a bad key. This browser " +
          "profile's proxy exit is refused by Anthropic. Set a gateway under " +
          "Settings \u2192 API endpoint, or run the profile without a proxy."
      );
    }
    throw new Error(`API ${res.status} (${transport.via}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (e) {
    throw new Error(`Failed to parse model output as JSON: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed.variants)) {
    throw new Error("Model output missing 'variants' array.");
  }

  // Normalize: accept both object shape {text, uk} and legacy string shape.
  const normalized = parsed.variants.map((v) =>
    typeof v === "string" ? { text: v, uk: "" } : { text: String(v.text || ""), uk: String(v.uk || "") }
  );

  // Final safety net: drop variants that snuck in forbidden words.
  const allForbidden = [...globalForbidden, ...(style.forbiddenWords || [])];
  const clean = filterForbidden(normalized, allForbidden);
  // If filtering killed everything, fall back to the raw set so the user
  // still sees something (and can decide manually).
  const variants = clean.length ? clean : normalized;

  return {
    variants: variants.slice(0, 3),
    model,
    via: transport.via,
    usage: readUsage(data.usage)
  };
}

// The API reports cache hits separately. Without recording this there's no way
// to tell whether the split prompt is actually being reused.
function readUsage(u) {
  if (!u) return null;
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0
  };
}

// Models occasionally wrap JSON in prose or fences despite instructions.
// Extract the first { ... } block.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}
