// Content script. Runs on every x.com / twitter.com page.
// Finds tweets in the feed, injects an extra button next to the action bar,
// and on click shows a style picker and 3 reply variants.
//
// Note: this file is NOT a module (Chrome doesn't support ES modules for
// content scripts), so everything is inline.

(function () {
  "use strict";

  const BUTTON_CLASS = "ra-trigger";
  const PANEL_CLASS = "ra-panel";

  // ---------- Cached settings ----------
  // Injection is synchronous, so we keep a local mirror of the two values the
  // button needs and refresh it when the popup changes them.

  const cfg = { activeStyle: "", activeStyleName: "", defaultLength: "normal" };

  function refreshCfg(store) {
    const styles = store.styles || [];
    cfg.activeStyle = store.activeStyle || "";
    cfg.defaultLength = store.defaultLength || "normal";
    const s = styles.find((x) => x.id === cfg.activeStyle);
    cfg.activeStyleName = s ? s.name : "";
    document.querySelectorAll("." + BUTTON_CLASS + " .ra-label").forEach((el) => {
      el.textContent = buttonLabel();
    });
  }

  function buttonLabel() {
    return cfg.activeStyleName ? "RA \u00b7 " + cfg.activeStyleName : "RA";
  }

  chrome.storage.local.get(["activeStyle", "styles", "defaultLength"]).then(refreshCfg);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!("activeStyle" in changes || "styles" in changes || "defaultLength" in changes)) return;
    chrome.storage.local.get(["activeStyle", "styles", "defaultLength"]).then(refreshCfg);
  });

  // ---------- DOM helpers ----------

  function getPostText(article) {
    // The main tweet text. Each text node lives inside [data-testid="tweetText"].
    // An article can contain a quoted tweet; we take only the first text block.
    const node = article.querySelector('[data-testid="tweetText"]');
    if (!node) return "";
    return node.innerText.trim();
  }

  function getParentText(article) {
    // On a permalink page, the article being shown as a reply is preceded
    // by the parent tweet article in the DOM. We only attach context when
    // the URL is a /status/ permalink, which is the common reply view.
    if (!/\/status\//.test(location.pathname)) return null;
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const idx = articles.indexOf(article);
    if (idx > 0) {
      const parent = articles[idx - 1];
      const node = parent.querySelector('[data-testid="tweetText"]');
      return node ? node.innerText.trim() : null;
    }
    return null;
  }

  function findActionBar(article) {
    // X's action row is a div with role="group" containing reply/retweet/like.
    return article.querySelector('div[role="group"]');
  }

  function findReplyButton(article) {
    return article.querySelector('[data-testid="reply"]');
  }

  // ---------- Injection ----------

  function injectButton(article) {
    const bar = findActionBar(article);
    if (!bar) return;
    // Check for the button itself, not a flag on <article>. X re-renders the
    // action bar (e.g. after a like) and the old flag made the button vanish
    // permanently once that happened.
    if (bar.querySelector("." + BUTTON_CLASS)) return;

    const btn = document.createElement("button");
    btn.className = BUTTON_CLASS;
    btn.type = "button";
    btn.title = "Reply Agent — generate replies";
    btn.setAttribute("aria-label", "Reply Agent");
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2 L14 8 L20 10 L14 12 L12 18 L10 12 L4 10 L10 8 Z"/>
      </svg>
      <span class="ra-label"></span>
    `;
    btn.querySelector(".ra-label").textContent = buttonLabel();
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onTrigger(article, btn);
    });

    bar.appendChild(btn);
  }

  function scanAndInject() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach(injectButton);
  }

  // ---------- Panel (style picker + variants) ----------

  function closeAllPanels() {
    document.querySelectorAll("." + PANEL_CLASS).forEach((p) => p.remove());
  }

  const LENGTHS = ["short", "normal", "long"];

  function lengthRowHtml(active) {
    return LENGTHS.map(
      (l) =>
        `<button class="ra-len-btn${l === active ? " is-active" : ""}" data-len="${l}">${l}</button>`
    ).join("");
  }

  async function onTrigger(article, btn) {
    closeAllPanels();
    const post = getPostText(article);
    const parentPost = getParentText(article);
    if (!post) {
      flashPanel(btn, "Couldn't read this post's text.");
      return;
    }

    // Everything the panel needs to (re)generate lives here.
    const state = {
      article,
      post,
      parentPost,
      length: cfg.defaultLength,
      styleId: cfg.activeStyle || null
    };

    const panel = document.createElement("div");
    panel.className = PANEL_CLASS;
    panel.innerHTML = `
      <div class="ra-panel-head">
        <span class="ra-panel-title">Pick a style</span>
        <div class="ra-head-actions">
          <button class="ra-switch" type="button" hidden>styles</button>
          <button class="ra-close" aria-label="Close">\u00d7</button>
        </div>
      </div>
      <div class="ra-length">
        <span class="ra-length-label">Length:</span>
        ${lengthRowHtml(state.length)}
      </div>
      <div class="ra-styles"><div class="ra-loading">Loading\u2026</div></div>
    `;
    insertPanel(panel, article);

    panel.querySelector(".ra-close").addEventListener("click", () => panel.remove());
    bindLengthChips(panel.querySelector(".ra-length"), panel, state, null);

    // Style is locked to this browser profile — skip the picker entirely.
    if (state.styleId) {
      const sw = panel.querySelector(".ra-switch");
      sw.hidden = false;
      sw.addEventListener("click", () => renderStylePicker(panel, state));
      generate(panel, state);
      return;
    }

    renderStylePicker(panel, state);
  }

  // Length chips. Listeners are bound only inside `root` (there can be two
  // chip rows in a panel), but the active mark is synced across the whole
  // panel. onChange stays null while the picker is open \u2014 nothing to
  // regenerate yet.
  function bindLengthChips(root, panel, state, onChange) {
    root.querySelectorAll(".ra-len-btn").forEach((b) => {
      b.addEventListener("click", () => {
        state.length = b.dataset.len;
        panel.querySelectorAll(".ra-len-btn").forEach((x) => {
          x.classList.toggle("is-active", x.dataset.len === state.length);
        });
        if (onChange) onChange();
      });
    });
  }

  async function renderStylePicker(panel, state) {
    panel.querySelector(".ra-panel-title").textContent = "Pick a style";
    const lenRow = panel.querySelector(".ra-length");
    if (lenRow) lenRow.hidden = false;

    const container = panel.querySelector(".ra-styles, .ra-variants");
    container.className = "ra-styles";
    container.innerHTML = `<div class="ra-loading">Loading\u2026</div>`;

    const stylesRes = await chrome.runtime.sendMessage({ type: "GET_STYLES" });
    if (!stylesRes || !stylesRes.ok) {
      container.innerHTML = `<div class="ra-error">Couldn't load styles.</div>`;
      return;
    }

    container.innerHTML = "";
    for (const st of stylesRes.styles) {
      const b = document.createElement("button");
      b.className = "ra-style-btn";
      b.textContent = st.name;
      b.addEventListener("click", () => {
        state.styleId = st.id;
        generate(panel, state);
      });
      container.appendChild(b);
    }
  }

  async function generate(panel, state) {
    panel.querySelector(".ra-panel-title").textContent = "Generating\u2026";
    const container = panel.querySelector(".ra-styles, .ra-variants");
    container.className = "ra-styles";
    container.innerHTML = `<div class="ra-loading">Thinking\u2026</div>`;
    // Hide the length toggle while generating to avoid confusion.
    const lenRow = panel.querySelector(".ra-length");
    if (lenRow) lenRow.hidden = true;

    const res = await chrome.runtime.sendMessage({
      type: "GENERATE",
      styleId: state.styleId,
      post: state.post,
      parentPost: state.parentPost,
      length: state.length
    });

    if (!res || !res.ok) {
      container.innerHTML = `<div class="ra-error">${escapeHtml(res?.error || "Unknown error")}</div>`;
      return;
    }

    renderVariants(panel, state, res.variants, res.logId);
  }

  function renderVariants(panel, state, variants, logId) {
    panel.querySelector(".ra-panel-title").textContent = "Pick one";
    const container = panel.querySelector(".ra-styles, .ra-variants");
    container.className = "ra-variants";
    container.innerHTML = "";

    variants.forEach((variant, i) => {
      // Backward-compat: variant can be either a string (legacy) or {text, uk}.
      const text = typeof variant === "string" ? variant : (variant.text || "");
      const uk = typeof variant === "string" ? "" : (variant.uk || "");
      const showUk = uk && uk.trim() && uk.trim() !== text.trim();

      const card = document.createElement("div");
      card.className = "ra-variant";
      card.innerHTML = `
        <div class="ra-variant-text"></div>
        <div class="ra-variant-uk" hidden></div>
        <button class="ra-pick" type="button">Use this</button>
      `;
      card.querySelector(".ra-variant-text").textContent = text;
      if (showUk) {
        const ukEl = card.querySelector(".ra-variant-uk");
        ukEl.hidden = false;
        ukEl.innerHTML = `<span class="ra-uk-flag">\ud83c\uddfa\ud83c\udde6</span><span></span>`;
        ukEl.querySelector("span:last-child").textContent = uk;
      }
      card.querySelector(".ra-pick").addEventListener("click", async () => {
        await navigator.clipboard.writeText(text);
        await chrome.runtime.sendMessage({
          type: "RECORD_CHOICE",
          logId,
          chosen: i
        });
        // Try to open the native reply composer for this post.
        const replyBtn = state.article ? findReplyButton(state.article) : null;
        if (replyBtn) replyBtn.click();
        panel.querySelector(".ra-panel-title").textContent = "Copied \u2014 Ctrl+V to paste";
        card.classList.add("ra-picked");
        setTimeout(() => panel.remove(), 1500);
      });
      container.appendChild(card);
    });

    // Footer: retry at another length, or reject everything.
    const footer = document.createElement("div");
    footer.className = "ra-foot";
    footer.innerHTML = `
      <div class="ra-refoot">${lengthRowHtml(state.length)}</div>
      <button class="ra-none" type="button">Nothing fits</button>
    `;
    container.appendChild(footer);
    bindLengthChips(footer, panel, state, () => generate(panel, state));
    footer.querySelector(".ra-none").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "RECORD_REJECT_ALL", logId });
      panel.querySelector(".ra-panel-title").textContent =
        "Got it \u2014 won't write like this for similar posts";
      container.querySelectorAll(".ra-variant").forEach((v) => v.classList.add("ra-dimmed"));
      setTimeout(() => panel.remove(), 1500);
    });
  }

  function insertPanel(panel, article) {
    // Drop the panel directly below the article so it doesn't disrupt layout.
    article.parentElement.insertBefore(panel, article.nextSibling);
  }

  function flashPanel(btn, msg) {
    const panel = document.createElement("div");
    panel.className = PANEL_CLASS;
    panel.innerHTML = `<div class="ra-error">${escapeHtml(msg)}</div>`;
    const article = btn.closest("article");
    if (article) insertPanel(panel, article);
    setTimeout(() => panel.remove(), 2000);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------- Observer (handle infinite scroll) ----------

  const observer = new MutationObserver(() => {
    // Debounce: do at most one scan per animation frame.
    if (observer._pending) return;
    observer._pending = true;
    requestAnimationFrame(() => {
      observer._pending = false;
      scanAndInject();
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
  scanAndInject();
})();
