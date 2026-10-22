/**
 * Triage after the 2026-10-22 production incident (ADR-046): an overlong reason, a cut-off or
 * invalid batch answer, a refused schema and a transient failure each take their own path, every
 * article ends with an explicit triage record, and nothing is ever written over a decision. A
 * programmable provider sits behind the real LlmClient, so validation, the normalizer and the
 * repair round run as in production. Proves pipeline logic only, never real model behaviour.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../../db/models.js';
import { createLlmClient } from '../../llm/client.js';
import {
  LlmError,
  type LlmProvider,
  type ProviderRequest,
  type StopReason,
} from '../../llm/types.js';
import { promptArticles } from '../../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../../testing/index.js';
import { readDiscoveryConfig } from '../config.js';
import type { DiscoveryDeps } from './context.js';
import { TRIAGE_TOKENS_BASE, TRIAGE_TOKENS_PER_ARTICLE, triageStage } from './triage.js';

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

const RUN = 'daily-discovery:2026-10-22';
const UNAVAILABLE = 'Triage unavailable; passed to clustering for full evaluation.';

type Reply = { text: string; stop?: StopReason } | LlmError;

function programmable(handler: (request: ProviderRequest, n: number) => Reply | Promise<Reply>) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    name: 'anthropic',
    generate: async (request) => {
      requests.push(request);
      const reply = await handler(request, requests.length);
      if (reply instanceof LlmError) throw reply;
      return {
        text: reply.text,
        model: 'claude-haiku-5-5',
        stopReason: reply.stop ?? 'complete',
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0 },
      };
    },
  };
  const llm = createLlmClient({
    provider,
    models: {
      triage: 'claude-haiku-5-5',
      primary: 'claude-sonnet-5-5',
      escalation: 'claude-opus-5-5',
    },
    recordUsage: () => Promise.resolve(),
  });
  const deps: DiscoveryDeps = {
    llm,
    search: {
      search: () => Promise.reject(new Error('no search')),
      extract: () => Promise.reject(new Error('no search')),
    },
    config: { ...readDiscoveryConfig({}), triageBatchSize: 6 },
    now: () => new Date('2026-10-22T05:10:00Z'),
  };
  return { deps, requests };
}

/** Articles across Omenai's domains, so nothing depends on one topic. */
const HEADLINES = [
  'Lagos biennale names its curators',
  'São Paulo choreographer premieres a new work',
  'Accra architects restore a modernist market',
  'Nairobi designers stage a sustainable fashion week',
  'Dakar jazz festival announces its programme',
  'Kinshasa film collective wins a festival prize',
  'Cape Town publisher launches a poetry imprint',
  'Marrakech heritage site reopens after restoration',
  'Johannesburg photographer opens a retrospective',
  'Addis Ababa chefs revive a regional cuisine',
  'Salvador samba school archives its history',
  'Kampala gallery shows a new generation of painters',
];

async function seedArticles(n: number) {
  const { SourceArticle, WorkflowRun } = await getModels();
  await WorkflowRun.create({ runKey: RUN, trigger: 'schedule' });
  for (let i = 0; i < n; i += 1)
    await SourceArticle.create({
      canonicalUrl: `https://culture.example/${i}`,
      url: `https://culture.example/${i}`,
      host: 'culture.example',
      publisher: 'Culture Desk',
      originalHeadline: HEADLINES[i % HEADLINES.length]!,
      retrievedAt: new Date('2026-10-22T05:09:00Z'),
      publishedAt: new Date('2026-10-21T08:00:00Z'),
      origin: 'discovery',
      extractionStatus: 'extracted',
      content: `${HEADLINES[i % HEADLINES.length]}. A report with enough text to triage (${i}).`,
      firstRunKey: RUN,
      intakeRunKey: RUN,
    });
}

const entry = (ref: string, overrides: Record<string, unknown> = {}) => ({
  ref,
  inScope: true,
  reason: 'A specific cultural development with named people and a clear angle.',
  eventSummary: 'A cultural institution announced a programme.',
  eventDate: null,
  entities: ['Culture Desk'],
  places: ['Lagos'],
  exclusionSignals: [],
  ...overrides,
});
const answer = (
  request: ProviderRequest,
  overrides: (ref: string) => Record<string, unknown> = () => ({}),
) => ({
  text: JSON.stringify({
    articles: promptArticles(request.messages[0]!.content).map((a) =>
      entry(a.ref, overrides(a.ref)),
    ),
  }),
});
const refsOf = (request: ProviderRequest) => promptArticles(request.messages[0]!.content).length;

