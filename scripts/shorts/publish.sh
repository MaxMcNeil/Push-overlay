#!/usr/bin/env bash
# Dépose les shorts rendus (out/short-NN-*.mp4) :
#   DESTINATION=auto    → < SHORTS_RELEASE_MAX_MB : Release GitHub « out-shorts-… » ; au-delà : Google Drive
#   DESTINATION=release → tout en Release (un fichier trop lourd part quand même sur Drive : GitHub refuse > 2 Go)
#   DESTINATION=drive   → tout sur Google Drive (secret RCLONE_CONF requis) ; repli Release si Drive indisponible
#   DESTINATION=both    → les deux
# Écrit le récapitulatif (titres, horaires dans la source, descriptions, hashtags) dans la release et le résumé du run.
set -uo pipefail
shopt -s nullglob
MAX_MB="${SHORTS_RELEASE_MAX_MB:-1900}"
DEST="${DESTINATION:-auto}"
STAMP=$(date -u +%Y%m%d-%H%M)
TAG="out-shorts"   # une seule release de sortie : chaque lancement remplace la précédente
# 🔗 CHAÎNE (fond vert → montage → shorts) : release à part « out-chaine-<id> », gardée 2 jours ;
# tes shorts manuels (out-shorts, dossier Drive « derniers ») ne sont jamais touchés par la chaîne.
if [ -n "${CHAINE_ID:-}" ]; then TAG="out-chaine-$CHAINE_ID"; fi
FILES=(out/short-*.mp4)
SUM="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ ${#FILES[@]} -eq 0 ]; then
  echo "::error::Aucun short n'a été rendu (voir les jobs « render » en rouge)."
  echo "### ❌ Aucun short rendu" >> "$SUM"; exit 1
fi
[ "${RENDER_RESULT:-success}" = "success" ] || echo "::warning::Certains rendus ont échoué : seuls ${#FILES[@]} short(s) sont publiés."

DRIVE_OK=0
if [ -n "${RCLONE_CONF:-}" ]; then
  command -v rclone >/dev/null || curl -sSf https://rclone.org/install.sh | sudo bash >/dev/null
  mkdir -p ~/.config/rclone && printf '%s\n' "$RCLONE_CONF" > ~/.config/rclone/rclone.conf
  REMOTE=$(grep -m1 -oE '^\[[^]]+\]' ~/.config/rclone/rclone.conf | tr -d '[]')
  [ -n "$REMOTE" ] && rclone about "$REMOTE:" >/dev/null 2>&1 && DRIVE_OK=1 || echo "::warning::RCLONE_CONF présent mais Google Drive injoignable (jeton expiré ?)."
fi
DRIVE_DIR="${GDRIVE_FOLDER:-Push-overlay/shorts}/derniers"   # dossier unique, vidé à chaque dépôt
[ -n "${CHAINE_ID:-}" ] && DRIVE_DIR="${GDRIVE_FOLDER:-Push-overlay/shorts}/chaine-$CHAINE_ID"   # chaîne : dossier à part, jamais vidé

to_release=(); to_drive=()
for f in "${FILES[@]}"; do
  mb=$(( $(stat -c %s "$f") / 1048576 ))
  case "$DEST" in
    release) if [ "$mb" -ge 2000 ]; then to_drive+=("$f"); else to_release+=("$f"); fi ;;
    drive)   if [ "$DRIVE_OK" = 1 ]; then to_drive+=("$f"); else echo "::warning::Drive indisponible → Release pour $f"; to_release+=("$f"); fi ;;
    both)    to_release+=("$f"); [ "$DRIVE_OK" = 1 ] && to_drive+=("$f") ;;
    *)       if [ "$mb" -ge "$MAX_MB" ]; then to_drive+=("$f"); else to_release+=("$f"); fi ;;
  esac
done

