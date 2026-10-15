import { getModels } from '../../db/models.js';
import { setRunStage } from '../runs.js';
import { clusterStage } from './cluster.js';
import type { DiscoveryDeps } from './context.js';
import { discoverStage } from './discover.js';
import { extractStage } from './extract.js';
import { revisitStage } from './revisit.js';
import { runStage } from './stage.js';
import { triageStage } from './triage.js';

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
  await runStage(runKey, owner, 'discover', () => discoverStage(runKey, input.queryDate, deps));
  await runStage(runKey, owner, 'revisit', () => revisitStage(runKey, deps));
  await runStage(runKey, owner, 'extract', () => extractStage(runKey, deps));
  await runStage(runKey, owner, 'triage', () => triageStage(runKey, deps));
  await runStage(runKey, owner, 'cluster', () => clusterStage(runKey, deps));

  const { Story } = await getModels();
  const pending = await Story.find(
    { lastCandidateRunKey: runKey, 'evaluation.status': 'pending' },
    { _id: 1, sourceArticleIds: 1, createdAt: 1 },
  ).lean();
  // More independent coverage first, then older candidates so carry-overs don't starve.
  const ordered = pending.toSorted(
    (a, b) =>
      b.sourceArticleIds.length - a.sourceArticleIds.length ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const selected = ordered.slice(0, deps.config.maxEvaluations).map((s) => s._id);
  await setRunStage(runKey, owner, 'evaluate', { candidateStoryIds: selected });
  return { candidateStoryIds: selected.map(String), overCap: ordered.length - selected.length };
}
