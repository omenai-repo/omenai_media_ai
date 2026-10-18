import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The real `generate-draft` task definition, run with a simulated Trigger.dev context: the SDK's
 * `task()` is reduced to its config so `run` can be called per attempt, the way the engine calls
 * it. The model is scripted (development fixtures); nothing reaches an AI provider.
 */
class AbortTaskRunError extends Error {}
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  AbortTaskRunError,
}));

const providerModel = vi.fn<() => unknown>();
vi.mock('@repo/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/core')>()),
  getLlmClient: (): unknown => providerModel(),
}));

const core = await import('@repo/core');
const fixtures = await import('@repo/core/fixtures');
const { seedFixtureNewsroom, startTestDatabase } = await import('@repo/core/testing');
const { generateDraft } = (await import('./drafts.js')) as unknown as {
  generateDraft: {
    retry: { maxAttempts: number };
    run: (payload: unknown, options: { ctx: unknown }) => Promise<{ version: number }>;
  };
};

type Llm = Awaited<ReturnType<typeof core.getLlmClient>>;
/** The in-memory test database's name, which every payload names. */
const DB = 'omenai_test';
const ctx = (attempt: number, environment = 'DEVELOPMENT') => ({
  ctx: {
    attempt: { number: attempt },
    run: { id: `run_${attempt}` },
    environment: { type: environment },
  },
});

/** The scripted writer (drafts are streamed), failing with a provider outage while `outages` lasts. */
function scripted(options: { outages?: number } = {}): Llm {
  const llm = fixtures.createFixtureResearchLlm();
  let outages = options.outages ?? 0;
  return {
    ...llm,
    streamObject: async (request) => {
      if (outages > 0) {
        outages -= 1;
        throw new core.LlmError('unavailable', 'scripted outage', 'gemini', { status: 503 });
      }
      return llm.streamObject(request);
    },
  };
}

