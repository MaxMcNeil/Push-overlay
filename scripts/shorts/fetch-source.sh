#!/usr/bin/env bash
# Récupère la vidéo source dans input/video.<ext>.
# Ordre : champ SOURCE (lien Drive / tag de release / lien direct) → release qui a déclenché (EVENT_TAG)
#         → dernière release dont le tag commence par "shorts". Une release sans vidéo peut contenir un lien Drive
#         dans sa description. Google Drive : rclone si le secret RCLONE_CONF existe, sinon gdown (lien public).
set -euo pipefail
mkdir -p input
rm -f input/video.*
VIDEO_RE='\.(mp4|mov|mkv|webm|avi|m4v)$'
out() { echo "$1=$2" >> "${GITHUB_OUTPUT:-/dev/null}"; }
die() { echo "::error::$*"; exit 1; }

drive_id() { # extrait l'ID d'un lien Google Drive (file/d/ID, open?id=ID, uc?id=ID, ou ID nu)
  local u="$1"
  if [[ "$u" =~ /file/d/([A-Za-z0-9_-]{10,}) ]]; then echo "${BASH_REMATCH[1]}"
  elif [[ "$u" =~ [?\&]id=([A-Za-z0-9_-]{10,}) ]]; then echo "${BASH_REMATCH[1]}"
  elif [[ "$u" =~ ^[A-Za-z0-9_-]{25,}$ ]]; then echo "$u"
  fi
}
setup_rclone() {
  [ -n "${RCLONE_CONF:-}" ] || return 1
  command -v rclone >/dev/null || { curl -sSf https://rclone.org/install.sh | sudo bash >/dev/null; }
  mkdir -p ~/.config/rclone && printf '%s\n' "$RCLONE_CONF" > ~/.config/rclone/rclone.conf
  REMOTE=$(grep -m1 -oE '^\[[^]]+\]' ~/.config/rclone/rclone.conf | tr -d '[]')
  [ -n "$REMOTE" ] || return 1
}
from_drive() {
  local link="$1" id; id=$(drive_id "$link")
  [ -n "$id" ] || die "Lien Google Drive non reconnu : $link (attendu : https://drive.google.com/file/d/ID/view). Un lien de DOSSIER ne marche pas : partage le fichier vidéo."
  echo "Google Drive : fichier $id"
  if setup_rclone; then
    echo "→ rclone (compte Google connecté, remote « $REMOTE »)"
    mkdir -p input/dl && rclone backend copyid "$REMOTE:" "$id" input/dl/ --drive-acknowledge-abuse -q || die "rclone n'a pas pu lire le fichier (est-il dans ton Drive ou partagé avec toi ?)."
  else
    echo "→ gdown (le fichier doit être partagé « Tous les utilisateurs disposant du lien »)"
    pip install -q --break-system-packages gdown 2>/dev/null || pip install -q gdown
    mkdir -p input/dl && (cd input/dl && gdown -q "https://drive.google.com/uc?id=$id") \
      || die "Téléchargement Drive refusé. Partage le fichier « Tous les utilisateurs disposant du lien → Lecteur », ou ajoute le secret RCLONE_CONF (voir README). Si Google affiche « quota de téléchargement dépassé », seul RCLONE_CONF contourne la limite."
  fi
  local f; f=$(find input/dl -type f | head -n1)
  [ -n "$f" ] || die "Aucun fichier téléchargé depuis Drive."
  NAME=$(basename "$f"); mv "$f" "input/$NAME"; rm -rf input/dl
}
from_release() {
  local tag="$1" body link
  NAME=$(gh release view "$tag" --repo "$REPO" --json assets -q '.assets[].name' 2>/dev/null | grep -Ei "$VIDEO_RE" | head -n1 || true)
  out tag "$tag"
  if [ -n "$NAME" ]; then
    echo "Release $tag — vidéo : $NAME"
    gh release download "$tag" --repo "$REPO" --pattern "$NAME" --dir input --clobber
    return 0
  fi
  body=$(gh release view "$tag" --repo "$REPO" --json body,name -q '.name + " " + .body' 2>/dev/null || true)
  link=$(grep -oE 'https?://(drive|docs)\.google\.com/[^ )>"]+' <<<"$body" | head -n1 || true)
  [ -n "$link" ] || die "La release $tag ne contient ni vidéo ni lien Google Drive dans sa description."
  echo "Release $tag — lien Google Drive trouvé dans la description"
  from_drive "$link"
}

SRC="$(echo "${SOURCE:-}" | xargs || true)"
NAME=""
if [ -n "$SRC" ]; then
  if [[ "$SRC" =~ (drive|docs)\.google\.com ]] || [[ "$SRC" =~ ^[A-Za-z0-9_-]{25,}$ ]]; then from_drive "$SRC"
  elif [[ "$SRC" =~ ^https?:// ]]; then
    NAME=$(basename "${SRC%%\?*}"); [[ "$NAME" =~ $VIDEO_RE ]] || NAME="video.mp4"
    echo "Lien direct : $SRC"; curl -fL --retry 3 -o "input/$NAME" "$SRC" || die "Téléchargement impossible : $SRC"
  else from_release "$SRC"
  fi
elif [ -n "${EVENT_TAG:-}" ]; then from_release "$EVENT_TAG"
else
  T=$(gh release list --repo "$REPO" --limit 40 --json tagName -q '.[].tagName' | grep -iE '^short' | head -n1 || true)
  [ -n "$T" ] || die "Aucune source : remplis le champ « source » (lien Drive) ou publie une release dont le tag commence par « shorts »."
  from_release "$T"
fi

EXT="${NAME##*.}"; EXT=$(echo "$EXT" | tr 'A-Z' 'a-z')
[[ ".$EXT" =~ $VIDEO_RE ]] || EXT="mp4"
mv "input/$NAME" "input/video.$EXT"
BASE=$(basename "$NAME" ".${NAME##*.}" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-40)
out base "$BASE"
ls -la input/
ffprobe -v error -show_entries stream=codec_type,width,height:format=duration,size -of compact=p=0 "input/video.$EXT" \
  || die "Le fichier téléchargé n'est pas une vidéo lisible (lien Drive privé ? page HTML reçue à la place de la vidéo ?)."
