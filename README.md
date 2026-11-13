# Push-overlay — vidéo brute → vidéo finale montée (+ Shorts)

## 📥 Déposer une vidéo puis lancer (mémo)

**Rien ne se lance tout seul** : déposer une vidéo, une photo ou un logo ne déclenche aucun workflow. Deux étapes :
1. **Déposer** : *Releases → Draft a new release* → **nouveau** tag (ex. `video-002`, `shorts-002` ; ne réutilise jamais
   un ancien tag) → joins la ou les vidéos → *Publish*.
2. **Lancer** : *Actions* → le workflow voulu → *Run workflow* :

| Je veux… | Workflow | Champ à remplir | Résultat |
|---|---|---|---|
| **la vidéo entière montée** | **Build Video** | `release` = ton tag (vide = la plus récente) · `format` = auto / vertical / horizontal | release **🎬 RÉSULTAT — Vidéo montée** |
| **des Shorts** | **Video to Shorts** | `source` = ton tag **ou** un lien Google Drive | release **✂️ RÉSULTAT — Shorts** |

Ta release affiche l'état dans son titre : **⏳ EN COURS** → **✅ TERMINÉ** ou **❌ ÉCHEC** (avec le lien).
Plusieurs vidéos dans une release → montées séparément, en parallèle. Chaque nouveau résultat remplace le précédent.
Seule exception au lancement manuel : la chaîne fond vert → Montage LV final → Shorts (lancée par Montage LV final).

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
- **Logo selon la langue (règle stricte)** : le logo vient du dossier `chaines/` de **Montage-LV-final** (source unique :
  change le logo là-bas, Build Video et les Shorts suivent ; copie de secours dans `chaines/` ici). Vidéo en arabe →
  logo de la chaîne arabe, en français → logo français ; **aucune chaîne dans la langue de la vidéo (ex. italien,
  anglais) → aucun logo**, jamais celui d'une autre langue. Short tiré d'un montage vertical qui porte déjà son petit
  logo → pas de 2e petit logo (le grand logo de l'écran de fin reste). L'interface se met en miroir pour l'arabe.
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
Chaque nouveau résultat **remplace** le précédent : Build Video garde dans la release « renders » les vidéos du dernier lot seulement, Video to Shorts une seule
release « out-shorts » (et un seul dossier Drive `…/derniers`). Les anciennes vidéos déposées sont supprimées après traitement (on garde
la dernière). Les Artifacts des runs sont gardés 3 jours (1 jour pour les passages intermédiaires).

### 🔗 Chaîne automatique (fond vert → montage → shorts)

Lancé tout seul par Montage LV final quand le fond vert a été lancé avec **enchainer** : la vidéo arrive par Google
Drive (privé, secret `RCLONE_CONF` requis, même compte Google que les autres dépôts), les shorts vont dans une
release à part **`out-chaine-<id>`**, supprimée après 2 jours. `out-shorts` et le dossier Drive « derniers » ne sont
jamais touchés. Rien à configurer ici en plus de `RCLONE_CONF`. Guide complet : README de
vdo-BACKGROUND-replace-GREEN-, section « Chaîne ».

**Sous-titres des Shorts lancés par la chaîne** (fond vert ou Montage LV final) : le choix fait au lancement est
respecté (`non` = aucun sous-titre). Lancement à la main : inchangé.

### 🎵 Musique de fond retirée dans les Shorts (lancement à la main)

Video to Shorts lancé **à la main** : chaque passage passe par le même outil que Build Video (Demucs). S'il y a de la
musique, même 1 seconde ou en continu du début à la fin, le son du short est remplacé par la voix seule (image et synchro
intactes) ; sinon le son d'origine est gardé. Garde-fous : en cas de souci (installation, résultat tronqué…), le short
est quand même rendu avec son son d'origine et un avertissement s'affiche dans le résumé. Shorts lancés **par la
chaîne** (fond vert → Montage) : inchangés. Testé : musique continue ajoutée sur un vrai passage → −28 dB sur la
musique, voix au même niveau, durée identique.

### ⚖️ Protection juridique et écran de fin (Build Video)

- **Protection juridique** (option au lancement, `non` par défaut) : sur `oui`, une mention de **3 s dès la 1re seconde puis chaque minute**
  (0:01, 1:01, 2:01…) se pose sur le bandeau de titre, jamais sur la vidéo ni le visage. Texte **dans la langue de la vidéo**
  (fr, ar en arabe littéraire, en, it) : contenu déjà public, ni affirmation ni démenti, neutralité, droit de réponse,
  propos n'engageant que leurs auteurs, liberté d'expression, respect des lois de chaque pays… 20 mentions par langue,
  ordre mélangé propre à chaque vidéo, **jamais deux fois la même** (au-delà de 20 min la liste recommence, jamais deux
  fois de suite la même). Textes : `scripts/lib/legal.mjs`.
- **Aussi dans Video to Shorts** (option « protection_juridique » au lancement **à la main uniquement** — la chaîne
  automatique fond vert → Montage → Shorts n'est jamais concernée) : même règle (0:01, 1:01, 2:01…, jamais pendant
  l'écran d'abonnement), carte posée dans la zone de l'étiquette, hors visage et hors interface YouTube ; l'accroche se
  range alors dans la zone des puces et le petit logo s'efface le temps de la mention.
- **Écran de fin** (toutes langues, tous formats) : 4,5 s ajoutées APRÈS la vidéo (aucune parole coupée) — fond flouté
  et assombri, logo de la chaîne de la langue (aucun logo si la chaîne n'existe pas encore : en/it), nom de la chaîne,
  « Merci de nous avoir suivis » + invitation à s'abonner, carillon discret, fondu au noir.
- **Bandeau défilant** : texte plus grand, défilement plus lent (lisible sur téléphone), étiquette fixe « À SAVOIR »
  (« تنبيه » en arabe, défilement de gauche à droite comme les bandeaux d'info arabes).

### 🖼 Format de sortie (Build Video) : vertical ou horizontal
- **Automatique** (par défaut) : même orientation que ta vidéo.
- **Au choix**, quelle que soit ta vidéo d'entrée :
  - lancement à la main : *Actions → Build Video → Run workflow* → menu **format** (`auto`, `vertical`, `horizontal`) ;
  - par release : mets **vertical** (ou portrait, 9:16) ou **horizontal** (ou paysage, 16:9) dans le **titre** ou le tag
    (ex. titre « Interview — vertical »). Rien → automatique. Les deux à la fois → automatique (avertissement).
- **Cas croisés, mises en page dédiées** :
  - vidéo verticale → sortie horizontale : grande colonne au centre ; à chaque idée elle glisse sur le côté et la carte
    d'analyse occupe le reste (format plateau télé) ;
  - vidéo horizontale → sortie verticale : visage détecté → **recadrage 4:5 centré sur la personne** ; pas de visage
    (écran, diapos, paysage) → image entière, et la carte d'analyse apparaît **sous** la vidéo.
- Le nom du fichier final se termine par `-vertical` ou `-horizontal`, et le résumé du run indique le format choisi.
- Il n'y a plus de réglage caché : l'ancien fichier `content/orientation.txt`, qui forçait le vertical, est supprimé.

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
- Les anciens scripts d'overlay OBS (`generate-overlay.mjs`, `templates/`, `docs/`) sont conservés mais ne sont plus lancés par le workflow.

## Faceless live arabic (un fichier voix → une vidéo animée)

Tu donnes **seulement ta voix** ; le workflow fabrique une vidéo « explainer » haut de gamme : accroche, titres, citations,
chiffres, frises, listes, face-à-face, carte de fin — sans musique, **sans aucun emoji**, textes grands et lisibles.

**Déposer** : *Releases → Draft a new release* → tag qui commence par **`voix`** (ex. `voix-001`) → joins :
- **la voix** — **n'importe quel nom**, le workflow la reconnaît : fichier son (mp3, m4a, wav, ogg, opus…) en priorité, sinon
  la vidéo à image fixe ou la plus longue (un enregistrement d'écran de téléphone n'est jamais pris pour ta voix). Le choix
  et sa raison sont notés en tête d'`EXPLAINER.md` (avertissement s'il n'est pas net). Les **autres fichiers son**
  (discours, déclaration…) deviennent des extraits « onde sonore » à faire écouter avec « اسمعوا » ;
- *(facultatif)* **captures d'écran / photos** : **toutes** sont insérées, recadrées (barres du téléphone, menus retirés)
  et placées au moment où tu en parles ; s'il y en a plus que de scènes, elles s'enchaînent en fondu ;
- *(facultatif)* **vidéos** — y compris des **enregistrements d'écran BRUTS du téléphone** : le workflow recadre sur le lecteur
  vidéo (barre d'état, titre, commentaires, boutons, barre de navigation retirés) et coupe le début et la fin hors vidéo
  (ouverture de l'appli, défilement, arrêt de l'enregistrement) ; si le mouvement ne suffit pas à repérer le lecteur, l'IA le
  repère sur l'image. Une vidéo normale n'est pas touchée. Montrées (sans leur son) pendant que tu parles. **Mot déclencheur** — si tu dis
  « إسمع / إسمعوا / استمع / استمعوا (جيدا، معي) / خلينا نسمع » (ou « écoutez », « listen », « ascoltate »), une vidéo
  est jouée **avec son son** ; ta voix attend, puis reprend. **La vidéo est choisie d'après son contenu** : ce que tu dis juste
  avant le mot déclencheur est comparé au début de chaque vidéo (transcrit par Groq) et à son nom de fichier (un appel IA).
  Repli : mots communs, puis ordre des noms de fichiers. Le plan (`EXPLAINER.md`) dit pour chaque vidéo comment elle a été choisie.

- **Source affichée** : sous chaque capture, photo ou vidéo, « المصدر : … » (média, agence, chaîne) — lue sur l'image (logo, URL,
  nom de la chaîne) ou dans le **nom du fichier** (ex. `reuters-ministre.jpg`, `aljazeera-interview.mp4`). Jamais inventée.

**Lancer** : *Actions → Faceless live arabic → Run workflow*.

**Recherche pour le montage** (champ `recherche`) : le workflow lit ta voix, repère les moments forts et écrit
**`download search pour montages.txt`** (GitHub l'affiche « download.search.pour.montages.txt ») : pour chaque moment, avec son
minutage dans ta voix — les **vidéos YouTube** à filmer en enregistrement d'écran, avec un lien qui démarre au **bon passage**
(trouvé dans les sous-titres de la vidéo, sinon dans ses chapitres ; sinon les mots à chercher), les **articles de presse**
(titre, média, date, lien) et des **photos libres de droits** (Wikimedia Commons) **téléchargées** dans la release
**🔎 RECHERCHE** (`out-recherche`), crédits compris. Pour les monter : champ `photos` = `out-recherche`. Les photos de presse ne
sont pas téléchargées (droits d'auteur : risque de réclamation) — leurs articles sont en lien.
`oui` (défaut) : recherche + montage (le fichier est aussi joint au résultat) ; `seule` : recherche sans montage (tu filmes les
passages, tu les déposes, puis tu relances avec `non`). Vidéos YouTube : secret `YOUTUBE_API_KEYS` (même clé que dans
OSINT-teleprompter). IA : Groq (jamais la clé Gemini pour la recherche). Une recherche en panne n'empêche jamais le montage.

| Champ | Rôle |
|---|---|
| `source` | tag de la release (vide = la dernière `voix…`) ou lien Google Drive du fichier voix |
| `format` | vertical, horizontal ou **les deux** (une seule transcription et un seul passage IA pour les deux) |
| `qualite` | 1080, 1440 ou 2160 (4K, environ 4 fois plus long) |
| `pays` | `auto` : un seul pays du Golfe dans la voix → ses couleurs (sa, ae, qa, kw, om, bh) ; plusieurs → palette Golfe bleu nuit + or. Une scène consacrée à un pays prend ses accents |
| `photos` | tag d'une autre release de captures / photos / vidéos (facultatif) |
| `voix` | **radio** (défaut) : son de studio d'émission — grave chaleureux, présence, sifflantes adoucies, compression, souffle réduit ; `naturel` : nettoyage seul. Les vidéos « à écouter » gardent leur son d'origine |
| `effets_sonores` | discret (défaut), normal, non — synthétisés, aucun droit d'auteur |
| `mots_declencheurs` | oui / non |
| `recherche` | oui (recherche + montage), seule (recherche sans montage), non |
| `nettoyage_medias` | oui : 30 min après un run **réussi**, les captures / photos / vidéos déposées sont supprimées (la voix reste ; rien n'est supprimé si le run a échoué, si tu as changé les fichiers entre-temps ou si un autre montage attend) |

**Résultat** : release **🎙️ RÉSULTAT — Faceless live arabic** (`out-explainer`, remplace la précédente) + le plan scène par scène
(`EXPLAINER.md`). Logo : règle habituelle (chaîne de la langue de la voix, sinon aucun).

**Fiche YouTube** : le workflow écrit aussi le **titre** (provocateur, fidèle à la voix), la **description**, les **tags**
(séparés par des virgules, dans la description) et les **hashtags** → fichier `youtube-metadata.txt` joint au résultat et
affiché en tête du plan. Écrite dans le même appel IA que le plan quand la voix est courte, sinon un seul petit appel de
plus. Le workflow `Prerecorded_Live_Now` de liveYOUTUBE-AUTO la met directement sur le direct. Pour la corriger avant le
live : remplace le fichier dans la release `out-explainer` (même nom, lignes `Titre:` puis `Description :`).

**Sécurités** : rien n'est affiché qui ne soit dit dans la voix (un chiffre ou une date absents de la transcription sont
refusés) ; sans IA disponible, les phrases prononcées s'affichent mot pour mot (le montage sort toujours) ; un texte trop
long est réduit automatiquement, jamais coupé hors de l'écran ; une tranche de rendu qui échoue est refaite seule.
**Clés dédiées (facultatif)** : secrets `EXPLAINER_GEMINI_API_KEY`, `EXPLAINER_GROQ_API_KEY` et `EXPLAINER_YOUTUBE_API_KEY` (recherche). Si une clé dédiée existe, ce
workflow n'utilise qu'elle pour ce fournisseur ; sinon il prend les clés habituelles du dépôt. Attention : les quotas gratuits
sont comptés par projet Google (Gemini) et par compte (Groq), pas par clé.
Clés IA utilisées : Groq (transcription), puis **un** appel pour le plan et **un** appel Gemini pour tous les médias.
**Voix longues (1 h et plus, jusqu'à 3 h)** : le plan IA est demandé par blocs d'environ 10 min (un bloc refusé n'arrête
rien), puis le rendu est réparti sur plusieurs machines en parallèle (une par tranche de 4 min) et réassemblé. Le débit est
ajusté pour que chaque fichier reste sous la limite de 2 Go des releases. Si une tranche échoue : *Re-run failed jobs*
ne refait que celle-là (ni la transcription ni l'IA ne sont relancées).
