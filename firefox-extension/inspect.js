// Debugging helpers for setting up site rules: selector suggestions, finding the video under the
// mouse, highlighting matches, and a point-and-click thumbnail picker. Loaded before content.js;
// content scripts from one extension share their globals.

// Attributes that never make a good selector (they describe content, not what the element is).
const TE_SKIP_ATTRS = new Set([
  "id", "class", "style", "href", "src", "srcset", "sizes", "alt", "title", "role", "tabindex",
  "type", "target", "rel", "width", "height", "loading", "decoding", "draggable", "dir", "lang",
  "slot", "hidden", "name", "value", "for", "fetchpriority", "crossorigin", "referrerpolicy",
  "poster", "preload", "autoplay", "muted", "playsinline", "controls", "loop", "disabled"
]);

// Elements a preview can be: a video, or a site's player in an iframe.
const TE_PREVIEW_MEDIA = "video, iframe";

// Elements that can't hold the expand button (it's added as a child).
const TE_NO_CHILDREN = "img, picture, svg, input, video, iframe, canvas, embed, object";

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

// Container tags that make a useful starting point for a path down to a thumbnail.
const TE_ANCHOR_TAGS = new Set(["main", "section", "article", "ul", "ol", "li", "nav", "aside"]);

// Selectors for a thumbnail. Its own (id, attributes, classes), and paths down to it from up to
// five ancestors, like "[data-id^='SPW_'] > div > div", for thumbnails with nothing distinctive
// of their own (only generated class names, say). Never the bare tag: "div" would put a button in
// every box on the page.
function teThumbnailCandidates(el) {
  const tag = el.tagName.toLowerCase();
  const own = teOwnCandidates(el);
  const out = [...own];
  // Two or more stable classes together are often specific where each alone isn't.
  const classes = own.filter((c) => c.sel.startsWith(".")).map((c) => c.sel);
  if (classes.length > 1) out.push({ sel: classes.slice(0, 4).join(""), rank: 2 });

  // The last step of a path: the tag, narrowed to boxes holding an image, or by position.
  const index = [...(el.parentElement?.children || [])].indexOf(el) + 1;
  const tails = [{ sel: tag, rank: 0 }];
  if (el.querySelector("img")) tails.push({ sel: `${tag}:has(img)`, rank: 0.1 });
  if (index > 0) tails.push({ sel: `${tag}:nth-child(${index})`, rank: 0.3 });

  let between = ""; // tags between the ancestor and el, like "div > a > "
  for (let a = el.parentElement, depth = 0; a && a !== el.ownerDocument.body && depth < 5; a = a.parentElement, depth++) {
    const anchors = teOwnCandidates(a).slice(0, 4);
    if (TE_ANCHOR_TAGS.has(a.tagName.toLowerCase())) anchors.push({ sel: a.tagName.toLowerCase(), rank: 2 });
    for (const p of anchors) {
      const rank = 2 + depth * 0.1;
      for (const t of tails) out.push({ sel: `${p.sel} > ${between}${t.sel}`, rank: rank + t.rank });
      for (const o of own.slice(0, 2)) out.push({ sel: `${p.sel} ${o.sel}`, rank: rank + 0.05 });
    }
    between = `${a.tagName.toLowerCase()} > ${between}`;
  }
  return out;
}

// How well a selector picks out thumbnails like el. Thumbnails on a page share a shape, so a good
// selector matches several boxes, nearly all shaped like el, and none inside another (each would
// get a button). Returns { count, alike, share, nested }.
function teThumbnailFit(el, sel) {
  const matches = [...el.ownerDocument.querySelectorAll(sel)];
  const r0 = el.getBoundingClientRect();
  const ratio = r0.width / r0.height;
  const sample = matches.slice(0, 120);
  let alike = 0;
  let nested = false;
  for (const m of sample) {
    const r = m.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 20 && Math.abs(r.width / r.height - ratio) <= ratio * 0.15) alike++;
    if (!nested && m.parentElement?.closest(sel)) nested = true;
  }
  return {
    count: matches.length,
    alike: Math.round((alike * matches.length) / sample.length),
    share: alike / sample.length,
    nested
  };
}

