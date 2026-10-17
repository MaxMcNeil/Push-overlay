#!/usr/bin/env python3
"""Mesure les largeurs de glyphes d'une police pour caler précisément les retours à la ligne.
Usage : font-metrics.py <police.ttf> <fichier-texte>  ->  JSON {lf, adv:{caractère: largeur pour 1000 px}}"""
import json, sys
from PIL import ImageFont
font = ImageFont.truetype(sys.argv[1], 1000)
text = open(sys.argv[2], encoding="utf-8").read()
asc, desc = font.getmetrics()
adv = {}
for ch in set(text):
    if ch in "\r\n":
        continue
    try:
        adv[ch] = font.getlength(ch)
    except Exception:
        pass
print(json.dumps({"lf": (asc + desc) / 1000.0, "adv": adv}, ensure_ascii=False))
