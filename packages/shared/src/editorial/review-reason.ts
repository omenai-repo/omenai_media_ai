import type { CandidateOutcome } from './ranking.js';
import { SCORE_THRESHOLDS } from './scoring.js';

/**
 * Plain-language explanations of editorial outcomes, for editors rather than engineers. Built
 * only from stored facts (outcome, failing checks, score), never invented.
 */

const EXCLUSION_PLAIN: Record<string, string> = {
  routine_announcement: 'a routine announcement',
  press_release_repackaged: 'a press release rewritten as news',
  celebrity_gossip_or_virality: 'celebrity or viral content without a cultural question',
  generic_luxury_promotion: 'promotional luxury content',
  fame_only: 'notable only for who is involved',
  repeated_coverage: 'repeat coverage with nothing new',
  thin_listicle_seo: 'a thin list rather than a story',
  engagement_controversy: 'controversy for its own sake',
  geographic_tokenism: 'included only to balance geography',
  sponsor_relevance_only: 'relevant only commercially',
};

const CRITICAL_PLAIN: Record<string, string> = {
  source: 'its sources need confirming',
  accuracy: 'a key fact needs checking',
  rights: 'image or content rights need checking',
  ethics: 'an ethical question needs resolving',
};

const CHECK_PLAIN: Record<string, string> = {
  sources: 'no usable source',
  freshness: 'the publication date needs checking or it is too old',
  repeat: 'already covered',
  editorial_test: 'no clear reason it matters to our readers',
};

/** Plain description of one failed editorial check, e.g. `exclusion:thin_listicle_seo`. */
export function plainCheck(gate: string): string {
  const [kind, id = ''] = gate.split(':');
  if (kind === 'exclusion') return EXCLUSION_PLAIN[id] ?? 'excluded by our editorial guidelines';
  if (kind === 'critical') return CRITICAL_PLAIN[id] ?? 'a serious concern needs resolving';
  return CHECK_PLAIN[gate] ?? 'an editorial check';
}

/** Editor-facing name of a check, for the "How this story was assessed" view. */
export function plainCheckName(gate: string): string {
  const [kind, id = ''] = gate.split(':');
  if (kind === 'exclusion') return `Not ${EXCLUSION_PLAIN[id] ?? 'excluded content'}`;
  if (kind === 'critical') return `No unresolved concern: ${id}`;
  return (
    {
      sources: 'Has usable sources',
      freshness: 'Recent enough',
      repeat: 'Not a repeat',
      editorial_test: 'Clear reason it matters',
    }[gate] ?? gate
  );
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function reviewReason(input: {
  outcome: CandidateOutcome | null;
  failingChecks: readonly string[];
  score: number | null;
  threshold?: number;
  /** False for a story that met the standard but ranked below a full edition. */
  recommended?: boolean;
}): string {
  const threshold = input.threshold ?? SCORE_THRESHOLDS.shortlist;
  const checks = [...new Set(input.failingChecks.map(plainCheck))];
  switch (input.outcome) {
    case 'qualified': {
      const met =
        input.score !== null ? `Met our standards (scored ${input.score})` : 'Met our standards';
      return input.recommended === false
        ? `${met}, but stronger stories filled the edition.`
        : `${met}.`;
    }
    case 'below_threshold':
      return input.score !== null
        ? `Scored ${input.score}; our bar is ${threshold}.`
        : 'Did not reach our bar.';
    case 'gate_hold':
      return checks.length
        ? `Needs checking first: ${list(checks)}.`
        : 'Needs checking before it can be recommended.';
    case 'gate_reject':
      return checks.length
        ? `Didn’t pass our editorial checks: ${list(checks)}.`
        : 'Didn’t pass our editorial checks.';
    case 'suppressed_repeat':
      return 'Already covered, with nothing new.';
    case 'evaluation_failed':
      return 'Couldn’t be assessed because of a technical problem (see Operations).';
    case 'source_failed':
      return 'The source couldn’t be read.';
    case 'deferred_late':
      return 'Will be considered in the next edition.';
    default:
      return 'Not assessed yet.';
  }
}
