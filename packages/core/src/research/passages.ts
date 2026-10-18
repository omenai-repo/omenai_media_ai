import { excerpt } from '../discovery/normalize.js';
import { meaningfulTerms } from './terms.js';

/**
 * The part of a stored source a prompt shows for one question. A stored page can run to 20,000
 * characters while a prompt shows a few thousand, and the opening is often site navigation: on
 * 2026-10-18 a saved interview discussed the reopening the editor asked about at character 7,271,
 * past the 3,000 shown, so the answer looked missing and research was started for it. Instead, the
 * paragraphs that share the question's words are chosen, kept in their order, within the same
 * budget; with no match, the opening is shown as before. Deterministic: no model call or index.
 * Quotes are still checked against the whole stored text.
 */

/** Between paragraphs that weren't next to each other in the source. */
export const GAP_MARKER = '[…]';

/** Paragraphs this long or shorter that are mostly links are page furniture, not reporting. */
function isFurniture(paragraph: string): boolean {
  const links = paragraph.match(/\[[^\]]*\]\([^)]*\)/g)?.join('').length ?? 0;
  return links > paragraph.length * 0.5;
}

export function passagesFor(text: string, question: string | null, chars: number): string {
  if (text.length <= chars || !question) return excerpt(text, chars);
  const wanted = meaningfulTerms(question);
  if (!wanted.size) return excerpt(text, chars);
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((paragraph, index) => ({
      index,
      paragraph,
      furniture: isFurniture(paragraph),
      words: meaningfulTerms(paragraph),
    }));
  // A rare word ("reopen") says more about where the answer is than one on every line ("wing").
  const weight = new Map(
    [...wanted].map((term) => {
      const seen = paragraphs.filter((p) => p.words.has(term)).length;
      return [term, seen ? Math.log(1 + paragraphs.length / seen) : 0];
    }),
  );
  const scored = paragraphs.map((p) => ({
    ...p,
    score: p.furniture
      ? 0
      : [...wanted].reduce((sum, term) => sum + (p.words.has(term) ? weight.get(term)! : 0), 0),
  }));
  const best = scored
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!best.length) return excerpt(text, chars);

  // The best-matching paragraphs first, each with the one after it (an interview's answer follows
  // its question), then the rest of the budget in the source's own order, so the excerpt never
  // shows less of the source than the opening alone would.
  const chosen = new Set<number>();
  let used = 0;
  const take = (p: (typeof scored)[number] | undefined) => {
    if (!p || p.furniture) return;
    const cost = p.paragraph.length + GAP_MARKER.length + 2;
    if (chosen.has(p.index) || used + cost > chars) return;
    chosen.add(p.index);
    used += cost;
  };
  for (const p of best) {
    take(p);
    if (chosen.has(p.index)) take(scored[p.index + 1]);
  }
  if (!chosen.size) return excerpt(best[0]!.paragraph, chars);
  scored.forEach(take);
  const kept = scored.filter((p) => chosen.has(p.index));
  return kept
    .map((p, i) =>
      i > 0 && p.index !== kept[i - 1]!.index + 1 ? `${GAP_MARKER}\n${p.paragraph}` : p.paragraph,
    )
    .join('\n\n');
}
