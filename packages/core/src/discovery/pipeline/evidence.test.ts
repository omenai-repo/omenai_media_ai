/**
 * Evidence gates end to end (ADR-041): key claims are checked by the shared statement checks
 * against the text the evaluator was shown, and every check can only lower a story. Fixtures
 * only (fake search, scripted model, in-memory MongoDB); nothing here shows real model behaviour.
 */
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../../db/models.js';
import type { SourceArticleDoc } from '../../db/models/source-article.js';
import type { EvaluationOutput } from '../schemas.js';
import type { SearchClient, SearchHit } from '../../search/types.js';
import { fixtureEvaluation, fixtureKeyClaims, scores } from '../../testing/discovery-fixtures.js';
import { createScriptedLlm, promptArticles } from '../../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../../testing/index.js';
import { readDiscoveryConfig } from '../config.js';
import { checkKeyClaims, evaluationPrompt } from './evaluate.js';
import { runDiscoveryInline } from './run-inline.js';

/** One source text per domain, with a claim that its quote backs and variants that must fail. */
const DOMAINS = [
  ['art', 'The gallery opened a joint exhibition of two Lagos painters on 12 October 2026.'],
  ['architecture', 'The library occupies a customs house built in 1898 on the Dakar waterfront.'],
  ['design', 'The studio produced 40 chairs using Kente loom patterns from Bonwire.'],
  [
    'fashion',
    'The label works with 6 ateliers in Abidjan that it has co-owned with the tailors since 2019.',
  ],
  ['music', 'The album was recorded in Addis Ababa with 24 members of a youth choir.'],
  ['film', 'The documentary restores 1974 footage of Kinshasa nightclubs from a family archive.'],
  ['literature', 'The press will translate 30 Swahili poems kept by the Mazrui family in Mombasa.'],
  ['performance', 'The company stages the Osun festival as a 90-minute theatre work in Osogbo.'],
  ['heritage', 'The museum returned 21 bronzes to Benin City and published their provenance file.'],
  ['market', 'The auction house sold a painting by a Senegalese modernist for 1.2 million euros.'],
  ['photography', 'The archive has digitised 3,000 studio portraits made in Bamako in the 1960s.'],
  ['food', 'The restaurant records 50 Lagos street recipes with the vendors who cook them.'],
] as const;

const article = (id = new Types.ObjectId()) => ({ _id: id }) as unknown as SourceArticleDoc;
const claim = (statement: string, quote: string, sources = ['A1']) => ({
  statement,
  type: 'fact' as const,
  sources,
  quote,
});

describe.each(DOMAINS)('key-claim checks: %s', (_domain, text) => {
  const articles = [article(), article()];
  const texts = [`Report. ${text} More context follows.`, 'An unrelated second source.'];

  it('finds no defect when the claim quotes its source word for word', () => {
    const { stored, gate } = checkKeyClaims([claim(text, text)], articles, texts);
    expect(stored[0]?.status).toBe('no_defect_found');
    expect(gate[0]).toMatchObject({ passed: true, sources: [0] });
  });

  it('lowers an invented quote, a quote missing a detail, a mis-cited source and an unknown label', () => {
    const invented = claim(text, 'Words that appear nowhere in the source at all, invented.');
    // Change every number the claim gives, so the quote no longer carries it.
    const altered = text.replace(/\d[\d,.]*/g, (n) => `${n}9`);
    const missingDetail = claim(altered, text);
    const wrongSource = claim(text, text, ['A2']);
    const unknown = claim(text, text, ['A7']);
    const { stored, gate } = checkKeyClaims(
      [invented, missingDetail, wrongSource, unknown],
      articles,
      texts,
    );
    expect(stored.map((c) => c.status)).toEqual([
      'quote_not_found',
      'detail_not_in_quote',
      'quote_not_found',
      'unknown_source',
    ]);
    expect(gate.every((c) => !c.passed && c.problem)).toBe(true);
  });
});

it('never stores "verified": a pass is recorded as no defect found', () => {
  const text = DOMAINS[0][1];
  const { stored } = checkKeyClaims([claim(text, text)], [article()], [text]);
  expect(JSON.stringify(stored)).not.toMatch(/verified/);
});

// ── Through the pipeline ────────────────────────────────────────────────────────────────────

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

function hit(slug: string, title: string, host = 'news.example'): SearchHit & { content: string } {
  return {
    url: `https://${host}/${slug}`,
    title,
    snippet: title,
    publishedDate: 'Wed, 14 Oct 2026 08:00:00 GMT',
    score: 0.9,
    content: `${title}. The organisers confirmed the programme for the coming weeks in a statement.`,
  };
}

function search(hits: Array<SearchHit & { content: string }>): SearchClient {
  const pages = new Map(hits.map((h) => [h.url, h.content]));
  return {
    search: () => Promise.resolve(hits.map(({ content: _c, ...h }) => h)),
    extract: (urls) =>
      Promise.resolve({
        pages: urls.map((url) => ({ url, title: null, content: pages.get(url) ?? '', images: [] })),
        failed: [],
      }),
  };
}

