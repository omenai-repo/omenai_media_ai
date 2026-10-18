import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getModels } from '../db/models.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import {
  completeTask,
  ensureTask,
  failTask,
  progressRecorder,
  startTaskAttempt,
} from './service.js';

/**
 * Progress records: what the interface shows while work runs. Steps are written as the work
 * reaches them, never block it, never touch a finished task, and nothing partial outlives it.
 */
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

async function runningTask(key: string, kind: 'research' | 'generate' = 'research') {
  await ensureTask({ key, kind });
  await startTaskAttempt(key, 1);
  const { Task } = await getModels();
  return async () => (await Task.findOne({ key }).lean())!;
}

describe('progressRecorder', () => {
  it('records each step reached, in order, with what it found', async () => {
    const read = await runningTask('research:standard:t1');
    let clock = Date.parse('2026-10-16T21:00:00Z');
    const progress = progressRecorder('research:standard:t1', () => new Date((clock += 1_000)));
    progress.step('sources', { sources: 3 });
    progress.step('search');
    progress.count({ found: 2, setAside: 1 });
    progress.notice('retrying');
    await progress.flush();

    const task = await read();
    expect(task.progress).toMatchObject({
      step: 'search',
      notice: 'retrying',
      startedAt: new Date('2026-10-16T21:00:02Z'),
    });
    expect(task.progress?.steps).toEqual([
      { step: 'sources', startedAt: new Date('2026-10-16T21:00:01Z'), counts: { sources: 3 } },
      {
        step: 'search',
        startedAt: new Date('2026-10-16T21:00:02Z'),
        counts: { found: 2, setAside: 1 },
      },
    ]);

    // A new step clears the notice that belonged to the last one.
    progress.step('write', { sources: 5 });
    await progress.flush();
    expect((await read()).progress).toMatchObject({ step: 'write', notice: null });
  });

  it('collapses changes made while a write is in flight into one write of the latest state', async () => {
    const read = await runningTask('research:standard:t2');
    const { Task } = await getModels();
    const writes = vi.spyOn(Task, 'updateOne');
    const progress = progressRecorder('research:standard:t2');
    progress.step('sources');
    for (let i = 0; i < 50; i += 1) progress.count({ sources: i });
    await progress.flush();
    expect(writes.mock.calls.length).toBeLessThanOrEqual(2);
    expect((await read()).progress?.steps?.[0]?.counts).toEqual({ sources: 49 });
    writes.mockRestore();
  });

  it('never touches a task that has finished, and a new attempt starts from nothing', async () => {
    const read = await runningTask('research:standard:t3');
    const progress = progressRecorder('research:standard:t3');
    progress.step('sources');
    await progress.flush();
    await failTask('research:standard:t3', 'scripted outage', false);

    // A late change from the attempt that failed: ignored, the task isn't running.
    progress.step('write');
    await progress.flush();
    expect((await read()).progress?.step).toBe('sources');

    await startTaskAttempt('research:standard:t3', 2);
    expect((await read()).progress).toMatchObject({ step: null, steps: [], notice: null });
  });

  it('keeps a draft’s text only while it is written, and writes the final steps with the outcome', async () => {
    const read = await runningTask('generate:x_post:t4', 'generate');
    const progress = progressRecorder('generate:x_post:t4');
    progress.step('write');
    progress.preview({ title: '', body: 'The first words of the post' });
    await progress.flush();
    expect((await read()).progress?.preview).toEqual({
      title: '',
      body: 'The first words of the post',
    });

    progress.step('save');
    await completeTask('generate:x_post:t4', 'succeeded', progress.final());
    const done = await read();
    expect(done.status).toBe('succeeded');
    expect(done.progress?.preview).toBeUndefined();
    expect(done.progress?.steps?.map((s) => s.step)).toEqual(['write', 'save']);

    // Recording has stopped: nothing more is written after the outcome.
    progress.step('check');
    await progress.flush();
    expect((await read()).progress?.step).toBe('save');
  });

  it('drops the text written so far when an attempt fails, retried or not', async () => {
    const read = await runningTask('generate:x_post:t5', 'generate');
    const progress = progressRecorder('generate:x_post:t5');
    progress.step('write');
    progress.preview({ title: '', body: 'Half a post' });
    await progress.flush();
    await failTask('generate:x_post:t5', 'scripted outage', false);
    expect((await read()).progress?.preview).toBeUndefined();
    expect((await read()).status).toBe('queued');
  });
});
