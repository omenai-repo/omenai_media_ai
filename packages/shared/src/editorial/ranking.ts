import type { GateOutcome, GateResult } from './gates.js';
import { SCORE_THRESHOLDS } from './scoring.js';
import type { Confidence, GeographyTier } from './taxonomy.js';

/**
 * Every candidate in a run ends with exactly one outcome, so the operations view can account for
 * every story that did not make the shortlist.
 */
export const CANDIDATE_OUTCOMES = [
  'qualified',
  'below_threshold',
  'gate_hold',
  'gate_reject',
  'suppressed_repeat',
  'evaluation_failed',
  'source_failed',
  'deferred_late',
] as const;
export type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];

/** Outcome for an evaluated candidate. Gates always win over the score. */
export function classifyEvaluated(
  gates: { outcome: GateOutcome; results: readonly GateResult[] },
  total: number,
  threshold: number = SCORE_THRESHOLDS.shortlist,
): CandidateOutcome {
  if (gates.outcome === 'reject') {
    const failing = gates.results.filter((r) => r.outcome === 'reject');
    return failing.every((r) => r.gate === 'repeat') ? 'suppressed_repeat' : 'gate_reject';
  }
  if (gates.outcome === 'hold') return 'gate_hold';
  return total >= threshold ? 'qualified' : 'below_threshold';
}

export interface RankableCandidate {
  id: string;
  outcome: CandidateOutcome;
  total: number;
  confidence: Confidence;
  tier: GeographyTier;
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Ranks qualified candidates by score; ties go to higher confidence, then to geographic priority
 * (a tiebreak only, never a quota). Returns at most `max`; possibly none. Nothing here relaxes the
 * threshold when few stories qualify.
 */
export function rankShortlist<T extends RankableCandidate>(
  candidates: readonly T[],
  max: number,
): T[] {
  return candidates
    .filter((c) => c.outcome === 'qualified')
    .toSorted(
      (a, b) =>
        b.total - a.total ||
        CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
        a.tier - b.tier ||
        a.id.localeCompare(b.id),
    )
    .slice(0, Math.max(0, max));
}

/**
 * §9 recommended_action, derived from the outcome rather than chosen by a model: gates and the
 * score decide, and only qualified stories can be pitched or flagged for urgent review.
 */
export function recommendedActionFor(
  outcome: CandidateOutcome,
  band: 'priority' | 'shortlist' | 'below_threshold' | null,
  timeliness: 'urgent' | 'this_week' | 'upcoming' | 'evergreen' | null,
): 'reject' | 'monitor' | 'research' | 'shortlist' | 'pitch' | 'urgent_review' {
  switch (outcome) {
    case 'qualified':
      if (band === 'priority') return timeliness === 'urgent' ? 'urgent_review' : 'pitch';
      return 'shortlist';
    case 'gate_hold':
      return 'research';
    case 'gate_reject':
    case 'suppressed_repeat':
      return 'reject';
    default:
      return 'monitor';
  }
}
