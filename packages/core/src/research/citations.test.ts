import { describe, expect, it } from 'vitest';

import {
  checkClaim,
  detailsMissingFromExcerpt,
  excerptLocated,
  type CitableSource,
} from './citations.js';

const sources = new Map<string, CitableSource>([
  [
    'S1',
    {
      label: 'S1',
      id: 'a1',
      text: 'The biennale opens with eleven venues,\n including a “floating” gallery on the lagoon.',
    },
  ],
  [
    'S2',
    { label: 'S2', id: 'a2', text: 'The director said the programme took ten years — not five.' },
  ],
]);

describe('citation checks against stored source text', () => {
  // Real extracted text (Markdown) and quotes from a live development brief, 2026-10-16.
  const page =
    'The exhibition recalls Wahaab’s presentation of *Where Is Chi Chi?* with Oda Art Gallery at Art X Lagos in 2023.\n\n' +
    'This phenomenon can be seen across some of the continent’s major institutions and exhibitions: the scattered tiling of the walls at Nahous Lagos, the wooden-framed surfaces of the [2024 Lagos Biennial](https://lagos-biennial.org/lb-2024/), the varied colours of Art X Lagos’ booths at every edition, the **bold** \\_escaped\\_ text.';

  it('finds an exact quote whatever Markdown formatting the stored page carries', () => {
    expect(
      excerptLocated(
        'The exhibition recalls Wahaab’s presentation of Where Is Chi Chi? with Oda Art Gallery at Art X Lagos in 2023.',
        [page],
      ),
    ).toBe(true);
    expect(
      excerptLocated('the wooden-framed surfaces of the 2024 Lagos Biennial, the varied colours', [
        page,
      ]),
    ).toBe(true);
    expect(excerptLocated('the bold escaped text', [page])).toBe(true);
  });

  it('still refuses a quote that changes the words, even by one', () => {
    // The live model inserted "and": that is not word for word.
    expect(
      excerptLocated(
        'the wooden-framed surfaces of the 2024 Lagos Biennial, and the varied colours of Art X Lagos’ booths at every edition.',
        [page],
      ),
    ).toBe(false);
    // Link targets are not visible text and can't be quoted into a match.
    expect(excerptLocated('lagos-biennial.org/lb-2024', [page])).toBe(false);
  });

  it('locates excerpts despite curly quotes, dashes, line breaks and case', () => {
    expect(
      excerptLocated('including a "Floating" gallery on the lagoon', [sources.get('S1')!.text]),
    ).toBe(true);
    expect(excerptLocated('took ten years - not five', [sources.get('S2')!.text])).toBe(true);
    expect(excerptLocated('“…eleven venues, including…”', [sources.get('S1')!.text])).toBe(true);
    expect(excerptLocated('twelve venues', [sources.get('S1')!.text])).toBe(false);
    // Too short to establish anything.
    expect(excerptLocated('venues', [sources.get('S1')!.text])).toBe(false);
  });

  it('verifies a sourced fact, and flags one whose excerpt is not in the cited source', () => {
    const verified = checkClaim(
      {
        type: 'fact',
        text: 'It has eleven venues.',
        sources: ['[s1]'],
        excerpt: 'opens with eleven venues',
      },
      sources,
    );
    expect(verified).toMatchObject({
      claim: { citationStatus: 'verified', sourceLabels: ['S1'], sourceArticleIds: ['a1'] },
    });
    const unlocated = checkClaim(
      {
        type: 'attributed',
        text: 'The director says it took ten years.',
        sources: ['S1'],
        excerpt: 'took ten years',
      },
      sources,
    );
    expect(unlocated).toMatchObject({ claim: { citationStatus: 'excerpt_not_located' } });
  });

  it('drops claims citing an unknown source, and facts citing none', () => {
    expect(
      checkClaim(
        {
          type: 'fact',
          text: 'Made up.',
          sources: ['S1', 'S9'],
          excerpt: 'opens with eleven venues',
        },
        sources,
      ),
    ).toMatchObject({ dropped: { reason: 'unknown_source' } });
    expect(
      checkClaim({ type: 'fact', text: 'Unsourced.', sources: [], excerpt: '' }, sources),
    ).toMatchObject({
      dropped: { reason: 'no_source' },
    });
    expect(
      checkClaim(
        { type: 'analysis', text: 'A shift in who counts as an artist.', sources: [], excerpt: '' },
        sources,
      ),
    ).toMatchObject({ claim: { citationStatus: 'uncited' } });
  });

  it('flags a date or figure the quoted passage does not contain, and nothing more', () => {
    const career = new Map<string, CitableSource>([
      [
        'S2',
        {
          label: 'S2',
          id: 'a2',
          text: 'A curator at the Metropolitan since 1996, she has organised exhibitions on 1,200 works.',
        },
      ],
    ]);
    const claim = (text: string, excerpt: string) =>
      checkClaim({ type: 'fact', text, sources: ['S2'], excerpt }, career);
    // A guessed year the quote can't back is caught.
    expect(
      claim(
        'She was appointed Pulitzer Curator in 2003.',
        'A curator at the Metropolitan since 1996',
      ),
    ).toMatchObject({ claim: { citationStatus: 'detail_not_in_excerpt' } });
    // Figures match whatever the thousands separator; source labels are not details.
    expect(
      claim('She has organised shows on 1200 works [S2].', 'exhibitions on 1,200 works'),
    ).toMatchObject({ claim: { citationStatus: 'verified' } });
    // The limit of a deterministic safeguard: the year is in the quote, so a substituted fact
    // (a career start presented as an appointment) still passes. "verified" only means the
    // passage was found; whether it supports the claim stays the editor's judgement.
    expect(
      claim(
        'She was appointed Pulitzer Curator in 1996.',
        'A curator at the Metropolitan since 1996',
      ),
    ).toMatchObject({ claim: { citationStatus: 'verified' } });
    // Interpretation and open questions are not checked for details.
    expect(
      checkClaim(
        { type: 'open_question', text: 'Was it 2003?', sources: ['S2'], excerpt: 'since 1996' },
        career,
      ),
    ).not.toMatchObject({ claim: { citationStatus: 'detail_not_in_excerpt' } });
    expect(
      detailsMissingFromExcerpt('In the 20th century, over 40% of 3.5 million', '20th; 40%'),
    ).toEqual(['3.5']);
  });
});
