# Push-overlay — vidéo brute → vidéo finale montée (+ Shorts)

Deux workflows :
- **Build Video** : une vidéo → la même vidéo montée (`final.mp4`). Release « normale » (tag libre, sauf `shorts…`).
- **Video to Shorts** : une vidéo longue → plusieurs **Shorts verticaux** montés. Release dont le **tag commence par `shorts`**, ou lien Google Drive.

Tu déposes une vidéo dans une **Release GitHub**. Le workflow la transcrit, écrit un scénario
(hook + headlines choc + cartes d'analyse) et **rend `final.mp4`** : horizontal si ta vidéo est
horizontale, vertical si elle est verticale. Tout tourne sur GitHub (ffmpeg), sans service payant.

## Ce que contient la vidéo finale
- **Jamais 100 % de l'écran** : ta vidéo vit dans une fenêtre arrondie (halo néon) sur un fond animé (copie floutée + dérive de teinte).
- **Hook d'ouverture** (≈ 3 s) : question ou affirmation choc, mot-clé en or.
- **Synchro parole/idées** : petits coups de zoom, flashs de lumière sur le cadre, éclats sur le fond et balayages lumineux à chaque nouvelle idée, mot-clé prononcé ou reprise de phrase après une pause.
- **Titres courts et percutants** (3 à 7 mots), cartes en 3 puces de 4 à 8 mots, dans toutes les langues ; l'arabe est écrit en littéraire simple.
- **Mouvement permanent** : fond dégradé animé, travelling lent dans la fenêtre, tremblement à l'entrée des zooms, balayages de couleur + flash à chaque transition, reflet qui traverse la headline, emojis qui montent.
- **Bandeau de headline** qui change à chaque séquence (phrases complètes, validées par le script).
- **Valeur ajoutée** : cartes d'analyse en *split-screen* (« Pourquoi ? », « Le contexte »…) avec flèche vers la vidéo, emoji, transitions flash, **zooms punch**.
- **Sous-titres animés mot à mot** : pop, légère inclinaison, couleur qui change à chaque phrase. Largeurs mesurées avec le vrai moteur de rendu : l'arabe est parfaitement calé.
- **Ticker permanent des 3 disclaimers** (FR/AR/EN/IT) : ta protection reste affichée du début à la fin.
- **Logo selon la langue** : arabe → `input/logo-ar.png`, français (et EN/IT) → `input/logo-fr.png`. L'interface se met en miroir pour l'arabe.
- **Effets sonores** synthétisés (impact d'ouverture, whoosh de transition, ding de headline, pop d'emoji), barre de progression.
- Langues : **arabe, français, anglais, italien** (détection automatique).

## Mise en place (une fois)
1. Pousse ce dossier sur GitHub.
2. *Settings → Actions → General → Workflow permissions* : **Read and write permissions**.
3. **IA gratuite pour écrire les headlines (fortement recommandé)** — le LLM local est gratuit mais écrit mal l'arabe. Crée UNE de ces clés (sans carte bancaire) :
   - **Gemini** (meilleur en arabe) : https://aistudio.google.com → *Get API key*.
   - **Groq** (très rapide, Llama 3.3 70B) : https://console.groq.com/keys.

   Puis ajoute-la comme secret du dépôt, nom exact `GEMINI_API_KEY` ou `GROQ_API_KEY`
   (site : *Settings → Secrets and variables → Actions → New repository secret* ; ou Termux : `gh secret set GEMINI_API_KEY --repo MaxMcNeil/Push-overlay`, puis colle la clé).
   Ordre d'essai : Gemini → Groq → Claude (optionnel, payant : `ANTHROPIC_API_KEY`) → LLM local. Avec une clé, plus de téléchargement de modèle : le run est bien plus court.
   Les offres gratuites changent : si un fournisseur refuse, le script passe au suivant, puis au LLM local. Les requêtes gratuites de Gemini peuvent être utilisées par Google pour améliorer ses produits : n'envoie que des contenus que tu publies de toute façon.

### Qualité du texte (important)
- **La clé Groq sert aussi à transcrire** : Whisper large-v3 gratuit, nettement meilleur que le whisper local pour l'arabe dialectal. Sans clé Groq, le workflow utilise whisper large-v3-turbo en local (meilleur que l'ancien « small », mais plus lent).
- Les headlines/cartes sont écrites en **arabe littéraire simple**, avec **3 points courts** par carte. Avec Gemini, l'**audio** de la vidéo est envoyé à l'IA : elle comprend le sens même quand la transcription est mauvaise.
- **Aucune IA disponible ? Plus de texte brut** : le montage sort sans headlines ni cartes (sous-titres + effets seulement) et le log affiche un gros avertissement. Rien de faux n'est publié.
- Erreur Gemini 403 dans le log = clé restreinte/refusée → crée une nouvelle clé sur https://aistudio.google.com/apikey (« Create API key in new project ») et remets le secret.

