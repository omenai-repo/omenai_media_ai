import type { CriticalIssueKind, ExclusionId, NoveltyStatus, SourceQuality } from './taxonomy.js';

/**
 * Mandatory editorial gates (§5 exclusions, §8 critical failures, §2 editorial test, §10
 * "verify basics"). They run before ranking and override any score: a story must `pass` to be
 * recommended. `hold` means "needs human verification first"; `reject` means "not a
 * recommendation". Deterministic checks use facts we hold; the rest come from the model's
 * evidence-backed findings.
 *
 * Every check here can only lower a story's outcome (ADR-039, ADR-041). A passing evidence check
 * means no known defect was found by lexical checks of quotes against our stored text, never that
 * a claim is true or that a quote supports it. Source-quality ratings are the model's assessment,
 * not independent verification: they can hold a story, never vouch for it.
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
  /** Key claims (1-based) the exception says it rests on. */
  supportedBy: readonly number[];
}

/** Ratings that can carry a recommendation. Still the model's assessment, not verification. */
export const ESTABLISHED_SOURCE_QUALITIES: readonly SourceQuality[] = [
  'primary',
  'reputable_secondary',
  'specialist',
];

export interface GateSource {
  url: string;
  publisher: string;
  publishedAt: Date | null;
  /** The assessment's rating (a model judgement, not verification). Missing counts as unknown. */
  quality?: SourceQuality | null;
  /** The source's host, from our records (never from the model). */
  host?: string | null;
}

/** A key claim after the deterministic quote checks, computed in core from stored text. */
export interface KeyClaimCheck {
  type: 'fact' | 'attributed';
  /** The checks found no defect. Never proof that the claim is true or supported. */
  passed: boolean;
  /** Why the checks lowered it, when they did. */
  problem: string | null;
  /** Indexes into `GateInput.sources` of the sources the claim cites. */
  sources: readonly number[];
}

export interface EvidenceInput {
  keyClaims: readonly KeyClaimCheck[];
  /** Key claims (1-based) the editorial test says it rests on. */
  editorialSupport: readonly number[];
  /** The assessment's judgement of whether the story is only the originator's announcement. */
  pressRelease: { leadOnly: boolean; reason: string } | null;
}

export interface CriticalIssueFinding {
  kind: CriticalIssueKind;
  severity: 'hold' | 'reject';
  evidence: string;
}

export interface GateInput {
  now: Date;
  freshnessDays: number;
  sources: readonly GateSource[];
  novelty: NoveltyStatus;
  repeat: RepeatStatus;
  /** True if an editor previously skipped this same development. */
  previouslySkipped: boolean;
  /** The model's "This matters to Omenai's audience because…" completion. */
  editorialTest: { canAnswer: boolean; answer: string };
  exclusions: readonly ExclusionFinding[];
  criticalIssues: readonly CriticalIssueFinding[];
  evidence: EvidenceInput;
  card: { angle: string; whyItMatters: string };
  /** Exclusion signals triage raised; each must be confirmed (flagged) or dismissed. */
  triageSignals: readonly ExclusionId[];
  dismissedSignals: ReadonlyArray<{ id: ExclusionId; reason: string }>;
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

const established = (source: GateSource | undefined) =>
  ESTABLISHED_SOURCE_QUALITIES.includes(source?.quality ?? 'unknown');

function sourceGate(input: GateInput): GateResult {
  const usable = input.sources.filter((s) => isHttpUrl(s.url) && s.publisher.trim().length > 0);
  if (usable.length === 0) {
    return {
      gate: 'sources',
      outcome: 'reject',
      reason: 'No source with a valid URL and publisher.',
    };
  }
  if (!usable.some(established)) {
    return {
      gate: 'sources',
      outcome: 'hold',
      reason:
        'No source the assessment rated primary, reputable or specialist (a model judgement, not verification). Establish the sources first.',
    };
  }
  return {
    gate: 'sources',
    outcome: 'pass',
    reason: `${usable.length} usable source(s); quality ratings are the assessment's judgement, not verification.`,
  };
}

function cardGate(input: GateInput): GateResult {
  const missing = [
    input.card.angle.trim() ? null : 'angle',
    input.card.whyItMatters.trim() ? null : 'why it matters',
  ].filter(Boolean);
  return missing.length
    ? {
        gate: 'card_complete',
        outcome: 'reject',
        reason: `No proposed ${missing.join(' or ')}; a story needs a plausible angle to be recommended.`,
      }
    : { gate: 'card_complete', outcome: 'pass', reason: 'Angle and why-it-matters given.' };
}

/** 1-based key-claim numbers that exist. */
function claimsNamed(numbers: readonly number[], evidence: EvidenceInput) {
  return [...new Set(numbers)]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= evidence.keyClaims.length)
    .map((n) => evidence.keyClaims[n - 1]!);
}

