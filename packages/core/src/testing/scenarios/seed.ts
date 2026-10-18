/**
 * DEVELOPMENT FIXTURES ONLY. Seeds a named scenario into a `*_fixtures` database through the real
 * code paths: invitations and sign-up, the discovery pipeline (with a scripted search and scripted
 * model answers), editorial decisions and task records. Model and search usage is recorded as
 * `simulated`, so it can never be counted or shown as provider-reported usage.
 */
import { chicagoDateKey } from '@repo/shared';
import { Types } from 'mongoose';

import { createInvitation, revokeInvitation } from '../../auth/invitations.js';
import { deactivateUser, listUsers } from '../../auth/users.js';
import { isFixtureRuntime } from '../../config/runtime.js';
import { getModels } from '../../db/models.js';
import { readDiscoveryConfig } from '../../discovery/config.js';
import type { DiscoveryDeps } from '../../discovery/pipeline/context.js';
import { evaluateStory } from '../../discovery/pipeline/evaluate.js';
import { prepareRun } from '../../discovery/pipeline/prepare.js';
import { runDiscoveryInline } from '../../discovery/pipeline/run-inline.js';
import { claimRun, startRun } from '../../discovery/runs.js';
import { requestDraft, runDraftGeneration, saveDraftEdit } from '../../drafts/service.js';
import { LlmError } from '../../llm/types.js';
import { databaseUsageRecorder } from '../../llm/usage.js';
import { decideStory } from '../../newsroom/decisions.js';
import { runChatReply } from '../../research/chat.js';
import { postChatMessage, requestResearch, runResearch } from '../../research/service.js';
import {
  SearchError,
  type ExtractedPage,
  type SearchClient,
  type SearchHit,
} from '../../search/types.js';
import { ensureTask, failTask, progressRecorder, startTaskAttempt } from '../../tasks/service.js';
import { fixtureEvaluation, scores } from '../discovery-fixtures.js';
import { createScriptedLlm, promptArticles, promptStories } from '../fake-llm.js';
import { createFixtureResearchLlm } from './executor.js';
import {
  fixtureResearchSearch,
  researchResultsFor,
  scriptedChatReply,
  scriptedFocusedAnswer,
  scriptedResearchBrief,
} from './research-script.js';
import {
  FULL_EDITIONS,
  ON_DEMAND_EDITION,
  type ScenarioArticle,
  type ScenarioEdition,
  type ScenarioStory,
} from './catalog.js';

export const SCENARIOS = {
  full: 'Six editions covering every state (in progress, full, small, empty, failed sources, failed run), a varied team and simulated usage.',
  empty: 'A brand-new newsroom: only the owner, no editions, no invitations, no usage.',
} as const;
export type ScenarioName = keyof typeof SCENARIOS;

export const FIXTURE_PASSWORD = 'fixture-password-only';

export const FIXTURE_ACCOUNTS = {
  owner: { email: 'owner@fixtures.example', name: 'Ifeoma Bello', role: 'owner' },
  editor: { email: 'editor@fixtures.example', name: 'Leila Haddad', role: 'editor' },
  secondEditor: { email: 'tomas.ribeiro@fixtures.example', name: 'Tomás Ribeiro', role: 'editor' },
  formerEditor: { email: 'kwesi.mensah@fixtures.example', name: 'Kwesi Mensah', role: 'editor' },
} as const;

/** Creates one account through the real invitation sign-up path (supplied by the caller). */
export type FixtureSignUp = (input: {
  email: string;
  name: string;
  password: string;
  invitationToken: string;
}) => Promise<void>;

const DAY_MS = 86_400_000;

