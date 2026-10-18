/**
 * The words that carry meaning in a question, a claim or a passage, shared by the deterministic
 * research checks: comparing research questions, choosing a source's passages for a question, and
 * checking that a quote is about the claim it is offered for. Lexical only: it can say two texts
 * share their key words, never that one supports the other.
 */

const STOP_WORDS = new Set(
  (
    'a an the and or but of in on at to for from by with about as is are was were be been being do ' +
    'does did has have had what when where which who whom whose why how that this these those it its ' +
    'their there than then into over under any some such can could would should will may might more ' +
    'most much many also not no yes omenai story he she him her his they them we us our you your'
  ).split(' '),
);

/**
 * A light stem, so forms of one word meet ("reopening", "reopened" and "reopen"; "visitors" and
 * "visitor"). Deliberately crude: it only has to make the same word match itself.
 */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Lower-cased, accents, punctuation and filler removed, each word stemmed; "1,200" is "1200". */
export function meaningfulTerms(text: string): Set<string> {
  return new Set(
    withDigits(text)
      .replace(/(\d),(?=\d{3}\b)/g, '$1')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => (word.length > 1 || /^\d$/.test(word)) && !STOP_WORDS.has(word))
      .map(stem),
  );
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const NUMBER_WORD = new RegExp(
  `\\b(${Object.keys(NUMBER_WORDS).join('|')})(?:-(one|two|three|four|five|six|seven|eight|nine))?\\b`,
  'gi',
);

/**
 * Cardinal numbers written as words, as digits ("three weeks" → "3 weeks", "twenty-five" → "25"),
 * so a statement and its quote compare however each writes them. Left alone: "one" on its own
 * ("one of", "no one"), and number words in a name ("the Tondo of the Two Brothers").
 */
export function withDigits(text: string): string {
  return text.replace(
    NUMBER_WORD,
    (match: string, word: string, unit: string | undefined, at: number) => {
      const lower = word.toLowerCase();
      if (/^\p{Lu}/u.test(word)) {
        const opensSentence = /(^|[.!?:;“"(]\s*)$/.test(text.slice(0, at));
        const nameFollows = /^\s+\p{Lu}/u.test(text.slice(at + match.length));
        if (!opensSentence || nameFollows) return match;
      }
      if (lower === 'one' && !unit) return match;
      const tens = NUMBER_WORDS[lower]!;
      if (unit) return tens >= 20 && tens % 10 === 0 ? String(tens + NUMBER_WORDS[unit]!) : match;
      return String(tens);
    },
  );
}

/**
 * Terms that measure or place in time rather than say what is measured: numbers, units, months
 * and days. Two passages sharing only these ("three weeks", "in June") aren't about the same thing.
 */
const MEASURES = new Set(
  (
    'second minute hour day week weekend month year decade century centurie metre meter kilometre ' +
    'kilometer mile foot feet inch square percent cent per million billion thousand hundred dozen ' +
    'time january february march april june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday'
  ).split(' '),
);
export const isMeasure = (term: string) => /^\d[\d.]*$/.test(term) || MEASURES.has(term);

/** How many of `a`'s terms are also in `b`. */
export function sharedTerms(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared;
}

/** Lower-cased words with accents removed and nothing else dropped: for matching names exactly. */
export function plainWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1),
  );
}

/**
 * Culture and news words that never identify anything on their own ("museum", "festival",
 * "national"): a search result that shares only these with a story isn't about it, and a name made
 * only of them names nothing in particular.
 */
export const CULTURE_WORDS = new Set(
  `art arts artist artists artwork exhibition exhibitions show shows museum museums gallery galleries
  music musician musicians album design designer designers fashion festival festivals film films
  cinema culture cultural heritage history archive archives textile textiles craft crafts
  biennale biennial fair fairs market markets city cities new first last opens open opening reopens
  week weekend year years celebrates celebration award prize collection collective studio studios
  project centre center house home world global international national african africa women men
  people young youth contemporary modern classic street public private book books photo photos
  photography photographs portrait portraits story stories event events season`
    .split(/\s+/)
    .filter(Boolean),
);

/** Words naming a kind of institution or event rather than one ("Library", "Trust", "Awards"). */
const INSTITUTION_WORDS = new Set(
  (
    'library libraries foundation institute institution university college school trust council ' +
    'ministry company group theatre theater ballet orchestra opera academy society association ' +
    'press records magazine journal guide awards prizes architects partners'
  ).split(' '),
);

/** Whether a word of a name can tell one person, place or thing from another. */
const distinctiveName = (word: string) => !CULTURE_WORDS.has(word) && !INSTITUTION_WORDS.has(word);

