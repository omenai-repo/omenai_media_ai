import { emptyFunnel, type RunFunnel, type ShortfallReason } from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import type { SourceArticleDoc } from '../db/models/source-article.js';
import type { StoryDoc } from '../db/models/story.js';
import type { WorkflowRunDoc } from '../db/models/workflow-run.js';
import { NotFoundError } from '../errors.js';
import type {
  RunDetailDto,
  RunSummaryDto,
  SourceDto,
  StoryCardDto,
  StoryDetailDto,
  UsageRowDto,
} from './dto.js';

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function toCard(story: StoryDoc, publishers: string[]): StoryCardDto {
  return {
    id: String(story._id),
    headline: story.headline,
    summary: story.summary ?? '',
    whyItMatters: story.whyItMatters ?? '',
    angle: story.angle ?? '',
    whyNow: story.whyNow ?? '',
    primaryPillar: (story.primaryPillar ?? null) as StoryCardDto['primaryPillar'],
    subcategories: (story.subcategories ?? []) as StoryCardDto['subcategories'],
    crossCuttingTags: (story.crossCuttingTags ?? []) as StoryCardDto['crossCuttingTags'],
    geography: (story.geography ?? []).map((g) => ({
      country: g.country,
      city: g.city ?? null,
      region: g.region as StoryCardDto['geography'][number]['region'],
    })),
    tier: story.tier ?? 5,
    score: {
      total: story.score?.total ?? null,
      band: (story.score?.band ?? null) as StoryCardDto['score']['band'],
      confidence: (story.score?.confidence ?? null) as StoryCardDto['score']['confidence'],
    },
    outcome: (story.evaluation?.outcome ?? null) as StoryCardDto['outcome'],
    recommendedAction: (story.recommendedAction ?? null) as StoryCardDto['recommendedAction'],
    timeliness: story.timeliness ?? null,
    noveltyStatus: story.noveltyStatus ?? null,
    relation: story.relation ?? 'new',
    editorialState: (story.editorialState ?? 'none') as StoryCardDto['editorialState'],
    sourceCount: story.sourceArticleIds.length,
    publishers,
    firstSeenRunKey: story.firstSeenRunKey,
    lastRecommendedAt: iso(story.lastRecommendedAt),
    createdAt: iso(story.createdAt as Date | undefined),
  };
}

/** Publisher names per story, in one query for a list of stories. */
async function publishersFor(stories: StoryDoc[]): Promise<Map<string, string[]>> {
  const { SourceArticle } = await getModels();
  const ids = stories.flatMap((s) => s.sourceArticleIds);
  const articles = await SourceArticle.find({ _id: { $in: ids } }, { publisher: 1 }).lean();
  const byId = new Map(articles.map((a) => [String(a._id), a.publisher]));
  return new Map(
    stories.map((s) => [
      String(s._id),
      [...new Set(s.sourceArticleIds.map((id) => byId.get(String(id))).filter((p): p is string => Boolean(p)))],
    ]),
  );
}

async function cards(stories: StoryDoc[]): Promise<StoryCardDto[]> {
  const publishers = await publishersFor(stories);
  return stories.map((s) => toCard(s, publishers.get(String(s._id)) ?? []));
}

function toRunSummary(run: WorkflowRunDoc): RunSummaryDto {
  const funnel = (run.funnel ?? emptyFunnel()) as RunFunnel;
  return {
    runKey: run.runKey,
    trigger: run.trigger,
    status: run.status ?? 'queued',
    stage: run.stage ?? 'queued',
    createdAt: iso(run.createdAt as Date | undefined),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    candidates: funnel.candidates ?? 0,
    qualified: funnel.qualified ?? 0,
    shortlisted: run.shortlist?.length ?? 0,
    shortfallReasons: (run.shortfallReasons ?? []) as ShortfallReason[],
  };
}

export async function listRuns(limit = 20): Promise<RunSummaryDto[]> {
  const { WorkflowRun } = await getModels();
  const runs = await WorkflowRun.find().sort({ createdAt: -1 }).limit(limit).lean();
  return runs.map(toRunSummary);
}

/**
 * The newsroom view: a completed run's shortlist in rank order. Defaults to the most recently
 * completed run; `runKey` selects an earlier one.
 */
