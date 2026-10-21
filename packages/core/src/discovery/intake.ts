/**
 * Fair, bounded intake (ADR-042). Each stage still takes at most its cap per run; this decides
 * which items fill it. Older batches go first, so nothing waits behind newer work indefinitely,
 * and within a batch the queries take turns: a search score is relevance to one query, so scores
 * from different queries are never compared.
 */
export interface IntakeItem {
  /** The run that first found it: one batch. */
  batch: string;
  /** When the batch was found; older batches go first. */
  foundAt: Date;
  /** The originating query (null for records stored before queries were kept). */
  lane: string | null;
  laneTier: number | null;
  /** Relevance to its own query only. */
  score: number;
  /** Stable tiebreak. */
  id: string;
}

const UNKNOWN_LANE = '\u0000unknown';

function interleave<T extends IntakeItem>(items: readonly T[]): T[] {
  const lanes = new Map<string, T[]>();
  for (const item of items) {
    const key = item.lane ?? UNKNOWN_LANE;
    lanes.set(key, [...(lanes.get(key) ?? []), item]);
  }
  const ordered = [...lanes.entries()]
    .map(([key, list]) => ({
      key,
      tier: list[0]?.laneTier ?? 6,
      list: list.toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
    }))
    .toSorted((a, b) => a.tier - b.tier || a.key.localeCompare(b.key));
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round += 1)
    for (const lane of ordered) {
      const next = lane.list[round];
      if (next) out.push(next);
    }
  return out;
}

/** Oldest batch first; within a batch, one item per query in turn. Deterministic. */
export function fairOrder<T extends IntakeItem>(items: readonly T[]): T[] {
  const batches = new Map<string, T[]>();
  for (const item of items) batches.set(item.batch, [...(batches.get(item.batch) ?? []), item]);
  return [...batches.values()]
    .map((list) => ({
      list,
      foundAt: Math.min(...list.map((i) => i.foundAt.getTime())),
      key: list[0]!.batch,
    }))
    .toSorted((a, b) => a.foundAt - b.foundAt || a.key.localeCompare(b.key))
    .flatMap(({ list }) => interleave(list));
}

/** The intake view of a stored article. */
export function articleIntake(article: {
  _id: { toString(): string };
  firstRunKey?: string | null;
  retrievedAt: Date;
  searchQuery?: string | null;
  searchTier?: number | null;
  searchScore?: number | null;
}): IntakeItem {
  return {
    batch: article.firstRunKey ?? '',
    foundAt: article.retrievedAt,
    lane: article.searchQuery ?? null,
    laneTier: article.searchTier ?? null,
    score: article.searchScore ?? 0,
    id: article._id.toString(),
  };
}
