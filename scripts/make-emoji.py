#!/usr/bin/env python3
"""Rend chaque emoji du plan en PNG transparent (assets/emoji/<hex>.png).
libass ne sait pas afficher les emojis couleur : on les incruste donc en image.
Usage : python3 scripts/make-emoji.py content/plan.json"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf",
]
plan = json.load(open(sys.argv[1], encoding="utf-8"))
emojis = {b.get("emoji", "") for b in plan["beats"]} | {plan.get("hookEmoji", "")}
emojis.discard("")
font_path = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)
if not font_path:
    print("NotoColorEmoji introuvable : pas d'emojis incrustés (le montage continue).")
    sys.exit(0)
font = ImageFont.truetype(font_path, 109)
os.makedirs("assets/emoji", exist_ok=True)
for e in emojis:
    hexname = "-".join(f"{ord(c):x}" for c in e)
    img = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((80, 80), e, font=font, embedded_color=True, anchor="mm")
    bbox = img.getbbox()
    if not bbox:
        continue
    img = img.crop(bbox)
    side = max(img.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    sq.resize((256, 256), Image.LANCZOS).save(f"assets/emoji/{hexname}.png")
    print("emoji", e, "->", hexname)
