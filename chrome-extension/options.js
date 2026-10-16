// Settings page: general switches and per-site rules.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const sitesEl = $("#sites");
  const statusEl = $("#status");
  const template = $("#site-template");

  const TEXT_FIELDS = ["name", "hosts", "thumbnail", "preview"];

  let dirty = false;

  init();

  async function init() {
    $("#version").textContent = "v" + ext.runtime.getManifest().version;
    const data = await ext.storage.sync.get(["settings"]);
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
    $("#debug").checked = settings.debug;
    sitesEl.textContent = "";
    settings.sites.forEach((site) => addSiteCard(site));
  }

  function addSiteCard(site, { open = false } = {}) {
    const card = template.content.firstElementChild.cloneNode(true);

    for (const key of TEXT_FIELDS) {
      card.querySelector(`[data-key="${key}"]`).value = site[key] ?? "";
    }
    card.querySelector('[data-key="enabled"]').checked = site.enabled !== false;

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

  // Keeps the collapsed card's summary (avatar, name, domains, preview) in sync with its fields.
  function updateHeader(card) {
    const name = card.querySelector('[data-key="name"]').value.trim() || "Unnamed site";
    const hosts = card.querySelector('[data-key="hosts"]').value.trim();
    const previewSel = card.querySelector('[data-key="preview"]').value.trim();
    const enabled = card.querySelector('[data-key="enabled"]').checked;

    const avatar = card.querySelector("[data-avatar]");
    avatar.textContent = name.charAt(0).toUpperCase();
    avatar.style.background = `linear-gradient(135deg, hsl(${hue(name)} 75% 58%), hsl(${hue(name) + 40} 75% 52%))`;

    card.querySelector("[data-name]").textContent = name;
    card.querySelector("[data-hosts]").textContent = hosts || "No domain yet";
    card.querySelector("[data-preview-badge]").textContent = previewSel ? "Custom preview" : "Auto preview";
    card.classList.toggle("disabled", !enabled);
  }

  function hue(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  function addNewSite(host = "") {
    const card = addSiteCard(newSiteRule(host), { open: true });
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.querySelector(host ? '[data-key="thumbnail"]' : '[data-key="name"]').focus({ preventScroll: true });
    setStatus("dirty");
  }

  // ---------- Reading and validating ----------

  function readSites() {
    return [...sitesEl.querySelectorAll(".site")].map((card) => {
      const site = { enabled: card.querySelector('[data-key="enabled"]').checked };
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
      if (site.preview && !isSelector(site.preview)) return fail("preview", "the preview selector isn't valid CSS.");
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
      debug: $("#debug").checked,
      sites
    };
    await ext.storage.sync.set({ settings });
    setStatus("ok", "Saved. Open pages update automatically.");
  });

  $("#add-site").addEventListener("click", () => addNewSite());

  $("#reset").addEventListener("click", async () => {
    if (!confirm("Reset all settings and site rules to the defaults?")) return;
    const defaults = structuredClone(DEFAULT_SETTINGS);
    await ext.storage.sync.set({ settings: defaults });
    render(defaults);
    setStatus("ok", "Reset to defaults.");
  });
})();
