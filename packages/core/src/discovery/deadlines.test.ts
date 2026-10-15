import { describe, expect, it } from 'vitest';

import { shouldCloseCandidateSet } from './deadlines.js';

const at = (h: number) => new Date(Date.UTC(2026, 10, 1, 5 + h));
const deadlines = { soft: at(2), extension: at(3), hard: at(4) };

describe('shouldCloseCandidateSet', () => {
  it('closes as soon as nothing is pending', () => {
    expect(
      shouldCloseCandidateSet({
        now: at(0.1),
        deadlines,
        evaluated: 7,
        pending: 0,
        minCandidates: 3,
      }),
    ).toEqual({
      close: true,
      reason: 'all_done',
    });
  });

  it('waits before the soft deadline', () => {
    expect(
      shouldCloseCandidateSet({ now: at(1), deadlines, evaluated: 9, pending: 2, minCandidates: 3 })
        .close,
    ).toBe(false);
  });

  it('closes at the soft deadline when enough candidates are evaluated', () => {
    expect(
      shouldCloseCandidateSet({
        now: at(2),
        deadlines,
        evaluated: 3,
        pending: 4,
        minCandidates: 3,
      }),
    ).toEqual({
      close: true,
      reason: 'soft_deadline',
    });
  });

  it('extends once when too few are evaluated, then closes at the extension deadline', () => {
    expect(
      shouldCloseCandidateSet({
        now: at(2.5),
        deadlines,
        evaluated: 1,
        pending: 4,
        minCandidates: 3,
      }),
    ).toEqual({
      close: false,
      reason: 'extended',
    });
    expect(
      shouldCloseCandidateSet({
        now: at(3),
        deadlines,
        evaluated: 1,
        pending: 4,
        minCandidates: 3,
      }),
    ).toEqual({
      close: true,
      reason: 'extension_deadline',
    });
  });

  it('always closes at the hard deadline', () => {
    const late = { soft: at(2), extension: at(5), hard: at(4) };
    expect(
      shouldCloseCandidateSet({
        now: at(4),
        deadlines: late,
        evaluated: 0,
        pending: 9,
        minCandidates: 3,
      }),
    ).toEqual({
      close: true,
      reason: 'hard_deadline',
    });
  });
});
