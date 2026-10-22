/**
 * Targeted run recovery (ADR-046) against an in-memory database: a completed run shaped like the
 * 2026-10-22 production incident, with stories in every state recovery must tell apart. A
 * programmable provider sits behind the real LlmClient and the real triage, assessment, gates and
 * ranking. Proves the recovery's selection, guards, idempotency and accounting, not model output.
 */
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { createLlmClient } from '../llm/client.js';
import { LlmError, type LlmProvider, type ProviderRequest } from '../llm/types.js';
import { getOperationsOverview } from '../ops/overview.js';
import { fixtureEvaluation, fixtureKeyClaims, scores } from '../testing/discovery-fixtures.js';
import { promptArticles } from '../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { readDiscoveryConfig } from './config.js';
import type { DiscoveryDeps } from './pipeline/context.js';
import { EVALUATION_SYSTEM_PROMPT, TRIAGE_SYSTEM_PROMPT } from './prompts.js';
import { applyRecovery, planRecovery, type RecoveryTarget } from './recovery.js';

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
const NOW = new Date('2026-10-22T18:00:00Z');
const GRAMMAR =
  'Anthropic API error 400: Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large, which would cause performance issues."}}';
const target: RecoveryTarget = {
  runKey: RUN,
  id: 'test-recovery',
  reason: 'test',
  failure: /compiled grammar is too large/,
};

type Kind =
  | 'failed'
  | 'failed_fallback'
  | 'pending_fallback'
  | 'assessed'
  | 'rejected'
  | 'skipped'
  | 'saved'
  | 'other_failure'
  | 'no_text';