let db: Awaited<ReturnType<typeof startTestDatabase>>;
let storyId: string;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  providerModel.mockReset();
  await seedFixtureNewsroom();
  const { Story } = await core.getModels();
  const story = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
  storyId = String(story._id);
  const { taskKey } = await core.requestResearch({
    storyId,
    userId: 'editor-1',
    depth: 'standard',
  });
  await core.runResearch({
    taskKey,
    deps: {
      llm: fixtures.createFixtureResearchLlm(),
      search: fixtures.fixtureResearchSearch(fixtures.researchResultsFor(story)),
      now: () => new Date(),
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const request = (format = 'newsletter_item', instructions?: string) =>
  core.requestDraft({ storyId, userId: 'editor-1', format, instructions });

describe('generate-draft task (simulated Trigger.dev attempts, scripted model)', () => {
  it('uses the shared retry limit and records the run, its progress and one version', async () => {
    expect(generateDraft.retry.maxAttempts).toBe(core.TASK_MAX_ATTEMPTS.generate);
    const { Task, DraftVersion } = await core.getModels();
    const { taskKey } = await request();
    providerModel.mockReturnValue(scripted());

    expect(await generateDraft.run({ taskKey, database: DB }, ctx(1))).toMatchObject({
      version: 1,
    });
    const task = (await Task.findOne({ key: taskKey }).lean())!;
    expect(task).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      triggerRunId: 'run_1',
      lastError: null,
      progress: { step: 'save', notice: null },
    });
    // Every step it took is on record, in order, and the preview went with the task.
    expect(task.progress?.steps?.map((s) => s.step)).toEqual([
      'research',
      'write',
      'statements',
      'check',
      'save',
    ]);
    expect(task.progress?.preview).toBeUndefined();
    expect(task.activeLock).toBeUndefined();
    expect(await DraftVersion.countDocuments({ taskId: taskKey })).toBe(1);
  });

  it('retries an outage without losing the lock, then writes exactly one version, never over an edit', async () => {
    const { Task, DraftVersion } = await core.getModels();
    providerModel.mockReturnValue(scripted());
    const first = await request();
    await generateDraft.run({ taskKey: first.taskKey, database: DB }, ctx(1));

    const { taskKey } = await request();
    providerModel.mockReturnValue(scripted({ outages: 1 }));
    // Attempt 1: a transient failure is rethrown for the engine to retry (not aborted).
    const attempt1 = generateDraft.run({ taskKey, database: DB }, ctx(1));
    await expect(attempt1).rejects.toBeInstanceOf(core.LlmError);
    await expect(attempt1).rejects.not.toBeInstanceOf(AbortTaskRunError);
    let task = (await Task.findOne({ key: taskKey }).lean())!;
    expect(task).toMatchObject({ status: 'queued', attempts: 1 });
    expect(task.activeLock).toBe(`draft:${storyId}:newsletter_item`);
    const retrying = (await core.getOperationsOverview()).attention.find(
      (a) => a.kind === 'task_retrying',
    );
    expect(retrying).toMatchObject({ automatic: true, attempts: { made: 1, limit: 3 } });

    // Meanwhile an editor saves an edit: it takes version 2.
    expect(
      await core.saveDraftEdit({
        storyId,
        userId: 'editor-2',
        format: 'newsletter_item',
        baseVersion: 1,
        title: 'Edited',
        body: 'An editor’s own words.',
      }),
    ).toMatchObject({ version: 2, changed: true });

    // Attempt 2 succeeds and takes the next number; a replayed attempt writes nothing new.
    expect(await generateDraft.run({ taskKey, database: DB }, ctx(2))).toMatchObject({
      version: 3,
    });
    expect(await generateDraft.run({ taskKey, database: DB }, ctx(3))).toMatchObject({
      version: 3,
    });
    task = (await Task.findOne({ key: taskKey }).lean())!;
    expect(task).toMatchObject({ status: 'succeeded', attempts: 3, lastError: null });
    const versions = await DraftVersion.find({ storyId: task.storyId }).sort({ version: 1 }).lean();
    expect(versions.map((v) => [v.version, v.origin, v.taskId ?? null])).toEqual([
      [1, 'generated', first.taskKey],
      [2, 'edited', null],
      [3, 'generated', taskKey],
    ]);
    expect(versions[1]!.body).toBe('An editor’s own words.');
  });

  it('gives up after the last attempt, releases the lock and lets the editor ask again', async () => {
    const { Task } = await core.getModels();
    const { taskKey } = await request('x_post');
    providerModel.mockReturnValue(scripted({ outages: 3 }));
    await expect(generateDraft.run({ taskKey, database: DB }, ctx(1))).rejects.toBeInstanceOf(
      core.LlmError,
    );
    await expect(generateDraft.run({ taskKey, database: DB }, ctx(2))).rejects.toBeInstanceOf(
      core.LlmError,
    );
    await expect(generateDraft.run({ taskKey, database: DB }, ctx(3))).rejects.toBeInstanceOf(
      AbortTaskRunError,
    );
    const task = (await Task.findOne({ key: taskKey }).lean())!;
    expect(task).toMatchObject({ status: 'failed', attempts: 3 });
    expect(task.activeLock).toBeUndefined();
    expect((await core.getDraftsView(storyId)).formats.x_post.lastFailure?.key).toBe(taskKey);
    await expect(request('x_post')).resolves.toHaveProperty('taskKey');
  });

  it('stops at once on a permanent error or a malformed payload', async () => {
    const { Task } = await core.getModels();
    const { taskKey } = await request('linkedin_post');
    providerModel.mockImplementation(() => {
      throw new core.ConfigError('GEMINI_API_KEY');
    });
    await expect(generateDraft.run({ taskKey, database: DB }, ctx(1))).rejects.toBeInstanceOf(
      AbortTaskRunError,
    );
    expect(await Task.findOne({ key: taskKey }).lean()).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    await expect(
      generateDraft.run({ taskKey: 'not-a-key', database: DB }, ctx(1)),
    ).rejects.toBeInstanceOf(AbortTaskRunError);
  });

  it('uses the scripted writer only in the fixtures runtime, never in production', async () => {
    const { Task } = await core.getModels();
    vi.stubEnv('OMENAI_RUNTIME', 'fixtures');
    vi.stubEnv('MONGODB_DB_NAME', 'omenai_fixtures');
    const dev = await request('instagram_caption', fixtures.FIXTURE_FAIL_FIRST_ATTEMPT);
    // The note makes the scripted writer's first attempt fail, so the engine's retry can be seen.
    await expect(
      generateDraft.run({ taskKey: dev.taskKey, database: DB }, ctx(1)),
    ).rejects.toBeInstanceOf(core.LlmError);
    expect(await generateDraft.run({ taskKey: dev.taskKey, database: DB }, ctx(2))).toMatchObject({
      version: 1,
    });
    expect(providerModel).not.toHaveBeenCalled();

    // A fixtures worker running in production is refused before it touches anything.
    const prod = await request('x_post');
    await expect(
      generateDraft.run({ taskKey: prod.taskKey, database: DB }, ctx(1, 'PRODUCTION')),
    ).rejects.toBeInstanceOf(AbortTaskRunError);
    expect(providerModel).not.toHaveBeenCalled();
    expect(await Task.findOne({ key: prod.taskKey }).lean()).toMatchObject({
      status: 'queued',
      attempts: 0,
    });
  });

  it('refuses work requested from another database, without touching anything', async () => {
    const { Task } = await core.getModels();
    const { taskKey } = await request('linkedin_post');
    providerModel.mockReturnValue(scripted());
    const refused = generateDraft.run({ taskKey, database: 'omenai_live_dev' }, ctx(1));
    await expect(refused).rejects.toBeInstanceOf(AbortTaskRunError);
    await expect(refused).rejects.toThrow(/Database mismatch/);
    expect(providerModel).not.toHaveBeenCalled();
    expect(await Task.findOne({ key: taskKey }).lean()).toMatchObject({
      status: 'queued',
      attempts: 0,
    });
  });
});
