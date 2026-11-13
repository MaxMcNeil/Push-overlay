#!/usr/bin/env bash
# Contrôle qualité AUTOMATIQUE de chaque vidéo produite (n'arrête jamais le run, écrit dans le journal et le résumé) :
# durée vs voix, image, volume (LUFS / crête), silences longs, images noires, images figées (> 6 s hors extraits).
set -uo pipefail
VOICE_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 input/voice.wav 2>/dev/null || echo 0)
for f in output/explainer-*.mp4; do
  [ -f "$f" ] || continue
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  vs=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 "$f")
  log=$(mktemp)
  ffmpeg -nostdin -hide_banner -i "$f" -map 0:v -vf "fps=4,scale=320:-2,blackdetect=d=1.5:pix_th=0.06,freezedetect=n=0.002:d=6" -f null - \
         -map 0:a -af "silencedetect=n=-45dB:d=2.5,ebur128=peak=true" -f null - 2> "$log" || true
  lufs=$(grep -E "^\s+I:" "$log" | tail -1 | awk '{print $2}')
  peak=$(grep -E "^\s+Peak:" "$log" | tail -1 | awk '{print $2}')
  blacks=$(grep -c "black_start" "$log"); freezes=$(grep -c "freeze_start" "$log"); sil=$(grep -c "silence_start" "$log")
  ok="✅"; notes=""
  awk -v a="$dur" -v b="$VOICE_DUR" 'BEGIN{exit !(a+0 < b+0 - 1)}' && { ok="⚠️"; notes+=" vidéo plus courte que la voix ;"; }
  awk -v l="${lufs:-0}" 'BEGIN{exit !(l < -17 || l > -11)}' && { ok="⚠️"; notes+=" volume hors cible ;"; }
  [ "$blacks" -gt 1 ] && { ok="⚠️"; notes+=" $blacks passage(s) noir(s) ;"; }
  [ "$sil" -gt 0 ] && notes+=" $sil silence(s) > 2,5 s ;"
  [ "$freezes" -gt 0 ] && notes+=" $freezes image(s) figée(s) > 6 s ;"
  line="$ok $(basename "$f") : ${dur%.*} s (voix ${VOICE_DUR%.*} s), ${vs}, ${lufs:-?} LUFS, crête ${peak:-?} dBFS.${notes}"
  echo "$line"; echo "- $line" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  grep -E "black_start|freeze_start|silence_start" "$log" | sed 's/^\[[^]]*\] */    /' | head -20
  rm -f "$log"
done
exit 0
