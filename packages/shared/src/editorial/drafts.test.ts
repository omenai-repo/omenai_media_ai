import { describe, expect, it } from 'vitest';

import {
  countConservatively,
  countWords,
  countXCharacters,
  DRAFT_FORMAT_IDS,
  DRAFT_FORMATS,
  isDraftFormat,
  measureDraft,
} from './drafts.js';

const exact = (n: number) => ({ min: n, max: n });

describe('draft formats and channel limits', () => {
  it('defines the five formats with the agreed limits', () => {
    expect(DRAFT_FORMAT_IDS).toHaveLength(5);
    expect(DRAFT_FORMATS.x_post.limit).toEqual({ unit: 'characters', max: 280, counting: 'x' });
    expect(DRAFT_FORMATS.instagram_caption.limit).toMatchObject({ max: 2_200 });
    expect(DRAFT_FORMATS.linkedin_post.limit).toMatchObject({ max: 3_000 });
    expect(DRAFT_FORMATS.newsletter_item.limit).toEqual({ unit: 'words', min: 150, max: 300 });
    expect(DRAFT_FORMATS.editorial_article.limit).toEqual({ unit: 'words', min: 800, max: 1_500 });
    expect(isDraftFormat('x_post')).toBe(true);
    expect(isDraftFormat('tiktok_script')).toBe(false);
    expect(countWords('  Kora,  rewired.\nA new\tsound ')).toBe(5);
    expect(countWords('   ')).toBe(0);
  });
});

describe('counting an X post the way X does', () => {
  it('matches the examples in X’s documentation', () => {
    expect(countXCharacters('Hello, world! 👋')).toEqual(exact(16));
    // Composed and decomposed "café" both normalise to four characters.
    expect(countXCharacters('café')).toEqual(exact(4));
    expect(countXCharacters('café')).toEqual(exact(4));
  });

  it('weighs emoji, CJK and characters outside the light ranges as 2', () => {
    expect(countXCharacters('👍🏽')).toEqual(exact(2));
    expect(countXCharacters('👨‍👩‍👧')).toEqual(exact(2));
    expect(countXCharacters('🇳🇬')).toEqual(exact(2));
    expect(countXCharacters('日本語')).toEqual(exact(6));
    // Curly quotes and dashes are light; the ellipsis character is not.
    expect(countXCharacters('“Kora” — rewired')).toEqual(exact(16));
    expect(countXCharacters('…')).toEqual(exact(2));
    expect(countXCharacters('Valparaíso')).toEqual(exact(10));
  });

  it('counts a link X will shorten as 23, and gives a range when X might not treat it as a link', () => {
    expect(
      countXCharacters('Read https://www.omenai.com/stories/a-very-long-path-that-goes-on-and-on'),
    ).toEqual(exact(5 + 23));
    // Trailing punctuation stays outside the link.
    expect(countXCharacters('See https://omenai.com/x.')).toEqual(exact(4 + 23 + 1));
    // A bare domain: 10 if X leaves it as text, 23 if it links it.
    expect(countXCharacters('omenai.com')).toEqual({ min: 10, max: 23 });
  });

  it('never calls a post within the limit unless the highest reading fits', () => {
    expect(measureDraft('x_post', 'a'.repeat(280))).toMatchObject({
      count: 280,
      overLimit: false,
      uncertain: false,
      summary: '280 of 280 characters',
    });
    expect(measureDraft('x_post', 'a'.repeat(281)).overLimit).toBe(true);
    // Six emoji are 12 on X, not 6: counted by code point, this post looked like 277.
    const emoji = measureDraft('x_post', `${'a'.repeat(270)} 👋👋👋👋👋👋`);
    expect(emoji).toMatchObject({ count: 283, overLimit: true, uncertain: false });
    const maybe = measureDraft('x_post', `${'a'.repeat(260)} omenai.com`);
    expect(maybe).toMatchObject({
      lowest: 271,
      count: 284,
      overLimit: true,
      uncertain: true,
      summary: 'Between 271 and 284 of 280 characters',
    });
  });
});

describe('Instagram and LinkedIn (no published counting rules)', () => {
  it('counts conservatively: every emoji as at least 2, never fewer than the characters', () => {
    expect(countConservatively('Kora 🎶')).toBe(7);
    expect(countConservatively('café')).toBe(4);
    expect(measureDraft('instagram_caption', '🎶'.repeat(1_100)).overLimit).toBe(false);
    expect(measureDraft('instagram_caption', '🎶'.repeat(1_101)).overLimit).toBe(true);
    expect(measureDraft('linkedin_post', 'a'.repeat(3_000)).overLimit).toBe(false);
    expect(measureDraft('linkedin_post', 'a'.repeat(3_001)).overLimit).toBe(true);
  });

  it('treats word ranges as guidance, never as a hard limit', () => {
    const short = measureDraft('newsletter_item', 'word '.repeat(120));
    expect(short).toMatchObject({ count: 120, overLimit: false, outsideGuidance: true });
    expect(short.summary).toBe('120 words · aim for 150–300');
    expect(measureDraft('newsletter_item', 'word '.repeat(200)).outsideGuidance).toBe(false);
    expect(measureDraft('editorial_article', 'word '.repeat(1_600)).outsideGuidance).toBe(true);
  });
});