/** Seeds the run and one story per kind, each with its own article; returns ids by kind. */
async function seed(kinds: Kind[]) {
  const { Story, SourceArticle, WorkflowRun, Task } = await getModels();
  const ids: Record<string, string> = {};
  const outcomes: Array<{ storyId: Types.ObjectId; outcome: string; detail: string }> = [];
  for (const [i, kind] of kinds.entries()) {
    const fallback = kind.endsWith('_fallback');
    const article = await SourceArticle.create({
      canonicalUrl: `https://culture.example/${kind}-${i}`,
      url: `https://culture.example/${kind}-${i}`,
      host: 'culture.example',
      publisher: 'Culture Desk',
      originalHeadline: `Story ${kind} ${i}: a cultural institution opens a programme`,
      retrievedAt: new Date('2026-10-22T05:09:00Z'),
      publishedAt: new Date('2026-10-21T08:00:00Z'),
      origin: 'discovery',
      extractionStatus: 'extracted',
      content:
        kind === 'no_text'
          ? ''
          : `The institution opened a new programme of exhibitions on 21 October 2026 in Lagos. It names three curators (${kind}).`,
      snippet: '',
      firstRunKey: RUN,
      intakeRunKey: RUN,
      triage: {
        inScope: true,
        reason: fallback
          ? 'Triage unavailable; passed to clustering for full evaluation.'
          : 'In scope.',
        eventSummary: null,
        eventDate: null,
        entities: [],
        places: [],
        exclusionSignals: [],
        model: fallback ? 'none' : 'claude-haiku-5-5',
        triagedAt: new Date('2026-10-22T05:10:00Z'),
      },
    });
    const evaluation: {
      status: 'pending' | 'evaluated' | 'failed';
      runKey?: string;
      outcome?: 'qualified' | 'gate_reject' | 'evaluation_failed';
      model?: string;
      error?: string;
      failedRuns?: number;
    } =
      kind === 'pending_fallback'
        ? { status: 'pending' }
        : kind === 'assessed'
          ? { status: 'evaluated', runKey: RUN, outcome: 'qualified', model: 'claude-sonnet-5-5' }
          : kind === 'rejected'
            ? {
                status: 'evaluated',
                runKey: RUN,
                outcome: 'gate_reject',
                model: 'claude-sonnet-5-5',
              }
            : {
                status: 'failed',
                runKey: RUN,
                outcome: 'evaluation_failed',
                error:
                  kind === 'other_failure' ? 'invalid_output: the answer was invalid' : GRAMMAR,
                failedRuns: 1,
              };
    const story = await Story.create({
      headline: `Story ${kind} ${i}`,
      sourceArticleIds: [article._id],
      firstSeenRunKey: RUN,
      lastCandidateRunKey: RUN,
      evaluation,
      editorialState: kind === 'skipped' ? 'skipped' : kind === 'saved' ? 'saved' : 'none',
      decisions:
        kind === 'saved' || kind === 'skipped'
          ? [
              {
                action: kind === 'saved' ? 'saved' : 'skipped',
                userId: 'editor-1',
                at: new Date('2026-10-22T09:00:00Z'),
              },
            ]
          : [],
      ...(kind === 'assessed'
        ? {
            score: { total: 81, band: 'priority', confidence: 'high', dimensions: [] },
            gates: { outcome: 'pass', results: [] },
            // As finalize left it: recommended in its run.
            recommendations: [
              {
                runKey: RUN,
                rank: 1,
                score: 81,
                isUpdate: false,
                at: new Date('2026-10-22T05:12:20Z'),
              },
            ],
            lastRecommendedAt: new Date('2026-10-22T05:12:20Z'),
          }
        : {}),
    });
    await SourceArticle.updateOne({ _id: article._id }, { $set: { storyIds: [story._id] } });
    ids[`${kind}${kinds.indexOf(kind) === i ? '' : `-${i}`}`] = String(story._id);
    outcomes.push({
      storyId: story._id,
      outcome: evaluation.status === 'pending' ? 'deferred_late' : evaluation.outcome!,
      detail: evaluation.error ?? '',
    });
    if (evaluation.status === 'failed')
      await Task.create({
        key: `discovery.evaluate:${RUN}:${String(story._id)}`,
        kind: 'discovery.evaluate',
        runKey: RUN,
        storyId: story._id,
        status: 'failed',
        attempts: 1,
        lastError: evaluation.error ?? null,
      });
  }
  await WorkflowRun.create({
    runKey: RUN,
    trigger: 'schedule',
    status: 'completed',
    stage: 'done',
    attempts: 1,
    completedAt: new Date('2026-10-22T05:12:20Z'),
    candidateSetClosedAt: new Date('2026-10-22T05:12:20Z'),
    completedStages: ['discover', 'revisit', 'extract', 'triage', 'cluster'],
    stageStats: { triage: { triaged: kinds.length, inScope: kinds.length, fallbacks: 2 } },
    config: {
      shortlistThreshold: 65,
      priorityThreshold: 80,
      shortlistMax: 8,
      maxEvaluations: 25,
      maxEscalations: 4,
      freshnessDays: 14,
    },
    outcomes,
    shortlist: outcomes
      .filter((o) => o.outcome === 'qualified')
      .map((o, i) => ({ storyId: o.storyId, rank: i + 1, score: 81, isUpdate: false })),
    runErrors: [
      {
        stage: 'triage',
        message: 'Batch fallback: earlier failure',
        at: new Date('2026-10-22T05:10:00Z'),
      },
    ],
  });
  return ids;
}

interface Script {
  evaluate?: (request: ProviderRequest, n: number) => unknown;
}

