/**
 * When to close a run's candidate set (§E of the brief). Ranking waits for evaluations until the
 * soft deadline; if too few candidates are evaluated by then, it waits until the extension
 * deadline; the hard deadline always closes. Finishing early is fine when nothing is pending.
 */
export interface CloseDecisionInput {
  now: Date;
  deadlines: { soft: Date; extension: Date; hard: Date };
  evaluated: number;
  pending: number;
  minCandidates: number;
}

export type CloseDecision =
  | { close: true; reason: 'all_done' | 'soft_deadline' | 'extension_deadline' | 'hard_deadline' }
  | { close: false; reason: 'waiting' | 'extended' };

export function shouldCloseCandidateSet(input: CloseDecisionInput): CloseDecision {
  const t = input.now.getTime();
  if (input.pending === 0) return { close: true, reason: 'all_done' };
  if (t >= input.deadlines.hard.getTime()) return { close: true, reason: 'hard_deadline' };
  if (t >= input.deadlines.extension.getTime())
    return { close: true, reason: 'extension_deadline' };
  if (t >= input.deadlines.soft.getTime()) {
    return input.evaluated >= input.minCandidates
      ? { close: true, reason: 'soft_deadline' }
      : { close: false, reason: 'extended' };
  }
  return { close: false, reason: 'waiting' };
}
