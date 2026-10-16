// Default settings shared by the content script, the popup and the settings page.
//
// The extension enlarges a thumbnail's hover preview (the video a site plays when you hover a
// thumbnail) to fill the window. Each site rule says where the thumbnails are:
//   name      - label shown in the settings page
//   enabled   - turn the rule on/off without deleting it
//   hosts     - comma-separated domains the rule applies to (subdomains included)
//   thumbnail - CSS selector for the thumbnail element; the expand button is added inside it
//   preview   - optional CSS selector for the preview video. Empty: use whichever video (or player
//               iframe) is playing over the thumbnail when you click expand.

const SETTINGS_VERSION = 4;

// Dailymotion wraps each thumbnail in a fixed-ratio box whose direct child is the video link.
// The class names carry a build hash, so match on the stable prefix.
const DAILYMOTION_THUMBNAIL_SELECTOR = "[class*='FixedRatioDiv__fixedRatioDiv']:has(> a[href*='/video/'])";

const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  enabled: true,
  // Logs to the console, outlines thumbnails and detected previews, shows a status panel when
  // expanding, and turns on the Alt+Shift+P shortcut.
  debug: false,
  sites: [
    {
      name: "YouTube",
      enabled: true,
      hosts: "youtube.com",
      // ytd-video-preview is the floating hover preview YouTube places over some thumbnails
      // (search results, sidebar). It covers the thumbnail, so it gets its own button.
      thumbnail: "ytd-thumbnail, yt-thumbnail-view-model, ytd-video-preview",
      preview: ""
    },
    {
      name: "Dailymotion",
      enabled: true,
      hosts: "dailymotion.com",
      thumbnail: DAILYMOTION_THUMBNAIL_SELECTOR,
      preview: ""
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

// Brings saved settings up to date and fills in missing keys.
function mergeSettings(saved) {
  if (!saved || !Array.isArray(saved.sites)) return structuredClone(DEFAULT_SETTINGS);

  const version = saved.version ?? 1;
  const sites = saved.sites.map((site) => {
    let thumbnail = site.thumbnail || "";
    // The original Dailymotion selector matched title links too and broke the thumbnail layout.
    if (version < 3 && /dailymotion\.com/i.test(site.hosts || "") && thumbnail === "a[href*='/video/']") {
      thumbnail = DAILYMOTION_THUMBNAIL_SELECTOR;
    }
    // Before version 4 there were page and embed modes with their own settings; only the
    // thumbnail selector carries over.
    return {
      name: site.name || "",
      enabled: site.enabled !== false,
      hosts: site.hosts || "",
      thumbnail,
      preview: site.preview || ""
    };
  });

  return {
    version: SETTINGS_VERSION,
    enabled: saved.enabled ?? DEFAULT_SETTINGS.enabled,
    debug: saved.debug ?? DEFAULT_SETTINGS.debug,
    sites
  };
}

// "www.vimeo.com" -> "Vimeo"
function siteNameFromHost(hostname) {
  const label = hostname.replace(/^www\./, "").split(".")[0] || hostname;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// A blank rule for a site, to be filled in from the settings page or the debug tools.
function newSiteRule(hostname = "") {
  const domain = hostname.replace(/^www\./, "");
  return {
    name: domain ? siteNameFromHost(domain) : "New site",
    enabled: true,
    hosts: domain,
    thumbnail: "",
    preview: ""
  };
}

// Sets one selector ("thumbnail" or "preview") on the rule for this hostname, creating the rule if
// there isn't one. Mutates settings; returns { rule, created } so callers can describe it.
function applyPickedSelector(settings, hostname, field, value) {
  let rule = settings.sites.find((s) => ruleMatchesHost(s, hostname));
  const created = !rule;
  if (created) {
    rule = newSiteRule(hostname);
    settings.sites.push(rule);
  }
  rule[field] = value;
  return { rule, created };
}
