import type { CriticalIssueKind, ExclusionId, NoveltyStatus } from './taxonomy.js';

/**
 * Mandatory editorial gates (§5 exclusions, §8 critical failures, §2 editorial test, §10
 * "verify basics"). They run before ranking and override any score: a story must `pass` to be
 * recommended. `hold` means "needs human verification first"; `reject` means "not a
 * recommendation". Deterministic checks use facts we hold; the rest come from the model's
 * evidence-backed findings.
 */

export type GateOutcome = 'pass' | 'hold' | 'reject';

export interface GateResult {
  gate: string;
  outcome: GateOutcome;
  reason: string;
}

/** How clustering related this candidate to stories we already know. */
export type RepeatStatus =
  'new' | 'new_development' | 'same_development_new_info' | 'same_development_no_new_info';

export interface ExclusionFinding {
  id: ExclusionId;
  evidence: string;
  /** A specific, evidence-based cultural angle that justifies an exception, if any. */
  exception: string | null;
}

export interface CriticalIssueFinding {
  kind: CriticalIssueKind;
  severity: 'hold' | 'reject';
  evidence: string;
}

export interface GateInput {
  now: Date;
  freshnessDays: number;
  sources: ReadonlyArray<{ url: string; publisher: string; publishedAt: Date | null }>;
  novelty: NoveltyStatus;
  repeat: RepeatStatus;
  /** True if an editor previously skipped this same development. */
  previouslySkipped: boolean;
  /** The model's "This matters to Omenai's audience because…" completion. */
  editorialTest: { canAnswer: boolean; answer: string };
  exclusions: readonly ExclusionFinding[];
  criticalIssues: readonly CriticalIssueFinding[];
}

const DAY_MS = 86_400_000;
const MIN_EXCEPTION_LENGTH = 60;
const MIN_EDITORIAL_ANSWER_LENGTH = 80;
const MIN_EDITORIAL_ANSWER_WORDS = 12;

/** §2 "If it cannot give a specific, evidence-based answer, it should not recommend the story." */
export function editorialTestProblem(test: GateInput['editorialTest']): string | null {
  if (!test.canAnswer) return 'The model could not complete the editorial test.';
  const answer = test.answer.trim();
  const words = answer.split(/\s+/).filter(Boolean).length;
  if (answer.length < MIN_EDITORIAL_ANSWER_LENGTH || words < MIN_EDITORIAL_ANSWER_WORDS) {
    return 'The "why it matters" answer is too thin to be specific.';
  }
  return null;
}

// Shared code runs without DOM or Node globals, so no `URL`; canonical URLs are normalised in core.
const HTTP_URL = /^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;

function isHttpUrl(value: string): boolean {
  return HTTP_URL.test(value);
}

function sourceGate(input: GateInput): GateResult {
  const usable = input.sources.filter((s) => isHttpUrl(s.url) && s.publisher.trim().length > 0);
  if (usable.length === 0) {
    return {
      gate: 'sources',
      outcome: 'reject',
      reason: 'No source with a valid URL and publisher.',
    };
  }
  return { gate: 'sources', outcome: 'pass', reason: `${usable.length} usable source(s).` };
}

function freshnessGate(input: GateInput): GateResult {
  const dates = input.sources
    .map((s) => s.publishedAt)
    .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (dates.length === 0) {
    return {
      gate: 'freshness',
      outcome: 'hold',
      reason: 'No publication date is known; confirm the date before recommending.',
    };
  }
  const newest = Math.max(...dates.map((d) => d.getTime()));
  if (newest > input.now.getTime() + DAY_MS) {
    return {
      gate: 'freshness',
      outcome: 'hold',
      reason: 'Publication date is in the future; verify it.',
    };
  }
  const ageDays = (input.now.getTime() - newest) / DAY_MS;
  if (
    ageDays > input.freshnessDays &&
    input.novelty !== 'evergreen' &&
    input.novelty !== 'retrospective'
  ) {
    return {
      gate: 'freshness',
      outcome: 'reject',
      reason: `Newest source is ${Math.floor(ageDays)} days old and the story is not evergreen.`,
    };
  }
  return {
    gate: 'freshness',
    outcome: 'pass',
    reason: `Newest source is ${Math.floor(ageDays)} day(s) old.`,
  };
}

function repeatGate(input: GateInput): GateResult {
  const sameDevelopment =
    input.repeat === 'same_development_new_info' || input.repeat === 'same_development_no_new_info';
  if (sameDevelopment && input.previouslySkipped) {
    return {
      gate: 'repeat',
      outcome: 'reject',
      reason: 'An editor skipped this development; only a genuinely new development can return.',
    };
  }
  if (input.repeat === 'same_development_no_new_info') {
    return {
      gate: 'repeat',
      outcome: 'reject',
      reason: 'Same development with no new information.',
    };
  }
  return { gate: 'repeat', outcome: 'pass', reason: input.repeat.replaceAll('_', ' ') };
}

function exclusionGates(input: GateInput): GateResult[] {
  return input.exclusions.map((finding) => {
    const exception = finding.exception?.trim() ?? '';
    return exception.length >= MIN_EXCEPTION_LENGTH
      ? {
          gate: `exclusion:${finding.id}`,
          outcome: 'pass',
          reason: `Exception: ${exception}`,
        }
      : {
          gate: `exclusion:${finding.id}`,
          outcome: 'reject',
          reason: finding.evidence,
        };
  });
}

function criticalGates(input: GateInput): GateResult[] {
  return input.criticalIssues.map((issue) => ({
    gate: `critical:${issue.kind}`,
    outcome: issue.severity,
    reason: issue.evidence,
  }));
}

export function applyGates(input: GateInput): { outcome: GateOutcome; results: GateResult[] } {
  const editorialProblem = editorialTestProblem(input.editorialTest);
  const results: GateResult[] = [
    sourceGate(input),
    freshnessGate(input),
    repeatGate(input),
    editorialProblem
      ? { gate: 'editorial_test', outcome: 'reject', reason: editorialProblem }
      : { gate: 'editorial_test', outcome: 'pass', reason: 'Specific answer given.' },
    ...exclusionGates(input),
    ...criticalGates(input),
  ];

  const outcome: GateOutcome = results.some((r) => r.outcome === 'reject')
    ? 'reject'
    : results.some((r) => r.outcome === 'hold')
      ? 'hold'
      : 'pass';
  return { outcome, results };
}
