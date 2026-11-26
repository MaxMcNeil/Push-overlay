// War Room — 📻 Radios et émissions, étape 3 : des transcriptions aux sujets. Chaque émission est découpée en passages
// d'environ 90 s ; les passages les plus alarmants (guerre, attentat, scandale, effondrement, fuite, menace…) deviennent des
// sujets candidats, avec le passage MOT POUR MOT comme preuve et l'attribution exacte (« selon l'émission X du … »).
// Ils passent ensuite par le même tri, les mêmes vérifications et les mêmes règles que les autres sources. Sans IA (aucun quota).
import { readFileSync, readdirSync, existsSync } from "fs";

const ALARME = {
  fr: "guerre attaque attentat bombard missile drone frappe nucléaire invasion armée militaire otan explosion morts tués victimes massacre génocide crise effondrement faillite krach inflation pénurie scandale corruption fraude complot censure fuite révél secret mensonge menace alerte urgence danger catastrophe épidémie virus pandémie cyberattaque piratage arrestation emprisonn coup d'état émeute insurrection répression sanction embargo blocus otage terroris",
  en: "war attack strike bomb missile drone nuclear invasion troops military nato explosion killed dead casualties massacre genocide crisis collapse bankrupt crash inflation shortage scandal corruption fraud cover-up censorship leak leaked secret lie lied threat warning emergency danger disaster outbreak virus pandemic cyberattack hacked arrest jailed coup riot insurrection crackdown sanction embargo blockade hostage terror escalat",
  ar: "حرب هجوم قصف غارة صاروخ مسيرة نووي غزو جيش عسكري انفجار قتلى قتيل ضحايا مجزرة إبادة أزمة انهيار إفلاس تضخم نقص فضيحة فساد احتيال مؤامرة رقابة تسريب سري كذب تهديد تحذير طوارئ خطر كارثة وباء فيروس اختراق اعتقال سجن انقلاب احتجاج قمع عقوبات حصار رهائن إرهاب تصعيد",
};
const PUB = /sponsor|brought to you|promo code|discount|use code|code promo|abonnez|soutenez|patreon|tipeee|merch|إعلان/i;
const LEX = Object.fromEntries(Object.entries(ALARME).map(([k, v]) => [k, v.split(/\s+/)]));
const plat = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function score(t, langue) {
  const p = plat(t);
  let s = 0;
  for (const w of LEX[langue] || LEX.en) if (p.includes(plat(w))) s++;
  s += Math.min(2, (t.match(/\b\d[\d.,]*\s?(%|millions?|milliards?|billion|million|thousand|mille)\b/gi) || []).length);
  return s;
}

const fmtDate = (d, langue) => new Date(d).toLocaleDateString(langue === "en" ? "en-GB" : langue === "ar" ? "ar" : "fr-FR", { day: "numeric", month: "long" });

export function sujetsRadios(dossier = "output/warroom/ecoute/transcriptions", { parEpisode = 3, total = 45 } = {}) {
  if (!existsSync(dossier)) return [];
  const out = [];
  for (const f of readdirSync(dossier).filter((x) => x.endsWith(".json")).sort()) {
    let e; try { e = JSON.parse(readFileSync(`${dossier}/${f}`, "utf8")); } catch { continue; }
    const segs = e.segments || [];
    // passages d'environ 90 s
    const pass = [];
    for (const [t, x] of segs) { const last = pass[pass.length - 1]; if (!last || t - last.t0 >= 90) pass.push({ t0: t, txt: x }); else last.txt += " " + x; }
    const notes = pass.filter((p) => p.txt.length > 200 && !PUB.test(p.txt)).map((p) => ({ ...p, s: score(p.txt, e.langue) })).filter((p) => p.s >= 3)
      .sort((a, b) => b.s - a.s).slice(0, parEpisode);
    for (const p of notes) {
      const ph = p.txt.split(/(?<=[.!?؟])\s+/).filter((x) => x.length >= 40);
      const titre = (ph.sort((a, b) => score(b, e.langue) - score(a, e.langue))[0] || p.txt).slice(0, 220);
      const mm = `${Math.floor(p.t0 / 60)} min`;
      out.push({ titre, url: e.lien || "", source: `${e.media} (émission du ${fmtDate(e.date, "fr")}, à ${mm})`, date: e.date,
        resume: `Passage mot pour mot de l'émission « ${e.titre} » (${e.media}, transcription automatique) : « ${p.txt.slice(0, 1200)} »`,
        origine: "radio", langue: e.langue, emission: e.media, independant: true, _score: p.s });
    }
  }
  return out.sort((a, b) => b._score - a._score).slice(0, total).map(({ _score, ...x }) => x);
}

if (process.argv[1] && process.argv[1].endsWith("radios.mjs")) {
  const s = sujetsRadios(process.argv[2]);
  console.log(`${s.length} sujet(s) tiré(s) des radios et émissions :`);
  for (const x of s) console.log(`\n• [${x.langue}] ${x.source}\n  TITRE : ${x.titre}\n  ${x.resume.slice(0, 400)}…`);
}
