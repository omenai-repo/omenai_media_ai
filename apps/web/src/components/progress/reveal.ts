/**
 * Pacing for text that arrives in bursts. A model streams its answer as a few large pieces after
 * a wait (live: the whole answer within about half a second, 2026-10-16), and printing each piece
 * as it lands reads as a jolt. Instead the text is revealed word by word at a steady speed that
 * adapts to how much is waiting, so the added delay stays small and bounded:
 *
 * - text that has arrived is all on screen within `catchUpMs` of its arrival;
 * - once the whole answer is in, the rest appears within `finishMs`;
 * - the speed never drops below `minCharsPerSecond`, so short answers don't crawl.
 */
export const REVEAL = {
  minCharsPerSecond: 120,
  catchUpMs: 1_200,
  finishMs: 400,
} as const;

/** One frame never asks for less than this much time left, so an overdue backlog shows at once. */
const FRAME_MS = 16;

/**
 * How many characters should be on screen after `elapsedMs` more, revealing the backlog at the
 * constant speed that finishes it by the deadline (`remainingMs` from now).
 */
export function revealCount(input: {
  shown: number;
  target: number;
  elapsedMs: number;
  remainingMs: number;
}): number {
  const backlog = input.target - input.shown;
  if (backlog <= 0) return input.target;
  const perMs = Math.max(
    REVEAL.minCharsPerSecond / 1_000,
    backlog / Math.max(input.remainingMs, FRAME_MS),
  );
  return Math.min(input.target, input.shown + perMs * Math.max(0, input.elapsedMs));
}

/** The deadline for what has arrived: soon after the latest piece, sooner once all is in. */
export function revealDeadline(arrivedAt: number, completeAt: number | null): number {
  const catchUp = arrivedAt + REVEAL.catchUpMs;
  return completeAt === null ? catchUp : Math.min(catchUp, completeAt + REVEAL.finishMs);
}

/** A word longer than this is revealed in parts (text without spaces, a long link). */
const LONGEST_WORD = 24;

/**
 * Where to cut `text` to show about `count` characters: at the end of the word being revealed,
 * so words appear whole, and never between the two halves of a surrogate pair.
 */
export function revealCut(text: string, count: number): number {
  if (count >= text.length) return text.length;
  let cut = Math.max(0, Math.floor(count));
  if (cut === 0) return 0;
  const toSpace = text.slice(cut).search(/\s/);
  if (toSpace < 0 ? text.length - cut <= LONGEST_WORD : toSpace <= LONGEST_WORD)
    cut = toSpace < 0 ? text.length : cut + toSpace;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut += 1;
  return Math.min(cut, text.length);
}

/**
 * What of the text so far can be shown: all of it once complete; until then, everything up to the
 * last space, so a word still arriving (a piece can end mid-word) doesn't sit half-written.
 */
export function settledText(text: string, complete: boolean): string {
  if (complete) return text;
  const lastSpace = text.search(/\s\S*$/);
  return lastSpace > 0 ? text.slice(0, lastSpace) : text;
}

/** How much of `next` can stay on screen when the text changes: where it agrees with `shown`. */
export function keptPrefix(shown: string, next: string): number {
  const limit = Math.min(shown.length, next.length);
  let i = 0;
  while (i < limit && shown.charCodeAt(i) === next.charCodeAt(i)) i += 1;
  return i;
}
