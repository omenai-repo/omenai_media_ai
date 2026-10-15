import { chicagoDateKey } from '@repo/shared';

import { LlmError } from '../../llm/types.js';
import { claimRun, failRun, startRun, type RunTrigger } from '../runs.js';
import type { DiscoveryDeps } from './context.js';
import { evaluateStory, markEvaluationFailed } from './evaluate.js';
import { finalizeRun, type FinalizeResult } from './finalize.js';
import { prepareRun } from './prepare.js';

/**
 * Runs a whole discovery run in one process, evaluating candidates one after another. The
 * background worker uses the same stage functions but evaluates in parallel child tasks with
 * retries and deadlines; this runner exists for tests and local diagnostics.
 */
export async function runDiscoveryInline(input: {
  runKey: string;
  trigger: RunTrigger;
  owner: string;
  deps: DiscoveryDeps;
}): Promise<FinalizeResult | null> {
  const { runKey, owner, deps } = input;
  await startRun({ runKey, trigger: input.trigger });
  const now = deps.now();
  const run = await claimRun({
    runKey,
    owner,
    now,
    config: {
      leaseMs: deps.config.leaseMinutes * 60_000,
      softDeadlineMinutes: deps.config.softDeadlineMinutes,
      extensionDeadlineMinutes: deps.config.extensionDeadlineMinutes,
      hardDeadlineMinutes: deps.config.hardDeadlineMinutes,
    },
  });
  if (!run) return null;

  try {
    const queryDate = runKey.startsWith('daily-discovery:')
      ? runKey.slice('daily-discovery:'.length)
      : chicagoDateKey(now);
    const { candidateStoryIds } = await prepareRun({ runKey, owner, queryDate, deps });
    for (const storyId of candidateStoryIds) {
      try {
        await evaluateStory({ runKey, storyId, deps });
      } catch (error) {
        // One candidate failing never stops the others.
        const message =
          error instanceof LlmError ? `${error.kind}: ${error.message}` : String(error);
        await markEvaluationFailed(runKey, storyId, message);
      }
    }
    return await finalizeRun({ runKey, owner, deps });
  } catch (error) {
    await failRun({ runKey, owner, stage: 'pipeline', message: String(error) });
    throw error;
  }
}
