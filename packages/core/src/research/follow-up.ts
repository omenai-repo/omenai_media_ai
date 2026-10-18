import type { ChatAnswer } from './schemas.js';
import { meaningfulTerms, sharedTerms } from './terms.js';

/**
 * When a chat reply starts research on its own (ADR-038). The model decides, in the answer itself,
 * whether the saved research establishes the answer (`assessment`). This only applies the rules
 * around that decision, from what the reply and the already-loaded briefs say: no database call,
 * so the ordinary path costs nothing extra.
 */

export interface FollowUpPlan {
  question: string;
  depth: 'standard' | 'in_depth';
}

/** Research on the same question is reused, not repeated, for this long. */
export const SAME_QUESTION_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Whether two research questions ask the same thing: nearly all the meaningful words of the
 * shorter one appear in the other. Deliberately strict ("visitors in its first month" is not
 * "visitors in its first year"): repeating research costs credits, but skipping needed research
 * would leave the editor without an answer. The model is also told not to ask twice.
 */
export function sameQuestion(a: string, b: string): boolean {
  const left = meaningfulTerms(a);
  const right = meaningfulTerms(b);
  const smaller = Math.min(left.size, right.size);
  if (smaller < 2) return false;
  const shared = sharedTerms(left, right);
  return shared >= 3 && shared / smaller >= 0.85;
}

export type FollowUpDecision =
  | { kind: 'research'; plan: FollowUpPlan }
  /** Research on this question already ran recently: its findings are in the saved research. */
  | { kind: 'already_researched'; question: string }
  | null;

/**
 * Whether a reply's assessment should start research now. Only a `needs_research` assessment with
 * a usable question does, and only if the evidence wasn't judged sufficient and the same question
 * wasn't researched in the last week.
 */
export function planFollowUp(input: {
  answer: Pick<ChatAnswer, 'assessment' | 'evidence' | 'researchQuestion' | 'researchDepth'>;
  briefs: ReadonlyArray<{ focus?: string | null; createdAt: Date }>;
  now: Date;
}): FollowUpDecision {
  const { answer } = input;
  const question = answer.researchQuestion.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (answer.assessment !== 'needs_research' || answer.evidence === 'sufficient') return null;
  if (meaningfulTerms(question).size < 2) return null;
  const since = input.now.getTime() - SAME_QUESTION_WINDOW_MS;
  const done = input.briefs.some(
    (brief) =>
      brief.focus && brief.createdAt.getTime() >= since && sameQuestion(brief.focus, question),
  );
  if (done) return { kind: 'already_researched', question };
  return {
    kind: 'research',
    plan: { question, depth: answer.researchDepth === 'broad' ? 'in_depth' : 'standard' },
  };
}
