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

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "te-close";
    closeBtn.title = "Close (Esc)";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.appendChild(createIcon(CLOSE_ICON));
    closeBtn.addEventListener("click", closeOverlay);
    overlay.appendChild(closeBtn);

    // Brief "Press Esc to close" hint that fades out on its own.
    const hint = document.createElement("div");
    hint.className = "te-hint";
    const key = document.createElement("kbd");
    key.textContent = "Esc";
    hint.append("Press ", key, " to close");
    overlay.appendChild(hint);

    const error = rule.mode === "page" ? addPageFrame(videoUrl, rule) : addEmbedFrame(videoUrl, rule);
    if (error) showMessage(error);

    // Stop the thumbnail's hover preview so it does not play behind the overlay.
    document.querySelectorAll("video").forEach((v) => v.pause());

    document.documentElement.appendChild(overlay);
    document.documentElement.classList.add("te-locked");
    document.addEventListener("keydown", onKeyDown, true);
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
      if (t.sample && rule.mode !== "page") t.embedUrl = buildEmbedUrl(t.sample, rule);
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
    const target = kind === "thumbnail" ? teButtonHost(el) : el;
    const suggestion = teSuggestSelector(target, kind);
    if (!suggestion) {
      toast("Couldn't build a selector for that element. Try its parent (↑) next time.");
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

  function stopFramePoll() {
    clearInterval(framePoll);
    framePoll = null;
  }

  function closeOverlay() {
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
