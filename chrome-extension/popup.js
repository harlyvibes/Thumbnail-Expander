// Toolbar popup: quick switches for the extension and the current site, plus debug tools for
// setting up a site's rule. Changes save immediately; open pages pick them up through
// ext.storage.onChanged.
(async () => {
  const $ = (sel) => document.querySelector(sel);

  const data = await ext.storage.sync.get(["settings"]);
  const settings = mergeSettings(data.settings);
  const save = () => ext.storage.sync.set({ settings });

  // The active tab, and its hostname if it's a normal web page (activeTab grants the URL here).
  let tab = null;
  let host = "";
  try {
    [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || "");
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch {
    // No tab URL available; the "not a web page" state is shown.
  }

  const rule = host ? settings.sites.find((s) => ruleMatchesHost(s, host)) : null;

  $("#enabled").checked = settings.enabled;
  $("#debug-mode").checked = settings.debug;
  document.body.classList.toggle("off", !settings.enabled);
  document.body.classList.toggle("nopage", !host);

  const site = $("#site");
  if (rule) {
    site.dataset.state = "rule";
    $("#rule-name").textContent = rule.name || host;
    $("#rule-host").textContent = host;
    $("#site-enabled").checked = rule.enabled !== false;
    $("#preview-sel").textContent = rule.preview || "auto (the video playing over the thumbnail)";
  } else if (host) {
    site.dataset.state = "norule";
    $("#host").textContent = host.replace(/^www\./, "");
  }

  $("#enabled").addEventListener("change", (e) => {
    settings.enabled = e.target.checked;
    document.body.classList.toggle("off", !settings.enabled);
    save();
  });

  $("#debug-mode").addEventListener("change", (e) => {
    settings.debug = e.target.checked;
    save();
  });

  $("#site-enabled").addEventListener("change", (e) => {
    rule.enabled = e.target.checked;
    save();
  });

  $("#add-site").addEventListener("click", () => {
    const domain = host.replace(/^www\./, "");
    ext.tabs.create({ url: ext.runtime.getURL(`options.html?add=${encodeURIComponent(domain)}`) });
    window.close();
  });

  $("#settings").addEventListener("click", () => {
    ext.runtime.openOptionsPage();
    window.close();
  });

  // ---------- Debug tools ----------

  const reportEl = $("#report");

  // Talks to the content script in the page. Fails if the page was open before the extension
  // was installed or reloaded (the content script isn't in it yet).
  async function ask(message) {
    try {
      return await ext.tabs.sendMessage(tab.id, message);
    } catch {
      showReport([{ ok: false, text: "The extension isn't running on this page yet. Reload the page and try again." }]);
      return null;
    }
  }

  // lines: [{ ok: true | false | null, text, code? }]
  function showReport(lines) {
    reportEl.hidden = false;
    reportEl.textContent = "";
    for (const line of lines) {
      const li = document.createElement("li");
      li.className = line.ok === true ? "ok" : line.ok === false ? "bad" : "info";
      li.append(line.text);
      if (line.code) {
        const code = document.createElement("code");
        code.textContent = line.code;
        li.append(" ", code);
      }
      reportEl.appendChild(li);
    }
  }

  // Turns the content script's check result into readable lines.
  function describeCheck(r) {
    const lines = [];
    if (!r.extensionEnabled) lines.push({ ok: false, text: "The extension is turned off." });
    if (!r.rule) {
      lines.push({ ok: false, text: "No rule for this site yet. Use Pick thumbnail to start one." });
      return lines;
    }
    lines.push({ ok: r.rule.enabled, text: `Rule: ${r.rule.name}${r.rule.enabled ? "" : " (turned off)"}` });

    const t = r.thumbnails;
    if (!t.selector) lines.push({ ok: false, text: "No thumbnail selector yet. Use Pick thumbnail." });
    else if (!t.valid) lines.push({ ok: false, text: "Thumbnail selector isn't valid CSS:", code: t.selector });
    else {
      lines.push({ ok: t.count > 0, text: `Thumbnail selector matches ${t.count} on this page (outlined in purple).` });
      if (t.count) lines.push({ ok: t.buttons > 0, text: `Expand buttons on the page: ${t.buttons}.` });
    }

    const p = r.preview;
    if (!p.selector) lines.push({ ok: null, text: "Preview: auto, whichever video plays over the thumbnail." });
    else if (!p.valid) lines.push({ ok: false, text: "Preview selector isn't valid CSS:", code: p.selector });
    else lines.push({ ok: null, text: `Preview selector matches ${p.count} right now:`, code: p.selector });
    if (p.playingNow) lines.push({ ok: true, text: `Previews showing over thumbnails right now: ${p.playingNow} (outlined in red).` });

    // Previews only exist while a thumbnail is hovered, so they can't be checked from here.
    lines.push({
      ok: null,
      text: r.debug
        ? "To check a preview, hover a thumbnail: the preview it finds gets a red outline. Press Alt+Shift+P over a playing preview to save it as the preview selector."
        : "To check a preview, turn on Debug mode and hover a thumbnail: the preview it finds gets a red outline."
    });
    return lines;
  }

  $("#check").addEventListener("click", async () => {
    const result = await ask({ type: "te-check" });
    if (result) showReport(describeCheck(result));
  });

  // The picker runs in the page, so the popup closes to let you point at things.
  $("#pick-thumbnail").addEventListener("click", async () => {
    if (await ask({ type: "te-pick" })) window.close();
  });
})();