export async function seedScenario(
  name: ScenarioName,
  options: { signUp: FixtureSignUp; now?: Date },
): Promise<{ editions: Array<{ runKey: string; description: string }> }> {
  // Defence in depth: the CLI checks too, but fixtures must never reach a real database.
  if (!isFixtureRuntime())
    throw new Error('Scenarios can only be seeded into a *_fixtures database.');
  const now = options.now ?? new Date();

  const accounts = name === 'full' ? Object.values(FIXTURE_ACCOUNTS) : [FIXTURE_ACCOUNTS.owner];
  for (const account of accounts) {
    const { token } = await createInvitation({
      email: account.email,
      role: account.role,
      invitedBy: 'fixture-seed',
      // Within the seven-day validity, as the real sign-up path requires.
      now: new Date(now.getTime() - 3 * DAY_MS),
    });
    await options.signUp({
      email: account.email,
      name: account.name,
      password: FIXTURE_PASSWORD,
      invitationToken: token,
    });
  }
  if (name === 'empty') return { editions: [] };

  const users = new Map((await listUsers()).map((u) => [u.email, u]));
  const userId = (email: string) => users.get(email)!.id;
  const ownerId = userId(FIXTURE_ACCOUNTS.owner.email);
  await seedTeamStates(ownerId, now);

  const context = createScenarioContext();
  const editions: Array<{ runKey: string; description: string }> = [];
  for (const edition of FULL_EDITIONS) {
    editions.push({
      runKey: await seedEdition(edition, context, now),
      description: edition.description,
    });
  }

  // Editorial decisions, through the real decision service (with its audit trail).
  const decisions: Array<[string, string, 'save' | 'skip', string | null]> = [
    [
      'nairobi-archive',
      FIXTURE_ACCOUNTS.editor.email,
      'save',
      'Possible feature for the archive issue.',
    ],
    ['biennale', FIXTURE_ACCOUNTS.owner.email, 'save', null],
    ['kinshasa-chef', FIXTURE_ACCOUNTS.secondEditor.email, 'save', 'Pitch for the food series.'],
    [
      'beirut-gallery',
      FIXTURE_ACCOUNTS.editor.email,
      'skip',
      'We covered this gallery in the spring.',
    ],
  ];
  for (const [key, email, decision, reason] of decisions) {
    const storyId = await context.storyIdFor(key);
    if (storyId) await decideStory({ storyId, userId: userId(email), decision, reason, now });
  }
  await seedResearch(context, userId(FIXTURE_ACCOUNTS.editor.email), now);
  await seedDrafts(context, userId(FIXTURE_ACCOUNTS.editor.email), ownerId, now);
  return { editions };
}

/** Invitations in every state, and one member whose access was removed. */
async function seedTeamStates(ownerId: string, now: Date): Promise<void> {
  const former = (await listUsers()).find((u) => u.email === FIXTURE_ACCOUNTS.formerEditor.email);
  if (former) await deactivateUser({ actorId: ownerId, userId: former.id });

  await createInvitation({
    email: 'nadia.farouk@fixtures.example',
    role: 'editor',
    invitedBy: ownerId,
    now: new Date(now.getTime() - 2 * DAY_MS),
  });
  // Sent ten days ago, so its seven-day link has expired.
  await createInvitation({
    email: 'samuel.osei@fixtures.example',
    role: 'editor',
    invitedBy: ownerId,
    now: new Date(now.getTime() - 10 * DAY_MS),
  });
  const withdrawn = await createInvitation({
    email: 'priya.raman@fixtures.example',
    role: 'owner',
    invitedBy: ownerId,
    now: new Date(now.getTime() - 4 * DAY_MS),
  });
  await revokeInvitation(withdrawn.invitation.id, new Date(now.getTime() - 3 * DAY_MS));
}

// ── Research (through the real research and chat services) ─────────────────

/**
 * Research data for the workspace: an Omenai-started brief and a conversation (on topic, an
 * editorial question, a question the saved research didn't settle, researched on its own, and an
 * off-topic one), a second story's brief, a failed attempt, and research still in progress.
 */
