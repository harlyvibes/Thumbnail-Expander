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

  async function init() {
    settings = await loadSettings();
    applySettings();

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
      thumbs.forEach((thumb) => attach(thumb, rule));
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

  function attach(thumb, rule) {
    if (thumb.hasAttribute(ATTACHED_ATTR)) return;
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
    if (!host || host === document.body || host === document.documentElement) return;
    if (host.querySelector(`:scope > .${BUTTON_CLASS}`)) return;

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
      openOverlay(getVideoUrl(thumb, rule), rule);
    });

    host.appendChild(btn);
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

    const reveal = () => {
      iframe.classList.remove("te-loading");
      loading.remove();
    };

    framePoll = setInterval(() => {
      if (Date.now() - started > FRAME_TIMEOUT_MS) {
        stopFramePoll();
        reveal();
        return;
      }

      let doc = null;
      try {
        doc = iframe.contentDocument;
      } catch {
        // The page redirected to another site; it can't be styled, so just show it.
        stopFramePoll();
        reveal();
        return;
      }
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
      // Let the player re-measure itself now that it fills the window.
      iframe.contentWindow.dispatchEvent(new Event("resize"));
    }, 100);

    return null;
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
