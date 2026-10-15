import { describe, expect, it } from 'vitest';

import {
  canonicalizeUrl,
  contentHash,
  excerpt,
  normalizeTitle,
  parseDate,
  publisherName,
  textSimilarity,
  titleSimilarity,
} from './normalize.js';

describe('canonicalizeUrl', () => {
  it('maps the same article reached different ways to one canonical URL', () => {
    const variants = [
      'https://www.BusinessDay.ng/arts/gele-exhibition/?utm_source=x&utm_medium=social',
      'http://businessday.ng/arts/gele-exhibition',
      'https://businessday.ng/arts/gele-exhibition/#comments',
      'https://businessday.ng/arts/gele-exhibition?fbclid=abc',
    ];
    const canonical = variants.map(canonicalizeUrl);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('https://businessday.ng/arts/gele-exhibition');
  });

  it('keeps meaningful query parameters, sorted', () => {
    expect(canonicalizeUrl('https://example.org/article?id=7&page=2&utm_campaign=z')).toBe(
      'https://example.org/article?id=7&page=2',
    );
    expect(canonicalizeUrl('https://example.org/a?page=2&id=7')).toBe(
      'https://example.org/a?id=7&page=2',
    );
  });

  it('rejects non-web URLs', () => {
    expect(canonicalizeUrl('mailto:press@example.org')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });
});

describe('dates and publishers', () => {
  it('parses Tavily’s RFC 1123 dates and ISO dates', () => {
    expect(parseDate('Mon, 12 Oct 2026 03:00:00 GMT')?.toISOString()).toBe(
      '2026-10-12T03:00:00.000Z',
    );
    expect(parseDate('2026-10-12')?.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(parseDate('yesterday')).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });

  it('names known publishers and falls back to the host', () => {
    expect(publisherName('guardian.ng')).toBe('The Guardian Nigeria');
    expect(publisherName('example.org')).toBe('example.org');
  });
});

describe('change detection', () => {
  // Varied text of realistic length (a real article is ~15k characters).
  const article = Array.from(
    { length: 60 },
    (_, i) =>
      `Paragraph ${i}: Alexis Galleries in Lagos presents work ${i * 7} from the Gele series, ` +
      `painted in ${1990 + (i % 30)} and shown alongside archive photographs number ${i * 13}.`,
  ).join(' ');

  it('hashes ignoring case and whitespace', () => {
    expect(contentHash(article)).toBe(contentHash(article.toUpperCase().replace(/ /g, '  ')));
    expect(contentHash(article)).not.toBe(contentHash(`${article} Updated: the show is extended.`));
  });

  it('scores a small edit as near-identical and a rewrite as different', () => {
    expect(textSimilarity(article, `${article} Related: ten openings this week.`)).toBeGreaterThan(
      0.9,
    );
    expect(
      textSimilarity(article, 'An entirely different report about a film festival in Durban.'),
    ).toBeLessThan(0.1);
  });
});

describe('titles', () => {
  it('drops publisher suffixes and punctuation', () => {
    expect(normalizeTitle('Alexis Galleries pairs two masters in ‘Gele’ – Business Day')).toBe(
      'alexis galleries pairs two masters in gele',
    );
  });

  it('recognises the same headline syndicated with small differences', () => {
    expect(
      titleSimilarity(
        'Zeitz MOCAA opens retrospective of Ghanaian sculptor El Anatsui',
        'Zeitz MOCAA opens El Anatsui retrospective | Arts',
      ),
    ).toBeGreaterThan(0.6);
    expect(
      titleSimilarity('Lagos gallery opens show', 'Venice Biennale names curator'),
    ).toBeLessThan(0.2);
  });
});

describe('excerpt', () => {
  it('marks text we cut so the model does not treat it as a defective source', () => {
    expect(excerpt('short text', 100)).toBe('short text');
    expect(excerpt('a'.repeat(50) + ' by Mi', 50)).toBe(`${'a'.repeat(50)} […excerpt truncated]`);
  });
});
