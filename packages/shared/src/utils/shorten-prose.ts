/**
 * Shortens an explanation that overran its field's limit to at most `max` characters, keeping as
 * many whole leading sentences as fit. When even the first sentence is too long, it is cut at a
 * word boundary and ends with "…", so the cut is visible. The result is always a prefix of the
 * original (spacing collapsed), so nothing is reworded or invented. Text within the limit is
 * returned unchanged. For explanatory prose only: never for identifiers, quotes or decisions.
 */
export function shortenProse(text: string, max: number): string {
  if (text.trim().length <= max) return text;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;

  // A sentence ends at . ! or ? (with any closing quote or bracket) before a space or the end.
  const sentences = flat.match(/.*?[.!?]+["'”’)\]]*(?=\s|$)|.+$/g) ?? [flat];
  let kept = '';
  for (const sentence of sentences) {
    const next = kept ? `${kept} ${sentence.trim()}` : sentence.trim();
    if (next.length > max) break;
    kept = next;
  }
  if (kept) return kept;

  const room = flat.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  const cut = (space > 0 ? room.slice(0, space) : room).replace(/[\s,;:–—-]+$/, '');
  return `${cut}…`;
}
