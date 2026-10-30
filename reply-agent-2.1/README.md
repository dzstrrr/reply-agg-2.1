# Reply Agent 2.1

A Chrome extension that suggests three reply variants in your own voice under any post on X / Twitter, using Claude Haiku 4.5.

## How it works

Open `x.com`. Under each post in your feed, a small **RA** button appears next to the reply/repost/like row. If you've locked a style to this browser it shows as **RA · stylename** and one click generates straight away; otherwise it opens a style picker first. Three variants generate in 2–3 seconds → click the one you like. It's copied to the clipboard and the native reply composer opens. Paste with Ctrl+V (Cmd+V on Mac) and post.

The post text is read directly from your open tab — no scraping, no external requests to X.

## Install (developer mode)

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select the `reply-agent` folder.
5. Click the puzzle-piece icon in Chrome's toolbar, pin **Reply Agent**.
6. Click the Reply Agent icon → **Settings** tab → paste your Anthropic API key → **Save**. (Behind an antidetect browser with a proxy, use the gateway instead — see below.)

Get an API key at <https://console.anthropic.com>. The key is stored locally in `chrome.storage` and sent only to `api.anthropic.com`.

## Settings tabs

- **Styles** — five styles ship preinstalled. Click any to edit its prompt, forbidden words, or examples. Click **+ New style** to add your own. **Active style in this browser** locks one style to this Chrome profile: RA then generates instantly with it and skips the picker. The lock lives in `chrome.storage.local`, so every browser profile has its own — nothing is synced. Set it to *Ask every time* to get the picker back.
- **Settings → Default length** — which of the three lengths a locked style uses. You can still switch length per reply from the chips under the variants.
- **Forbidden** — a global list of words/phrases the model will be told never to use, plus a post-generation filter as a safety net. Per-style forbidden lists live inside each style.
- **Log** — every generation is stored locally: post text, style, three variants, which one you picked, and the token usage reported by the API. A summary at the top totals input/output tokens, cache hits and estimated cost. Export as JSON to review what worked.
- **Settings** — API key or gateway endpoint + token, model name, default reply language, default reply length, Ukrainian translation toggle.

## Reply length

Three tiers, picked per reply or set as a default in Settings:

- **short** — 2–6 words. A fragment, not a sentence.
- **normal** — one or two short sentences, 40–120 characters.
- **long** — up to 280 characters, one developed thought.

## Examples format

Examples teach a style more than a prompt description does. Add 5–15 per style.

Examples are of two kinds. **Manual** ones are what you wrote or imported — they define the voice. **Auto** ones are variants you picked, saved automatically. The prompt always reserves room for the last 10 manual examples plus the last 15 auto ones, so auto-learning can never push your hand-written examples out. (Before v0.5 it could, and the model slowly drifted into imitating its own output.)

Add examples three ways from the style editor:
- **Add example** button — paste one post/reply pair at a time.
- **Import JSON** — upload a file like `examples/examples.example.json`.

The importer accepts three file shapes:

```json
// Shape 1 — per-style file
{ "style": "chill", "examples": [{ "post": "...", "reply": "..." }] }

// Shape 2 — all styles in one file
{ "chill": [{ "post": "...", "reply": "..." }], "smart": [...] }

// Shape 3 — raw array, applied to the style you're editing
[{ "post": "...", "reply": "..." }]
```

## Running behind an antidetect browser / proxy

An antidetect browser (Dolphin Anty and friends) applies the profile's proxy to **all** traffic, including `api.anthropic.com`, and has no per-domain bypass. Anthropic refuses many proxy exit IPs with:

```
403 {"error":{"type":"forbidden","message":"Request not allowed"}}
```

That is an IP block, not a bad key — an invalid key returns 401 instead. Confirm it by running the same extension with the same key in a normal browser without a proxy: if that works, it's the proxy.

The extension cannot opt out of the browser proxy, so route the call somewhere that isn't geo-restricted. Deploy `worker/worker.js` to Cloudflare (free tier is 100k requests/day):

