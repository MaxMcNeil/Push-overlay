# État — Push-overlay

Ce qui bloque, pourquoi, quand ça se débloque et quoi faire.

<!-- workflows:start -->
## Workflows

_Vérifié le 25/10/2026 à 10:22 (heure italienne), automatiquement à la fin de chacun de tes lancements (aucune exécution planifiée)._

- ❌ **Build Overlay** : dernier lancement en échec (22/10 à 18:58, failure), 6 échecs d'affilée · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/39818461203)
  - **Cause** : erreur dans le programme (pas un problème de quota ni de clé) (étape « build → Extraction des accroches »)
  - **Quoi faire** : à corriger dans le code : transmets la ligne d'erreur ci-dessous
  - Message : `Error: Aucune phrase exploitable trouvée dans le transcript.`
- ✅ **Build Video** : dernier lancement réussi (22/10 à 19:38) · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/39818527178)
- ✅ **Ranger les releases** : dernier lancement réussi (24/10 à 20:22) · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/40120369392)
- ❌ **Video to Shorts** : dernier lancement en échec (25/10 à 10:22, failure) — dernier succès le 24/10 à 20:16 · [voir](https://github.com/MaxMcNeil/Push-overlay/actions/runs/40178138243)
  - **Cause** : le travail a dépassé le temps maximum (étape « select → Choisir les meilleurs passages »)
  - **Quoi faire** : relance ; si ça se répète, la vidéo/le traitement est trop long
  - Message : `##[error]The action 'Choisir les meilleurs passages' has timed out after 30 minutes.`

<!-- workflows:end -->
