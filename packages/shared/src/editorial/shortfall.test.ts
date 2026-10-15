import { describe, expect, it } from 'vitest';

import { deriveShortfallReasons, emptyFunnel } from './shortfall.js';

describe('deriveShortfallReasons', () => {
  it('is empty when the run met the target', () => {
    expect(deriveShortfallReasons({ ...emptyFunnel(), qualified: 5 }, 5)).toEqual([]);
  });

  it('explains a short list with every contributing cause, largest first', () => {
    const reasons = deriveShortfallReasons(
      {
        ...emptyFunnel(),
        searchFailures: 1,
        extractionFailures: 2,
        evaluated: 12,
        evaluationFailures: 1,
        gateRejects: 6,
        gateHolds: 1,
        gateRejectsByGate: {
          'exclusion:thin_listicle_seo': 3,
          'exclusion:routine_announcement': 3,
        },
        belowThreshold: 3,
        suppressedRepeats: 1,
        qualified: 2,
      },
      5,
    );
    expect(reasons.map((r) => r.code)).toEqual([
      'editorial_gates',
      'source_failures',
      'below_threshold',
      'evaluation_failures',
      'suppressed_repeats',
    ]);
    expect(reasons[0]?.breakdown).toEqual({
      'exclusion:thin_listicle_seo': 3,
      'exclusion:routine_announcement': 3,
    });
  });

  it('reports insufficient candidates when too few reached evaluation', () => {
    const reasons = deriveShortfallReasons({ ...emptyFunnel(), evaluated: 2, qualified: 1 }, 5);
    expect(reasons.map((r) => r.code)).toContain('insufficient_candidates');
  });
});
