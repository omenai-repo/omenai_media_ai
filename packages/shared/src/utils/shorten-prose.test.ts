import { describe, expect, it } from 'vitest';

import { shortenProse } from './shorten-prose.js';

/** The result is always a prefix of the original (spacing collapsed), plus "…" when cut mid-sentence. */
function isPrefix(original: string, result: string): boolean {
  const flat = original.replace(/\s+/g, ' ').trim();
  return flat.startsWith(result.replace(/…$/, ''));
}

const FITS = [
  ['art', 'A named curator and a specific exhibition: in scope.'],
  ['music', 'A festival programme with named Dakar composers.'],
  ['heritage', '  Restoration of a listed market hall, with dates.  '],
  ['exactly 300', `${'A sentence that is padded out to the limit. '.repeat(6).slice(0, 299)}.`],
] as const;

const SENTENCES = [
  [
    'architecture',
    'Architects restore a 1960s market hall in Accra. The concrete shells are a rare survival of tropical modernism. The city and two foundations fund the work, and the market stays open throughout so traders keep working while the roof and drainage are rebuilt over two years, with a public archive of the drawings.',
  ],
  [
    'fashion',
    'A Nairobi fashion week is staged entirely with reclaimed textiles. It names six designers and the cooperatives that supply them! Does the angle hold? The organisers say the event will travel to Lagos and São Paulo next year, with workshops for students and an exhibition of the garments in each city’s design museum.',
  ],
  [
    'film',
    'The collective won the jury prize for a documentary about Kinshasa’s sapeurs (“La Sape”). The film is distributed by a Belgian company, and it opens in cinemas across the continent in November, with screenings followed by conversations with the directors and the people who appear in it, in French and Lingala.',
  ],
  [
    'food',
    'Chefs document a highland cuisine through recipes gathered from grandmothers in three towns, with a book and dinners planned. The project names its contributors. It says where each recipe came from, which gives editors people to approach and a clear visual story, though the dates of the dinners are still to be confirmed by the organisers.',
  ],
] as const;

describe('shortenProse', () => {
  it.each(FITS)('leaves %s text within the limit unchanged', (_domain, text) => {
    expect(shortenProse(text, 300)).toBe(text);
  });

  it.each(SENTENCES)('keeps whole leading sentences of overlong %s text', (_domain, text) => {
    expect(text.length).toBeGreaterThan(300);
    const short = shortenProse(text, 300);
    expect(short.length).toBeLessThanOrEqual(300);
    expect(short).toMatch(/[.!?]["'”’)\]]*$/);
    expect(isPrefix(text, short)).toBe(true);
    // As many sentences as fit: adding the next would pass the limit.
    const rest = text.replace(/\s+/g, ' ').slice(short.length).trim();
    const next = /^.*?[.!?]+["'”’)\]]*(?=\s|$)/.exec(rest)?.[0] ?? rest;
    expect(`${short} ${next}`.length).toBeGreaterThan(300);
  });

  it.each([
    [
      'one long sentence',
      `The biennale ${'brings together artists, writers and curators from across the continent and its diaspora '.repeat(5)}in Lagos.`,
    ],
    ['no punctuation at all', 'photographers from Johannesburg and Maputo '.repeat(12)],
    ['one unbroken token', `https://example.org/${'a'.repeat(400)}`],
  ])('cuts %s at a word boundary and marks the cut', (_case, text) => {
    const short = shortenProse(text, 300);
    expect(short.length).toBeLessThanOrEqual(300);
    expect(short.endsWith('…')).toBe(true);
    expect(isPrefix(text, short)).toBe(true);
    expect(short).not.toMatch(/[\s,;:]…$/);
  });

  it('never returns an empty explanation for non-empty text', () => {
    for (const max of [5, 20, 80])
      expect(shortenProse('Supercalifragilistic expialidocious.', max).length).toBeGreaterThan(1);
  });
});
