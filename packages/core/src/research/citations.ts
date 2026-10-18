import type { CITATION_STATUSES, CLAIM_TYPES } from '../db/models/research-brief.js';
import {
  dateWordsIn,
  eventsNamed,
  isMeasure,
  meaningfulTerms,
  namesIn,
  opensWithName,
  plainWords,
  sameName,
  sharedTerms,
  SOURCE_LABELS as LABELS,
  withDigits,
} from './terms.js';

/**
 * Citation checks for every statement Omenai writes: research briefs, focused follow-ups, chat
 * replies and drafts all pass through `checkClaims`. Everything is decided against the persisted
 * source records, never against the model's own account: a label must name a source in this set,
 * and an evidence excerpt must be found in that source's stored text.
 *
 * Each check here can only lower a statement's status. None of them, alone or together, shows that
 * a passage supports a statement: a found quote shows where a statement came from, and a quote that
 * passes every check can still say something else. That judgement stays the editor's, with each
 * quote shown beside its statement.
 */

export type ClaimType = (typeof CLAIM_TYPES)[number];
export type CitationStatus = (typeof CITATION_STATUSES)[number];

export interface CitableSource {
  label: string;
  id: string;
  /** The stored text (extracted content, or the snippet when the page couldn't be read). */
  text: string;
}

/** Excerpts shorter than this can't establish anything, so they never count as verified. */
const MIN_EXCERPT_CHARS = 12;

