import type { Types } from 'mongoose';

import { getModels } from '../../db/models.js';
import type { SourceArticleDoc } from '../../db/models/source-article.js';
import type { StoryDoc } from '../../db/models/story.js';
import { LlmError } from '../../llm/types.js';
import { titleSimilarity } from '../normalize.js';
import { CLUSTER_SYSTEM_PROMPT } from '../prompts.js';
import { recordRunError } from '../runs.js';
import { clusterOutputSchema, type ClusterOutput } from '../schemas.js';
import type { DiscoveryDeps } from './context.js';

export interface ClusterStats extends Record<string, unknown> {
  items: number;
  overCap: number;
  groups: number;
  newStories: number;
  newDevelopments: number;
  updates: number;
  suppressed: number;
  carriedOver: number;
  aiCalls: number;
  fallback: boolean;
  /** Stories whose development repeated with nothing new, or that an editor skipped. */
  suppressedStoryIds: string[];
}

type Relation = ClusterOutput['groups'][number]['relation'];
interface Group {
  items: number[];
  relation: Relation;
  related: number | null;
  signature: string;
}

const DAY_MS = 86_400_000;
/** Titles this similar are the same report syndicated; they are always grouped together. */
const SYNDICATED_TITLE_SIMILARITY = 0.75;

function preGroups(articles: readonly SourceArticleDoc[]): number[] {
  const parent = articles.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < articles.length; i += 1) {
    for (let j = i + 1; j < articles.length; j += 1) {
      if (
        titleSimilarity(articles[i]!.originalHeadline, articles[j]!.originalHeadline) >=
        SYNDICATED_TITLE_SIMILARITY
      ) {
        parent[find(j)] = find(i);
      }
    }
  }
  return articles.map((_, i) => find(i));
}

function date(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : 'undated';
}

export function clusterPrompt(
  articles: readonly SourceArticleDoc[],
  stories: readonly StoryDoc[],
): string {
  const articleLines = articles.map((a, i) => {
    const t = a.triage;
    return (
      `A${i + 1} | ${a.publisher} | ${date(a.publishedAt)} | ${a.originalHeadline}\n` +
      `   event: ${t?.eventSummary ?? 'n/a'} | event date: ${t?.eventDate ?? 'n/a'} | entities: ${(t?.entities ?? []).join(', ') || 'n/a'} | places: ${(t?.places ?? []).join(', ') || 'n/a'}`
    );
  });
  const storyLines = stories.map(
    (s, i) =>
      `S${i + 1} | ${date(s.createdAt as Date | undefined)} | ${s.headline} | ${s.developmentSignature || 'n/a'}${s.editorialState === 'skipped' ? ' | skipped by an editor' : ''}`,
  );
  return `NEW ARTICLES:\n${articleLines.join('\n')}\n\nTRACKED STORIES:\n${storyLines.length ? storyLines.join('\n') : '(none)'}`;
}

/**
 * Turns model output into a valid partition of the articles: each article in exactly one group,
 * story references that exist, and syndicated duplicates kept together. Anything the model got
 * wrong degrades to a conservative "new" group instead of failing the run.
 */
export function normalizeGroups(
  output: ClusterOutput | null,
  articleCount: number,
  storyCount: number,
  syndication: readonly number[],
): Group[] {
  const owner = new Array<number>(articleCount).fill(-1);
  const groups: Group[] = [];
  for (const raw of output?.groups ?? []) {
    const items = raw.items
      .map((ref) => Number(ref.slice(1)) - 1)
      .filter((i) => i >= 0 && i < articleCount && owner[i] === -1);
    if (items.length === 0) continue;
    const related = raw.relatedStory ? Number(raw.relatedStory.slice(1)) - 1 : null;
    const validRelated = related !== null && related >= 0 && related < storyCount ? related : null;
    const relation: Relation =
      raw.relation !== 'new' && validRelated === null ? 'new' : raw.relation;
    for (const i of items) owner[i] = groups.length;
    groups.push({
      items,
      relation,
      related: relation === 'new' ? null : validRelated,
      signature: raw.signature,
    });
  }
  for (let i = 0; i < articleCount; i += 1) {
    if (owner[i] === -1) {
      owner[i] = groups.length;
      groups.push({ items: [i], relation: 'new', related: null, signature: '' });
    }
  }

  // Merge groups that split a syndicated report.
  const target = groups.map((_, g) => g);
  const root = (g: number): number => (target[g] === g ? g : (target[g] = root(target[g]!)));
  const firstOfSyndicate = new Map<number, number>();
  for (let i = 0; i < articleCount; i += 1) {
    const syndicate = syndication[i]!;
    const seen = firstOfSyndicate.get(syndicate);
    if (seen === undefined) firstOfSyndicate.set(syndicate, owner[i]!);
    else if (root(seen) !== root(owner[i]!)) target[root(owner[i]!)] = root(seen);
  }
  const merged = new Map<number, Group>();
  groups.forEach((group, g) => {
    const into = root(g);
    const existing = merged.get(into);
    if (!existing) merged.set(into, { ...group, items: [...group.items] });
    else {
      existing.items.push(...group.items);
      if (existing.relation === 'new' && group.relation !== 'new') {
        existing.relation = group.relation;
        existing.related = group.related;
      }
    }
  });
  return [...merged.values()];
}

