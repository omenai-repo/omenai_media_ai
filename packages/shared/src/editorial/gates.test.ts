/**
 * Gate scenarios drawn from the playbook and from real discovery results seen while testing the
 * Tavily integration (a listicle, a whisky-brand promotion, a gallery sales listing).
 */
import { describe, expect, it } from 'vitest';

import { applyGates, editorialTestProblem, type GateInput } from './gates.js';

const NOW = new Date('2026-10-15T05:00:00Z');
const STRONG_ANSWER =
  'This matters to Omenai’s audience because the joint exhibition places two generations of Lagos painters in dialogue about the gele as both adornment and authorship, a question about how Nigerian dress codes enter contemporary art.';

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    now: NOW,
    freshnessDays: 14,
    sources: [
      {
        url: 'https://businessday.ng/arts/alexis-galleries-gele',
        publisher: 'BusinessDay',
        publishedAt: new Date('2026-10-12T03:00:00Z'),
      },
    ],
    novelty: 'new',
    repeat: 'new',
    previouslySkipped: false,
    editorialTest: { canAnswer: true, answer: STRONG_ANSWER },
    exclusions: [],
    criticalIssues: [],
    ...overrides,
  };
}

const failing = (result: ReturnType<typeof applyGates>) =>
  result.results.filter((r) => r.outcome !== 'pass').map((r) => `${r.gate}:${r.outcome}`);

describe('applyGates', () => {
  it('passes a recent, sourced, specific exhibition story', () => {
    const result = applyGates(input());
    expect(result.outcome).toBe('pass');
    expect(failing(result)).toEqual([]);
  });

  it('rejects a thin listicle ("10 art exhibitions this October")', () => {
    const result = applyGates(
      input({
        exclusions: [
          {
            id: 'thin_listicle_seo',
            evidence: 'A list of ten openings with one line each.',
            exception: null,
          },
        ],
      }),
    );
    expect(result.outcome).toBe('reject');
    expect(failing(result)).toEqual(['exclusion:thin_listicle_seo:reject']);
  });

  it('rejects brand-led luxury promotion presented as a cultural celebration', () => {
    const result = applyGates(
      input({
        exclusions: [
          {
            id: 'generic_luxury_promotion',
            evidence: 'Sponsored whisky-brand event copy; no independent reporting.',
            exception: null,
          },
          {
            id: 'press_release_repackaged',
            evidence: 'Mirrors the brand press release.',
            exception: null,
          },
        ],
      }),
    );
    expect(result.outcome).toBe('reject');
  });

  it('rejects a sales listing that has no editorial angle', () => {
    const result = applyGates(
      input({
        exclusions: [
          {
            id: 'routine_announcement',
            evidence: 'A single artwork offered for sale.',
            exception: null,
          },
        ],
        editorialTest: { canAnswer: false, answer: '' },
      }),
    );
    expect(result.outcome).toBe('reject');
    expect(failing(result)).toContain('editorial_test:reject');
  });

  it('accepts a normally excluded subject when a specific exception is given', () => {
    const result = applyGates(
      input({
        exclusions: [
          {
            id: 'celebrity_gossip_or_virality',
            evidence: 'Coverage is driven by a musician’s fame.',
            exception:
              'The musician is funding a sound archive of 1970s Lagos highlife recordings, raising questions about who owns and preserves the scene’s history.',
          },
        ],
      }),
    );
    expect(result.outcome).toBe('pass');
    expect(
      result.results.find((r) => r.gate === 'exclusion:celebrity_gossip_or_virality')?.reason,
    ).toMatch(/^Exception:/);
  });

  it('does not accept a vague exception', () => {
    const result = applyGates(
      input({
        exclusions: [
          {
            id: 'fame_only',
            evidence: 'Famous designer.',
            exception: 'It is culturally relevant.',
          },
        ],
      }),
    );
    expect(result.outcome).toBe('reject');
  });

  it('rejects the playbook’s weak rationale example', () => {
    expect(
      editorialTestProblem({
        canAnswer: true,
        answer: 'A new museum has opened in Lagos. This is an important cultural story.',
      }),
    ).not.toBeNull();
  });

  it('holds on a critical rights issue and rejects on a critical accuracy failure, regardless of everything else', () => {
    const hold = applyGates(
      input({
        criticalIssues: [
          { kind: 'rights', severity: 'hold', evidence: 'Image rights unconfirmed.' },
        ],
      }),
    );
    expect(hold.outcome).toBe('hold');
    const reject = applyGates(
      input({
        criticalIssues: [
          { kind: 'rights', severity: 'hold', evidence: 'Image rights unconfirmed.' },
          {
            kind: 'accuracy',
            severity: 'reject',
            evidence: 'Sources contradict the central claim.',
          },
        ],
      }),
    );
    expect(reject.outcome).toBe('reject');
  });

  it('rejects stale news but allows evergreen and retrospective stories', () => {
    const old = [
      {
        url: 'https://example.org/a',
        publisher: 'Example',
        publishedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ];
    expect(applyGates(input({ sources: old })).outcome).toBe('reject');
    expect(applyGates(input({ sources: old, novelty: 'evergreen' })).outcome).toBe('pass');
    expect(applyGates(input({ sources: old, novelty: 'retrospective' })).outcome).toBe('pass');
  });

  it('holds when no publication date is known or a date is in the future', () => {
    const undated = [{ url: 'https://example.org/a', publisher: 'Example', publishedAt: null }];
    expect(applyGates(input({ sources: undated })).outcome).toBe('hold');
    const future = [
      {
        url: 'https://example.org/a',
        publisher: 'Example',
        publishedAt: new Date('2026-12-01T00:00:00Z'),
      },
    ];
    expect(applyGates(input({ sources: future })).outcome).toBe('hold');
  });

  it('rejects candidates without a usable source', () => {
    expect(applyGates(input({ sources: [] })).outcome).toBe('reject');
    const bad = [{ url: 'not a url', publisher: 'X', publishedAt: NOW }];
    expect(applyGates(input({ sources: bad })).outcome).toBe('reject');
  });

  describe('repeats and skips', () => {
    it('suppresses the same development with no new information', () => {
      expect(applyGates(input({ repeat: 'same_development_no_new_info' })).outcome).toBe('reject');
      expect(applyGates(input({ repeat: 'same_development_new_info' })).outcome).toBe('pass');
    });

    it('keeps a skipped development suppressed but lets a new development through', () => {
      // Skipping an auction announcement must not block the later auction result.
      expect(
        applyGates(input({ repeat: 'same_development_new_info', previouslySkipped: true })).outcome,
      ).toBe('reject');
      expect(
        applyGates(input({ repeat: 'new_development', previouslySkipped: true })).outcome,
      ).toBe('pass');
    });
  });
});
