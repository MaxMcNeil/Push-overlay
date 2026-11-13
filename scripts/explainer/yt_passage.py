"""Passage d'une vidéo YouTube qui correspond le mieux à des mots-clés, d'après ses sous-titres (manuels ou automatiques).
Usage : python3 yt_passage.py VIDEO_ID '["mot1", "mot2"]'  ->  {"start": s, "end": s, "text": "..."} ou {} si impossible.
Ne lève jamais d'erreur : sous-titres absents ou bloqués -> {} (le workflow passe aux chapitres de la description)."""
import json
import re
import sys
import unicodedata


def norm(s):
    s = unicodedata.normalize("NFD", str(s).lower())
    s = "".join(c for c in s if not unicodedata.combining(c)).replace("ـ", "")
    return re.sub(r"[أإآٱ]", "ا", s).replace("ى", "ي")


def segments(vid):
    from youtube_transcript_api import YouTubeTranscriptApi
    langs = ["ar", "en", "fr", "it", "fa", "he", "ru", "es", "de"]
    try:                                   # API récente (objet)
        api = YouTubeTranscriptApi()
        tl = api.list(vid)
        try:
            t = tl.find_transcript(langs)
        except Exception:
            t = next(iter(tl))
        return [{"start": s.start, "duration": s.duration, "text": s.text} for s in t.fetch()]
    except AttributeError:                 # ancienne API (méthodes statiques)
        tl = YouTubeTranscriptApi.list_transcripts(vid)
        try:
            t = tl.find_transcript(langs)
        except Exception:
            t = next(iter(tl))
        return t.fetch()


def main():
    try:
        vid, keys = sys.argv[1], [norm(k) for k in json.loads(sys.argv[2]) if len(k) > 2]
        segs = segments(vid)
    except Exception:
        print("{}")
        return
    if not segs or not keys:
        print("{}")
        return
    best = None
    for i in range(len(segs)):               # fenêtre d'environ 60 s qui COMMENCE sur une phrase contenant un mot-clé
        if not any(k in norm(segs[i]["text"]) for k in keys):
            continue
        t0 = segs[i]["start"]
        txt, j = [], i
        while j < len(segs) and segs[j]["start"] - t0 <= 60:
            txt.append(segs[j]["text"])
            j += 1
        blob = norm(" ".join(txt))
        score = sum(1 for k in keys if k in blob) + 0.1 * sum(blob.count(k) for k in keys)
        if score > 0 and (best is None or score > best[0]):
            end = segs[j - 1]["start"] + segs[j - 1].get("duration", 3)
            best = (score, t0, end, " ".join(txt))
    if not best or best[0] < 2:              # au moins deux mots-clés différents : sinon on n'invente pas de minutage
        print("{}")
        return
    print(json.dumps({"start": round(best[1]), "end": round(best[2]), "text": re.sub(r"\s+", " ", best[3])[:300]}, ensure_ascii=False))


main()