# ---------- récapitulatif ----------
NOTES=out/SHORTS.md
node - <<'JS' > "$NOTES"
const fs = require("fs");
const sel = (() => { try { return JSON.parse(fs.readFileSync("shorts/selection.json", "utf8")); } catch { return { clips: [] }; } })();
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const files = fs.readdirSync("out").filter((f) => /^short-\d+.*\.mp4$/.test(f));
console.log(`Shorts générés automatiquement (moteur de sélection : ${sel.engine || "?"}).\n`);
if (sel.errors?.length) console.log(`⚠ Incidents IA pendant la sélection :\n${sel.errors.map((e) => "- " + e).join("\n")}\n`);
for (const c of sel.clips) {
  const f = files.find((x) => x.startsWith(`short-${c.id}-`));
  let plan = {}; try { plan = JSON.parse(fs.readFileSync(`out/short-${c.id}.plan.json`, "utf8")); } catch {}
  console.log(`### #${c.id} ${c.title || plan.hook || "(sans titre)"}`);
  console.log(`- Fichier : ${f ? "`" + f + "`" : "❌ rendu échoué"}`);
  if (!f) { try { const err = fs.readFileSync(`out/short-${c.id}.error.txt`, "utf8").trim().split("\n").slice(-8).join("\n"); console.log("```\n" + err + "\n```"); } catch {} }
  console.log(`- Passage dans la source : ${fmt(c.start)} → ${fmt(c.end)} (${Math.round(c.duration)} s)`);
  if (plan.hook) console.log(`- Hook à l'écran : ${plan.hook}`);
  if (c.description) console.log(`- Description : ${c.description}`);
  if (c.hashtags?.length) console.log(`- Hashtags : ${c.hashtags.join(" ")}`);
  // texte prêt à coller en description du short (le short annonce « vidéo complète : lien juste en dessous »)
  const cta = { ar: "🎬 الفيديو الكامل:", en: "🎬 Full video:", it: "🎬 Video completo:" }[sel.lang] || "🎬 Vidéo complète :";
  console.log(`- À coller en description : ${[c.description, `${cta} [lien de ta vidéo longue]`, (c.hashtags || []).join(" ")].filter(Boolean).join(" — ")}`);
  console.log(`  (sur YouTube, relie aussi la vidéo longue avec « Vidéo associée » : c'est le lien cliquable qui s'affiche sous le short)`);
  if (c.why) console.log(`- Pourquoi : ${c.why}`);
  if (c.quality) console.log(`- Relecture IA : autonome ${c.quality.autonome}/10 · accroche ${c.quality.accroche}/10 · chute ${c.quality.chute}/10`);
  if (c.text) console.log(`- Début : « ${c.text.slice(0, 180)}… »`);
  console.log("");
}
JS

# ---------- Release ----------
if [ -n "${CHAINE_ID:-}" ]; then
  # chaîne : seulement les anciennes sorties de chaîne de plus de 2 jours
  gh release list --repo "$REPO" --limit 100 --json tagName,createdAt \
    -q '.[] | select(.tagName | startswith("out-chaine-")) | select(.createdAt < (now - 2*86400 | todate)) | .tagName' 2>/dev/null \
    | while read -r t; do [ -n "$t" ] && { echo "Sortie de chaîne de plus de 2 jours supprimée : $t"; gh release delete "$t" --repo "$REPO" -y --cleanup-tag || true; }; done
else
# anciennes releases de sortie (out-shorts, out-shorts-<date>…) supprimées avant de publier les nouvelles
for t in $(gh release list --repo "$REPO" --limit 100 --json tagName -q '.[].tagName' | grep -E '^out-shorts' || true); do
  echo "Suppression de l'ancienne release de sortie : $t"; gh release delete "$t" --repo "$REPO" -y --cleanup-tag || true
done
# anciennes releases d'ENTRÉE shorts* (on garde seulement celle qui vient d'être traitée)
for t in $(gh release list --repo "$REPO" --limit 100 --json tagName -q '.[].tagName' | grep -iE '^short' || true); do
  [ "$t" = "${SRC_TAG:-}" ] && continue
  echo "Suppression de l'ancienne vidéo déposée : $t"; gh release delete "$t" --repo "$REPO" -y --cleanup-tag || true
