#!/data/data/com.termux/files/usr/bin/bash
# War Room — agent d'écoute YouTube sur le TÉLÉPHONE (Termux), lancé tout seul toutes les 6 h par Android.
# YouTube bloque les machines de GitHub, pas ton téléphone : il prend le son des 45 premières minutes des nouvelles vidéos des
# chaînes de chaines.txt (relue à chaque passage depuis le dépôt), le dépose sur une release temporaire du dépôt, puis l'efface du
# téléphone. La War Room (Radios = oui) le transcrit, puis supprime définitivement les fichiers et la release.
# Il ne touche à rien d'autre : ni à tes workflows, ni à tes releases, ni à tes fichiers.
set -u
REPO="MaxMcNeil/Push-overlay"
TAG="out-ecoute-telephone"
D="$HOME/.ecoute"
mkdir -p "$D/tmp"
J="$D/journal.txt"
VUS="$D/vus.txt"; touch "$VUS"
MAX_PAR_PASSAGE=12
log() { echo "$(date '+%d/%m %H:%M') $*" >> "$J"; }

# un seul passage à la fois (un verrou de plus de 3 h est considéré comme abandonné)
if ! mkdir "$D/verrou" 2>/dev/null; then
  [ -n "$(find "$D/verrou" -maxdepth 0 -mmin +180 2>/dev/null)" ] && rm -rf "$D/verrou" && mkdir "$D/verrou" || exit 0
fi
command -v termux-wake-lock >/dev/null && termux-wake-lock
trap 'rm -rf "$D/verrou" "$D/tmp"/*; command -v termux-wake-unlock >/dev/null && termux-wake-unlock' EXIT

: > "$J"
log "passage de l'agent d'écoute"
# yt-dlp à jour une fois par jour (YouTube change souvent ses protections)
if [ -z "$(find "$D/maj" -mtime -1 2>/dev/null)" ]; then
  pip install -q -U "yt-dlp[default]" >/dev/null 2>&1 && touch "$D/maj" && log "yt-dlp mis à jour : $(yt-dlp --version)"
fi
gh auth status >/dev/null 2>&1 || { log "✗ gh n'est pas connecté à GitHub : rien n'est envoyé"; exit 0; }

LISTE=$(curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/warroom/telephone/chaines.txt" 2>/dev/null \
  || curl -fsSL "https://raw.githubusercontent.com/$REPO/radios/scripts/warroom/telephone/chaines.txt" 2>/dev/null)
[ -n "$LISTE" ] || { log "✗ liste des chaînes injoignable (pas de réseau ?)"; exit 0; }

gh release view "$TAG" -R "$REPO" >/dev/null 2>&1 || gh release create "$TAG" -R "$REPO" --prerelease \
  --title "Écoute téléphone (temporaire)" --notes "Sons déposés par l'agent d'écoute du téléphone. Supprimés automatiquement par la War Room après usage." >/dev/null 2>&1
# « passage en cours » : la War Room ne supprime jamais la release pendant que le téléphone y dépose des sons
date > "$D/en-cours.txt"; gh release upload "$TAG" "$D/en-cours.txt" -R "$REPO" --clobber >/dev/null 2>&1 || true

YT="yt-dlp --no-warnings --js-runtimes node --socket-timeout 30"
n=0
while IFS='|' read -r langue nom url; do
  langue=$(echo "$langue" | xargs); nom=$(echo "$nom" | xargs); url=$(echo "$url" | xargs)
  case "$langue" in fr|en|ar) ;; *) continue ;; esac
  [ "$n" -ge "$MAX_PAR_PASSAGE" ] && { log "plafond de $MAX_PAR_PASSAGE vidéos atteint pour ce passage"; break; }
  ids=$($YT --flat-playlist --playlist-end 3 --print "%(id)s" "$url/videos" 2>/dev/null)
  [ -n "$ids" ] || { log "✗ $nom : chaîne introuvable ou YouTube refuse ($url)"; continue; }
  for id in $ids; do
    grep -qx "$id" "$VUS" && continue
    meta=$($YT -j --skip-download "https://www.youtube.com/watch?v=$id" 2>/dev/null) || { log "✗ $nom : vidéo $id illisible"; continue; }
    statut=$(echo "$meta" | jq -r '.live_status // "not_live"')
    [ "$statut" = "is_upcoming" ] || [ "$statut" = "is_live" ] && continue          # direct pas encore fini : repris au prochain passage
    duree=$(echo "$meta" | jq -r '(.duration // 0) | floor')
    date=$(echo "$meta" | jq -r 'if .timestamp then (.timestamp | todate) else (.upload_date // "" | if length == 8 then "\(.[0:4])-\(.[4:6])-\(.[6:8])T12:00:00Z" else "" end) end')
    age=$(( ( $(date +%s) - $(date -d "$date" +%s 2>/dev/null || echo 0) ) / 3600 ))
    if [ -z "$date" ] || [ "$age" -gt 72 ] || [ "$duree" -lt 240 ]; then echo "$id" >> "$VUS"; continue; fi   # trop ancienne ou trop courte
    $YT -f "139/249/250/140/bestaudio" --download-sections "*0-2700" -o "$D/tmp/yt-$id.%(ext)s" "https://www.youtube.com/watch?v=$id" >/dev/null 2>&1
    f=$(ls "$D/tmp/yt-$id".* 2>/dev/null | head -1)
    [ -s "$f" ] || { log "✗ $nom : téléchargement refusé ($id)"; continue; }
    minutes=$(( duree > 2700 ? 45 : duree / 60 ))
    echo "$meta" | jq --arg nom "$nom" --arg langue "$langue" --arg date "$date" --arg m "$minutes" --arg f "$(basename "$f")" \
      '{nom: $nom, media: ($nom + " (YouTube)"), langue: $langue, titre: (.title // ""), date: $date, lien: (.webpage_url // ""), minutes: ($m | tonumber), fichier: $f}' > "$D/tmp/yt-$id.json"
    if gh release upload "$TAG" "$f" "$D/tmp/yt-$id.json" -R "$REPO" --clobber >/dev/null 2>&1; then
      echo "$id" >> "$VUS"; n=$((n + 1))
      log "✓ $nom : « $(echo "$meta" | jq -r '.title' | cut -c1-80) » ($minutes min, $(du -k "$f" | cut -f1) Ko)"
    else
      log "✗ $nom : envoi vers GitHub impossible (réessayé au prochain passage)"
    fi
    rm -f "$f" "$D/tmp/yt-$id.json"
    break        # une vidéo par chaîne et par passage : la plus récente
  done
done <<< "$LISTE"

tail -n 3000 "$VUS" > "$VUS.n" && mv "$VUS.n" "$VUS"
log "fin du passage : $n vidéo(s) envoyée(s)"
gh release upload "$TAG" "$J" -R "$REPO" --clobber >/dev/null 2>&1 || true
gh release delete-asset "$TAG" en-cours.txt -R "$REPO" -y >/dev/null 2>&1 || true
