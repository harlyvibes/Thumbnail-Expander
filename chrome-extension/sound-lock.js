// Runs in the page's own JavaScript (see "world": "MAIN" in the manifest), before the site's
// scripts. Some sites keep setting their preview's volume or mute (to keep previews quiet, or in
// sync with their own volume setting), which fights the volume control on an enlarged preview.
// While that control is in use, content.js marks the preview with data-te-sound-lock, and the
// site's changes to its volume and mute are ignored. Everywhere else this does nothing.
//
// The extension's own changes don't come through here: its content scripts run in a separate
// world with their own, untouched copy of these properties.
(() => {
  const LOCK_ATTR = "data-te-sound-lock";
  const hasAttribute = Element.prototype.hasAttribute;
  const proto = HTMLMediaElement.prototype;
  for (const prop of ["volume", "muted"]) {
    const native = Object.getOwnPropertyDescriptor(proto, prop);
    if (!native?.set) continue;
    Object.defineProperty(proto, prop, {
      ...native,
      set(value) {
        if (hasAttribute.call(this, LOCK_ATTR)) return;
        native.set.call(this, value);
      }
    });
  }
})();
