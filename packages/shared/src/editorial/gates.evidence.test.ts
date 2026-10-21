/**
 * Evidence, source and origin gates (ADR-041), tested across Omenai's editorial domains with
 * cases that must pass beside cases that must fail. Topic-agnostic: every rule is decided from
 * claim checks, source ratings and hosts, never from what a story is about.
 *
 * These checks only lower an outcome. A pass means no known defect was found, never that a claim
 * is true; source ratings are the model's assessment, not verification.
 */
import { describe, expect, it } from 'vitest';

import { applyGates, type GateInput, type GateSource, type KeyClaimCheck } from './gates.js';

const NOW = new Date('2026-10-15T05:00:00Z');

/** One story per domain: its source, a specific answer, an angle and an exclusion it might trip. */
const DOMAINS = [
  ['art', 'gallery.example', 'the exhibition pairs two painters on the gele as authorship'],
  ['architecture', 'buildings.example', 'the library reuses a colonial customs house in Dakar'],
  ['design', 'design.example', 'the studio revives Kente loom patterns in furniture'],
  ['fashion', 'fashion.example', 'the label works only with Abidjan ateliers it co-owns'],
  ['music', 'music.example', 'the album records Ethio-jazz players with Addis youth choirs'],
  ['film', 'cinema.example', 'the documentary restores footage of 1970s Kinshasa nightlife'],
  ['literature', 'books.example', 'the press translates Swahili poetry kept in a family archive'],
  ['performance', 'stage.example', 'the dance company stages a Yoruba festival as theatre'],
  ['heritage', 'heritage.example', 'the museum returns bronzes and shares their provenance file'],
  ['market', 'market.example', 'the auction sets a record for a Senegalese modernist'],
  ['photography', 'photo.example', 'the archive digitises studio portraits from Bamako'],
  ['food', 'food.example', 'the restaurant documents Lagos street recipes with vendors'],
] as const;

function source(host: string, quality: GateSource['quality']): GateSource {
  return {
    url: `https://${host}/story`,
    publisher: host,
    publishedAt: new Date('2026-10-13T08:00:00Z'),
    quality,
    host,
  };
}

const fact = (sources: number[], passed = true, problem: string | null = null): KeyClaimCheck => ({
  type: 'fact',
  passed,
  problem,
  sources,
});

function story(
  domain: readonly [string, string, string],
  overrides: Partial<GateInput> = {},
): GateInput {
  const [, host, why] = domain;
  return {
    now: NOW,
    freshnessDays: 14,
    sources: [source(host, 'reputable_secondary')],
    novelty: 'new',
    repeat: 'new',
    previouslySkipped: false,
    editorialTest: {
      canAnswer: true,
      answer: `This matters to Omenai’s audience because ${why}, which raises a specific question about who shapes the work and on whose terms.`,
    },
    exclusions: [],
    criticalIssues: [],
    evidence: {
      keyClaims: [fact([0])],
      editorialSupport: [1],
      pressRelease: { leadOnly: false, reason: 'Reported independently.' },
    },
    card: { angle: `What does it change that ${why}?`, whyItMatters: `Because ${why}.` },
    triageSignals: [],
    dismissedSignals: [],
    ...overrides,
  };
}

const gate = (input: GateInput, id: string) => applyGates(input).results.find((r) => r.gate === id);

