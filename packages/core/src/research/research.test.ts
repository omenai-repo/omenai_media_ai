import type { StepCounts } from '@repo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { AppError, ConflictError } from '../errors.js';
import { LlmError } from '../llm/types.js';
import { createFakeSearch, type FixtureArticle } from '../testing/discovery-fixtures.js';
import { createScriptedLlm } from '../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { seedFixtureNewsroom } from '../testing/seed.js';
import { failTask, startTaskAttempt } from '../tasks/service.js';
import { outOfScopeReply, runChatReply } from './chat.js';
import { getResearchStatus, getResearchView } from './queries.js';
import { postChatMessage, requestResearch, researchQueries, runResearch } from './service.js';

/** "S1 | publisher | date | headline" header, then (after optional markers) the source text. */
function promptSources(prompt: string): Array<{ label: string; headline: string; text: string }> {
  const list = (prompt.split('SOURCES:\n')[1] ?? '').split('\n\nQUESTION:')[0]!;
  return list.split('\n---\n').map((block) => {
    const [header = '', ...rest] = block.split('\n');
    const [label = '', , , headline = ''] = header.split(' | ');
    return { label, headline, text: rest.filter((l) => !l.startsWith('[')).join('\n') };
  });
}

const question = (prompt: string) => /^QUESTION: (.*)$/m.exec(prompt)?.[1] ?? '';

const fixture = (url: string, title: string, content: string): FixtureArticle => ({
  url,
  title,
  snippet: title,
  publishedDate: 'Mon, 05 Oct 2026 08:00:00 GMT',
  score: 0.8,
  content,
  images: [],
});

const background = fixture(
  'https://museum-journal.example/asante-career-survey',
  'A survey of Kwame Asante’s thirty-year career with bottle caps',
  'The sculptor began working with flattened bottle caps in the 1990s, stitching them with copper wire into large hangings.',
);
// Shares only the city with the story: must be discarded before it is read or stored.
const nearMiss = fixture(
  'https://city-news.example/cape-town-bus-lanes',
  'Cape Town opens new bus lanes this week',
  'New bus lanes open across the city centre.',
);

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await seedFixtureNewsroom();
});

function scripted(options: { failResearchOnce?: boolean } = {}) {
  let researchFailures = options.failResearchOnce ? 1 : 0;
  return createScriptedLlm({
    research: (prompt) => {
      if (researchFailures > 0) {
        researchFailures -= 1;
        throw new LlmError('unavailable', 'scripted outage', 'gemini', { status: 503 });
      }
      const sources = promptSources(prompt);
      const own = sources[0]!;
      const found = sources.find((s) => s.headline.startsWith('A survey')) ?? own;
      return {
        overview: [
          {
            type: 'fact',
            text: 'The Kwame Asante retrospective at Zeitz MOCAA is drawing crowds.',
            sources: [own.label],
            excerpt: own.text.slice(0, 70),
          },
          // Unknown label: dropped, and must not survive in the overview text either.
          { type: 'fact', text: 'Invented.', sources: ['S9'], excerpt: 'nothing' },
        ],
        whyItMatters: [
          {
            type: 'analysis',
            text: 'A shift in whose careers become histories.',
            sources: [],
            excerpt: '',
          },
        ],
        findings: [
          {
            type: 'attributed',
            text: 'He began in the 1990s.',
            sources: [found.label],
            excerpt: 'began working with flattened bottle caps in the 1990s',
          },
          {
            type: 'fact',
            text: 'It drew record crowds.',
            sources: [own.label],
            excerpt: 'record crowds on opening night',
          },
        ],
        toConfirm: [],
        background: [],
        peopleToApproach: [],
        verificationChecklist: ['Confirm the opening date with the museum.'],
      };
    },
    // A lead: a short answer to the question, never a new brief.
    focused: (prompt) => {
      const found = promptSources(prompt).find((s) => s.headline.startsWith('A survey'))!;
      return {
        answer: [
          {
            type: 'open_question',
            text: 'The sources don’t say which collectors own his work.',
            sources: [],
            excerpt: '',
          },
          {
            type: 'fact',
            text: 'They do say he began working with bottle caps in the 1990s.',
            sources: [found.label],
            excerpt: 'began working with flattened bottle caps in the 1990s',
          },
        ],
        evidence: 'insufficient',
        toConfirm: [
          {
            type: 'open_question',
            text: 'Ask his gallery for a collector list.',
            sources: [],
            excerpt: '',
          },
        ],
        nextSteps: ['Ask the gallery which collections hold his work.'],
      };
    },
    // One call decides the scope and answers. The prompt carries the conversation so far, so
    // only the question itself decides the scripted answer.
    chat: (prompt) =>
      /linux/i.test(question(prompt))
        ? {
            assessment: 'out_of_scope',
            scope: 'about_story',
            statements: [{ type: 'analysis', text: 'Off topic.', sources: [], excerpt: '' }],
            evidence: 'insufficient',
            researchQuestion: '',
            researchDepth: 'focused',
          }
        : /collectors/i.test(question(prompt))
          ? {
              assessment: 'needs_research',
              scope: 'related',
              statements: [
                {
                  type: 'analysis',
                  text: 'The sources don’t name any collectors.',
                  sources: [],
                  excerpt: '',
                },
              ],
              evidence: 'insufficient',
              researchQuestion: 'Which collectors own works by Kwame Asante?',
              researchDepth: 'focused',
            }
          : {
              assessment: 'sufficient',
              scope: 'about_story',
              statements: [
                // A quote left empty: kept, but its source check reads "not found".
                { type: 'fact', text: 'It opened this week [S1].', sources: ['S1'], excerpt: '' },
                // S8 isn't in this research: the statement is dropped.
                {
                  type: 'attributed',
                  text: 'A sequel show is rumoured.',
                  sources: ['S8'],
                  excerpt: 'a sequel show',
                },
              ],
              evidence: 'sufficient',
              researchQuestion: '',
              researchDepth: 'focused',
            },
  });
}

