#!/usr/bin/env python3
"""Repère où se trouve le visage dans une vidéo (pour ne JAMAIS écrire dessus).
Usage : face-box.py <vidéo> [nb_échantillons]  ->  JSON sur stdout :
  {"found": true, "x0":..,"y0":..,"x1":..,"y1":.., "cx":.., "cy":.., "ratio": part des images avec visage}
Coordonnées normalisées (0-1) dans l'image affichée. La zone couvre les déplacements du visage pendant la vidéo
(percentiles 10/90 des boîtes détectées) : c'est la zone à laisser libre.
Détecteur : OpenCV (Haar, de face + de profil) — léger, sans GPU, sans téléchargement de modèle.
Repère aussi les SOUS-TITRES DÉJÀ INCRUSTÉS (texte blanc cerné de noir, dans la moitié basse) : "captions":{y0,y1}
→ zone protégée elle aussi, et les sous-titres automatiques sont alors désactivés (sinon ils se doublent)."""
import json, sys

def caption_band(cv2, np, gray):
    """Bande de texte incrusté (blanc/jaune très clair entouré de contour sombre) dans les 55 % bas de l'image."""
    h, w = gray.shape
    top = int(h * 0.45)
    roi = gray[top:, :]
    bright = (roi > 215).astype(np.uint8)
    dark = cv2.dilate((roi < 70).astype(np.uint8), np.ones((5, 5), np.uint8))
    txt = bright & dark  # pixels clairs collés à un contour sombre = lettres sous-titrées
    rows = txt.sum(axis=1) / float(w)
    on = rows > 0.012
    best, cur = None, None
    for y, v in enumerate(on):
        if v and cur is None:
            cur = y
        if (not v or y == len(on) - 1) and cur is not None:
            end = y
            # tolère les interlignes : fusion si l'écart avec la bande précédente est petit
            if best and cur - best[1] < h * 0.03:
                best = (best[0], end)
            elif best is None or (end - cur) > (best[1] - best[0]):
                best = (cur, end) if best is None or (end - cur) > (best[1] - best[0]) else best
            cur = None
    if not best:
        return None
    y0, y1 = best
    hh = (y1 - y0) / h
    if hh < 0.025 or hh > 0.22:
        return None
    # le texte doit être étalé horizontalement (pas un objet blanc isolé)
    cols = txt[y0:y1, :].sum(axis=0) > 0
    xs = np.where(cols)[0]
    if len(xs) == 0 or (xs[-1] - xs[0]) < w * 0.25:
        return None
    return ((top + y0) / h, (top + y1) / h)


def main():
    path = sys.argv[1]
    samples = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    try:
        import cv2
    except Exception as e:
        print(json.dumps({"found": False, "error": f"opencv absent: {e}"}))
        return
    cap = cv2.VideoCapture(path)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if n <= 0:
        print(json.dumps({"found": False, "error": "vidéo illisible"}))
        return
    front = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    prof = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    idx = sorted({int(n * (k + 0.5) / samples) for k in range(samples)})
    boxes, seen, bands = [], 0, []
    import numpy as np
    for i in idx:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, fr = cap.read()
        if not ok or fr is None:
            continue
        seen += 1
        h, w = fr.shape[:2]
        sc = 480.0 / max(w, h)
        small = cv2.resize(fr, (int(w * sc), int(h * sc))) if sc < 1 else fr
        sh, sw = small.shape[:2]
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        b = caption_band(cv2, np, gray)
        if b:
            bands.append(b)
        g = cv2.equalizeHist(gray)
        mn = int(min(sw, sh) * 0.08)
        found = list(front.detectMultiScale(g, 1.1, 6, minSize=(mn, mn)))
        if not found:
            found = list(prof.detectMultiScale(g, 1.1, 6, minSize=(mn, mn)))
        if not found:
            continue
        x, y, bw, bh = max(found, key=lambda b: b[2] * b[3])  # le plus grand visage = le locuteur
        boxes.append((x / sw, y / sh, (x + bw) / sw, (y + bh) / sh))
    def pct(vals, p):
        v = sorted(vals)
        return v[min(len(v) - 1, max(0, int(round(p * (len(v) - 1)))))]
    caps = None
    if len(bands) >= max(3, seen * 0.35):
        c0, c1 = pct([b[0] for b in bands], 0.1), pct([b[1] for b in bands], 0.9)
        if c1 - c0 < 0.3:
            caps = {"y0": round(max(0, c0 - 0.015), 3), "y1": round(min(1, c1 + 0.015), 3), "ratio": round(len(bands) / max(1, seen), 2)}
    if not boxes or len(boxes) < max(2, seen * 0.15):
        print(json.dumps({"found": False, "ratio": round(len(boxes) / max(1, seen), 2), "captions": caps}))
        return
    x0 = pct([b[0] for b in boxes], 0.1); y0 = pct([b[1] for b in boxes], 0.1)
    x1 = pct([b[2] for b in boxes], 0.9); y1 = pct([b[3] for b in boxes], 0.9)
    # la boîte Haar s'arrête aux sourcils et au menton : on ajoute cheveux et cou
    hgt = y1 - y0
    y0 = max(0.0, y0 - hgt * 0.35); y1 = min(1.0, y1 + hgt * 0.25)
    wid = x1 - x0
    x0 = max(0.0, x0 - wid * 0.12); x1 = min(1.0, x1 + wid * 0.12)
    cx = pct([(b[0] + b[2]) / 2 for b in boxes], 0.5); cy = pct([(b[1] + b[3]) / 2 for b in boxes], 0.5)
    print(json.dumps({"found": True, "x0": round(x0, 3), "y0": round(y0, 3), "x1": round(x1, 3), "y1": round(y1, 3),
                      "cx": round(cx, 3), "cy": round(cy, 3), "ratio": round(len(boxes) / max(1, seen), 2), "captions": caps}))

main()
