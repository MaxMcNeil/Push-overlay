#!/data/data/com.termux/files/usr/bin/bash
# Vérifie chaque chaîne de chaines.txt depuis le téléphone : l'adresse marche-t-elle ? sinon, que trouve la recherche par nom ?
L=$(curl -fsSL https://raw.githubusercontent.com/MaxMcNeil/Push-overlay/main/scripts/warroom/telephone/chaines.txt 2>/dev/null \
  || curl -fsSL https://raw.githubusercontent.com/MaxMcNeil/Push-overlay/radios/scripts/warroom/telephone/chaines.txt)
while IFS='|' read -r langue nom url; do
  nom=$(echo "$nom" | xargs); url=$(echo "$url" | xargs)
  case "$(echo "$langue" | xargs)" in fr|en|ar) ;; *) continue ;; esac
  t=$(timeout 90 yt-dlp --js-runtimes node --flat-playlist --playlist-end 1 --print "%(channel)s" "$url/videos" 2>/dev/null | head -1)
  if [ -n "$t" ]; then echo "OK  | $nom | $url | $t"; continue; fi
  q=$(printf '%s' "$nom" | jq -sRr @uri)
  r=$(timeout 90 yt-dlp --js-runtimes node --flat-playlist --playlist-end 1 --print "%(url)s|%(title)s" "https://www.youtube.com/results?search_query=$q&sp=EgIQAg%253D%253D" 2>/dev/null | head -1)
  echo "NEUF| $nom | ${r:-introuvable}"
done <<< "$L"
