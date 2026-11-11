#!/usr/bin/env bash
# Récupère le fichier VOIX (et les photos éventuelles) pour « Voice to Explainer ».
#   SOURCE = tag de release, lien Google Drive, lien direct, ou vide (= dernière release dont le tag commence par voix/voice/audio)
#   PHOTOS = tag d'une release de captures / photos / vidéos (facultatif ; celles jointes à la release de la voix sont aussi prises)
# Produit : input/voice.wav (mono 48 kHz, vérifié), input/video.mp4 (même son + image noire : pour scripts/transcribe.mjs),
#           input/photos/NN.jpg (≤ 2160 px, orientation corrigée), input/clips/NN-nom.mp4 (vidéos à monter).
#           Écrit tag=, photos_tag=, voice_name=, photos=, clips=, medias= dans GITHUB_OUTPUT.
set -euo pipefail
out() { echo "$1=$2" >> "${GITHUB_OUTPUT:-/dev/null}"; }
die() { echo "::error::$*"; exit 1; }
AUDIO_RE='\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|wma|amr|3gp|mp4|mov|mkv|webm|m4v)$'
IMG_RE='\.(jpe?g|png|webp)$'
rm -rf input/raw input/photos input/clips input/voice.* input/video.*; mkdir -p input/raw input/photos

drive_id() { local u="$1"
  if [[ "$u" =~ /file/d/([A-Za-z0-9_-]{10,}) ]]; then echo "${BASH_REMATCH[1]}"
  elif [[ "$u" =~ [?\&]id=([A-Za-z0-9_-]{10,}) ]]; then echo "${BASH_REMATCH[1]}"; fi; }
from_drive() { local id; id=$(drive_id "$1")
  [ -n "$id" ] || die "Lien Google Drive non reconnu (attendu : https://drive.google.com/file/d/ID/view — le lien d'un FICHIER, pas d'un dossier)."
  if [ -n "${RCLONE_CONF:-}" ]; then
    command -v rclone >/dev/null || { curl -sSf https://rclone.org/install.sh | sudo bash >/dev/null; }
    mkdir -p ~/.config/rclone && printf '%s\n' "$RCLONE_CONF" > ~/.config/rclone/rclone.conf
    local remote; remote=$(grep -m1 -oE '^\[[^]]+\]' ~/.config/rclone/rclone.conf | tr -d '[]')
    rclone backend copyid "$remote:" "$id" input/raw/ --drive-acknowledge-abuse -q && return 0
    echo "::warning::rclone n'a pas pu lire le fichier : essai par lien public"
  fi
  pip install -q --break-system-packages gdown 2>/dev/null || pip install -q gdown
  (cd input/raw && gdown -q "https://drive.google.com/uc?id=$id") || die "Téléchargement Google Drive refusé : partage le fichier « Tous les utilisateurs disposant du lien → Lecteur »."
}
latest_voice_tag() { gh release list --repo "$REPO" --limit 60 --json tagName,createdAt -q 'sort_by(.createdAt)|reverse|.[].tagName' | grep -Ei '^(voix|voice|audio)' | head -n1 || true; }
from_release() { local tag="$1"
  gh release view "$tag" --repo "$REPO" >/dev/null 2>&1 || die "Release « $tag » introuvable. Vérifie le tag (Releases → le texte à côté de l'icône d'étiquette)."
  out tag "$tag"; SRC_TAG="$tag"
  local names; names=$(gh release view "$tag" --repo "$REPO" --json assets -q '.assets[].name')
  if grep -Eiq "$AUDIO_RE" <<<"$names"; then
    gh release download "$tag" --repo "$REPO" --dir input/raw --clobber
  else
    local link; link=$(gh release view "$tag" --repo "$REPO" --json body,name -q '.name+" "+.body' | grep -oE 'https?://(drive|docs)\.google\.com/[^ )>"]+' | head -n1 || true)
    [ -n "$link" ] || die "La release « $tag » ne contient ni fichier audio (mp3, m4a, wav, ogg, opus…) ni lien Google Drive."
    [ -n "$names" ] && gh release download "$tag" --repo "$REPO" --dir input/raw --clobber || true
    from_drive "$link"
  fi
}

SRC="$(echo "${SOURCE:-}" | xargs || true)"; SRC_TAG=""
if [ -z "$SRC" ]; then SRC=$(latest_voice_tag); [ -n "$SRC" ] || die "Aucune source : remplis le champ « source » (tag de release ou lien Google Drive), ou crée une release dont le tag commence par « voix »."; echo "Source automatique : release $SRC"; fi
case "$SRC" in
  *drive.google.com*|*docs.google.com*) from_drive "$SRC" ;;
  http://*|https://*) curl -sSL --fail --retry 3 --max-time 1800 -o "input/raw/voice-$(basename "${SRC%%\?*}")" "$SRC" || die "Téléchargement impossible : $SRC" ;;
  *) from_release "$SRC" ;;
esac

# photos d'une release séparée (facultatif)
PH="$(echo "${PHOTOS:-}" | xargs || true)"
if [ -n "$PH" ] && [ "$PH" != "$SRC_TAG" ]; then
  if gh release view "$PH" --repo "$REPO" >/dev/null 2>&1; then
    mkdir -p input/raw/ph && gh release download "$PH" --repo "$REPO" --dir input/raw/ph --clobber || true; out photos_tag "$PH"
  else echo "::warning::Release de photos « $PH » introuvable : montage sans photos."; fi