function programmable(script: Script = {}) {
  const requests: Array<{ operation: 'triage' | 'evaluate'; request: ProviderRequest }> = [];
  let evaluations = 0;
  const provider: LlmProvider = {
    name: 'anthropic',
    generate: async (request) => {
      const operation =
        request.system === TRIAGE_SYSTEM_PROMPT
          ? 'triage'
          : request.system === EVALUATION_SYSTEM_PROMPT
            ? 'evaluate'
            : null;
      if (!operation) throw new Error('unexpected prompt');
      requests.push({ operation, request });
      const prompt = request.messages[0]!.content;
      let data: unknown;
      if (operation === 'triage') {
        data = {
          articles: promptArticles(prompt).map((a) => ({
            ref: a.ref,
            inScope: true,
            reason: 'A named institution and a new programme.',
            eventSummary: 'An institution opened a programme.',
            eventDate: '2026-10-21',
            entities: ['Culture Desk'],
            places: ['Lagos'],
            exclusionSignals: [],
          })),
        };
      } else {
        evaluations += 1;
        const custom = await script.evaluate?.(request, evaluations);
        if (custom instanceof LlmError) throw custom;
        data =
          custom ??
          fixtureEvaluation(scores(5), {
            headline: promptArticles(prompt)[0]?.headline ?? 'Recovered',
            keyClaims: fixtureKeyClaims(prompt),
          });
      }
      return {
        text: JSON.stringify(data),
        model: operation === 'triage' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5',
        stopReason: 'complete',
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
      search: () => Promise.reject(new Error('Recovery never searches.')),
      extract: () => Promise.reject(new Error('Recovery never searches.')),
    },
    config: readDiscoveryConfig({}),
    now: () => NOW,
  };
  return { deps, requests, budget: (ceiling = 100) => ({ ceiling, used: () => requests.length }) };
}

const noPause = () => Promise.resolve();

/** Every stored record as JSON, to prove what a step did and didn't change. */
async function snapshot() {
  const { Story, SourceArticle, WorkflowRun } = await getModels();
  const byId = async (model: typeof Story | typeof SourceArticle) =>
    Object.fromEntries(
      (await (model as typeof Story).find().lean()).map((d) => [String(d._id), JSON.stringify(d)]),
    );
  return {
    stories: await byId(Story),
    articles: await byId(SourceArticle),
    run: JSON.stringify(await WorkflowRun.findOne({ runKey: RUN }).lean()),
  };
}

const ALL: Kind[] = [
  'failed',
  'failed_fallback',
  'pending_fallback',
  'assessed',
  'rejected',
  'skipped',
  'saved',
  'other_failure',
  'no_text',
];

describe('run recovery', () => {
  it('previews every candidate’s group from stored state, writing nothing', async () => {
    const ids = await seed(ALL);
    const before = await snapshot();
    const plan = await planRecovery(target);
    expect(await snapshot()).toEqual(before);
    expect(plan.counts).toMatchObject({
      incident_failed: 2,
      pending: 1,
      assessed: 1,
      rejected: 1,
      editor_skipped: 1,
      protected: 1,
      other_failure: 1,
      missing_content: 1,
    });
    // The incident's failures first, in the run's order, then the pending one.
    expect(plan.eligible).toEqual([ids.failed, ids.failed_fallback, ids.pending_fallback]);
    expect(plan.retriage).toHaveLength(2);
    expect(plan.estimate.expected).toBe(1 + 3);
  });

  it('assesses only eligible stories, through the normal gates, and leaves every other record exactly as it was', async () => {
    const ids = await seed(ALL);
    const before = await snapshot();
    const { deps, requests, budget } = programmable();
    const report = await applyRecovery({ target, deps, budget: budget(), pause: noPause });
    expect(report.status).toBe('completed');
    expect(requests.filter((r) => r.operation === 'triage')).toHaveLength(1);

    const after = await snapshot();
    const eligible = new Set([ids.failed!, ids.failed_fallback!, ids.pending_fallback!]);
    for (const [id, json] of Object.entries(before.stories))
      if (!eligible.has(id)) expect(after.stories[id]).toBe(json);
    expect(Object.keys(after.stories)).toHaveLength(Object.keys(before.stories).length);
    expect(Object.keys(after.articles)).toHaveLength(Object.keys(before.articles).length);

    const { Story, SourceArticle, WorkflowRun, Task } = await getModels();
    for (const id of eligible) {
      const story = await Story.findById(id).lean();
      // Assessed for its own run, not deferred to the next one; the score is computed in code.
      expect(story?.evaluation).toMatchObject({ status: 'evaluated', runKey: RUN, error: null });
      expect(story?.evaluation?.outcome).not.toBe('deferred_late');
      expect(story?.score?.total).toBe(100);
      const task = await Task.findOne({ key: `discovery.evaluate:${RUN}:${id}` }).lean();
      expect(task).toMatchObject({ status: 'succeeded', triggerRunId: 'recovery:test-recovery' });
    }
    expect(await SourceArticle.countDocuments({ 'triage.model': 'none' })).toBe(0);

    const run = await WorkflowRun.findOne({ runKey: RUN }).lean();
    expect(run?.status).toBe('completed');
    expect(run?.runErrors).toHaveLength(1);
    expect(run?.recovery).toMatchObject({
      id: 'test-recovery',
      status: 'completed',
      before: { outcomes: { evaluation_failed: 6, deferred_late: 1 } },
    });
    // Ranked by the run's rules: the recovered qualifiers join the already assessed one.
    const outcomeOf = new Map((run?.outcomes ?? []).map((o) => [String(o.storyId), o.outcome]));
    for (const id of eligible) expect(outcomeOf.get(id)).toBe(story(id, report));
    expect(outcomeOf.get(ids.other_failure!)).toBe('evaluation_failed');
    expect(run?.shortlist?.map((s) => String(s.storyId))).toEqual(
      expect.arrayContaining([...eligible]),
    );

    // A completed recovery is not run again.
    const again = programmable();
    const second = await applyRecovery({
      target,
      deps: again.deps,
      budget: again.budget(),
      pause: noPause,
    });
    expect(second.claimed).toBe(false);
    expect(again.requests).toHaveLength(0);
  });

  function story(id: string, report: Awaited<ReturnType<typeof applyRecovery>>) {
    return report.stories.find((s) => s.storyId === id)?.outcome;
  }

  it('9. stops before its ceiling, records that, and a resumed run finishes without redoing work', async () => {
    const ids = await seed(['failed', 'failed_fallback', 'pending_fallback']);
    const first = programmable();
    // Triage (1) and one assessment (up to 2 + 2 with an escalation) fit; the second doesn't.
    const report = await applyRecovery({
      target,
      deps: first.deps,
      budget: first.budget(5),
      pause: noPause,
    });
    expect(report.status).toBe('incomplete');
    expect(first.requests.length).toBeLessThanOrEqual(5);
    expect(report.stories.filter((s) => s.result === 'assessed')).toHaveLength(1);
    const { Story, WorkflowRun } = await getModels();
    expect((await Story.findById(ids.failed_fallback).lean())?.evaluation?.status).toBe('failed');
    expect((await Story.findById(ids.pending_fallback).lean())?.evaluation?.status).toBe('pending');
    expect((await WorkflowRun.findOne({ runKey: RUN }).lean())?.recovery?.status).toBe(
      'incomplete',
    );
    const overview = await getOperationsOverview(NOW);
    expect(overview.attention.map((a) => a.kind)).toContain('recovery_incomplete');

    const resumed = programmable();
    const done = await applyRecovery({
      target,
      deps: resumed.deps,
      budget: resumed.budget(),
      pause: noPause,
    });
    expect(done.status).toBe('completed');
    // Only the two left are assessed; triage was already done.
    expect(resumed.requests.map((r) => r.operation)).toEqual(['evaluate', 'evaluate']);
    expect((await getOperationsOverview(NOW)).attention.map((a) => a.kind)).not.toContain(
      'recovery_incomplete',
    );
  });

  it('completes placeholder triage on a story already assessed, without touching the story', async () => {
    const ids = await seed(['failed_fallback']);
    const { Story, SourceArticle, WorkflowRun } = await getModels();
    // As a canary left it: assessed by this recovery, its article still "Triage unavailable".
    await Story.updateOne(
      { _id: ids.failed_fallback },
      { $set: { evaluation: { status: 'evaluated', runKey: RUN, outcome: 'qualified' } } },
    );
    await WorkflowRun.updateOne(
      { runKey: RUN },
      {
        $set: {
          recovery: {
            id: 'test-recovery',
            status: 'completed',
            reason: 'x',
            startedAt: NOW,
            updatedAt: NOW,
          },
        },
      },
    );
    const before = JSON.stringify(await Story.findById(ids.failed_fallback).lean());
    const plan = await planRecovery(target);
    expect(plan.eligible).toEqual([]);
    expect(plan.retriage).toHaveLength(1);
    const { deps, requests, budget } = programmable();
    const report = await applyRecovery({ target, deps, budget: budget(), pause: noPause });
    expect(requests.map((r) => r.operation)).toEqual(['triage']);
    expect(report.status).toBe('completed');
    expect(JSON.stringify(await Story.findById(ids.failed_fallback).lean())).toBe(before);
    expect(await SourceArticle.countDocuments({ 'triage.model': 'none' })).toBe(0);
    // Nothing left: a further run sends nothing.
    const again = programmable();
    expect(
      (await applyRecovery({ target, deps: again.deps, budget: again.budget(), pause: noPause }))
        .stoppedBy,
    ).toBe('Nothing left to recover.');
    expect(again.requests).toHaveLength(0);
  });

  it('takes over a recovery whose process died, but never one that is still running', async () => {
    await seed(['failed']);
    const { WorkflowRun } = await getModels();
    const claimedAt = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
    await WorkflowRun.updateOne(
      { runKey: RUN },
      {
        $set: {
          recovery: {
            id: 'test-recovery',
            status: 'running',
            reason: 'x',
            startedAt: claimedAt(2),
            updatedAt: claimedAt(2),
          },
        },
      },
    );
    const live = programmable();
    expect(
      (await applyRecovery({ target, deps: live.deps, budget: live.budget(), pause: noPause }))
        .claimed,
    ).toBe(false);
    expect(live.requests).toHaveLength(0);
    await WorkflowRun.updateOne({ runKey: RUN }, { $set: { 'recovery.updatedAt': claimedAt(30) } });
    const takeover = programmable();
    expect(
      (
        await applyRecovery({
          target,
          deps: takeover.deps,
          budget: takeover.budget(),
          pause: noPause,
        })
      ).status,
    ).toBe('completed');
  });

  it('10–11. never writes over an editor decision made while the story was being assessed', async () => {
    const ids = await seed(['failed', 'failed_fallback']);
    const { Story } = await getModels();
    const { deps, budget } = programmable({
      evaluate: async (request) => {
        if (promptArticles(request.messages[0]!.content)[0]?.headline.includes('failed_fallback'))
          await Story.updateOne(
            { _id: ids.failed_fallback },
            {
              $set: { editorialState: 'saved' },
              $push: { decisions: { action: 'saved', userId: 'editor-2', at: NOW } },
            },
          );
        return undefined;
      },
    });
    const report = await applyRecovery({ target, deps, budget: budget(), pause: noPause });
    expect(report.stories.find((s) => s.storyId === ids.failed_fallback)?.result).toBe('conflict');
    const saved = await Story.findById(ids.failed_fallback).lean();
    expect(saved?.editorialState).toBe('saved');
    expect(saved?.evaluation?.status).toBe('failed');
    expect(saved?.headline).toBe('Story failed_fallback 1');
    expect((await Story.findById(ids.failed).lean())?.evaluation?.status).toBe('evaluated');
  });

  it('5. stops at a refused schema after one assessment request, leaving every story eligible', async () => {
    const ids = await seed(['failed', 'failed_fallback', 'pending_fallback']);
    const { deps, requests, budget } = programmable({
      evaluate: () => new LlmError('schema_rejected', GRAMMAR, 'anthropic', { status: 400 }),
    });
    const report = await applyRecovery({ target, deps, budget: budget(), pause: noPause });
    expect(requests.filter((r) => r.operation === 'evaluate')).toHaveLength(1);
    expect(report.status).toBe('incomplete');
    expect(report.stoppedBy).toMatch(/permanent request error \(schema_rejected\)/);
    expect((await planRecovery(target)).eligible).toEqual([
      ids.failed,
      ids.failed_fallback,
      ids.pending_fallback,
    ]);
  });

  it('stops before any assessment when triage fails on a transient error; the resume triages first', async () => {
    await seed(['failed_fallback', 'pending_fallback']);
    const { SourceArticle } = await getModels();
    const outage = programmable();
    const inner = outage.deps.llm;
    outage.deps.llm = {
      ...inner,
      generateObject: (request) =>
        request.operation === 'discovery.triage'
          ? Promise.reject(new LlmError('unavailable', 'Connection error.', 'anthropic'))
          : inner.generateObject(request),
    };
    const report = await applyRecovery({
      target,
      deps: outage.deps,
      budget: outage.budget(),
      pause: noPause,
    });
    expect(report.status).toBe('incomplete');
    expect(report.stoppedBy).toMatch(/Triage stopped on a transient error/);
    expect(report.stories).toEqual([]);
    expect(await SourceArticle.countDocuments({ 'triage.model': 'none' })).toBe(2);
    const resumed = programmable();
    const done = await applyRecovery({
      target,
      deps: resumed.deps,
      budget: resumed.budget(),
      pause: noPause,
    });
    expect(resumed.requests.map((r) => r.operation)).toEqual(['triage', 'evaluate', 'evaluate']);
    expect(done.status).toBe('completed');
  });

  it('6. a transient failure leaves the story for later and backs off; repeated ones stop the recovery', async () => {
    const ids = await seed(['failed', 'failed_fallback', 'pending_fallback', 'failed']);
    const pauses: number[] = [];
    const { deps, budget } = programmable({
      evaluate: (_r, n) =>
        n === 1
          ? undefined
          : new LlmError('unavailable', 'Anthropic API error 529', 'anthropic', { status: 529 }),
    });
    const report = await applyRecovery({
      target,
      deps,
      budget: budget(),
      pause: (ms) => (pauses.push(ms), Promise.resolve()),
    });
    expect(report.stories.map((s) => s.result)).toEqual(['assessed', 'left', 'left', 'left']);
    expect(report.stoppedBy).toMatch(/3 transient failures in a row/);
    expect(pauses).toEqual([15_000, 15_000]);
    const { Story } = await getModels();
    expect((await Story.findById(ids.pending_fallback).lean())?.evaluation?.status).toBe('pending');
  });

  it('7. a story whose answer stays invalid after its repair gets an explicit failure with the real reason', async () => {
    const ids = await seed(['failed', 'pending_fallback']);
    const { deps, requests, budget } = programmable({
      evaluate: () => ({ headline: 'missing everything else' }),
    });
    const report = await applyRecovery({ target, deps, budget: budget(), pause: noPause });
    // Each assessment: the answer and its one repair round, no more.
    expect(requests.filter((r) => r.operation === 'evaluate')).toHaveLength(4);
    expect(report.stories.map((s) => s.result)).toEqual(['failed', 'failed']);
    const { Story } = await getModels();
    for (const id of [ids.failed, ids.pending_fallback]) {
      const evaluation = (await Story.findById(id).lean())?.evaluation;
      expect(evaluation).toMatchObject({
        status: 'failed',
        runKey: RUN,
        outcome: 'evaluation_failed',
        failedRuns: 1,
      });
      expect(evaluation?.error).toMatch(/failed validation after a repair attempt/);
    }
    // Two in a row: recovery stops rather than spend more on what looks like the request.
    expect(report.stoppedBy).toMatch(/2 assessments in a row failed on their answers/);
    // Not the incident's failure any more, so not this recovery's to retry: it is finished.
    expect(report.status).toBe('completed');
  });

  it('stops after two own failures in a row, leaving the rest untouched and eligible', async () => {
    const ids = await seed(['failed', 'failed_fallback', 'pending_fallback']);
    const { deps, requests, budget } = programmable({ evaluate: () => ({ headline: 'invalid' }) });
    const report = await applyRecovery({ target, deps, budget: budget(), pause: noPause });
    expect(report.stories.map((s) => s.result)).toEqual(['failed', 'failed', 'left']);
    expect(requests.filter((r) => r.operation === 'evaluate')).toHaveLength(4);
    expect(report.status).toBe('incomplete');
    expect((await planRecovery(target)).eligible).toEqual([ids.pending_fallback]);
  });

  it('assesses only a canary batch when asked, then resumes the rest', async () => {
    await seed(['failed', 'failed_fallback', 'pending_fallback']);
    const canary = programmable();
    const first = await applyRecovery({
      target,
      deps: canary.deps,
      budget: canary.budget(),
      maxStories: 1,
      pause: noPause,
    });
    expect(first.stories.map((s) => s.result)).toEqual(['assessed', 'left', 'left']);
    expect(first.status).toBe('incomplete');
    const rest = programmable();
    const second = await applyRecovery({
      target,
      deps: rest.deps,
      budget: rest.budget(),
      pause: noPause,
    });
    expect(second.stories.map((s) => s.result)).toEqual(['assessed', 'assessed']);
    expect(rest.requests.map((r) => r.operation)).toEqual(['evaluate', 'evaluate']);
    expect(second.status).toBe('completed');
  });
});
