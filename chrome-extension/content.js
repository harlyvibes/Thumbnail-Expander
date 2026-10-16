// Injects an expand button into video thumbnails and opens the video in a full-window overlay.
(() => {
  const BUTTON_CLASS = "te-expand-btn";
  const ATTACHED_ATTR = "data-te-attached";
  const FRAME_STYLE_ID = "te-frame-style";
  const FRAME_TIMEOUT_MS = 15000;

  let settings = null;
  let activeRules = [];
  let overlay = null;
  let framePoll = null;
  let scanQueued = false;

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
        pickSelector(msg.field);
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      // Remove existing buttons so they are rebuilt with the new rules.
      document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((b) => b.remove());
      document.querySelectorAll(`[${ATTACHED_ATTR}]`).forEach((el) => el.removeAttribute(ATTACHED_ATTR));
      loadSettings().then((s) => {
        settings = s;
        applySettings();
      });
    });
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(["settings"], (data) => {
        resolve(mergeSettings(data.settings));
      });
    });
  }

  function applySettings() {
    activeRules = [];
    if (settings.enabled) {
      activeRules = settings.sites.filter((s) => s.enabled && s.thumbnail && ruleMatchesHost(s, location.hostname));
    }
    // Debug mode outlines every recognized thumbnail (see content.css).
    document.documentElement.classList.toggle("te-debug", Boolean(settings.debug));
    log(activeRules.length ? `Active rules: ${activeRules.map((r) => r.name).join(", ")}` : "No rule for this site.");
    scan();
    observeDom();
  }

  function scan() {
    for (const rule of activeRules) {
      let thumbs = [];
      try {
        thumbs = document.querySelectorAll(rule.thumbnail);
      } catch (err) {
        console.warn("[Thumbnail Expander] Bad selector for", rule.name, err);
        continue;
      }
      let added = 0;
      thumbs.forEach((thumb) => {
        if (attach(thumb, rule)) added++;
      });
      if (added) log(`${rule.name}: added ${added} button(s); thumbnail selector matches ${thumbs.length} on the page.`);
    }
  }

  // Pages like YouTube load thumbnails dynamically, so rescan whenever the DOM changes.
  let observer = null;
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
    btn.title = "Expand video";
    btn.setAttribute("aria-label", "Expand video");
    btn.appendChild(createIcon(EXPAND_ICON));

    btn.addEventListener("click", (e) => {
      // Stop the thumbnail's link from navigating to the watch page.
      e.preventDefault();
      e.stopPropagation();
      if (rule.mode === "preview") {
        log(`Expand clicked (${rule.name}, preview mode). Thumbnail:`, host);
        expandPreview(host);
        return;
      }
      const url = getVideoUrl(thumb, rule);
      log(`Expand clicked (${rule.name}, ${rule.mode} mode). Video link:`, url || "(none found)", "Thumbnail:", thumb);
      openOverlay(url, rule);
    });

    host.appendChild(btn);
    return true;
  }

  function getVideoUrl(thumb, rule) {
    let anchor = null;
    try {
      if (thumb.matches("a[href]")) {
        anchor = thumb;
      } else {
        // The link may be inside the thumbnail, or the thumbnail may be inside the link.
        anchor = thumb.querySelector(rule.link || "a[href]");
        if (!anchor) anchor = thumb.closest(rule.link || "a[href]");
      }
    } catch (err) {
      console.warn("[Thumbnail Expander] Bad link selector for", rule.name, err);
    }
    return anchor ? anchor.href : "";
  }

  function buildEmbedUrl(videoUrl, rule) {
    let match = null;
    try {
      match = new RegExp(rule.idPattern).exec(videoUrl);
    } catch (err) {
      console.warn("[Thumbnail Expander] Bad idPattern for", rule.name, err);
      return null;
    }
    if (!match || !match[1]) return null;

    const url = new URL(rule.embedUrl.replace("{id}", encodeURIComponent(match[1])));
    if (settings.autoplay) url.searchParams.set("autoplay", "1");
    return url.toString();
  }

  function openOverlay(videoUrl, rule) {
    closeOverlay();

    overlay = document.createElement("div");
    overlay.id = "te-overlay";
    overlay.append(...createCloseControls());

    const error = rule.mode === "page" ? addPageFrame(videoUrl, rule) : addEmbedFrame(videoUrl, rule);
    if (error) showMessage(error);

    // Stop the thumbnail's hover preview so it does not play behind the overlay.
    document.querySelectorAll("video").forEach((v) => v.pause());

    document.documentElement.appendChild(overlay);
    document.documentElement.classList.add("te-locked");
    document.addEventListener("keydown", onKeyDown, true);
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
      closeOverlay();
    });

    const hint = document.createElement("div");
    hint.className = "te-hint";
    const key = document.createElement("kbd");
    key.textContent = "Esc";
    hint.append("Press ", key, " to close");
    return [closeBtn, hint];
  }

  function showMessage(text) {
    const msg = document.createElement("div");
    msg.className = "te-message";
    msg.textContent = text;
    overlay.appendChild(msg);
    return msg;
  }

  // Spinner shown under the frame until the video is ready.
  function showLoading() {
    const wrap = document.createElement("div");
    wrap.className = "te-spinner-wrap";
    const spinner = document.createElement("div");
    spinner.className = "te-spinner";
    wrap.append(spinner, "Loading video…");
    overlay.appendChild(wrap);
    return wrap;
  }

  function createFrame(src) {
    const iframe = document.createElement("iframe");
    iframe.className = "te-frame";
    iframe.src = src;
    iframe.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    return iframe;
  }

  // Embed mode: load the site's embeddable player. Returns an error message, or null.
  function addEmbedFrame(videoUrl, rule) {
    const embedUrl = videoUrl ? buildEmbedUrl(videoUrl, rule) : null;
    if (settings.debug) {
      createDebugPanel().set([
        { ok: Boolean(videoUrl), text: "Video link:", code: videoUrl || "(none found)" },
        { ok: Boolean(embedUrl), text: embedUrl ? "Embed URL:" : "No video ID matched the ID pattern:", code: embedUrl || rule.idPattern }
      ]);
      log("Embed URL:", embedUrl || "(none: the ID pattern didn't match the link)");
    }
    if (!embedUrl) {
      return `Could not find a video ID in this link (${videoUrl || "no link"}). Check the site rule's ID pattern in the options page.`;
    }
    const loading = showLoading();
    const iframe = createFrame(embedUrl);
    iframe.addEventListener("load", () => loading.remove(), { once: true });
    overlay.appendChild(iframe);
    return null;
  }

  // Page mode: load the video's own page in a frame, then hide everything except its player.
  // This only works for same-site links, because the frame's page must be styleable from here.
  function addPageFrame(videoUrl, rule) {
    if (!videoUrl) return "Could not find a link to the video in this thumbnail. Check the site rule's link selector in the options page.";

    let url;
    try {
      url = new URL(videoUrl);
    } catch {
      return `This thumbnail's link is not a valid URL (${videoUrl}).`;
    }
    if (url.origin !== location.origin) {
      return "This thumbnail links to another site (usually an ad), so it can't be expanded here.";
    }

    const loading = showLoading();
    const iframe = createFrame(url.toString());
    iframe.classList.add("te-loading");
    overlay.appendChild(iframe);

    // Everything outside the player is made invisible rather than covered: some page elements
    // (like YouTube's loading skeleton) sit in a higher stacking layer than the player, so no
    // z-index can put the player above them. Visibility keeps the page's layout and scripts intact.
    const playerSel = `:is(${rule.playerSelector})`;
    const playerCss = `
      html, body { overflow: hidden !important; background: #000 !important; }
      body *:not(${playerSel}):not(${playerSel} *) { visibility: hidden !important; }
      ${playerSel} {
        visibility: visible !important;
        position: fixed !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        z-index: 2147483646 !important;
      }`;

    const started = Date.now();
    let pausedOnce = false;
    let ticks = 0;
    const panel = settings.debug ? createDebugPanel() : null;

    const reveal = () => {
      iframe.classList.remove("te-loading");
      loading.remove();
    };

    // Debug mode: report what the player selector matches inside the video page.
    const report = (doc, phase) => {
      if (!panel) return;
      const lines = [{ ok: null, text: "Video page:", code: url.pathname + url.search }];
      if (!doc || doc.location.href === "about:blank") {
        lines.push({ ok: null, text: "Loading the video page…" });
        panel.set(lines);
        return;
      }
      let matches = [];
      try {
        matches = [...doc.querySelectorAll(rule.playerSelector)];
        lines.push({ ok: matches.length > 0, text: `Player selector matches ${matches.length}:`, code: rule.playerSelector });
      } catch {
        lines.push({ ok: false, text: "Player selector isn't valid CSS:", code: rule.playerSelector });
      }
      if (matches.length) {
        const inside = matches.some((m) => m.matches(TE_MEDIA) || m.querySelector(TE_MEDIA));
        lines.push({
          ok: inside,
          text: inside ? "The video is inside the matched player." : "The video isn't inside the matched element, so it's hidden (audio only)."
        });
      }
      const media = teFindMainMedia(doc);
      lines.push(media ? { ok: null, text: "Video on the page:", code: teDescribe(media) } : { ok: false, text: "No video on the page yet." });
      if (media) {
        const suggestion = teSuggestSelector(tePlayerElementFor(media), "player");
        if (suggestion && suggestion.sel !== rule.playerSelector) {
          lines.push({
            ok: null,
            text: "Suggested player selector:",
            code: suggestion.sel,
            action: { label: "Use", run: () => useSuggestion("playerSelector", suggestion.sel) }
          });
        }
      }
      if (phase === "timeout") lines.push({ ok: false, text: `Stopped waiting for the player after ${FRAME_TIMEOUT_MS / 1000} s.` });
      panel.set(lines);
    };

    framePoll = setInterval(() => {
      if (Date.now() - started > FRAME_TIMEOUT_MS) {
        stopFramePoll();
        reveal();
        let doc = null;
        try {
          doc = iframe.contentDocument;
        } catch {}
        report(doc, "timeout");
        log(`Page mode: player selector "${rule.playerSelector}" never matched on the video page.`);
        return;
      }

      let doc = null;
      try {
        doc = iframe.contentDocument;
      } catch {
        // The page redirected to another site; it can't be styled, so just show it.
        log("Page mode: the video page redirected to another site, so it can't be styled.");
        stopFramePoll();
        reveal();
        return;
      }
      // The panel is rebuilt every half second, not every tick: suggestions query the page.
      if (ticks++ % 5 === 0) report(doc);
      // The frame starts on about:blank before the real page loads.
      if (!doc || doc.location.href === "about:blank" || !doc.head) return;

      if (!doc.getElementById(FRAME_STYLE_ID)) {
        const style = doc.createElement("style");
        style.id = FRAME_STYLE_ID;
        style.textContent = playerCss;
        doc.head.appendChild(style);
        // Esc pressed while the player has focus goes to the frame, not this page.
        doc.addEventListener("keydown", onKeyDown, true);
      }

      const player = doc.querySelector(rule.playerSelector);
      if (!player) return;

      const video = player.querySelector("video");
      if (!settings.autoplay && video && !pausedOnce) {
        pausedOnce = true;
        if (!video.paused) video.pause();
        else video.addEventListener("playing", () => video.pause(), { once: true });
      }

      stopFramePoll();
      reveal();
      report(doc, "found");
      log("Page mode: player found:", player, player.querySelector(TE_MEDIA) ? "(video inside)" : "(no video inside: it will be hidden)");
      // Let the player re-measure itself now that it fills the window.
      iframe.contentWindow.dispatchEvent(new Event("resize"));
    }, 100);

    return null;
  }

  // ---------- Debug tools ----------

  // Small status panel in the top-left of the expanded view (debug mode only).
  function createDebugPanel() {
    const panel = document.createElement("div");
    panel.className = "te-debug-panel";
    overlay.appendChild(panel);
    let last = "";
    return {
      el: panel,
      // lines: [{ ok: true | false | null, text, code?, action?: { label, run } }]
      set(lines) {
        // Only rebuild when something changed, so a click on a button isn't lost mid-rebuild.
        const key = JSON.stringify(lines.map(({ ok, text, code }) => [ok, text, code]));
        if (key === last) return;
        last = key;
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
            button.addEventListener("click", line.action.run);
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
    log(`Saved ${field} for ${result.rule.name}:`, value);
    return result;
  }

  async function useSuggestion(field, value) {
    await saveSelector(field, value);
    toast(`Saved. Close this and expand the video again to use ${value}.`);
  }

  // Message along the bottom of the page (or the expanded view) that fades out.
  function toast(text) {
    document.querySelector(".te-toast")?.remove();
    const el = document.createElement("div");
    el.className = "te-toast";
    el.textContent = text;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  // "Check this page" from the popup: test this site's rule against the current page,
  // highlight what matches, and report back.
  function checkPage() {
    const rule = settings.sites.find((s) => ruleMatchesHost(s, location.hostname)) || null;
    const result = {
      extensionEnabled: settings.enabled,
      rule: rule && { name: rule.name, enabled: rule.enabled !== false, mode: rule.mode }
    };

    if (rule) {
      const t = { selector: rule.thumbnail, valid: true, count: 0, withLink: 0, offSite: 0 };
      let thumbs = [];
      try {
        thumbs = rule.thumbnail ? [...document.querySelectorAll(rule.thumbnail)] : [];
      } catch {
        t.valid = false;
      }
      const urls = thumbs.map((th) => getVideoUrl(th, rule)).filter(Boolean);
      t.count = thumbs.length;
      t.withLink = urls.length;
      t.offSite = urls.filter((u) => {
        try {
          return new URL(u).origin !== location.origin;
        } catch {
          return true;
        }
      }).length;
      t.sample = urls.find((u) => u.startsWith(location.origin)) || urls[0] || null;
      if (t.sample && rule.mode === "embed") t.embedUrl = buildEmbedUrl(t.sample, rule);
      result.thumbnails = t;
      teHighlight(thumbs, "thumb");
    }

    // On a video page: does the player selector find the player around the video?
    const media = teFindMainMedia();
    const p = { hasVideo: Boolean(media), video: media ? teDescribe(media) : null };
    if (media) p.suggestion = teSuggestSelector(tePlayerElementFor(media), "player")?.sel || null;
    if (rule?.mode === "page" && rule.playerSelector) {
      p.selector = rule.playerSelector;
      let matches = [];
      try {
        matches = [...document.querySelectorAll(rule.playerSelector)];
        p.valid = true;
      } catch {
        p.valid = false;
      }
      p.count = matches.length;
      p.containsVideo = Boolean(media) && matches.some((m) => m === media || m.contains(media));
      teHighlight(matches, "player");
    }
    result.player = p;

    log("Check this page:", result);
    return result;
  }

  // "Pick thumbnail" / "Pick player" from the popup.
  async function pickSelector(field) {
    const kind = field === "playerSelector" ? "player" : "thumbnail";
    const el = await tePickElement({
      kind,
      title: kind === "player" ? "Point at the video player." : "Point at a video thumbnail."
    });
    if (!el) return;

    // Arrow keys can land on an image; the thumbnail must be able to hold the button.
    await saveElementSelector(field, kind === "thumbnail" ? teButtonHost(el) : el);
  }

  // Builds a selector for the element, saves it into this site's rule, outlines what it
  // matches, and says what was saved.
  async function saveElementSelector(field, el) {
    const kind = field === "playerSelector" ? "player" : "thumbnail";
    const suggestion = teSuggestSelector(el, kind);
    if (!suggestion) {
      toast("Couldn't build a selector for that element. Try Pick in the toolbar popup and choose its parent (↑).");
      return;
    }
    const { rule, created, switchedToPage } = await saveSelector(field, suggestion.sel);
    teHighlight(document.querySelectorAll(suggestion.sel), kind);

    let text =
      kind === "player"
        ? `Player selector for ${rule.name}: ${suggestion.sel}.`
        : `Thumbnail selector for ${rule.name}: ${suggestion.sel} (${suggestion.count} on this page).`;
    if (created) text += " New site rule created.";
    if (switchedToPage) text += " Switched to page mode.";
    if (kind === "thumbnail" && rule.mode === "page" && !rule.playerSelector) {
      text += " Next: open a video and use Pick player.";
    }
    toast(text);
  }

  // Last mouse position, for the debug shortcut (null until the mouse moves).
  let lastMouse = null;
  function onMouseMove(e) {
    lastMouse = { x: e.clientX, y: e.clientY };
  }

  // Debug mode shortcut: Alt+Shift+P (Option+Shift+P on Mac) saves the player under the mouse as
  // this site's player selector. Matched by key position so it works on any keyboard layout.
  function onDebugShortcut(e) {
    if (!settings?.debug || e.code !== "KeyP" || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    grabPlayerUnderMouse();
  }

  async function grabPlayerUnderMouse() {
    if (overlay || preview) {
      toast("Close the expanded video first, then use Alt+Shift+P on the video's own page.");
      return;
    }
    // The innermost hovered element. A player in a cross-site iframe still shows up here, as the
    // iframe itself (its own mouse moves don't reach this page, so lastMouse is from its edge).
    const hovered = [...document.querySelectorAll(":hover")].pop();
    const media = hovered && teMediaNear(hovered, lastMouse);
    log("Alt+Shift+P: hovered", hovered, "video", media);
    if (!media) {
      toast("No video under the mouse. Hover over the player and press Alt+Shift+P again.");
      return;
    }
    await saveElementSelector("playerSelector", tePlayerElementFor(media));
  }

  function stopFramePoll() {
    clearInterval(framePoll);
    framePoll = null;
  }

  // ---------- Preview mode ----------
  // Enlarges the video the site is already playing in the thumbnail (its hover preview) to fill
  // the window. Nothing new is loaded: it's the same preview, on the same page, with no click
  // through to the video's page. The video stays where it is in the page (only its styles
  // change), so the site still sees the mouse over its thumbnail and keeps the preview playing.

  let preview = null; // { restore: [functions], ui, timer }

  async function expandPreview(host) {
    closeOverlay();
    let media = findPreviewMedia(host);
    if (!media) {
      // Clicked before the preview started: give it a few seconds.
      toast("Waiting for the preview to start…");
      const started = Date.now();
      while (!media && Date.now() - started < 5000) {
        await new Promise((r) => setTimeout(r, 150));
        media = findPreviewMedia(host);
      }
      document.querySelector(".te-toast")?.remove();
    }
    if (!media) {
      log("Preview mode: no video playing over", host);
      toast("No preview is playing in this thumbnail. Hover it until the video starts, then click expand.");
      return;
    }
    log("Preview mode: enlarging", media);
    enlargePreview(media);
  }

  // The video (or player iframe) playing in or over the thumbnail: whichever covers most of it.
  function findPreviewMedia(host) {
    const t = host.getBoundingClientRect();
    const thumbArea = t.width * t.height;
    if (!thumbArea) return null;
    let best = null;
    let bestCover = 0;
    for (const m of document.querySelectorAll("video, iframe")) {
      if (m.closest("#te-overlay")) continue;
      const r = m.getBoundingClientRect();
      const w = Math.min(r.right, t.right) - Math.max(r.left, t.left);
      const h = Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top);
      const cover = w > 0 && h > 0 ? (w * h) / thumbArea : 0;
      if (cover > bestCover) {
        best = m;
        bestCover = cover;
      }
    }
    return bestCover >= 0.4 ? best : null;
  }

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
      // Lift every stacking layer on the way up, so the site's header can't cover the video.
      if (cs.zIndex !== "auto" || cs.position === "fixed" || cs.position === "sticky") props["z-index"] = "2147483646";
      if (cs.opacity !== "1") props.opacity = "1";
      if (cs.isolation === "isolate") props.isolation = "auto";
      if (Object.keys(props).length) setStyles(a, props);

      // A link around the preview would open the video's page when the video is clicked.
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
      "pointer-events": "auto"
    });

    // The preview itself is left as the site plays it (sound, playback); only its size changes.
    // pointer-events stays on so the mouse is over the preview, which keeps the site's hover
    // (and the preview) alive. Clicks on it are kept away from the site, which might open the
    // video's page on them.
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

    // Close button and hint, placed next to the video so the mouse never leaves the thumbnail.
    const ui = document.createElement("div");
    ui.id = "te-preview-ui";
    ui.append(...createCloseControls());
    CLICKS.forEach((type) => ui.addEventListener(type, swallow));
    media.parentElement.appendChild(ui);

    // If the site removes the preview (it ended, say), put everything back.
    const timer = setInterval(() => {
      if (!media.isConnected) {
        closeOverlay();
        toast("The site stopped the preview.");
      }
    }, 500);

    preview = { restore, ui, timer };
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

  // Closes whichever expanded view is open.
  function closeOverlay() {
    closePreview();
    if (!overlay) return;
    stopFramePoll();
    overlay.remove();
    overlay = null;
    document.documentElement.classList.remove("te-locked");
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    // Let Esc leave browser fullscreen first; a second Esc closes the overlay.
    if (document.fullscreenElement || e.target.ownerDocument?.fullscreenElement) return;
    e.preventDefault();
    e.stopPropagation();
    closeOverlay();
  }
})();
