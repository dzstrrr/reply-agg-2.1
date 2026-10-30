// Default styles, taken from the screenshot.
// Stored once on first install, then editable from the popup.

export const DEFAULT_STYLES = [
  {
    id: "chill",
    name: "chill",
    prompt: "casual, relaxed, low-energy",
    examples: [],
    forbiddenWords: []
  },
  {
    id: "smart",
    name: "smart",
    prompt: "one sharp observation, insightful, no buzzwords",
    examples: [],
    forbiddenWords: []
  },
  {
    id: "provocative",
    name: "provocative",
    prompt: "slightly challenging, push back, disagree politely",
    examples: [],
    forbiddenWords: []
  },
  {
    id: "funny",
    name: "funny",
    prompt: "light humor, dry wit, no forced jokes",
    examples: [],
    forbiddenWords: []
  },
  {
    id: "alpha",
    name: "alpha",
    prompt: "confident, slightly cocky, direct",
    examples: [],
    forbiddenWords: []
  }
];

export const STORAGE_KEYS = {
  API_KEY: "apiKey",
  MODEL: "model",
  LANGUAGE: "language",
  STYLES: "styles",
  GLOBAL_FORBIDDEN: "globalForbiddenWords",
  LOG: "replyLog",
  INSTALLED: "installed",
  // Style locked to THIS Chrome profile. Empty string = show the picker.
  ACTIVE_STYLE: "activeStyle",
  DEFAULT_LENGTH: "defaultLength",
  INCLUDE_UK: "includeUk",
  // Gateway. Leave ENDPOINT empty to call api.anthropic.com directly.
  ENDPOINT: "endpoint",
  GATEWAY_TOKEN: "gatewayToken"
};

export const DIRECT_ENDPOINT = "https://api.anthropic.com/v1/messages";

export const DEFAULT_MODEL = "claude-haiku-4-5";
export const DEFAULT_LANGUAGE = "auto"; // "auto" = match the post's language
export const DEFAULT_LENGTH = "normal"; // short | normal | long

// How many examples of each kind go into the prompt.
// Manual examples define the voice, so they always get a reserved slot —
// otherwise auto-learned ones push them out and the model learns from itself.
export const PROMPT_MANUAL_EXAMPLES = 10;
export const PROMPT_AUTO_EXAMPLES = 15;

// Log cap. chrome.storage.local is ~10MB and we have no unlimitedStorage
// permission, so a huge log silently starves the styles bank.
export const LOG_CAP = 300;

// ---------- Token budget ----------
//
// Output tokens cost 5x input, so the Ukrainian translation under every
// variant is the single most expensive line item: it roughly doubles the
// output of each call. Off by default; turn it on in Settings.
export const DEFAULT_INCLUDE_UK = false;

// Example posts get truncated — the reply teaches the voice, the post is
// only there as context for what the reply was answering.
export const EXAMPLE_POST_MAX_CHARS = 220;
export const PARENT_POST_MAX_CHARS = 400;

// Rejected alternatives triple the size of an auto example. Keep them only
// on the most recent ones, where the contrast signal is still fresh.
export const REJECTED_KEEP_LAST = 5;

// Output ceiling per length tier. Prevents a runaway response from costing
// 5x what it should.
export const MAX_TOKENS_BY_LENGTH = { short: 300, normal: 500, long: 900 };

// Haiku 4.5, USD per million tokens. Used only for the cost estimate in the
// popup — update if you switch models.
export const PRICING_PER_MTOK = {
  input: 1.0,
  output: 5.0,
  cacheRead: 0.1,
  cacheWrite: 1.25
};