describe('research briefs and grounded chat (scripted model, fake search)', () => {
  it('persists relevant sources only, validates citations, locks the story and never duplicates', async () => {
    const { Story, SourceArticle, ResearchBrief, Task } = await getModels();
    const story = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
    const storyId = String(story._id);
    const search = createFakeSearch([background, nearMiss]);
    const { llm, calls } = scripted();
    const deps = { llm, search: search.client, now: () => new Date() };

    const { taskKey } = await requestResearch({
      storyId,
      userId: 'editor-1',
      depth: 'standard',
      kind: 'auto',
    });
    await expect(
      requestResearch({ storyId, userId: 'editor-2', depth: 'standard' }),
    ).rejects.toBeInstanceOf(ConflictError);

    const { briefId } = await runResearch({ taskKey, deps });
    expect((await SourceArticle.findOne({ url: background.url }).lean())?.origin).toBe('research');
    expect(await SourceArticle.exists({ url: nearMiss.url })).toBeNull();
    expect(search.calls.extractedUrls).not.toContain(nearMiss.url);
    expect(calls.find((c) => c.operation === 'research')?.prompt).toContain(
      'A survey of Kwame Asante',
    );

    const view = await getResearchView(storyId);
    const brief = view.briefs.at(-1)!;
    expect(brief).toMatchObject({ requestKind: 'auto', discardedResults: 1, droppedClaims: 1 });
    expect(brief.counts).toEqual({ verified: 2, unconfirmed: 1, uncited: 1 });
    // Fixed kinds and titles from the server, empty parts left out, in reading order.
    expect(brief.sections.map((s) => [s.kind, s.title])).toEqual([
      ['overview', 'Overview'],
      ['why_it_matters', 'Why it matters'],
      ['findings', 'What we found'],
    ]);
    expect(brief.overview).toBe('The Kwame Asante retrospective at Zeitz MOCAA is drawing crowds.');
    expect(brief.sources.some((s) => view.sources[s.sourceId]?.origin === 'research')).toBe(true);
    expect((await Task.findOne({ key: taskKey }).lean())?.status).toBe('succeeded');

    // The gap between saving the brief and releasing the lock already reads as finished.
    await Task.updateOne(
      { key: taskKey },
      { $set: { status: 'running', activeLock: `story:${storyId}` } },
    );
    expect((await getResearchView(storyId)).activeTask).toBeNull();
    await Task.updateOne(
      { key: taskKey },
      { $set: { status: 'succeeded' }, $unset: { activeLock: '' } },
    );

    // Retried, or opened again by a stale page: no second brief, no new spend.
    expect((await runResearch({ taskKey, deps })).briefId).toBe(briefId);
    await expect(
      requestResearch({ storyId, userId: 'editor-1', depth: 'standard', kind: 'auto' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await ResearchBrief.countDocuments({ storyId: story._id })).toBe(1);

    // Chat holds the same lock while a reply is being written.
    const chat = await postChatMessage({
      storyId,
      userId: 'editor-1',
      content: 'When did it open?',
    });
    await expect(
      requestResearch({ storyId, userId: 'editor-1', depth: 'standard' }),
    ).rejects.toBeInstanceOf(ConflictError);
    await runChatReply({ taskKey: chat.taskKey, deps });
    await runChatReply({ taskKey: chat.taskKey, deps });
    const reply = (await getResearchView(storyId)).messages.filter((m) => m.role === 'assistant');
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({
      // Labels never stay in the text; each statement carries its own sources and quote.
      content: 'It opened this week.',
      droppedClaims: 1,
      scope: 'about_story',
      claims: [
        {
          text: 'It opened this week.',
          sourceLabels: ['S1'],
          excerpt: null,
          citationStatus: 'excerpt_not_located',
        },
      ],
    });
  });

  it('keeps the conversation on the story: off-topic replies are server-written, leads come only from approved replies', async () => {
    const { Story } = await getModels();
    const story = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
    const storyId = String(story._id);
    const search = createFakeSearch([background]);
    const { llm, calls } = scripted({ failResearchOnce: true });
    const deps = { llm, search: search.client, now: () => new Date() };

    // A failed attempt keeps what it found; the retry reuses it without searching again.
    const first = await requestResearch({ storyId, userId: 'editor-1', depth: 'standard' });
    await expect(runResearch({ taskKey: first.taskKey, deps })).rejects.toBeInstanceOf(LlmError);
    const { Task } = await getModels();
    await Task.updateOne(
      { key: first.taskKey },
      { $set: { status: 'failed' }, $unset: { activeLock: '' } },
    );
    const searchesBefore = search.calls.search;
    const retry = await requestResearch({ storyId, userId: 'editor-1', depth: 'standard' });
    await runResearch({ taskKey: retry.taskKey, deps });
    expect(search.calls.search).toBe(searchesBefore);

    // Off-topic: one call decides it, and the reply is the server's own text, not the model's.
    const offTopic = await postChatMessage({
      storyId,
      userId: 'editor-1',
      content: 'How do I configure a Linux server?',
    });
    const answersBefore = calls.filter((c) => c.operation === 'chat').length;
    await runChatReply({ taskKey: offTopic.taskKey, deps });
    expect(calls.filter((c) => c.operation === 'chat')).toHaveLength(answersBefore + 1);
    const refused = (await getResearchView(storyId)).messages.at(-1)!;
    expect(refused).toMatchObject({
      scope: 'unrelated',
      content: outOfScopeReply(story.headline),
      citations: [],
      claims: null,
    });
    await expect(
      requestResearch({
        storyId,
        userId: 'editor-1',
        depth: 'standard',
        fromMessageId: refused.id,
      }),
    ).rejects.toBeInstanceOf(AppError);

    // A related question the saved research can't settle starts focused research on its own; the
    // research takes its question from the saved reply, and is never started twice for it.
    const lead = await postChatMessage({
      storyId,
      userId: 'editor-1',
      content: 'Which collectors own his work?',
    });
    const replied = await runChatReply({ taskKey: lead.taskKey, deps });
    const offer = (await getResearchView(storyId)).messages.at(-1)!;
    expect(offer).toMatchObject({
      scope: 'related',
      evidence: 'insufficient',
      assessment: 'needs_research',
      followUp: { status: 'started', question: 'Which collectors own works by Kwame Asante?' },
    });
    expect(replied.followUp?.taskKey).toBe(offer.followUp?.taskKey);
    await expect(
      requestResearch({ storyId, userId: 'editor-1', depth: 'standard', fromMessageId: offer.id }),
    ).rejects.toMatchObject({ code: 'ALREADY_RESEARCHED' });
    await runResearch({ taskKey: replied.followUp!.taskKey, deps });
    const briefs = (await getResearchView(storyId)).briefs;
    expect(briefs.map((b) => b.requestKind)).toEqual(['manual', 'followup']);
    expect(briefs[1]).toMatchObject({ focus: offer.suggestedFocus, fromMessageId: offer.id });
    // The lead gets an answer to its question, not a briefing: no overview, significance or
    // background, and the honest "not established" comes first.
    expect(briefs[1]?.sections.map((s) => s.kind)).toEqual(['answer', 'to_confirm']);
    expect(briefs[1]?.sections[0]?.claims.map((c) => [c.type, c.citationStatus])).toEqual([
      ['open_question', 'uncited'],
      ['fact', 'verified'],
    ]);
    expect(calls.filter((c) => c.operation === 'focused')).toHaveLength(1);
    expect(calls.at(-1)?.prompt).toContain(`FOCUS: ${offer.suggestedFocus}`);
  });

  it('records only the steps it takes, with what each found, and skips reading when nothing is new', async () => {
    const { Story, SourceArticle, Task } = await getModels();
    const zeitz = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
    const other = (await Story.findOne({
      _id: { $ne: zeitz._id },
      'sourceArticleIds.0': { $exists: true },
    }).lean())!;
    const own = async (story: typeof zeitz) =>
      Math.min(6, await SourceArticle.countDocuments({ _id: { $in: story.sourceArticleIds } }));
    async function research(story: typeof zeitz, hits: FixtureArticle[]) {
      const { taskKey } = await requestResearch({
        storyId: String(story._id),
        userId: 'editor-1',
        depth: 'standard',
      });
      await startTaskAttempt(taskKey, 1);
      const search = createFakeSearch(hits).client;
      await runResearch({ taskKey, deps: { llm: scripted().llm, search, now: () => new Date() } });
      const task = (await Task.findOne({ key: taskKey }).lean())!;
      return task.progress!.steps!.map((s) => [s.step, s.counts as StepCounts | null]);
    }

    const zeitzSources = await own(zeitz);
    expect(await research(zeitz, [background, nearMiss])).toEqual([
      ['sources', { sources: zeitzSources }],
      ['search', { found: 1, setAside: 1 }],
      ['read', { articles: 1 }],
      ['write', { sources: zeitzSources + 1 }],
      ['check', null],
    ]);
    // Nothing new found: no reading step is recorded, so none is shown as done.
    const otherSources = await own(other);
    expect(await research(other, [])).toEqual([
      ['sources', { sources: otherSources }],
      ['search', { found: 0, setAside: 0 }],
      ['write', { sources: otherSources }],
      ['check', null],
    ]);
  });

  it('records a retry that reuses what the first attempt found, without searching again', async () => {
    const { Story, Task } = await getModels();
    const story = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
    const { taskKey } = await requestResearch({
      storyId: String(story._id),
      userId: 'editor-1',
      depth: 'standard',
    });
    const search = createFakeSearch([background]);
    const { llm } = scripted({ failResearchOnce: true });
    const deps = { llm, search: search.client, now: () => new Date() };
    await startTaskAttempt(taskKey, 1);
    await expect(runResearch({ taskKey, deps })).rejects.toBeInstanceOf(LlmError);
    await failTask(taskKey, 'scripted outage', false);
    const searches = search.calls.search;
    expect(searches).toBeGreaterThan(0);

    await startTaskAttempt(taskKey, 2);
    await runResearch({ taskKey, deps });
    const steps = (await Task.findOne({ key: taskKey }).lean())!.progress!.steps!;
    expect(steps.map((s) => [s.step, (s.counts as StepCounts | null)?.reused ?? null])).toEqual([
      ['sources', null],
      ['search', 1],
      ['write', null],
      ['check', null],
    ]);
    expect(search.calls.search).toBe(searches);
  });

  it('builds lead searches from the focus without repeating its subject', () => {
    const story = {
      headline: 'Met Curator Alisa LaGamma on the Rockefeller Wing and Restitution',
      entities: ['Alisa LaGamma', 'Metropolitan Museum of Art'],
      geography: [{ country: 'United States', city: 'New York' }],
    } as Parameters<typeof researchQueries>[0];
    const focus =
      'When was Alisa LaGamma appointed Ceil and Michael E. Pulitzer Curator at the Metropolitan Museum of Art?';
    const queries = researchQueries(story, 'standard', focus);
    expect(queries[0]).toBe(focus);
    expect(queries.every((q) => !/Alisa LaGamma.*Alisa LaGamma/.test(q))).toBe(true);
  });

  it('tells the story page where research stands: none, running, failed, ready', async () => {
    const { Story } = await getModels();
    const story = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
    const storyId = String(story._id);
    const deps = {
      llm: scripted().llm,
      search: createFakeSearch([background]).client,
      now: () => new Date(),
    };

    expect(await getResearchStatus(storyId)).toEqual({ state: 'none', briefs: 0, questions: 0 });
    const first = await requestResearch({ storyId, userId: 'editor-1', depth: 'standard' });
    expect((await getResearchStatus(storyId)).state).toBe('running');
    await failTask(first.taskKey, 'scripted outage', true);
    expect((await getResearchStatus(storyId)).state).toBe('failed');

    const retry = await requestResearch({ storyId, userId: 'editor-1', depth: 'standard' });
    await runResearch({ taskKey: retry.taskKey, deps });
    expect(await getResearchStatus(storyId)).toEqual({ state: 'ready', briefs: 1, questions: 0 });
  });

  it('shows research that stopped without a word as stopped, and lets the editor start again', async () => {
    // Controlled failure (simulated): a timeout or a worker that went away records no error.
    const { Story, Task } = await getModels();
    const story = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
    const storyId = String(story._id);
    const { taskKey } = await requestResearch({ storyId, userId: 'editor-1', depth: 'standard' });
    await Task.collection.updateOne(
      { key: taskKey },
      { $set: { status: 'running', updatedAt: new Date(Date.now() - 50 * 60_000) } },
    );
    const view = await getResearchView(storyId);
    expect(view.activeTask).toBeNull();
    expect(view.lastFailure?.key).toBe(taskKey);
    expect(view.lastFailure?.lastError).toMatch(/Abandoned/);
    expect((await getResearchStatus(storyId)).state).toBe('failed');
    // Asking again takes over the abandoned lock instead of waiting on it.
    await expect(
      requestResearch({ storyId, userId: 'editor-1', depth: 'standard' }),
    ).resolves.toHaveProperty('taskKey');
  });
});
