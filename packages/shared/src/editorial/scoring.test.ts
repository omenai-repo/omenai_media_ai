import { describe, expect, it } from 'vitest';

import { scoreBand, weightedTotal, type DimensionScores } from './scoring.js';

const all = (n: number): DimensionScores => ({
  cultural_significance: n,
  distinctive_angle: n,
  originality: n,
  human_interest_access: n,
  visual_potential: n,
  audience_relevance: n,
  timeliness: n,
  commercial_adjacency: n,
});

describe('weightedTotal', () => {
  it('spans 0 to 100', () => {
    expect(weightedTotal(all(0))).toBe(0);
    expect(weightedTotal(all(5))).toBe(100);
    expect(weightedTotal(all(4))).toBe(80);
  });

  it('applies the playbook weights: Σ(score / 5 × weight)', () => {
    const scores: DimensionScores = {
      cultural_significance: 5, // 25
      distinctive_angle: 4, // 16
      originality: 3, // 9
      human_interest_access: 4, // 8
      visual_potential: 5, // 10
      audience_relevance: 3, // 6
      timeliness: 2, // 2
      commercial_adjacency: 1, // 1
    };
    expect(weightedTotal(scores)).toBe(77);
  });

  it('weights significance far above commercial adjacency', () => {
    const significant = { ...all(3), cultural_significance: 5, commercial_adjacency: 0 };
    const commercial = { ...all(3), cultural_significance: 0, commercial_adjacency: 5 };
    expect(weightedTotal(significant)).toBeGreaterThan(weightedTotal(commercial));
  });

  it.each([-1, 6, 2.5, Number.NaN])('rejects a dimension score of %s', (bad) => {
    expect(() => weightedTotal({ ...all(3), originality: bad })).toThrow(RangeError);
  });
});

describe('scoreBand', () => {
  it.each([
    [100, 'priority'],
    [80, 'priority'],
    [79.9, 'shortlist'],
    [65, 'shortlist'],
    [64.9, 'below_threshold'],
    [0, 'below_threshold'],
  ] as const)('%d → %s', (total, band) => {
    expect(scoreBand(total)).toBe(band);
  });
});
