// Toolbar popup: quick switches for the extension and the current site. Changes save immediately;
// open video pages pick them up through chrome.storage.onChanged.
(async () => {
  const $ = (sel) => document.querySelector(sel);

  const data = await chrome.storage.sync.get(["settings"]);
  const settings = mergeSettings(data.settings);
  const save = () => chrome.storage.sync.set({ settings });

  // The active tab's hostname, if it's a normal web page (activeTab grants the URL here).
  let host = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || "");
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch {
    // No tab URL available; the "not a web page" state is shown.
  }

  const rule = host ? settings.sites.find((s) => ruleMatchesHost(s, host)) : null;

  $("#enabled").checked = settings.enabled;
  $("#autoplay").checked = settings.autoplay;
  document.body.classList.toggle("off", !settings.enabled);

  const site = $("#site");
  if (rule) {
    site.dataset.state = "rule";
    $("#rule-name").textContent = rule.name || host;
    $("#rule-host").textContent = host;
    $("#site-enabled").checked = rule.enabled !== false;
  } else if (host) {
    site.dataset.state = "norule";
    $("#host").textContent = host.replace(/^www\./, "");
  }

  $("#enabled").addEventListener("change", (e) => {
    settings.enabled = e.target.checked;
    document.body.classList.toggle("off", !settings.enabled);
    save();
  });

  $("#autoplay").addEventListener("change", (e) => {
    settings.autoplay = e.target.checked;
    save();
  });

  $("#site-enabled").addEventListener("change", (e) => {
    rule.enabled = e.target.checked;
    save();
  });

  $("#add-site").addEventListener("click", () => {
    const domain = host.replace(/^www\./, "");
    chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?add=${encodeURIComponent(domain)}`) });
    window.close();
  });

  $("#settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
})();
