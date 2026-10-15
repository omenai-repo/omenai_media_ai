import { describe, expect, it } from 'vitest';

import { chicagoDateKey, dailyRunKey, manualRunKey, RUN_KEY_PATTERN } from './schedule.js';

describe('Chicago run keys', () => {
  it.each([
    // Midnight CDT (UTC-5) and CST (UTC-6), around both DST transitions.
    ['2026-10-31T05:00:00Z', '2026-10-31'],
    ['2026-11-01T05:00:00Z', '2026-11-01'], // DST ends at 02:00 local this day
    ['2026-11-02T06:00:00Z', '2026-11-02'],
    ['2027-03-14T06:00:00Z', '2027-03-14'], // DST starts at 02:00 local this day
    ['2027-03-15T05:00:00Z', '2027-03-15'],
  ])('a run scheduled at %s belongs to %s', (instant, date) => {
    expect(chicagoDateKey(new Date(instant))).toBe(date);
  });

  it('maps a delayed or retried firing to the same daily key', () => {
    const scheduled = dailyRunKey(new Date('2026-11-01T05:00:00Z'));
    const retried = dailyRunKey(new Date('2026-11-01T05:59:00Z'));
    expect(scheduled).toBe('daily-discovery:2026-11-01');
    expect(retried).toBe(scheduled);
  });

  it('does not confuse the UTC date with the Chicago date', () => {
    // 03:00 UTC on Nov 2 is 21:00 CST on Nov 1 in Chicago.
    expect(chicagoDateKey(new Date('2026-11-02T03:00:00Z'))).toBe('2026-11-01');
  });

  it('produces keys that match the run-key pattern', () => {
    expect(dailyRunKey(new Date('2026-10-15T05:00:00Z'))).toMatch(RUN_KEY_PATTERN);
    expect(manualRunKey(new Date('2026-10-15T14:03:00.123Z'))).toMatch(RUN_KEY_PATTERN);
  });
});
