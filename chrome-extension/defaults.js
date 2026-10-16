// Default settings shared by the content script and the options page.
//
// Each site rule describes how to find thumbnails on one website and how to play them:
//   name           - label shown in the options page
//   enabled        - turn the rule on/off without deleting it
//   hosts          - comma-separated domains the rule applies to (subdomains included)
//   thumbnail      - CSS selector for the thumbnail element; the expand button is added inside it
//   link           - CSS selector for the element whose href points to the video. It is looked up
//                    inside the thumbnail first, then among its ancestors. Leave empty for "a[href]".
//   mode           - "page":  load the video's own page in a full-window frame and enlarge its player.
//                             Works when embedding is blocked (YouTube refuses embeds on youtube.com).
//                             Only works for links on the same site.
//                    "embed": load the site's embeddable player using idPattern + embedUrl.
//   playerSelector - (page mode) CSS selector for the player element on the video page
//   idPattern      - (embed mode) regex applied to the video URL; capture group 1 must be the video ID
//   embedUrl       - (embed mode) embed URL template; {id} is replaced with the captured ID

const SETTINGS_VERSION = 3;

const YOUTUBE_PLAYER_SELECTOR = "#movie_player, #shorts-player";

// Dailymotion wraps each thumbnail in a fixed-ratio box whose direct child is the video link.
// The class names carry a build hash, so match on the stable prefix.
const DAILYMOTION_THUMBNAIL_SELECTOR = "[class*='FixedRatioDiv__fixedRatioDiv']:has(> a[href*='/video/'])";

const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  enabled: true,
  autoplay: true,
  // Logs to the console, outlines recognized thumbnails, and shows a status panel when expanding.
  debug: false,
  sites: [
    {
      name: "YouTube",
      enabled: true,
      hosts: "youtube.com",
      // ytd-video-preview is the floating hover preview YouTube places over some thumbnails
      // (search results, sidebar). It covers the thumbnail, so it gets its own button.
      thumbnail: "ytd-thumbnail, yt-thumbnail-view-model, ytd-video-preview",
      link: "a[href]",
      mode: "page",
      playerSelector: YOUTUBE_PLAYER_SELECTOR,
      idPattern: "(?:[?&]v=|/shorts/|/embed/)([\\w-]{11})",
      embedUrl: "https://www.youtube.com/embed/{id}"
    },
    {
      name: "Dailymotion",
      enabled: true,
      hosts: "dailymotion.com",
      thumbnail: DAILYMOTION_THUMBNAIL_SELECTOR,
      link: "a[href*='/video/']",
      mode: "embed",
      playerSelector: "",
      idPattern: "/video/([A-Za-z0-9]+)",
      embedUrl: "https://www.dailymotion.com/embed/video/{id}"
    }
  ]
};

// True if the rule's comma-separated domain list covers this hostname (subdomains included).
function ruleMatchesHost(rule, hostname) {
  const host = hostname.toLowerCase();
  return (rule.hosts || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .some((domain) => host === domain || host.endsWith("." + domain));
}

// Fill in missing keys so older or partially saved settings still work.
function mergeSettings(saved) {
  if (!saved || !Array.isArray(saved.sites)) return structuredClone(DEFAULT_SETTINGS);

  const version = saved.version ?? 1;
  const sites = saved.sites.map((site) => {
    const merged = { mode: "embed", playerSelector: "", link: "", ...site };
    // Settings saved before version 2 used embed mode for YouTube, which YouTube blocks.
    if (version < 2 && /(^|,)\s*(www\.)?youtube\.com\s*(,|$)/i.test(site.hosts || "")) {
      merged.mode = "page";
      merged.playerSelector = YOUTUBE_PLAYER_SELECTOR;
    }
    // The original Dailymotion selector matched title links too and broke the thumbnail layout.
    if (version < 3 && /dailymotion\.com/i.test(site.hosts || "") && site.thumbnail === "a[href*='/video/']") {
      merged.thumbnail = DAILYMOTION_THUMBNAIL_SELECTOR;
      merged.link = "a[href*='/video/']";
    }
    return merged;
  });

  return {
    version: SETTINGS_VERSION,
    enabled: saved.enabled ?? DEFAULT_SETTINGS.enabled,
    autoplay: saved.autoplay ?? DEFAULT_SETTINGS.autoplay,
    debug: saved.debug ?? DEFAULT_SETTINGS.debug,
    sites
  };
}

// "www.vimeo.com" -> "Vimeo"
function siteNameFromHost(hostname) {
  const label = hostname.replace(/^www\./, "").split(".")[0] || hostname;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// A blank page-mode rule for a site, to be filled in from the settings page or the picker.
function newSiteRule(hostname = "") {
  const domain = hostname.replace(/^www\./, "");
  return {
    name: domain ? siteNameFromHost(domain) : "New site",
    enabled: true,
    hosts: domain,
    thumbnail: "",
    link: "",
    mode: "page",
    playerSelector: "",
    idPattern: "",
    embedUrl: ""
  };
}

// Sets one selector on the rule for this hostname, creating the rule if there isn't one.
// Picking a player only makes sense in page mode, so that also switches the rule to page mode.
// Mutates settings; returns what changed so callers can describe it.
function applyPickedSelector(settings, hostname, field, value) {
  let rule = settings.sites.find((s) => ruleMatchesHost(s, hostname));
  const created = !rule;
  if (created) {
    rule = newSiteRule(hostname);
    settings.sites.push(rule);
  }
  rule[field] = value;
  const switchedToPage = field === "playerSelector" && rule.mode !== "page";
  if (switchedToPage) rule.mode = "page";
  return { rule, created, switchedToPage };
}
