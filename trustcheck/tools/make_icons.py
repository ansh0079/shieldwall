#!/usr/bin/env python3
# Generates the extension icons (a shield with a check mark) at 16/32/48/128 px.
# Deterministic: run `python3 tools/make_icons.py` from trustcheck/ to regenerate icons/.
from PIL import Image, ImageDraw
import os

S = 512  # supersample, then downscale for clean edges

def shield_pts(cx, cy, w, h):
    """Symmetric shield outline centred on (cx, cy): gently curved top, sides easing into a rounded bottom point."""
    pts = []
    n = 160
    for i in range(n + 1):                     # right half, top to bottom point
        a = i / n
        x = (1 - a ** 2.2) ** 0.62             # width factor: 1 at top -> 0 at the point
        y = -0.5 + a                           # -0.5 (top) -> 0.5 (bottom)
        top_dip = 0.045 * (1 - abs(x))         # slight dip in the middle of the top edge
        pts.append((cx + x * w / 2, cy + (y + (top_dip if a < 0.05 else 0)) * h))
    for i in range(n, -1, -1):                 # mirrored left half
        a = i / n
        x = (1 - a ** 2.2) ** 0.62
        y = -0.5 + a
        top_dip = 0.045 * (1 - abs(x))
        pts.append((cx - x * w / 2, cy + (y + (top_dip if a < 0.05 else 0)) * h))
    return pts

def make():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon(shield_pts(S / 2, S / 2, 0.86 * S, 0.94 * S), fill=(30, 64, 135, 255))   # rim #1e4087
    d.polygon(shield_pts(S / 2, S / 2 - 0.004 * S, 0.76 * S, 0.84 * S), fill=(37, 99, 235, 255))  # face #2563eb
    lw = int(S * 0.115)                        # check mark
    a, b, c = (0.30 * S, 0.50 * S), (0.45 * S, 0.645 * S), (0.72 * S, 0.33 * S)
    d.line([a, b], fill=(255, 255, 255, 255), width=lw)
    d.line([b, c], fill=(255, 255, 255, 255), width=lw)
    for p in (a, b, c):
        r = lw / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(255, 255, 255, 255))
    return img

os.makedirs("icons", exist_ok=True)
base = make()
for size in (16, 32, 48, 128):
    base.resize((size, size), Image.LANCZOS).save(f"icons/icon{size}.png")
print("wrote icons/icon{16,32,48,128}.png")
