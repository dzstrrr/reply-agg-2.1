// Popup logic. Wires the settings UI to chrome.storage.

import {
  ensureInstalled,
  get,
  set,
  getAll,
  getStyles,
  saveStyles,
  upsertStyle,
  deleteStyle,
  getGlobalForbidden,
  getActiveStyleId,
  setActiveStyleId,
  clearLog
} from "../lib/storage.js";
import {
  STORAGE_KEYS,
  DEFAULT_MODEL,
  DEFAULT_LENGTH,
  DEFAULT_INCLUDE_UK,
  PRICING_PER_MTOK
} from "../lib/defaults.js";

// ---------- Tabs ----------

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("is-active"));
    document.querySelectorAll(".panel").forEach((x) => x.classList.remove("is-active"));
    t.classList.add("is-active");
    document.querySelector(`.panel[data-panel="${t.dataset.tab}"]`).classList.add("is-active");
  });
});

// ---------- Detached mode (so popup doesn't auto-close) ----------

const params = new URLSearchParams(location.search);
const isDetached = params.get("detached") === "1";

if (isDetached) {
  document.body.classList.add("detached");
  document.getElementById("open-window").hidden = true;
} else {
  document.getElementById("open-window").addEventListener("click", () => {
    chrome.windows.create({
      url: chrome.runtime.getURL("src/popup/popup.html") + "?detached=1",
      type: "popup",
      width: 480,
      height: 760
    });
    window.close();
  });
}

// ---------- Boot ----------

async function boot() {
  await ensureInstalled();
  await loadSettings();
  await renderStyles();
  await renderForbidden();
  await renderLog();
  await renderHeaderMeta();
}

async function renderHeaderMeta() {
  const apiKey = await get(STORAGE_KEYS.API_KEY);
  const endpoint = ((await get(STORAGE_KEYS.ENDPOINT)) || "").trim();
  const token = ((await get(STORAGE_KEYS.GATEWAY_TOKEN)) || "").trim();
  const model = (await get(STORAGE_KEYS.MODEL)) || DEFAULT_MODEL;

  // With a gateway there is no local API key, so the key alone can't say
  // whether the extension is configured.
  let meta;
  if (endpoint) meta = token ? `${model} \u00b7 gateway` : "gateway: no token";
  else meta = apiKey ? model : "no api key";
  document.getElementById("hdr-meta").textContent = meta;
}

// ---------- Settings ----------

async function loadSettings() {
  const all = await getAll();
  document.getElementById("api-key").value = all[STORAGE_KEYS.API_KEY] || "";
  document.getElementById("model").value = all[STORAGE_KEYS.MODEL] || DEFAULT_MODEL;
  document.getElementById("language").value = all[STORAGE_KEYS.LANGUAGE] || "auto";
  document.getElementById("default-length").value =
    all[STORAGE_KEYS.DEFAULT_LENGTH] || DEFAULT_LENGTH;
  document.getElementById("endpoint").value = all[STORAGE_KEYS.ENDPOINT] || "";
  document.getElementById("gateway-token").value = all[STORAGE_KEYS.GATEWAY_TOKEN] || "";
  const uk = all[STORAGE_KEYS.INCLUDE_UK];
  document.getElementById("include-uk").value =
    (uk === undefined ? DEFAULT_INCLUDE_UK : uk) ? "1" : "0";
}

document.getElementById("save-settings").addEventListener("click", async () => {
  const apiKey = document.getElementById("api-key").value.trim();
  const model = document.getElementById("model").value.trim() || DEFAULT_MODEL;
  const language = document.getElementById("language").value;
  const defaultLength = document.getElementById("default-length").value;
  await set(STORAGE_KEYS.API_KEY, apiKey);
  await set(STORAGE_KEYS.MODEL, model);
  await set(STORAGE_KEYS.LANGUAGE, language);
  await set(STORAGE_KEYS.DEFAULT_LENGTH, defaultLength);
  await set(STORAGE_KEYS.INCLUDE_UK, document.getElementById("include-uk").value === "1");
  await set(STORAGE_KEYS.ENDPOINT, document.getElementById("endpoint").value.trim());
  await set(STORAGE_KEYS.GATEWAY_TOKEN, document.getElementById("gateway-token").value.trim());
  const saved = document.getElementById("settings-saved");
  saved.textContent = "saved";
  await renderHeaderMeta();
  setTimeout(() => (saved.textContent = ""), 1200);
});

