import { getModels } from '../../db/models.js';
import type { WorkflowRunDoc } from '../../db/models/workflow-run.js';
import { setRunStage } from '../runs.js';

type Stage = WorkflowRunDoc['stage'];

/**
 * Runs a stage once per run. Each stage persists its own results before reporting stats, so on
 * resume a completed stage is skipped and its recorded stats are reused.
 */
export async function runStage<T extends Record<string, unknown>>(
  runKey: string,
  owner: string,
  stage: Stage,
  work: () => Promise<T>,
): Promise<T> {
  const { WorkflowRun } = await getModels();
  const run = await WorkflowRun.findOne({ runKey }, { completedStages: 1, stageStats: 1 }).lean();
  const stats = (run?.stageStats ?? {}) as Record<string, T>;
  if (run?.completedStages?.includes(stage) && stats[stage]) return stats[stage];

  await setRunStage(runKey, owner, stage);
  const result = await work();
  await WorkflowRun.updateOne(
    { runKey },
    { $addToSet: { completedStages: stage }, $set: { [`stageStats.${stage}`]: result } },
  );
  return result;
}
