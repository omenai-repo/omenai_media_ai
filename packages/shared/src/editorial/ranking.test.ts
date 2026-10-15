import { describe, expect, it } from 'vitest';

import type { GateResult } from './gates.js';
import { classifyEvaluated, rankShortlist, type RankableCandidate } from './ranking.js';

const pass: GateResult = { gate: 'sources', outcome: 'pass', reason: '' };

describe('classifyEvaluated', () => {
  it('lets gates override any score', () => {
    const rejected = {
      outcome: 'reject' as const,
      results: [{ gate: 'exclusion:fame_only', outcome: 'reject' as const, reason: '' }],
    };
    expect(classifyEvaluated(rejected, 98)).toBe('gate_reject');
    expect(classifyEvaluated({ outcome: 'hold', results: [pass] }, 98)).toBe('gate_hold');
  });

  it('labels repeat-only rejections as suppressed repeats', () => {
    const repeat = {
      outcome: 'reject' as const,
      results: [{ gate: 'repeat', outcome: 'reject' as const, reason: '' }],
    };
    expect(classifyEvaluated(repeat, 90)).toBe('suppressed_repeat');
  });

  it('applies the 65 threshold to stories that pass the gates', () => {
    expect(classifyEvaluated({ outcome: 'pass', results: [pass] }, 65)).toBe('qualified');
    expect(classifyEvaluated({ outcome: 'pass', results: [pass] }, 64.9)).toBe('below_threshold');
  });
});

describe('rankShortlist', () => {
  const candidate = (
    id: string,
    total: number,
    extra: Partial<RankableCandidate> = {},
  ): RankableCandidate => ({
    id,
    total,
    outcome: 'qualified',
    confidence: 'medium',
    tier: 3,
    ...extra,
  });

  it('returns only qualified candidates, highest score first, capped at max', () => {
    const ranked = rankShortlist(
      [
        candidate('a', 70),
        candidate('b', 91),
        candidate('c', 88, { outcome: 'gate_reject' }),
        candidate('d', 60, { outcome: 'below_threshold' }),
        candidate('e', 82),
      ],
      2,
    );
    expect(ranked.map((c) => c.id)).toEqual(['b', 'e']);
  });

  it('never pads a short list: two qualifiers give a two-item shortlist', () => {
    const ranked = rankShortlist(
      [candidate('a', 75), candidate('b', 66), candidate('c', 64, { outcome: 'below_threshold' })],
      8,
    );
    expect(ranked.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('breaks ties by confidence, then geographic priority', () => {
    const ranked = rankShortlist(
      [
        candidate('europe', 80, { tier: 3, confidence: 'high' }),
        candidate('lagos', 80, { tier: 1, confidence: 'high' }),
        candidate('lowconf', 80, { tier: 1, confidence: 'low' }),
      ],
      8,
    );
    expect(ranked.map((c) => c.id)).toEqual(['lagos', 'europe', 'lowconf']);
  });
});

describe('recommendedActionFor', () => {
  it('only lets qualified stories be pitched or escalated for urgent review', async () => {
    const { recommendedActionFor } = await import('./ranking.js');
    expect(recommendedActionFor('qualified', 'priority', 'urgent')).toBe('urgent_review');
    expect(recommendedActionFor('qualified', 'priority', 'evergreen')).toBe('pitch');
    expect(recommendedActionFor('qualified', 'shortlist', 'urgent')).toBe('shortlist');
    expect(recommendedActionFor('gate_reject', 'priority', 'urgent')).toBe('reject');
    expect(recommendedActionFor('gate_hold', 'priority', 'urgent')).toBe('research');
    expect(recommendedActionFor('below_threshold', 'below_threshold', null)).toBe('monitor');
  });
});
