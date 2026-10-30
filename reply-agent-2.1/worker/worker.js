// Reply Agent gateway — Cloudflare Worker.
//
// Why this exists: an antidetect browser applies the profile proxy to ALL
// traffic, including api.anthropic.com, and offers no per-domain bypass.
// Anthropic refuses many proxy exit IPs with 403 "Request not allowed".
// The extension can't opt out of the browser proxy, so it talks to this
// Worker instead, which calls Anthropic from Cloudflare's own IP.
//
// It also means the Anthropic key lives in exactly one place instead of
// being copied into every browser profile.
//
// Deploy:
//   npx wrangler login
//   npx wrangler deploy
//   npx wrangler secret put ANTHROPIC_API_KEY
//   npx wrangler secret put RA_TOKENS      # cz1:token-one,cz2:token-two
//
// Optional per-token daily cap: bind a KV namespace RA_KV and set
// RA_DAILY_LIMIT (see wrangler.toml).

const UPSTREAM = "https://api.anthropic.com/v1/messages";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-ra-token",
  "Access-Control-Max-Age": "86400"
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS }
  });

// "cz1:token-a,cz2:token-b" -> Map(token -> label)
function parseTokens(raw) {
  const map = new Map();
  for (const pair of String(raw || "").split(",")) {
    const i = pair.indexOf(":");
    if (i < 0) continue;
    const label = pair.slice(0, i).trim();
    const token = pair.slice(i + 1).trim();
    if (label && token) map.set(token, label);
  }
  return map;
}

// Compare against every token so a wrong one doesn't return faster.
function lookupToken(map, token) {
  let found = null;
  for (const [t, label] of map) {
    let diff = t.length ^ token.length;
    for (let i = 0; i < Math.max(t.length, token.length); i++) {
      diff |= (t.charCodeAt(i) || 0) ^ (token.charCodeAt(i) || 0);
    }
    if (diff === 0) found = label;
  }
  return found;
}

async function underDailyLimit(env, label) {
  const limit = Number(env.RA_DAILY_LIMIT || 0);
  if (!limit || !env.RA_KV) return { ok: true };
  const day = new Date().toISOString().slice(0, 10);
  const key = `count:${label}:${day}`;
  const used = Number((await env.RA_KV.get(key)) || 0);
  if (used >= limit) return { ok: false, used, limit };
  await env.RA_KV.put(key, String(used + 1), { expirationTtl: 172800 });
  return { ok: true };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "POST") {
      return json({ error: { type: "invalid_request", message: "POST only" } }, 405);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json(
        { error: { type: "config", message: "ANTHROPIC_API_KEY secret is not set on the Worker" } },
        500
      );
    }

    const token = request.headers.get("x-ra-token") || "";
    const label = lookupToken(parseTokens(env.RA_TOKENS), token);
    if (!label) {
      return json({ error: { type: "forbidden", message: "Unknown or missing gateway token" } }, 401);
    }

    const cap = await underDailyLimit(env, label);
    if (!cap.ok) {
      return json(
        {
          error: {
            type: "rate_limit",
            message: `Daily limit reached for "${label}": ${cap.used}/${cap.limit}`
          }
        },
        429
      );
    }

    const body = await request.text();

    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body
      });
    } catch (e) {
      return json({ error: { type: "upstream", message: String(e) } }, 502);
    }

    const text = await upstream.text();
    // Pass the upstream status through unchanged so the extension keeps
    // showing real Anthropic errors rather than a generic gateway one.
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json", ...CORS }
    });
  }
};
