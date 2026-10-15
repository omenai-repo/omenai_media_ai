import { getModels } from '../../db/models.js';
import { canonicalizeUrl, contentHash, textSimilarity } from '../normalize.js';
import { CHANGE_SYSTEM_PROMPT } from '../prompts.js';
import { changeOutputSchema } from '../schemas.js';
import type { DiscoveryDeps } from './context.js';

export interface RevisitStats extends Record<string, unknown> {
  revisited: number;
  unchanged: number;
  cosmetic: number;
  updatedReporting: number;
  newDevelopments: number;
  failed: number;
  aiCalls: number;
}

const COMPARE_CHARS = 3_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Re-checks a bounded set of known articles: those reappearing in today's search, and those
 * behind recently relevant stories (recommended, saved or scoring at least the threshold).
 * Each article is checked at most once per interval. Only a material text change costs a model
 * call; the outcome either refreshes the story (updated reporting) or opens a linked new story.
 */
export async function revisitStage(runKey: string, deps: DiscoveryDeps): Promise<RevisitStats> {
  const { SourceArticle, Story } = await getModels();
  const { config } = deps;
  const now = deps.now();
  const stats: RevisitStats = {
    revisited: 0,
    unchanged: 0,
    cosmetic: 0,
    updatedReporting: 0,
    newDevelopments: 0,
    failed: 0,
    aiCalls: 0,
  };
  if (config.maxRevisits === 0) return stats;

  const relevantStories = await Story.find(
    {
      updatedAt: { $gte: new Date(now.getTime() - config.revisitWindowDays * DAY_MS) },
      $or: [
        { 'recommendations.0': { $exists: true } },
        { editorialState: 'saved' },
        { 'score.total': { $gte: config.shortlistThreshold } },
      ],
    },
    { sourceArticleIds: 1 },
  ).lean();
  const relevantArticleIds = relevantStories.flatMap((s) => s.sourceArticleIds);
  const dueBefore = new Date(now.getTime() - config.revisitIntervalHours * HOUR_MS);

  const eligible = await SourceArticle.find({
    extractionStatus: 'extracted',
    firstRunKey: { $ne: runKey },
    $and: [
      { $or: [{ lastSeenRunKey: runKey }, { _id: { $in: relevantArticleIds } }] },
      { $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: dueBefore } }] },
    ],
  })
    .sort({ lastCheckedAt: 1 })
    .limit(config.maxRevisits)
    .lean();
  if (eligible.length === 0) return stats;

  const { pages, failed } = await deps.search.extract(
    eligible.map((a) => a.url),
    { runKey },
  );
  stats.failed = failed.length;
  const byCanonical = new Map(eligible.map((a) => [a.canonicalUrl, a]));

  for (const page of pages) {
    const canonical = canonicalizeUrl(page.url);
    const article = canonical ? byCanonical.get(canonical) : undefined;
    if (!article) continue;
    stats.revisited += 1;
    const content = page.content.slice(0, config.storedContentChars);
    const hash = contentHash(content);
    const revisionBase = {
      checkedAt: now,
      contentHash: hash,
      headline: page.title ?? article.originalHeadline,
    };

    if (hash === article.contentHash) {
      stats.unchanged += 1;
      await SourceArticle.updateOne(
        { _id: article._id },
        {
          $set: { lastCheckedAt: now },
          $push: {
            revisions: { $each: [{ ...revisionBase, changeKind: 'unchanged' }], $slice: -20 },
          },
        },
      );
      continue;
    }

    let changeKind: 'cosmetic' | 'updated_reporting' | 'new_development' = 'cosmetic';
    let changeSummary: string | null = null;
    if (textSimilarity(article.content, content) < config.cosmeticSimilarity) {
      stats.aiCalls += 1;
      const result = await deps.llm.generateObject({
        operation: 'discovery.revisit',
        tier: 'triage',
        system: CHANGE_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Article: ${article.originalHeadline} (${article.publisher})\n\nPREVIOUS TEXT:\n${article.content.slice(0, COMPARE_CHARS)}\n\nCURRENT TEXT:\n${content.slice(0, COMPARE_CHARS)}`,
          },
        ],
        maxOutputTokens: 300,
        schema: changeOutputSchema,
        context: { runKey },
      });
      changeKind = result.data.changeKind;
      changeSummary = result.data.summary;
    }

    await SourceArticle.updateOne(
      { _id: article._id },
      {
        $set: { content, contentHash: hash, lastCheckedAt: now },
        $push: {
          revisions: { $each: [{ ...revisionBase, changeKind, changeSummary }], $slice: -20 },
        },
      },
    );

    if (changeKind === 'cosmetic') {
      stats.cosmetic += 1;
    } else if (changeKind === 'updated_reporting') {
      stats.updatedReporting += 1;
      // Re-evaluate the stories this article supports, as updates of the same development.
      await Story.updateMany(
        { _id: { $in: article.storyIds }, editorialState: { $ne: 'skipped' } },
        {
          $set: {
            lastCandidateRunKey: runKey,
            relation: 'same_development_new_info',
            'evaluation.status': 'pending',
          },
        },
      );
    } else {
      stats.newDevelopments += 1;
      const parentId = article.storyIds[0] ?? null;
      const story = await Story.create({
        headline: page.title ?? article.originalHeadline,
        sourceArticleIds: [article._id],
        relation: 'new_development',
        parentStoryId: parentId,
        relatedStoryIds: parentId ? [parentId] : [],
        developmentSignature: changeSummary ?? '',
        firstSeenRunKey: runKey,
        lastCandidateRunKey: runKey,
      });
      await SourceArticle.updateOne({ _id: article._id }, { $addToSet: { storyIds: story._id } });
    }
  }
  return stats;
}
