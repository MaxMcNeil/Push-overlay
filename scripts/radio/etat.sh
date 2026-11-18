#!/usr/bin/env bash
# « Émission radio » : quelle étape, quels fichiers ? Aucun nom imposé.
#   SRC   = release de tes audios (champ « release », sinon la dernière où tu as déposé un son ou une vidéo)
#   STATE = où sont rangées tes phrases (emission-a-lire.txt + emission-plan.json) : ta release (main) ;
#           depuis une branche d'essai : « out-radio-essai » (ta release n'est jamais modifiée)
#   étape : analyse (pas encore de phrases, ou « réécrire mes phrases ») ; montage (un audio déposé APRÈS les phrases
#           = ta voix) ; attente (phrases écrites, ta voix pas encore déposée)
# Écrit dans input/radio : clips/NN-nom (+ clips.json : nom local → nom dans la release), plan.json et voix.* (montage).
set -euo pipefail
out() { echo "$1=$2" >> "${GITHUB_OUTPUT:-/dev/null}"; }
die() { echo "::error::$*"; exit 1; }
MEDIA='\\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|wma|amr|weba|mp4|mov|mkv|webm|m4v|avi|3gp)$'
rm -rf input/radio && mkdir -p input/radio/clips

SRC="$(echo "${SOURCE:-}" | xargs || true)"
if [ -z "$SRC" ]; then
  SRC=$(gh api "repos/$REPO/releases?per_page=50" -q "
    [ .[] | select(.draft|not) | select(.tag_name | test(\"^(out-|renders\$)\"; \"i\") | not)
      | select([.assets[].name | test(\"$MEDIA\"; \"i\")] | any)
      | { tag: .tag_name, t: ([.published_at, .created_at] + [.assets[] | .updated_at, .created_at] | map(select(. != null)) | max) } ]
    | sort_by(.t) | reverse | .[0].tag // empty" || true)
  [ -n "$SRC" ] || die "Aucune release avec un audio : dépose tes audios dans une release (n'importe quel nom), ou remplis le champ « release »."
  echo "::notice::Release utilisée : « $SRC » (la dernière où tu as déposé un son ou une vidéo)"
fi
gh api "repos/$REPO/releases/tags/$SRC" >/dev/null 2>&1 || die "Release « $SRC » introuvable."
out src "$SRC"

if [ -n "${MAIN:-}" ]; then STATE="$SRC"; else
  STATE="out-radio-essai"
  gh api "repos/$REPO/releases/tags/$STATE" >/dev/null 2>&1 || gh release create "$STATE" --repo "$REPO" --prerelease \
    --title "🧪 Émission radio — essais (branche)" --notes "Résultats des essais lancés depuis une branche : ta release n'est jamais modifiée."
fi
out state "$STATE"

# médias de ta release, dans l'ordre de dépôt
gh api "repos/$REPO/releases/tags/$SRC" -q "[.assets[] | select(.name | test(\"$MEDIA\"; \"i\")) | {id, name, t: .created_at, size}] | sort_by(.t, .name)" > input/radio/medias.json
NB=$(node -e 'console.log(require("./input/radio/medias.json").length)')
[ "$NB" -gt 0 ] || die "La release « $SRC » ne contient aucun audio."

# phrases déjà écrites ?
read -r PLAN_ID PLAN_T < <(gh api "repos/$REPO/releases/tags/$STATE" -q '[.assets[] | select(.name == "emission-plan.json")] | if length > 0 then (.[0] | "\(.id) \(.updated_at)") else "" end' 2>/dev/null || true) || true
if [ -n "${PLAN_T:-}" ]; then
  gh api -H "Accept: application/octet-stream" "repos/$REPO/releases/assets/$PLAN_ID" > input/radio/plan.json
  node -e 'JSON.parse(require("fs").readFileSync("input/radio/plan.json","utf8"))' 2>/dev/null || die "emission-plan.json illisible dans « $STATE » : choisis « réécrire mes phrases »."
fi
PLAN_T="${PLAN_T:-}"

case "${ETAPE:-auto}" in
  réécrire*) ETAPE=analyse ;;
  monter*) ETAPE=montage ;;
  *) ETAPE=auto ;;
esac

# nouveaux fichiers = déposés APRÈS les phrases et absents de la liste des auditeurs
node -e '
const fs = require("fs");
const m = require("./input/radio/medias.json");
const plan = fs.existsSync("input/radio/plan.json") ? JSON.parse(fs.readFileSync("input/radio/plan.json", "utf8")) : null;
const t = process.argv[1];
const deja = new Set((plan?.clips || []).map((c) => c.origine));
const nouveaux = plan ? m.filter((x) => !deja.has(x.name) && (!t || x.t > t)) : [];
fs.writeFileSync("input/radio/nouveaux.json", JSON.stringify(nouveaux));
' "$PLAN_T"
NEW=$(node -e 'console.log(require("./input/radio/nouveaux.json").length)')

if [ "$ETAPE" = auto ]; then
  if [ -z "$PLAN_T" ]; then ETAPE=analyse
  elif [ "$NEW" -gt 0 ]; then ETAPE=montage
  else ETAPE=attente; fi
fi

dl() { gh api -H "Accept: application/octet-stream" "repos/$REPO/releases/assets/$1" > "$2" && [ -s "$2" ]; }
clean() { echo "$1" | sed -E 's/[^A-Za-z0-9._-]+/_/g' | cut -c1-60; }

case "$ETAPE" in
  analyse)
    echo "Étape 1 : $NB audio(s) de « $SRC » → tes phrases"
    node -e 'for (const [i, x] of require("./input/radio/medias.json").entries()) console.log([x.id, String(i + 1).padStart(2, "0"), x.name].join("\t"))' > input/radio/liste.tsv
    echo "{" > input/radio/clips.json; first=1
    while IFS=$'\t' read -r id n name; do
      local_name="$n-$(clean "$name")"
      for i in 1 2 3; do dl "$id" "input/radio/clips/$local_name" && break; sleep 5; done || die "Téléchargement impossible : $name"
      [ $first = 1 ] || echo "," >> input/radio/clips.json; first=0
      node -e 'process.stdout.write(JSON.stringify(process.argv[1]) + ":" + JSON.stringify(process.argv[2]))' "$local_name" "$name" >> input/radio/clips.json
      echo "  auditeur $n : $name"
    done < input/radio/liste.tsv
    echo "}" >> input/radio/clips.json
    ;;
  montage)
    [ -n "$PLAN_T" ] || die "Pas encore de phrases pour « $SRC » : lance d'abord l'étape 1 (champ étape = auto)."
    [ "$NEW" -gt 0 ] || die "Aucun audio déposé dans « $SRC » après tes phrases : dépose l'enregistrement de ta voix, puis relance."
    read -r VID VNAME < <(node -e 'const n = require("./input/radio/nouveaux.json"); const v = n[n.length - 1]; console.log(v.id + " " + v.name)')
    [ "$NEW" -gt 1 ] && echo "::warning::$NEW nouveaux fichiers : ta voix = le plus récent (« $VNAME »), les autres sont ignorés."
    EXT="${VNAME##*.}"
    for i in 1 2 3; do dl "$VID" "input/radio/voix.$EXT" && break; sleep 5; done || die "Téléchargement impossible : $VNAME"
    echo "Étape 2 : ta voix = « $VNAME »"
    # les auditeurs, exactement ceux de tes phrases
    node -e '
const p = require("./input/radio/plan.json"), m = require("./input/radio/medias.json");
for (const c of p.clips) { const x = m.find((y) => y.name === c.origine); console.log([x ? x.id : "", c.fichier, c.origine].join("\t")); }' > input/radio/liste.tsv
    while IFS=$'\t' read -r id local_name name; do
      [ -n "$id" ] || die "L'audio « $name » a été retiré de la release « $SRC » : remets-le, ou choisis « réécrire mes phrases »."
      for i in 1 2 3; do dl "$id" "input/radio/clips/$local_name" && break; sleep 5; done || die "Téléchargement impossible : $name"
    done < input/radio/liste.tsv
    ;;
  attente)
    echo "::notice::Tes phrases sont prêtes (emission-a-lire.txt dans la release « $STATE ») : enregistre-les, dépose ton audio dans « $SRC », puis relance."
    { echo "## ⏳ En attente de ta voix"; echo; echo "Tes phrases sont dans **emission-a-lire.txt** (release **$STATE**). Enregistre-les d'affilée, dépose ton audio dans la release **$SRC**, puis relance « Émission radio » (champs vides)."; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    ;;
esac
out etape "$ETAPE"
