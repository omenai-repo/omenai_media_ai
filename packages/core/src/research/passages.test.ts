import { describe, expect, it } from 'vitest';

import { GAP_MARKER, passagesFor } from './passages.js';

/** A stored page shaped like the live interview: navigation first, the answer far down. */
const page = [
  '[Log In](https://example.org/login) [Subscribe](https://example.org/subscribe)',
  '##### [Museums & Institutions](https://example.org/museums)',
  '# Lunch With Adam: a curator on the revitalised wing',
  ...Array.from({ length: 12 }, (_, i) =>
    `Paragraph ${i + 1} about collecting history and restitution debates in general. `.repeat(4),
  ),
  'On the reopening, LaGamma said the wing was rebuilt so visitors meet the works in natural light.',
  ...Array.from({ length: 6 }, (_, i) =>
    `Closing paragraph ${i + 1} about the lunch itself. `.repeat(4),
  ),
].join('\n\n');

describe('the passages a prompt shows for a question', () => {
  it('finds a passage past the opening, within the same budget', () => {
    const shown = passagesFor(page, 'What does LaGamma say about the reopening?', 1_200);
    expect(page.indexOf('On the reopening')).toBeGreaterThan(1_200);
    expect(shown).toContain('On the reopening, LaGamma said the wing was rebuilt');
    expect(shown.length).toBeLessThanOrEqual(1_200);
  });

  it('keeps passages in their order, marks the gaps, and leaves page furniture out', () => {
    const shown = passagesFor(page, 'What does LaGamma say about the reopening?', 1_200);
    expect(shown).not.toContain('[Log In]');
    expect(shown).toContain(GAP_MARKER);
    // Every passage is the source's own text, so a quote from one is found word for word.
    for (const passage of shown.split(/\n\n/).map((p) => p.replace(`${GAP_MARKER}\n`, '')))
      expect(page).toContain(passage);
  });

  it('shows the opening when nothing matches, or when the whole source fits', () => {
    expect(passagesFor(page, 'Anything about ceramics?', 500)).toBe(passagesFor(page, null, 500));
    expect(passagesFor('A short source.', 'reopening', 500)).toBe('A short source.');
  });
});
