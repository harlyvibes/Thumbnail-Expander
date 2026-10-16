// Adds an expand button to video thumbnails. Clicking it enlarges the thumbnail's hover preview
// (the video the site plays while you hover a thumbnail) to fill the window. Nothing new is
// loaded, so it never opens the video's page.
(() => {
  const BUTTON_CLASS = "te-expand-btn";
  const ATTACHED_ATTR = "data-te-attached";
  // Marks the element holding a button, so the debug tools can find the hovered thumbnail.
  const HOST_ATTR = "data-te-host";
  // Marks the enlarged preview; content.css sizes it to the window.
  const ENLARGED_ATTR = "data-te-enlarged";
  const WAIT_FOR_PREVIEW_MS = 5000;
  // The close button on an enlarged preview hides after the mouse rests this long.
  const CONTROLS_IDLE_MS = 2500;
  // Mouse movement the site would use to notice the mouse leaving its thumbnail.
  const MOVE_EVENTS = [
    "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave",
    "pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave", "pointerrawupdate"
  ];
  const SCROLL_KEYS = new Set([" ", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

  let settings = null;
  let activeRules = [];
  const hostRules = new WeakMap(); // button host -> its site rule
  // The enlarged preview: { media, host, rule, restore, ui, timer, watcher, misses, anchor, moved, idleTimer }
  let preview = null;
  let scanQueued = false;
  let observer = null;
  let lastMouse = null; // for the debug shortcut
  let debugWatch = null; // debug mode: outlines the preview of the hovered thumbnail
  let watchedPreview = null;

  init();

  // Console output, only in debug mode.
  function log(...args) {
    if (settings?.debug) console.log("%c[Thumbnail Expander]", "color:#8b5cf6;font-weight:bold", ...args);
  }

  async function init() {
    settings = await loadSettings();
    applySettings();

    window.addEventListener("keydown", onDebugShortcut, true);
    // On window, and added before the enlarged preview hides mouse movement from the site, so it
    // still sees the mouse.
    window.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });

    // Requests from the toolbar popup's debug tools.
    ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === "te-check") {
        sendResponse(checkPage());
      } else if (msg?.type === "te-pick") {
        sendResponse({ ok: true });
        pickThumbnail();
      }
    });

    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      // Remove existing buttons so they are rebuilt with the new rules.
      document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((b) => b.remove());
      document.querySelectorAll(`[${ATTACHED_ATTR}]`).forEach((el) => el.removeAttribute(ATTACHED_ATTR));
      document.querySelectorAll(`[${HOST_ATTR}]`).forEach((el) => el.removeAttribute(HOST_ATTR));
      loadSettings().then((s) => {
        settings = s;
        applySettings();
      });
    });
  }

  async function loadSettings() {
    const data = await ext.storage.sync.get(["settings"]);
    return mergeSettings(data.settings);
  }

  function applySettings() {
    activeRules = settings.enabled
      ? settings.sites.filter((s) => s.enabled && s.thumbnail && ruleMatchesHost(s, location.hostname))
      : [];
    // Debug mode outlines every recognized thumbnail (see content.css).
    document.documentElement.classList.toggle("te-debug", Boolean(settings.debug));
    log(activeRules.length ? `Active rules: ${activeRules.map((r) => r.name).join(", ")}` : "No rule for this site.");
    scan();
    observeDom();
    toggleDebugWatch();
  }

  function scan() {
    for (const rule of activeRules) {
      let thumbs = [];
      try {
        thumbs = document.querySelectorAll(rule.thumbnail);
      } catch (err) {
        console.warn("[Thumbnail Expander] Bad thumbnail selector for", rule.name, err);
        continue;
      }
      let added = 0;
      thumbs.forEach((thumb) => {
        if (attach(thumb, rule)) added++;
      });
      if (added) log(`${rule.name}: added ${added} button(s); thumbnail selector matches ${thumbs.length} on the page.`);
    }
  }

  // Pages load thumbnails dynamically, so rescan whenever the DOM changes.
  function observeDom() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (scanQueued) return;
      scanQueued = true;
      requestAnimationFrame(() => {
        scanQueued = false;
        scan();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Rounded-stroke line icons (24x24). The expand corners match the extension icon.
  const EXPAND_ICON = "M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3";
  const CLOSE_ICON = "M6 6l12 12M18 6L6 18";
  const SPEAKER = "M11 5L6 9H3v6h3l5 4z";
  const VOLUME_ICONS = {
    muted: SPEAKER + "M16 9l6 6M22 9l-6 6",
    low: SPEAKER + "M15.5 8.5a5 5 0 0 1 0 7",
    high: SPEAKER + "M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"
  };

  // Built with DOM calls rather than innerHTML, which some sites (e.g. YouTube) forbid.
  function createIcon(d) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2.4");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  // Adds the expand button to one thumbnail. Returns true if a button was added.
  function attach(thumb, rule) {
    if (thumb.hasAttribute(ATTACHED_ATTR)) return false;
    thumb.setAttribute(ATTACHED_ATTR, "1");

    // The button is absolutely positioned, so it needs a positioning context. An inline element
    // (typically a link wrapping an absolutely positioned image) must not be made relative: its
    // children would be positioned against its tiny inline box and the thumbnail would collapse.
    // Use the nearest positioned ancestor instead and leave the page's styles alone.
    let host = thumb;
    const style = getComputedStyle(thumb);
    if (style.display === "inline" || style.display === "contents") {
      host = thumb.offsetParent || thumb.parentElement;
    } else if (style.position === "static") {
      thumb.style.position = "relative";
    }
    // No usable container (the button would land in a page corner), or it already has a button.
    if (!host || host === document.body || host === document.documentElement) return false;
    if (host.querySelector(`:scope > .${BUTTON_CLASS}`)) return false;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BUTTON_CLASS;
    btn.title = "Expand preview";
    btn.setAttribute("aria-label", "Expand preview");
    btn.appendChild(createIcon(EXPAND_ICON));
    btn.addEventListener("click", (e) => {
      // Stop the thumbnail's link from opening the video's page.
      e.preventDefault();
      e.stopPropagation();
      expandPreview(host, rule);
    });

    host.setAttribute(HOST_ATTR, "");
    hostRules.set(host, rule);
    host.appendChild(btn);
    return true;
  }

  // ---------- Finding and enlarging the preview ----------

  async function expandPreview(host, rule) {
    closePreview();
    log(`Expand clicked (${rule.name}). Thumbnail:`, host);
    let found = findPreview(host, rule);
    if (!found) {
      // Clicked before the preview started: give it a few seconds.
      toast("Waiting for the preview to start…");
      const started = Date.now();
      while (!found && Date.now() - started < WAIT_FOR_PREVIEW_MS) {
        await new Promise((r) => setTimeout(r, 150));
        found = findPreview(host, rule);
      }
      document.querySelector(".te-toast")?.remove();
    }
    if (!found) {
      log("No preview found for", host, rule.preview ? `(preview selector: ${rule.preview})` : "(auto-detect)");
      toast(
        rule.preview
          ? `No preview found with this site's preview selector (${rule.preview}). Hover the thumbnail until the preview plays, then click expand.`
          : "No preview is playing in this thumbnail. Hover it until the preview starts, then click expand."
      );
      return;
    }
    log(`Preview found by ${found.how}:`, found.media);

    // Describe it before enlarging changes its size.
    const details = settings.debug && {
      thumbnail: teDescribe(host),
      media: teDescribe(found.media),
      suggestion: teSuggestSelector(found.media, "preview")
    };
    if (enlargePreview(found.media, host, rule) && details) showPreviewDebug(rule, found, details);
  }

  // The preview for a thumbnail, as { media, how }, or null.
  //   With a preview selector: the match covering most of the thumbnail, or the only one visible.
  //   Without: whichever video or player iframe covers most of the thumbnail.
  function findPreview(host, rule) {
    let candidates = [];
    try {
      candidates = [...document.querySelectorAll(rule.preview || TE_PREVIEW_MEDIA)];
    } catch {
      return null; // invalid selector; checkPage reports it
    }
    candidates = candidates.filter((m) => {
      const r = m.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !m.closest("#te-preview-ui");
    });

    const t = host.getBoundingClientRect();
    const thumbArea = t.width * t.height;
    let best = null;
    let bestCover = 0;
    for (const m of candidates) {
      const r = m.getBoundingClientRect();
      const w = Math.min(r.right, t.right) - Math.max(r.left, t.left);
      const h = Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top);
      const cover = thumbArea && w > 0 && h > 0 ? (w * h) / thumbArea : 0;
      if (cover > bestCover) {
        best = m;
        bestCover = cover;
      }
    }
    const pct = Math.round(bestCover * 100);
    if (bestCover >= 0.4) {
      return { media: best, how: rule.preview ? `the preview selector (covers ${pct}% of the thumbnail)` : `auto-detect: the video covering ${pct}% of the thumbnail` };
    }
    // Some sites play the preview somewhere else on the page; a preview selector still finds it.
    if (rule.preview && candidates.length === 1) {
      return { media: candidates[0], how: "the preview selector (its only match on the page)" };
    }
    return null;
  }

  // Enlarges the preview element itself to fill the window. It's lifted into the browser's top
  // layer (as a popover), which draws it above everything on the page, outside any box that could
  // clip, shrink or cover it. It stays where it is in the page, so the site still treats it as the
  // thumbnail's preview and keeps it playing. Everything is put back on close.
  // Returns true if the preview was enlarged.
  function enlargePreview(media, host, rule) {
    const restore = [];

    // A link around the preview would open the video's page when the preview is clicked.
    for (let a = media.parentElement; a; a = a.parentElement) {
      if (!a.matches("a[href]")) continue;
      const href = a.getAttribute("href");
      a.removeAttribute("href");
      restore.push(() => a.setAttribute("href", href));
    }

    const popoverBefore = media.getAttribute("popover");
    restore.push(() => {
      if (media.matches(":popover-open")) media.hidePopover();
      if (popoverBefore === null) media.removeAttribute("popover");
      else media.setAttribute("popover", popoverBefore);
      media.removeAttribute(ENLARGED_ATTR);
    });

    // The preview plays exactly as the site plays it; only its size changes. Clicks on it are
    // kept away from the site, which might open the video's page on them.
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const CLICKS = ["click", "dblclick", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup"];
    CLICKS.forEach((type) => media.addEventListener(type, swallow));
    restore.push(() => CLICKS.forEach((type) => media.removeEventListener(type, swallow)));

    // Hide mouse movement from the site. The mouse is now over the big preview, often far outside
    // the thumbnail, and sites stop a preview once they see the mouse leave its thumbnail. As far
    // as the site knows, the mouse stays where it clicked. The page can't scroll either: sites
    // also stop previews that scroll out of view.
    MOVE_EVENTS.forEach((type) => window.addEventListener(type, hideFromSite, true));
    window.addEventListener("wheel", noScroll, { capture: true, passive: false });
    restore.push(() => {
      MOVE_EVENTS.forEach((type) => window.removeEventListener(type, hideFromSite, true));
      window.removeEventListener("wheel", noScroll, { capture: true });
    });

    // Close button, hint and volume control, in the top layer above the preview. They sit next to
    // the preview in the page, so the mouse is still inside the thumbnail as far as the page can
    // tell.
    const ui = document.createElement("div");
    ui.id = "te-preview-ui";
    ui.className = "te-idle"; // the controls show once the mouse moves
    ui.setAttribute("popover", "manual");
    ui.append(...createCloseControls());
    const volume = createVolumeControl(media, restore);
    if (volume) ui.append(volume);
    CLICKS.forEach((type) => ui.addEventListener(type, (e) => e.stopPropagation()));
    media.parentElement.appendChild(ui);

    // Puts the preview back on top as soon as the site touches the attributes that keep it there.
    const watcher = new MutationObserver(() => preview && keepEnlarged());
    watcher.observe(media, { attributes: true, attributeFilter: [ENLARGED_ATTR, "popover"] });

    setWatched(null);
    preview = {
      media, host, rule, restore, ui, watcher,
      timer: setInterval(checkEnlarged, 250),
      misses: 0,
      anchor: lastMouse, // where the mouse was when it opened (see revealControls)
      moved: false,
      idleTimer: null
    };
    document.addEventListener("keydown", onKeyDown, true);

    if (!keepEnlarged()) {
      closePreview();
      toast("Couldn't enlarge this preview.");
      return false;
    }
    hideScrollbars(restore);
    // Take keyboard focus off the expand button underneath, so keys can't press it again.
    if (document.activeElement?.classList.contains(BUTTON_CLASS)) document.activeElement.blur();
    // The cursor hides once the mouse has rested a moment (see revealControls).
    restartIdleTimer(preview);
    return true;
  }

  // The page's scrollbar would show beside the enlarged preview (the browser draws it outside
  // anything the page can cover), so hide it while the preview is enlarged.
  function hideScrollbars(restore) {
    const html = document.documentElement;
    const body = document.body;
    // The body's overflow normally applies to the window. Once the page's own is hidden, the
    // body would get a scrollbar of its own instead.
    const bodyScrolls = body && getComputedStyle(body).overflowY !== "visible";
    // Each direction separately, so the page's own inline values are put back exactly.
    const hide = (el) => {
      for (const prop of ["overflow-x", "overflow-y"]) {
        const before = el.style.getPropertyValue(prop);
        const priority = el.style.getPropertyPriority(prop);
        el.style.setProperty(prop, "hidden", "important");
        restore.push(() => (before ? el.style.setProperty(prop, before, priority) : el.style.removeProperty(prop)));
      }
    };
    hide(html);
    if (bodyScrolls) hide(body);
  }

  // Like a video player, the controls (close button, volume) and the mouse cursor show while the
  // mouse moves over the enlarged preview and hide once it rests (unless it's resting on a
  // control). The controls start out hidden; the cursor hides after the first rest.
  function revealControls() {
    const p = preview;
    if (!p.moved) {
      // The browser can send a mousemove without real movement when the page changes under it.
      if (p.anchor && Math.hypot(lastMouse.x - p.anchor.x, lastMouse.y - p.anchor.y) < 4) return;
      p.moved = true;
    }
    setIdle(p, false);
    restartIdleTimer(p);
  }

  function restartIdleTimer(p) {
    clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(function hide() {
      if (preview !== p) return;
      if (p.ui.querySelector(".te-close:hover, .te-volume:hover")) p.idleTimer = setTimeout(hide, CONTROLS_IDLE_MS);
      else setIdle(p, true);
    }, CONTROLS_IDLE_MS);
  }

  // content.css hides the controls (te-idle) and the cursor over the preview ("idle").
  function setIdle(p, idle) {
    p.ui.classList.toggle("te-idle", idle);
    p.media.setAttribute(ENLARGED_ATTR, idle ? "idle" : "");
  }

  // Puts the enlarged preview in the top layer, with the close button above it. Called again
  // whenever the site disturbs it. Returns false if that isn't possible.
  function keepEnlarged() {
    const { media, ui } = preview;
    try {
      if (!media.hasAttribute(ENLARGED_ATTR)) media.setAttribute(ENLARGED_ATTR, "");
      if (media.getAttribute("popover") !== "manual") media.setAttribute("popover", "manual");
      if (!ui.isConnected) (media.parentElement || document.documentElement).appendChild(ui);
      if (!media.matches(":popover-open")) {
        media.showPopover();
        // The preview is now above the close button; put the button back on top.
        if (ui.matches(":popover-open")) ui.hidePopover();
      }
      if (!ui.matches(":popover-open")) ui.showPopover();
      return true;
    } catch (err) {
      log("Couldn't put the preview on top:", err);
      return false;
    }
  }

  // Runs every 250 ms while a preview is enlarged. Keeps it on top, follows the site if it swaps
  // in a new preview element, and closes once the site has stopped the preview.
  function checkEnlarged() {
    const { media, host, rule } = preview;
    if (media.isConnected && media.getClientRects().length) {
      preview.misses = 0;
      keepEnlarged();
      return;
    }
    const next = !media.isConnected && findPreview(host, rule);
    if (next) {
      log("The site replaced the preview element. Enlarging the new one:", next.media);
      closePreview();
      enlargePreview(next.media, host, rule);
      return;
    }
    // Removed, or hidden by the site. Give it a second to come back.
    if (++preview.misses >= 4) {
      closePreview();
      toast("The site stopped the preview.");
    }
  }

  function closePreview() {
    if (!preview) return;
    clearInterval(preview.timer);
    clearTimeout(preview.idleTimer);
    preview.watcher.disconnect();
    preview.ui.remove();
    preview.restore.reverse().forEach((undo) => undo());
    preview = null;
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function hideFromSite(e) {
    e.stopImmediatePropagation();
  }

  function noScroll(e) {
    e.preventDefault();
  }

  // Close button plus a brief "Press Esc to close" hint that fades out on its own.
  function createCloseControls() {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "te-close";
    closeBtn.title = "Close (Esc)";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.appendChild(createIcon(CLOSE_ICON));
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePreview();
    });

    const hint = document.createElement("div");
    hint.className = "te-hint";
    const key = document.createElement("kbd");
    key.textContent = "Esc";
    hint.append("Press ", key, " to close");
    return [closeBtn, hint];
  }

  // Mute button and volume slider for the enlarged preview (bottom left). The mouse wheel over it
  // changes the volume too. If you change the sound, it's put back as the site had it on close.
  // Returns null for a player iframe, whose sound the page can't reach.
  function createVolumeControl(media, restore) {
    if (!media.matches("video, audio")) return null;
    const before = { muted: media.muted, volume: media.volume };
    let changed = false;
    let lastLevel = media.volume || 1; // what unmuting goes back to

    const wrap = document.createElement("div");
    wrap.className = "te-volume";
    const button = document.createElement("button");
    button.type = "button";
    const icon = createIcon(VOLUME_ICONS.high);
    button.appendChild(icon);
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.01";
    slider.setAttribute("aria-label", "Volume");
    wrap.append(button, slider);

    const level = () => (media.muted ? 0 : media.volume);
    // Shows the preview's sound as it is, whoever changed it.
    const show = () => {
      const v = level();
      if (v > 0) lastLevel = v;
      slider.value = String(v);
      slider.style.setProperty("--te-level", `${Math.round(v * 100)}%`);
      icon.firstChild.setAttribute("d", v === 0 ? VOLUME_ICONS.muted : v < 0.5 ? VOLUME_ICONS.low : VOLUME_ICONS.high);
      button.setAttribute("aria-label", v === 0 ? "Unmute" : "Mute");
    };
    const setLevel = (v) => {
      changed = true;
      v = Math.min(1, Math.max(0, v));
      if (v > 0) media.volume = v;
      media.muted = v === 0;
      // Using the control counts as moving the mouse: keep the controls up.
      if (preview) {
        setIdle(preview, false);
        restartIdleTimer(preview);
      }
    };

    button.addEventListener("click", () => setLevel(level() === 0 ? lastLevel : 0));
    slider.addEventListener("input", () => setLevel(Number(slider.value)));
    wrap.addEventListener("wheel", (e) => setLevel(level() + (e.deltaY < 0 ? 0.05 : -0.05)));
    media.addEventListener("volumechange", show);
    restore.push(() => {
      media.removeEventListener("volumechange", show);
      if (!changed) return;
      media.volume = before.volume;
      media.muted = before.muted;
    });
    show();
    return wrap;
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      // Let Esc leave browser fullscreen first; a second Esc closes the preview.
      if (document.fullscreenElement) return;
      e.preventDefault();
      e.stopPropagation();
      closePreview();
    } else if (SCROLL_KEYS.has(e.key) && !e.target.closest?.("input, textarea, select, [contenteditable]")) {
      // Keep the page still underneath (see enlargePreview).
      e.preventDefault();
    }
  }

  // Message along the bottom of the page that fades out. While a preview is enlarged it goes in
  // the preview's top-layer controls, or the preview would cover it.
  function toast(text) {
    document.querySelector(".te-toast")?.remove();
    const el = document.createElement("div");
    el.className = "te-toast";
    el.textContent = text;
    (preview?.ui || document.documentElement).appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  // ---------- Debug tools ----------

  // Debug mode: while you hover a thumbnail, outline the preview it would enlarge (in red).
  function toggleDebugWatch() {
    clearInterval(debugWatch);
    debugWatch = null;
    setWatched(null);
    if (settings.debug && activeRules.length) debugWatch = setInterval(watchHoveredThumbnail, 400);
  }

  function watchHoveredThumbnail() {
    if (preview) return;
    const host = [...document.querySelectorAll(`[${HOST_ATTR}]:hover`)].pop();
    const rule = host && hostRules.get(host);
    const found = rule ? findPreview(host, rule) : null;
    const media = found?.media || null;
    if (media === watchedPreview) return;
    setWatched(media);
    if (media) log(`Preview detected for the hovered thumbnail, by ${found.how}:`, media);
  }

  function setWatched(media) {
    watchedPreview?.classList.remove("te-hl-preview");
    watchedPreview = media;
    media?.classList.add("te-hl-preview");
  }

  // Status panel in the top-left of the enlarged preview (debug mode only).
  function showPreviewDebug(rule, found, details) {
    const lines = [
      { ok: null, text: "Thumbnail:", code: details.thumbnail },
      { ok: true, text: "Preview:", code: details.media },
      { ok: null, text: `Found by ${found.how}.` }
    ];
    const s = details.suggestion;
    if (s && s.sel !== rule.preview) {
      lines.push({
        ok: null,
        text: rule.preview ? "Better preview selector:" : "To always use this element, save it as the preview selector:",
        code: s.sel,
        action: { label: "Save", run: () => saveAndTell("preview", s.sel) }
      });
    }
    createDebugPanel(preview.ui).set(lines);
  }

  // lines: [{ ok: true | false | null, text, code?, action?: { label, run } }]
  function createDebugPanel(container) {
    const panel = document.createElement("div");
    panel.className = "te-debug-panel";
    container.appendChild(panel);
    return {
      set(lines) {
        panel.textContent = "";
        const title = document.createElement("div");
        title.className = "te-debug-title";
        title.textContent = "Debug";
        panel.appendChild(title);
        for (const line of lines) {
          const row = document.createElement("div");
          row.className = "te-debug-line " + (line.ok === true ? "ok" : line.ok === false ? "bad" : "info");
          const text = document.createElement("span");
          text.textContent = line.text;
          row.appendChild(text);
          if (line.code) {
            const code = document.createElement("code");
            code.textContent = line.code;
            row.appendChild(code);
          }
          if (line.action) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = line.action.label;
            button.addEventListener("click", (e) => {
              e.stopPropagation();
              line.action.run();
              button.textContent = "Saved";
              button.disabled = true;
            });
            row.appendChild(button);
          }
          panel.appendChild(row);
        }
      }
    };
  }

  // Saves a selector into this site's rule (creating the rule if needed).
  async function saveSelector(field, value) {
    const data = await ext.storage.sync.get(["settings"]);
    const updated = mergeSettings(data.settings);
    const result = applyPickedSelector(updated, location.hostname, field, value);
    await ext.storage.sync.set({ settings: updated });
    log(`Saved ${field} selector for ${result.rule.name}:`, value);
    return result;
  }

  async function saveAndTell(field, value) {
    const { rule, created } = await saveSelector(field, value);
    const what = field === "preview" ? "Preview" : "Thumbnail";
    toast(`${what} selector for ${rule.name}: ${value}.${created ? " New site rule created." : ""}`);
  }

  function onMouseMove(e) {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (preview) revealControls();
  }

  // Debug mode shortcut: Alt+Shift+P (Option+Shift+P on Mac). Hover a thumbnail until its preview
  // plays, then press it: the video under the mouse is saved as this site's preview selector.
  // Matched by key position so it works on any keyboard layout.
  function onDebugShortcut(e) {
    if (!settings?.debug || e.code !== "KeyP" || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    grabPreviewUnderMouse();
  }

  async function grabPreviewUnderMouse() {
    // While a preview is enlarged, that's the one under the mouse.
    const media = preview?.media || (lastMouse && teVideoAt(lastMouse));
    log("Alt+Shift+P at", lastMouse, "found", media);
    if (!media) {
      toast("No video under the mouse. Hover a thumbnail until its preview plays, then press Alt+Shift+P.");
      return;
    }
    const s = teSuggestSelector(media, "preview");
    if (!s) {
      toast("Couldn't build a selector for that video.");
      return;
    }
    teHighlight([media], "preview");
    await saveAndTell("preview", s.sel);
  }

  // "Check this page" from the popup: test this site's rule against the page, outline what
  // matches, and report back.
  function checkPage() {
    const rule = settings.sites.find((s) => ruleMatchesHost(s, location.hostname)) || null;
    const result = {
      extensionEnabled: settings.enabled,
      debug: settings.debug,
      rule: rule && { name: rule.name, enabled: rule.enabled !== false }
    };
    if (!rule) return result;

    const t = { selector: rule.thumbnail, valid: true, count: 0, buttons: document.querySelectorAll(`.${BUTTON_CLASS}`).length };
    let thumbs = [];
    try {
      thumbs = rule.thumbnail ? [...document.querySelectorAll(rule.thumbnail)] : [];
    } catch {
      t.valid = false;
    }
    t.count = thumbs.length;
    result.thumbnails = t;
    teHighlight(thumbs, "thumb");

    const p = { selector: rule.preview, valid: true, count: 0 };
    if (rule.preview) {
      try {
        p.count = document.querySelectorAll(rule.preview).length;
      } catch {
        p.valid = false;
      }
    }
    // Previews showing right now (some sites play them without hovering).
    const playing = [...document.querySelectorAll(`[${HOST_ATTR}]`)]
      .slice(0, 300)
      .map((host) => findPreview(host, hostRules.get(host) || rule))
      .filter(Boolean)
      .map((f) => f.media);
    p.playingNow = new Set(playing).size;
    teHighlight(new Set(playing), "preview");
    result.preview = p;

    log("Check this page:", result);
    return result;
  }

  // "Pick thumbnail" from the popup.
  async function pickThumbnail() {
    const el = await tePickElement({ title: "Point at a video thumbnail." });
    if (!el) return;
    // Arrow keys can land on an image; the thumbnail must be able to hold the button.
    const target = teButtonHost(el);
    const s = teSuggestSelector(target, "thumbnail");
    if (!s) {
      toast("Couldn't build a selector for that element. Try its parent (↑) next time.");
      return;
    }
    const { rule, created } = await saveSelector("thumbnail", s.sel);
    teHighlight(document.querySelectorAll(s.sel), "thumb");
    toast(`Thumbnail selector for ${rule.name}: ${s.sel} (${s.count} on this page).${created ? " New site rule created." : ""}`);
  }
})();
