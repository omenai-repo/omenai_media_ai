/**
 * Publication formats for drafts, and how a draft measures against each one's limit. Shared by
 * the server (which checks generated drafts and asks for one shorter version) and the studio
 * (which counts as the editor types), so both always agree. Drafts are never published from here.
 *
 * Character limits are the channels' own maximums and are hard: a draft over one is flagged, never
 * silently cut. Word ranges are Omenai's guidance for the briefing and editorials, so a draft
 * outside one is noted, not treated as an error.
 *
 * A count is never allowed to come out lower than the channel's own: where we can't be sure how
 * the channel counts something, we give a range and only call a draft within the limit when the
 * top of the range fits.
 */

export const DRAFT_FORMAT_IDS = [
  'newsletter_item',
  'editorial_article',
  'linkedin_post',
  'instagram_caption',
  'x_post',
] as const;
export type DraftFormat = (typeof DRAFT_FORMAT_IDS)[number];

export type DraftLimit =
  | {
      unit: 'characters';
      max: number;
      /** `x`: X's published weighting; `conservative`: never fewer than the channel counts. */
      counting: 'x' | 'conservative';
    }
  | { unit: 'words'; min: number; max: number };

export interface DraftFormatSpec {
  label: string;
  /** One line for the format picker: what it's for. */
  purpose: string;
  /** Formats with a headline (the briefing item and editorials); social posts have none. */
  hasTitle: boolean;
  limit: DraftLimit;
}

export const DRAFT_FORMATS: Record<DraftFormat, DraftFormatSpec> = {
  newsletter_item: {
    label: 'Weekly Briefing item',
    purpose: 'What happened and why it matters, for Omenai Insider’s Thursday briefing.',
    hasTitle: true,
    limit: { unit: 'words', min: 150, max: 300 },
  },
  editorial_article: {
    label: 'Editorial article',
    purpose: 'A feature with context, history and the people involved.',
    hasTitle: true,
    limit: { unit: 'words', min: 800, max: 1_500 },
  },
  linkedin_post: {
    label: 'LinkedIn post',
    purpose: 'The story’s significance for a professional audience.',
    hasTitle: false,
    limit: { unit: 'characters', max: 3_000, counting: 'conservative' },
  },
  instagram_caption: {
    label: 'Instagram caption',
    purpose: 'A caption led by what the picture shows.',
    hasTitle: false,
    limit: { unit: 'characters', max: 2_200, counting: 'conservative' },
  },
  x_post: {
    label: 'X post',
    purpose: 'One clear sentence or two that make people want to know more.',
    hasTitle: false,
    limit: { unit: 'characters', max: 280, counting: 'x' },
  },
};

export function isDraftFormat(value: unknown): value is DraftFormat {
  return typeof value === 'string' && (DRAFT_FORMAT_IDS as readonly string[]).includes(value);
}

