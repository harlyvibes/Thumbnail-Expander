// Debugging helpers for setting up site rules: selector suggestions, finding the player around a
// video, highlighting matches, and a point-and-click element picker. Loaded before content.js;
// content scripts from one extension share their globals.

// Attributes that never make a good selector (they describe content, not what the element is).
const TE_SKIP_ATTRS = new Set([
  "id", "class", "style", "href", "src", "srcset", "sizes", "alt", "title", "role", "tabindex",
  "type", "target", "rel", "width", "height", "loading", "decoding", "draggable", "dir", "lang",
  "slot", "hidden", "name", "value", "for", "fetchpriority", "crossorigin", "referrerpolicy",
  "poster", "preload", "autoplay", "muted", "playsinline", "controls", "loop", "disabled"
]);

// What counts as "the video" inside a player element.
const TE_MEDIA = "video, iframe, canvas, embed, object";

// Elements that can't hold the expand button (it's added as a child).
const TE_NO_CHILDREN = "img, picture, svg, input, " + TE_MEDIA;

// Does this id/class/attribute value look machine-generated, and so likely to change when the
// site updates? (e.g. "SPW_123456789", "css-1x2y3z", "Component-sPPW")
function teLooksGenerated(s) {
  if (/\d{4,}/.test(s)) return true; // long numbers: ids, timestamps
  if (/^(css|sc|jsx|svelte|emotion|tw)-/i.test(s)) return true; // CSS-in-JS prefixes
  const last = s.split(/[-_]/).pop();
  if (last.length <= 5 && /[a-z]/.test(last) && /[A-Z]/.test(last.slice(1))) return true; // "sPPW"
  if (s.length >= 5 && (s.match(/\d/g) || []).length >= 2 && /[a-z]/i.test(s)) return true; // "a1b2c"
  return false;
}

