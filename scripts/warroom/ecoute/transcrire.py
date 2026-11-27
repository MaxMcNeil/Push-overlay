# War Room — 📻 Radios et émissions, étape 2 : une machine écoute son lot d'épisodes (début de chaque épisode, 40 min max)
# et le transcrit en local avec faster-whisper (gratuit, sans clé, sans quota). Un épisode qui échoue est sauté.
# Usage : python transcrire.py plan.json <n° de lot> <dossier de sortie>
import json, os, subprocess, sys, tempfile, time

import numpy as np

plan, lot, sortie = sys.argv[1], int(sys.argv[2]), sys.argv[3]
os.makedirs(sortie, exist_ok=True)
eps = json.load(open(plan, encoding="utf-8"))["lots"][lot]
MODELE = os.environ.get("ECOUTE_MODELE", "small")
# l'arabe (et toute langue hors fr/en) est mal transcrit par « small » : modèle bien meilleur pour ces émissions-là seulement
MODELE_AUTRE = os.environ.get("ECOUTE_MODELE_AR", "large-v3-turbo")

from faster_whisper import WhisperModel  # noqa: E402
t0 = time.time()
_modeles = {}


def modele(langue):
    nom = MODELE if (langue or "fr") in ("fr", "en") else MODELE_AUTRE
    if nom not in _modeles:
        t = time.time()
        try:
            _modeles[nom] = WhisperModel(nom, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
            print(f"modèle {nom} chargé en {time.time() - t:.0f} s", flush=True)
        except Exception as x:  # noqa: BLE001
            print(f"  ⚠ modèle {nom} indisponible ({str(x)[:120]}) → modèle {MODELE} à la place", flush=True)
            _modeles[nom] = modele("fr") if nom != MODELE else None
    return _modeles[nom]


def propres(segs):
    """Retire ce que Whisper invente sur la musique ou le silence : phrases répétées en boucle, segments incompréhensibles."""
    out, faux = [], 0
    for s in segs:
        t = s.text.strip()
        if not t:
            continue
        if s.compression_ratio > 2.4 or s.avg_logprob < -1.0 or (s.no_speech_prob > 0.6 and s.avg_logprob < -0.6):
            faux += 1
            continue
        if len(out) >= 2 and out[-1][1] == t and out[-2][1] == t:
            faux += 1
            continue
        out.append([round(s.start), t])
    return out, faux


for k, e in enumerate(eps):
    nom = f"{lot:02d}-{k:02d}"
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "a.raw")
        t1 = time.time()
        # ffmpeg lit le flux et s'arrête tout seul après la durée voulue : jamais le fichier entier
        try:
            r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-user_agent", "Mozilla/5.0", "-reconnect", "1", "-reconnect_delay_max", "5", "-rw_timeout", "20000000",
                                "-t", str(int(e["ecoute"] * 60)), "-i", e["audio"], "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", wav], capture_output=True, text=True, timeout=int(e["ecoute"] * 60) + 240)
        except subprocess.TimeoutExpired:  # flux qui traîne : on garde ce qui a déjà été enregistré
            r = None
        except Exception as x:  # noqa: BLE001
            print(f"  ✗ {e['nom']} : audio injoignable ({x})", flush=True)
            continue
        if not os.path.exists(wav) or os.path.getsize(wav) < 320000 or (r is not None and r.returncode and os.path.getsize(wav) < 320000 * 30):
            print(f"  ✗ {e['nom']} : audio illisible ({((r.stderr if r else 'délai dépassé') or '').strip()[:160]})", flush=True)
            continue
        t2 = time.time()
        try:
            # audio passé directement en tableau (jamais décodé par PyAV, dont les versions récentes cassent faster-whisper)
            audio = np.frombuffer(open(wav, "rb").read(), dtype=np.int16).astype(np.float32) / 32768.0
            model = modele(e.get("langue"))
            segs, info = model.transcribe(audio, language=e.get("langue") or None, vad_filter=True, beam_size=1, condition_on_previous_text=False)
            segments, faux = propres(segs)
            if faux:
                print(f"    {faux} segment(s) douteux écarté(s) (répétitions ou passages incompréhensibles)", flush=True)
        except Exception as x:  # noqa: BLE001
            print(f"  ✗ {e['nom']} : transcription impossible ({x})", flush=True)
            continue
        dur = segments[-1][0] / 60 if segments else 0
        print(f"  ✓ {e['nom']} — « {e['titre'][:70]} » : {len(segments)} segments, ≈ {dur:.0f} min transcrites "
              f"(téléchargement {t2 - t1:.0f} s, transcription {time.time() - t2:.0f} s)", flush=True)
        json.dump({**e, "segments": segments}, open(os.path.join(sortie, f"{nom}.json"), "w", encoding="utf-8"), ensure_ascii=False)
print(f"lot {lot} terminé en {time.time() - t0:.0f} s", flush=True)
