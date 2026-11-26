#!/data/data/com.termux/files/usr/bin/bash
# Installation (une seule fois) de l'agent d'écoute YouTube du téléphone. Relançable sans risque : il remplace simplement
# l'installation précédente. Pour tout arrêter : termux-job-scheduler --cancel --job-id 4242
set -e
REPO="MaxMcNeil/Push-overlay"
echo "1/4 Outils (python, ffmpeg, node, jq, gh, termux-api)…"
pkg install -y python ffmpeg nodejs jq gh termux-api coreutils findutils curl >/dev/null
echo "2/4 yt-dlp…"
pip install -q -U "yt-dlp[default]"
mkdir -p "$HOME/.ecoute"
echo "3/4 Agent d'écoute…"
# le lanceur reprend à chaque passage la dernière version de l'agent depuis le dépôt (corrections sans rien toucher ici) ;
# dépôt injoignable : la dernière version déjà téléchargée est utilisée
cat > "$HOME/.ecoute/lanceur.sh" <<'L'
#!/data/data/com.termux/files/usr/bin/bash
R="https://raw.githubusercontent.com/MaxMcNeil/Push-overlay"
for b in main radios; do
  curl -fsSL "$R/$b/scripts/warroom/telephone/ecoute.sh" -o "$HOME/.ecoute/ecoute.new" 2>/dev/null && head -1 "$HOME/.ecoute/ecoute.new" | grep -q bash && mv "$HOME/.ecoute/ecoute.new" "$HOME/.ecoute/ecoute.sh" && break
done
rm -f "$HOME/.ecoute/ecoute.new"
[ -f "$HOME/.ecoute/ecoute.sh" ] && exec bash "$HOME/.ecoute/ecoute.sh"
L
chmod +x "$HOME/.ecoute/lanceur.sh"
gh auth status >/dev/null 2>&1 || { echo "⚠ gh n'est pas connecté : lance « gh auth login » puis relance cette installation."; exit 1; }
command -v termux-job-scheduler >/dev/null || { echo "⚠ installe l'application Termux:API (même source que Termux), puis relance."; exit 1; }
echo "4/4 Lancement automatique toutes les 6 h (survit au redémarrage)…"
termux-job-scheduler --cancel --job-id 4242 >/dev/null 2>&1 || true
termux-job-scheduler --job-id 4242 --script "$HOME/.ecoute/lanceur.sh" --period-ms 21600000 --persisted true --network any >/dev/null
nohup "$HOME/.ecoute/lanceur.sh" >/dev/null 2>&1 &
echo "✓ Installé. Premier passage lancé maintenant en arrière-plan ; ensuite toutes les 6 h, sans rien toucher."
