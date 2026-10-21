/**
 * Per-run counts through the discovery funnel. When fewer stories qualify than the target,
 * `deriveShortfallReasons` explains why, so a short list is visible and accountable rather
 * than padded.
 */
export interface RunFunnel {
  searchQueries: number;
  searchFailures: number;
  discovered: number;
  newArticles: number;
  revisited: number;
  changed: number;
  extractionFailures: number;
  inScope: number;
  candidates: number;
  evaluated: number;
  evaluationFailures: number;
  deferredLate: number;
  gateHolds: number;
  gateRejects: number;
  /** Rejections by gate id, e.g. `exclusion:thin_listicle_seo`. */
  gateRejectsByGate: Record<string, number>;
  suppressedRepeats: number;
  belowThreshold: number;
  qualified: number;
  shortlisted: number;
  /**
   * Fair intake (ADR-042): work over a stage's cap waits in a backlog instead of being dropped,
   * and anything that ages past the freshness window first is counted here, never lost silently.
   */
  waitingToExtract: number;
  waitingToCluster: number;
  expiredBeforeExtract: number;
  expiredBeforeCluster: number;
  expiredBeforeEvaluation: number;
}

export function emptyFunnel(): RunFunnel {
  return {
    searchQueries: 0,
    searchFailures: 0,
    discovered: 0,
    newArticles: 0,
    revisited: 0,
    changed: 0,
    extractionFailures: 0,
    inScope: 0,
    candidates: 0,
    evaluated: 0,
    evaluationFailures: 0,
    deferredLate: 0,
    gateHolds: 0,
    gateRejects: 0,
    gateRejectsByGate: {},
    suppressedRepeats: 0,
    belowThreshold: 0,
    qualified: 0,
    shortlisted: 0,
    waitingToExtract: 0,
    waitingToCluster: 0,
    expiredBeforeExtract: 0,
    expiredBeforeCluster: 0,
    expiredBeforeEvaluation: 0,
  };
}

export const SHORTFALL_CODES = [
  'insufficient_candidates',
  'source_failures',
  'evaluation_failures',
  'editorial_gates',
  'below_threshold',
  'suppressed_repeats',
  'deferred_late',
  'expired_unprocessed',
] as const;
export type ShortfallCode = (typeof SHORTFALL_CODES)[number];

export interface ShortfallReason {
  code: ShortfallCode;
  count: number;
  message: string;
  /** For `editorial_gates`: the most frequent failing gates. */
  breakdown?: Record<string, number>;
}

/** Empty when the run met the target; otherwise every contributing cause, largest first. */
export function deriveShortfallReasons(funnel: RunFunnel, targetMin: number): ShortfallReason[] {
  if (funnel.qualified >= targetMin) return [];

  const reasons: ShortfallReason[] = [];
  const reviewable = funnel.evaluated + funnel.evaluationFailures + funnel.deferredLate;
  if (reviewable < targetMin) {
    reasons.push({
      code: 'insufficient_candidates',
      count: reviewable,
      message: `Only ${reviewable} candidate development(s) reached evaluation (target ${targetMin}).`,
    });
  }
  const sourceFailures = funnel.searchFailures + funnel.extractionFailures;
  if (sourceFailures > 0) {
    reasons.push({
      code: 'source_failures',
      count: sourceFailures,
      message: `${funnel.searchFailures} search and ${funnel.extractionFailures} extraction failure(s).`,
    });
  }
  if (funnel.evaluationFailures > 0) {
    reasons.push({
      code: 'evaluation_failures',
      count: funnel.evaluationFailures,
      message: `${funnel.evaluationFailures} evaluation(s) failed after retries.`,
    });
  }
  const gateCount = funnel.gateRejects + funnel.gateHolds;
  if (gateCount > 0) {
    reasons.push({
      code: 'editorial_gates',
      count: gateCount,
      message: `${funnel.gateRejects} rejected and ${funnel.gateHolds} held by editorial gates.`,
      breakdown: funnel.gateRejectsByGate,
    });
  }
  if (funnel.belowThreshold > 0) {
    reasons.push({
      code: 'below_threshold',
      count: funnel.belowThreshold,
      message: `${funnel.belowThreshold} passed the gates but scored below the threshold.`,
    });
  }
  if (funnel.suppressedRepeats > 0) {
    reasons.push({
      code: 'suppressed_repeats',
      count: funnel.suppressedRepeats,
      message: `${funnel.suppressedRepeats} repeated an earlier or skipped development.`,
    });
  }
  if (funnel.deferredLate > 0) {
    reasons.push({
      code: 'deferred_late',
      count: funnel.deferredLate,
      message: `${funnel.deferredLate} were not evaluated in time (over the evaluation cap or finished after the candidate set closed); they roll to the next run.`,
    });
  }
  const expired =
    funnel.expiredBeforeExtract + funnel.expiredBeforeCluster + funnel.expiredBeforeEvaluation;
  if (expired > 0) {
    reasons.push({
      code: 'expired_unprocessed',
      count: expired,
      message: `${expired} waited past the freshness window before they could be processed (${funnel.expiredBeforeExtract} before reading, ${funnel.expiredBeforeCluster} before grouping, ${funnel.expiredBeforeEvaluation} before assessment).`,
    });
  }
  return reasons.toSorted((a, b) => b.count - a.count);
}