export async function getNewsroom(runKey?: string): Promise<{
  run: RunSummaryDto | null;
  shortlist: StoryCardDto[];
  recentRuns: RunSummaryDto[];
}> {
  const { WorkflowRun, Story } = await getModels();
  const recent = await WorkflowRun.find({ status: 'completed' }).sort({ completedAt: -1 }).limit(14).lean();
  const run = runKey ? await WorkflowRun.findOne({ runKey, status: 'completed' }).lean() : (recent[0] ?? null);
  if (!run) return { run: null, shortlist: [], recentRuns: recent.map(toRunSummary) };

  const entries = run.shortlist ?? [];
  const ids = entries.map((e) => e.storyId).filter((id): id is Types.ObjectId => id instanceof Types.ObjectId);
  const stories = await Story.find({ _id: { $in: ids } }).lean();
  const byId = new Map((await cards(stories)).map((c) => [c.id, c]));
  const shortlist: StoryCardDto[] = [];
  for (const entry of entries) {
    const card = byId.get(String(entry.storyId));
    if (card) shortlist.push({ ...card, rank: entry.rank ?? 0, isUpdate: entry.isUpdate ?? false });
  }
  shortlist.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return { run: toRunSummary(run), shortlist, recentRuns: recent.map(toRunSummary) };
}

export async function listSavedStories(): Promise<StoryCardDto[]> {
  const { Story } = await getModels();
  const stories = await Story.find({ editorialState: 'saved' }).sort({ updatedAt: -1 }).limit(200).lean();
  return cards(stories);
}

function toSource(article: SourceArticleDoc): SourceDto {
  return {
    id: String(article._id),
    url: article.url,
    publisher: article.publisher,
    headline: article.originalHeadline,
    publishedAt: iso(article.publishedAt),
    retrievedAt: iso(article.retrievedAt),
    sourceQuality: article.sourceQuality ?? 'unknown',
    extractionStatus: article.extractionStatus ?? 'pending',
    origin: article.origin,
  };
}

export async function getStoryDetail(id: string): Promise<StoryDetailDto> {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Story not found.');
  const { Story, SourceArticle, AuthUser } = await getModels();
  const story = await Story.findById(id).lean();
  if (!story) throw new NotFoundError('Story not found.');

  const [articles, parent, developments] = await Promise.all([
    SourceArticle.find({ _id: { $in: story.sourceArticleIds } }).sort({ publishedAt: -1 }).lean(),
    story.parentStoryId ? Story.findById(story.parentStoryId, { headline: 1, editorialState: 1 }).lean() : null,
    Story.find({ parentStoryId: story._id }, { headline: 1, createdAt: 1 }).sort({ createdAt: -1 }).lean(),
  ]);
  const userIds = [...new Set((story.decisions ?? []).map((d) => d.userId))].filter((u) => Types.ObjectId.isValid(u));
  const users = await AuthUser.find({ _id: { $in: userIds } }, { name: 1, email: 1 }).lean();
  const names = new Map(users.map((u) => [String(u._id), u.name || u.email]));

  return {
    ...toCard(story, [...new Set(articles.map((a) => a.publisher))]),
    whatHappened: story.whatHappened ?? '',
    editorialTest: {
      canAnswer: story.editorialTest?.canAnswer ?? false,
      answer: story.editorialTest?.answer ?? '',
    },
    culturalConnections: story.culturalConnections ?? [],
    entities: story.entities ?? [],
    formatPotential: (story.formatPotential ?? []).map((f) => ({ format: f.format ?? '', rationale: f.rationale ?? '' })),
    verificationNeeds: story.verificationNeeds ?? [],
    peopleToApproach: (story.peopleToApproach ?? []).map((p) => ({
      name: p.name ?? '',
      role: p.role ?? '',
      basis: p.basis ?? '',
    })),
    visualOpportunities: story.visualOpportunities ?? [],
    dimensions: (story.score?.dimensions ?? []).map((d) => ({
      dimension: d.dimension as StoryDetailDto['dimensions'][number]['dimension'],
      score: d.score,
      rationale: d.rationale,
    })),
    gates: (story.gates?.results ?? []).map((g) => ({
      gate: g.gate,
      outcome: g.outcome as 'pass' | 'hold' | 'reject',
      reason: g.reason,
    })),
    sources: articles.map(toSource),
    parent: parent
      ? { id: String(parent._id), headline: parent.headline, editorialState: parent.editorialState ?? 'none' }
      : null,
    developments: developments.map((d) => ({
      id: String(d._id),
      headline: d.headline,
      createdAt: iso(d.createdAt as Date | undefined),
    })),
    decisions: (story.decisions ?? [])
      .map((d) => ({
        action: d.action,
        userName: names.get(d.userId) ?? 'Former user',
        reason: d.reason ?? null,
        at: iso(d.at) ?? '',
      }))
      .reverse(),
    recommendations: (story.recommendations ?? []).map((r) => ({
      runKey: r.runKey,
      rank: r.rank,
      score: r.score,
      isUpdate: r.isUpdate,
      at: iso(r.at) ?? '',
    })),
    evaluation: {
      status: story.evaluation?.status ?? 'pending',
      model: story.evaluation?.model ?? null,
      escalated: story.evaluation?.escalated ?? false,
      evaluatedAt: iso(story.evaluation?.evaluatedAt),
      error: story.evaluation?.error ?? null,
      runKey: story.evaluation?.runKey ?? null,
    },
  };
}

