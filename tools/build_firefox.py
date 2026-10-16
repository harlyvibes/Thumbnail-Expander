"""Builds the Firefox version of the extension from the Chrome one.

Usage: python tools/build_firefox.py
Replaces firefox-extension/ with a copy of chrome-extension/ and a Firefox manifest. The code is
shared (it uses Firefox's browser.* API when it's there), so only the manifest differs. Edit
chrome-extension/ and run this again; never edit firefox-extension/ directly.
"""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "chrome-extension"
OUT = ROOT / "firefox-extension"

# Firefox needs a fixed add-on ID for storage.sync. 140 is the first version that knows about
# data_collection_permissions (addons.mozilla.org requires it for signing), and is past what
# the extension needs: the Popover API (125) and :has() (121).
GECKO = {
    "id": "thumbnail-expander@harlyvibes",
    "strict_min_version": "140.0",
    "data_collection_permissions": {"required": ["none"]},
}


def main():
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf8"))
    manifest["browser_specific_settings"] = {"gecko": GECKO}

    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SRC, OUT)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    print(f"Built {OUT.relative_to(ROOT)} (version {manifest['version']})")


if __name__ == "__main__":
    main()