export async function clusterStage(runKey: string, deps: DiscoveryDeps): Promise<ClusterStats> {
  const { SourceArticle, Story } = await getModels();
  const { config } = deps;
  const now = deps.now();
  const stats: ClusterStats = {
    items: 0,
    overCap: 0,
    groups: 0,
    newStories: 0,
    newDevelopments: 0,
    updates: 0,
    suppressed: 0,
    carriedOver: 0,
    aiCalls: 0,
    fallback: false,
    suppressedStoryIds: [],
  };

  // On resume, articles already placed in a story created by this run are not clustered again.
  const runStories = await Story.find({ firstSeenRunKey: runKey }, { sourceArticleIds: 1 }).lean();
  const attached = runStories.flatMap((s) => s.sourceArticleIds);
  const inScope = await SourceArticle.find({
    firstRunKey: runKey,
    'triage.inScope': true,
    _id: { $nin: attached },
  })
    .sort({ searchScore: -1 })
    .lean();
  const articles = inScope.slice(0, config.clusterMaxItems);
  stats.items = articles.length;
  stats.overCap = inScope.length - articles.length;

  if (articles.length > 0) {
    const recent = await Story.find({
      createdAt: { $gte: new Date(now.getTime() - config.recentStoryWindowDays * DAY_MS) },
      firstSeenRunKey: { $ne: runKey },
    })
      .sort({ createdAt: -1 })
      .limit(config.recentStoryMax)
      .lean();

    let output: ClusterOutput | null = null;
    if (articles.length > 1 || recent.length > 0) {
      stats.aiCalls += 1;
      try {
        const response = await deps.llm.generateObject({
          operation: 'discovery.cluster',
          tier: 'primary',
          system: CLUSTER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: clusterPrompt(articles, recent) }],
          maxOutputTokens: 150 * articles.length + 300,
          schema: clusterOutputSchema,
          context: { runKey },
        });
        output = response.data;
      } catch (error) {
        if (error instanceof LlmError && error.retryable) throw error;
        stats.fallback = true;
        await recordRunError(
          runKey,
          'cluster',
          `Clustering fell back to one story per article: ${String(error)}`,
        );
      }
    }

    const groups = normalizeGroups(output, articles.length, recent.length, preGroups(articles));
    stats.groups = groups.length;

    for (const group of groups) {
      const members = group.items.map((i) => articles[i]!);
      const memberIds = members.map((a) => a._id);
      const related = group.related === null ? null : recent[group.related]!;
      let storyId: Types.ObjectId;

      if (group.relation === 'new' || group.relation === 'new_development' || !related) {
        const lead = members[0]!;
        const story = await Story.create({
          headline: lead.originalHeadline,
          sourceArticleIds: memberIds,
          relation: related ? group.relation : 'new',
          parentStoryId: related?._id ?? null,
          relatedStoryIds: related ? [related._id] : [],
          developmentSignature: group.signature,
          firstSeenRunKey: runKey,
          lastCandidateRunKey: runKey,
        });
        storyId = story._id;
        if (related) stats.newDevelopments += 1;
        else stats.newStories += 1;
      } else {
        storyId = related._id;
        const suppressed =
          group.relation === 'same_development_no_new_info' || related.editorialState === 'skipped';
        await Story.updateOne(
          { _id: related._id },
          suppressed
            ? { $addToSet: { sourceArticleIds: { $each: memberIds } } }
            : {
                $addToSet: { sourceArticleIds: { $each: memberIds } },
                $set: {
                  lastCandidateRunKey: runKey,
                  relation: 'same_development_new_info',
                  'evaluation.status': 'pending',
                },
              },
        );
        if (suppressed) {
          stats.suppressed += 1;
          stats.suppressedStoryIds.push(String(related._id));
        } else {
          stats.updates += 1;
        }
      }
      await SourceArticle.updateMany(
        { _id: { $in: memberIds } },
        { $addToSet: { storyIds: storyId } },
      );
    }
  }

  // Fresh stories from earlier runs that didn't get a decision there join this run: those never
  // evaluated (over the cap) are evaluated now; those evaluated after the set closed are
  // reclassified at finalize from their stored evaluation, without another model call.
  const freshSince = new Date(now.getTime() - config.freshnessDays * DAY_MS);
  const carried = await Story.updateMany(
    {
      lastCandidateRunKey: { $ne: runKey },
      editorialState: { $ne: 'skipped' },
      $or: [
        { 'evaluation.status': 'pending', updatedAt: { $gte: freshSince } },
        {
          'evaluation.status': 'evaluated',
          'evaluation.outcome': 'deferred_late',
          'evaluation.evaluatedAt': { $gte: freshSince },
        },
      ],
    },
    { $set: { lastCandidateRunKey: runKey } },
  );
  stats.carriedOver = carried.modifiedCount;
  return stats;
}
