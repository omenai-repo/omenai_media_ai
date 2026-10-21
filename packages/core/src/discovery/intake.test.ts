import { describe, expect, it } from 'vitest';

import { fairOrder, type IntakeItem } from './intake.js';

const item = (
  id: string,
  batch: string,
  day: number,
  lane: string | null,
  score: number,
  laneTier: number | null = 1,
): IntakeItem => ({
  id,
  batch,
  foundAt: new Date(Date.UTC(2026, 9, day)),
  lane,
  laneTier,
  score,
});

describe('fairOrder', () => {
  const items = [
    item('n1', 'day2', 2, 'q-a', 0.99),
    item('o1', 'day1', 1, 'q-a', 0.9),
    item('o2', 'day1', 1, 'q-a', 0.8),
    item('o3', 'day1', 1, 'q-b', 0.3),
    item('o4', 'day1', 1, null, 0.95, null),
    item('o5', 'day1', 1, 'q-c', 0.5, 3),
  ];

  it('takes older batches first, then lets the queries take turns', () => {
    expect(fairOrder(items).map((i) => i.id)).toEqual([
      // day1, round 1: one per lane (tier 1 lanes by name, then tier 3, then the unknown lane)
      'o1',
      'o3',
      'o5',
      'o4',
      // day1, round 2
      'o2',
      // day2
      'n1',
    ]);
  });

  it('never compares scores across queries', () => {
    const order = fairOrder(items).map((i) => i.id);
    // q-b's 0.3 comes before q-a's second item at 0.8.
    expect(order.indexOf('o3')).toBeLessThan(order.indexOf('o2'));
  });

  it('is deterministic whatever the input order', () => {
    const expected = fairOrder(items).map((i) => i.id);
    for (const shuffled of [items.toReversed(), [...items.slice(3), ...items.slice(0, 3)]])
      expect(fairOrder(shuffled).map((i) => i.id)).toEqual(expected);
  });
});