function evidenceGate(input: GateInput): GateResult {
  const claims = input.evidence.keyClaims;
  if (claims.length === 0) {
    return {
      gate: 'evidence',
      outcome: 'hold',
      reason: 'No key claim with a quote to check, so the facts it rests on are not traceable.',
    };
  }
  const problems = claims.flatMap((claim, i) => {
    if (!claim.passed) return [`key claim ${i + 1}: ${claim.problem ?? 'did not pass the checks'}`];
    if (!claim.sources.some((index) => established(input.sources[index])))
      return [
        `key claim ${i + 1} rests only on sources the assessment didn't rate primary, reputable or specialist`,
      ];
    return [];
  });
  return problems.length
    ? { gate: 'evidence', outcome: 'hold', reason: `Check first: ${problems.join('; ')}.` }
    : {
        gate: 'evidence',
        outcome: 'pass',
        reason: `No defect found in ${claims.length} key claim(s) (lexical checks of quotes against our stored text; not proof of support).`,
      };
}

/**
 * §5: a press release can be a lead, never the whole story. A primary source is authoritative for
 * its own facts, so a single originator is not weak in itself; what is held is a story that is
 * only the announcement, or whose significance rests only on the originator's account of itself.
 * Independence uses the assessment's ratings (model judgement) and hosts from our records.
 */
function singleOriginGate(input: GateInput): GateResult {
  const primaryHosts = new Set(
    input.sources.filter((s) => s.quality === 'primary').map((s) => s.host ?? ''),
  );
  const independent = input.sources.some(
    (s) =>
      (s.quality === 'reputable_secondary' || s.quality === 'specialist') &&
      !!s.host &&
      !primaryHosts.has(s.host),
  );
  if (independent) {
    return {
      gate: 'single_origin',
      outcome: 'pass',
      reason:
        "An independent source is present (going by the assessment's ratings and our records of each host).",
    };
  }
  const pressRelease = input.evidence.pressRelease;
  if (!pressRelease) {
    return {
      gate: 'single_origin',
      outcome: 'hold',
      reason:
        "No independent source, and no judgement of whether this is only the originator's announcement.",
    };
  }
  if (pressRelease.leadOnly) {
    return {
      gate: 'single_origin',
      outcome: 'hold',
      reason:
        `A lead, not yet a story: only the originator's announcement so far. ${pressRelease.reason}`.trim(),
    };
  }
  const support = claimsNamed(input.evidence.editorialSupport, input.evidence).filter(
    (c) => c.passed,
  );
  if (!support.some((c) => c.type === 'fact')) {
    return {
      gate: 'single_origin',
      outcome: 'hold',
      reason:
        "With no independent source, why it matters rests only on the originator's own account of itself.",
    };
  }
  return {
    gate: 'single_origin',
    outcome: 'pass',
    reason:
      "No independent source: the facts rest on the originator's own account. Treat its description of itself as a claim, not a finding.",
  };
}

function signalGates(input: GateInput): GateResult[] {
  const flagged = new Set(input.exclusions.map((e) => e.id));
  return [...new Set(input.triageSignals)]
    .filter((id) => !flagged.has(id))
    .map((id) => {
      const dismissal = input.dismissedSignals.find((d) => d.id === id)?.reason.trim();
      return dismissal
        ? {
            gate: `signal:${id}`,
            outcome: 'pass' as const,
            reason: `Triage flagged it; the assessment dismissed it: ${dismissal}`,
          }
        : {
            gate: `signal:${id}`,
            outcome: 'hold' as const,
            reason: 'Triage flagged this; the assessment neither confirmed nor dismissed it.',
          };
    });
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

/**
 * An exception passes only when it is long enough to be specific AND rests on a key claim that
 * passed the checks. Neither condition shows the exception is right; failing either keeps the
 * exclusion.
 */
function exclusionGates(input: GateInput): GateResult[] {
  return input.exclusions.map((finding) => {
    const exception = finding.exception?.trim() ?? '';
    const grounded = claimsNamed(finding.supportedBy, input.evidence).some((c) => c.passed);
    if (exception.length >= MIN_EXCEPTION_LENGTH && grounded) {
      return {
        gate: `exclusion:${finding.id}`,
        outcome: 'pass',
        reason: `Exception: ${exception}`,
      };
    }
    return {
      gate: `exclusion:${finding.id}`,
      outcome: 'reject',
      reason: exception
        ? `${finding.evidence} The exception isn't specific enough or isn't tied to a key claim that passed the checks.`
        : finding.evidence,
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

function editorialGate(input: GateInput): GateResult {
  const problem =
    editorialTestProblem(input.editorialTest) ??
    (claimsNamed(input.evidence.editorialSupport, input.evidence).length === 0
      ? 'The answer names no key claim it rests on, so it is not shown to be evidence-based.'
      : null);
  return problem
    ? { gate: 'editorial_test', outcome: 'reject', reason: problem }
    : {
        gate: 'editorial_test',
        outcome: 'pass',
        reason: 'An answer was given and names the key claims it rests on.',
      };
}

export function applyGates(input: GateInput): { outcome: GateOutcome; results: GateResult[] } {
  const results: GateResult[] = [
    sourceGate(input),
    freshnessGate(input),
    repeatGate(input),
    editorialGate(input),
    cardGate(input),
    evidenceGate(input),
    singleOriginGate(input),
    ...signalGates(input),
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
