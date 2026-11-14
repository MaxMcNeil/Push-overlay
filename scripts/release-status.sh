#!/usr/bin/env bash
# Affiche l'état du traitement DIRECTEMENT sur la release que tu as déposée (titre + note en bas de la description) :
#   ⏳ EN COURS — <titre>   puis   ✅ TERMINÉ — <titre>   ou   ❌ ÉCHEC — <titre>
# Usage : release-status.sh <tag> <run|ok|fail> "<message>"   (REPO et GH_TOKEN dans l'environnement)
TAG="$1"; STATE="$2"; MSG="$3"
[ -n "$TAG" ] || exit 0
cur=$(gh release view "$TAG" --repo "$REPO" --json name,body 2>/dev/null) || exit 0
name=$(jq -r '.name // ""' <<<"$cur"); body=$(jq -r '.body // ""' <<<"$cur")
base=$(sed -E 's/^(⏳ EN COURS|✅ TERMINÉ|❌ ÉCHEC) — //' <<<"$name"); [ -n "$base" ] || base="$TAG"
# rôles déjà notés (quels workflows ont utilisé cette release) : gardés d'un état à l'autre. Build Video ne supprime
# jamais une release qu'un autre workflow (Faceless, Shorts) a utilisée.
roles=$( { grep -o '<!-- role:[a-z-]* -->' <<<"$body"; [ -n "${STATUS_ROLE:-}" ] && echo "<!-- role:$STATUS_ROLE -->"; } | sort -u | tr '\n' ' ')
body=$(awk '/^<!-- etat-auto -->/{exit} {print}' <<<"$body")   # retire l'ancien bloc d'état
case "$STATE" in run) p="⏳ EN COURS";; ok) p="✅ TERMINÉ";; *) p="❌ ÉCHEC";; esac
printf '%s\n\n<!-- etat-auto -->\n---\n**%s** — %s\n%s\n' "$body" "$p" "$MSG" "$roles" > /tmp/release-body.md
gh release edit "$TAG" --repo "$REPO" --title "$p — $base" --notes-file /tmp/release-body.md >/dev/null && echo "État de la release $TAG : $p" || true
