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
    # ORDRE : un nom qui commence par un numéro (« 001_… », « 2 - … ») est placé selon ce numéro, en tête ; les autres dans
    # l'ordre où tu les as déposés. RÔLE : « start / intro / générique / début / ouverture » = ouverture de l'émission (pas un
    # auditeur) ; « outro / ending / fin / clôture » = fin de l'émission.
    node -e '
const m = require("./input/radio/medias.json");
const num = (n) => { const x = String(n).match(/^\s*(\d{1,4})(?=[\s._-])/); return x ? Number(x[1]) : Infinity; };
const role = (n) => /(^|[^a-z])(start|starting|intro|opening|g[eé]n[eé]rique|d[eé]but|ouverture|jingle)([^a-z]|$)/i.test(n) ? "ouverture"
  : /(^|[^a-z])(outro|ending|end|fin|cl[oô]ture)([^a-z]|$)/i.test(n) ? "fin" : "auditeur";
const tri = m.map((x, i) => ({ ...x, i })).sort((a, b) => (num(a.name) - num(b.name)) || (a.i - b.i));
for (const [k, x] of tri.entries()) console.log([x.id, String(k + 1).padStart(2, "0"), role(x.name), x.name].join("\t"));' > input/radio/liste.tsv
    : > input/radio/clips.tsv
    while IFS=$'\t' read -r id n role name; do
      local_name="$n-$(clean "$name")"
      for i in 1 2 3; do dl "$id" "input/radio/clips/$local_name" && break; sleep 5; done || die "Téléchargement impossible : $name"
      d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "input/radio/clips/$local_name" 2>/dev/null || echo 0)
      printf '%s\t%s\t%s\t%s\t%s\n' "$local_name" "$name" "$id" "${d:-0}" "$role" >> input/radio/clips.tsv
      echo "  $n ($role, ${d%.*} s) : $name"
    done < input/radio/liste.tsv
    node -e '
const fs = require("fs");
const L = fs.readFileSync("input/radio/clips.tsv", "utf8").trim().split("\n").filter(Boolean).map((l) => { const [fichier, origine, id, d, role] = l.split("\t"); return { fichier, origine, id, duree: Number(d) || 0, role }; });
fs.writeFileSync("input/radio/clips.json", JSON.stringify(L, null, 1));'
    PREP=oui
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
    node -e '
const p = require("./input/radio/plan.json");
require("fs").writeFileSync("input/radio/clips.json", JSON.stringify(p.clips.map((c) => ({ fichier: c.fichier, origine: c.origine, duree: c.duree, role: c.role || "auditeur" })), null, 1));'
    # voix des auditeurs déjà séparées de leur musique à l'étape 1 (rangées avec tes phrases) : rien à refaire
    TAR_ID=$(gh api "repos/$REPO/releases/tags/$STATE" -q '[.assets[] | select(.name == "emission-voix-seules.tar")] | if length > 0 then .[0].id else "" end' 2>/dev/null || true)
    if [ -n "$TAR_ID" ] && dl "$TAR_ID" input/radio/voix-seules.tar && mkdir -p input/radio/voix-seules && tar -xf input/radio/voix-seules.tar -C input/radio/voix-seules; then
      rm -f input/radio/voix-seules.tar; echo "Voix des auditeurs sans musique : reprises de l'étape 1 ($(ls input/radio/voix-seules | wc -l) fichiers)"; PREP=non
    else
      rm -f input/radio/voix-seules.tar; PREP=oui
    fi
    ;;
  attente)
    echo "::notice::Tes phrases sont prêtes (emission-a-lire.txt dans la release « $STATE ») : enregistre-les, dépose ton audio dans « $SRC », puis relance."
    { echo "## ⏳ En attente de ta voix"; echo; echo "Tes phrases sont dans **emission-a-lire.txt** (release **$STATE**). Enregistre-les d'affilée, dépose ton audio dans la release **$SRC**, puis relance « Émission radio » (champs vides)."; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    ;;
esac
# RÉPARTITION : la préparation (musique retirée, transcription) est partagée entre plusieurs machines en parallèle,
# chacune ≈ 20 min d'audio au plus (16 machines max) : une émission 10 fois plus longue ne prend pas 10 fois plus de temps.
[ "$ETAPE" = montage ] && [ "${MUSIQUE:-retirer}" = garder ] && PREP=non     # rien à préparer : transcriptions déjà dans le plan
if [ "${PREP:-non}" = oui ] && [ "$ETAPE" != attente ]; then
  node -e '
const fs = require("fs");
const L = JSON.parse(fs.readFileSync("input/radio/clips.json", "utf8"));
const total = L.reduce((s, c) => s + (c.duree || 60), 0);
const n = Math.max(1, Math.min(16, Math.ceil(total / (20 * 60)), L.length));
const g = Array.from({ length: n }, () => ({ d: 0, f: [] }));
for (const c of [...L].sort((a, b) => (b.duree || 60) - (a.duree || 60))) { const t = g.reduce((a, b) => (b.d < a.d ? b : a)); t.d += c.duree || 60; t.f.push(c.fichier); }
fs.writeFileSync("input/radio/groupes.json", JSON.stringify(g.map((x) => x.f)));
console.log(`Préparation répartie sur ${n} machine(s) : ` + g.map((x) => Math.round(x.d / 60) + " min").join(", ") + ` (total ${Math.round(total / 60)} min d’audio)`);'
  GR=$(node -e 'console.log(JSON.stringify(require("./input/radio/groupes.json").map((_, i) => i + 1)))')
  out prep oui; out groupes "$GR"
else
  out prep non; out groupes "[]"
fi
out etape "$ETAPE"
