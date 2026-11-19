#!/usr/bin/env bash
# Émission radio — UNE machine de préparation (plusieurs tournent en parallèle) : les audios de son groupe
# (input/radio/groupes.json, n° GROUPE) → musique retirée (si demandé) → transcription (étape 1).
# Résultat dans prep-out/ : voix-seules/*.opus (légères, réutilisées à l'étape 2) et transcripts/*.json.
set -uo pipefail
G="${GROUPE:?}"
mapfile -t NOMS < <(node -e 'const g = require("./input/radio/groupes.json")[Number(process.argv[1]) - 1] || []; for (const f of g) console.log(f)' "$G")
[ ${#NOMS[@]} -gt 0 ] || { echo "Groupe $G vide"; exit 0; }
FILES=(); for n in "${NOMS[@]}"; do FILES+=("input/radio/clips/$n"); done
echo "Machine $G : ${#FILES[@]} audio(s)"
[ "${MUSIQUE:-retirer}" = garder ] || bash scripts/radio/sans_musique.sh "${FILES[@]}"
mkdir -p prep-out/voix-seules prep-out/transcripts
RC=0
if [ "${ETAPE:-analyse}" = analyse ]; then
  # ce qui est transcrit est gardé même si un audio échoue (le reste sera refait par l'étape d'écriture)
  node scripts/radio/emission.mjs transcrire "${NOMS[@]}" || { echo "::warning::Transcription incomplète (machine $G) : le reste sera fait à l'écriture"; RC=1; }
  cp input/radio/transcripts/*.json prep-out/transcripts/ 2>/dev/null || true
fi
shopt -s nullglob
for w in input/radio/voix-seules/*.wav; do
  ffmpeg -v error -y -i "$w" -c:a libopus -b:a 48k -ac 1 "prep-out/voix-seules/$(basename "${w%.wav}").opus" || echo "::warning::$(basename "$w") : compression impossible"
done
echo "Machine $G : $(ls prep-out/voix-seules | wc -l) voix sans musique, $(ls prep-out/transcripts | wc -l) transcription(s)"
exit $RC
