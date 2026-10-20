import type { DraftStatusDto, ResearchStatusDto, StoryCardDto } from '@repo/core';

/**
 * How an edition's recommended stories are laid out, from its data alone: the lead, then the
 * rest in rank order as wide bands, a row of three columns and ranked rows. Sections appear only
 * when they have stories; nothing depends on which edition it is.
 */

export type ColumnShape = 'portrait' | 'landscape' | 'text';
/** Which side of a band its image sits on. */
export type BandSide = 'left' | 'right';

export interface EditionPlan<T> {
  lead: T | null;
  /**
   * Stories two to four as wide bands, image beside text, alternating sides from the left: the
   * second story always, the third and fourth when there aren't three stories to fill a row.
   */
  bands: Array<{ story: T; side: BandSide }>;
  /** Stories three to five as a row of columns, only when all three are there. */
  columns: Array<{ story: T; shape: ColumnShape }>;
  /** Stories six onwards. */
  ranked: T[];
  /** "More from this edition", the subject index and the list at a glance need a second story. */
  hasMore: boolean;
}

export function planEdition<T extends { image: unknown }>(shortlist: readonly T[]): EditionPlan<T> {
  const [lead = null, ...rest] = shortlist;
  // Columns share a row only as a full three. One or two alone would each stretch across the
  // page, their images with them, so those stories continue the bands instead.
  const row = rest.length >= 4 ? rest.slice(1, 4) : [];
  const bands = (row.length ? rest.slice(0, 1) : rest).map((story, index) => ({
    story,
    side: index % 2 === 0 ? ('left' as const) : ('right' as const),
  }));
  let images = 0;
  const columns = row.map((story) => {
    if (!story.image) return { story, shape: 'text' as const };
    images += 1;
    return { story, shape: images === 1 ? ('portrait' as const) : ('landscape' as const) };
  });
  return { lead, bands, columns, ranked: rest.slice(4), hasMore: shortlist.length > 1 };
}

/**
 * The lead's state in words, from stored records: its standing, the editor's decision and how far
 * research and drafting have got. No scores or counts: those belong on Story Review.
 */
export function leadStatus(
  story: Pick<StoryCardDto, 'score' | 'editorialState'>,
  research: Pick<ResearchStatusDto, 'state'> | null,
  drafts: Pick<DraftStatusDto, 'writing' | 'versions'> | null,
): string[] {
  const standing = story.score.band === 'priority' ? 'priority' : null;
  const decision =
    story.editorialState === 'saved'
      ? 'saved'
      : story.editorialState === 'skipped'
        ? 'skipped'
        : null;
  const researched = research
    ? {
        none: 'not researched yet',
        running: 'research in progress',
        ready: 'researched',
        failed: 'research didn’t finish',
      }[research.state]
    : null;
  const drafted = drafts?.writing ? 'draft under way' : drafts?.versions ? 'drafts started' : null;
  return [standing, decision, researched, drafted].filter((item): item is string => Boolean(item));
}