// Best selector for an element.
//   kind "thumbnail": should match this element and the other thumbnails like it (many matches).
//   kind "preview":   should match this preview video and as little else as possible. Previews
//                     only exist while hovering, so there's usually just one on the page.
// Returns { sel, count, rank }, or undefined.
function teSuggestSelector(el, kind) {
  const candidates = kind === "thumbnail" ? teThumbnailCandidates(el) : teSelectorCandidates(el);
  const seen = new Set();
  const scored = [];
  for (const c of candidates) {
    if (seen.has(c.sel)) continue;
    seen.add(c.sel);
    try {
      if (!el.matches(c.sel)) continue;
      if (kind === "thumbnail") scored.push({ ...c, ...teThumbnailFit(el, c.sel) });
      else scored.push({ ...c, count: el.ownerDocument.querySelectorAll(c.sel).length });
    } catch {
      // Not valid CSS for this browser; skip it.
    }
  }
  if (kind === "preview") {
    scored.sort((a, b) => a.count - b.count || a.rank - b.rank);
    return scored[0];
  }
  // Thumbnails: the selector that finds the most boxes shaped like this one, if nearly all its
  // matches are. Otherwise the one closest to that.
  const good = scored.filter((s) => s.count > 1 && s.share >= 0.75 && !s.nested);
  if (good.length) {
    good.sort((a, b) => b.alike - a.alike || a.rank - b.rank || a.sel.length - b.sel.length);
    return good[0];
  }
  scored.sort(
    (a, b) =>
      a.nested - b.nested ||
      (a.count > 1 ? 0 : 1) - (b.count > 1 ? 0 : 1) ||
      b.share - a.share ||
      a.rank - b.rank
  );
  return scored[0];
}

// From an element (an image under the cursor, say), climb to the outermost ancestor that is still
// the same size: the box the size of the image. Collapsed wrappers (inline links, zero-height
// boxes) are skipped over rather than stopping the climb.
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

// The video (or player iframe) at a point on the page: the smallest one covering it. Found by
// position rather than by what's hovered, because sites often make previews ignore the mouse
// (pointer-events: none) so clicks reach the link underneath.
function teVideoAt(point, doc = document) {
  let best = null;
  let bestArea = Infinity;
  for (const m of doc.querySelectorAll(TE_PREVIEW_MEDIA)) {
    const r = m.getBoundingClientRect();
    if (r.width < 50 || r.height < 30) continue;
    if (point.x < r.left || point.x > r.right || point.y < r.top || point.y > r.bottom) continue;
    const area = r.width * r.height;
    if (area < bestArea) {
      best = m;
      bestArea = area;
    }
  }
  return best;
}

// "video.preview-player 320×180" for logs and labels.
function teDescribe(el) {
  if (!el) return "(none)";
  const r = el.getBoundingClientRect();
  const cls = [...el.classList].filter((c) => !c.startsWith("te-")).slice(0, 2).map((c) => "." + c).join("");
  return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls} ${Math.round(r.width)}×${Math.round(r.height)}`;
}

// Outlines elements for a few seconds: thumbnails in purple, previews in red.
function teHighlight(elements, kind, ms = 4000) {
  const cls = kind === "preview" ? "te-hl-preview" : "te-hl-thumb";
  const list = [...elements].slice(0, 300);
  list.forEach((el) => el.classList.add(cls));
  setTimeout(() => list.forEach((el) => el.classList.remove(cls)), ms);
}

// Lets the user point at a thumbnail on the page. A transparent layer catches the mouse (so links
// don't fire); the element underneath is found by position. Arrow keys move to the parent/child.
// Resolves with the chosen element, or null on Esc.
function tePickElement({ title }) {
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
    const suggestions = new Map(); // element -> suggestion; working one out takes a moment

    const show = () => {
      if (!current) return;
      const r = current.getBoundingClientRect();
      Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      const host = teButtonHost(current);
      if (!suggestions.has(host)) suggestions.set(host, teSuggestSelector(host, "thumbnail"));
      const s = suggestions.get(host);
      label.textContent = `${s ? s.sel : "no selector, try ↑"}  ·  ${s ? s.count : 0} on page  ·  ${Math.round(r.width)}×${Math.round(r.height)}`;
      label.style.left = Math.max(4, r.left) + "px";
      label.style.top = (r.top > 34 ? r.top - 30 : Math.min(innerHeight - 30, r.bottom + 6)) + "px";
    };

    // The page element under the mouse. Sites often lay a link or a gradient over the thumbnail
    // image; the image itself is the better starting point.
    const elementAt = (x, y) => {
      const stack = document
        .elementsFromPoint(x, y)
        .filter((e) => e !== layer && e !== document.documentElement && e !== document.body && !e.closest(".te-expand-btn"));
      const image = stack.find((e) => e.matches("img, video, picture, canvas") && e.getBoundingClientRect().width >= 80);
      return image || stack[0];
    };

    const onMove = (e) => {
      const el = elementAt(e.clientX, e.clientY);
      if (!el || el === under) return;
      under = el;
      downStack.length = 0;
      current = teThumbnailElementFor(el);
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