// ---------- Styles list ----------

async function renderStyles() {
  const styles = await getStyles();
  const activeId = await getActiveStyleId();
  renderActiveStyleSelect(styles, activeId);

  const list = document.getElementById("styles-list");
  list.innerHTML = "";
  if (!styles.length) {
    list.innerHTML = `<div class="muted">No styles yet. Add one.</div>`;
    return;
  }
  for (const s of styles) {
    const card = document.createElement("div");
    card.className = "style-card" + (s.id === activeId ? " is-active" : "");
    const exCount = (s.examples || []).length;
    const fwCount = (s.forbiddenWords || []).length;
    const manualCount = (s.examples || []).filter(
      (e) => e.source !== "auto" && e.source !== "rejected_all"
    ).length;
    card.innerHTML = `
      <div class="name"><span></span>${s.id === activeId ? '<span class="active-badge">active here</span>' : ""}</div>
      <div class="desc"></div>
      <div class="meta">${manualCount} manual · ${exCount - manualCount} auto · ${fwCount} forbidden</div>
    `;
    card.querySelector(".name span").textContent = s.name;
    card.querySelector(".desc").textContent = s.prompt;
    card.addEventListener("click", () => openStyleEditor(s.id));
    list.appendChild(card);
  }
}

function renderActiveStyleSelect(styles, activeId) {
  const sel = document.getElementById("active-style");
  sel.innerHTML = `<option value="">Ask every time (show picker)</option>`;
  for (const s of styles) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === activeId) opt.selected = true;
    sel.appendChild(opt);
  }
}

document.getElementById("active-style").addEventListener("change", async (e) => {
  await setActiveStyleId(e.target.value);
  await renderStyles();
});

document.getElementById("add-style").addEventListener("click", () => openStyleEditor(null));

// ---------- Style editor ----------

let editingStyleId = null;
let editingStyleDraft = null; // working copy

async function openStyleEditor(id) {
  const styles = await getStyles();
  if (id) {
    editingStyleId = id;
    editingStyleDraft = JSON.parse(JSON.stringify(styles.find((s) => s.id === id)));
    document.getElementById("style-modal-title").textContent = `Edit · ${editingStyleDraft.name}`;
    document.getElementById("style-delete").hidden = false;
  } else {
    editingStyleId = null;
    editingStyleDraft = {
      id: "style_" + crypto.randomUUID().slice(0, 8),
      name: "",
      prompt: "",
      examples: [],
      forbiddenWords: []
    };
    document.getElementById("style-modal-title").textContent = "New style";
    document.getElementById("style-delete").hidden = true;
  }
  document.getElementById("style-name").value = editingStyleDraft.name;
  document.getElementById("style-prompt").value = editingStyleDraft.prompt;
  renderStyleForbidden();
  renderStyleExamples();
  document.getElementById("style-modal").hidden = false;
}

function closeStyleEditor() {
  document.getElementById("style-modal").hidden = true;
  editingStyleId = null;
  editingStyleDraft = null;
}

document.getElementById("style-modal-close").addEventListener("click", closeStyleEditor);
document.getElementById("style-cancel").addEventListener("click", closeStyleEditor);

document.getElementById("style-save").addEventListener("click", async () => {
  if (!editingStyleDraft) return;
  editingStyleDraft.name = document.getElementById("style-name").value.trim();
  editingStyleDraft.prompt = document.getElementById("style-prompt").value.trim();
  if (!editingStyleDraft.name) {
    alert("Style needs a name.");
    return;
  }
  await upsertStyle(editingStyleDraft);
  closeStyleEditor();
  await renderStyles();
});

