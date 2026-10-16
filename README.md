<img src="chrome-extension/icons/icon128.png" alt="" width="72" align="right">

# Thumbnail Expander

A Chrome extension that adds an expand button to the top-left corner of video thumbnails. Clicking it opens the video full-window over the page, without clicking into the video itself.

Works on YouTube and Dailymotion out of the box. Other sites can be added from the settings page.

## Install (unpacked)

1. Download this repository (**Code** > **Download ZIP**) and unzip it, or clone it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `chrome-extension` folder inside it.
5. Pin the extension from Chrome's puzzle-piece menu so its icon stays in the toolbar.
6. Open YouTube and hover over a thumbnail. The expand button appears in its top-left corner.

## Usage

- Click the expand button on a thumbnail to open the video full-window.
- Press **Esc** or the close button in the corner to close it.
- Click the toolbar icon for quick switches: turn the extension or the current site on and off, toggle autoplay, or add the current site.

## Settings

Click the toolbar icon and choose **Settings** (or `chrome://extensions` > Thumbnail Expander > **Extension options**).

- **Enable**: turn the extension on or off globally.
- **Autoplay**: start the video as soon as it's expanded.
- **Debug mode**: see [Debugging tools](#debugging-tools).
- **Sites**: one rule per website. Click a site to edit it. Each rule has:
  - **Domains**: where the rule applies (subdomains included).
  - **Thumbnail selector**: CSS selector for the thumbnail element. The button is placed inside it.
  - **Link selector** (optional): CSS selector for the element whose `href` points to the video. It is looked for inside the thumbnail first, then in the elements around it. Defaults to `a[href]`.
  - **Playback mode**:
    - **Page**: loads the video's own page in a full-window frame and hides everything except the player. Needs a **Player selector** (YouTube: `#movie_player`). Only works for links on the same site, and only on sites that allow their pages in frames.
    - **Embed**: loads the site's embeddable player. Needs a **Video ID pattern** (regex, group 1 = the ID) and an **Embed URL** with `{id}` where the ID goes.

Changes from the popup apply immediately. Changes on the settings page apply when you click **Save changes**; open video pages update without a reload.

## Why YouTube uses page mode

YouTube refuses to play its embedded player on youtube.com itself ("This video is unavailable", error 152-4), for every video. So on YouTube the extension loads the normal watch page in a frame and enlarges its player instead. Side effects: it plays YouTube's usual ads, and the video counts as watched in your history, just like opening it normally.

Dailymotion is the opposite: it refuses to show its pages in frames, but its embed player works, so it uses embed mode.

## Adding a site

The quickest way is with the picker:

1. Open the site's thumbnail page, click the toolbar icon, and choose **Pick thumbnail**. Point at a thumbnail and click. This creates a rule for the site with a thumbnail selector.
2. Open one of its videos, click the toolbar icon, and choose **Pick player**. Point at the player and click.
3. Go back to the thumbnails and try the expand button. If it doesn't work, use **Check this page** (see below).

To do it by hand:

1. Open the site and right-click a thumbnail, then choose **Inspect**.
2. Find the element that wraps the thumbnail and note its tag, class, or id.
3. Click the toolbar icon and choose **Add this site** (or **Add a site** on the settings page), then fill in the fields. Target the box that is the size of the thumbnail image, not a bare link: a selector like `a[href*='/video/']` also matches title text links. If class names end in a build hash, match the stable start (`[class*='VideoCard__thumb']`) and use `:has()` to require a video link inside (`div:has(> a[href*='/video/'])`).
4. Save, reload the site, and hover a thumbnail.

## Debugging tools

All in the toolbar popup:

- **Debug mode**: logs what the extension does to the browser console (filter it by `Thumbnail Expander`), outlines every thumbnail it recognized in purple, and keeps their buttons visible. When you expand a video, a panel in the top-left says what the player selector matched, whether the video is inside it, and suggests a better selector with a **Use** button.
- **Check this page**: tests the site's rule against the open page and outlines what matches: thumbnails in purple, the player in red. It reports how many thumbnails matched and whether their video links were found, plus the embed URL in embed mode. On a video page, it reports whether the player selector contains the video, and suggests one with a **Use** button if it doesn't.
- **Alt+Shift+P** (Option+Shift+P on Mac), in debug mode: on a video page, hover over the player and press it to save that player as the site's player selector, without opening the popup. If the player is in an iframe and you've clicked into it, click somewhere else on the page first so the shortcut reaches the page.
- **Pick thumbnail** / **Pick player**: point at an element and click to save a selector for it. **↑**/**↓** move to the parent/child element, and **Esc** cancels. The label shows the selector it will use and how many elements on the page it matches.

Common problems:

- **Audio but no picture when expanded**: the player selector doesn't match the element around the video, so the video gets hidden. Open a video, then press **Alt+Shift+P** over the player (debug mode), or use **Check this page** or **Pick player**.
- **No expand buttons**: the thumbnail selector matches nothing. Turn on debug mode to see the outlines, or use **Pick thumbnail**.
- **"Reload the page and try again"** in the popup: the page was open before the extension was installed or reloaded.

## Notes

- Some sites block their videos from playing in embedded players. In that case the overlay shows the site's own error message; try page mode for that site.
- Ad thumbnails link to an ad server rather than a video, so they show a message instead of expanding.
- The extension runs on all sites (`<all_urls>`) because you can add rules for any domain. It does nothing on a page unless a rule matches the domain.
- Settings are stored with `chrome.storage.sync`, so they follow your Chrome profile. Settings saved by older versions are upgraded automatically.
- The icons are generated by `tools/make_icons.py` (requires Pillow). Run `python tools/make_icons.py` from the repository root to regenerate them.
