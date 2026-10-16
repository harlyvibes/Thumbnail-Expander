// Toolbar popup: quick switches for the extension and the current site, plus debug tools for
// setting up a site's rule. Changes save immediately; open video pages pick them up through
// chrome.storage.onChanged.
(async () => {
  const $ = (sel) => document.querySelector(sel);

  const data = await chrome.storage.sync.get(["settings"]);
  const settings = mergeSettings(data.settings);
  const save = () => chrome.storage.sync.set({ settings });

  // The active tab, and its hostname if it's a normal web page (activeTab grants the URL here).
  let tab = null;
  let host = "";
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || "");
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch {
    // No tab URL available; the "not a web page" state is shown.
  }

  const rule = host ? settings.sites.find((s) => ruleMatchesHost(s, host)) : null;

  $("#enabled").checked = settings.enabled;
  $("#autoplay").checked = settings.autoplay;
  $("#debug-mode").checked = settings.debug;
  document.body.classList.toggle("off", !settings.enabled);
  document.body.classList.toggle("nopage", !host);

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
    chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?add=${encodeURIComponent(domain)}`) });
    window.close();
  });

  $("#settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // ---------- Debug tools ----------

  const reportEl = $("#report");

  // Talks to the content script in the page. Fails if the page was open before the extension
  // was installed or reloaded (the content script isn't in it yet).
  async function ask(message) {
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      showReport([{ ok: false, text: "The extension isn't running on this page yet. Reload the page and try again." }]);
      return null;
    }
  }

  // lines: [{ ok: true | false | null, text, code?, use?: { field, value } }]
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
      if (line.use) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn use";
        button.textContent = "Use";
        button.addEventListener("click", () => useSelector(line.use.field, line.use.value, button));
        li.append(button);
      }
      reportEl.appendChild(li);
    }
  }

  async function useSelector(field, value, button) {
    const fresh = mergeSettings((await chrome.storage.sync.get(["settings"])).settings);
    applyPickedSelector(fresh, host, field, value);
    await chrome.storage.sync.set({ settings: fresh });
    button.textContent = "Saved";
    button.disabled = true;
  }

  // Turns the content script's check result into readable lines.
  function describeCheck(r) {
    const lines = [];
    if (!r.extensionEnabled) lines.push({ ok: false, text: "The extension is turned off." });
    if (!r.rule) {
      lines.push({ ok: false, text: "No rule for this site yet. Use Pick thumbnail to start one." });
    } else {
      lines.push({ ok: r.rule.enabled, text: `Rule: ${r.rule.name}, ${r.rule.mode} mode${r.rule.enabled ? "" : " (turned off)"}` });
      const t = r.thumbnails;
      if (!t.selector) lines.push({ ok: false, text: "No thumbnail selector yet. Use Pick thumbnail." });
      else if (!t.valid) lines.push({ ok: false, text: "Thumbnail selector isn't valid CSS:", code: t.selector });
      else {
        // No thumbnails is expected on a video page, so only flag it elsewhere.
        lines.push(
          t.count > 0
            ? { ok: true, text: `Thumbnail selector matches ${t.count} on this page (outlined in purple).` }
            : { ok: r.player.hasVideo ? null : false, text: "Thumbnail selector matches nothing on this page." }
        );
        if (t.count) lines.push({ ok: t.withLink === t.count, text: `Video links found for ${t.withLink} of ${t.count}.` });
        if (t.sample) lines.push({ ok: null, text: "First link:", code: t.sample });
        if (r.rule.mode === "page" && t.offSite) {
          lines.push({ ok: false, text: `${t.offSite} link(s) go to another site (often ads); page mode can't open those.` });
        }
        if (r.rule.mode !== "page" && t.sample) {
          lines.push(t.embedUrl ? { ok: true, text: "Embed URL:", code: t.embedUrl } : { ok: false, text: "The video ID pattern doesn't match the link." });
        }
      }
    }

    const p = r.player;
    if (!p.hasVideo) {
      if (r.rule?.mode === "page") lines.push({ ok: null, text: "No video on this page. Open a video to check the player selector." });
    } else {
      lines.push({ ok: null, text: "Video on this page:", code: p.video });
      if (p.selector) {
        if (!p.valid) lines.push({ ok: false, text: "Player selector isn't valid CSS:", code: p.selector });
        else if (!p.count) lines.push({ ok: false, text: "Player selector matches nothing on this page:", code: p.selector });
        else lines.push({ ok: p.containsVideo, text: p.containsVideo ? `Player selector matches ${p.count} and contains the video (outlined in red).` : "Player selector matches, but the video isn't inside it, so it would be hidden:", code: p.containsVideo ? undefined : p.selector });
      }
      if (p.suggestion && p.suggestion !== p.selector && !p.containsVideo) {
        lines.push({ ok: null, text: "Suggested player selector:", code: p.suggestion, use: { field: "playerSelector", value: p.suggestion } });
      }
    }
    return lines;
  }

  $("#check").addEventListener("click", async () => {
    const result = await ask({ type: "te-check" });
    if (result) showReport(describeCheck(result));
  });

  // The picker runs in the page, so the popup closes to let you point at things.
  for (const [id, field] of [["#pick-thumbnail", "thumbnail"], ["#pick-player", "playerSelector"]]) {
    $(id).addEventListener("click", async () => {
      if (await ask({ type: "te-pick", field })) window.close();
    });
  }
})();
