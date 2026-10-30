// Background service worker. Acts as a message broker between
// content script (DOM injector) and the Anthropic API.

import { ensureInstalled, appendLog, updateLogEntry, getStyles, recordChoice, recordRejectAll } from "../lib/storage.js";
import { generateReplies } from "../lib/anthropic.js";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureInstalled();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // chrome.runtime.onMessage requires returning true and using sendResponse
  // for async work.
  (async () => {
    try {
      if (msg.type === "GET_STYLES") {
        sendResponse({ ok: true, styles: await getStyles() });
        return;
      }

      if (msg.type === "GENERATE") {
        const { styleId, post, parentPost, length } = msg;
        const logId = crypto.randomUUID();
        await appendLog({
          id: logId,
          styleId,
          length: length || "normal",
          post,
          parentPost: parentPost || null,
          variants: [],
          chosen: null,
          status: "pending"
        });

        try {
          const { variants, model, usage } = await generateReplies({
            styleId,
            post,
            parentPost,
            length
          });
          await updateLogEntry(logId, { variants, model, usage, status: "ok" });
          sendResponse({ ok: true, logId, variants });
        } catch (e) {
          await updateLogEntry(logId, { status: "error", error: String(e.message || e) });
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        return;
      }

      if (msg.type === "RECORD_CHOICE") {
        // 1. Mark the log entry.
        await updateLogEntry(msg.logId, { chosen: msg.chosen });

        // 2. Teach the style: chosen variant becomes a new example,
        // rejected variants are kept beside it as negative contrast.
        const log = (await chrome.storage.local.get("replyLog")).replyLog || [];
        const entry = log.find((e) => e.id === msg.logId);
        if (entry && Array.isArray(entry.variants)) {
          const textOf = (v) => (typeof v === "string" ? v : v && v.text) || "";
          const chosenText = textOf(entry.variants[msg.chosen]);
          const rejectedTexts = entry.variants
            .filter((_, i) => i !== msg.chosen)
            .map(textOf)
            .filter(Boolean);
          if (chosenText) {
            await recordChoice({
              styleId: entry.styleId,
              post: entry.post,
              parentPost: entry.parentPost,
              chosen: chosenText,
              rejected: rejectedTexts
            });
          }
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "RECORD_REJECT_ALL") {
        await updateLogEntry(msg.logId, { chosen: -1 });

        const log = (await chrome.storage.local.get("replyLog")).replyLog || [];
        const entry = log.find((e) => e.id === msg.logId);
        if (entry && Array.isArray(entry.variants)) {
          const textOf = (v) => (typeof v === "string" ? v : v && v.text) || "";
          const allTexts = entry.variants.map(textOf).filter(Boolean);
          await recordRejectAll({
            styleId: entry.styleId,
            post: entry.post,
            parentPost: entry.parentPost,
            rejected: allTexts
          });
        }
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();

  return true; // keep the message channel open for async sendResponse
});