/** A strong assessment (all 4s = 80) whose evidence fields each case varies. */
function llmWith(
  vary: (headline: string, prompt: string) => Partial<EvaluationOutput>,
  signals: (headline: string) => string[] = () => [],
) {
  return createScriptedLlm({
    triage: (prompt) => ({
      articles: promptArticles(prompt).map((a) => ({
        ref: a.ref,
        inScope: true,
        reason: 'Cultural development.',
        eventSummary: a.headline,
        eventDate: null,
        entities: [],
        places: [],
        exclusionSignals: signals(a.headline),
      })),
    }),
    cluster: (prompt) => ({
      groups: promptArticles(prompt).map((a) => ({
        items: [a.ref],
        relation: 'new',
        relatedStory: null,
        signature: a.headline,
      })),
    }),
    evaluate: (prompt) => {
      const headline = promptArticles(prompt)[0]?.headline ?? '';
      return fixtureEvaluation(scores(4), {
        headline,
        keyClaims: fixtureKeyClaims(prompt),
        sourceQuality: [{ ref: 'A1', quality: 'reputable_secondary' }],
        ...vary(headline, prompt),
      });
    },
  });
}

async function outcomes(
  hits: Array<SearchHit & { content: string }>,
  llm: ReturnType<typeof llmWith>['llm'],
) {
  await runDiscoveryInline({
    runKey: 'daily-discovery:2026-10-15',
    trigger: 'schedule',
    owner: 'w',
    deps: {
      llm,
      search: search(hits),
      config: { ...readDiscoveryConfig({}), maxQueries: 1 },
      now: () => new Date('2026-10-15T05:00:00Z'),
    },
  });
  const { Story } = await getModels();
  const stories = await Story.find().lean();
  return Object.fromEntries(
    stories.map((s) => [
      s.headline,
      {
        outcome: s.evaluation?.outcome,
        action: s.recommendedAction,
        failing: (s.gates?.results ?? []).filter((r) => r.outcome !== 'pass').map((r) => r.gate),
        keyClaims: s.keyClaims,
      },
    ]),
  );
}

describe('evidence gates in the pipeline', () => {
  it('qualifies a story whose quoted claim is found, and holds one whose quote was invented', async () => {
    const { llm } = llmWith((headline) =>
      /Invented/.test(headline)
        ? {
            keyClaims: [
              claim(
                'The biennale opened in eleven venues.',
                'It opened in eleven venues across the city.',
              ),
            ],
          }
        : {},
    );
    const result = await outcomes(
      [
        hit('found', 'Found textile biennale opens in Lagos'),
        hit('invented', 'Invented biennale report from Accra'),
      ],
      llm,
    );
    expect(result['Found textile biennale opens in Lagos']).toMatchObject({ outcome: 'qualified' });
    expect(result['Found textile biennale opens in Lagos']?.keyClaims?.[0]?.status).toBe(
      'no_defect_found',
    );
    expect(result['Invented biennale report from Accra']).toMatchObject({
      outcome: 'gate_hold',
      action: 'research',
      failing: ['evidence'],
    });
  });

  it('holds a story whose sources the assessment rated unknown, however high it scores', async () => {
    const { llm } = llmWith(() => ({ sourceQuality: [{ ref: 'A1', quality: 'unknown' }] }));
    const result = await outcomes(
      [hit('weak', 'Unknown blog reports a design week in Nairobi')],
      llm,
    );
    expect(result['Unknown blog reports a design week in Nairobi']).toMatchObject({
      outcome: 'gate_hold',
      failing: ['sources', 'evidence'],
    });
  });

  it('judges a single primary source on its merits: facts pass, a bare announcement is a lead', async () => {
    const { llm } = llmWith((headline) => ({
      sourceQuality: [{ ref: 'A1', quality: 'primary' }],
      ...(/announces/.test(headline)
        ? { pressRelease: { leadOnly: true, reason: 'Only the museum’s own release.' } }
        : {}),
    }));
    const result = await outcomes(
      [
        hit(
          'programme',
          'Museum details its restitution programme in Benin City',
          'museum.example',
        ),
        hit(
          'release',
          'Museum announces a new season of talks in Cape Town',
          'other-museum.example',
        ),
      ],
      llm,
    );
    expect(result['Museum details its restitution programme in Benin City']?.outcome).toBe(
      'qualified',
    );
    expect(result['Museum announces a new season of talks in Cape Town']).toMatchObject({
      outcome: 'gate_hold',
      action: 'research',
      failing: ['single_origin'],
    });
  });

  it('shows triage signals to the evaluator and holds one it neither confirms nor dismisses', async () => {
    const { llm, calls } = llmWith(
      (headline) =>
        /dismissed/.test(headline)
          ? {
              dismissedSignals: [
                { signal: 'routine_announcement', reason: 'A first edition, not routine.' },
              ],
            }
          : {},
      () => ['routine_announcement'],
    );
    const result = await outcomes(
      [
        hit('a', 'Festival opening dismissed as routine in Dakar'),
        hit('b', 'Festival opening ignored by the assessment'),
      ],
      llm,
    );
    const prompt = calls.find((c) => c.operation === 'evaluate')?.prompt ?? '';
    expect(prompt).toMatch(/TRIAGE SIGNALS[^\n]*\nA1: routine_announcement/);
    expect(result['Festival opening dismissed as routine in Dakar']?.outcome).toBe('qualified');
    expect(result['Festival opening ignored by the assessment']).toMatchObject({
      outcome: 'gate_hold',
      failing: ['signal:routine_announcement'],
    });
  });
});

it('keeps the evaluation prompt free of a triage block when triage raised nothing', () => {
  const story = { relation: 'new' } as Parameters<typeof evaluationPrompt>[0];
  const prompt = evaluationPrompt(
    story,
    [
      {
        ...article(),
        publisher: 'P',
        publishedAt: null,
        originalHeadline: 'H',
        extractionStatus: 'extracted',
        content: 'Text.',
        snippet: '',
        triage: null,
      } as unknown as SourceArticleDoc,
    ],
    null,
    6_000,
  );
  expect(prompt).not.toMatch(/TRIAGE SIGNALS/);
});