document.getElementById("style-delete").addEventListener("click", async () => {
  if (!editingStyleId) return;
  if (!confirm("Delete this style?")) return;
  await deleteStyle(editingStyleId);
  closeStyleEditor();
  await renderStyles();
});

// Style-level forbidden words

function renderStyleForbidden() {
  const chips = document.getElementById("style-forbidden-chips");
  chips.innerHTML = "";
  for (const w of editingStyleDraft.forbiddenWords) {
    const chip = makeChip(w, () => {
      editingStyleDraft.forbiddenWords = editingStyleDraft.forbiddenWords.filter((x) => x !== w);
      renderStyleForbidden();
    });
    chips.appendChild(chip);
  }
}

document.getElementById("style-forbidden-input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const v = e.target.value.trim();
  if (!v) return;
  if (!editingStyleDraft.forbiddenWords.includes(v)) {
    editingStyleDraft.forbiddenWords.push(v);
  }
  e.target.value = "";
  renderStyleForbidden();
});

// Style examples

function renderStyleExamples() {
  const list = document.getElementById("examples-list");
  list.innerHTML = "";
  // Newest first — auto examples grow at the end, so show in reverse.
  const indexed = editingStyleDraft.examples.map((ex, i) => ({ ex, i }));
  indexed.reverse();
  for (const { ex, i } of indexed) {
    const row = document.createElement("div");
    row.className = "example-row";
    let badge = "";
    if (ex.source === "auto") badge = `<span class="ex-badge">auto</span>`;
    else if (ex.source === "rejected_all") badge = `<span class="ex-badge danger">none fit</span>`;

    const replyLabel = ex.source === "rejected_all" ? "All rejected — avoid" : "Reply (chosen)";

    row.innerHTML = `
      <div class="col">
        <div class="col-label">Post ${badge}</div>
        <div class="col-text"></div>
      </div>
      <div class="col">
        <div class="col-label">${replyLabel}</div>
        <div class="col-text"></div>
        <div class="rejected"></div>
      </div>
      <button class="remove" title="Remove">×</button>
    `;
    row.querySelectorAll(".col-text")[0].textContent = ex.post;
    if (ex.reply) {
      row.querySelectorAll(".col-text")[1].textContent = ex.reply;
    } else {
      row.querySelectorAll(".col-text")[1].textContent = "—";
      row.querySelectorAll(".col-text")[1].style.color = "var(--muted)";
    }
    const rejectedEl = row.querySelector(".rejected");
    if (ex.rejected && ex.rejected.length) {
      for (const r of ex.rejected) {
        const line = document.createElement("div");
        line.className = "rejected-line";
        line.textContent = "× " + r;
        rejectedEl.appendChild(line);
      }
    }
    row.querySelector(".remove").addEventListener("click", () => {
      editingStyleDraft.examples.splice(i, 1);
      renderStyleExamples();
    });
    list.appendChild(row);
  }
  document.getElementById("examples-count").textContent =
    `${editingStyleDraft.examples.length} example${editingStyleDraft.examples.length === 1 ? "" : "s"}`;
}

document.getElementById("add-example").addEventListener("click", () => {
  const post = document.getElementById("example-post").value.trim();
  const reply = document.getElementById("example-reply").value.trim();
  if (!post || !reply) return;
  editingStyleDraft.examples.push({ post, reply });
  document.getElementById("example-post").value = "";
  document.getElementById("example-reply").value = "";
  renderStyleExamples();
});

document.getElementById("clear-examples").addEventListener("click", () => {
  if (!editingStyleDraft.examples.length) return;
  if (!confirm("Remove all examples for this style?")) return;
  editingStyleDraft.examples = [];
  renderStyleExamples();
});

document.getElementById("import-examples").addEventListener("click", () => {
  document.getElementById("examples-file").click();
});

document.getElementById("examples-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const merged = mergeImported(editingStyleDraft, data);
    editingStyleDraft.examples = merged;
    renderStyleExamples();
  } catch (err) {
    alert("Import failed: " + err.message);
  }
  e.target.value = "";
});

