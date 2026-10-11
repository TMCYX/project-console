#!/usr/bin/env python3
"""Generate the Project Console app icon.

Swiss-industrial Gantt mark: cold-paper tile, near-black ink bars, a single
vermilion accent bar. Draws supersampled (4x) then downsamples for clean edges.
Writes assets/icon.png (256) and assets/icon.ico (multi-size).
"""
import os
from PIL import Image, ImageDraw

BASE = 256
SS = 4
S = BASE * SS

PAPER = (243, 241, 236, 255)
INK = (23, 22, 15, 255)
MUTED = (122, 116, 106, 255)
VERM = (220, 59, 30, 255)
BORDER = (23, 22, 15, 40)


def sc(v):
    return int(round(v * SS))


img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

inset = sc(6)
d.rounded_rectangle(
    [inset, inset, S - inset, S - inset],
    radius=sc(56), fill=PAPER, outline=BORDER, width=sc(2),
)


def bar(x0, y0, x1, y1, color, r=6):
    d.rounded_rectangle([sc(x0), sc(y0), sc(x1), sc(y1)], radius=sc(r), fill=color)


# Staggered Gantt bars: ink, vermilion (accent), ink, muted.
bar(44, 54, 150, 78, INK)
bar(70, 100, 210, 124, VERM)
bar(44, 146, 128, 170, INK)
bar(96, 192, 200, 216, MUTED)

icon = img.resize((BASE, BASE), Image.LANCZOS)

here = os.path.dirname(os.path.abspath(__file__))
png = os.path.join(here, "icon.png")
ico = os.path.join(here, "icon.ico")
icon.save(png)
icon.save(
    ico,
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("wrote", png)
print("wrote", ico, os.path.getsize(ico), "bytes")
