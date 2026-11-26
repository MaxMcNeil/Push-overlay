# War Room — 📻 Radios et émissions, étape 2 : une machine écoute son lot d'épisodes (début de chaque épisode, 40 min max)
# et le transcrit en local avec faster-whisper (gratuit, sans clé, sans quota). Un épisode qui échoue est sauté.
# Usage : python transcrire.py plan.json <n° de lot> <dossier de sortie>
import json, os, subprocess, sys, tempfile, time

plan, lot, sortie = sys.argv[1], int(sys.argv[2]), sys.argv[3]
os.makedirs(sortie, exist_ok=True)
eps = json.load(open(plan, encoding="utf-8"))["lots"][lot]
MODELE = os.environ.get("ECOUTE_MODELE", "small")

from faster_whisper import WhisperModel  # noqa: E402
t0 = time.time()
model = WhisperModel(MODELE, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
print(f"modèle {MODELE} chargé en {time.time() - t0:.0f} s", flush=True)

for k, e in enumerate(eps):
    nom = f"{lot:02d}-{k:02d}"
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "a.wav")
        t1 = time.time()
        # ffmpeg lit le flux et s'arrête tout seul après la durée voulue : jamais le fichier entier
        r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-user_agent", "Mozilla/5.0", "-reconnect", "1", "-reconnect_delay_max", "5",
                            "-t", str(int(e["ecoute"] * 60)), "-i", e["audio"], "-vn", "-ac", "1", "-ar", "16000", wav], capture_output=True, text=True, timeout=900)
        if r.returncode or not os.path.exists(wav) or os.path.getsize(wav) < 100000:
            print(f"  ✗ {e['nom']} : audio illisible ({(r.stderr or '').strip()[:160]})", flush=True)
            continue
        t2 = time.time()
        try:
            segs, info = model.transcribe(wav, language=e.get("langue") or None, vad_filter=True, beam_size=1, condition_on_previous_text=False)
            segments = [[round(s.start), s.text.strip()] for s in segs if s.text.strip()]
        except Exception as x:  # noqa: BLE001
            print(f"  ✗ {e['nom']} : transcription impossible ({x})", flush=True)
            continue
        dur = segments[-1][0] / 60 if segments else 0
        print(f"  ✓ {e['nom']} — « {e['titre'][:70]} » : {len(segments)} segments, ≈ {dur:.0f} min transcrites "
              f"(téléchargement {t2 - t1:.0f} s, transcription {time.time() - t2:.0f} s)", flush=True)
        json.dump({**e, "segments": segments}, open(os.path.join(sortie, f"{nom}.json"), "w", encoding="utf-8"), ensure_ascii=False)
print(f"lot {lot} terminé en {time.time() - t0:.0f} s", flush=True)
