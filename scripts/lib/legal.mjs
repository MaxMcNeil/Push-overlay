// Textes de l'écran de fin et des mentions de protection juridique (Build Video), par langue.
// Langues : fr, ar (arabe littéraire), en, it. Langue inconnue → anglais (jamais un texte dans une autre langue que la
// vidéo… sauf faute de traduction : l'anglais est le plus compris).
// Les mentions sont VOLONTAIREMENT courtes (≤ ~110 caractères) : lues en 3 s, sans couper le bandeau.

export const OUTRO = {
  fr: { title: "Merci de nous avoir suivis", sub: "Abonnez-vous et activez la cloche", note: "La suite très bientôt sur la chaîne" },
  ar: { title: "شكرًا لمتابعتكم", sub: "اشتركوا في القناة وفعّلوا الجرس", note: "انتظروا المزيد قريبًا على القناة" },
  en: { title: "Thank you for watching", sub: "Subscribe and turn on notifications", note: "More coming soon on the channel" },
  it: { title: "Grazie per averci seguito", sub: "Iscriviti e attiva la campanella", note: "Il seguito a breve sul canale" },
};

export const LEGAL_KICKER = { fr: "MENTION LÉGALE", ar: "تنبيه قانوني", en: "LEGAL NOTICE", it: "NOTA LEGALE" };