### Mode sous-titres
Niveau d'énergie des zooms/lumières : `{"energy":"high"}` (défaut, nerveux), `"normal"` ou `"low"`. Les deux réglages se combinent : `{"subtitles":"full","energy":"high"}`.

Fichier optionnel `content/style.json` : `{"subtitles":"full"}` (défaut : tous les mots), `{"subtitles":"keywords"}` (seulement les mots importants, en grand, quand ils sont prononcés) ou `{"subtitles":"off"}`.

### Variété des styles (anti « contenu répétitif »)
Chaque vidéo reçoit automatiquement un **thème** différent parmi 8 (palette de couleurs, dégradé, sons, transitions, animation des sous-titres, forme des puces, côté de la carte, arrondis, barre de progression…), plus de petites variations aléatoires propres à chaque vidéo. **Chaque chaîne a son propre historique** (FR/EN/IT d'un côté, arabe de l'autre) : un thème ne revient pas avant au moins 4 vidéos sur la même chaîne ; les deux chaînes peuvent partager un même thème. L'historique est enregistré dans `state/style-history.json` (commit automatique `[skip ci]`).
- Forcer un thème : `content/style.json` → `{"style":"sunset"}` (thèmes : neon-night, sunset, emerald, royal, crimson, ocean, mono-gold, candy). Revenir à l'ancien rendu fixe : `{"style":"default"}`.
- Le logo et la place de la headline ne changent jamais (identité de chaîne). Le thème utilisé est noté dans `theme.json` (Artifacts).
- À toi de varier aussi le fond (commentaire, angles, durée) : la politique de YouTube vise surtout les contenus produits en série sans valeur ajoutée propre.

## Video to Shorts (vidéo longue → Shorts)

