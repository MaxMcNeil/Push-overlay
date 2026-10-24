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
TAG="out-shorts-${STAMP}-${BASE:-video}"
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
DRIVE_DIR="${GDRIVE_FOLDER:-Push-overlay/shorts}/${STAMP}-${BASE:-video}"

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
if [ ${#to_release[@]} -gt 0 ]; then
  gh release create "$TAG" --repo "$REPO" --prerelease --title "Shorts — ${BASE:-video} (${STAMP})" --notes-file "$NOTES" \
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
    for f in "${to_drive[@]}"; do rclone copy "$f" "$REMOTE:$DRIVE_DIR" --retries 3 -q || echo "::error::Envoi Drive échoué : $f"; done
    rclone copy "$NOTES" "$REMOTE:$DRIVE_DIR" -q || true
    echo "### ✅ ${#to_drive[@]} short(s) sur Google Drive : $DRIVE_DIR" >> "$SUM"
  fi
fi
echo "" >> "$SUM"; cat "$NOTES" >> "$SUM"