describe.each(DOMAINS)('%s', (...domain) => {
  const [, host] = domain;

  it('passes with an established source and a key claim that passed the checks', () => {
    const result = applyGates(story(domain));
    expect(result.outcome).toBe('pass');
    // A pass is never presented as proof.
    expect(result.results.find((r) => r.gate === 'evidence')?.reason).toMatch(
      /not proof of support/,
    );
    expect(result.results.find((r) => r.gate === 'sources')?.reason).toMatch(/not verification/);
  });

  it('rejects an answer that names no key claim, however long it is', () => {
    const padded = story(domain, {
      editorialTest: {
        canAnswer: true,
        answer:
          'This is an important cultural story for the city and its creative community, and it matters a great deal to readers everywhere.',
      },
      evidence: { ...story(domain).evidence, editorialSupport: [] },
    });
    expect(gate(padded, 'editorial_test')?.outcome).toBe('reject');
    // Naming a claim that doesn't exist is the same as naming none.
    const phantom = story(domain, {
      evidence: { ...story(domain).evidence, editorialSupport: [3] },
    });
    expect(gate(phantom, 'editorial_test')?.outcome).toBe('reject');
  });

  it('holds when a key claim failed the checks, or there is no key claim', () => {
    const notFound = story(domain, {
      evidence: {
        ...story(domain).evidence,
        keyClaims: [fact([0], false, 'quote not found in A1')],
      },
    });
    expect(applyGates(notFound).outcome).toBe('hold');
    expect(gate(notFound, 'evidence')?.reason).toMatch(/quote not found in A1/);
    const none = story(domain, { evidence: { ...story(domain).evidence, keyClaims: [] } });
    expect(gate(none, 'evidence')?.outcome).toBe('hold');
  });

  it('holds when no source is rated primary, reputable or specialist (missing rating = unknown)', () => {
    for (const quality of ['unknown', 'unverified_social', null] as const) {
      const weak = story(domain, { sources: [source(host, quality)] });
      expect(gate(weak, 'sources')?.outcome).toBe('hold');
      expect(applyGates(weak).outcome).toBe('hold');
    }
  });

  it('holds a key claim resting only on a weak source, even beside an established one', () => {
    const mixed = story(domain, {
      sources: [source(host, 'reputable_secondary'), source(`social.${host}`, 'unverified_social')],
      evidence: { ...story(domain).evidence, keyClaims: [fact([0]), fact([1])] },
    });
    expect(gate(mixed, 'evidence')?.outcome).toBe('hold');
  });

  it('keeps an exclusion unless its exception is specific AND rests on a claim that passed', () => {
    const exception =
      'A specific, sourced angle: who owns and preserves this history, and on whose terms.';
    const flagged = (supportedBy: number[], keyClaims = [fact([0])], text = exception) =>
      story(domain, {
        exclusions: [
          {
            id: 'press_release_repackaged',
            evidence: 'Mirrors the release.',
            exception: text,
            supportedBy,
          },
        ],
        evidence: { ...story(domain).evidence, keyClaims },
      });
    expect(applyGates(flagged([1])).outcome).toBe('pass');
    // Long but tied to nothing.
    expect(gate(flagged([]), 'exclusion:press_release_repackaged')?.outcome).toBe('reject');
    // Tied only to a claim that failed the checks.
    expect(
      gate(
        flagged([1], [fact([0], false, 'quote not found')]),
        'exclusion:press_release_repackaged',
      )?.outcome,
    ).toBe('reject');
    // Tied, but too short to be specific.
    expect(
      gate(flagged([1], [fact([0])], 'It matters.'), 'exclusion:press_release_repackaged')?.outcome,
    ).toBe('reject');
  });

  it('rejects a story with no proposed angle or why-it-matters', () => {
    expect(
      gate(story(domain, { card: { angle: '  ', whyItMatters: 'x' } }), 'card_complete')?.outcome,
    ).toBe('reject');
    expect(
      gate(story(domain, { card: { angle: 'x', whyItMatters: '' } }), 'card_complete')?.outcome,
    ).toBe('reject');
  });

  describe('a single primary source, judged on its merits', () => {
    const primaryOnly = (evidence: Partial<GateInput['evidence']> = {}, extra: GateSource[] = []) =>
      story(domain, {
        sources: [source(host, 'primary'), ...extra],
        evidence: { ...story(domain).evidence, ...evidence },
      });

    it('passes when the originator’s facts are located and the story goes beyond the announcement', () => {
      const result = applyGates(primaryOnly());
      expect(result.outcome).toBe('pass');
      expect(result.results.find((r) => r.gate === 'single_origin')?.reason).toMatch(
        /originator's own account/,
      );
    });

    it('holds as a lead when it is only the announcement', () => {
      const lead = primaryOnly({ pressRelease: { leadOnly: true, reason: 'Announcement only.' } });
      expect(gate(lead, 'single_origin')?.outcome).toBe('hold');
    });

    it('holds when why it matters rests only on the originator’s account of itself', () => {
      const selfDescribed = primaryOnly({
        keyClaims: [{ ...fact([0]), type: 'attributed' }],
      });
      expect(gate(selfDescribed, 'single_origin')?.outcome).toBe('hold');
    });

    it('treats a "secondary" source on the originator’s own host as not independent', () => {
      const sameHost = primaryOnly(
        { pressRelease: { leadOnly: true, reason: 'Announcement only.' } },
        [source(host, 'reputable_secondary')],
      );
      expect(gate(sameHost, 'single_origin')?.outcome).toBe('hold');
      const otherHost = primaryOnly(
        { pressRelease: { leadOnly: true, reason: 'Announcement only.' } },
        [source(`independent.${host}`, 'specialist')],
      );
      expect(gate(otherHost, 'single_origin')?.outcome).toBe('pass');
    });
  });

  it('requires every triage signal to be confirmed or dismissed', () => {
    const signals = { triageSignals: ['routine_announcement' as const] };
    expect(gate(story(domain, signals), 'signal:routine_announcement')?.outcome).toBe('hold');
    const dismissed = story(domain, {
      ...signals,
      dismissedSignals: [
        { id: 'routine_announcement', reason: 'A first-time event, not routine.' },
      ],
    });
    expect(gate(dismissed, 'signal:routine_announcement')?.outcome).toBe('pass');
    // Confirmed as an exclusion: decided by the exclusion gate instead.
    const confirmed = story(domain, {
      ...signals,
      exclusions: [
        {
          id: 'routine_announcement',
          evidence: 'A standard opening.',
          exception: null,
          supportedBy: [],
        },
      ],
    });
    expect(gate(confirmed, 'signal:routine_announcement')).toBeUndefined();
    expect(gate(confirmed, 'exclusion:routine_announcement')?.outcome).toBe('reject');
  });
});
