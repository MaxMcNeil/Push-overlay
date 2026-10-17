# Push-overlay — vidéo brute → vidéo finale montée

Tu déposes une vidéo dans une **Release GitHub**. Le workflow la transcrit, écrit un scénario
(hook + headlines choc + cartes d'analyse) et **rend `final.mp4`** : horizontal si ta vidéo est
horizontale, vertical si elle est verticale. Tout tourne sur GitHub (ffmpeg), sans service payant.

## Ce que contient la vidéo finale
- **Jamais 100 % de l'écran** : ta vidéo vit dans une fenêtre arrondie (halo néon) sur un fond animé (copie floutée + dérive de teinte).
- **Hook d'ouverture** (≈ 3 s) : question ou affirmation choc.
- **Bandeau de headline** qui change à chaque séquence (phrases complètes, validées par le script).
- **Valeur ajoutée** : cartes d'analyse en *split-screen* (« Pourquoi ? », « Le contexte »…) avec flèche vers la vidéo, emoji, transitions flash, **zooms punch**.
- **Sous-titres animés mot à mot** (mot prononcé en jaune), très lisibles.
- **Ticker permanent des 3 disclaimers** (FR/AR/EN/IT) : ta protection reste affichée du début à la fin.
- **Logo selon la langue** : arabe → `input/logo-ar.png`, français (et EN/IT) → `input/logo-fr.png`. L'interface se met en miroir pour l'arabe.
- **Effets sonores** synthétisés (impact d'ouverture, whoosh de transition, ding de headline, pop d'emoji), barre de progression.
- Langues : **arabe, français, anglais, italien** (détection automatique).

## Mise en place (une fois)
1. Pousse ce dossier sur GitHub.
2. *Settings → Actions → General → Workflow permissions* : **Read and write permissions**.
3. (Recommandé) *Settings → Secrets → Actions* : ajoute **`ANTHROPIC_API_KEY`** → headlines et analyses écrites par Claude en ~10 s, bien meilleures. Sans ce secret, le workflow utilise un LLM local (Qwen2.5-7B) : gratuit mais plus lent et moins brillant.

## Utilisation
1. *Releases → Draft a new release* → joins ta vidéo (n'importe quel nom) → **Publish**.
2. Attends la fin du workflow (onglet Actions).
3. Récupère `final.mp4` dans la Release **« renders »** (ou dans *Artifacts* du run, avec `plan.json`).

Tes propres headlines : mets-les dans `content/manual-headlines.txt` (une par ligne, dans l'ordre des séquences) — elles remplacent les headlines générées.

## Durées indicatives (runner GitHub gratuit)
Rendu ≈ 2,5× la durée de la vidéo ; transcription ≈ 0,5× ; scénario local ≈ 8–15 min (≈ 10 s avec Claude). Idéal : clips de 30 s à 5 min. Le 1er run est plus long (compilation + téléchargement des modèles, mis en cache ensuite).

## En local
Prérequis : `ffmpeg` (avec libass), Node 20, Python 3 + Pillow, polices Poppins/Tajawal dans `fonts/`.
`input/video.mp4` → `npm run all` → `output/final.mp4` (whisper.cpp requis pour la transcription ; sinon fournis `content/script.txt`).

## Limites honnêtes
- Les cartes d'analyse sont écrites à partir de **ce qui est dit** + du contexte général ; le LLM peut se tromper : relis `plan.json` pour les sujets sensibles (c'est aussi pour ça que les disclaimers restent affichés).
- Repli sans LLM : phrases propres tirées de la vidéo, cartes = extrait de la parole (pas d'analyse inédite).
- Pas de b-roll ni de cartes géographiques automatiques (aucune banque d'images embarquée) : zoom, split-screen, flèches, emojis et graphismes sont générés.
- Les anciens scripts d'overlay OBS (`generate-overlay.mjs`, `templates/`, `docs/`) sont conservés mais ne sont plus lancés par le workflow.
