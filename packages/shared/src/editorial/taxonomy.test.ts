import { describe, expect, it } from 'vitest';

import { SCORING_DIMENSIONS, SCORING_DIMENSION_IDS } from './scoring.js';
import {
  bestTier,
  CROSS_CUTTING_TAGS,
  EXCLUSIONS,
  PILLAR_IDS,
  PILLARS,
  pillarOfSubcategory,
  REGION_IDS,
  SUBCATEGORY_IDS,
} from './taxonomy.js';

describe('playbook taxonomy', () => {
  it('has the six pillars, each with subcategories, and unique subcategory ids', () => {
    expect(PILLAR_IDS).toHaveLength(6);
    for (const pillar of PILLAR_IDS) {
      expect(Object.keys(PILLARS[pillar].subcategories).length).toBeGreaterThan(5);
    }
    expect(new Set(SUBCATEGORY_IDS).size).toBe(SUBCATEGORY_IDS.length);
    expect(pillarOfSubcategory('restitution_stewardship')).toBe('ideas_history_cultural_change');
  });

  it('lists the 11 cross-cutting tags and the 10 exclusions from the playbook', () => {
    expect(CROSS_CUTTING_TAGS.ids).toHaveLength(11);
    expect(EXCLUSIONS.ids).toHaveLength(10);
  });

  it('scores eight dimensions whose weights sum to 100', () => {
    expect(SCORING_DIMENSION_IDS).toHaveLength(8);
    const sum = SCORING_DIMENSION_IDS.reduce((acc, id) => acc + SCORING_DIMENSIONS[id].weight, 0);
    expect(sum).toBe(100);
    expect(SCORING_DIMENSIONS.cultural_significance.weight).toBe(25);
    expect(SCORING_DIMENSIONS.commercial_adjacency.weight).toBe(5);
  });

  it('maps regions to geographic tiers, Africa first', () => {
    expect(REGION_IDS).toContain('west_africa');
    expect(bestTier(['europe', 'west_africa'])).toBe(1);
    expect(bestTier(['brazil', 'north_america'])).toBe(2);
    expect(bestTier(['gulf_states'])).toBe(5);
    expect(bestTier([])).toBe(5);
  });
});
