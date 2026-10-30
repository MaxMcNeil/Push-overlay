#!/usr/bin/env python3
"""Supprime la musique de fond de la vidéo déposée (risque de droits d'auteur), AVANT tout le reste du montage.

Usage : remove-music.py <vidéo> [dossier de travail]
1. Sépare la voix du reste avec Demucs (modèle htdemucs, gratuit, sur le processeur du runner GitHub).
2. Cherche de la musique dans la partie « sans voix », seconde par seconde : il suffit d'UNE seconde où cette partie
   sort nettement du bruit de fond de la pièce pour considérer qu'il y a de la musique.
3. S'il y en a : la piste son de la vidéo est remplacée, sur TOUTE la durée, par la voix seule (même synchro, même
   durée ; l'image n'est pas réencodée). Sinon : le son d'origine est gardé tel quel (meilleure qualité).
Écrit content/music.json (résultat, secondes concernées) et affiche un résumé dans le journal.
Code de sortie 0 dans tous les cas où la vidéo reste utilisable ; un échec est signalé par ::warning::."""
import json
import os
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
WIN = 1.0          # fenêtre d'analyse : 1 seconde
ABS_MIN = -50.0    # en dessous (dBFS), la partie « sans voix » est inaudible : pas de musique
ABOVE_FLOOR = 10.0 # au-dessus du bruit de fond de la pièce (dB) : quelque chose d'audible qui n'est pas la voix


def run(cmd, **kw):
    print("+", " ".join(str(c) for c in cmd)[:300], flush=True)
    return subprocess.run([str(c) for c in cmd], check=True, **kw)


def read_wav(p: Path) -> np.ndarray:
    with wave.open(str(p), "rb") as w:
        n, ch, sw = w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        x = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"format WAV inattendu ({sw} octets)")
    return x.reshape(-1, ch).mean(axis=1)


def db_per_window(x: np.ndarray) -> np.ndarray:
    n = int(SR * WIN)
    k = len(x) // n
    if k == 0:
        return np.array([-120.0])
    r = np.sqrt(np.mean(x[:k * n].reshape(k, n) ** 2, axis=1) + 1e-12)
    return 20 * np.log10(r + 1e-9)


def main() -> int:
    video = Path(sys.argv[1])
    work = Path(sys.argv[2] if len(sys.argv) > 2 else "work-music")
    work.mkdir(parents=True, exist_ok=True)
    Path("content").mkdir(exist_ok=True)
    report = {"checked": False, "music": False, "seconds": [], "replaced": False}
    has_audio = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                                "-of", "csv=p=0", str(video)], capture_output=True, text=True).stdout.strip()
    if not has_audio:
        print("Pas de son dans la vidéo : rien à vérifier.")
        Path("content/music.json").write_text(json.dumps(report), encoding="utf-8")
        return 0
    wav = work / "audio.wav"
    run(["ffmpeg", "-y", "-v", "error", "-i", video, "-vn", "-ac", "2", "-ar", SR, "-c:a", "pcm_s16le", wav])
    # 1) séparation voix / reste (Demucs). --segment : mémoire raisonnable ; -j : tous les cœurs du runner.
    jobs = max(1, min(4, os.cpu_count() or 2))
    run([sys.executable, "-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs", "--segment", "7", "-j", jobs,
         "-o", work / "sep", wav])
    d = work / "sep" / "htdemucs" / "audio"
    voc, acc = d / "vocals.wav", d / "no_vocals.wav"
    if not voc.exists() or not acc.exists():
        raise RuntimeError("Demucs n'a pas produit les pistes séparées")
    # 2) détection : une seule seconde suffit
    a = db_per_window(read_wav(acc))
    floor = float(np.percentile(a, 10))
    thr = max(ABS_MIN, floor + ABOVE_FLOOR)
    hits = [int(i) for i in np.where(a >= thr)[0]]
    report.update(checked=True, music=bool(hits), seconds=hits[:500], floor_db=round(floor, 1), thr_db=round(thr, 1))
    if not hits:
        print(f"✔ Aucune musique de fond détectée (partie sans voix ≤ {thr:.0f} dBFS partout) : son d'origine gardé.")
        Path("content/music.json").write_text(json.dumps(report), encoding="utf-8")
        return 0

    def mmss(s):
        return f"{s // 60}:{s % 60:02d}"
    spans, start = [], hits[0]
    for p, q in zip(hits, hits[1:] + [None]):
        if q is None or q != p + 1:
            spans.append(f"{mmss(start)}→{mmss(p + 1)}")
            if q is not None:
                start = q
    print(f"♫ Musique / son de fond détecté pendant {len(hits)} s ({', '.join(spans[:12])}{' …' if len(spans) > 12 else ''})"
          " → le son de TOUTE la vidéo est remplacé par ta voix seule.")
    # 3) remplacement du son (image copiée telle quelle, même durée)
    out = video.with_name(video.stem + ".sans-musique" + video.suffix)
    acodec = ["-c:a", "libopus", "-b:a", "160k"] if video.suffix.lower() == ".webm" else ["-c:a", "aac", "-b:a", "192k"]
    run(["ffmpeg", "-y", "-v", "error", "-i", video, "-i", voc, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
         *acodec, "-ar", "48000", "-shortest", *(["-movflags", "+faststart"] if video.suffix.lower() in (".mp4", ".mov", ".m4v") else []), out])
    os.replace(out, video)
    report["replaced"] = True
    Path("content/music.json").write_text(json.dumps(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — la vidéo reste utilisable, mais on le signale très clairement
        print(f"::warning::Suppression de la musique de fond IMPOSSIBLE ({e}). La vidéo garde son son d'origine : "
              "vérifie-la avant de publier (risque de droits d'auteur s'il y a de la musique).")
        Path("content").mkdir(exist_ok=True)
        Path("content/music.json").write_text(json.dumps({"checked": False, "error": str(e)[:300]}), encoding="utf-8")
        sys.exit(0)
