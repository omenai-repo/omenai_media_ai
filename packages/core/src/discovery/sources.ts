import type { GeographyTier } from '@repo/shared';

/**
 * Starting source registry: discovery queries by geographic tier (§3). Breadth comes from search,
 * not crawling. Editorial review should refine these after the first weeks of real runs; they are
 * deliberately plain so the search engine, not the query, decides what is current.
 */
export interface DiscoveryQuery {
  tier: GeographyTier;
  query: string;
}

export const DISCOVERY_QUERIES: readonly DiscoveryQuery[] = [
  // Tier 1: Africa, the foundational strength.
  { tier: 1, query: 'contemporary art exhibition Lagos' },
  { tier: 1, query: 'Accra artist gallery exhibition' },
  { tier: 1, query: 'Dakar art biennale artists' },
  { tier: 1, query: 'Nairobi design fashion culture' },
  { tier: 1, query: 'Johannesburg Cape Town museum exhibition' },
  { tier: 1, query: 'African film festival filmmaker award' },
  { tier: 1, query: 'African architecture building cultural project' },
  { tier: 1, query: 'Marrakech Cairo contemporary art' },
  { tier: 1, query: 'Kinshasa Addis Ababa music artists' },
  { tier: 1, query: 'African fashion designer collection craft' },
  { tier: 1, query: 'Africa museum restitution artefacts returned' },
  { tier: 1, query: 'Abidjan Kigali creative scene cultural space' },
  { tier: 1, query: 'African collector foundation art collection' },
  { tier: 1, query: 'Nigerian Ghanaian musicians album cultural' },
  // Tier 2: Brazil and the wider Global South.
  { tier: 2, query: 'São Paulo Rio contemporary art exhibition' },
  { tier: 2, query: 'Brazil design architecture culture' },
  { tier: 2, query: 'Brazilian film music artists' },
  { tier: 2, query: 'Caribbean artists exhibition heritage' },
  { tier: 2, query: 'Mexico City Bogotá art gallery' },
  { tier: 2, query: 'India Pakistan Bangladesh art biennale' },
  { tier: 2, query: 'Southeast Asia contemporary art craft' },
  { tier: 2, query: 'Middle East artists museum exhibition' },
  { tier: 2, query: 'Global South design fashion craft' },
  { tier: 2, query: 'diaspora artists cultural exchange exhibition' },
  // Tier 3: UK and Europe.
  { tier: 3, query: 'London museum exhibition African artists' },
  { tier: 3, query: 'Paris Milan fashion design culture' },
  { tier: 3, query: 'Venice Berlin Basel art fair biennale' },
  { tier: 3, query: 'European museum restitution colonial collections' },
  { tier: 3, query: 'Lisbon Brussels gallery diaspora artists' },
  // Tier 4: North America.
  { tier: 4, query: 'New York gallery exhibition artists' },
  { tier: 4, query: 'Los Angeles museum architecture design' },
  { tier: 4, query: 'Black artists institutions collectors United States' },
  { tier: 4, query: 'North America film festival documentary culture' },
  // Tier 5: wider global opportunities.
  { tier: 5, query: 'Tokyo Seoul design exhibition craft' },
  { tier: 5, query: 'Hong Kong art market collectors museum' },
  { tier: 5, query: 'Dubai Sharjah art foundation biennial' },
  { tier: 5, query: 'artificial intelligence creativity artists culture debate' },
];

/**
 * Per-run mix (a discovery weight, not a quota): Africa 40%, Global South 30%, then 10% each.
 * Rounding gives tier 1 any remainder, so it always receives at least its share.
 */
const TIER_SHARE: Record<GeographyTier, number> = { 1: 0.4, 2: 0.3, 3: 0.1, 4: 0.1, 5: 0.1 };

function dayNumber(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * Deterministic daily selection: the same date always yields the same queries, and consecutive
 * days rotate through each tier's list so coverage spreads over time.
 */
export function selectQueries(
  dateKey: string,
  count: number,
  registry: readonly DiscoveryQuery[] = DISCOVERY_QUERIES,
): DiscoveryQuery[] {
  const tiers = [1, 2, 3, 4, 5] as const;
  const quota = Object.fromEntries(
    tiers.map((t) => [t, Math.floor(count * TIER_SHARE[t])]),
  ) as Record<GeographyTier, number>;
  quota[1] += count - tiers.reduce((sum, t) => sum + quota[t], 0);

  const day = dayNumber(dateKey);
  return tiers.flatMap((tier) => {
    const pool = registry.filter((q) => q.tier === tier);
    const take = Math.min(quota[tier], pool.length);
    return Array.from({ length: take }, (_, i) => pool[(day * take + i) % pool.length]!);
  });
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
