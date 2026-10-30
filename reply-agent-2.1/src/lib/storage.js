// Thin wrapper around chrome.storage.local.
// Everything lives in one place so we can swap to a backend later
// without rewriting callers.

import {
  STORAGE_KEYS,
  DEFAULT_STYLES,
  DEFAULT_MODEL,
  DEFAULT_LANGUAGE,
  DEFAULT_LENGTH,
  LOG_CAP
} from "./defaults.js";

export async function get(key) {
  const res = await chrome.storage.local.get(key);
  return res[key];
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getAll() {
  return await chrome.storage.local.get(null);
}

// Seed defaults on first install.
export async function ensureInstalled() {
  const installed = await get(STORAGE_KEYS.INSTALLED);
  if (installed) return;
  await set(STORAGE_KEYS.STYLES, DEFAULT_STYLES);
  await set(STORAGE_KEYS.MODEL, DEFAULT_MODEL);
  await set(STORAGE_KEYS.LANGUAGE, DEFAULT_LANGUAGE);
  await set(STORAGE_KEYS.GLOBAL_FORBIDDEN, []);
  await set(STORAGE_KEYS.LOG, []);
  await set(STORAGE_KEYS.DEFAULT_LENGTH, DEFAULT_LENGTH);
  await set(STORAGE_KEYS.ACTIVE_STYLE, ""); // "" = ask every time
  await set(STORAGE_KEYS.INSTALLED, true);
}

// ---------- Active style (locked per Chrome profile) ----------
//
// chrome.storage.local is scoped to the profile, so each browser gets its own
// value with no syncing. Do NOT move this to chrome.storage.sync — profiles
// signed into the same Google account would fight over it.

export async function getActiveStyleId() {
  return (await get(STORAGE_KEYS.ACTIVE_STYLE)) || "";
}

export async function setActiveStyleId(id) {
  await set(STORAGE_KEYS.ACTIVE_STYLE, id || "");
}

export async function getDefaultLength() {
  return (await get(STORAGE_KEYS.DEFAULT_LENGTH)) || DEFAULT_LENGTH;
}

export async function getStyles() {
  return (await get(STORAGE_KEYS.STYLES)) || DEFAULT_STYLES;
}

export async function getStyle(id) {
  const styles = await getStyles();
  return styles.find((s) => s.id === id) || null;
}

export async function saveStyles(styles) {
  await set(STORAGE_KEYS.STYLES, styles);
}

export async function upsertStyle(style) {
  const styles = await getStyles();
  const idx = styles.findIndex((s) => s.id === style.id);
  if (idx >= 0) styles[idx] = style;
  else styles.push(style);
  await saveStyles(styles);
}

export async function deleteStyle(id) {
  const styles = await getStyles();
  await saveStyles(styles.filter((s) => s.id !== id));
  // If the deleted style was locked to this profile, fall back to the picker
  // instead of leaving a dangling id that fails on every generation.
  if ((await getActiveStyleId()) === id) await setActiveStyleId("");
}

// Auto-add the chosen variant to the style's examples bank, with the
// two rejected variants attached so the model sees the contrast next time.
// Manual examples are never pruned; auto examples are capped at AUTO_CAP
// (oldest auto entries drop off when over the cap).
const AUTO_CAP = 60;

const isAutoExample = (e) => e.source === "auto" || e.source === "rejected_all";

// Shared by both recorders so the manual/auto split can't drift apart.
async function pushExample(styleId, entry) {
  const styles = await getStyles();
  const idx = styles.findIndex((s) => s.id === styleId);
  if (idx < 0) return;
  const style = styles[idx];
  if (!Array.isArray(style.examples)) style.examples = [];

  style.examples.push({ ...entry, ts: Date.now() });

  const manual = style.examples.filter((e) => !isAutoExample(e));
  const autos = style.examples.filter(isAutoExample);
  if (autos.length > AUTO_CAP) autos.splice(0, autos.length - AUTO_CAP);
  style.examples = [...manual, ...autos];

  styles[idx] = style;
  await saveStyles(styles);
}

export async function recordChoice({ styleId, post, parentPost, chosen, rejected }) {
  await pushExample(styleId, {
    post,
    parentPost: parentPost || null,
    reply: chosen,
    rejected: (rejected || []).filter(Boolean),
    source: "auto"
  });
}

// Called when the user dismisses all 3 variants ("Nothing fits").
// Saves the post + all 3 rejected variants as a negative-only example,
// so next time the model sees that "for this kind of post, those tones
// were all wrong".
export async function recordRejectAll({ styleId, post, parentPost, rejected }) {
  await pushExample(styleId, {
    post,
    parentPost: parentPost || null,
    reply: null,
    rejected: (rejected || []).filter(Boolean),
    source: "rejected_all"
  });
}

export async function getGlobalForbidden() {
  return (await get(STORAGE_KEYS.GLOBAL_FORBIDDEN)) || [];
}

export async function appendLog(entry) {
  const log = (await get(STORAGE_KEYS.LOG)) || [];
  log.unshift({ ...entry, ts: Date.now() });
  // Cap the log — storage.local is ~10MB and shared with the styles bank.
  if (log.length > LOG_CAP) log.length = LOG_CAP;
  await set(STORAGE_KEYS.LOG, log);
}

export async function updateLogEntry(id, patch) {
  const log = (await get(STORAGE_KEYS.LOG)) || [];
  const idx = log.findIndex((e) => e.id === id);
  if (idx >= 0) {
    log[idx] = { ...log[idx], ...patch };
    await set(STORAGE_KEYS.LOG, log);
  }
}

export async function clearLog() {
  await set(STORAGE_KEYS.LOG, []);
}
