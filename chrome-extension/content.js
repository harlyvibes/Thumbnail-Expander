// Adds an expand button to video thumbnails. Clicking it enlarges the thumbnail's hover preview
// (the video the site plays while you hover a thumbnail) to fill the window. Nothing new is
// loaded, so it never opens the video's page.
(() => {
  const BUTTON_CLASS = "te-expand-btn";
  const ATTACHED_ATTR = "data-te-attached";
  // Marks the element holding a button, so the debug tools can find the hovered thumbnail.
  const HOST_ATTR = "data-te-host";
  const WAIT_FOR_PREVIEW_MS = 5000;

  let settings = null;
  let activeRules = [];
  const hostRules = new WeakMap(); // button host -> its site rule
  let preview = null; // the enlarged preview: { media, restore, ui, timer }
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
    document.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });

    // Requests from the toolbar popup's debug tools.
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === "te-check") {
        sendResponse(checkPage());
      } else if (msg?.type === "te-pick") {
        sendResponse({ ok: true });
        pickThumbnail();
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
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

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(["settings"], (data) => resolve(mergeSettings(data.settings)));
    });
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
    enlargePreview(found.media);
    if (details) showPreviewDebug(rule, found, details);
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

  // Enlarges the preview element itself to fill the window. It stays where it is in the page
  // (only its styles change), so the site still sees the mouse over its thumbnail and keeps the
  // preview playing. Everything is put back on close.
  function enlargePreview(media) {
    const restore = [];
    // The whole style attribute is saved and put back on close.
    const setStyles = (el, props) => {
      const before = el.getAttribute("style");
      restore.push(() => (before === null ? el.removeAttribute("style") : el.setAttribute("style", before)));
      for (const [prop, value] of Object.entries(props)) el.style.setProperty(prop, value, "important");
    };

    for (let a = media.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const props = {};
      // Anything that would make a fixed element size itself to this box instead of the window,
      // or clip it.
      if (cs.transform !== "none") props.transform = "none";
      if (cs.translate !== "none") props.translate = "none";
      if (cs.scale !== "none") props.scale = "none";
      if (cs.rotate !== "none") props.rotate = "none";
      if (cs.filter !== "none") props.filter = "none";
      if (cs.backdropFilter && cs.backdropFilter !== "none") props["backdrop-filter"] = "none";
      if (cs.perspective !== "none") props.perspective = "none";
      if (cs.contain !== "none") props.contain = "none";
      if (cs.containerType && cs.containerType !== "normal") props["container-type"] = "normal";
      if (cs.willChange !== "auto") props["will-change"] = "auto";
      if (cs.clipPath !== "none") props["clip-path"] = "none";
      if (cs.maskImage && cs.maskImage !== "none") props["mask-image"] = "none";
      if (cs.contentVisibility && cs.contentVisibility !== "visible") props["content-visibility"] = "visible";
      // Lift every stacking layer on the way up, so the site's header can't cover the preview.
      if (cs.zIndex !== "auto" || cs.position === "fixed" || cs.position === "sticky") props["z-index"] = "2147483646";
      if (cs.opacity !== "1") props.opacity = "1";
      if (cs.isolation === "isolate") props.isolation = "auto";
      if (Object.keys(props).length) {
        // Apply instantly: an animated transform would hold the preview inside the card meanwhile.
        props.transition = "none";
        setStyles(a, props);
      }

      // A link around the preview would open the video's page when the preview is clicked.
      if (a.matches("a[href]")) {
        const href = a.getAttribute("href");
        a.removeAttribute("href");
        restore.push(() => a.setAttribute("href", href));
      }
    }

    setStyles(media, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      "max-width": "none",
      "max-height": "none",
      "min-width": "0",
      "min-height": "0",
      margin: "0",
      display: "block",
      "z-index": "2147483646",
      "object-fit": "contain",
      background: "#000",
      transform: "none",
      "border-radius": "0",
      opacity: "1",
      visibility: "visible",
      // The mouse must be over the preview to keep the site's hover (and the preview) alive.
      "pointer-events": "auto"
    });

    // The preview plays exactly as the site plays it; only its size changes. Clicks on it are
    // kept away from the site, which might open the video's page on them.
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const noScroll = (e) => e.preventDefault();
    const CLICKS = ["click", "dblclick", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup"];
    CLICKS.forEach((type) => media.addEventListener(type, swallow));
    media.addEventListener("wheel", noScroll, { passive: false });
    restore.push(() => {
      CLICKS.forEach((type) => media.removeEventListener(type, swallow));
      media.removeEventListener("wheel", noScroll);
    });

    // Close button and hint, placed next to the preview so the mouse never leaves the thumbnail.
    const ui = document.createElement("div");
    ui.id = "te-preview-ui";
    ui.append(...createCloseControls());
    CLICKS.forEach((type) => ui.addEventListener(type, (e) => e.stopPropagation()));
    media.parentElement.appendChild(ui);

    // If the site removes the preview (it ended, say), put everything back.
    const timer = setInterval(() => {
      if (!media.isConnected) {
        closePreview();
        toast("The site stopped the preview.");
      }
    }, 500);

    setWatched(null);
    preview = { media, restore, ui, timer };
    document.addEventListener("keydown", onKeyDown, true);
  }

  function closePreview() {
    if (!preview) return;
    clearInterval(preview.timer);
    preview.ui.remove();
    preview.restore.reverse().forEach((undo) => undo());
    preview = null;
    document.removeEventListener("keydown", onKeyDown, true);
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

  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    // Let Esc leave browser fullscreen first; a second Esc closes the preview.
    if (document.fullscreenElement) return;
    e.preventDefault();
    e.stopPropagation();
    closePreview();
  }

  // Message along the bottom of the page that fades out.
  function toast(text) {
    document.querySelector(".te-toast")?.remove();
    const el = document.createElement("div");
    el.className = "te-toast";
    el.textContent = text;
    document.documentElement.appendChild(el);
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
    const data = await chrome.storage.sync.get(["settings"]);
    const updated = mergeSettings(data.settings);
    const result = applyPickedSelector(updated, location.hostname, field, value);
    await chrome.storage.sync.set({ settings: updated });
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
    const media = lastMouse && teVideoAt(lastMouse);
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