async function triages() {
  const { SourceArticle } = await getModels();
  return (await SourceArticle.find().sort({ canonicalUrl: 1 }).lean()).map((a) => a.triage);
}

describe('triage, after the 2026-10-22 incident', () => {
  it('1. saves a valid, concise answer in one request per batch of six', async () => {
    await seedArticles(6);
    const { deps, requests } = programmable((request) => answer(request));
    const stats = await triageStage(RUN, deps);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.maxOutputTokens).toBe(TRIAGE_TOKENS_PER_ARTICLE * 6 + TRIAGE_TOKENS_BASE);
    expect(stats).toMatchObject({ triaged: 6, fallbacks: 0, splits: 0, shortenedReasons: 0 });
    expect((await triages()).every((t) => t?.model === 'claude-haiku-5-5')).toBe(true);
  });

  const LONG = [
    [
      'music',
      'The festival commissions new work from three Dakar composers and pairs them with Brazilian percussionists, a collaboration that matters to Omenai because it traces the Atlantic routes of rhythm. It also opens a public archive of recordings. The organisers say the archive will be online by spring, with commentary from musicologists in Lagos and Salvador, and a programme of talks.',
    ],
    [
      'architecture',
      'Architects are restoring a 1960s market hall whose concrete shells were designed by a Ghanaian engineer, a rare surviving example of tropical modernism in civic use. The work is led by a local practice. It is funded by the city and two foundations, and the market stays open throughout so that the traders who run it keep their livelihoods while the roof and the drainage are rebuilt over two years.',
    ],
    [
      'food',
      'A group of chefs is documenting a regional cuisine through recipes gathered from grandmothers in three highland towns, with a book and a series of dinners planned. The angle is about memory and land. The project names its contributors and says where each recipe came from, which gives editors people to approach and a clear visual story, though the dates of the dinners are still to be confirmed.',
    ],
  ] as const;

  it.each(LONG)(
    '2. shortens an overlong %s reason by sentence, without a repair or a changed decision',
    async (_domain, reason) => {
      expect(reason.length).toBeGreaterThan(300);
      await seedArticles(3);
      const { deps, requests } = programmable((request) =>
        answer(request, (ref) => (ref === 'A2' ? { reason, inScope: false } : {})),
      );
      const stats = await triageStage(RUN, deps);
      expect(requests).toHaveLength(1);
      expect(stats.shortenedReasons).toBe(1);
      const stored = (await triages())[1]!;
      expect(stored.inScope).toBe(false);
      expect(stored.reason.length).toBeLessThanOrEqual(300);
      expect(reason.startsWith(stored.reason)).toBe(true);
      expect(stored.reason).toMatch(/[.!?]$/);
    },
  );

  it('3. splits a batch that hits its token limit, and asks again only for its halves', async () => {
    await seedArticles(6);
    const { deps, requests } = programmable((request, n) =>
      n === 1 ? { text: '{"articles":[', stop: 'max_tokens' } : answer(request),
    );
    const stats = await triageStage(RUN, deps);
    expect(requests.map(refsOf)).toEqual([6, 3, 3]);
    expect(stats).toMatchObject({ triaged: 6, fallbacks: 0, splits: 1 });
    expect((await triages()).every((t) => t?.model === 'claude-haiku-5-5')).toBe(true);
  });

  it('4. never saves a cut-off answer, even one that parses, or one that is not JSON', async () => {
    await seedArticles(4);
    const { deps, requests } = programmable((request, n) => {
      if (n === 1) return { ...answer(request, () => ({ reason: 'cut off' })), stop: 'max_tokens' };
      if (n === 2) return { text: '{"articles":[{"ref":"A1","inScope":tr' };
      return answer(request);
    });
    const stats = await triageStage(RUN, deps);
    expect(requests.map(refsOf)).toEqual([4, 2, 1, 1, 2]);
    expect(stats.fallbacks).toBe(0);
    expect((await triages()).some((t) => t?.reason === 'cut off')).toBe(false);
  });

  it('5. stops at a refused schema: one request, every article explicitly unavailable', async () => {
    await seedArticles(12);
    const { deps, requests } = programmable(
      () =>
        new LlmError(
          'schema_rejected',
          'Anthropic API error 400: The compiled grammar is too large',
          'anthropic',
          { status: 400 },
        ),
    );
    const stats = await triageStage(RUN, deps);
    expect(requests).toHaveLength(1);
    expect(stats).toMatchObject({ triaged: 12, fallbacks: 12 });
    expect(
      (await triages()).every((t) => t?.model === 'none' && t.reason === UNAVAILABLE && t.inScope),
    ).toBe(true);
    const { WorkflowRun } = await getModels();
    const errors = (await WorkflowRun.findOne({ runKey: RUN }).lean())?.runErrors ?? [];
    expect(errors.map((e) => e.message).join('\n')).toMatch(/no further triage requests/);
  });

  it.each([
    ['429', new LlmError('rate_limited', 'Anthropic API error 429', 'anthropic', { status: 429 })],
    ['529', new LlmError('unavailable', 'Anthropic API error 529', 'anthropic', { status: 529 })],
  ])(
    '6. lets a transient %s propagate, keeps saved work, and resumes only what is left',
    async (_s, failure) => {
      await seedArticles(12);
      const first = programmable((request, n) => (n === 2 ? failure : answer(request)));
      await expect(triageStage(RUN, first.deps)).rejects.toBe(failure);
      expect((await triages()).filter(Boolean)).toHaveLength(6);
      const second = programmable((request) => answer(request));
      await triageStage(RUN, second.deps);
      expect(second.requests.map(refsOf)).toEqual([6]);
      expect((await triages()).every((t) => t?.model === 'claude-haiku-5-5')).toBe(true);
    },
  );

  it('7–8. a batch that fails is saved article by article; a single still invalid after its repair falls back', async () => {
    await seedArticles(2);
    // A2 always comes back without its decision; A1 is fine.
    const { deps, requests } = programmable((request) => {
      const headlines = new Map(
        promptArticles(request.messages[0]!.content).map((a) => [a.ref, a.headline]),
      );
      return answer(request, (ref) =>
        headlines.get(ref) === HEADLINES[1] ? { inScope: undefined } : {},
      );
    });
    const stats = await triageStage(RUN, deps);
    // The pair (no repair for a batch), then each alone; the bad one gets its one repair round.
    expect(requests.map(refsOf)).toEqual([2, 1, 1, 1]);
    expect(stats).toMatchObject({ triaged: 2, fallbacks: 1, splits: 1 });
    const [good, bad] = await triages();
    expect(good?.model).toBe('claude-haiku-5-5');
    expect(bad).toMatchObject({ model: 'none', reason: UNAVAILABLE, inScope: true });
  });

  it('11. a repeated delivery sends nothing, and a concurrent decision is never overwritten', async () => {
    await seedArticles(3);
    const { SourceArticle } = await getModels();
    const { deps } = programmable(async (request) => {
      // Someone else triages A1 while our request is out.
      await SourceArticle.updateOne(
        { canonicalUrl: 'https://culture.example/0' },
        {
          $set: {
            triage: {
              ...entry('A1', { reason: 'decided elsewhere' }),
              model: 'other',
              triagedAt: new Date(),
            },
          },
        },
      );
      return answer(request);
    });
    const stats = await triageStage(RUN, deps);
    expect(stats.triaged).toBe(2);
    expect((await triages())[0]?.reason).toBe('decided elsewhere');
    const again = programmable((request) => answer(request));
    await triageStage(RUN, again.deps);
    expect(again.requests).toHaveLength(0);
    expect(await SourceArticle.countDocuments()).toBe(3);
  });

  it('13. every article ends with an explicit record, whatever happens', async () => {
    await seedArticles(12);
    let n = 0;
    const { deps } = programmable((request) => {
      n += 1;
      if (n % 3 === 0) return { text: 'not json' };
      if (n % 4 === 0) return new LlmError('refusal', 'declined', 'anthropic');
      return answer(request);
    });
    await triageStage(RUN, deps);
    const all = await triages();
    expect(all).toHaveLength(12);
    for (const t of all) {
      expect(t).not.toBeNull();
      expect(
        t!.model === 'none' ? t!.reason === UNAVAILABLE : t!.model === 'claude-haiku-5-5',
      ).toBe(true);
    }
  });
});