export function countWords(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

// ── X ────────────────────────────────────────────────────────────────────────

/**
 * X's counting rules, checked on 2026-10-16 against docs.x.com/fundamentals/counting-characters
 * and twitter-text's config/v3.json: text is normalised to NFC; code points in these ranges weigh
 * 1 and all others 2; every emoji (with its modifiers and joiners) weighs 2; every link weighs 23.
 */
export const X_COUNTING = {
  max: 280,
  linkLength: 23,
  lightRanges: [
    [0x0000, 0x10ff],
    [0x2000, 0x200d],
    [0x2010, 0x201f],
    [0x2032, 0x2037],
  ],
  verifiedOn: '2026-10-16',
} as const;

/**
 * Anything that might be a link: with or without a scheme, a dotted host ending in letters. Broad
 * on purpose ("Mr.Smith" matches): a false match only widens the range, it never lowers a count.
 */
const LINK_LIKE =
  /(?:https?:\/\/)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}(?::\d{1,5})?(?:[/?#]\S*)?/giu;
/** Links X always shortens: an http(s) scheme and a widely used top-level domain. */
const CERTAIN_LINK =
  /^https?:\/\/(?:[\p{L}\p{N}-]+\.)+(?:com|org|net|edu|gov|int|info|io|co|art|news|museum|uk|us|ca|au|nz|ie|fr|de|it|es|pt|nl|be|ch|at|se|no|dk|br|mx|ar|cl|ng|za|ke|gh|ma|eg|sn|tz|ug|rw|et|ci|cm|in|jp|cn|kr|sg|ae)(?::\d{1,5})?(?:[/?#]\S*)?$/iu;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

function isLight(codePoint: number): boolean {
  return X_COUNTING.lightRanges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** X's weighted length of plain text (no links): emoji graphemes 2, other code points 1 or 2. */
function weighText(text: string): number {
  let total = 0;
  const graphemes =
    typeof Intl.Segmenter === 'function'
      ? Array.from(
          new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text),
          (s) => s.segment,
        )
      : Array.from(text);
  for (const grapheme of graphemes) {
    if (EMOJI.test(grapheme)) {
      total += 2;
      continue;
    }
    for (const char of grapheme) total += isLight(char.codePointAt(0)!) ? 1 : 2;
  }
  return total;
}

/**
 * A post's length as X counts it. Exact (`min === max`) unless it holds something X may or may
 * not treat as a link: X counts a link as 23 whatever its length, but only text it recognises as
 * a link. Then the range covers both readings, so the top is never lower than X's own count.
 */
export function countXCharacters(text: string): { min: number; max: number } {
  const normalized = text.normalize('NFC');
  let min = 0;
  let max = 0;
  let last = 0;
  for (const match of normalized.matchAll(LINK_LIKE)) {
    const before = weighText(normalized.slice(last, match.index));
    min += before;
    max += before;
    // Trailing sentence punctuation isn't part of a link.
    const token = match[0].replace(/[.,;:!?)\]'"’”]+$/u, '');
    const trailing = weighText(match[0].slice(token.length));
    const own = weighText(token);
    if (CERTAIN_LINK.test(token)) {
      min += X_COUNTING.linkLength;
      max += X_COUNTING.linkLength;
    } else {
      min += Math.min(own, X_COUNTING.linkLength);
      max += Math.max(own, X_COUNTING.linkLength);
    }
    min += trailing;
    max += trailing;
    last = match.index + match[0].length;
  }
  const rest = weighText(normalized.slice(last));
  return { min: min + rest, max: max + rest };
}

/**
 * Instagram and LinkedIn don't publish exact counting rules. Counting UTF-16 units after NFC is
 * never lower than counting characters, and counts every emoji as at least 2.
 */
export function countConservatively(text: string): number {
  return text.normalize('NFC').length;
}

// ── Measuring a draft ───────────────────────────────────────────────────────

export interface DraftMeasure {
  /** The count in the format's unit (the body only; a headline is separate). Highest reading. */
  count: number;
  unit: DraftLimit['unit'];
  /** The lowest reading, when the channel might count some of the text differently. */
  lowest: number;
  /** Not confirmed within a hard character limit: over it, or possibly over it. */
  overLimit: boolean;
  /** Possibly over: within the limit on the lowest reading, over it on the highest. */
  uncertain: boolean;
  /** Outside the suggested word range (word formats only). */
  outsideGuidance: boolean;
  /** "243 of 280 characters", "Between 274 and 321 of 280 characters" or "212 words · aim for 150–300". */
  summary: string;
}

const n = (value: number) => value.toLocaleString('en-GB');

export function measureDraft(format: DraftFormat, body: string): DraftMeasure {
  const { limit } = DRAFT_FORMATS[format];
  if (limit.unit === 'characters') {
    const { min, max } =
      limit.counting === 'x'
        ? countXCharacters(body)
        : { min: countConservatively(body), max: countConservatively(body) };
    return {
      count: max,
      lowest: min,
      unit: 'characters',
      overLimit: max > limit.max,
      uncertain: min <= limit.max && max > limit.max,
      outsideGuidance: false,
      summary:
        min === max
          ? `${n(max)} of ${n(limit.max)} characters`
          : `Between ${n(min)} and ${n(max)} of ${n(limit.max)} characters`,
    };
  }
  const count = countWords(body);
  return {
    count,
    lowest: count,
    unit: 'words',
    overLimit: false,
    uncertain: false,
    outsideGuidance: count < limit.min || count > limit.max,
    summary: `${n(count)} ${count === 1 ? 'word' : 'words'} · aim for ${n(limit.min)}–${n(limit.max)}`,
  };
}