// Accept two import shapes:
//  1) { "style": "chill", "examples": [{post, reply}, ...] }
//  2) { "chill": [{post, reply}, ...], "smart": [...] }
//  3) [{post, reply}, ...]  (raw list — assumed for current style)
function mergeImported(draft, data) {
  let incoming = [];
  if (Array.isArray(data)) {
    incoming = data;
  } else if (data && Array.isArray(data.examples)) {
    incoming = data.examples;
  } else if (data && typeof data === "object") {
    const arr = data[draft.name] || data[draft.id];
    if (Array.isArray(arr)) incoming = arr;
    else
      throw new Error(
        `No examples found for style "${draft.name}" in the imported file.`
      );
  } else {
    throw new Error("Unrecognized format.");
  }
  incoming = incoming
    .map((x) => ({ post: String(x.post || "").trim(), reply: String(x.reply || "").trim() }))
    .filter((x) => x.post && x.reply);
  // De-dupe by post+reply key.
  const seen = new Set(draft.examples.map((x) => x.post + "\u0001" + x.reply));
  const out = [...draft.examples];
  for (const ex of incoming) {
    const k = ex.post + "\u0001" + ex.reply;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(ex);
    }
  }
  return out;
}

// ---------- Forbidden (global) ----------

let globalForbiddenCache = [];

async function renderForbidden() {
  globalForbiddenCache = await getGlobalForbidden();
  const chips = document.getElementById("forbidden-chips");
  chips.innerHTML = "";
  for (const w of globalForbiddenCache) {
    const chip = makeChip(w, async () => {
      globalForbiddenCache = globalForbiddenCache.filter((x) => x !== w);
      await set(STORAGE_KEYS.GLOBAL_FORBIDDEN, globalForbiddenCache);
      renderForbidden();
    });
    chips.appendChild(chip);
  }
}

document.getElementById("forbidden-input").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const v = e.target.value.trim();
  if (!v) return;
  if (!globalForbiddenCache.includes(v)) {
    globalForbiddenCache = [...globalForbiddenCache, v];
    await set(STORAGE_KEYS.GLOBAL_FORBIDDEN, globalForbiddenCache);
    renderForbidden();
  }
  e.target.value = "";
});

// ---------- Chip helper ----------

function makeChip(text, onRemove) {
  const el = document.createElement("span");
  el.className = "chip";
  el.innerHTML = `<span></span><button class="chip-x" aria-label="Remove">×</button>`;
  el.querySelector("span").textContent = text;
  el.querySelector(".chip-x").addEventListener("click", onRemove);
  return el;
}

// ---------- Log ----------