export const LEGAL = {
  fr: [
    "Ce contenu relaie des informations déjà rendues publiques par leurs auteurs.",
    "Nous n'affirmons ni ne démentons les propos rapportés dans cette vidéo.",
    "Chaîne neutre : nous ne prenons parti pour aucune personne ni aucun camp.",
    "Droit de réponse garanti : toute personne citée peut nous contacter.",
    "Les propos tenus dans cette vidéo n'engagent que leurs auteurs.",
    "La chaîne n'assume aucune responsabilité quant aux opinions exprimées.",
    "Diffusé dans le cadre de la liberté d'expression et du droit à l'information.",
    "Contenu diffusé dans le respect des lois de chaque pays où il est visible.",
    "Toute personne mise en cause est présumée innocente jusqu'à décision de justice.",
    "Présenté à titre purement informatif, sans aucune prise de position.",
    "Une erreur ou une inexactitude ? Signalez-la : nous la rectifierons.",
    "Les sources d'origine restent seules responsables de leur contenu.",
    "Vérifiez toujours ces informations auprès de plusieurs sources.",
    "La chaîne ne porte aucune accusation à l'encontre de quiconque.",
    "Ce contenu n'est ni un conseil, ni une incitation, ni un jugement.",
    "Liberté d'expression : article 19 de la Déclaration universelle des droits de l'homme.",
    "Nous respectons la vie privée, la dignité et la réputation de chacun.",
    "Les opinions exprimées ne reflètent pas nécessairement celles de la chaîne.",
    "Toute demande de correction ou de retrait sera examinée avec attention.",
    "Contenu public relayé à des fins d'information et de débat.",
  ],
  ar: [
    "يعرض هذا المحتوى معلومات سبق أن نشرها أصحابها للعموم.",
    "نحن لا نؤكد ولا ننفي الأقوال الواردة في هذا الفيديو.",
    "قناة محايدة: لا ننحاز إلى أي شخص أو أي طرف.",
    "حق الرد مكفول: يمكن لكل شخص مذكور التواصل معنا.",
    "الأقوال الواردة في هذا الفيديو لا تلزم إلا أصحابها.",
    "لا تتحمل القناة أي مسؤولية عن الآراء المعبَّر عنها.",
    "يُبث هذا المحتوى في إطار حرية التعبير والحق في المعلومة.",
    "يُبث هذا المحتوى مع احترام قوانين كل بلد يُشاهَد فيه.",
    "كل شخص متهم بريء حتى تثبت إدانته بحكم قضائي.",
    "يُقدَّم هذا المحتوى لغرض إعلامي بحت دون أي موقف.",
    "هل لاحظتم خطأً أو معلومة غير دقيقة؟ نبهونا لنصححها.",
    "تبقى المصادر الأصلية وحدها مسؤولة عن محتواها.",
    "تحققوا دائمًا من هذه المعلومات من مصادر متعددة.",
    "لا توجه القناة أي اتهام إلى أي شخص.",
    "هذا المحتوى ليس نصيحة ولا تحريضًا ولا حكمًا.",
    "حرية التعبير: المادة 19 من الإعلان العالمي لحقوق الإنسان.",
    "نحترم الحياة الخاصة وكرامة الجميع وسمعتهم.",
    "الآراء المعبَّر عنها لا تعكس بالضرورة رأي القناة.",
    "كل طلب تصحيح أو حذف سيُدرس بعناية.",
    "محتوى منشور للعموم يُعرض لغرض الإعلام والنقاش.",
  ],
  en: [
    "This content relays information already made public by its authors.",
    "We neither confirm nor deny the statements reported in this video.",
    "Neutral channel: we take no side for any person or group.",
    "Right of reply guaranteed: anyone mentioned may contact us.",
    "The statements in this video are the sole responsibility of their authors.",
    "The channel assumes no responsibility for the opinions expressed.",
    "Published under freedom of expression and the right to information.",
    "Published in compliance with the laws of every country where it is viewed.",
    "Anyone accused is presumed innocent until proven guilty in court.",
    "Presented for information purposes only, without taking any position.",
    "Spotted an error or inaccuracy? Tell us and we will correct it.",
    "Original sources remain solely responsible for their content.",
    "Always check this information against several sources.",
    "The channel makes no accusation against anyone.",
    "This content is not advice, incitement or a judgement.",
    "Freedom of expression: Article 19 of the Universal Declaration of Human Rights.",
    "We respect everyone's privacy, dignity and reputation.",
    "Opinions expressed do not necessarily reflect those of the channel.",
    "Any request for correction or removal will be carefully reviewed.",
    "Public content relayed for information and debate.",
  ],
  it: [
    "Questo contenuto riporta informazioni già rese pubbliche dai loro autori.",
    "Non confermiamo né smentiamo le dichiarazioni riportate in questo video.",
    "Canale neutrale: non ci schieriamo con nessuna persona né parte.",
    "Diritto di replica garantito: chiunque sia citato può contattarci.",
    "Le dichiarazioni di questo video impegnano solo i loro autori.",
    "Il canale non si assume alcuna responsabilità per le opinioni espresse.",
    "Diffuso nell'ambito della libertà di espressione e del diritto all'informazione.",
    "Diffuso nel rispetto delle leggi di ogni paese in cui è visibile.",
    "Ogni persona accusata è presunta innocente fino a sentenza definitiva.",
    "Presentato a solo scopo informativo, senza alcuna presa di posizione.",
    "Un errore o un'imprecisione? Segnalacelo e lo correggeremo.",
    "Le fonti originali restano le sole responsabili del loro contenuto.",
    "Verifica sempre queste informazioni presso più fonti.",
    "Il canale non muove alcuna accusa nei confronti di nessuno.",
    "Questo contenuto non è un consiglio, né un'istigazione, né un giudizio.",
    "Libertà di espressione: articolo 19 della Dichiarazione universale dei diritti umani.",
    "Rispettiamo la privacy, la dignità e la reputazione di tutti.",
    "Le opinioni espresse non riflettono necessariamente quelle del canale.",
    "Ogni richiesta di rettifica o rimozione sarà esaminata con attenzione.",
    "Contenuto pubblico riportato a scopo di informazione e dibattito.",
  ],
};

export const TICKER_LABEL = { fr: "À SAVOIR", ar: "تنبيه", en: "NOTICE", it: "AVVISO" };

const pick = (tbl, lang) => tbl[lang] || tbl.en;
export const outroText = (lang) => pick(OUTRO, lang);
export const legalKicker = (lang) => pick(LEGAL_KICKER, lang);
export const tickerLabel = (lang) => pick(TICKER_LABEL, lang);

// mentions pour n passages : ordre mélangé (graine propre à la vidéo), JAMAIS deux fois la même tant que la liste
// n'est pas épuisée ; au-delà (vidéo de plus de 20 min), nouveau tour mélangé sans répéter la dernière mention.
export function legalSequence(lang, n, seedStr = "") {
  const pool = pick(LEGAL, lang);
  let s = 2166136261;
  for (const ch of String(seedStr)) s = Math.imul(s ^ ch.codePointAt(0), 16777619) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const out = [];
  while (out.length < n) {
    const deck = pool.slice();
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    if (out.length && deck[0] === out[out.length - 1]) deck.push(deck.shift());
    out.push(...deck);
  }
  return { list: out.slice(0, n), cycled: n > pool.length, size: pool.length };
}