```
cd worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put ANTHROPIC_API_KEY     # your sk-ant-... key
npx wrangler secret put RA_TOKENS             # cz1:token-one,cz2:token-two
```

Test it before touching any browser:

```
curl -X POST https://your-url.workers.dev \
  -H "content-type: application/json" \
  -H "x-ra-token: YOUR_TOKEN" \
  -d '{"model":"claude-haiku-4-5","max_tokens":20,"messages":[{"role":"user","content":"say hi"}]}'
```

`401` means the token doesn't match `RA_TOKENS`; `500` means the API key secret didn't land.

Then in each profile: popup → **Settings** → **API endpoint** = the Worker URL, **Gateway token** = that profile's token, and clear the Anthropic API key field. The header shows `model · gateway` once it's wired up.

`RA_TOKENS` is a comma-separated list of `label:token` pairs, one per browser profile. Separate tokens mean you can revoke one profile without touching the rest, and the Anthropic key never leaves the Worker — so cloning a Dolphin profile no longer clones your key. Optionally bind a KV namespace `RA_KV` and set `RA_DAILY_LIMIT` for a per-token daily cap (see `wrangler.toml`).

Leave **API endpoint** blank on any profile without a proxy to go straight to Anthropic.

## After Chrome updates

Sometimes X changes how its DOM is laid out and the **RA** button stops appearing. The selectors live in `src/content/content.js` (look for `data-testid="tweet"` and `role="group"`). Most fixes are one-line.

## Configuration reference

See `.env.example` for the list of settings. Chrome extensions can't read `.env` files directly — paste values into the popup's Settings tab.

## Cost and the split prompt

Haiku 4.5 is $1 per million input tokens and $5 per million output tokens — **output is 5x more expensive than input**, which is what the defaults are tuned around.

The system prompt is sent as three separate blocks, ordered most-stable first:

| Block | Contents | Changes when |
| --- | --- | --- |
| 0 · core | Role, generic rules, output format | Never |
| 1 · style | Name, description, forbidden list, manual examples | You edit the style |
| 2 · request | Length rule, language rule, auto-learned examples | Every call |

A `cache_control` breakpoint sits at the end of block 1, so blocks 0+1 form a cache prefix. Auto-learned examples are deliberately kept out of it — they change after every pick, and a prefix that changes every call can never be reused.

**Caching will not actually fire until a style is large.** Claude Haiku 4.5 has a minimum cacheable prefix of 4,096 tokens; a typical style with ~10 manual examples produces a prefix of roughly 900. Below the minimum the breakpoint is simply ignored at no extra cost, and it starts paying off on its own (cache reads are $0.10/M instead of $1/M) once a style grows past the threshold — realistically 50+ manual examples. Check the **Log** tab: it reports whether the cache was hit.

What actually reduces cost today, in order of size:

- **Ukrainian translation off** (Settings, off by default) — it roughly doubles output tokens, the expensive side. Worth ~20% of total cost on its own.
- **Rejected alternatives trimmed** — only the 5 most recent auto examples carry them; they triple an example's size.
- **Example posts truncated** to 220 characters. The reply teaches the voice; the post is only context.
- **`max_tokens` scaled per length tier** (300 / 500 / 900) so a runaway response can't cost 5x what it should.

Measured on a style with 10 manual and 25 auto examples: about $4.30 per 1,000 generations before, about $2.70 after with translation off — roughly 37% less. The **Log** tab shows real totals from the API rather than estimates.

## Status

v2.1. Working: button injection, style picker, three variants with Ukrainian translation under each, copy + open composer, forbidden words (prompt + filter), reply log, examples import, automatic learning from picks, "Nothing fits" button for negative feedback, per-profile style lock, three length tiers, whole-word forbidden matching, split cache-aware prompt with token accounting, optional Cloudflare Worker gateway for proxied profiles. Not yet built: semantic example retrieval (picks most relevant examples instead of last N), image/media context, automatic style suggestion.
