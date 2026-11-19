#!/usr/bin/env bash
# Émission radio : retire la MUSIQUE DE FOND des audios des auditeurs (Demucs, IA libre et gratuite, sur le serveur GitHub).
# input/radio/clips/NN-nom.ext (tous, ou ceux passés en arguments) → input/radio/voix-seules/NN-nom.wav (même durée, mêmes horaires).
# Jamais bloquant : si la séparation échoue pour un audio, son original est utilisé (avertissement dans le journal).
set -uo pipefail
warn() { echo "::warning::$*"; }
mkdir -p input/radio/voix-seules
shopt -s nullglob
if [ $# -gt 0 ]; then F=("$@"); else F=(input/radio/clips/*); fi
[ ${#F[@]} -gt 0 ] || exit 0
if ! python3 -c "import demucs" 2>/dev/null; then
  echo "Installation de Demucs (séparation voix / musique)…"
  { pip install -q --break-system-packages torch==2.4.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install -q --break-system-packages demucs==4.0.1 soundfile; } \
    || { warn "Demucs n'a pas pu s'installer : musique de fond gardée"; exit 0; }
fi
IN=$(mktemp -d); OUT=$(mktemp -d)
for f in "${F[@]}"; do
  n=$(basename "${f%.*}")
  ffmpeg -v error -y -i "$f" -vn -ac 2 -ar 44100 "$IN/$n.wav" || warn "« $(basename "$f") » illisible pour la séparation"
done
python3 -m demucs.separate --two-stems=vocals -n htdemucs -d cpu -j "$(nproc)" -o "$OUT" "$IN"/*.wav \
  || warn "Séparation voix / musique en échec : audios d'origine gardés pour ce qui n'a pas été séparé"
ok=0
for f in "${F[@]}"; do
  n=$(basename "${f%.*}"); v="$OUT/htdemucs/$n/vocals.wav"
  if [ -s "$v" ]; then
    d0=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN/$n.wav"); d1=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$v")
    if awk -v a="$d0" -v b="$d1" 'BEGIN{exit !((a-b)<0.3 && (b-a)<0.3)}'; then
      ffmpeg -v error -y -i "$v" -ac 1 -ar 48000 -c:a pcm_s16le "input/radio/voix-seules/$n.wav" && ok=$((ok + 1)) && echo "  musique retirée : $(basename "$f")"
      continue
    fi
  fi
  warn "« $(basename "$f") » : musique non retirée (audio d'origine utilisé)"
done
echo "Voix seules : $ok/${#F[@]} audio(s)"
rm -rf "$IN" "$OUT"
