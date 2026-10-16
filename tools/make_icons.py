"""Generates the extension icons: a rounded gradient tile with expand corners around a play triangle.

Usage: python tools/make_icons.py
Writes chrome-extension/icons/icon{16,32,48,128}.png. Requires Pillow.
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "chrome-extension" / "icons"

S = 1024  # drawing resolution; each size is downscaled from this
TOP_LEFT = (99, 102, 241)  # indigo
BOTTOM_RIGHT = (168, 85, 247)  # violet
WHITE = (255, 255, 255, 255)

# Small sizes get thicker strokes and a larger play triangle so they stay legible.
STYLES = {
    "large": {"margin": 64, "radius": 230, "stroke": 64, "inset": 210, "arm": 150, "play": 150},
    "small": {"margin": 0, "radius": 230, "stroke": 104, "inset": 150, "arm": 190, "play": 190},
}


def gradient_tile(margin, radius):
    # Diagonal gradient, built small and scaled up (smooth, and fast without numpy).
    n = 256
    grad = Image.new("RGB", (n, n))
    px = []
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            px.append(tuple(round(a + (b - a) * t) for a, b in zip(TOP_LEFT, BOTTOM_RIGHT)))
    grad.putdata(px)
    grad = grad.resize((S, S), Image.BILINEAR).convert("RGBA")

    # Soft highlight on the upper half for a bit of depth.
    shine = Image.new("L", (S, S), 0)
    ImageDraw.Draw(shine).ellipse((-S * 0.3, -S * 0.9, S * 1.3, S * 0.45), fill=46)
    shine = shine.filter(ImageFilter.GaussianBlur(S * 0.06))
    grad = Image.composite(Image.new("RGBA", (S, S), WHITE), grad, shine)

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((margin, margin, S - 1 - margin, S - 1 - margin), radius=radius, fill=255)
    tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)
    return tile


def glyph_mask(style):
    """White parts of the icon as a mask: four expand corners and a play triangle."""
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    w, inset, arm = style["stroke"], style["inset"], style["arm"]
    lo, hi = inset, S - 1 - inset

    def polyline(points):
        d.line(points, fill=255, width=w, joint="curve")
        for x, y in (points[0], points[-1]):  # round caps
            d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=255)

    polyline([(lo, lo + arm), (lo, lo), (lo + arm, lo)])
    polyline([(hi - arm, lo), (hi, lo), (hi, lo + arm)])
    polyline([(lo, hi - arm), (lo, hi), (lo + arm, hi)])
    polyline([(hi - arm, hi), (hi, hi), (hi, hi - arm)])

    # Play triangle, optically centred (nudged right). Rounded corners come from growing a smaller
    # triangle by r: fill it, stroke each edge 2r wide, and put an r circle on each corner.
    p, cx, cy = style["play"], S / 2 + style["play"] * 0.12, S / 2
    r = p * 0.18
    tri = [(cx - p * 0.75 + r, cy - p + r * 1.4), (cx + p - r * 1.2, cy), (cx - p * 0.75 + r, cy + p - r * 1.4)]
    d.polygon(tri, fill=255)
    for a, b in zip(tri, tri[1:] + tri[:1]):
        d.line([a, b], fill=255, width=round(r * 2))
    for x, y in tri:
        d.ellipse((x - r, y - r, x + r, y + r), fill=255)
    return m


def render(style):
    tile = gradient_tile(style["margin"], style["radius"])
    glyph = glyph_mask(style)

    # Soft shadow under the glyph, kept inside the tile.
    shadow = glyph.filter(ImageFilter.GaussianBlur(S * 0.02))
    shadow = ImageChops.offset(shadow, 0, round(S * 0.012)).point(lambda v: v * 0.35)
    shadow = ImageChops.multiply(shadow, tile.getchannel("A"))
    tile = Image.composite(Image.new("RGBA", (S, S), (30, 20, 80, 255)), tile, shadow)

    tile.paste(Image.new("RGBA", (S, S), WHITE), (0, 0), glyph)
    return tile


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    large, small = render(STYLES["large"]), render(STYLES["small"])
    for size, img in ((16, small), (32, small), (48, large), (128, large)):
        img.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
        print("wrote", OUT / f"icon{size}.png")


if __name__ == "__main__":
    main()
