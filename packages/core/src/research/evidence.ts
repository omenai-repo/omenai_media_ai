import type { EVIDENCE_CHECKS, EVIDENCE_LEVELS } from '../db/models/research-brief.js';
import type { CheckedClaim } from './citations.js';
import {
  eventsNamed,
  hasDate,
  meaningfulTerms,
  namesIn,
  plainWords,
  sameName,
  sharedTerms,
  withDigits,
} from './terms.js';

/**
 * Whether an answer's own "the evidence is sufficient" survives the claim checks (ADR-039). The
 * model judges how fully the research answers a question, in the answer itself; these rules can
 * lower that judgement after the checks, never raise it. Each is a general invariant, whatever the
 * subject:
 *
 * - statements whose sources disagree settle nothing (`conflicting`);
 * - an answer that rests on no checked fact isn't a sufficient answer to a factual question: its
 *   facts all failed their checks, or it only says what isn't known (`no_checked_facts`);
 * - a question that asks for an exact detail (when, how many or how much, who or where) is
 *   answered only by a checked statement that gives that kind of detail for the event or thing
 *   asked about; a related detail is not the answer (`asked_detail_unchecked`). Observed live
 *   2026-10-18: "When was she appointed…?" was judged sufficient on a quote dating when she joined
 *   the institution, years earlier.
 *
 * Deterministic and lexical (English). It recognises a detail question from its wording, and the
 * event a detail belongs to from a vocabulary of event kinds (`eventsNamed`); an event described in
 * other words is not taken as answering, and a name is not typed (a place can pass for a person).
 * It cannot tell that a statement answers the question, so passing it is never reported as proof
 * of anything. Judgement questions are held only to the first two rules: callers pass no question.
 */

export type Evidence = (typeof EVIDENCE_LEVELS)[number];
export type EvidenceCheck = (typeof EVIDENCE_CHECKS)[number];
type Detail = 'date' | 'figure' | 'name';

/** "when" opening a question or clause, or after a verb of knowing; never "when" as a condition. */
const OPENS = String.raw`(^|[.?!;:,]\s*|\b(and|but|or|so|then)\s+)`;
const KNOWING = String.raw`\b(know|known|say|says|said|tell|confirm|establish|find out|check|clear|unclear|sure|recall|note|record|idea|ask)( (me|us|you|them|him|her))? `;

const ASKS_DATE = new RegExp(
  [
    `${OPENS}when\\b`,
    `${KNOWING}when\\b`,
    String.raw`\bsince when\b`,
    String.raw`\bhow long ago\b`,
    String.raw`\b(what|which) (year|date|month|day|decade|season)\b`,
    String.raw`\b(dates?|year|day) (of|for)\b`,
  ].join('|'),
  'i',
);

/**
 * A question asking for a quantity: "how many/much…", or "what is/was the … price" and its kin,
 * not a question that merely mentions one ("what does the price say about the market?").
 */
const QUANTITIES =
  'number|figure|share|percentage|percent|proportion|amount|price|cost|budget|estimate|total|size|area|height|length|capacity|attendance|revenue|turnover|sales|valuation|fee|salary|age|population|rate|count';
const ASKS_FIGURE = new RegExp(
  [
    String.raw`\bhow (many|much|old|long|big|large|tall|far|high|wide)\b`,
    String.raw`\b(what|which) (${QUANTITIES})\b`,
    String.raw`\b(what|which) (is|was|are|were) (the|its|their|his|her)( [\p{L}'’-]+){0,3}? (${QUANTITIES})\b`,
  ].join('|'),
  'iu',
);

/** A question asking who or where: answered by a name. */
const ASKS_NAME = new RegExp(
  [
    `${OPENS}(who|whom|whose|where)\\b`,
    `${KNOWING}(who|whom|whose|where)\\b`,
    String.raw`\b(what|which) (is|was) (the|its|their|his|her) name\b`,
    String.raw`\bname of\b`,
  ].join('|'),
  'i',
);

/** The kind of exact detail a question asks for, if it asks for one. */
export function detailAsked(question: string): Detail | null {
  if (ASKS_DATE.test(question)) return 'date';
  if (ASKS_FIGURE.test(question)) return 'figure';
  if (ASKS_NAME.test(question)) return 'name';
  return null;
}

/** The thing a "how many" question counts ("visitors"), when it names one. */
function countedThing(question: string): string | null {
  const word = /\bhow many\s+(\p{L}+)/iu.exec(question)?.[1];
  return word ? ([...meaningfulTerms(word)][0] ?? null) : null;
}

