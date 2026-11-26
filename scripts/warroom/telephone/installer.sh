#!/data/data/com.termux/files/usr/bin/bash
# Installation (une seule fois) de l'agent d'écoute YouTube du téléphone. Relançable sans risque : il remplace simplement
# l'installation précédente. Pour tout arrêter : bash ~/.ecoute/arreter.sh
# Fonctionne avec le Termux de Google Play (sans Termux:API) : une boucle en arrière-plan, relancée toute seule à l'ouverture de Termux.
set -e
REPO="MaxMcNeil/Push-overlay"
echo "1/4 Outils (python, ffmpeg, node, jq, gh)…"
pkg install -y python ffmpeg nodejs jq gh coreutils findutils curl procps >/dev/null
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
echo "4/4 Lancement automatique toutes les 6 h…"
# boucle : un passage, puis 6 h d'attente. Une seule boucle à la fois.
cat > "$HOME/.ecoute/boucle.sh" <<'B'
#!/data/data/com.termux/files/usr/bin/bash
while true; do bash "$HOME/.ecoute/lanceur.sh" >/dev/null 2>&1; sleep 21600; done
B
cat > "$HOME/.ecoute/demarrer.sh" <<'S'
#!/data/data/com.termux/files/usr/bin/bash
pgrep -f "ecoute/boucle.sh" >/dev/null 2>&1 || nohup bash "$HOME/.ecoute/boucle.sh" >/dev/null 2>&1 &
S
cat > "$HOME/.ecoute/arreter.sh" <<'A'
#!/data/data/com.termux/files/usr/bin/bash
pkill -f "ecoute/boucle.sh"; sed -i '/ecoute\/demarrer.sh/d' "$HOME/.bashrc" 2>/dev/null; echo "Agent d'écoute arrêté."
A
chmod +x "$HOME/.ecoute/"*.sh
# relancée toute seule à chaque ouverture de Termux (après un redémarrage du téléphone, par exemple) — jamais en double
touch "$HOME/.bashrc"
grep -q "ecoute/demarrer.sh" "$HOME/.bashrc" || echo 'bash "$HOME/.ecoute/demarrer.sh" >/dev/null 2>&1' >> "$HOME/.bashrc"
pkill -f "ecoute/boucle.sh" 2>/dev/null || true
bash "$HOME/.ecoute/demarrer.sh"
echo "✓ Installé. Premier passage lancé maintenant en arrière-plan ; ensuite toutes les 6 h, sans rien toucher."
echo "  Après un redémarrage du téléphone, il suffit d'ouvrir Termux une fois : l'agent repart tout seul."
