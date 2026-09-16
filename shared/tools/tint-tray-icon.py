#!/usr/bin/env python3
"""tint-tray-icon.py <src.png> <dst.png> <hue-source.png|#rrggbb>

The system tray icon Claude Desktop ships is monochrome — white on a dark theme, black on a light
one — so several profiles running at once are indistinguishable in the tray. This tints the glyph
with a profile's colour while keeping its shape and alpha, so the tray says which account it is.

The hue is read from that profile's application icon, so tray and launcher always agree.
"""
import sys
import colorsys

try:
    from PIL import Image
except ImportError:
    print("tint-tray-icon: Pillow not installed, leaving the icon untouched", file=sys.stderr)
    sys.exit(3)


def dominant_hue(path: str) -> float:
    """The hue of the most common saturated colour in an image — the icon's background."""
    im = Image.open(path).convert("RGBA")
    best, count = None, 0
    tally: dict[int, int] = {}
    for r, g, b, a in im.getdata():
        if a < 200:
            continue
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s < 0.25 or v < 0.2:
            continue
        key = int(h * 360)
        tally[key] = tally.get(key, 0) + 1
        if tally[key] > count:
            best, count = key, tally[key]
    if best is None:
        raise SystemExit("tint-tray-icon: no saturated colour found in the hue source")
    return best / 360.0


def main() -> int:
    src, dst, hue_src = sys.argv[1], sys.argv[2], sys.argv[3]
    if hue_src.startswith("#"):
        r, g, b = (int(hue_src[i:i + 2], 16) for i in (1, 3, 5))
        hue, sat = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[:2]
    else:
        hue, sat = dominant_hue(hue_src), 0.75

    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            # The glyph is flat black or flat white; only its alpha carries the shape. Keep the
            # alpha, and give every visible pixel the profile's colour at a fixed brightness that
            # reads on both a light and a dark panel.
            nr, ng, nb = colorsys.hsv_to_rgb(hue, sat, 0.95)
            px[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255), a)
    im.save(dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