const YEAR = /\b(1\d{3}|20\d{2})s?\b/;
/** Dates relative to their source ("this week", "on Tuesday"), which its date pins down. */
const RELATIVE_DATE =
  /\b(today|yesterday|tomorrow|tonight|(this|last|next) (week|weekend|month|year)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
/** Questions that already fix the year, or ask only for a month, day or time of year. */
const YEAR_GIVEN =
  /\b(1\d{3}|20\d{2})\b|\b(this|last|next) year\b|\b(what|which) (month|day|season|time of year)\b/i;

/**
 * Whether a statement dates something precisely enough to answer a "when" question: with a year,
 * or relative to its source ("this week"). A month or a day alone ("in the middle of July", "from
 * November to May") is enough only when the question already fixes the year or asks only for the
 * month or day; otherwise it is a partial answer, however well quoted.
 */
function datedEnough(text: string, question: string): boolean {
  if (!hasDate(text)) return false;
  return YEAR.test(text) || RELATIVE_DATE.test(text) || YEAR_GIVEN.test(question);
}

/** Whether a statement gives a detail of the kind asked: a date, a figure, or a name the question doesn't. */
function givesDetail(text: string, question: string, wants: Detail): boolean {
  if (wants === 'date') return datedEnough(text, question);
  if (wants === 'figure') return /\d/.test(withDigits(text));
  const asked = plainWords(question);
  const { inner, lead } = namesIn(text);
  return [...inner, ...lead].some((name) => ![...asked].some((word) => sameName(name, word)));
}

/**
 * The question without its descriptive asides (", the firm behind the renovated wing,"; ", which
 * was recorded in Lagos,"), so an event an aside mentions isn't taken for the one asked about.
 */
function withoutAsides(question: string): string {
  return question.replace(
    /,\s*(the|a|an|which|who|whose|where|that|its|their|his|her)\b[^,?]*(,|(?=\?)|$)/gi,
    ' ',
  );
}

/**
 * Whether a checked statement gives what the question asks for: a detail of the kind asked, for
 * the same kind of event when the question names one ("joined in 1996" doesn't date "appointed";
 * "built" doesn't say who was appointed). Otherwise a name must be about the question's subject
 * (mention a name the question gives, if it gives one: "who are the key people behind this?" is
 * about the story itself), and a date or figure must be about the thing counted, or share the
 * question's words.
 */
function answersDetail(question: string, claim: CheckedClaim, wants: Detail): boolean {
  if (!givesDetail(claim.text, question, wants)) return false;
  const asked = eventsNamed(withoutAsides(question));
  if (asked.size) return [...eventsNamed(claim.text)].some((event) => asked.has(event));
  if (wants === 'name') {
    const { inner, lead } = namesIn(question);
    const subject = [...inner, ...lead];
    const words = [...plainWords(claim.text)];
    return !subject.length || subject.some((name) => words.some((word) => sameName(name, word)));
  }
  const terms = meaningfulTerms(claim.text);
  const thing = wants === 'figure' ? countedThing(question) : null;
  if (thing) return terms.has(thing);
  const questionTerms = meaningfulTerms(question);
  return sharedTerms(questionTerms, terms) >= Math.min(2, questionTerms.size);
}

export function judgeEvidence(input: {
  evidence: Evidence | null;
  claims: readonly CheckedClaim[];
  /** The question asked, or null for a judgement question. */
  question: string | null;
}): { evidence: Evidence | null; check: EvidenceCheck | null } {
  const { evidence, claims, question } = input;
  if (evidence === null) return { evidence, check: null };
  if (claims.some((c) => c.citationStatus === 'conflicting'))
    return { evidence: evidence === 'insufficient' ? evidence : 'partial', check: 'conflicting' };
  if (evidence !== 'sufficient') return { evidence, check: null };
  const factual = claims.filter((c) => c.type === 'fact' || c.type === 'attributed');
  const checked = factual.filter((c) => c.citationStatus === 'verified');
  const saysUnknown = claims.some((c) => c.type === 'open_question');
  if (!checked.length && (factual.length || (question !== null && saysUnknown)))
    return { evidence: 'partial', check: 'no_checked_facts' };
  const wants = question === null ? null : detailAsked(question);
  if (wants && !checked.some((claim) => answersDetail(question!, claim, wants)))
    return { evidence: 'partial', check: 'asked_detail_unchecked' };
  return { evidence, check: null };
}
