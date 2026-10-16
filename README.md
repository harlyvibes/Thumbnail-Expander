<img src="chrome-extension/icons/icon128.png" alt="" width="72" align="right">

# Thumbnail Expander

A Chrome extension for sites that play a preview when you hover a video thumbnail. It adds an expand button to the top-left corner of each thumbnail. Clicking it blows that hover preview up to fill the browser window. Nothing new is loaded, so it never opens the video's page.

Comes with rules for YouTube and Dailymotion. Other sites can be added from the toolbar popup or the settings page.

## Install (unpacked)

1. Download this repository (**Code** > **Download ZIP**) and unzip it, or clone it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `chrome-extension` folder inside it.
5. Pin the extension from Chrome's puzzle-piece menu so its icon stays in the toolbar.

## Usage

1. Hover a thumbnail until the site starts its preview.
2. Click the expand button in the thumbnail's top-left corner. The preview fills the window, exactly as the site plays it.
3. Press **Esc** or the close button to put it back.

While it's enlarged, clicks on the preview are blocked, so they can't open the video. If you click expand before the preview starts, it waits a few seconds for it.

## How it works

The extension doesn't copy or reload the preview. It restyles the site's own preview element to cover the window, and undoes anything that would keep it boxed in, such as transforms on the thumbnail card. The preview stays inside the thumbnail in the page, so the site still sees the mouse over the thumbnail and keeps playing it. Links around it are disabled until you close it. Closing puts every change back.

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
- **Pick thumbnail**: point at a thumbnail and click to save its selector. **↑**/**↓** move to the parent/child element, and **Esc** cancels.

Common problems:

- **No expand buttons**: the thumbnail selector matches nothing. Turn on debug mode to see the outlines, or use **Pick thumbnail**.
- **"No preview is playing in this thumbnail"**: hover until the site starts its preview, then click expand. If the preview is playing and it still says this, set the preview selector with **Alt+Shift+P**.
- **The wrong thing gets enlarged**: set the preview selector with **Alt+Shift+P** over the actual preview.
- **"Reload the page and try again"** in the popup: the page was open before the extension was installed or reloaded.

## Notes

- The site has to play previews on hover; this enlarges that preview. It plays exactly as the site plays it, including whether it's muted.
- The extension runs on all sites (`<all_urls>`) because you can add rules for any domain. It does nothing on a page unless a rule matches the domain.
- Settings are stored with `chrome.storage.sync`, so they follow your Chrome profile. Settings saved by older versions are upgraded automatically. Only the thumbnail selectors carry over from the old page and embed modes.
- The icons are generated by `tools/make_icons.py` (requires Pillow). Run `python tools/make_icons.py` from the repository root to regenerate them.
