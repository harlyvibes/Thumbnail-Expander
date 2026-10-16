// Settings page: general toggles and per-site rules.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const sitesEl = $("#sites");
  const statusEl = $("#status");
  const template = $("#site-template");

  const TEXT_FIELDS = ["name", "hosts", "thumbnail", "link", "playerSelector", "idPattern", "embedUrl"];
  const MODE_HINTS = {
    page: "Loads the video's own page full-window and hides everything but the player. Use this when the site blocks embedding. Only works for links on the same site.",
    embed: "Loads the site's embeddable player, built from the video ID in the link."
  };

  let cardCount = 0;
  let dirty = false;

  init();

  async function init() {
    $("#version").textContent = "v" + chrome.runtime.getManifest().version;
    const data = await chrome.storage.sync.get(["settings"]);
    render(mergeSettings(data.settings));

    // The popup's "Add this site" button opens this page with ?add=<hostname>.
    const addHost = new URLSearchParams(location.search).get("add");
    if (addHost) addNewSite(addHost);
    setStatus(addHost ? "dirty" : "");

    document.addEventListener("input", onEdit);
    document.addEventListener("change", onEdit);
    window.addEventListener("beforeunload", (e) => {
      if (dirty) e.preventDefault();
    });
  }

  function onEdit(e) {
    if (!e.target.closest("main")) return;
    e.target.classList?.remove("invalid");
    setStatus("dirty");
  }

  // ---------- Rendering ----------

  function render(settings) {
    $("#enabled").checked = settings.enabled;
    $("#autoplay").checked = settings.autoplay;
    sitesEl.textContent = "";
    settings.sites.forEach((site) => addSiteCard(site));
  }

  function addSiteCard(site, { open = false } = {}) {
    const n = ++cardCount;
    const card = template.content.firstElementChild.cloneNode(true);

    for (const key of TEXT_FIELDS) {
      card.querySelector(`[data-key="${key}"]`).value = site[key] ?? "";
    }
    card.querySelector('[data-key="enabled"]').checked = site.enabled !== false;

    // Radio groups need unique names/ids per card.
    card.querySelectorAll("[data-mode]").forEach((radio) => {
      radio.name = `mode-${n}`;
      radio.id = `mode-${n}-${radio.value}`;
      radio.nextElementSibling.htmlFor = radio.id;
      radio.checked = radio.value === (site.mode || "embed");
    });

    card.open = open;
    card.querySelector("[data-remove]").addEventListener("click", () => {
      card.remove();
      setStatus("dirty");
    });
    card.addEventListener("input", () => updateHeader(card));
    card.addEventListener("change", () => updateHeader(card));

    updateHeader(card);
    sitesEl.appendChild(card);
    return card;
  }

  // Keeps the collapsed card's summary (avatar, name, domains, mode) in sync with its fields.
  function updateHeader(card) {
    const name = card.querySelector('[data-key="name"]').value.trim() || "Unnamed site";
    const hosts = card.querySelector('[data-key="hosts"]').value.trim();
    const mode = card.querySelector("[data-mode]:checked")?.value || "embed";
    const enabled = card.querySelector('[data-key="enabled"]').checked;

    const avatar = card.querySelector("[data-avatar]");
    avatar.textContent = name.charAt(0).toUpperCase();
    avatar.style.background = `linear-gradient(135deg, hsl(${hue(name)} 75% 58%), hsl(${hue(name) + 40} 75% 52%))`;

    card.querySelector("[data-name]").textContent = name;
    card.querySelector("[data-hosts]").textContent = hosts || "No domain yet";
    card.querySelector("[data-mode-badge]").textContent = mode === "page" ? "Page mode" : "Embed mode";
    card.querySelector("[data-mode-hint]").textContent = MODE_HINTS[mode];
    card.dataset.mode = mode;
    card.classList.toggle("disabled", !enabled);
  }

  function hue(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  function addNewSite(host = "") {
    const card = addSiteCard(
      {
        name: host ? prettyName(host) : "New site",
        enabled: true,
        hosts: host,
        thumbnail: "",
        link: "",
        mode: "page",
        playerSelector: "",
        idPattern: "",
        embedUrl: ""
      },
      { open: true }
    );
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.querySelector(host ? '[data-key="thumbnail"]' : '[data-key="name"]').focus({ preventScroll: true });
    setStatus("dirty");
  }

  // "www.vimeo.com" -> "Vimeo"
  function prettyName(host) {
    const label = host.replace(/^www\./, "").split(".")[0] || host;
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  // ---------- Reading and validating ----------

  function readSites() {
    return [...sitesEl.querySelectorAll(".site")].map((card) => {
      const site = {
        enabled: card.querySelector('[data-key="enabled"]').checked,
        mode: card.querySelector("[data-mode]:checked")?.value || "embed"
      };
      for (const key of TEXT_FIELDS) {
        site[key] = card.querySelector(`[data-key="${key}"]`).value.trim();
      }
      return site;
    });
  }

  // Returns { index, key, message } for the first problem, or null.
  function validate(sites) {
    const isSelector = (sel) => {
      try {
        document.querySelector(sel);
        return true;
      } catch {
        return false;
      }
    };

    for (const [index, site] of sites.entries()) {
      const label = site.name || "Unnamed site";
      const fail = (key, problem) => ({ index, key, message: `${label}: ${problem}` });

      if (!site.hosts) return fail("hosts", "add at least one domain.");
      if (!site.thumbnail) return fail("thumbnail", "the thumbnail selector is required.");
      if (!isSelector(site.thumbnail)) return fail("thumbnail", "the thumbnail selector isn't valid CSS.");
      if (site.link && !isSelector(site.link)) return fail("link", "the link selector isn't valid CSS.");

      if (site.mode === "page") {
        if (!site.playerSelector) return fail("playerSelector", "page mode needs a player selector.");
        if (!isSelector(site.playerSelector)) return fail("playerSelector", "the player selector isn't valid CSS.");
      } else {
        if (!site.idPattern) return fail("idPattern", "embed mode needs a video ID pattern.");
        try {
          new RegExp(site.idPattern);
        } catch {
          return fail("idPattern", "the video ID pattern isn't a valid regex.");
        }
        if (!site.embedUrl.includes("{id}")) return fail("embedUrl", "the embed URL must contain {id}.");
      }
    }
    return null;
  }

  function showInvalid({ index, key, message }) {
    const card = sitesEl.querySelectorAll(".site")[index];
    card.open = true;
    const input = card.querySelector(`[data-key="${key}"]`);
    input.classList.add("invalid");
    input.focus({ preventScroll: true });
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus("error", message);
  }

  // ---------- Status bar ----------

  // kind: "" | "dirty" | "ok" | "error". An error means the edits are still unsaved.
  function setStatus(kind, message) {
    dirty = kind === "dirty" || kind === "error";
    statusEl.className = "status " + kind;
    statusEl.textContent =
      message || { dirty: "Unsaved changes", ok: "All changes saved", error: "Something needs fixing" }[kind] || "";
  }

  // ---------- Actions ----------

  $("#save").addEventListener("click", async () => {
    const sites = readSites();
    const problem = validate(sites);
    if (problem) {
      showInvalid(problem);
      return;
    }
    const settings = {
      version: SETTINGS_VERSION,
      enabled: $("#enabled").checked,
      autoplay: $("#autoplay").checked,
      sites
    };
    await chrome.storage.sync.set({ settings });
    setStatus("ok", "Saved. Open video pages update automatically.");
  });

  $("#add-site").addEventListener("click", () => addNewSite());

  $("#reset").addEventListener("click", async () => {
    if (!confirm("Reset all settings and site rules to the defaults?")) return;
    const defaults = structuredClone(DEFAULT_SETTINGS);
    await chrome.storage.sync.set({ settings: defaults });
    render(defaults);
    setStatus("ok", "Reset to defaults.");
  });
})();
