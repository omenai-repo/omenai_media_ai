import { getModels } from '../../db/models.js';
import { assertSearchBudget } from '../../ops/budget.js';
import { worstCaseRunCredits } from '../budget.js';
import { fairOrder } from '../intake.js';
import { setRunStage } from '../runs.js';
import { clusterStage } from './cluster.js';
import type { DiscoveryDeps } from './context.js';
import { discoverStage } from './discover.js';
import { extractStage } from './extract.js';
import { revisitStage } from './revisit.js';
import { runStage } from './stage.js';
import { triageStage } from './triage.js';

/** The settings a run used, stored once on its record (§10 audit trail). */
async function recordRunConfig(runKey: string, deps: DiscoveryDeps): Promise<void> {
  const { WorkflowRun } = await getModels();
  const { config } = deps;
  await WorkflowRun.updateOne(
    { runKey, config: null },
    {
      $set: {
        config: {
          shortlistThreshold: config.shortlistThreshold,
          priorityThreshold: config.priorityThreshold,
          shortlistMax: config.shortlistMax,
          maxQueries: config.maxQueries,
          resultsPerQuery: config.resultsPerQuery,
          searchTimeRange: config.searchTimeRange,
          languages: config.languages,
          maxExtract: config.maxExtract,
          clusterMaxItems: config.clusterMaxItems,
          maxEvaluations: config.maxEvaluations,
          maxEscalations: config.maxEscalations,
          freshnessDays: config.freshnessDays,
          models: {
            triage: deps.llm.modelFor('triage'),
            primary: deps.llm.modelFor('primary'),
            escalation: deps.llm.modelFor('escalation'),
          },
        },
      },
    },
  );
}

/**
 * Everything before evaluation: discover → revisit → extract → triage → cluster. Each stage is
 * skipped on resume once complete. Returns the stories to evaluate in this run, capped at
 * `maxEvaluations`; candidates over the cap stay pending and carry over to the next run.
 */
export async function prepareRun(input: {
  runKey: string;
  owner: string;
  queryDate: string;
  deps: DiscoveryDeps;
}): Promise<{ candidateStoryIds: string[]; overCap: number }> {
  const { runKey, owner, deps } = input;
  await recordRunConfig(runKey, deps);
  // Before the first search: a run that can't fit in what's left of the daily search-credit limit
  // stops now, having spent nothing, instead of failing part-way (ADR-042). A resumed run whose
  // search is done is not checked again.
  const { WorkflowRun } = await getModels();
  const record = await WorkflowRun.findOne({ runKey }, { completedStages: 1 }).lean();
  if (!record?.completedStages?.includes('discover'))
    await assertSearchBudget(worstCaseRunCredits(deps.config), deps.now());
  await runStage(runKey, owner, 'discover', () => discoverStage(runKey, input.queryDate, deps));
  await runStage(runKey, owner, 'revisit', () => revisitStage(runKey, deps));
  await runStage(runKey, owner, 'extract', () => extractStage(runKey, deps));
  await runStage(runKey, owner, 'triage', () => triageStage(runKey, deps));
  await runStage(runKey, owner, 'cluster', () => clusterStage(runKey, deps));

  const { Story, SourceArticle } = await getModels();
  const pending = await Story.find(
    { lastCandidateRunKey: runKey, 'evaluation.status': 'pending' },
    { _id: 1, sourceArticleIds: 1, createdAt: 1, firstSeenRunKey: 1 },
  ).lean();
  // Each story's lane is its lead article's originating query (ADR-042).
  const leads = await SourceArticle.find(
    { _id: { $in: pending.flatMap((s) => s.sourceArticleIds.slice(0, 1)) } },
    { searchQuery: 1, searchTier: 1, searchScore: 1 },
  ).lean();
  const leadById = new Map(leads.map((a) => [String(a._id), a]));
  // Oldest batch first, so carry-overs can't be overtaken indefinitely; then the queries take
  // turns. The number of articles is not used: wide coverage is not importance.
  const ordered = fairOrder(
    pending.map((story) => {
      const lead = leadById.get(String(story.sourceArticleIds[0]));
      return {
        batch: story.firstSeenRunKey,
        foundAt: new Date(story.createdAt),
        lane: lead?.searchQuery ?? null,
        laneTier: lead?.searchTier ?? null,
        score: lead?.searchScore ?? 0,
        id: String(story._id),
        storyId: story._id,
      };
    }),
  );
  const selected = ordered.slice(0, deps.config.maxEvaluations).map((s) => s.storyId);
  await setRunStage(runKey, owner, 'evaluate', { candidateStoryIds: selected });
  return { candidateStoryIds: selected.map(String), overCap: ordered.length - selected.length };
}
