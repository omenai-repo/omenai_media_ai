/**
 * DEVELOPMENT FIXTURES ONLY. Runs background work in-process against a `*_fixtures` database,
 * with scripted model answers and a fake search, so the app can be used end to end without
 * Trigger.dev or any real AI or search service: research and draft tasks, a search for stories
 * started by hand, and the scripted model behind the chat stream. Each step is paced so progress is visible. Everything else (task and
 * run records, locks, persistence, citation checks, gates, scoring, ranking) is the real code.
 */
import { isFixtureRuntime } from '../../config/runtime.js';
import { getModels } from '../../db/models.js';
import { readDiscoveryConfig } from '../../discovery/config.js';
import { runDiscoveryInline } from '../../discovery/pipeline/run-inline.js';
import { runDraftGeneration } from '../../drafts/service.js';
import type { LlmClient } from '../../llm/client.js';
import { LlmError } from '../../llm/types.js';
import { databaseUsageRecorder } from '../../llm/usage.js';
import { runResearch } from '../../research/service.js';
import { failTask, startTaskAttempt } from '../../tasks/service.js';
import { createScriptedLlm, type ScriptedStreamOptions } from '../fake-llm.js';
import { ON_DEMAND_EDITION } from './catalog.js';
import { scriptedDraft } from './draft-script.js';
import {
  fixtureResearchSearch,
  researchResultsFor,
  scriptedChatReply,
  scriptedFocusedAnswer,
  scriptedResearchBrief,
} from './research-script.js';
import { createScenarioContext, recordSimulatedSearchUsage } from './seed.js';

const FIXTURES_ONLY =
  'The fixture executor only runs in the fixtures runtime (OMENAI_RUNTIME=fixtures, *_fixtures database).';

/** Delays each model call, so progress can be followed in the interface. */
function paced(llm: LlmClient, delayMs: number): LlmClient {
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  return {
    ...llm,
    generateObject: async (request) => {
      await pause();
      return llm.generateObject(request);
    },
    streamObject: async (request) => {
      await pause();
      return llm.streamObject(request);
    },
  };
}

/**
 * The scripted assistant for research, chat and drafts. `stream` paces streamed answers (the chat
 * in the fixtures runtime) so text can be watched arriving; tests leave it unpaced.
 */
export function createFixtureResearchLlm(
  options: { stream?: ScriptedStreamOptions } = {},
): LlmClient {
  return createScriptedLlm(
    {
      research: scriptedResearchBrief,
      focused: scriptedFocusedAnswer,
      chat: scriptedChatReply,
      draft: scriptedDraft,
    },
    { recordUsage: databaseUsageRecorder({ simulated: true }), stream: options.stream },
  ).llm;
}

/**
 * How the live model's chat answers arrived (Gemini 3.5 Flash-Lite, 2026-10-16 evaluation):
 * a wait of 3–9 s, then the whole answer within about half a second, in a few large pieces. The
 * fixture chat streams the same way (with a shorter wait), so the interface is tried against
 * real bursts rather than an evenly paced trickle.
 */
export const LIVE_LIKE_CHAT_STREAM: ScriptedStreamOptions = {
  firstChunkDelayMs: 2_500,
  chunkChars: 90,
  chunkDelayMs: 80,
};
/** Draft text in the fixtures runtime: steady pieces, so the studio's preview can be watched. */
const FIXTURE_DRAFT_STREAM: ScriptedStreamOptions = {
  firstChunkDelayMs: 1_500,
  chunkChars: 48,
  chunkDelayMs: 60,
};

/** The scripted assistant behind the chat stream in the fixtures runtime. */
export function createFixtureChatLlm(): LlmClient {
  if (!isFixtureRuntime()) throw new Error(FIXTURES_ONLY);
  return createFixtureResearchLlm({ stream: LIVE_LIKE_CHAT_STREAM });
}

/** An editor's note that makes the scripted writer's first attempt fail (development fixtures). */
export const FIXTURE_FAIL_FIRST_ATTEMPT = '[fixture: fail the first attempt]';

/**
 * The scripted writer for a draft task run by a real (development) Trigger.dev worker against a
 * fixtures database, so the engine's queueing, attempts, retries and persistence can be watched
 * without any AI call. A note containing FIXTURE_FAIL_FIRST_ATTEMPT makes attempt 1 fail with a
 * transient outage, so the engine's own retry runs.
 */
export async function createFixtureWorkerLlm(input: {
  taskKey: string;
  attempt: number;
}): Promise<LlmClient> {
  if (!isFixtureRuntime()) throw new Error(FIXTURES_ONLY);
  const llm = createFixtureResearchLlm({ stream: FIXTURE_DRAFT_STREAM });
  const { Task } = await getModels();
  const task = await Task.findOne({ key: input.taskKey }, { instructions: 1 }).lean();
  if (input.attempt !== 1 || !task?.instructions?.includes(FIXTURE_FAIL_FIRST_ATTEMPT)) return llm;
  const outage = () =>
    Promise.reject(
      new LlmError(
        'unavailable',
        'Scripted outage on the first attempt (development fixture)',
        'gemini',
        { status: 503 },
      ),
    );
  return { ...llm, generateObject: outage, streamObject: outage };
}

export async function runFixtureStoryTask(
  taskKey: string,
  options: { stepDelayMs?: number } = {},
): Promise<void> {
  if (!isFixtureRuntime()) throw new Error(FIXTURES_ONLY);
  const { Task, Story, AiUsage } = await getModels();
  const task = await Task.findOne({ key: taskKey }).lean();
  if (!task?.storyId) return;
  const story = await Story.findById(task.storyId).lean();
  if (!story) return;

  const delay = options.stepDelayMs ?? 1_500;
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, delay));
  const llm = paced(createFixtureResearchLlm({ stream: FIXTURE_DRAFT_STREAM }), delay);
  const search = fixtureResearchSearch(researchResultsFor(story), async (kind) => {
    await pause();
    await AiUsage.create({
      provider: 'tavily',
      kind,
      operation: `research.${kind}`,
      units: 1,
      outcome: 'ok',
      taskId: taskKey,
      storyId: String(story._id),
      simulated: true,
    });
  });
  const deps = { llm, search, now: () => new Date() };

  await startTaskAttempt(taskKey, (task.attempts ?? 0) + 1);
  try {
    if (task.kind === 'generate') await runDraftGeneration({ taskKey, deps });
    else await runResearch({ taskKey, deps });
  } catch (error) {
    await failTask(taskKey, error instanceof Error ? error.message : String(error), true);
  }
}

/**
 * A search for stories started by hand ("Find today’s stories"), run through the real pipeline
 * with the on-demand fixture articles. The run record was already created by the request.
 */
export async function runFixtureDiscovery(
  runKey: string,
  options: { stepDelayMs?: number } = {},
): Promise<void> {
  if (!isFixtureRuntime()) throw new Error(FIXTURES_ONLY);
  const context = createScenarioContext();
  context.load(ON_DEMAND_EDITION, new Date());
  await runDiscoveryInline({
    runKey,
    trigger: 'manual',
    owner: 'fixture-executor',
    deps: {
      llm: paced(context.llm, options.stepDelayMs ?? 1_500),
      search: context.search,
      config: { ...readDiscoveryConfig({}), maxQueries: 2, maxRevisits: 0 },
      now: () => new Date(),
    },
  });
  await recordSimulatedSearchUsage(ON_DEMAND_EDITION, runKey);
}