function teQuote(value) {
  return value.replace(/["\\]/g, "\\$&");
}

// Selectors describing the element itself (id, attributes, custom tag, classes).
// Lower rank = more likely to survive site updates.
function teOwnCandidates(el) {
  const out = [];
  const tag = el.tagName.toLowerCase();

  if (el.id && !teLooksGenerated(el.id)) out.push({ sel: "#" + CSS.escape(el.id), rank: 0 });

  for (const { name, value } of [...el.attributes]) {
    if (TE_SKIP_ATTRS.has(name) || name.startsWith("aria-") || name.startsWith("on") || name.startsWith("data-te-")) continue;
    if (!value || value.length > 80) continue;
    // Bare numbers and booleans ("0", "true") are state, not identity.
    if (/^(\d+|true|false)$/i.test(value)) continue;
    const attr = CSS.escape(name);
    // A fixed start followed by a number, like "SPW_123456789": match just the start.
    const prefix = value.match(/^(\D+)\d{3,}/);
    if (prefix) out.push({ sel: `[${attr}^="${teQuote(prefix[1])}"]`, rank: 1 });
    else if (!teLooksGenerated(value)) out.push({ sel: `[${attr}="${teQuote(value)}"]`, rank: 1 });
  }

  // Custom elements (YouTube's ytd-thumbnail etc.) are named on purpose and rarely change.
  if (tag.includes("-")) out.push({ sel: tag, rank: 1 });

  for (const cls of el.classList) {
    if (cls.startsWith("te-")) continue;
    // CSS modules: "VideoCard__thumb___x7Yz2" -> match the readable start.
    const mod = cls.match(/^(.+?__.+?)___[\w-]+$/);
    if (mod) out.push({ sel: `[class*="${teQuote(mod[1])}"]`, rank: 2 });
    else if (!teLooksGenerated(cls)) out.push({ sel: "." + CSS.escape(cls), rank: 2 });
  }
  return out;
}

// All candidates: the element's own, then its tag scoped to the parent (for elements with nothing
// distinctive of their own), then the bare tag as a last resort.
function teSelectorCandidates(el) {
  const tag = el.tagName.toLowerCase();
  const out = teOwnCandidates(el);
  const parent = el.parentElement;
  if (parent && parent !== el.ownerDocument.body) {
    for (const p of teOwnCandidates(parent).slice(0, 3)) out.push({ sel: `${p.sel} > ${tag}`, rank: 2.5 });
  }
  out.push({ sel: tag, rank: 3 });
  return out;
}

// Best selector for an element.
//   kind "thumbnail": should match this element and the other thumbnails like it (many matches).
//   kind "player":    should match just this element.
// Returns { sel, count, rank }.
function teSuggestSelector(el, kind) {
  const doc = el.ownerDocument;
  const scored = [];
  for (const c of teSelectorCandidates(el)) {
    try {
      if (!el.matches(c.sel)) continue;
      scored.push({ ...c, count: doc.querySelectorAll(c.sel).length });
    } catch {
      // Not valid CSS for this browser; skip it.
    }
  }
  if (kind === "player") {
    scored.sort((a, b) => (a.count === 1 ? 0 : 1) - (b.count === 1 ? 0 : 1) || a.rank - b.rank || a.count - b.count);
  } else {
    scored.sort((a, b) => (a.count > 1 ? 0 : 1) - (b.count > 1 ? 0 : 1) || a.rank - b.rank || b.count - a.count);
  }
  return scored[0];
}

// From an element (an image under the cursor, say), climb to the outermost ancestor that is still
// the same size: the box the size of the image or video. Collapsed wrappers (inline links, or
// YouTube's zero-height box around its absolutely positioned video) are skipped over rather than
// stopping the climb.
function teSameSizeChain(el) {
  const base = el.getBoundingClientRect();
  // Allow for borders, padding and rounding: 8px or 5%, whichever is larger.
  const close = (a, b) => Math.abs(a - b) <= Math.max(8, b * 0.05);
  const chain = [el];
  for (let p = el.parentElement; p && p !== el.ownerDocument.body; p = p.parentElement) {
    const r = p.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (!close(r.width, base.width) || !close(r.height, base.height)) break;
    chain.push(p);
  }
  return chain;
}

// The element to put the expand button in, starting from whatever is under the cursor.
function teThumbnailElementFor(el) {
  const chain = teSameSizeChain(el);
  return teButtonHost(chain[chain.length - 1]);
}

// The button is added inside the thumbnail, so step out of images and other media.
function teButtonHost(el) {
  let host = el;
  while (host?.parentElement && host.matches(TE_NO_CHILDREN)) host = host.parentElement;
  return host || el;
}

// From a video (or anything inside the player), find the element that holds both the video and
// its controls: the innermost same-size ancestor that has controls in it and a unique selector.
function tePlayerElementFor(el) {
  const hasControls = (e) =>
    !!e.querySelector('button, [role="button"], input[type="range"], [class*="control" i]');
  const chain = teSameSizeChain(el).filter((e) => !e.matches(TE_MEDIA));
  if (!chain.length) {
    // Nothing around the video is the same size: take the nearest ancestor with controls.
    for (let p = el.parentElement; p && p !== el.ownerDocument.body; p = p.parentElement) {
      if (hasControls(p)) return p;
    }
    return el.parentElement || el;
  }
  const scored = chain.map((e) => ({ e, s: teSuggestSelector(e, "player"), controls: hasControls(e) }));
  const pick =
    scored.find((x) => x.controls && x.s?.count === 1 && x.s.rank <= 1) ||
    scored.find((x) => x.controls && x.s?.count === 1) ||
    scored.find((x) => x.s?.count === 1) ||
    scored[scored.length - 1];
  return pick.e;
}

// The video (or player iframe) under the mouse, starting from the hovered element. Hovering a
// player usually lands on one of its controls, so this walks up from "the play button" until it
// finds a sizeable video. With a mouse position, the video must be under it (with a margin for
// control bars drawn just outside the picture), so hovering elsewhere on the page finds nothing.
function teMediaNear(el, point) {
  const usable = (m) => {
    const r = m.getBoundingClientRect();
    if (r.width < 150 || r.height < 80) return false;
    if (!point) return true;
    const mx = 8;
    const my = Math.max(24, r.height * 0.15);
    return point.x >= r.left - mx && point.x <= r.right + mx && point.y >= r.top - my && point.y <= r.bottom + my;
  };
  for (let e = el; e && e !== e.ownerDocument.body; e = e.parentElement) {
    if (e.matches("video, iframe") && usable(e)) return e;
    const inside = [...e.querySelectorAll("video, iframe")].find(usable);
    if (inside) return inside;
  }
  return null;
}

// The biggest visible video on the page, or failing that the biggest large iframe (a player
// embedded from another domain).
function teFindMainMedia(doc = document) {
  const area = (e) => {
    const r = e.getBoundingClientRect();
    return r.width * r.height;
  };
  const biggest = (list) => list.filter((e) => area(e) > 0).sort((a, b) => area(b) - area(a))[0] || null;
  return (
    biggest([...doc.querySelectorAll("video")]) ||
    biggest([...doc.querySelectorAll("iframe")].filter((f) => f.getBoundingClientRect().width >= 200))
  );
}

// "div#player.video-box 640×360" for logs and labels.
function teDescribe(el) {
  if (!el) return "(none)";
  const r = el.getBoundingClientRect();
  const cls = [...el.classList].filter((c) => !c.startsWith("te-")).slice(0, 2).map((c) => "." + c).join("");
  return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls} ${Math.round(r.width)}×${Math.round(r.height)}`;
}

// Outlines elements for a few seconds.
function teHighlight(elements, kind, ms = 4000) {
  const cls = kind === "player" ? "te-hl-player" : "te-hl-thumb";
  const list = [...elements].slice(0, 300);
  list.forEach((el) => el.classList.add(cls));
  setTimeout(() => list.forEach((el) => el.classList.remove(cls)), ms);
}

// Lets the user point at an element on the page. A transparent layer catches the mouse (so links
// don't fire and players in iframes can be picked too); the element underneath is found by
// position. Arrow keys move to the parent/child. Resolves with the chosen element, or null on Esc.
function tePickElement({ kind, title }) {
  return new Promise((resolve) => {
    const make = (cls) => {
      const el = document.createElement("div");
      el.className = cls;
      document.documentElement.appendChild(el);
      return el;
    };
    const layer = make("te-picker");
    const box = make("te-picker-box");
    const label = make("te-picker-label");
    const banner = make("te-picker-banner");
    const key = (text) => {
      const k = document.createElement("kbd");
      k.textContent = text;
      return k;
    };
    const strong = document.createElement("b");
    strong.textContent = title;
    banner.append(strong, "  Click to choose · ", key("↑"), key("↓"), " parent/child · ", key("Esc"), " cancel");

    let current = null;
    let under = null;
    const downStack = [];

    const show = () => {
      if (!current) return;
      const r = current.getBoundingClientRect();
      Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      const s = teSuggestSelector(current, kind);
      label.textContent = `${s ? s.sel : current.tagName.toLowerCase()}  ·  ${s ? s.count : "?"} on page  ·  ${Math.round(r.width)}×${Math.round(r.height)}`;
      label.style.left = Math.max(4, r.left) + "px";
      label.style.top = (r.top > 34 ? r.top - 30 : Math.min(innerHeight - 30, r.bottom + 6)) + "px";
    };

    const elementAt = (x, y) =>
      document.elementsFromPoint(x, y).find((e) => e !== layer && e !== document.documentElement && e !== document.body);

    const onMove = (e) => {
      const el = elementAt(e.clientX, e.clientY);
      if (!el || el === under) return;
      under = el;
      downStack.length = 0;
      current = kind === "player" ? tePlayerElementFor(el) : teThumbnailElementFor(el);
      show();
    };

    const onKey = (e) => {
      if (e.key === "Escape") finish(null);
      else if (e.key === "Enter" && current) finish(current);
      else if (e.key === "ArrowUp" && current?.parentElement && current.parentElement !== document.body) {
        downStack.push(current);
        current = current.parentElement;
        show();
      } else if (e.key === "ArrowDown" && downStack.length) {
        current = downStack.pop();
        show();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (current) finish(current);
    };

    function finish(result) {
      layer.removeEventListener("mousemove", onMove);
      layer.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", show, true);
      [layer, box, label, banner].forEach((el) => el.remove());
      resolve(result);
    }

    layer.addEventListener("mousemove", onMove);
    layer.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", show, true);
  });
}
