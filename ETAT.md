# État — Push-overlay

Ce qui bloque, pourquoi, quand ça se débloque et quoi faire.

<!-- workflows:start -->
## Workflows

_Vérifié le 30/10/2026 à 19:17 (heure italienne), automatiquement à la fin de chacun de tes lancements (aucune exécution planifiée)._

- ❌ **Build Overlay** : dernier lancement en échec (30/10 à 19:17, failure), 10 échecs d'affilée · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/41105546644)
  - **Cause** : erreur dans le programme (pas un problème de quota ni de clé) (étape « build »)
  - **Quoi faire** : à corriger dans le code : transmets la ligne d'erreur ci-dessous
  - Message : `Error: Aucune phrase exploitable trouvée dans le transcript.`
- ❌ **Build Video** : dernier lancement en échec (30/10 à 19:17, failure) — dernier succès le 30/10 à 18:59 · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/41105604646)
  - **Cause** : un fichier, une Release ou une ressource attendue est introuvable (étape « lister »)
  - **Quoi faire** : vérifie le nom / le lien du fichier fourni au workflow
  - Message : `Included Software: https://github.com/actions/runner-images/blob/ubuntu24/20261025.353/images/ubuntu/Ubuntu2404-Readme.md`
- ✅ **Ranger les releases** : dernier lancement réussi (24/10 à 20:22) · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/40120369392)
- ✅ **Video to Shorts** : dernier lancement réussi (30/10 à 12:41) · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/41048171640)

<!-- workflows:end -->