function renderUsage(log) {
  const el = document.getElementById("usage-body");
  const withUsage = log.filter((e) => e.usage);
  if (!withUsage.length) {
    el.textContent = "No usage recorded yet.";
    return;
  }
  const t = withUsage.reduce(
    (a, e) => ({
      input: a.input + (e.usage.input || 0),
      output: a.output + (e.usage.output || 0),
      cacheRead: a.cacheRead + (e.usage.cacheRead || 0),
      cacheWrite: a.cacheWrite + (e.usage.cacheWrite || 0)
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  );
  const cost =
    (t.input * PRICING_PER_MTOK.input +
      t.output * PRICING_PER_MTOK.output +
      t.cacheRead * PRICING_PER_MTOK.cacheRead +
      t.cacheWrite * PRICING_PER_MTOK.cacheWrite) /
    1e6;
  const per = cost / withUsage.length;
  const cacheNote = t.cacheRead
    ? `${t.cacheRead.toLocaleString()} cached`
    : "cache not hit (prompt below the model minimum)";
  el.innerHTML =
    `${withUsage.length} generations · ${t.input.toLocaleString()} in · ` +
    `${t.output.toLocaleString()} out · ${cacheNote}<br>` +
    `≈ $${cost.toFixed(4)} total, $${per.toFixed(5)} per generation`;
}

async function renderLog() {
  const log = (await get(STORAGE_KEYS.LOG)) || [];
  renderUsage(log);
  const list = document.getElementById("log-list");
  list.innerHTML = "";
  if (!log.length) {
    list.innerHTML = `<div class="muted">No entries yet. Generate some replies on X.</div>`;
    return;
  }
  for (const entry of log) {
    const card = document.createElement("div");
    card.className = "log-card";
    const date = new Date(entry.ts).toLocaleString();
    let chosen = "";
    if (entry.chosen === -1) {
      chosen = `<div class="log-rejected">Rejected all</div>`;
    } else if (entry.chosen != null) {
      chosen = `<div class="log-chosen">Picked variant ${entry.chosen + 1}</div>`;
    } else if (entry.status === "error") {
      chosen = `<div class="log-error">Error</div>`;
    }
    const lengthTag = entry.length && entry.length !== "normal"
      ? ` · ${entry.length}` : "";
    const usageTag = entry.usage
      ? ` · ${entry.usage.input}→${entry.usage.output}t` : "";
    card.innerHTML = `
      <div class="log-meta"><span></span><span>${date}</span></div>
      <div class="log-post"><div class="truncate"></div></div>
      ${chosen}
    `;
    card.querySelector(".log-meta span:first-child").textContent =
      (entry.styleId || "—") + lengthTag + usageTag;
    card.querySelector(".log-post .truncate").textContent = entry.post || "";
    card.addEventListener("click", () => openLogModal(entry));
    list.appendChild(card);
  }
}

function openLogModal(entry) {
  const body = document.getElementById("log-modal-body");
  body.innerHTML = "";
  body.appendChild(field("Style", entry.styleId || "—"));
  if (entry.parentPost) body.appendChild(field("Parent post", entry.parentPost));
  body.appendChild(field("Post", entry.post || ""));
  if (entry.status === "error") {
    body.appendChild(field("Error", entry.error || ""));
  } else if (entry.variants && entry.variants.length) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "Variants";
    wrap.appendChild(label);
    entry.variants.forEach((v, i) => {
      const row = document.createElement("div");
      row.className = "card subtle";
      let pickMark = "";
      if (entry.chosen === i) pickMark = " ✓";
      else if (entry.chosen === -1) pickMark = " ×";
      const head = document.createElement("div");
      head.className = "label small";
      head.textContent = `Variant ${i + 1}${pickMark}`;

      const vText = typeof v === "string" ? v : (v.text || "");
      const vUk = typeof v === "string" ? "" : (v.uk || "");

      const text = document.createElement("div");
      text.style.whiteSpace = "pre-wrap";
      text.style.fontSize = "12px";
      text.textContent = vText;
      row.appendChild(head);
      row.appendChild(text);

      if (vUk && vUk.trim() && vUk.trim() !== vText.trim()) {
        const uk = document.createElement("div");
        uk.style.whiteSpace = "pre-wrap";
        uk.style.fontSize = "11px";
        uk.style.color = "var(--muted)";
        uk.style.fontStyle = "italic";
        uk.style.marginTop = "4px";
        uk.style.paddingLeft = "8px";
        uk.style.borderLeft = "2px solid #FFD700";
        uk.textContent = "🇺🇦 " + vUk;
        row.appendChild(uk);
      }
      wrap.appendChild(row);
    });
    body.appendChild(wrap);
  }
  document.getElementById("log-modal").hidden = false;
}

function field(label, value) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const l = document.createElement("span");
  l.className = "label";
  l.textContent = label;
  const v = document.createElement("div");
  v.style.whiteSpace = "pre-wrap";
  v.style.fontSize = "12px";
  v.style.color = "var(--ink-2)";
  v.textContent = value;
  wrap.appendChild(l);
  wrap.appendChild(v);
  return wrap;
}

document.getElementById("log-modal-close").addEventListener("click", () => {
  document.getElementById("log-modal").hidden = true;
});

document.getElementById("export-log").addEventListener("click", async () => {
  const log = (await get(STORAGE_KEYS.LOG)) || [];
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `reply-agent-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("clear-log").addEventListener("click", async () => {
  if (!confirm("Clear the entire reply log? This can't be undone.")) return;
  await clearLog();
  await renderLog();
});

boot();