**Déposer la vidéo**, au choix :
1. *Releases → Draft a new release* → tag **`shorts-001`** (tout tag qui commence par `shorts`) → joins la vidéo → **Publish** ;
2. vidéo trop lourde (> 2 Go) : même release **sans pièce jointe**, avec le **lien Google Drive** dans la description ;
3. ou *Actions → Video to Shorts → Run workflow* → champ **source** = lien Google Drive (ou tag de release, ou lien direct .mp4).
   Les autres champs : nombre de shorts (5), durée min/max (20–60 s), recadrage (auto = vidéo horizontale → 4:5 centré), consigne libre (« les passages sur l'économie »), destination.

**Ce que fait le workflow** : transcription (Groq par morceaux de 10 min, repli whisper local) → l'IA choisit les meilleurs passages
(idée complète, accroche forte, chute nette, sans chevauchement ; elle répond par numéros de phrases, donc les coupes tombent
toujours entre deux phrases) → chaque passage est découpé, recadré en vertical et monté **en parallèle** (hook, headlines, cartes,
sous-titres, ticker des disclaimers) avec **un thème différent par short** → dépôt.

**Résultats** : chaque short < 1 900 Mo → Release **`out-shorts-<date>-<nom>`** (avec un récapitulatif : titre proposé, passage dans la
source, description, hashtags) ; plus lourd → **Google Drive** (`Push-overlay/shorts/…`). Champ *destination* : `auto` (selon la taille),
`release`, `drive`, `both`. Les shorts sont aussi dans les *Artifacts* du run pendant 14 jours.
**Identité visuelle des Shorts** (volontairement différente de Build Video, rendu par `scripts/render-short.mjs`) :
vidéo **plein écran** avec jump-zoom à chaque idée, transitions glitch/secousse, **sous-titres karaoké** (police Anton / Lalezar,
mot actif sur boîte, en couleur ou souligné), **étiquette de chapitre** inclinée façon tampon + emoji réaction, **puces** qui s'empilent,
barre de progression **segmentée**, sons propres (pas de bandeau de disclaimers dans les shorts). 6 styles qui tournent (`lib/short-styles.mjs`).
**Jamais de texte sur le visage** ni sur des sous-titres déjà incrustés (détectés par `scripts/face-box.py` ; nos sous-titres se coupent
alors tout seuls), ni dans les zones couvertes par l'interface YouTube/TikTok.
**« Vidéo complète en lien »** : badge « EXTRAIT · VIDÉO COMPLÈTE EN LIEN » après le hook. **Écran de fin** (≈ 4-5 s) : la vidéo se réduit
en carte en haut (visage entier), une main clique « S'ABONNER » → « ABONNÉ ✓ » + cloche, le pouce « J'AIME » éclate (sons clic, ding, pop),
et « VIDÉO COMPLÈTE — lien juste en dessous » s'affiche en grand en bas, au-dessus de la zone couverte par YouTube. Le récapitulatif donne le texte à coller en description ; sur YouTube, relie la vidéo longue avec
« Vidéo associée » (c'est le lien cliquable affiché sous le short).
Les coupes tombent toujours en fin de phrase, jamais sur le début de la phrase suivante (fondu audio de 0,2 s).

**Google Drive** :
- *Lire* une vidéo : le fichier doit être partagé « Tous les utilisateurs disposant du lien → Lecteur » (téléchargé avec gdown).
- *Écrire* sur ton Drive (ou lire un fichier privé / contourner « quota de téléchargement dépassé ») : secret **`RCLONE_CONF`**.
  Dans Termux : `pkg install rclone` → `rclone config` → `n` → nom `gdrive` → type `drive` → client_id/secret vides → scope `1` (accès complet)
  → laisser le reste par défaut → navigateur automatique `y` (copie le lien `http://127.0.0.1:53682/…` affiché dans le navigateur du téléphone et connecte ton compte Google) → Shared Drive `n` → `q`.
  Puis : `gh secret set RCLONE_CONF --repo MaxMcNeil/Push-overlay < ~/.config/rclone/rclone.conf`.
  Dossier de dépôt modifiable avec la variable de dépôt `GDRIVE_FOLDER` (*Settings → Secrets and variables → Actions → Variables*).

**Durées indicatives** (runner gratuit) : vidéo de 1 h ≈ 5–10 min de transcription Groq (≈ 30–60 min en local), puis ≈ 4 min de rendu par short de 60 s, 5 shorts en parallèle.

### Plusieurs clés IA (recommandé pour les Shorts)
Les secrets **`GEMINI_API_KEYS`** et **`GROQ_API_KEYS`** acceptent plusieurs clés (séparées par une virgule ou un retour à la ligne).
Une clé saturée ou refusée est sautée automatiquement, et chaque short commence par une clé différente. Les anciens secrets
`GEMINI_API_KEY` / `GROQ_API_KEY` restent valables. ⚠ Le quota gratuit est compté **par projet Google** : crée chaque clé Gemini avec
« Create API key in new project ». Les secrets d'un autre dépôt (ex. Vid-o-presse-finder) ne sont pas visibles ici : il faut les recréer.

### Pas de surcharge de GitHub
Chaque nouveau résultat **remplace** le précédent : Build Video garde une seule vidéo dans la release « renders », Video to Shorts une seule
release « out-shorts » (et un seul dossier Drive `…/derniers`). Les anciennes vidéos déposées sont supprimées après traitement (on garde
la dernière). Les Artifacts des runs sont gardés 3 jours (1 jour pour les passages intermédiaires).

## Utilisation (Build Video)
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
- `content/orientation.txt` contient « Vertical » : il **force la sortie verticale** même pour une vidéo horizontale (Build Video). Supprime-le pour suivre l'orientation de la vidéo.
- Les anciens scripts d'overlay OBS (`generate-overlay.mjs`, `templates/`, `docs/`) sont conservés mais ne sont plus lancés par le workflow.