done
fi
if [ ${#to_release[@]} -gt 0 ] && [ -n "${CHAINE_ID:-}" ]; then
  { printf '%s\n' "🔗 **Chaîne \`$CHAINE_ID\`** — shorts du montage ${BASE:-?} ($(date -u +%d/%m/%Y)). Release supprimée automatiquement après 2 jours : télécharge tes shorts avant." ""
    [ -n "${CHAINE_ORIGINE:-}" ] && printf '%s\n' "Montage : ${CHAINE_ORIGINE}" ""
    printf '%s\n' "---" ""; cat "$NOTES"; } > /tmp/out-notes.md
  gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 \
    || gh release create "$TAG" --repo "$REPO" --prerelease --title "🔗 CHAÎNE $CHAINE_ID — ✂️ vidéos courtes" --notes-file /tmp/out-notes.md \
    || { echo "::error::Création de la release impossible"; exit 1; }
  UP=0
  for f in "${to_release[@]}"; do
    for i in 1 2 3; do gh release upload "$TAG" "$f" --repo "$REPO" --clobber && { UP=$((UP+1)); break; }; echo "réessai $i…"; sleep 5; done
  done
  gh release upload "$TAG" out/short-*.meta.json --repo "$REPO" --clobber || true
  [ "$UP" -gt 0 ] || { echo "::error::Aucun short n'a pu être déposé dans la release $TAG"; exit 1; }
  echo "### ✅ 🔗 Chaîne : $UP short(s) dans la release « $TAG » (gardée 2 jours)" >> "$SUM"
  echo "https://github.com/$REPO/releases/tag/$TAG" >> "$SUM"
elif [ ${#to_release[@]} -gt 0 ]; then
  { printf '%s\n' "✂️ **Tes derniers shorts** (vidéo source : ${BASE:-?}, $(date -u +%d/%m/%Y)) — remplacés à chaque nouvelle découpe." "" \
      "**Pour découper une autre vidéo** : Releases → *Draft a new release* → tag \`shorts-001\` (doit commencer par « shorts ») → joins la vidéo, ou colle son lien Google Drive dans la description → *Publish*." \
      "**Pour un montage complet (pas des shorts)** : tag SANS « short », ex. \`video-001\`." "" "---" ""; cat "$NOTES"; } > /tmp/out-notes.md
  gh release create "$TAG" --repo "$REPO" --prerelease --title "✂️ RÉSULTAT — Shorts" --notes-file /tmp/out-notes.md \
    || { echo "::error::Création de la release impossible"; exit 1; }
  for f in "${to_release[@]}"; do
    for i in 1 2 3; do gh release upload "$TAG" "$f" --repo "$REPO" --clobber && break; echo "réessai $i…"; sleep 5; done
  done
  gh release upload "$TAG" out/short-*.meta.json --repo "$REPO" --clobber || true
  echo "### ✅ ${#to_release[@]} short(s) dans la release « $TAG »" >> "$SUM"
  echo "https://github.com/$REPO/releases/tag/$TAG" >> "$SUM"
fi

# ---------- Google Drive ----------
if [ ${#to_drive[@]} -gt 0 ]; then
  if [ "$DRIVE_OK" != 1 ]; then
    echo "::error::${#to_drive[@]} fichier(s) trop lourd(s) pour une release, et Google Drive n'est pas configuré (secret RCLONE_CONF). Ils restent dans les Artifacts du run (14 jours)."
    echo "### ⚠ ${#to_drive[@]} fichier(s) seulement dans les Artifacts (Drive non configuré)" >> "$SUM"
  else
    [ -z "${CHAINE_ID:-}" ] && { rclone delete "$REMOTE:$DRIVE_DIR" -q 2>/dev/null || true; }   # les anciens shorts partent à la corbeille Drive
    for f in "${to_drive[@]}"; do rclone copy "$f" "$REMOTE:$DRIVE_DIR" --retries 3 -q || echo "::error::Envoi Drive échoué : $f"; done
    rclone copy "$NOTES" "$REMOTE:$DRIVE_DIR" -q || true
    echo "### ✅ ${#to_drive[@]} short(s) sur Google Drive : $DRIVE_DIR" >> "$SUM"
  fi
fi
echo "" >> "$SUM"; cat "$NOTES" >> "$SUM"
bash scripts/release-status.sh "${SRC_TAG:-}" ok "${#FILES[@]} short(s) prêts → release [✂️ RÉSULTAT — Shorts](https://github.com/$REPO/releases/tag/out-shorts)"