async function seedResearch(context: ScenarioContext, editorId: string, now: Date) {
  const { Story } = await getModels();
  const depsFor = async (storyId: string) => {
    const story = (await Story.findById(storyId).lean())!;
    return {
      llm: createFixtureResearchLlm(),
      search: fixtureResearchSearch(researchResultsFor(story)),
      now: () => now,
    };
  };
  const research = async (
    storyId: string,
    kind: 'auto' | 'manual' | 'lead',
    fromMessageId?: string,
  ) => {
    const { taskKey } = await requestResearch({
      storyId,
      userId: editorId,
      depth: 'standard',
      kind,
      fromMessageId,
      now,
    });
    await startTaskAttempt(taskKey, 1);
    await runResearch({ taskKey, deps: await depsFor(storyId) });
  };
  const ask = async (storyId: string, content: string) => {
    const { taskKey } = await postChatMessage({ storyId, userId: editorId, content, now });
    await startTaskAttempt(taskKey, 1);
    const { messageId, followUp } = await runChatReply({ taskKey, deps: await depsFor(storyId) });
    // Research a reply started on its own (the saved research didn't settle the question) runs
    // as the worker would run it, so its findings appear inside that reply.
    if (followUp) {
      await startTaskAttempt(followUp.taskKey, 1);
      await runResearch({ taskKey: followUp.taskKey, deps: await depsFor(storyId) });
    }
    return messageId;
  };

  const biennale = await context.storyIdFor('biennale');
  if (biennale) {
    await research(biennale, 'auto');
    await ask(
      biennale,
      'Who is behind the floating gallery, and what do the sources say about it?',
    );
    await ask(biennale, 'Does this story suit Omenai’s focus on contemporary art?');
    // The saved research doesn't settle this, so the reply researches it on its own.
    await ask(biennale, 'Is the visitor figure confirmed anywhere?');
    await ask(biennale, 'How do I configure a Linux server for our website?');
  }
  const casablanca = await context.storyIdFor('casablanca-market');
  if (casablanca) {
    await research(casablanca, 'auto');
    await ask(casablanca, 'Who campaigned to save the market hall?');
  }
  // A research attempt that gave up, so the failure and retry states can be seen.
  const chef = await context.storyIdFor('kinshasa-chef');
  if (chef) {
    const { taskKey } = await requestResearch({
      storyId: chef,
      userId: editorId,
      depth: 'standard',
      kind: 'auto',
      now,
    });
    await startTaskAttempt(taskKey, 3);
    await failTask(taskKey, 'unavailable: The model is overloaded (development fixture)', true);
  }
  // Research still running (its lock is held), so the workspace reconnects to its progress.
  const dakar = await context.storyIdFor('dakar-documentary');
  if (dakar) {
    const { taskKey } = await requestResearch({
      storyId: dakar,
      userId: editorId,
      depth: 'standard',
      kind: 'auto',
      now,
    });
    await startTaskAttempt(taskKey, 1);
    // Steps recorded the way real research records them (the counts are fixture values).
    const progress = progressRecorder(taskKey, () => now);
    progress.step('sources', { sources: 3 });
    progress.step('search');
    progress.count({ found: 2, setAside: 1 });
    progress.step('read', { articles: 2 });
    progress.step('write', { sources: 5 });
    await progress.flush();
  }
}

// ── Drafts (through the real draft service) ─────────────────────────────────

/**
 * A draft history for the studio: a briefing item that was generated, edited by hand and then
 * revised with instructions, an X post, and a LinkedIn post whose generation gave up.
 */
