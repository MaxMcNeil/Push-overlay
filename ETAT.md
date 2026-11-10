# État — Push-overlay

Ce qui bloque, pourquoi, quand ça se débloque et quoi faire.

<!-- workflows:start -->
## Workflows

_Vérifié le 10/11/2026 à 20:35 (heure italienne), automatiquement à la fin de chacun de tes lancements (aucune exécution planifiée)._

- ❌ **Build Overlay** : désactivé (disabled_manually)
  - **Quoi faire** : Actions → ce workflow → « Enable workflow »
- ❌ **Build Video** : dernier lancement en échec (10/11 à 20:35, failure) — dernier succès le 10/11 à 17:56 · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/42886686629)
  - **Cause** : un fichier, une Release ou une ressource attendue est introuvable (étape « lister → Vidéos de la release »)
  - **Quoi faire** : vérifie le nom / le lien du fichier fourni au workflow
  - Message : `Included Software: https://github.com/actions/runner-images/blob/ubuntu24/20261101.360/images/ubuntu/Ubuntu2404-Readme.md`
- ✅ **test-musique-shorts** : dernier lancement réussi (08/11 à 12:05) · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/42474064872)
- ✅ **Ranger les releases** : dernier lancement réussi (24/10 à 20:22) · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/40120369392)
- ✅ **Video to Shorts** : dernier lancement réussi (10/11 à 12:26) · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/42805086072)

<!-- workflows:end -->