/** Source labels ("[S2]") in a statement's text: not words of the statement. */
export const SOURCE_LABELS = /\[?\bS\d{1,3}\b\]?/gi;

/** Capitalised words that start sentences or clauses, or name months and days, rather than things. */
const NOT_NAMES = new Set(
  (
    'The A An In On At Its It Their His Her This That These Those He She They We I But And For With ' +
    'From By As Of To After Before During Since While When Where Who What Which Why How Some Many ' +
    'Most All There Here According However Yet Also Both Each Every Such One Our Your My If Once ' +
    'Although Though Despite Among Between Through Under Over Into Within Without Because So Then ' +
    'Now Today Recently Earlier Later Mr Mrs Ms Dr Did Does Do Is Are Was Were Has Have Can Could ' +
    'Would Should Will Whose Whom Not No Yes Please January February March April May June July ' +
    'August September October November December Monday Tuesday Wednesday Thursday Friday Saturday ' +
    'Sunday'
  ).split(' '),
);

/**
 * The names a text gives: capitalised words other than months, days, function words and generic
 * words ("Museum", "National"), as plain words. `lead` holds those that open a sentence, which may be names ("Okafor designed…") or
 * ordinary words ("Critics praised…"), so they can match a name but never show one is there.
 */
export function namesIn(text: string): { inner: Set<string>; lead: Set<string> } {
  const inner = new Set<string>();
  const lead = new Set<string>();
  for (const sentence of text
    .replace(SOURCE_LABELS, ' ')
    .replace(/[’']s\b/g, '')
    .split(/(?<=[.!?])\s+/)) {
    const first = sentence.trim().match(/^\P{L}*([\p{L}\p{N}'’-]+)/u)?.[1];
    for (const word of sentence.match(/\p{Lu}[\p{L}\p{N}'’-]*/gu) ?? []) {
      if (word.length < 2 || NOT_NAMES.has(word)) continue;
      for (const part of plainWords(word))
        if (distinctiveName(part)) (word === first ? lead : inner).add(part);
    }
  }
  return { inner, lead };
}

/**
 * Whether a passage opens by naming its subject ("The National Museum of Benin plans…", "Annabelle
 * Selldorf designed…") rather than describing it ("Specialists from Rome worked…", "It was…"). A
 * single capitalised word before a lowercase one is read as an ordinary sentence opening.
 */
export function opensWithName(passage: string): boolean {
  const words = passage.replace(/^\P{L}+/u, '').split(/\s+/);
  const article = /^(the|a|an)$/i.test(words[0] ?? '');
  const [first = '', next = ''] = article ? words.slice(1) : words;
  if (!/^\p{Lu}/u.test(first) || NOT_NAMES.has(first)) return false;
  return article || /^\p{Lu}/u.test(next);
}

/** "Africa" names what "African" does; a short name must match whole ("Met" isn't "method"). */
export const sameName = (a: string, b: string) =>
  a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Kinds of event a dated or counted statement can describe, across Omenai's territory (art,
 * design, architecture, fashion, music, film, books, performance, heritage and the market), each
 * with the everyday words that name it. A date answers a question, or contradicts another date,
 * only for the same kind of event: "joined" doesn't date "appointed", an announcement isn't an
 * opening, a nomination isn't a win, and "closed in 2021" doesn't contradict "reopened in 2025".
 *
 * Words too ambiguous to name an event are left out ("made", "found", the noun "issue", and
 * "prize" or "award" alone, which name a prize rather than winning it). An event
 * described in words not listed here names no kind, which the checks treat cautiously (a date
 * question it may answer is not taken as answered).
 */
const EVENT_KINDS: ReadonlyArray<readonly [kind: string, words: RegExp]> = [
  [
    'appointment',
    /\b(appoint\w*|nam(ed|es|ing)|bec(a|o)mes?|promot\w*|hir(e|ed|es|ing)|elect(ed|s|ion)?|(took|takes?|taken|taking) (up|over)|assum(e|ed|es|ing) the|elevat\w*|succeed\w*|tapped)\b/,
  ],
  ['joining', /\bjoin(ed|s|ing)?\b/],
  ['reopening', /\bre-?open\w*\b/],
  [
    'opening',
    /\b(open(ed|s|ing)?|inaugurat\w*|unveil\w*|debut\w*|premi[eè]r(e|ed|es|ing)|screened|screening|showcas\w*|runs? from)\b/,
  ],
  [
    'closing',
    /\b(clos(e|ed|es|ing|ure)|shut\w*|shutter\w*|until|(runs?|running|open|on view|on show|continues?) through)\b/,
  ],
  ['founding', /\b(founded|founding|co-?found\w*|establish\w*|set up|launch\w*)\b/],
  [
    'making',
    /\b(creat(ed|es|ing)|paint(ed|s|ing)|sculpt(ed|s)|compos(ed|es)|wrote|written|recorded|filmed|shot|designed|buil(t|ds|ding)|construct\w*|erect\w*)\b/,
  ],
  ['birth', /\b(born|birth)\b/],
  ['death', /\b(die[sd]?|death|passed away|killed)\b/],
  ['award', /\b(award(ed|ing)|w[oi]ns?|honou?red|receiv(ed|es))\b/],
  ['nomination', /\b(nominat\w*|shortlist\w*|longlist\w*|finalists?)\b/],
  ['announcement', /\b(announc\w*|revealed)\b/],
  [
    'release',
    /\b(publish\w*|releas\w*|issued|came out|comes out|hit (shelves|stores|cinemas|theaters|theatres)|launch\w*)\b/,
  ],
  [
    'acquisition',
    /\b(acquir\w*|acquisition|bought|buy\w*|purchas\w*|donat\w*|gift(ed)?|bequea\w*)\b/,
  ],
  ['sale', /\b(sold|sell\w*|auction\w*|fetch(ed|es)|hammer)\b/],
  [
    'departure',
    /\b(retir\w*|resign\w*|step(ped|s)? down|left|leav(e|es|ing)|depart\w*|quit|ousted|dismiss\w*|fired)\b/,
  ],
  ['completion', /\b(complet\w*|finish\w*)\b/],
  [
    'renovation',
    /\b(renovat\w*|restor\w*|rebuil\w*|refurbish\w*|expan(d|ded|ding|sion)|extension|overhaul\w*|redesign\w*)\b/,
  ],
  ['restitution', /\b(return(ed|s|ing)?|repatriat\w*|restitut\w*|handed back|hand(ed)? over)\b/],
  ['discovery', /\b(discover\w*|rediscover\w*|unearth\w*|excavat\w*)\b/],
  ['theft', /\b(stol(e|en)|theft|loot\w*)\b/],
  ['performance', /\b(perform\w*|concerts?|tour(ed|ing|s)?|staged|played)\b/],
  ['exhibition', /\b(exhibit\w*|on view|on show|on display|displayed)\b/],
  ['commission', /\bcommission\w*\b/],
  ['agreement', /\b(agree(d|s|ing)?|signed|signs|signing|agreement|deal|contract)\b/],
  ['relocation', /\b(relocat\w*|mov(ed|es|ing) to)\b/],
  ['cancellation', /\b(cancel\w*|postpon\w*|delay(ed|s)?)\b/],
  ['merger', /\bmerg(e|ed|er|es|ing)\b/],
  ['education', /\b(graduat\w*|studied|trained)\b/],
  ['marriage', /\b(marri(ed|age)|wed)\b/],
];

/**
 * Words that place something in time: month and weekday names ("May" only beside a number, so the
 * verb isn't one), and relative dates ("this week").
 */
const DATE_WORDS =
  /\b(january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow|tonight|(this|last|next) (week|weekend|month|year))\b|\bmay(?=\s+\d)|(?<=\d(st|nd|rd|th)?\s+)may\b/gi;

/** The date words a text gives, lower-cased. */
export function dateWordsIn(text: string): string[] {
  return [
    ...new Set((text.match(DATE_WORDS) ?? []).map((w) => w.toLowerCase().replace(/\s+/g, ' '))),
  ];
}

/** Whether a text gives a date: a year, or a date word. */
export function hasDate(text: string): boolean {
  return /\b(1\d{3}|20\d{2})s?\b/.test(text) || dateWordsIn(text).length > 0;
}

/** Runs of two or more capitalised words, with the small words names contain ("Museum of Art"). */
const NAME_RUN =
  /(?:\p{Lu}\.|\p{Lu}[\p{L}\p{N}'’-]*)(?:\s+(?:(?:of|the|and|&|de|du|des|la|le|for|von|van|da|di)\s+)*(?:\p{Lu}\.|\p{Lu}[\p{L}\p{N}'’-]*))+/gu;

/**
 * A text without its multi-word names. An event word inside a name ("Art Auction East Africa",
 * "the Grand Reopening Festival", "Kilimanjaro Prize") names an organisation or an event's title,
 * not the event a sentence is about. Single capitalised words are kept.
 */
export function withoutNames(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(NAME_RUN, ' '))
    .join(' ');
}

/** The kinds of event a text names ("appointment", "opening"…), outside the names it gives. */
export function eventsNamed(text: string): Set<string> {
  const lower = withoutNames(text).toLowerCase();
  return new Set(EVENT_KINDS.filter(([, words]) => words.test(lower)).map(([kind]) => kind));
}
