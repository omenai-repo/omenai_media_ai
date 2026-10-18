import { describe, expect, it } from 'vitest';

import { selectRepresentativeImage } from './images.js';
import { plainCheck, reviewReason } from './review-reason.js';

describe('reviewReason', () => {
  it('explains each outcome in plain language from stored facts', () => {
    expect(
      reviewReason({ outcome: 'qualified', failingChecks: [], score: 70, recommended: false }),
    ).toBe('Met our standards (scored 70), but stronger stories filled the edition.');
    expect(reviewReason({ outcome: 'qualified', failingChecks: [], score: 86 })).toBe(
      'Met our standards (scored 86).',
    );
    expect(reviewReason({ outcome: 'below_threshold', failingChecks: [], score: 58 })).toBe(
      'Scored 58; our bar is 65.',
    );
    expect(
      reviewReason({ outcome: 'gate_hold', failingChecks: ['critical:rights'], score: 74 }),
    ).toBe('Needs checking first: image or content rights need checking.');
    expect(
      reviewReason({
        outcome: 'gate_reject',
        failingChecks: [
          'exclusion:thin_listicle_seo',
          'editorial_test',
          'exclusion:thin_listicle_seo',
        ],
        score: 16,
      }),
    ).toBe(
      'Didn’t pass our editorial checks: a thin list rather than a story and no clear reason it matters to our readers.',
    );
    expect(reviewReason({ outcome: 'suppressed_repeat', failingChecks: [], score: null })).toMatch(
      /nothing new/,
    );
    expect(reviewReason({ outcome: 'deferred_late', failingChecks: [], score: null })).toMatch(
      /next edition/,
    );
    expect(reviewReason({ outcome: null, failingChecks: [], score: null })).toBe(
      'Not assessed yet.',
    );
  });

  it('never exposes raw check identifiers', () => {
    for (const gate of ['exclusion:unknown_thing', 'critical:other', 'mystery']) {
      expect(plainCheck(gate)).not.toContain(':');
      expect(plainCheck(gate)).not.toContain('_');
    }
  });
});

describe('selectRepresentativeImage', () => {
  const image = (name: string) => ({
    url: `https://img.example/${name}.jpg`,
    alt: null,
    pageUrl: `https://a.example/${name}`,
    publisher: name,
  });
  const base = {
    sourceQuality: 'unknown',
    extractionStatus: 'extracted',
    publishedAt: '2026-10-10T00:00:00Z',
  };

  it('returns null when no article has an image', () => {
    expect(
      selectRepresentativeImage([{ ...base, image: null, canonicalUrl: 'https://a.example/1' }]),
    ).toBeNull();
  });

  it('prefers more reliable sources, then full text, then the earliest report', () => {
    const picked = selectRepresentativeImage([
      {
        ...base,
        image: image('social'),
        sourceQuality: 'unverified_social',
        canonicalUrl: 'https://a.example/1',
      },
      {
        ...base,
        image: image('reputable'),
        sourceQuality: 'reputable_secondary',
        canonicalUrl: 'https://a.example/2',
      },
      {
        ...base,
        image: image('primary'),
        sourceQuality: 'primary',
        extractionStatus: 'failed',
        canonicalUrl: 'https://a.example/3',
      },
    ]);
    expect(picked?.publisher).toBe('primary');

    const tie = selectRepresentativeImage([
      {
        ...base,
        image: image('later'),
        publishedAt: '2026-10-12T00:00:00Z',
        canonicalUrl: 'https://a.example/b',
      },
      {
        ...base,
        image: image('earlier'),
        publishedAt: '2026-10-11T00:00:00Z',
        canonicalUrl: 'https://a.example/a',
      },
    ]);
    expect(tie?.publisher).toBe('earlier');
  });

  it('is deterministic regardless of input order', () => {
    const articles = [
      { ...base, image: image('x'), canonicalUrl: 'https://a.example/x' },
      { ...base, image: image('y'), canonicalUrl: 'https://a.example/y' },
    ];
    expect(selectRepresentativeImage(articles)).toEqual(
      selectRepresentativeImage(articles.toReversed()),
    );
  });
});
