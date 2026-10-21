import type { GeographyTier, PillarId } from '@repo/shared';

/**
 * Starting source registry: discovery queries by geographic tier (§3), each tagged with the pillar
 * (§4) it mainly searches. Breadth comes from search, not crawling. Editorial review should refine
 * these after the first weeks of real runs; they are deliberately plain so the search engine, not
 * the query, decides what is current.
 */
export interface DiscoveryQuery {
  tier: GeographyTier;
  pillar: PillarId;
  query: string;
}

const A = 'art_creative_expression';
const B = 'fashion_design_objects';
const C = 'film_music_performance';
const D = 'places_architecture_living';
const E = 'people_influence_institutions';
const F = 'ideas_history_cultural_change';

export const DISCOVERY_QUERIES: readonly DiscoveryQuery[] = [
  // Tier 1: Africa, the foundational strength.
  { tier: 1, pillar: A, query: 'contemporary art exhibition Lagos' },
  { tier: 1, pillar: A, query: 'Accra artist gallery exhibition' },
  { tier: 1, pillar: A, query: 'Dakar art biennale artists' },
  { tier: 1, pillar: B, query: 'Nairobi design fashion culture' },
  { tier: 1, pillar: A, query: 'Johannesburg Cape Town museum exhibition' },
  { tier: 1, pillar: C, query: 'African film festival filmmaker award' },
  { tier: 1, pillar: D, query: 'African architecture building cultural project' },
  { tier: 1, pillar: A, query: 'Marrakech Cairo contemporary art' },
  { tier: 1, pillar: C, query: 'Kinshasa Addis Ababa music artists' },
  { tier: 1, pillar: B, query: 'African fashion designer collection craft' },
  { tier: 1, pillar: F, query: 'Africa museum restitution artefacts returned' },
  { tier: 1, pillar: D, query: 'Abidjan Kigali creative scene cultural space' },
  { tier: 1, pillar: E, query: 'African collector foundation art collection' },
  { tier: 1, pillar: C, query: 'Nigerian Ghanaian musicians album cultural' },
  // Tier 2: Brazil and the wider Global South.
  { tier: 2, pillar: A, query: 'São Paulo Rio contemporary art exhibition' },
  { tier: 2, pillar: B, query: 'Brazil design architecture culture' },
  { tier: 2, pillar: C, query: 'Brazilian film music artists' },
  { tier: 2, pillar: A, query: 'Caribbean artists exhibition heritage' },
  { tier: 2, pillar: A, query: 'Mexico City Bogotá art gallery' },
  { tier: 2, pillar: A, query: 'India Pakistan Bangladesh art biennale' },
  { tier: 2, pillar: A, query: 'Southeast Asia contemporary art craft' },
  { tier: 2, pillar: A, query: 'Middle East artists museum exhibition' },
  { tier: 2, pillar: B, query: 'Global South design fashion craft' },
  { tier: 2, pillar: F, query: 'diaspora artists cultural exchange exhibition' },
  // Tier 3: UK and Europe.
  { tier: 3, pillar: A, query: 'London museum exhibition African artists' },
  { tier: 3, pillar: B, query: 'Paris Milan fashion design culture' },
  { tier: 3, pillar: A, query: 'Venice Berlin Basel art fair biennale' },
  { tier: 3, pillar: F, query: 'European museum restitution colonial collections' },
  { tier: 3, pillar: A, query: 'Lisbon Brussels gallery diaspora artists' },
  // Tier 4: North America.
  { tier: 4, pillar: A, query: 'New York gallery exhibition artists' },
  { tier: 4, pillar: D, query: 'Los Angeles museum architecture design' },
  { tier: 4, pillar: E, query: 'Black artists institutions collectors United States' },
  { tier: 4, pillar: C, query: 'North America film festival documentary culture' },
  // Tier 5: wider global opportunities.
  { tier: 5, pillar: B, query: 'Tokyo Seoul design exhibition craft' },
  { tier: 5, pillar: A, query: 'Hong Kong art market collectors museum' },
  { tier: 5, pillar: A, query: 'Dubai Sharjah art foundation biennial' },
  { tier: 5, pillar: F, query: 'artificial intelligence creativity artists culture debate' },
];

/**
 * DRAFT, NOT SEARCHED: proposed additions (2026-10-20 audit) so every tier covers all six pillars,
 * filling gaps the registry had (food, hospitality, homes and interiors, theatre and dance,
 * writers, jewellery and objects, subcultures). The wording is editorial: these join
 * `DISCOVERY_QUERIES` only after the product owner approves them.
 */