async function seedDrafts(context: ScenarioContext, editorId: string, ownerId: string, now: Date) {
  const deps = { llm: createFixtureResearchLlm(), now: () => now };
  const generate = async (
    storyId: string,
    userId: string,
    format: string,
    options: { instructions?: string; fromVersion?: number } = {},
  ) => {
    const { taskKey } = await requestDraft({ storyId, userId, format, now, ...options });
    await startTaskAttempt(taskKey, 1);
    return runDraftGeneration({ taskKey, deps });
  };

  const biennale = await context.storyIdFor('biennale');
  if (biennale) {
    await generate(biennale, editorId, 'newsletter_item');
    const { DraftVersion } = await getModels();
    const first = (await DraftVersion.findOne({
      storyId: new Types.ObjectId(biennale),
      format: 'newsletter_item',
      version: 1,
    }).lean())!;
    await saveDraftEdit({
      storyId: biennale,
      userId: ownerId,
      format: 'newsletter_item',
      baseVersion: 1,
      title: 'Lagos opens its first biennale, on its own terms',
      body: first.body.replace(/\n\n[^\n]*$/, ''),
    });
    await generate(biennale, editorId, 'newsletter_item', {
      instructions: 'Shorter, and lead with the floating gallery.',
      fromVersion: 2,
    });
    await generate(biennale, editorId, 'x_post');
  }
  const casablanca = await context.storyIdFor('casablanca-market');
  if (casablanca) {
    const { taskKey } = await requestDraft({
      storyId: casablanca,
      userId: editorId,
      format: 'linkedin_post',
      now,
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await startTaskAttempt(taskKey, attempt);
      await failTask(
        taskKey,
        'unavailable: The model is overloaded (development fixture)',
        attempt === 3,
      );
    }
  }
}

// ── Editions ─────────────────────────────────────────────────────────────────

function picsum(slug: string, width: number, height: number): string {
  return `https://picsum.photos/seed/omenai-${slug}/${width}/${height}`;
}

/** The images a fixture page offers, and the markdown that carries their alt text. */
function pageImages(article: ScenarioArticle): { urls: string[]; markdown: string } {
  const withAlt = (url: string) => ({
    urls: [url],
    markdown: article.alt ? `![${article.alt}](${url})` : '',
  });
  switch (article.image) {
    case 'landscape':
      return withAlt(picsum(article.slug, 1600, 1066));
    case 'portrait':
      return withAlt(picsum(article.slug, 1000, 1500));
    case 'landscape-no-alt':
      return { urls: [picsum(article.slug, 1600, 1066)], markdown: '' };
    case 'broken':
      // `.invalid` is reserved and never resolves, so the request always fails.
      return { urls: [`https://images.fixtures.invalid/${article.slug}.jpg`], markdown: '' };
    case 'rejected':
      // Neither survives the capture filter (insecure URL, a site logo).
      return {
        urls: [
          `http://insecure-images.example/${article.slug}.jpg`,
          `https://${article.host}/assets/site-logo.png`,
        ],
        markdown: '',
      };
    case 'missing':
      return { urls: [], markdown: '' };
  }
}

function pageText(article: ScenarioArticle, markdown: string): string {
  const paragraphs = Array.from(
    { length: 12 },
    (_, i) =>
      `${article.detail} (fixture paragraph ${i + 1}; invented text for interface testing).`,
  );
  return [`# ${article.title}`, markdown, ...paragraphs].filter(Boolean).join('\n\n');
}

/** Scripted search and model answers for every catalogued edition (shared with the executor). */
export function createScenarioContext() {
  const stories = new Map<string, ScenarioStory>();
  const articles = new Map<string, ScenarioArticle>();
  for (const edition of [...FULL_EDITIONS, ON_DEMAND_EDITION]) {
    for (const story of edition.stories) {
      stories.set(story.key, story);
      for (const article of story.articles) articles.set(article.title, article);
    }
  }
  const storyByTitle = new Map<string, ScenarioStory>();
  for (const story of stories.values())
    for (const article of story.articles) storyByTitle.set(article.title, story);
  const headlineOf = (story: ScenarioStory) => story.articles[0]!.title;

  const pages = new Map<string, ExtractedPage>();
  let hits: SearchHit[] = [];
  let unreadable = new Set<string>();
  let failingQueries = 0;
  let unauthorised = false;
  let searchCalls = 0;

  const search: SearchClient = {
    search: () => {
      searchCalls += 1;
      if (unauthorised)
        return Promise.reject(
          new SearchError('auth', 'Tavily search failed: Unauthorized (development fixture)'),
        );
      if (searchCalls <= failingQueries)
        return Promise.reject(
          new Error('Tavily search failed: 502 Bad Gateway (development fixture)'),
        );
      return Promise.resolve(hits);
    },
    extract: (urls) => {
      const found: ExtractedPage[] = [];
      const failed: Array<{ url: string; error: string }> = [];
      for (const url of urls) {
        const page = pages.get(url);
        if (page && !unreadable.has(url)) found.push(page);
        else failed.push({ url, error: 'Page could not be read (development fixture)' });
      }
      return Promise.resolve({ pages: found, failed });
    },
  };

  const { llm } = createScriptedLlm(
    {
      triage: (prompt) => ({
        articles: promptArticles(prompt).map((a) => ({
          ref: a.ref,
          inScope: true,
          reason: 'Cultural development (fixture).',
          eventSummary: a.headline,
          eventDate: null,
          entities: [],
          places: [],
          exclusionSignals: [],
        })),
      }),
      cluster: (prompt) => {
        const existing = promptStories(prompt);
        const groups = new Map<string, string[]>();
        for (const article of promptArticles(prompt)) {
          const key = storyByTitle.get(article.headline)?.key ?? article.headline;
          groups.set(key, [...(groups.get(key) ?? []), article.ref]);
        }
        return {
          groups: [...groups].map(([key, items]) => {
            const link = stories.get(key)?.relatesTo;
            const related = link
              ? existing.find((s) => s.headline === headlineOf(stories.get(link.key)!))?.ref
              : undefined;
            return related && link
              ? { items, relation: link.relation, relatedStory: related, signature: key }
              : { items, relation: 'new', relatedStory: null, signature: key };
          }),
        };
      },
      evaluate: (prompt) => {
        const refs = promptArticles(prompt);
        const story = refs.map((a) => storyByTitle.get(a.headline)).find(Boolean);
        if (!story) throw new Error('No fixture story for this assessment prompt');
        if (story.evaluation === 'fails')
          throw new LlmError(
            'unavailable',
            'The model is overloaded (development fixture)',
            'gemini',
            { status: 503 },
          );
        const lead = story.articles[0]!;
        return fixtureEvaluation(scores(4), {
          headline: lead.title,
          summary: `${lead.detail}.`,
          whatHappened: `${lead.detail}, according to ${lead.host} (A1).`,
          editorialTest: {
            canAnswer: true,
            answer: `This matters to Omenai’s audience because ${lead.detail.charAt(0).toLowerCase()}${lead.detail.slice(1)}, a development with cultural weight beyond the event itself.`,
          },
          whyItMatters: `${lead.detail}. A clear fit with Omenai’s coverage.`,
          angle: '',
          whyNow: 'Reported this week.',
          entities: [],
          formatPotential: [
            { format: 'briefing', rationale: 'A concise item for the weekly briefing.' },
          ],
          verificationNeeds: ['Confirm the key dates and names with the organisers.'],
          visualOpportunities: [],
          sourceQuality: refs.map((a) => ({
            ref: a.ref,
            quality: articles.get(a.headline)?.quality ?? 'unknown',
          })),
          ...story.evaluation,
        });
      },
      change: () => ({ changeKind: 'cosmetic', summary: 'No change (fixture).' }),
      research: scriptedResearchBrief,
      focused: scriptedFocusedAnswer,
      chat: scriptedChatReply,
    },
    { recordUsage: databaseUsageRecorder({ simulated: true }) },
  );

  return {
    llm,
    search,
    load(edition: ScenarioEdition, at: Date) {
      searchCalls = 0;
      failingQueries = edition.failingQueries ?? 0;
      unauthorised = edition.searchUnauthorised ?? false;
      unreadable = new Set();
      hits = [];
      this.serve(
        edition.stories.flatMap((s) => s.articles),
        at,
      );
    },
    serve(list: readonly ScenarioArticle[], at: Date) {
      {
        for (const article of list) {
          const url = `https://${article.host}/${article.slug}`;
          const images = pageImages(article);
          pages.set(url, {
            url,
            title: article.title,
            content: pageText(article, images.markdown),
            images: images.urls,
          });
          if (article.unreadable) unreadable.add(url);
          hits.push({
            url,
            title: article.title,
            snippet: `${article.detail}.`,
            publishedDate:
              article.publishedDaysBefore === null
                ? null
                : new Date(
                    at.getTime() - article.publishedDaysBefore * DAY_MS - 3_600_000,
                  ).toUTCString(),
            score: 0.9,
          });
        }
      }
    },
    async storyIdFor(key: string): Promise<string | null> {
      const story = stories.get(key);
      if (!story) return null;
      const { Story } = await getModels();
      const doc = await Story.findOne({ headline: headlineOf(story) }, { _id: 1 }).lean();
      return doc ? String(doc._id) : null;
    },
  };
}

type ScenarioContext = ReturnType<typeof createScenarioContext>;

/** Midnight-ish Chicago time on the edition's day (never in the future). */
function editionDay(now: Date, daysAgo: number): { day: string; at: Date } {
  const day = chicagoDateKey(new Date(now.getTime() - daysAgo * DAY_MS));
  const at = new Date(Math.min(Date.parse(`${day}T06:00:00Z`), now.getTime() - 15 * 60_000));
  return { day, at };
}

async function seedEdition(edition: ScenarioEdition, context: ScenarioContext, now: Date) {
  const { day, at } = editionDay(now, edition.daysAgo);
  const runKey = `daily-discovery:${day}`;
  context.load(edition, at);
  let tick = 0;
  const deps: DiscoveryDeps = {
    llm: context.llm,
    search: context.search,
    // Revisits are off so each edition only reads its own articles.
    config: { ...readDiscoveryConfig({}), maxQueries: 2, maxRevisits: 0 },
    now: () => new Date(at.getTime() + tick++ * 20_000),
  };
  const { WorkflowRun, Story, SourceArticle, AiUsage, Task } = await getModels();

  if (edition.state === 'in_progress') {
    await startRun({ runKey, trigger: 'schedule' });
    await claimRun({
      runKey,
      owner: 'fixture-seed',
      now: deps.now(),
      config: {
        leaseMs: deps.config.leaseMinutes * 60_000,
        softDeadlineMinutes: deps.config.softDeadlineMinutes,
        extensionDeadlineMinutes: deps.config.extensionDeadlineMinutes,
        hardDeadlineMinutes: deps.config.hardDeadlineMinutes,
      },
    });
    const { candidateStoryIds } = await prepareRun({
      runKey,
      owner: 'fixture-seed',
      queryDate: day,
      deps,
    });
    const assessed = edition.assessedSoFar ?? 0;
    for (const storyId of candidateStoryIds.slice(0, assessed)) {
      await evaluateStory({ runKey, storyId, deps });
    }
    // The next assessment failed once and is on its second attempt.
    const retrying = candidateStoryIds[assessed];
    if (retrying) {
      const key = `discovery.evaluate:${runKey}:${retrying}`;
      await ensureTask({
        key,
        kind: 'discovery.evaluate',
        runKey,
        storyId: new Types.ObjectId(retrying),
      });
      await startTaskAttempt(key, 1);
      await failTask(key, 'unavailable: The model is overloaded (development fixture)', false);
      await startTaskAttempt(key, 2);
    }
    // Keep the fixture "running" instead of letting its lease lapse into a stuck run.
    await WorkflowRun.updateOne(
      { runKey },
      { $set: { leaseExpiresAt: new Date(now.getTime() + 30 * DAY_MS) } },
    );
  } else {
    try {
      await runDiscoveryInline({ runKey, trigger: 'schedule', owner: 'fixture-seed', deps });
    } catch (error) {
      if (edition.state !== 'failed') throw error;
    }
  }

  // A story whose assessment failed for good: its background task gave up after five attempts.
  for (const story of edition.stories.filter((s) => s.evaluation === 'fails')) {
    const doc = await Story.findOne({ headline: story.articles[0]!.title }, { _id: 1 }).lean();
    if (!doc) continue;
    const key = `discovery.evaluate:${runKey}:${String(doc._id)}`;
    await ensureTask({ key, kind: 'discovery.evaluate', runKey, storyId: doc._id });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await startTaskAttempt(key, attempt);
      await failTask(
        key,
        'unavailable: The model is overloaded (development fixture)',
        attempt === 5,
      );
    }
  }

  await recordSimulatedSearchUsage(edition, runKey);

  // Date the records to the edition, so "first seen" and the 7-day views read naturally.
  await WorkflowRun.collection.updateOne({ runKey }, { $set: { createdAt: at } });
  await Story.collection.updateMany({ firstSeenRunKey: runKey }, { $set: { createdAt: at } });
  await SourceArticle.collection.updateMany({ firstRunKey: runKey }, { $set: { createdAt: at } });
  await AiUsage.collection.updateMany({ runKey }, { $set: { createdAt: at } });
  await Task.collection.updateMany({ runKey }, { $set: { createdAt: at } });
  return runKey;
}