elif [ -n "$SRC_TAG" ]; then out photos_tag "$SRC_TAG"; fi

# --- la voix : 1) un fichier AUDIO (mp3, m4a, wav, ogg, opus…) ; 2) sinon un fichier nommé voix…/voice…/audio… ;
#     3) sinon l'unique vidéo de la release. Les AUTRES vidéos sont des extraits à monter (input/clips).
has_audio() { ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$1" 2>/dev/null | grep -q audio; }
VOICE=""
mapfile -t CAND < <(find input/raw -maxdepth 1 -type f ! -iregex ".*\.\(jpe?g\|png\|webp\)$" -printf '%s\t%p\n' | sort -rn | cut -f2-)
for f in "${CAND[@]}"; do if [[ "${f,,}" =~ \.(mp3|m4a|wav|ogg|oga|opus|aac|flac|wma|amr)$ ]] && has_audio "$f"; then VOICE="$f"; break; fi; done
if [ -z "$VOICE" ]; then for f in "${CAND[@]}"; do b=$(basename "${f,,}"); if [[ "$b" =~ ^(voix|voice|audio|vocal) ]] && has_audio "$f"; then VOICE="$f"; break; fi; done; fi
if [ -z "$VOICE" ]; then
  WITH=(); for f in "${CAND[@]}"; do has_audio "$f" && WITH+=("$f"); done
  if [ "${#WITH[@]}" -eq 1 ]; then VOICE="${WITH[0]}"
  elif [ "${#WITH[@]}" -gt 1 ]; then die "Plusieurs vidéos et aucun fichier audio : je ne peux pas deviner laquelle est ta voix. Dépose la voix en mp3/m4a/wav, ou renomme-la « voix.mp4 »."
  else die "Aucun fichier audio lisible trouvé. Formats acceptés : mp3, m4a, wav, ogg, opus, aac, flac (ou une vidéo nommée « voix… » : son seul utilisé)."; fi
fi
out voice_name "$(basename "$VOICE")"
echo "Voix : $(basename "$VOICE")"
ffmpeg -y -v error -i "$VOICE" -map 0:a:0 -vn -ac 1 -ar 48000 -c:a pcm_s16le input/voice.wav || die "Fichier audio illisible ou abîmé : $(basename "$VOICE")."
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 input/voice.wav | cut -d. -f1)
[ "${DUR:-0}" -ge 3 ] || die "Voix trop courte (${DUR:-0} s) : il faut au moins 3 secondes de parole."
MAX=${EXPLAINER_MAX_MIN:-180}
[ "$DUR" -le $((MAX * 60)) ] || die "Voix de $((DUR / 60)) min : la limite est de $MAX min (3 h) par run. Coupe le fichier en deux parties."
VOL=$(ffmpeg -v info -i input/voice.wav -af volumedetect -f null - 2>&1 | grep -oE 'max_volume: (-?[0-9.]+|-inf)' | awk '{print ($2=="-inf")?-99:$2}' || echo 0)
VOL=${VOL:-0}
awk "BEGIN{exit !($VOL < -55)}" && die "Le fichier audio est silencieux (niveau maximal $VOL dB)." || true
ffmpeg -y -v error -f lavfi -i "color=c=black:s=320x180:r=2" -i input/voice.wav -shortest -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -c:a aac -b:a 128k input/video.mp4
echo "Voix prête : ${DUR} s"; out duration "$DUR"

# --- photos : converties en JPEG sûrs (orientation EXIF appliquée, taille bornée) ; une image illisible est ignorée
n=0
while IFS= read -r f; do
  n=$((n + 1)); o=$(printf 'input/photos/%02d.jpg' "$n")
  ffmpeg -y -v error -i "$f" -frames:v 1 -vf "scale='min(2160,iw)':'min(2160,ih)':force_original_aspect_ratio=decrease" -q:v 3 "$o" 2>/dev/null || { echo "::warning::Photo illisible ignorée : $(basename "$f")"; rm -f "$o"; n=$((n - 1)); }
  [ "$n" -ge 60 ] && { echo "::warning::Plus de 60 images : seules les 60 premières sont montées."; break; }
done < <(find input/raw -type f -iregex ".*\.\(jpe?g\|png\|webp\)$" | sort)
echo "Captures / photos : $n"; out photos "$n"

# --- vidéos à monter (tout sauf la voix) : copiées telles quelles, dans l'ordre des noms ; une vidéo illisible est ignorée
mkdir -p input/clips; c=0
while IFS= read -r f; do
  [ "$f" = "$VOICE" ] && continue
  if ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 "$f" 2>/dev/null | grep -q video; then
    c=$((c + 1)); cp "$f" "$(printf 'input/clips/%02d-%s' "$c" "$(printf '%s' "$(basename "$f")" | tr -c 'A-Za-z0-9._-' '_')")"
  else echo "::warning::Vidéo illisible ignorée : $(basename "$f")"; fi
  [ "$c" -ge 20 ] && { echo "::warning::Plus de 20 vidéos : seules les 20 premières sont montées."; break; }
done < <(find input/raw -type f -iregex ".*\.\(mp4\|mov\|mkv\|webm\|m4v\|avi\)$" | sort)
echo "Vidéos à monter : $c"; out clips "$c"; out medias "$((n + c))"
rm -rf input/raw