export const DRAFT_DISCOVERY_QUERIES: readonly DiscoveryQuery[] = [
  { tier: 1, pillar: D, query: 'Lagos Accra chef restaurant food culture' },
  { tier: 1, pillar: C, query: 'African theatre dance company performance' },
  { tier: 1, pillar: E, query: 'African writer novelist literary prize interview' },
  { tier: 1, pillar: B, query: 'African jewellery designer objects craft' },
  { tier: 1, pillar: F, query: 'African youth subculture identity movement' },
  { tier: 2, pillar: D, query: 'Brazil architecture public space city' },
  { tier: 2, pillar: D, query: 'São Paulo Mexico City chef culinary heritage' },
  { tier: 2, pillar: E, query: 'Latin American South Asian writer curator profile' },
  { tier: 2, pillar: F, query: 'Afro-Brazilian heritage memory history' },
  { tier: 2, pillar: C, query: 'Caribbean carnival music dance performance' },
  { tier: 3, pillar: C, query: 'London Paris theatre dance premiere' },
  { tier: 3, pillar: D, query: 'European architecture landmark cultural building' },
  { tier: 3, pillar: E, query: 'London Paris curator gallerist profile interview' },
  { tier: 4, pillar: B, query: 'New York collectible design objects fashion' },
  { tier: 4, pillar: F, query: 'United States cultural history archive debate' },
  { tier: 5, pillar: C, query: 'Tokyo Seoul film music performance' },
  { tier: 5, pillar: D, query: 'Tokyo Seoul architecture hospitality destination' },
  { tier: 5, pillar: E, query: 'Asia Pacific museum founder collector profile' },
];

/**
 * Per-run mix (a discovery weight, not a quota on recommendations): Africa 40%, Global South 30%,
 * then 10% each. Rotation spreads searches over time; it never guarantees what is found, and
 * ranking ignores it (tier is only a final tiebreak).
 */
const TIER_SHARE: Record<GeographyTier, number> = { 1: 4, 2: 3, 3: 1, 4: 1, 5: 1 };
const TIERS = [1, 2, 3, 4, 5] as const;

/**
 * The fixed 10-slot cycle of tiers, spread out by smooth weighted round-robin so no tier's turns
 * bunch together: 1,2,3,1,2,4,1,5,2,1.
 */
export const TIER_CYCLE: readonly GeographyTier[] = (() => {
  const total = TIERS.reduce((sum, t) => sum + TIER_SHARE[t], 0);
  const current: Record<GeographyTier, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  return Array.from({ length: total }, () => {
    for (const t of TIERS) current[t] += TIER_SHARE[t];
    const pick = TIERS.reduce((best, t) => (current[t] > current[best] ? t : best), TIERS[0]);
    current[pick] -= total;
    return pick;
  });
})();

function dayNumber(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** A tier's queries ordered so consecutive turns move through the pillars. */
function tierPool(registry: readonly DiscoveryQuery[], tier: GeographyTier): DiscoveryQuery[] {
  const byPillar = new Map<string, DiscoveryQuery[]>();
  for (const q of registry.filter((q) => q.tier === tier))
    byPillar.set(q.pillar, [...(byPillar.get(q.pillar) ?? []), q]);
  const lanes = [...byPillar.values()];
  const pool: DiscoveryQuery[] = [];
  for (let round = 0; pool.length < lanes.flat().length; round += 1)
    for (const lane of lanes) if (lane[round]) pool.push(lane[round]!);
  return pool;
}

/** How many of `tier`'s turns come before cycle slot `slot` (counting from slot 0). */
function turnsBefore(tier: GeographyTier, slot: number): number {
  const cycles = Math.floor(slot / TIER_CYCLE.length);
  const within = TIER_CYCLE.slice(0, slot % TIER_CYCLE.length).filter((t) => t === tier).length;
  return cycles * TIER_SHARE[tier] + within;
}

/**
 * Deterministic daily selection: day d takes the next `count` slots of the tier cycle, and each
 * tier's turn takes the next query in that tier's pool. Over any 10 days every tier gets exactly
 * its share of searches, for any count; at 10 a day each day is 4/3/1/1/1. The same date,
 * count and registry always give the same queries.
 */
export function selectQueries(
  dateKey: string,
  count: number,
  registry: readonly DiscoveryQuery[] = DISCOVERY_QUERIES,
): DiscoveryQuery[] {
  const pools = new Map(TIERS.map((t) => [t, tierPool(registry, t)]));
  const first = dayNumber(dateKey) * count;
  const chosen: DiscoveryQuery[] = [];
  for (let slot = first; slot < first + count; slot += 1) {
    const tier = TIER_CYCLE[slot % TIER_CYCLE.length]!;
    const pool = pools.get(tier) ?? [];
    if (pool.length === 0) continue;
    const query = pool[turnsBefore(tier, slot) % pool.length]!;
    // A tier asked for more turns in a day than it has queries doesn't repeat one.
    if (!chosen.includes(query)) chosen.push(query);
  }
  return chosen;
}

/** Social platforms and shops: not sources a recommendation can rest on. */
export const EXCLUDED_DOMAINS = [
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'x.com',
  'twitter.com',
  'pinterest.com',
  'youtube.com',
  'reddit.com',
  'linkedin.com',
  'amazon.com',
  'etsy.com',
  'ebay.com',
] as const;
