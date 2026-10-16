<img src="chrome-extension/icons/icon128.png" alt="" width="72" align="right">

# Thumbnail Expander

A Chrome and Firefox extension for sites that play a preview when you hover a video thumbnail. It adds an expand button to the top-left corner of each thumbnail. Clicking it blows that hover preview up to fill the browser window. Nothing new is loaded, so it never opens the video's page.

Comes with rules for YouTube and Dailymotion. Other sites can be added from the toolbar popup or the settings page.

## Install in Chrome

1. Download this repository (**Code** > **Download ZIP**) and unzip it, or clone it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `chrome-extension` folder inside it.
5. Pin the extension from Chrome's puzzle-piece menu so its icon stays in the toolbar.

To update, download or pull the repository again, then click the reload icon on the extension's card in `chrome://extensions` and reload open tabs. The card shows the version, so you can check the update took.

## Install in Firefox

Needs Firefox 140 or later.

**To try it** (removed when Firefox closes):

1. Download this repository and unzip it, or clone it.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select `manifest.json` in the `firefox-extension` folder.

**To keep it installed:** standard Firefox only keeps add-ons that Mozilla has signed. Either:

- Get it signed (free, and it stays private). Zip the *contents* of `firefox-extension` (not the folder itself), sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/addon/submit/distribution), and submit the zip with **On your own** chosen. Mozilla signs it automatically. Download the signed `.xpi` and open it in Firefox.
- Or use Firefox Developer Edition or Nightly. Set `xpinstall.signatures.required` to `false` in `about:config`, rename the zip above to `.xpi`, and install it from `about:addons` (gear menu > **Install Add-on From File…**).

If no expand buttons appear, click Firefox's Extensions button (puzzle piece), then Thumbnail Expander, and allow it on all sites.

The `firefox-extension` folder is generated from `chrome-extension`: the code is shared, only the manifest differs. After changing anything in `chrome-extension`, run `python tools/build_firefox.py` from the repository root to update it.

## Usage

1. Hover a thumbnail until the site starts its preview.
2. Click the expand button in the thumbnail's top-left corner. The preview fills the window, exactly as the site plays it.
3. Press **Esc** to put it back. There's also a close button in the top-right corner. It stays hidden until you move the mouse, and hides again when the mouse rests for a few seconds. So does the mouse cursor.

While it's enlarged, you can move the mouse anywhere and the preview keeps playing. Clicks on the preview are blocked, so they can't open the video. The page doesn't scroll, and its scrollbar is hidden. If you click expand before the preview starts, it waits a few seconds for it.

## How it works

The extension doesn't copy or reload the preview. It lifts the site's own preview element into the browser's top layer (as a popover), where it's drawn above everything on the page and nothing can clip, shrink or cover it. The extension's stylesheet sizes it to the window and wins over the site's own styles, even ones the site's scripts keep rewriting. The preview stays inside the thumbnail in the page, so the site still treats it as that thumbnail's preview.

While it's enlarged, the site doesn't see mouse movement, so it can't tell the mouse left the thumbnail, and it doesn't see the page scroll. Links around the preview are disabled. If the site swaps in a new preview element, the extension enlarges that one instead. Closing puts every change back.

## Settings

Click the toolbar icon for quick switches (the extension, the current site, debug mode), or choose **Settings** for the full list.

Each site rule has:

- **Domains**: where the rule applies (subdomains included).
- **Thumbnail selector**: CSS selector for the thumbnail element. The expand button is placed inside it.
- **Preview selector** (optional): CSS selector for the element the site plays as the preview. Leave it empty to use whichever video (or player iframe) is playing over the thumbnail.

Changes from the popup apply immediately. Changes on the settings page apply when you click **Save changes**. Open pages update without a reload.

## Adding a site

1. Open the site, click the toolbar icon, and choose **Pick thumbnail**. Point at a thumbnail and click. This creates a rule for the site with a thumbnail selector.
2. Hover a thumbnail until its preview plays, and click the expand button. Usually that's all it takes.
3. If it enlarges the wrong thing, or says no preview is playing, set the preview selector. Turn on **Debug mode**, hover a thumbnail until its preview plays, and press **Alt+Shift+P** with the mouse over the preview.

To write selectors by hand: right-click a thumbnail, choose **Inspect**, and find the box that is the size of the thumbnail image (not a text link). If class names end in a build hash, match the stable start, like `[class*='VideoCard__thumb']`. If an attribute ends in a number, match the start, like `[data-id^='SPW_']`.

## Debugging tools

In the toolbar popup:

- **Debug mode**: outlines every recognized thumbnail in purple. While you hover one, the preview it would enlarge gets a red outline. When you expand, a panel in the top-left shows the thumbnail, the preview, and how it was found, with a button to save it as the preview selector. It also logs to the browser console (filter by `Thumbnail Expander`).
- **Alt+Shift+P** (Option+Shift+P on Mac), in debug mode: hover a thumbnail until its preview plays, then press it with the mouse over the preview. The video under the mouse is saved as the site's preview selector. It finds the video by position, so it works even when the site makes the preview ignore the mouse.
- **Check this page**: tests the site's rule against the open page. It outlines matching thumbnails and reports how many there are and how many have buttons. It also reports the preview selector and any previews showing right now.
- **Pick thumbnail**: point at a thumbnail and click to save its selector. The label shows the selector it will save and how many elements it matches; that should be the number of thumbnails. When the thumbnail has nothing distinctive of its own (only generated class names, say), the selector is a path from a parent that does, like `[datum-the-location^="SPW_"] > div > div:has(img)`. **↑**/**↓** move to the parent/child element, and **Esc** cancels.

Common problems:

- **No expand buttons**: the thumbnail selector matches nothing. Turn on debug mode to see the outlines, or use **Pick thumbnail**.
- **"No preview is playing in this thumbnail"**: hover until the site starts its preview, then click expand. If the preview is playing and it still says this, set the preview selector with **Alt+Shift+P**.
- **The wrong thing gets enlarged**: set the preview selector with **Alt+Shift+P** over the actual preview.
- **"Reload the page and try again"** in the popup: the page was open before the extension was installed or reloaded.

## Notes

- The site has to play previews on hover; this enlarges that preview. It plays exactly as the site plays it, including whether it's muted.
- The extension runs on all sites (`<all_urls>`) because you can add rules for any domain. It does nothing on a page unless a rule matches the domain.
- Settings are stored in the browser's sync storage, so they follow your Chrome profile or Firefox account (each browser keeps its own). Settings saved by older versions are upgraded automatically. Only the thumbnail selectors carry over from the old page and embed modes.
- The icons are generated by `tools/make_icons.py` (requires Pillow). Run `python tools/make_icons.py` from the repository root to regenerate them.