/** Search-provider usage as the real client would record it, marked simulated. */
export async function recordSimulatedSearchUsage(edition: ScenarioEdition, runKey: string) {
  const { AiUsage } = await getModels();
  const base = { provider: 'tavily', runKey, simulated: true };
  if (edition.searchUnauthorised) {
    await AiUsage.create({
      ...base,
      kind: 'search',
      operation: 'discovery.search',
      outcome: 'error',
      errorKind: 'auth',
    });
    return;
  }
  const failing = edition.failingQueries ?? 0;
  await AiUsage.create([
    ...Array.from({ length: 2 }, (_, i) => ({
      ...base,
      kind: 'search' as const,
      operation: 'discovery.search',
      ...(i < failing
        ? { outcome: 'error' as const, errorKind: 'unavailable' }
        : { outcome: 'ok' as const, units: 1 }),
    })),
    // While an edition is in progress the extract response hasn't reported its credits yet.
    {
      ...base,
      kind: 'extract' as const,
      operation: 'discovery.extract',
      outcome: 'ok' as const,
      units: edition.state === 'in_progress' ? null : 2,
    },
  ]);
  if (edition.key === 'full-edition') {
    // One assessment escalated to a priced model, to show a list-price estimate.
    await AiUsage.create({
      ...base,
      provider: 'anthropic',
      kind: 'llm',
      operation: 'discovery.evaluate',
      model: 'claude-opus-5-5',
      tier: 'escalation',
      inputTokens: 4_200,
      outputTokens: 1_800,
      outcome: 'ok',
    });
  }
}