/**
 * Removes Markdown formatting, never words: link and image syntax keep their visible text, and
 * emphasis, code marks and escapes go. Stored pages are extracted as Markdown, while a quote is
 * the text as read ("Where Is Chi Chi?", not "*Where Is Chi Chi?*"). Observed live 2026-10-16:
 * exact quotes were reported as not found because of this.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1')
    .replace(/[*`]+/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}

/** Normalises formatting, quotes, dashes, ellipses, whitespace and case before matching. */
export function normalizeForMatch(text: string): string {
  return stripMarkdown(text)
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "[s2]", " S2 " → "S2"; anything else stays as given (and will be unknown). */
export function normalizeLabel(label: string): string {
  const match = /^\[?\s*s(\d{1,3})\s*\]?$/i.exec(label.trim());
  return match ? `S${Number(match[1])}` : label.trim();
}

/** True when the excerpt (minus wrapping quotes and ellipses) appears in one of the texts. */
export function excerptLocated(
  excerpt: string | null | undefined,
  texts: readonly string[],
): boolean {
  if (!excerpt) return false;
  const needle = normalizeForMatch(excerpt)
    .replace(/^["'\s.]+|["'\s.]+$/g, '')
    .trim();
  if (needle.length < MIN_EXCERPT_CHARS) return false;
  return texts.some((text) => normalizeForMatch(text).includes(needle));
}

export interface ClaimInput {
  type: ClaimType;
  text: string;
  sources: readonly string[];
  excerpt: string;
}

export interface CheckedClaim {
  type: ClaimType;
  text: string;
  sourceLabels: string[];
  sourceArticleIds: string[];
  excerpt: string | null;
  citationStatus: CitationStatus;
}

export interface DroppedClaim {
  text: string;
  reason: 'unknown_source' | 'no_source';
  labels: string[];
}

/**
 * Digit runs a statement gives (years, figures), with thousands separators removed. Source
 * labels ("[S2]") are not details.
 */
function detailsIn(text: string): string[] {
  const words = withDigits(text).replace(LABELS, ' ');
  return [
    ...new Set((words.match(/\d[\d,.]*\d|\d/g) ?? []).map((d) => d.replace(/,(?=\d{3})/g, ''))),
  ];
}

/** Words an attributed statement puts in quotation marks: what someone is said to have said. */
function quotedWordsIn(text: string): string[] {
  const plain = text.replace(/[“”„‟]/g, '"');
  return [...plain.matchAll(/"([^"]{8,})"/g)].map((m) =>
    normalizeForMatch(m[1]!).replace(/^[\s.,;:]+|[\s.,;:]+$/g, ''),
  );
}

/**
 * The dates and figures a statement gives that its quoted passage doesn't contain (digits, month
 * and weekday names, relative dates), and, in an attributed statement, the words it says someone
 * said.
 *
 * A deterministic safeguard, not a support check: it catches a year, number or quotation the
 * passage can't back ("appointed in 2003" quoting "a curator since 1996"), but a passage that does
 * contain them may still describe something else ("curator since 1996" is not "appointed Pulitzer
 * Curator in 1996"). Passing it therefore never upgrades a status or adds reassurance.
 */
/** Whether a quote gives a number whole: "2" is in "on 2 May", not in "2025" or "1.2". */
const givesNumber = (quote: string, n: string) =>
  new RegExp(`(?<![\\d.])${n.replace(/\./g, '\\.')}(?!\\d|\\.\\d)`).test(quote);

export function detailsMissingFromExcerpt(
  text: string,
  excerpt: string,
  type: ClaimType = 'fact',
): string[] {
  const quote = normalizeForMatch(excerpt).replace(/(\d),(?=\d{3})/g, '$1');
  // "three weeks" gives what "3 weeks" does, and the other way round.
  const figures = normalizeForMatch(withDigits(excerpt)).replace(/(\d),(?=\d{3})/g, '$1');
  const missing = detailsIn(text).filter((detail) => !givesNumber(figures, detail));
  missing.push(...dateWordsIn(text).filter((words) => !new RegExp(`\\b${words}\\b`).test(quote)));
  if (type === 'attributed')
    missing.push(...quotedWordsIn(text).filter((words) => !quote.includes(words)));
  return missing;
}

/**
 * Whether a found quote is about the statement it is offered for. Two floors against a real
 * passage passed off as support for something it doesn't discuss:
 *
 * - a quote for a fact that names none of the people or things the statement names, and either
 *   names others or shares fewer than three of its words besides numbers, units and months, must
 *   be tied to them by the source text just before it (`before`): "…to restore the artwork" after
 *   a sentence naming the painting is about it; "Its restoration took three weeks" after a
 *   sentence naming another work is not. A quote that opens by naming a different subject ("Annabelle
 *   Selldorf designed the galleries" for "Kulapat Yantrasast designed…") never is. Not applied to
 *   attributed statements: a speaker's words rarely name the speaker;
 * - the two must share at least two of the statement's meaningful words, and they can't all be
 *   numbers, units or months: "three weeks" alone doesn't tie a quote to a statement, unless the
 *   source names the statement's subject just before the quote.
 *
 * Neither tests support: a quote that names the right people and repeats the statement's words
 * can still say something else, and a fair paraphrase in other words can fail the second floor.
 * Lexical and English-centred.
 */
export function excerptAboutClaim(
  text: string,
  excerpt: string,
  type: ClaimType = 'fact',
  /** The source text just before the quote, if known. */
  before = '',
): boolean {
  const statement = text.replace(LABELS, ' ');
  const names = namesIn(statement);
  const named = [...names.inner, ...names.lead];
  const nearby = [...plainWords(before)];
  const namedNearby = named.some((name) => nearby.some((word) => sameName(name, word)));
  const claimTerms = meaningfulTerms(statement);
  const quoteTerms = meaningfulTerms(excerpt);
  const shared = [...claimTerms].filter((term) => quoteTerms.has(term));
  const anchors = shared.filter((term) => !isMeasure(term));
  if (type === 'fact' && names.inner.size) {
    const quoteWords = [...plainWords(excerpt)];
    const inQuote = named.some((name) => quoteWords.some((word) => sameName(name, word)));
    // A quote naming others, or tied to the statement by little more than a number, must get the
    // statement's subject from the text just before it.
    const needsSubject = namesIn(excerpt).inner.size > 0 || anchors.length < 3;
    if (!inQuote && needsSubject && (opensWithName(excerpt) || !namedNearby)) return false;
  }
  if (shared.length < Math.min(2, claimTerms.size)) return false;
  return anchors.length > 0 || namedNearby;
}

/** The source text just before a found quote: where an indirect reference ("the artwork") gets its name. */
function passageBefore(excerpt: string, source: string, chars = 400): string {
  const text = normalizeForMatch(source);
  const needle = normalizeForMatch(excerpt)
    .replace(/^["'\s.]+|["'\s.]+$/g, '')
    .trim();
  const at = needle ? text.indexOf(needle) : -1;
  return at > 0 ? text.slice(Math.max(0, at - chars), at) : '';
}

export function checkClaim(
  claim: ClaimInput,
  sources: ReadonlyMap<string, CitableSource>,
): { claim: CheckedClaim } | { dropped: DroppedClaim } {
  const labels = [...new Set(claim.sources.map(normalizeLabel))];
  const unknown = labels.filter((label) => !sources.has(label));
  if (unknown.length) return { dropped: { text: claim.text, reason: 'unknown_source', labels } };
  const sourcing = claim.type === 'fact' || claim.type === 'attributed';
  if (sourcing && labels.length === 0)
    return { dropped: { text: claim.text, reason: 'no_source', labels } };

  const cited = labels.map((label) => sources.get(label)!);
  const excerpt = claim.excerpt.trim() || null;
  let citationStatus: CitationStatus;
  if (!sourcing && !excerpt) citationStatus = 'uncited';
  else
    citationStatus = excerptLocated(
      excerpt,
      cited.map((s) => s.text),
    )
      ? 'verified'
      : 'excerpt_not_located';
  if (citationStatus === 'verified' && sourcing && excerpt) {
    // A found quote that lacks a date, figure or quoted words the statement gives can't back them.
    if (detailsMissingFromExcerpt(claim.text, excerpt, claim.type).length > 0)
      citationStatus = 'detail_not_in_excerpt';
    // A found quote about something else isn't evidence for this statement at all.
    else if (
      !excerptAboutClaim(
        claim.text,
        excerpt,
        claim.type,
        passageBefore(excerpt, cited[0]?.text ?? ''),
      )
    )
      citationStatus = 'excerpt_unrelated';
  }
  return {
    claim: {
      type: claim.type,
      text: claim.text,
      sourceLabels: labels,
      sourceArticleIds: cited.map((s) => s.id),
      excerpt,
      citationStatus,
    },
  };
}

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december';
/** "31 May", "May 31st": a day of the month, which belongs to a date, not to a figure. */
const DAY_OF_MONTH = new RegExp(
  `\\b(\\d{1,2})(st|nd|rd|th)?\\s+(of\\s+)?(${MONTHS})\\b|\\b(${MONTHS})\\s+(\\d{1,2})(st|nd|rd|th)?\\b`,
  'gi',
);
/** Month names as written in prose: capitalised, so the verb "may" is never one. */
const MONTH =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g;
const YEAR = /^(1\d{3}|20\d{2})$/;

/** The parts of the dates and figures a statement gives, compared separately. */
function datesAndFigures(text: string) {
  const days = new Set<string>();
  const withoutDays = text.replace(DAY_OF_MONTH, (...match: Array<string | undefined>) => {
    const month = match[4] ?? match[5] ?? '';
    days.add(`${month.toLowerCase()} ${Number(match[1] ?? match[6])}`);
    return ` ${month} `;
  });
  const details = detailsIn(withoutDays);
  return {
    years: new Set(details.filter((d) => YEAR.test(d))),
    figures: new Set(details.filter((d) => !YEAR.test(d))),
    months: new Set([...withoutDays.matchAll(MONTH)].map((m) => m[1]!.toLowerCase())),
    days,
  };
}

/** Neither set empty, and nothing in common. */
const disjoint = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x));

/**
 * Each gives a figure the other doesn't: "4,200 square metres over 3 floors" against "3,800 square
 * metres over 3 floors" differ, though both say 3. One that only adds a figure doesn't.
 */
const eachAdds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  [...a].some((x) => !b.has(x)) && [...b].some((x) => !a.has(x));

/**
 * Marks statements that give different dates or figures for the same thing, each backed by its
 * own found quote: the sources disagree, so neither is shown as settled. Two statements are about
 * the same thing when they name the same kind of event (or neither names one) and share nearly
 * all their words. They differ when their years, months or days of the month differ, or, for
 * figures, when the figures differ for the same (or an unstated) year: figures given for
 * different years are a series, not a contradiction. Examples: an appointment dated 2016 by one
 * source and 2014 by another; a closing date of 30 June and of 28 July; attendance of 5,000 and
 * of 7,500 for the same year.
 *
 * Lexical: it misses a contradiction worded differently, and can flag two measures of one subject
 * ("the building spans 40,000 square feet", "its galleries span 3,000 square feet"). A flag only
 * asks the editor to check. Changes the statements in place, so it can run over a whole brief,
 * reply or draft at once, and again across parts already checked.
 */
export function flagConflicts(claims: readonly CheckedClaim[]): number {
  const numbered = claims
    .filter(
      (c) =>
        (c.type === 'fact' || c.type === 'attributed') &&
        (c.citationStatus === 'verified' || c.citationStatus === 'conflicting'),
    )
    .map((claim) => ({
      claim,
      ...datesAndFigures(claim.text),
      events: eventsNamed(claim.text),
      terms: new Set([...meaningfulTerms(claim.text)].filter((t) => !/^\d+$/.test(t))),
    }))
    .filter((x) => x.years.size || x.figures.size || x.months.size);
  const conflicting = new Set<CheckedClaim>();
  for (let i = 0; i < numbered.length; i += 1)
    for (let j = i + 1; j < numbered.length; j += 1) {
      const a = numbered[i]!;
      const b = numbered[j]!;
      const sameEvent =
        a.events.size || b.events.size ? [...a.events].some((e) => b.events.has(e)) : true;
      const shared = sharedTerms(a.terms, b.terms);
      if (!sameEvent || shared < 3 || shared / Math.min(a.terms.size, b.terms.size) < 0.75)
        continue;
      const differ =
        a.figures.size && b.figures.size
          ? eachAdds(a.figures, b.figures) && !disjoint(a.years, b.years)
          : disjoint(a.years, b.years) || disjoint(a.months, b.months) || disjoint(a.days, b.days);
      if (differ) {
        conflicting.add(a.claim);
        conflicting.add(b.claim);
      }
    }
  for (const claim of conflicting) claim.citationStatus = 'conflicting';
  return conflicting.size;
}

export function checkClaims(
  claims: readonly ClaimInput[],
  sources: ReadonlyMap<string, CitableSource>,
): { claims: CheckedClaim[]; dropped: DroppedClaim[] } {
  const kept: CheckedClaim[] = [];
  const dropped: DroppedClaim[] = [];
  for (const claim of claims) {
    const result = checkClaim(claim, sources);
    if ('claim' in result) kept.push(result.claim);
    else dropped.push(result.dropped);
  }
  flagConflicts(kept);
  return { claims: kept, dropped };
}
