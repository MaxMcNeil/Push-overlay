# Journal du NON — Overlay OBS automatisé

Pipeline 100% GitHub (Actions + Pages) qui transforme une vidéo brute en bandeau
d'infos animé, prêt à coller en Browser Source dans OBS. Pas de clé API, pas de
service payant : la transcription tourne en local sur le runner (whisper.cpp).

## Comment ça marche

```
Release GitHub "video.mp4/.mov/.mkv/.webm"  →  téléchargée dans input/   →  scripts/transcribe.mjs (whisper.cpp, local)
input/logo.png (commité dans le dépôt)       →  scripts/generate-overlay.mjs
content/script.txt (optionnel)               ↘
                                               scripts/extract-highlights.mjs → content/highlights.json
                                               scripts/generate-overlay.mjs   → docs/index.html
```

- **La vidéo ne va PAS dans le dépôt git** (limite de 100 Mo par fichier sur
  GitHub). Elle se dépose comme pièce jointe d'une **Release GitHub**
  (jusqu'à 2 Go par fichier), et le workflow la télécharge automatiquement au
  début de chaque run, dans `input/` (dossier ignoré par git — voir
  `.gitignore`).
- Si tu déposes un `content/script.txt` (ton propre texte/transcript), l'étape
  de transcription est sautée — le pipeline part directement de ton texte,
  avec ou sans vidéo.
- Sinon, la vidéo (si une Release en contient une) est transcrite
  automatiquement (audio extrait via ffmpeg, puis passé à whisper.cpp en
  français, modèle "base").
- **Texte seul, sans vidéo du tout** : ça fonctionne aussi. Sans vidéo,
  l'orientation ne peut pas être auto-détectée ; par défaut c'est horizontal.
  Pour forcer le vertical dans ce cas, dépose un fichier
  `content/orientation.txt` contenant juste `vertical` (ou `horizontal`).
  Ce fichier est prioritaire sur la détection vidéo si les deux sont présents.
- `extract-highlights.mjs` découpe le texte en phrases, les note (mots-clés
  d'alerte, chiffres, longueur idéale pour un bandeau...) et garde les
  meilleures comme accroches, avec une catégorie devinée automatiquement
  (ALERTE, CHIFFRES, SCIENCE, EXCLUSIF, ANALYSE, RÉGULATION, INFO...).
- `generate-overlay.mjs` regarde la résolution de la vidéo avec `ffprobe` :
  si elle est plus haute que large → template vertical, sinon → horizontal.
  Le logo et les accroches sont injectés directement dans le HTML final
  (`docs/index.html`), qui est un fichier autonome (fond transparent, aucune
  dépendance externe à charger à part les polices Google Fonts).

Le résultat NE contient PAS la vidéo — uniquement les bandeaux/animations en
overlay. Tu passes ta vidéo séparément dans OBS (Media Source ou capture), et
tu poses l'overlay par-dessus.

## Mise en place (une seule fois)

1. Crée le dépôt sur GitHub et pousse ce contenu.
2. Dans **Settings → Pages**, choisis "Deploy from a branch", branche `main`,
   dossier `/docs`. Attends que la page se publie — l'URL apparaît en haut de
   cet écran (ex. `https://tonpseudo.github.io/journal-du-non-overlay/`).
3. Dans **Settings → Actions → General → Workflow permissions**, coche
   "Read and write permissions" (nécessaire pour que le workflow puisse
   committer `docs/index.html` généré, et télécharger les assets de Release).
4. Dans OBS : Source → Navigateur → colle l'URL GitHub Pages ci-dessus.
   Largeur/hauteur = ta résolution de canvas (ex. 1920×1080 horizontal,
   1080×1920 vertical).

## Utilisation à chaque live

**Option A — avec vidéo (transcription auto + orientation auto détectée) :**

1. Va dans **Releases → Draft a new release** sur GitHub.
2. Attache ta vidéo en tant que fichier joint, nommée exactement
   `video.mp4` (ou `.mov`/`.mkv`/`.webm`).
3. Publie la release. Ça déclenche automatiquement le workflow : téléchargement
   de la vidéo, transcription locale, extraction des accroches, génération de
   `docs/index.html`, publication sur GitHub Pages.
4. Pour un nouveau live, republie simplement une nouvelle release avec la
   vidéo suivante (le workflow prend toujours la dernière release).

**Option B — texte seul (pas de vidéo, plus rapide) :**

1. Édite `content/script.txt` avec ton texte.
2. (Optionnel) Édite `content/orientation.txt` avec `vertical` ou
   `horizontal` selon le format de ton live.
3. `git push`. Le workflow se déclenche, extrait les accroches et régénère
   `docs/index.html` — sans passer par la transcription.

Dans les deux cas, GitHub Pages se met à jour automatiquement une fois le
commit poussé par le workflow. Dans OBS, la source navigateur se rafraîchit
toute seule (ou clique-droit → Actualiser le cache du navigateur si besoin).

## Format vertical : zone de sécurité en haut

Le template vertical laisse volontairement les **~230 premiers pixels** (sur
1920 de haut) totalement vides, pour ne pas être caché par le badge chaîne /
"EN DIRECT" que YouTube affiche en haut de l'écran pendant un live. Le bandeau
d'infos est en bas (zone haute et basse peuvent être redimensionnées dans le
CSS — `templates/overlay-vertical.html` — si tu veux ajuster).

Repositionne simplement ta source vidéo dans OBS pour qu'elle occupe l'espace
transparent entre le badge du haut et le bandeau du bas.

## Personnalisation rapide

- Nom de chaîne, sous-titre, badge lieu, vitesse de rotation des accroches :
  tout est dans `CONFIG` en haut de `scripts/generate-overlay.mjs`.
- Couleurs, polices, timing des animations : dans les deux fichiers
  `templates/overlay-*.html` (variables CSS `:root`).
- Nombre d'accroches gardées, mots-clés de catégorisation : dans
  `scripts/extract-highlights.mjs`.

## Limites à connaître

- La transcription tourne sur CPU (runner GitHub gratuit) : compte large,
  peut prendre plusieurs minutes pour une vidéo longue.
- GitHub limite la taille des fichiers commités (100 Mo par fichier). Pour des
  vidéos volumineuses, active [Git LFS](https://git-lfs.com/) sur `input/*.mp4`
  ou héberge la vidéo ailleurs et adapte `transcribe.mjs` pour la télécharger
  en amont.
- Le premier run peut être plus lent (téléchargement + compilation de
  whisper.cpp) ; les runs suivants profitent du cache Actions.
