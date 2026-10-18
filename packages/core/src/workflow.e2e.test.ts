import { measureDraft } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getModels } from './db/models.js';
import { getDraftStatus, getDraftsView } from './drafts/queries.js';
import { requestDraft, runDraftGeneration, saveDraftEdit } from './drafts/service.js';
import { decideStory } from './newsroom/decisions.js';
import { getNewsroom, getStoryDetail, listSavedStories } from './newsroom/queries.js';
import { getOperationsOverview } from './ops/overview.js';
import { getResearchStatus, getResearchView } from './research/queries.js';
import { runChatReply } from './research/chat.js';
import { postChatMessage, requestResearch, runResearch } from './research/service.js';
import { startTaskAttempt } from './tasks/service.js';
import { startTestDatabase, type TestDatabase } from './testing/index.js';
import { createFixtureResearchLlm } from './testing/scenarios/executor.js';
import { fixtureResearchSearch, researchResultsFor } from './testing/scenarios/research-script.js';
import { seedFixtureNewsroom } from './testing/seed.js';

/**
 * The whole editorial workflow through the real services, as the web app and worker call them:
 * discover → shortlist → save → research → ask → draft → edit → revise, then what Operations and
 * the story page report. The model is scripted and the search fake (fixtures); this proves the
 * workflow and its records hold together, not how a real model writes.
 */
let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});

describe('editorial workflow, end to end (scripted model, fake search)', () => {
  it('takes a story from discovery to an edited, revised draft with every record consistent', async () => {
    // 1. Discovery produces an edition and a ranked shortlist.
    await seedFixtureNewsroom();
    const edition = await getNewsroom();
    expect(edition.run?.status).toBe('completed');
    expect(edition.shortlist.length).toBeGreaterThan(0);
    const card = edition.shortlist[0]!;
    expect(await getResearchStatus(card.id)).toMatchObject({ state: 'none' });

    // 2. An editor saves it to the reading list.
    await decideStory({ storyId: card.id, userId: 'editor-1', decision: 'save' });
    expect((await listSavedStories()).map((s) => s.id)).toContain(card.id);

    // 3. Research, as the worker runs it.
    const { Story } = await getModels();
    const story = (await Story.findById(card.id).lean())!;
    const deps = {
      llm: createFixtureResearchLlm(),
      search: fixtureResearchSearch(researchResultsFor(story)),
      now: () => new Date(),
    };
    const research = await requestResearch({
      storyId: card.id,
      userId: 'editor-1',
      depth: 'standard',
      kind: 'auto',
    });
    await startTaskAttempt(research.taskKey, 1);
    await runResearch({ taskKey: research.taskKey, deps });
    const chat = await postChatMessage({
      storyId: card.id,
      userId: 'editor-1',
      content: 'Who are the key people behind this?',
    });
    await startTaskAttempt(chat.taskKey, 1);
    await runChatReply({ taskKey: chat.taskKey, deps });
    const view = await getResearchView(card.id);
    expect(view.briefs).toHaveLength(1);
    expect(view.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(view.activeTask).toBeNull();
    expect(await getResearchStatus(card.id)).toMatchObject({ state: 'ready', briefs: 1 });

    // 4. Drafts in two formats, written from that research.
    const write = async (
      format: string,
      options: { instructions?: string; fromVersion?: number } = {},
    ) => {
      const { taskKey } = await requestDraft({
        storyId: card.id,
        userId: 'editor-1',
        format,
        ...options,
      });
      await startTaskAttempt(taskKey, 1);
      return runDraftGeneration({ taskKey, deps: { llm: deps.llm, now: deps.now } });
    };
    await write('newsletter_item');
    await write('x_post');
    let drafts = await getDraftsView(card.id);
    const briefing = drafts.formats.newsletter_item.versions[0]!;
    const post = drafts.formats.x_post.versions[0]!;
    expect(briefing.claims.length).toBeGreaterThan(0);
    // Never calls an over-limit post fine: whatever was saved is measured by X's rules.
    expect(measureDraft('x_post', post.body).overLimit).toBe(false);

    // 5. The editor edits, then asks for a revision of the edit.
    await saveDraftEdit({
      storyId: card.id,
      userId: 'editor-2',
      format: 'newsletter_item',
      baseVersion: 1,
      title: briefing.title,
      body: `${briefing.body}\n\nAn editor’s closing line.`,
    });
    await write('newsletter_item', { instructions: 'Tighter, please.', fromVersion: 2 });
    drafts = await getDraftsView(card.id);
    expect(
      drafts.formats.newsletter_item.versions.map((v) => [v.version, v.origin, v.basedOnVersion]),
    ).toEqual([
      [3, 'generated', 2],
      [2, 'edited', 1],
      [1, 'generated', null],
    ]);
    expect(await getDraftStatus(card.id)).toEqual({ formats: 2, versions: 4, writing: false });

    // 6. Every lock released, nothing needs anyone, and all usage is marked simulated.
    const { Task, AiUsage } = await getModels();
    expect(await Task.countDocuments({ activeLock: { $exists: true } })).toBe(0);
    expect(await Task.countDocuments({ status: { $ne: 'succeeded' }, storyId: story._id })).toBe(0);
    const overview = await getOperationsOverview();
    expect(overview.attention.filter((a) => !a.automatic)).toEqual([]);
    expect(await AiUsage.countDocuments({ storyId: card.id })).toBeGreaterThan(0);
    expect(await AiUsage.countDocuments({ simulated: { $ne: true } })).toBe(0);
    expect(overview.usage.simulated?.groups.map((g) => g.label)).toEqual(
      expect.arrayContaining(['Research', 'Creating content']),
    );
    // The story page still reads as saved, and nothing about it changed along the way.
    expect(await getStoryDetail(card.id)).toMatchObject({
      editorialState: 'saved',
      headline: card.headline,
    });
  });
});
