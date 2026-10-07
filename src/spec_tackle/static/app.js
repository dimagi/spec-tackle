/* spec-tackle review UI.
 *
 * The server renders the document with `data-ls`/`data-le` (source line range)
 * on every commentable element. This script anchors GitHub review threads to
 * those elements, lays the thread cards out in the right margin, and talks to
 * the small JSON API for posting comments, replies and resolutions.
 */
(() => {
  "use strict";

  const BOOT = JSON.parse(document.getElementById("boot").textContent);
  const PR = BOOT.pr;
  const FILES = BOOT.files;
  const RENDERED_SHA = BOOT.activity.headSha;
  const API = `/api/pr/${PR.owner}/${PR.repo}/${PR.number}`;
  const POLL_MS = 30_000;
  const GAP = 10;
  const CLAUDE = !!BOOT.claude;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const doc = $("#doc");
  const margin = $("#margin");

  // ── Persistence (per PR) ─────────────────────────────────────────────
  const KEY = `spec-tackle:${PR.owner}/${PR.repo}#${PR.number}`;
  const store = {
    get(name, fallback) {
      try {
        const raw = localStorage.getItem(`${KEY}:${name}`);
        return raw === null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(name, value) {
      try {
        if (value === null) localStorage.removeItem(`${KEY}:${name}`);
        else localStorage.setItem(`${KEY}:${name}`, JSON.stringify(value));
      } catch { /* private mode etc. */ }
    },
  };

  const allCommentIds = (activity) => [
    ...activity.threads.flatMap((t) => t.comments.map((c) => c.id)),
    ...activity.conversation.map((c) => c.id),
  ];

  const storedSeen = store.get("seen", null);
  const state = {
    activity: BOOT.activity,
    filter: store.get("filter", "open"),
    hideBots: store.get("hideBots", false),
    showClaude: store.get("showClaude", true),
    active: null, // thread id, or "composer"
    composer: null, // { path, start, end, el, anchors }
    expanded: new Set(), // thread ids the reviewer opened despite being collapsible
    expandedBodies: new Set(), // comment ids whose long body was expanded
    // First visit: nothing is "new". Later visits: badge what arrived since.
    seen: new Set(storedSeen ?? allCommentIds(BOOT.activity)),
    fresh: new Set(),
    lastSync: Date.now(),
    unreadWhileHidden: 0,
  };
  for (const id of allCommentIds(state.activity)) {
    if (!state.seen.has(id)) state.fresh.add(id);
    state.seen.add(id);
  }
  store.set("seen", [...state.seen]);

  // ── Small utilities ─────────────────────────────────────────────────
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  function timeAgo(iso) {
    if (!iso) return "";
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 45) return "just now";
    const units = [[60, "m"], [24, "h"], [7, "d"], [4.35, "w"], [12, "mo"], [Infinity, "y"]];
    let value = s / 60;
    let label = "m";
    for (const [size, unit] of units) {
      label = unit;
      if (value < size) break;
      value /= size;
    }
    return `${Math.max(1, Math.floor(value))}${label} ago`;
  }
  const timeTag = (iso) =>
    `<time data-time="${esc(iso)}" title="${esc(new Date(iso).toLocaleString())}">${timeAgo(iso)}</time>`;

  const textOf = (html) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent.replace(/\s+/g, " ").trim();
  };

  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join("; ") : data.detail;
      if (data.signedOut) showSignedOut();
      throw new Error(data.error || detail || `Request failed (${res.status})`);
    }
    return data;
  }

  function toast(message, { kind = "info", action, onAction, timeout = 5000 } = {}) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = esc(message) + (action ? ` <button>${esc(action)}</button>` : "");
    if (action) el.querySelector("button").onclick = () => { onAction(); el.remove(); };
    $("#toasts").append(el);
    if (timeout) setTimeout(() => el.remove(), timeout);
  }

  // GitHub stopped accepting the sign-in: say so once, and offer a way back here after signing in.
  let signedOut = false;
  function showSignedOut() {
    if (signedOut) return;
    signedOut = true;
    toast("You're signed out of GitHub, so comments can't be posted or refreshed.", {
      kind: "error",
      timeout: 0,
      action: "Sign in",
      onAction: () => { location.href = `/?next=${encodeURIComponent(location.pathname)}`; },
    });
  }

  let layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layout(); });
  }

  // ── Anchoring threads to document elements ───────────────────────────
  const sectionFor = (path) => $$("section.file").find((s) => s.dataset.path === path);
  const visibleView = (section) => section && $$(".view", section).find((v) => !v.hidden);

  /** Innermost elements overlapping [start, end] — e.g. table rows, not the table. */
  function elementsInRange(view, start, end) {
    const hits = $$("[data-ls]", view).filter((el) => +el.dataset.ls <= end && +el.dataset.le >= start);
    return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
  }

  function threadRange(t) {
    if (t.isFileLevel || t.side === "LEFT") return null;
    if (t.line != null) return [t.startLine ?? t.line, t.line];
    if (t.originalLine != null) return [t.originalStartLine ?? t.originalLine, t.originalLine];
    return null;
  }

  function rangeLabel(start, end) {
    return start === end ? `L${end}` : `L${start}–${end}`;
  }

  /** Mirror of render.resolve_anchor: where GitHub will accept a line comment. */
  function commentableRange(path, start, end) {
    const file = FILES[path];
    if (file.wholeFile) return { start, end };
    for (const [hs, he] of file.hunks) {
      const lo = Math.max(start, hs);
      const hi = Math.min(end, he);
      if (lo <= hi) return { start: lo, end: hi };
    }
    return null;
  }

  const isBotThread = (t) => t.comments[0].author.isBot;
  const isCollapsible = (t) => t.isResolved || t.isOutdated || isBotThread(t);
  const isCollapsed = (t) => isCollapsible(t) && !state.expanded.has(t.id) && state.active !== t.id;
  const isShown = (t) =>
    !(state.hideBots && isBotThread(t)) && !(state.filter === "open" && t.isResolved);

  // ── Thread cards ─────────────────────────────────────────────────────
  const cards = new Map(); // thread id → { el, thread, sig, anchors, fallback }
  const claudeCards = new Map(); // Claude thread id → { el, thread, anchors, fallback, live, source }
  const resizeObserver = new ResizeObserver(scheduleLayout);
  resizeObserver.observe(doc);

  function renderThreads() {
    const threads = state.activity.threads;
    const ids = new Set(threads.map((t) => t.id));
    for (const [id, card] of cards) {
      if (!ids.has(id)) { card.el.remove(); cards.delete(id); }
    }
    for (const t of threads) {
      let card = cards.get(t.id);
      if (!card) {
        card = { el: createCardShell(t) };
        cards.set(t.id, card);
        margin.append(card.el);
        resizeObserver.observe(card.el);
      }
      card.thread = t;
      const collapsed = isCollapsed(t);
      const sig = JSON.stringify([
        t.comments.map((c) => [c.id, state.fresh.has(c.id), state.expandedBodies.has(c.id)]),
        t.isResolved, t.isOutdated, t.line, t.startLine, collapsed,
      ]);
      if (card.sig !== sig) { fillCard(card.el, t, collapsed); card.sig = sig; }
      card.el.hidden = !isShown(t);
      card.el.classList.toggle("is-collapsed", collapsed);
    }
    for (const card of claudeCards.values()) card.el.hidden = !state.showClaude;
    markAnchors();
    clampBodies();
    updateStats();
    updateOutlineCounts();
    layout();
  }

  function createCardShell(t) {
    const el = document.createElement("div");
    el.className = "thread-card";
    el.dataset.thread = t.id;
    el.innerHTML = `
      <div class="thread-head"></div>
      <div class="thread-body"></div>
      <div class="thread-reply">
        <textarea rows="1" placeholder="Reply…"></textarea>
        <div class="actions" hidden>
          <span class="text-[11px] text-stone-400">⌘↵ to send</span>
          <span class="flex-1"></span>
          <button class="btn-ghost" data-action="reply-cancel">Cancel</button>
          <button class="btn-primary" data-action="reply-submit">Reply</button>
        </div>
      </div>`;
    const textarea = $("textarea", el);
    textarea.value = store.get(`draft:${t.id}`, "") || "";
    if (textarea.value) expandReply(el);
    return el;
  }

  function fillCard(el, t, collapsed) {
    const range = threadRange(t);
    let where;
    if (t.isFileLevel) where = `<span class="chip">File</span>`;
    else if (t.side === "LEFT") where = `<span class="chip">Removed line</span>`;
    else if (range) where = `<span class="chip" title="${esc(t.path)}">${rangeLabel(...range)}</span>`;
    else where = "";
    const freshCount = t.comments.filter((c) => state.fresh.has(c.id)).length;

    $(".thread-head", el).innerHTML = `
      ${where}
      ${t.isOutdated ? `<span class="chip chip-outdated" title="The text changed after this comment">Outdated</span>` : ""}
      ${t.isResolved ? `<span class="chip chip-resolved">Resolved${t.resolvedBy ? ` by ${esc(t.resolvedBy)}` : ""}</span>` : ""}
      ${freshCount ? `<span class="chip chip-new">${freshCount} new</span>` : ""}
      <span class="flex-1"></span>
      ${t.isResolved
        ? `<button class="icon-btn" data-action="unresolve">Reopen</button>`
        : `<button class="icon-btn" data-action="resolve" title="Mark as resolved">✓ Resolve</button>`}
      <a class="icon-btn" href="${esc(t.comments[0].url)}" target="_blank" rel="noopener" title="Open on GitHub">↗</a>`;

    const body = $(".thread-body", el);
    if (collapsed) {
      const first = t.comments[0];
      const replies = t.comments.length - 1;
      body.innerHTML = `
        <div class="collapsed-summary" data-action="expand">
          <img src="${esc(first.author.avatarUrl)}" alt="">
          <b class="shrink-0 text-[12.5px] text-stone-700 dark:text-stone-200">${esc(first.author.login)}</b>
          <span class="text">${esc(textOf(first.bodyHTML).slice(0, 160))}</span>
          ${replies ? `<span class="shrink-0 text-[11px]">+${replies}</span>` : ""}
        </div>`;
    } else {
      body.innerHTML = t.comments.map(commentHTML).join("") +
        (isCollapsible(t) && state.active !== t.id
          ? `<div class="px-3 pb-2"><button class="more-btn" data-action="collapse">Collapse</button></div>`
          : "");
      $$(".comment-body a", body).forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
    }
    $(".thread-reply", el).hidden = collapsed;
  }

  function commentHTML(c) {
    const bot = c.author.isBot ? `<span class="chip chip-bot">bot</span>` : "";
    const fresh = state.fresh.has(c.id) ? `<span class="chip chip-new">new</span>` : "";
    return `
      <div class="comment" data-comment="${c.id}">
        <img class="avatar" src="${esc(c.author.avatarUrl)}" alt="">
        <div class="min-w-0 flex-1">
          <div class="comment-meta"><b>${esc(c.author.login)}</b>${bot}${timeTag(c.createdAt)}${fresh}</div>
          <div class="comment-body prose prose-stone prose-sm max-w-none dark:prose-invert">${c.bodyHTML}</div>
        </div>
      </div>`;
  }

  /** Fade out very long comments (bot reviews!) behind a "Show more". */
  function clampBodies() {
    requestAnimationFrame(() => {
      for (const body of $$(".comment-body:not([data-measured])", margin)) {
        if (!body.offsetParent) continue; // hidden card — measure when it shows
        body.dataset.measured = "1";
        const id = +body.closest(".comment").dataset.comment;
        if (body.scrollHeight > 230 && !state.expandedBodies.has(id)) {
          body.classList.add("clamped");
          body.insertAdjacentHTML("afterend", `<button class="more-btn" data-action="more">Show more</button>`);
        }
      }
      scheduleLayout();
    });
  }

  function markAnchors() {
    $$(".has-thread, .has-claude, .is-active-anchor, .is-drafting", doc).forEach((el) => {
      el.classList.remove("has-thread", "has-claude", "is-active-anchor", "is-drafting");
      delete el._threads;
    });
    for (const card of cards.values()) {
      const t = card.thread;
      const section = sectionFor(t.path);
      const view = visibleView(section);
      const range = threadRange(t);
      card.anchors = range && view ? elementsInRange(view, ...range) : [];
      card.fallback = section ? $(".file-header", section) : $("#description");
      if (card.el.hidden) continue;
      const active = state.active === t.id;
      for (const el of card.anchors) {
        if (!t.isResolved || active) el.classList.add("has-thread");
        if (active) el.classList.add("is-active-anchor");
        (el._threads ||= []).push(t.id);
      }
    }
    for (const card of claudeCards.values()) {
      const t = card.thread;
      const section = sectionFor(t.path);
      const view = visibleView(section);
      card.anchors = view ? elementsInRange(view, t.startLine, t.endLine) : [];
      card.fallback = section ? $(".file-header", section) : $("#description");
      if (card.el.hidden) continue;
      const active = state.active === t.id;
      for (const el of card.anchors) {
        el.classList.add("has-claude");
        if (active) el.classList.add("is-active-anchor");
        (el._threads ||= []).push(t.id);
      }
    }
    if (state.composer) {
      const { path, start, end } = state.composer;
      state.composer.anchors = elementsInRange(visibleView(sectionFor(path)), start, end);
      state.composer.anchors.forEach((el) => el.classList.add("is-drafting"));
    }
  }

  function anchorTop(anchors, fallback) {
    const els = anchors && anchors.length ? anchors : [fallback];
    return Math.min(...els.filter(Boolean).map((el) => el.getBoundingClientRect().top));
  }

  /** Place cards beside their anchors without overlapping; the active card sits exactly level. */
  function layout() {
    if (!margin.offsetParent) return;
    const base = margin.getBoundingClientRect().top;
    const items = [];
    for (const card of cards.values()) {
      if (card.el.hidden) continue;
      items.push({ id: card.thread.id, el: card.el, top: anchorTop(card.anchors, card.fallback) - base });
    }
    for (const card of claudeCards.values()) {
      if (card.el.hidden) continue;
      items.push({ id: card.thread.id, el: card.el, top: anchorTop(card.anchors, card.fallback) - base });
    }
    if (state.composer) {
      const c = state.composer;
      items.push({ id: "composer", el: c.el, top: anchorTop(c.anchors, sectionFor(c.path)) - base });
    }
    items.sort((a, b) => a.top - b.top);
    const heights = items.map((it) => it.el.offsetHeight);
    const pos = new Array(items.length);
    // Pin the active card (or the first) to its anchor, push later cards down
    // and earlier cards up so nothing overlaps.
    const pinned = Math.max(0, items.findIndex((it) => it.id === state.active));
    if (items.length) {
      pos[pinned] = Math.max(0, items[pinned].top);
      for (let i = pinned + 1, y = pos[pinned] + heights[pinned] + GAP; i < items.length; i++) {
        pos[i] = Math.max(items[i].top, y);
        y = pos[i] + heights[i] + GAP;
      }
      for (let i = pinned - 1, y = pos[pinned]; i >= 0; i--) {
        pos[i] = Math.min(items[i].top, y - heights[i] - GAP);
        y = pos[i];
      }
    }
    const shift = pos.length && pos[0] < 0 ? -pos[0] : 0;
    let bottom = 0;
    items.forEach((it, i) => {
      it.el.style.top = `${pos[i] + shift}px`;
      it.el.classList.toggle("is-active", it.id === state.active);
      bottom = Math.max(bottom, pos[i] + shift + heights[i]);
    });
    margin.style.minHeight = `${bottom + 40}px`;
  }

  function activate(id, { scroll = false } = {}) {
    const previous = state.active;
    state.active = id;
    if (previous !== id) {
      // Collapsible threads expand while active; re-render the two affected cards.
      for (const tid of [previous, id]) {
        const card = cards.get(tid);
        if (card) card.sig = null;
      }
      renderThreads();
    }
    if (scroll && id) {
      const card = cards.get(id) || claudeCards.get(id);
      const target = id === "composer" ? state.composer?.anchors?.[0] : card?.anchors?.[0] || card?.fallback;
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // ── Composer for new comments ────────────────────────────────────────
  const MODES = {
    comment: { title: "New comment", help: "Markdown · ⌘↵ to post", submit: "Comment", placeholder: "What should change, or what's unclear?" },
    claude: { title: "Ask Claude", help: "Private, never posted · ⌘↵ to ask", submit: "Ask Claude", placeholder: "Ask Claude about this passage…" },
  };

  function openComposer({ path, start, end, quote, mode = "comment" }) {
    if (state.composer) {
      const existing = $("textarea", state.composer.el).value.trim();
      if (existing && existing !== state.composer.quoteText.trim() && !confirm("Discard your unsent text?")) return;
      closeComposer();
    }
    hideSelectionButton();
    const ok = commentableRange(path, start, end);
    let hint = "";
    if (!ok) {
      hint = `<div class="hint warn">This text wasn't changed in the PR, so GitHub can't attach a line comment here. It will be posted as a file comment that references ${rangeLabel(start, end)}.</div>`;
    } else if (ok.start !== start || ok.end !== end) {
      hint = `<div class="hint">Only ${rangeLabel(ok.start, ok.end)} of this passage changed in the PR, so the comment will be attached there.</div>`;
    }
    const el = document.createElement("div");
    el.className = "thread-card composer";
    el.innerHTML = `
      <div class="thread-head"><span class="chip">${rangeLabel(start, end)}</span><span class="composer-title"></span>
        ${CLAUDE ? `<span class="flex-1"></span><div class="mode-switch"><button data-action="mode-comment">Comment</button><button data-action="mode-claude">Ask Claude</button></div>` : ""}
      </div>
      <div class="comment-only">${hint}</div>
      <div class="p-3">
        <div class="tabs comment-only"><button class="on" data-action="tab-write">Write</button><button data-action="tab-preview">Preview</button></div>
        <textarea rows="4" class="field"></textarea>
        <div class="preview comment-body prose prose-stone prose-sm max-w-none dark:prose-invert" hidden></div>
        <div class="mt-2 flex items-center gap-2">
          <span class="composer-help text-[11px] text-stone-400"></span>
          <span class="flex-1"></span>
          <button class="btn-ghost" data-action="composer-cancel">Cancel</button>
          <button class="btn-primary" data-action="composer-submit"></button>
        </div>
      </div>`;
    margin.append(el);
    resizeObserver.observe(el);
    const quoteText = quote ? `> ${quote.replace(/\n+/g, "\n> ")}\n\n` : "";
    state.composer = { path, start, end, el, anchors: [], mode, quoteText };
    $("textarea", el).value = mode === "claude" ? "" : quoteText;
    setComposerMode(CLAUDE ? mode : "comment");
    activate("composer");
    markAnchors();
    layout();
  }

  /** Switch the composer between posting to GitHub and asking Claude privately. */
  function setComposerMode(mode) {
    const c = state.composer;
    const textarea = $("textarea", c.el);
    const m = MODES[mode];
    if (mode === "claude") {
      togglePreview(c.el, false); // Preview calls GitHub; never in Claude mode
      if (textarea.value === c.quoteText) textarea.value = "";
    } else if (!textarea.value) {
      textarea.value = c.quoteText;
    }
    c.mode = mode;
    c.el.classList.toggle("is-claude", mode === "claude");
    $(".composer-title", c.el).textContent = m.title;
    $(".composer-help", c.el).textContent = m.help;
    $("[data-action=composer-submit]", c.el).textContent = m.submit;
    textarea.placeholder = m.placeholder;
    $$(".mode-switch button", c.el).forEach((b) => b.classList.toggle("on", b.dataset.action === `mode-${mode}`));
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    scheduleLayout();
  }

  function closeComposer() {
    if (!state.composer) return;
    resizeObserver.unobserve(state.composer.el);
    state.composer.el.remove();
    state.composer = null;
    if (state.active === "composer") state.active = null;
    markAnchors();
    layout();
  }

  async function submitComposer() {
    const c = state.composer;
    if (c.mode === "claude") return askClaude();
    const textarea = $("textarea", c.el);
    const body = textarea.value.trim();
    if (!body) return textarea.focus();
    const button = $("[data-action=composer-submit]", c.el);
    button.disabled = true;
    button.textContent = "Posting…";
    try {
      const created = await request("POST", `${API}/comments`, {
        path: c.path, start: c.start, end: c.end, body, commit: RENDERED_SHA,
      });
      state.seen.add(created.id);
      closeComposer();
      toast("Comment posted to the PR");
      await refresh();
      const thread = state.activity.threads.find((t) => t.comments.some((x) => x.id === created.id));
      if (thread) activate(thread.id);
    } catch (err) {
      toast(err.message, { kind: "error", timeout: 8000 });
      button.disabled = false;
      button.textContent = MODES[c.mode].submit;
    }
  }

  async function togglePreview(cardEl, showPreview) {
    const textarea = $("textarea", cardEl);
    const preview = $(".preview", cardEl);
    $$(".tabs button", cardEl).forEach((b) => b.classList.toggle("on", (b.dataset.action === "tab-preview") === showPreview));
    textarea.hidden = showPreview;
    preview.hidden = !showPreview;
    if (showPreview) {
      preview.innerHTML = `<span class="text-stone-400">Rendering…</span>`;
      try {
        const { html } = await request("POST", `${API}/preview`, { body: textarea.value || "_Nothing to preview_" });
        preview.innerHTML = html;
      } catch (err) {
        preview.textContent = err.message;
      }
    }
    scheduleLayout();
  }

  // ── Replies & resolution ─────────────────────────────────────────────
  function expandReply(cardEl) {
    const textarea = $(".thread-reply textarea", cardEl);
    textarea.rows = 3;
    $(".thread-reply .actions", cardEl).hidden = false;
    scheduleLayout();
  }
  function collapseReply(cardEl) {
    const textarea = $(".thread-reply textarea", cardEl);
    textarea.rows = 1;
    $(".thread-reply .actions", cardEl).hidden = true;
    scheduleLayout();
  }

  async function submitReply(cardEl) {
    const card = cards.get(cardEl.dataset.thread);
    const textarea = $(".thread-reply textarea", cardEl);
    const body = textarea.value.trim();
    if (!body) return textarea.focus();
    const button = $("[data-action=reply-submit]", cardEl);
    button.disabled = true;
    try {
      const created = await request("POST", `${API}/replies`, { commentId: card.thread.comments[0].id, body });
      state.seen.add(created.id);
      textarea.value = "";
      store.set(`draft:${card.thread.id}`, null);
      collapseReply(cardEl);
      textarea.blur();
      await refresh();
    } catch (err) {
      toast(err.message, { kind: "error", timeout: 8000 });
    } finally {
      button.disabled = false;
    }
  }

  async function setResolved(threadId, resolved) {
    const thread = state.activity.threads.find((t) => t.id === threadId);
    thread.isResolved = resolved; // optimistic
    if (resolved && state.active === threadId) state.active = null;
    renderThreads();
    try {
      await request("POST", `/api/threads/${encodeURIComponent(threadId)}/resolve`, { resolved });
      toast(resolved ? "Thread resolved" : "Thread reopened", resolved && {
        action: "Undo", onAction: () => setResolved(threadId, false),
      } || {});
      refresh();
    } catch (err) {
      thread.isResolved = !resolved;
      renderThreads();
      toast(err.message, { kind: "error", timeout: 8000 });
    }
  }

  // ── Private Claude threads ───────────────────────────────────────────
  async function askClaude() {
    const c = state.composer;
    const textarea = $("textarea", c.el);
    const question = textarea.value.trim();
    if (!question) return textarea.focus();
    const button = $("[data-action=composer-submit]", c.el);
    button.disabled = true;
    button.textContent = "Asking…";
    try {
      const thread = await request("POST", `${API}/claude/threads`, {
        path: c.path, start: c.start, end: c.end, commit: RENDERED_SHA, question,
      });
      closeComposer();
      upsertClaudeThread(thread);
      renderThreads();
      listen(thread.id);
      activate(thread.id);
    } catch (err) {
      toast(err.message, { kind: "error", timeout: 8000 });
      button.disabled = false;
      button.textContent = MODES.claude.submit;
    }
  }

  function createClaudeCard(t) {
    const el = document.createElement("div");
    el.className = "thread-card claude";
    el.dataset.claude = t.id;
    el.innerHTML = `
      <div class="thread-head"></div>
      <div class="claude-note"></div>
      <div class="thread-body"></div>
      <div class="thread-reply">
        <textarea rows="1" placeholder="Ask a follow-up…"></textarea>
        <div class="actions" hidden>
          <span class="text-[11px] text-stone-400">Private · ⌘↵ to ask</span>
          <span class="flex-1"></span>
          <button class="btn-ghost" data-action="reply-cancel">Cancel</button>
          <button class="btn-primary" data-action="claude-followup">Ask</button>
        </div>
      </div>`;
    return el;
  }

  function claudeMessageHTML(m) {
    if (m.role === "user") {
      return `<div class="comment"><div class="min-w-0 flex-1">
        <div class="comment-meta"><b>You</b>${timeTag(m.createdAt)}</div>
        <div class="comment-body whitespace-pre-wrap">${esc(m.body)}</div></div></div>`;
    }
    if (m.role === "error") {
      return `<div class="comment claude-error"><div class="min-w-0 flex-1">
        <div class="comment-meta"><b>Couldn't answer</b>${timeTag(m.createdAt)}</div>
        <div class="comment-body">${esc(m.body)}</div></div></div>`;
    }
    return `<div class="comment"><div class="min-w-0 flex-1">
      <div class="comment-meta"><b>Claude</b>${timeTag(m.createdAt)}</div>
      <div class="comment-body prose prose-stone prose-sm max-w-none dark:prose-invert">${m.bodyHTML}</div></div></div>`;
  }

  function fillClaudeCard(card) {
    const t = card.thread;
    const head = state.activity.headSha;
    $(".thread-head", card.el).innerHTML = `
      <span class="chip chip-claude">Claude · private</span>
      <span class="chip" title="${esc(t.path)}">${rangeLabel(t.startLine, t.endLine)}</span>
      <span class="flex-1"></span>
      <button class="icon-btn" data-action="claude-delete" title="Delete this thread">Delete</button>`;
    $(".claude-note", card.el).innerHTML = t.commit !== head
      ? `<div class="hint">Asked on <code>${esc(t.commit.slice(0, 7))}</code>; the PR is now at <code>${esc(head.slice(0, 7))}</code>.</div>`
      : "";
    const last = t.messages[t.messages.length - 1];
    let tail = "";
    if (card.live) {
      tail = `<div class="comment"><div class="min-w-0 flex-1">
        <div class="comment-meta"><b>Claude</b><span class="spinner"></span><span class="text-[11px] text-stone-400">${esc(card.live.tool)}</span></div>
        ${card.live.text ? `<div class="comment-body whitespace-pre-wrap">${esc(card.live.text)}</div>` : ""}</div></div>`;
    } else if (!t.running && last?.role === "user") {
      tail = `<div class="hint warn">Interrupted. Ask again.</div>`;
    }
    $(".thread-body", card.el).innerHTML = t.messages.map(claudeMessageHTML).join("") + tail;
    $$(".comment-body a", card.el).forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
    $(".thread-reply textarea", card.el).disabled = !!card.live;
    scheduleLayout();
  }

  function upsertClaudeThread(t) {
    let card = claudeCards.get(t.id);
    if (!card) {
      card = { el: createClaudeCard(t), live: null, source: null, anchors: [], fallback: null };
      claudeCards.set(t.id, card);
      margin.append(card.el);
      resizeObserver.observe(card.el);
    }
    card.thread = t;
    fillClaudeCard(card);
  }

  function removeClaudeCard(id) {
    const card = claudeCards.get(id);
    if (!card) return;
    card.source?.close();
    resizeObserver.unobserve(card.el);
    card.el.remove();
    claudeCards.delete(id);
    if (state.active === id) state.active = null;
  }

  async function loadClaudeThreads() {
    if (!CLAUDE) return;
    let threads;
    try {
      threads = await request("GET", `${API}/claude/threads`);
    } catch (err) {
      return toast(`Couldn't load Claude threads: ${err.message}`, { kind: "error" });
    }
    const ids = new Set(threads.map((t) => t.id));
    for (const id of [...claudeCards.keys()]) if (!ids.has(id)) removeClaudeCard(id);
    threads.forEach(upsertClaudeThread);
    renderThreads();
    threads.filter((t) => t.running).forEach((t) => listen(t.id));
  }

  /** Follow a running turn; any tab (or a reload) can join part-way through. */
  function listen(id) {
    const card = claudeCards.get(id);
    if (!card || card.source) return;
    card.live = { text: "", tool: "Thinking…" };
    fillClaudeCard(card);
    const source = new EventSource(`/api/claude/threads/${encodeURIComponent(id)}/events`);
    card.source = source;
    const finish = () => {
      source.close();
      card.source = null;
      card.live = null;
      loadClaudeThreads();
    };
    source.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "text") card.live.text += ev.text;
      else if (ev.type === "tool") card.live.tool = ev.text;
      else return finish(); // done, error or idle
      fillClaudeCard(card);
    };
    source.onerror = finish;
  }

  async function submitFollowup(cardEl) {
    const id = cardEl.dataset.claude;
    const textarea = $(".thread-reply textarea", cardEl);
    const question = textarea.value.trim();
    if (!question) return textarea.focus();
    const button = $("[data-action=claude-followup]", cardEl);
    button.disabled = true;
    try {
      const thread = await request("POST", `/api/claude/threads/${encodeURIComponent(id)}/messages`, { question });
      textarea.value = "";
      collapseReply(cardEl);
      upsertClaudeThread(thread);
      listen(id);
    } catch (err) {
      toast(err.message, { kind: "error", timeout: 8000 });
    } finally {
      button.disabled = false;
    }
  }

  async function deleteClaudeThread(id) {
    if (!confirm("Delete this Claude thread? This can't be undone.")) return;
    try {
      await request("DELETE", `/api/claude/threads/${encodeURIComponent(id)}`);
      removeClaudeCard(id);
      renderThreads();
    } catch (err) {
      toast(err.message, { kind: "error", timeout: 8000 });
    }
  }

  // ── Margin interactions (event delegation) ───────────────────────────
  margin.addEventListener("click", (e) => {
    const cardEl = e.target.closest(".thread-card");
    if (!cardEl) return;
    if (cardEl.classList.contains("claude")) {
      const cid = cardEl.dataset.claude;
      switch (e.target.closest("[data-action]")?.dataset.action) {
        case "claude-delete": return deleteClaudeThread(cid);
        case "claude-followup": return submitFollowup(cardEl);
        case "reply-cancel": $(".thread-reply textarea", cardEl).value = ""; return collapseReply(cardEl);
      }
      if (!e.target.closest("a, textarea, button") && state.active !== cid) activate(cid);
      return;
    }
    const action = e.target.closest("[data-action]")?.dataset.action;
    const id = cardEl.dataset.thread;
    switch (action) {
      case "resolve": return setResolved(id, true);
      case "unresolve": return setResolved(id, false);
      case "expand": state.expanded.add(id); return activate(id);
      case "collapse":
        state.expanded.delete(id);
        if (state.active === id) state.active = null;
        cards.get(id).sig = null;
        return renderThreads();
      case "more": {
        const commentEl = e.target.closest(".comment");
        state.expandedBodies.add(+commentEl.dataset.comment);
        $(".comment-body", commentEl).classList.remove("clamped");
        e.target.remove();
        return scheduleLayout();
      }
      case "reply-cancel": {
        const textarea = $(".thread-reply textarea", cardEl);
        textarea.value = "";
        store.set(`draft:${id}`, null);
        return collapseReply(cardEl);
      }
      case "reply-submit": return submitReply(cardEl);
      case "composer-cancel": return closeComposer();
      case "composer-submit": return submitComposer();
      case "tab-write": return togglePreview(cardEl, false);
      case "tab-preview": return togglePreview(cardEl, true);
      case "mode-comment": return setComposerMode("comment");
      case "mode-claude": return setComposerMode("claude");
    }
    if (e.target.closest("a, textarea, button")) return;
    if (cardEl.classList.contains("composer")) return activate("composer");
    if (state.active !== id) activate(id);
  });

  margin.addEventListener("focusin", (e) => {
    const cardEl = e.target.closest(".thread-card");
    if (e.target.matches(".thread-reply textarea")) {
      expandReply(cardEl);
      const tid = cardEl.dataset.thread || cardEl.dataset.claude;
      if (state.active !== tid) activate(tid);
    }
  });

  margin.addEventListener("input", (e) => {
    if (e.target.matches(".thread-reply textarea") && e.target.closest(".thread-card").dataset.thread) {
      store.set(`draft:${e.target.closest(".thread-card").dataset.thread}`, e.target.value || null);
    }
  });

  margin.addEventListener("keydown", (e) => {
    if (!e.target.matches("textarea")) return;
    const cardEl = e.target.closest(".thread-card");
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (cardEl.classList.contains("composer")) submitComposer();
      else if (cardEl.classList.contains("claude")) submitFollowup(cardEl);
      else submitReply(cardEl);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (cardEl.classList.contains("composer") && !e.target.value.trim()) closeComposer();
      else if (!cardEl.classList.contains("composer") && !e.target.value.trim()) collapseReply(cardEl);
      e.target.blur();
    }
  });

  // ── Document interactions: gutter "+", selection, clicking highlights ─
  const gutterBtn = $("#gutter-add");
  let hoverEl = null;

  doc.addEventListener("mousemove", (e) => {
    if (e.target === gutterBtn) return;
    const el = e.target.closest(".view [data-ls]");
    if (el === hoverEl) return;
    // Keep the "+" while the cursor crosses the padding between the block and the button.
    if (!el && hoverEl && inGutterOf(hoverEl, e)) return;
    hoverEl?.classList.remove("is-hover-target");
    hoverEl = el;
    if (!el) { gutterBtn.hidden = true; return; }
    el.classList.add("is-hover-target");
    const elRect = el.getBoundingClientRect();
    const docRect = doc.getBoundingClientRect();
    const lineBox = Math.min(el.offsetHeight, 28);
    gutterBtn.style.top = `${elRect.top - docRect.top + (lineBox - 24) / 2 + (el.matches("tr, .code-line") ? 0 : 3)}px`;
    gutterBtn.style.left = `${Math.max(6, elRect.left - docRect.left - 30)}px`;
    gutterBtn.hidden = false;
  });
  doc.addEventListener("mouseleave", () => {
    hoverEl?.classList.remove("is-hover-target");
    hoverEl = null;
    gutterBtn.hidden = true;
  });
  function inGutterOf(el, e) {
    const r = el.getBoundingClientRect();
    return e.clientY >= r.top && e.clientY <= r.bottom && e.clientX < r.left;
  }
  gutterBtn.addEventListener("click", () => {
    if (!hoverEl) return;
    const section = hoverEl.closest("section.file");
    openComposer({ path: section.dataset.path, start: +hoverEl.dataset.ls, end: +hoverEl.dataset.le });
  });

  doc.addEventListener("click", (e) => {
    if (e.target.closest("a, button, summary, input, textarea")) return;
    if (!getSelection().isCollapsed) return;
    const anchor = e.target.closest(".has-thread, .has-claude");
    if (anchor?._threads?.length) {
      const list = anchor._threads;
      const next = list[(list.indexOf(state.active) + 1) % list.length];
      activate(next);
      return;
    }
    const block = e.target.closest(".view [data-ls]");
    if (block) {
      const path = block.closest("section.file").dataset.path;
      const start = +block.dataset.ls, end = +block.dataset.le;
      const c = state.composer;
      if (c && c.path === path && c.start === start && c.end === end) return;
      openComposer({ path, start, end });
    } else if (state.active && state.active !== "composer") {
      activate(null);
    }
  });

  const selectionBtn = $("#selection-add");
  let pendingSelection = null;

  function currentSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const quote = sel.toString().trim();
    if (!quote) return null;
    const range = sel.getRangeAt(0);
    const elementOf = (node) => (node.nodeType === 1 ? node : node.parentElement);
    const a = elementOf(range.startContainer)?.closest(".view [data-ls]");
    let b = elementOf(range.endContainer)?.closest(".view [data-ls]");
    // Triple-click selections end at offset 0 of the following block.
    if (b && b !== a && range.endOffset === 0) b = a;
    if (!a || !b) return null;
    const section = a.closest("section.file");
    if (section !== b.closest("section.file")) return null;
    const start = Math.min(+a.dataset.ls, +b.dataset.ls);
    const end = Math.max(+a.dataset.le, +b.dataset.le);
    // Only quote when the selection is a fragment; whole blocks are already obvious on GitHub.
    const whole = a === b && a.textContent.replace(/\s+/g, " ").trim() === quote.replace(/\s+/g, " ");
    return {
      path: section.dataset.path, start, end,
      quote: whole ? null : quote.slice(0, 400),
      rect: range.getBoundingClientRect(),
    };
  }

  function placeSelectionButton() {
    pendingSelection = currentSelection();
    if (!pendingSelection) return hideSelectionButton();
    const { rect } = pendingSelection;
    selectionBtn.hidden = false;
    const width = selectionBtn.offsetWidth;
    const top = rect.top > 90 ? rect.top - 40 : rect.bottom + 8;
    selectionBtn.style.top = `${top}px`;
    selectionBtn.style.left = `${Math.max(8, rect.left + rect.width / 2 - width / 2)}px`;
  }
  function hideSelectionButton() {
    selectionBtn.hidden = true;
    pendingSelection = null;
  }

  let selectionTimer;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(placeSelectionButton, 150);
  });
  window.addEventListener("scroll", () => { if (!selectionBtn.hidden) placeSelectionButton(); }, { passive: true });
  selectionBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  selectionBtn.addEventListener("click", () => {
    if (pendingSelection) openComposer(pendingSelection);
    getSelection().removeAllRanges();
  });

  // ── Keyboard ─────────────────────────────────────────────────────────
  function orderedOpenThreads() {
    return [...cards.values()]
      .filter((c) => !c.el.hidden && !c.thread.isResolved)
      .map((c) => ({ id: c.thread.id, top: anchorTop(c.anchors, c.fallback) + scrollY }))
      .sort((a, b) => a.top - b.top);
  }
  function stepThread(direction) {
    const list = orderedOpenThreads();
    if (!list.length) return toast("No open threads 🎉");
    let index = list.findIndex((t) => t.id === state.active);
    if (index < 0) {
      // Start from whatever is on screen.
      const y = scrollY + innerHeight * 0.3;
      index = direction > 0 ? list.findIndex((t) => t.top > y) : list.findLastIndex((t) => t.top < y);
      if (index < 0) index = direction > 0 ? 0 : list.length - 1;
    } else {
      index = (index + direction + list.length) % list.length;
    }
    activate(list[index].id, { scroll: true });
  }
  $("#next-thread").onclick = () => stepThread(1);
  $("#prev-thread").onclick = () => stepThread(-1);

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j") stepThread(1);
    else if (e.key === "k") stepThread(-1);
    else if (e.key === "c" && pendingSelection) { e.preventDefault(); openComposer(pendingSelection); getSelection().removeAllRanges(); }
    else if (e.key === "a" && CLAUDE && pendingSelection) { e.preventDefault(); openComposer({ ...pendingSelection, mode: "claude" }); getSelection().removeAllRanges(); }
    else if (e.key === "r" && cards.get(state.active)) { e.preventDefault(); $(".thread-reply textarea", cards.get(state.active).el)?.focus(); }
    else if (e.key === "Escape") {
      if (state.composer && !$("textarea", state.composer.el).value.trim()) closeComposer();
      activate(null);
    }
  });

  // ── Rail: stats, filters, outline ────────────────────────────────────
  function updateStats() {
    const visible = state.activity.threads.filter((t) => !(state.hideBots && isBotThread(t)));
    $("#stat-open").textContent = visible.filter((t) => !t.isResolved).length;
    $("#stat-resolved").textContent = visible.filter((t) => t.isResolved).length;
  }

  function updateOutlineCounts() {
    const links = $$(".outline-link[data-line]");
    links.forEach((link, i) => {
      const line = +link.dataset.line;
      const next = links[i + 1]?.dataset.path === link.dataset.path ? +links[i + 1].dataset.line : Infinity;
      const count = state.activity.threads.filter((t) => {
        const range = threadRange(t);
        return range && t.path === link.dataset.path && !t.isResolved && isShown(t) && range[1] >= line && range[1] < next;
      }).length;
      const badge = $(".count", link);
      badge.hidden = !count;
      badge.textContent = count;
    });
  }

  function renderFilters() {
    $$("[data-filter]").forEach((b) => b.classList.toggle("on", b.dataset.filter === state.filter));
    $("#hide-bots").checked = state.hideBots;
    const showClaude = $("#show-claude");
    if (showClaude) showClaude.checked = state.showClaude;
  }
  $$("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    state.filter = b.dataset.filter;
    store.set("filter", state.filter);
    renderFilters();
    renderThreads();
  }));
  $("#hide-bots").addEventListener("change", (e) => {
    state.hideBots = e.target.checked;
    store.set("hideBots", state.hideBots);
    renderThreads();
    renderConversation();
  });

  $("#show-claude")?.addEventListener("change", (e) => {
    state.showClaude = e.target.checked;
    store.set("showClaude", state.showClaude);
    renderThreads();
  });

  // Scroll-spy for the outline.
  const outlineLinks = $$(".outline-link");
  const outlineTargets = outlineLinks.map((l) => document.getElementById(l.dataset.target));
  function spy() {
    let current = 0;
    outlineTargets.forEach((el, i) => { if (el && el.getBoundingClientRect().top < 140) current = i; });
    outlineLinks.forEach((l, i) => l.classList.toggle("on", i === current));
  }
  window.addEventListener("scroll", () => requestAnimationFrame(spy), { passive: true });

  // Rendered ↔ Changes toggle for modified markdown files.
  $$("section.file").forEach((section) => {
    const toggles = $$(".view-toggle", section);
    const sync = () => toggles.forEach((t) => t.classList.toggle("on", !$(`.view[data-view="${t.dataset.view}"]`, section).hidden));
    toggles.forEach((t) => t.addEventListener("click", () => {
      $$(".view", section).forEach((v) => (v.hidden = v.dataset.view !== t.dataset.view));
      sync();
      markAnchors();
      layout();
    }));
    sync();
  });

  // ── Conversation ─────────────────────────────────────────────────────
  const VERDICTS = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "review dismissed" };

  function renderConversation() {
    const items = state.activity.conversation.filter((c) => !(state.hideBots && c.author.isBot));
    $("#conversation-list").innerHTML = items.length ? items.map((c) => `
      <li class="convo-item">
        <img src="${esc(c.author.avatarUrl)}" alt="">
        <div class="min-w-0 flex-1">
          <div class="comment-meta text-sm">
            <b>${esc(c.author.login)}</b>
            ${c.kind === "review" ? `<span class="verdict verdict-${c.state}">${VERDICTS[c.state] || c.state}</span>` : ""}
            ${c.author.isBot ? `<span class="chip chip-bot">bot</span>` : ""}
            ${timeTag(c.createdAt)}
            ${state.fresh.has(c.id) ? `<span class="chip chip-new">new</span>` : ""}
            <a class="ml-auto text-xs text-stone-400 hover:text-stone-700" href="${esc(c.url)}" target="_blank" rel="noopener">↗</a>
          </div>
          ${c.bodyHTML ? `<div class="comment-body gh-body prose prose-stone prose-sm mt-1 max-w-none dark:prose-invert">${c.bodyHTML}</div>` : ""}
        </div>
      </li>`).join("")
      : `<li class="text-sm text-stone-500">No general comments yet.</li>`;
    $$("#conversation-list .comment-body a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
    const badge = $("#conversation-count");
    badge.hidden = !items.length;
    badge.textContent = items.length;
  }

  $("#conversation-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = form.body.value.trim();
    if (!body) return;
    const button = $("button", form);
    button.disabled = true;
    try {
      const created = await request("POST", `${API}/conversation`, { body });
      state.seen.add(created.id);
      form.reset();
      await refresh();
    } catch (err) {
      toast(err.message, { kind: "error", timeout: 8000 });
    } finally {
      button.disabled = false;
    }
  });
  $("#conversation-form textarea").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#conversation-form").requestSubmit();
  });

  // ── Finish review ────────────────────────────────────────────────────
  const dialog = $("#review-dialog");
  $("#finish-review").onclick = () => dialog.showModal();
  $("#review-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const event = form.event.value;
    const body = form.body.value.trim();
    if (event !== "APPROVE" && !body) {
      form.body.focus();
      return toast("Add a summary for this kind of review", { kind: "error" });
    }
    const button = $("button[type=submit]", form);
    button.disabled = true;
    try {
      const created = await request("POST", `${API}/review`, { event, body });
      state.seen.add(created.id);
      dialog.close();
      form.reset();
      toast(event === "APPROVE" ? "Approved ✓" : "Review submitted");
      await refresh();
    } catch (err) {
      toast(err.message, { kind: "error", timeout: 8000 });
    } finally {
      button.disabled = false;
    }
  });

  // ── Live updates ─────────────────────────────────────────────────────
  const syncDot = $("#sync-dot");
  const syncLabel = $("#sync-label");
  let syncError = null;

  function renderSync(fetching = false) {
    syncDot.className = `h-2 w-2 rounded-full ${fetching ? "bg-amber-400 animate-pulse" : syncError ? "bg-rose-500" : "bg-emerald-500"}`;
    syncLabel.textContent = fetching ? "Checking…"
      : signedOut ? "Signed out"
      : syncError ? "Sync failed — retrying"
      : `Live · ${timeAgo(new Date(state.lastSync).toISOString())}`;
    if (syncError) syncLabel.parentElement.title = syncError;
  }

  function renderState() {
    const a = state.activity;
    const label = a.isDraft && a.state === "OPEN" ? "DRAFT" : a.state;
    const pill = $("#pr-state");
    pill.className = `state-pill state-${label}`;
    pill.textContent = label.toLowerCase();
  }

  function applyActivity(next) {
    const viewer = next.viewer.login;
    const arrivals = [];
    const collect = (c, threadId) => {
      if (state.seen.has(c.id)) return;
      state.seen.add(c.id);
      if (c.author.login === viewer) return;
      state.fresh.add(c.id);
      arrivals.push({ comment: c, threadId });
    };
    next.threads.forEach((t) => t.comments.forEach((c) => collect(c, t.id)));
    next.conversation.forEach((c) => collect(c, null));
    store.set("seen", [...state.seen]);

    state.activity = next;
    $("#new-commits").hidden = next.headSha === RENDERED_SHA;
    renderState();
    renderThreads();
    for (const card of claudeCards.values()) if (!card.live) fillClaudeCard(card);
    renderConversation();

    if (arrivals.length) {
      const names = [...new Set(arrivals.map((a) => a.comment.author.login))].join(", ");
      const first = arrivals.find((a) => a.threadId);
      toast(`${arrivals.length} new comment${arrivals.length > 1 ? "s" : ""} from ${names}`, {
        timeout: 9000,
        action: "Show",
        onAction: () => first
          ? activate(first.threadId, { scroll: true })
          : $("#conversation").scrollIntoView({ behavior: "smooth" }),
      });
      for (const a of arrivals) {
        const el = a.threadId && cards.get(a.threadId)?.el;
        if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
      }
      if (document.hidden) {
        state.unreadWhileHidden += arrivals.length;
        document.title = `(${state.unreadWhileHidden}) ${document.title.replace(/^\(\d+\) /, "")}`;
      }
    }
  }

  let inflight = null;
  function refresh() {
    inflight ||= (async () => {
      renderSync(true);
      try {
        applyActivity(await request("GET", `${API}/activity`));
        state.lastSync = Date.now();
        syncError = null;
        signedOut = false;
      } catch (err) {
        syncError = err.message;
      } finally {
        inflight = null;
        renderSync();
      }
    })();
    return inflight;
  }

  $("#sync").onclick = () => refresh();
  setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    state.unreadWhileHidden = 0;
    document.title = document.title.replace(/^\(\d+\) /, "");
    if (Date.now() - state.lastSync > POLL_MS) refresh();
  });

  // Keep relative timestamps fresh.
  setInterval(() => {
    $$("[data-time]").forEach((el) => (el.textContent = timeAgo(el.dataset.time)));
    renderSync(!!inflight);
  }, 20_000);

  // ── Boot ─────────────────────────────────────────────────────────────
  $$("[data-time]").forEach((el) => (el.textContent = timeAgo(el.dataset.time)));
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("spec-tackle:layout", scheduleLayout);
  $$(".doc-body img").forEach((img) => img.addEventListener("load", scheduleLayout));
  document.fonts?.ready.then(scheduleLayout);

  renderFilters();
  renderState();
  renderThreads();
  renderConversation();
  loadClaudeThreads();
  renderSync();
  spy();
})();
