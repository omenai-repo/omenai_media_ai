import { describe, expect, it } from 'vitest';

import { formatDuration } from './format-duration.js';

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [0.9, '0s'],
    [59.9, '59s'],
    [60, '1m'],
    [3_600, '1h'],
    [3_725, '1h 2m 5s'],
    [90_061, '1d 1h 1m 1s'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %d', (seconds) => {
    expect(() => formatDuration(seconds)).toThrow(RangeError);
  });
});