async function usageRows(match: Record<string, unknown>): Promise<UsageRowDto[]> {
  const { AiUsage } = await getModels();
  const rows = await AiUsage.aggregate<{
    _id: { provider: string; operation: string; model: string | null };
    calls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    units: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: { provider: '$provider', operation: '$operation', model: '$model' },
        calls: { $sum: 1 },
        errors: { $sum: { $cond: [{ $eq: ['$outcome', 'error'] }, 1, 0] } },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        reasoningTokens: { $sum: '$reasoningTokens' },
        units: { $sum: { $ifNull: ['$units', 0] } },
      },
    },
    { $sort: { '_id.provider': 1, '_id.operation': 1 } },
  ]);
  return rows.map((r) => ({
    provider: r._id.provider,
    operation: r._id.operation,
    model: r._id.model,
    calls: r.calls,
    errors: r.errors,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    reasoningTokens: r.reasoningTokens,
    units: r.units,
  }));
}

/** Raw provider usage over the last `days` days (all operations, including research and drafts). */
export async function usageSince(days: number, now: Date = new Date()): Promise<UsageRowDto[]> {
  return usageRows({ createdAt: { $gte: new Date(now.getTime() - days * 86_400_000) } });
}

export async function getRunDetail(runKey: string): Promise<RunDetailDto> {
  const { WorkflowRun, Story, Task } = await getModels();
  const run = await WorkflowRun.findOne({ runKey }).lean();
  if (!run) throw new NotFoundError('Run not found.');

  const outcomeIds = (run.outcomes ?? [])
    .map((o) => o.storyId)
    .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId);
  const [stories, failedTasks, usage] = await Promise.all([
    Story.find({ _id: { $in: outcomeIds } }, { headline: 1, score: 1 }).lean(),
    Task.find({ runKey, status: 'failed' }).sort({ updatedAt: -1 }).limit(50).lean(),
    usageRows({ runKey }),
  ]);
  const byId = new Map(stories.map((s) => [String(s._id), s]));

  return {
    ...toRunSummary(run),
    requestedBy: run.requestedBy ?? null,
    funnel: (run.funnel ?? null) as RunFunnel | null,
    deadlines: {
      soft: iso(run.deadlines?.soft),
      extension: iso(run.deadlines?.extension),
      hard: iso(run.deadlines?.hard),
    },
    candidateSetClosedAt: iso(run.candidateSetClosedAt),
    outcomes: (run.outcomes ?? []).map((o) => {
      const story = byId.get(String(o.storyId));
      return {
        storyId: String(o.storyId),
        headline: story?.headline ?? '(story removed)',
        outcome: o.outcome ?? 'unknown',
        detail: o.detail ?? '',
        score: story?.score?.total ?? null,
      };
    }),
    errors: (run.runErrors ?? []).map((e) => ({ stage: e.stage ?? '', message: e.message ?? '', at: iso(e.at) })),
    failedTasks: failedTasks.map((t) => ({
      key: t.key,
      kind: t.kind,
      attempts: t.attempts ?? 0,
      lastError: t.lastError ?? null,
      updatedAt: iso(t.updatedAt as Date | undefined),
    })),
    usage,
  };
}
