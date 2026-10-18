import { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import { BRIEF_SECTION_KINDS, type ResearchBriefDoc } from '../db/models/research-brief.js';
import type { SourceArticleDoc } from '../db/models/source-article.js';
import type { StoryDoc } from '../db/models/story.js';
import type { TaskDoc } from '../db/models/task.js';
import { pickPreviewImage } from '../discovery/images.js';
import {
  canonicalizeUrl,
  contentHash,
  hostOf,
  parseDate,
  publisherName,
} from '../discovery/normalize.js';
import { usageLimits } from '../config/runtime.js';
import type { FOLLOW_UP_SKIPS } from '../db/models/chat-message.js';
import { AppError, ConflictError, NotFoundError } from '../errors.js';
import type { LlmClient } from '../llm/client.js';
import { UsageLimitError, usageInWindow } from '../ops/budget.js';
import { SearchError, type SearchClient, type SearchHit } from '../search/types.js';
import {
  completeTask,
  createLockedTask,
  progressRecorder,
  type ProgressRecorder,
} from '../tasks/service.js';
import {
  checkClaims,
  flagConflicts,
  type CheckedClaim,
  type CitableSource,
  type DroppedClaim,
} from './citations.js';
import { judgeEvidence, type EvidenceCheck } from './evidence.js';
import type { FollowUpPlan } from './follow-up.js';
import { FOCUSED_RESEARCH_SYSTEM_PROMPT, RESEARCH_SYSTEM_PROMPT } from './prompts.js';
import { passagesFor } from './passages.js';
import { isRelevantToStory, storyAnchors } from './relevance.js';
import {
  focusedAnswerOutputSchema,
  researchBriefOutputSchema,
  type ResearchBriefOutput,
} from './schemas.js';

/**
 * Research briefs, bound to one story. Route handlers only create a locked task and enqueue it;
 * the worker runs `runResearch`. Chat replies are in `chat.ts` and share the story's lock (one
 * research or chat task at a time, a sparse-unique `activeLock`), so a reply never races a brief
 * still being written. Follow-up research only follows a lead the server already approved, and
 * search results unrelated to the story are discarded before anything is read or stored.
 */

export type ResearchDepth = 'standard' | 'in_depth';
export type ResearchRequestKind = 'auto' | 'manual' | 'lead' | 'followup';

export interface ResearchDeps {
  llm: LlmClient;
  search: SearchClient;
  now: () => Date;
}

const LIMITS = {
  standard: { searches: 2, newSources: 4, excerptChars: 5_000 },
  in_depth: { searches: 3, newSources: 6, excerptChars: 8_000 },
} as const;
const MAX_SOURCES = 10;
const MAX_CHAT_SOURCES = 12;

type SectionKind = (typeof BRIEF_SECTION_KINDS)[number];
/** The parts of a full brief (a focused follow-up has `answer` and `to_confirm` instead). */
const BRIEF_KINDS = ['overview', 'why_it_matters', 'findings', 'to_confirm', 'background'] as const;
const BRIEF_PART = {
  overview: 'overview',
  why_it_matters: 'whyItMatters',
  findings: 'findings',
  to_confirm: 'toConfirm',
  background: 'background',
} as const satisfies Record<(typeof BRIEF_KINDS)[number], keyof ResearchBriefOutput>;
const SECTION_TITLES: Record<SectionKind, string> = {
  overview: 'Overview',
  why_it_matters: 'Why it matters',
  findings: 'What we found',
  to_confirm: 'Still to confirm',
  background: 'Background',
  answer: 'Answer',
};
const STORED_CHARS = 20_000;
/** Sources found by a failed attempt are reused by a retry within this window. */
const REUSE_SOURCES_MS = 24 * 60 * 60_000;

const lockFor = (storyId: Types.ObjectId | string) => `story:${String(storyId)}`;

function toObjectId(id: string, what = 'Story'): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError(`${what} not found.`);
  return new Types.ObjectId(id);
}

async function findStory(storyId: string): Promise<StoryDoc> {
  const { Story } = await getModels();
  const story = await Story.findById(toObjectId(storyId)).lean();
  if (!story) throw new NotFoundError('Story not found.');
  return story;
}

/** One research or chat task at a time per story, so a reply never races a brief. */
function lockStory(input: {
  key: string;
  kind: 'research' | 'chat';
  storyId: Types.ObjectId;
  requestedBy: string;
  now: Date;
  extra?: Partial<Pick<TaskDoc, 'requestKind' | 'focus' | 'fromMessageId'>>;
}): Promise<TaskDoc> {
  return createLockedTask({
    ...input,
    lock: lockFor(input.storyId),
    busy: (holder) =>
      new ConflictError(
        'STORY_BUSY',
        !holder
          ? 'Something is already running for this story.'
          : holder.kind === 'chat'
            ? 'A reply is still being written for this story. Try again when it’s done.'
            : 'Research is already running for this story. Try again when it’s done.',
      ),
  });
}

/**
 * Requests a research brief. `auto` is Omenai starting the first brief when the workspace opens
 * (refused once one exists, so a stale page never spends credits again). A `lead` takes its focus
 * from an assistant reply the server already scoped to this story, never from client text.
 */
export async function requestResearch(input: {
  storyId: string;
  userId: string;
  depth: ResearchDepth;
  kind?: ResearchRequestKind;
  fromMessageId?: string;
  now?: Date;
}): Promise<{ taskKey: string }> {
  const story = await findStory(input.storyId);
  const { ResearchBrief, ChatMessage, Task } = await getModels();
  let kind: ResearchRequestKind = input.kind ?? 'manual';
  let focus: string | null = null;
  let fromMessageId: Types.ObjectId | null = null;
  let depth = input.depth;

  if (input.fromMessageId) {
    const lead = await ChatMessage.findOne({
      _id: toObjectId(input.fromMessageId, 'Lead'),
      storyId: story._id,
      role: 'assistant',
    }).lean();
    if (!lead?.suggestedFocus || lead.scope === 'unrelated' || lead.evidence === 'sufficient')
      throw new AppError('INVALID_LEAD', 'That lead can’t be researched for this story.', 422);
    // A reply's question is researched once; only research that failed can be tried again.
    if (
      await Task.exists({
        kind: 'research',
        fromMessageId: lead._id,
        status: { $in: ['queued', 'running', 'succeeded'] },
      })
    )
      throw new ConflictError('ALREADY_RESEARCHED', 'Omenai has already looked into this.');
    // Trying again after research the reply started itself keeps its question and depth.
    kind = lead.followUp ? 'followup' : 'lead';
    focus = lead.followUp?.question ?? lead.suggestedFocus;
    if (lead.followUp?.depth === 'in_depth') depth = 'in_depth';
    fromMessageId = lead._id;
  } else if (kind === 'lead' || kind === 'followup') {
    kind = 'manual';
  }
  if (kind === 'auto' && (await ResearchBrief.exists({ storyId: story._id })))
    throw new ConflictError('ALREADY_RESEARCHED', 'This story has already been researched.');

  const key = `research:${depth}:${String(story._id)}:${new Types.ObjectId().toHexString()}`;
  await lockStory({
    key,
    kind: 'research',
    storyId: story._id,
    requestedBy: input.userId,
    now: input.now ?? new Date(),
    extra: { requestKind: kind, focus, fromMessageId },
  });
  return { taskKey: key };
}

export type FollowUpSkip = (typeof FOLLOW_UP_SKIPS)[number];

/**
 * The most one follow-up can use, checked before it starts so that research the daily limits
 * would stop isn't started at all: its searches and one extract (five pages a credit), and one
 * model call (a repair round, if needed, is checked when it happens).
 */
const FOLLOW_UP_CREDITS: Record<ResearchDepth, number> = {
  standard: LIMITS.standard.searches + Math.ceil(LIMITS.standard.newSources / 5),
  in_depth: LIMITS.in_depth.searches + Math.ceil(LIMITS.in_depth.newSources / 5),
};

async function withinUsageLimits(depth: ResearchDepth, now: Date): Promise<boolean> {
  const limits = usageLimits();
  if (limits.aiCalls === null && limits.searchCredits === null) return true;
  const used = await usageInWindow(now);
  return (
    (limits.aiCalls === null || used.aiCalls + 1 <= limits.aiCalls) &&
    (limits.searchCredits === null ||
      used.searchCredits + FOLLOW_UP_CREDITS[depth] <= limits.searchCredits)
  );
}

/**
 * Starts focused research for a saved chat reply whose question the saved research didn't settle
 * (ADR-038): a research task holding the story's lock, keyed by the reply so it can never run twice
 * for it. Records on the reply that it started, or why it didn't. Never throws: the reply is
 * already saved, and a reason is shown instead. The caller hands a started task to the worker.
 */
export async function startFollowUpResearch(input: {
  storyId: Types.ObjectId;
  messageId: Types.ObjectId;
  requestedBy: string;
  plan: FollowUpPlan;
  now: Date;
}): Promise<{ taskKey: string } | { skipped: FollowUpSkip }> {
  const { plan } = input;
  const { Task, ChatMessage } = await getModels();
  const key = `research:${plan.depth}:${String(input.storyId)}:${String(input.messageId)}`;
  const record = (followUp: Record<string, unknown>) =>
    ChatMessage.updateOne(
      { _id: input.messageId },
      { $set: { followUp: { question: plan.question, depth: plan.depth, ...followUp } } },
    );
  const skip = async (reason: FollowUpSkip) => {
    await record({ status: 'skipped', reason, taskKey: null }).catch(() => undefined);
    return { skipped: reason };
  };
  try {
    if (!(await Task.exists({ key }))) {
      if (!(await withinUsageLimits(plan.depth, input.now))) return await skip('usage_limit');
      try {
        await lockStory({
          key,
          kind: 'research',
          storyId: input.storyId,
          requestedBy: input.requestedBy,
          now: input.now,
          extra: { requestKind: 'followup', focus: plan.question, fromMessageId: input.messageId },
        });
      } catch (error) {
        if (error instanceof ConflictError) return await skip('busy');
        throw error;
      }
    }
    await record({ status: 'started', reason: null, taskKey: key });
    return { taskKey: key };
  } catch (error) {
    console.error('Follow-up research could not be started', error);
    return await skip('error');
  }
}

export async function postChatMessage(input: {
  storyId: string;
  userId: string;
  content: string;
  now?: Date;
}): Promise<{ taskKey: string; messageId: string }> {
  const story = await findStory(input.storyId);
  const { ResearchBrief, ChatMessage, Task } = await getModels();
  const brief = await ResearchBrief.findOne({ storyId: story._id }, { _id: 1 })
    .sort({ createdAt: -1 })
    .lean();
  if (!brief)
    throw new ConflictError(
      'NO_BRIEF',
      'You can ask questions once the story has a research brief.',
    );
  const key = `chat:${String(story._id)}:${new Types.ObjectId().toHexString()}`;
  await lockStory({
    key,
    kind: 'chat',
    storyId: story._id,
    requestedBy: input.userId,
    now: input.now ?? new Date(),
  });
  try {
    const message = await ChatMessage.create({
      storyId: story._id,
      role: 'user',
      content: input.content,
      userId: input.userId,
      briefId: brief._id,
    });
    return { taskKey: key, messageId: String(message._id) };
  } catch (error) {
    await Task.updateOne(
      { key },
      { $set: { status: 'failed', lastError: 'Message not saved.' }, $unset: { activeLock: '' } },
    );
    throw error;
  }
}

/** Releases a task that could not be handed to the background worker. */
export async function abandonTask(key: string, reason: string): Promise<void> {
  const { Task } = await getModels();
  await Task.updateOne(
    { key },
    {
      $set: { status: 'failed', lastError: reason, finishedAt: new Date() },
      $unset: { activeLock: '' },
    },
  );
}

export const WORKER_UNAVAILABLE = () =>
  new AppError(
    'WORKER_UNAVAILABLE',
    'The background service couldn’t be reached, so nothing was started. Please try again in a moment.',
    503,
  );

// ── Research ────────────────────────────────────────────────────────────────

function dateOf(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : 'date unknown';
}

/** Deterministic queries from the story (and an approved focus): no model call chooses them. */
export function researchQueries(
  story: Pick<StoryDoc, 'headline' | 'entities' | 'geography'>,
  depth: ResearchDepth,
  focus: string | null = null,
): string[] {
  const place = story.geography?.[0];
  const where = place ? (place.city ?? place.country) : '';
  const entities = (story.entities ?? []).slice(0, 2).join(' ');
  const anchor = (story.entities ?? [])[0] ?? where;
  // A focus usually names its subject already ("When was Alisa LaGamma appointed…"): don't
  // repeat it ("Alisa LaGamma When was Alisa LaGamma appointed…", seen live on 2026-10-16).
  const has = (term: string) => !term || (focus ?? '').toLowerCase().includes(term.toLowerCase());
  const queries = focus
    ? [
        (has(anchor) ? focus : `${anchor} ${focus}`).trim().slice(0, 200),
        (has(where) ? `${focus} ${story.headline.slice(0, 60)}` : `${focus} ${where}`)
          .trim()
          .slice(0, 200),
        `${story.headline.slice(0, 80)} ${focus}`.slice(0, 200),
      ]
    : [
        story.headline.slice(0, 120),
        entities ? `${entities} ${where}`.trim() : '',
        `${story.headline.slice(0, 80)} background history`,
      ];
  return [...new Set(queries.filter(Boolean))].slice(0, LIMITS[depth].searches);
}

function researchPrompt(
  story: StoryDoc,
  sources: ReadonlyArray<{ label: string; article: SourceArticleDoc }>,
  excerptChars: number,
  focus: string | null,
  depth: ResearchDepth,
): string {
  const places = (story.geography ?? [])
    .map((g) => (g.city ? `${g.city}, ${g.country}` : g.country))
    .join('; ');
  const card = [
    `HEADLINE: ${story.headline}`,
    story.summary ? `SUMMARY: ${story.summary}` : null,
    story.whyItMatters ? `WHY IT MATTERS (assessment): ${story.whyItMatters}` : null,
    story.angle ? `ANGLE (assessment): ${story.angle}` : null,
    places ? `PLACES: ${places}` : null,
    story.verificationNeeds?.length
      ? `ALREADY FLAGGED TO CHECK: ${story.verificationNeeds.join(' | ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
  const list = sources
    .map(
      ({ label, article }) =>
        `${label} | ${article.publisher} | published ${dateOf(article.publishedAt)} | ${article.originalHeadline}\n` +
        `${article.origin === 'research' ? '[found during research]\n' : ''}` +
        `${article.extractionStatus === 'extracted' ? '' : '[snippet only; full text unavailable]\n'}` +
        // A focused question reads the passages that bear on it; a full brief reads the opening.
        passagesFor(article.content || article.snippet, focus, excerptChars),
    )
    .join('\n---\n');
  return `STORY AS ASSESSED:\n${card}\n\n${depth === 'in_depth' ? 'DEPTH: in depth\n\n' : ''}${focus ? `FOCUS: ${focus}\n\n` : ''}SOURCES:\n${list}`;
}

/** Sources a failed attempt for the same story and focus already found (no new search). */
async function reusableSources(task: TaskDoc, now: Date): Promise<Types.ObjectId[] | null> {
  if (task.foundSourceIds) return task.foundSourceIds;
  const { Task } = await getModels();
  const earlier = await Task.findOne({
    storyId: task.storyId,
    kind: 'research',
    status: 'failed',
    focus: task.focus ?? null,
    foundSourceIds: { $exists: true },
    updatedAt: { $gte: new Date(now.getTime() - REUSE_SOURCES_MS) },
  })
    .sort({ updatedAt: -1 })
    .lean();
  return earlier?.foundSourceIds ?? null;
}

/**
 * Searches, discards results unrelated to the story, then persists every remaining source before
 * any model sees it. The ids are saved on the task so a retry reuses them without searching again.
 */
async function gatherResearchSources(input: {
  story: StoryDoc;
  task: TaskDoc;
  depth: ResearchDepth;
  known: ReadonlySet<string>;
  deps: ResearchDeps;
  progress: ProgressRecorder;
}): Promise<{
  articles: SourceArticleDoc[];
  queries: string[];
  searchFailures: number;
  discarded: number;
}> {
  const { story, task, depth, deps, progress } = input;
  const { SourceArticle, Task } = await getModels();
  const taskKey = task.key;
  const queries = researchQueries(story, depth, task.focus ?? null);

  const reuse = await reusableSources(task, deps.now());
  if (reuse) {
    const articles = await SourceArticle.find({ _id: { $in: reuse } }).lean();
    await Task.updateOne({ key: taskKey }, { $set: { foundSourceIds: reuse } });
    progress.count({ reused: articles.length });
    return { articles, queries, searchFailures: 0, discarded: task.discardedResults ?? 0 };
  }

  const context = { storyId: String(story._id), taskId: taskKey };
  const anchors = storyAnchors({ ...story, focus: task.focus });
  const hits = new Map<string, SearchHit & { query: string }>();
  let searchFailures = 0;
  const discardedUrls = new Set<string>();
  for (const query of queries) {
    try {
      const results = await deps.search.search(
        query,
        {
          maxResults: 5,
          timeRange: 'year',
          topic: 'general',
          languages: ['en'],
          purpose: 'research',
        },
        context,
      );
      for (const hit of results) {
        const canonical = canonicalizeUrl(hit.url);
        if (!canonical || input.known.has(canonical) || hits.has(canonical)) continue;
        if (!isRelevantToStory(`${hit.title} ${hit.snippet}`, anchors)) {
          discardedUrls.add(canonical);
          continue;
        }
        hits.set(canonical, { ...hit, query });
      }
    } catch (error) {
      // A usage limit or a bad key won't clear by trying the next query: stop, and say so.
      if (error instanceof UsageLimitError) throw error;
      if (error instanceof SearchError && !error.retryable && error.kind !== 'invalid_request')
        throw error;
      // Otherwise a brief can still be written from the story's own sources; the gap is recorded.
      searchFailures += 1;
    }
  }
  // A focused question is researched to find new evidence. If no search worked, its answer could
  // only repeat the saved research and would read as "not established": a failure must never look
  // like an answer. Fail instead, so the task is retried or the editor sees what happened.
  if (task.focus && queries.length && searchFailures === queries.length)
    throw new SearchError(
      'unavailable',
      'Every search for this question failed, so no new sources could be looked for.',
    );
  const discarded = discardedUrls.size;
  const chosen = [...hits.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, LIMITS[depth].newSources);

  progress.count({ found: chosen.length, setAside: discarded });
  const ids: Types.ObjectId[] = [];
  if (chosen.length) {
    progress.step('read', { articles: chosen.length });
    const { pages } = await deps.search.extract(
      chosen.map(([, hit]) => hit.url),
      context,
      { purpose: 'research' },
    );
    const now = deps.now();
    for (const page of pages) {
      const canonical = canonicalizeUrl(page.url);
      const hit = canonical ? hits.get(canonical) : undefined;
      if (!canonical || !hit || !page.content.trim()) continue;
      const content = page.content.slice(0, STORED_CHARS);
      const image = pickPreviewImage(page.images, page.content);
      const host = hostOf(canonical);
      // Upsert: an article discovery already stored keeps its record (and its evidence text).
      const doc = await SourceArticle.findOneAndUpdate(
        { canonicalUrl: canonical },
        {
          $setOnInsert: {
            canonicalUrl: canonical,
            url: hit.url,
            host,
            publisher: publisherName(host),
            originalHeadline: (page.title ?? hit.title).trim() || canonical,
            publishedAt: parseDate(hit.publishedDate),
            retrievedAt: now,
            origin: 'research',
            snippet: hit.snippet.slice(0, 2_000),
            content,
            contentHash: contentHash(content),
            extractionStatus: 'extracted',
            lastCheckedAt: now,
            searchQuery: hit.query,
            searchScore: hit.score,
            ...(image ? { image: { ...image, capturedAt: now, rights: 'unverified' } } : {}),
          },
        },
        { upsert: true, returnDocument: 'after', projection: { _id: 1 } },
      ).lean();
      if (doc) ids.push(doc._id);
    }
  }
  await Task.updateOne(
    { key: taskKey },
    { $set: { foundSourceIds: ids, discardedResults: discarded } },
  );
  const articles = await SourceArticle.find({ _id: { $in: ids } }).lean();
  if (chosen.length) progress.count({ articles: articles.length });
  return { articles, queries, searchFailures, discarded };
}

/**
 * Writes a research brief for a queued research task. Idempotent per task: a retry after the
 * brief was saved only completes the task.
 */
export async function runResearch(input: { taskKey: string; deps: ResearchDeps }): Promise<{
  briefId: string;
}> {
  const { taskKey, deps } = input;
  const { Task, Story, SourceArticle, ResearchBrief } = await getModels();
  const task = await Task.findOne({ key: taskKey }).lean();
  if (!task?.storyId) throw new NotFoundError('Research task not found.');
  const done = await ResearchBrief.findOne({ taskId: taskKey }, { _id: 1 }).lean();
  if (done) {
    await completeTask(taskKey);
    return { briefId: String(done._id) };
  }
  const story = await Story.findById(task.storyId).lean();
  if (!story) throw new NotFoundError('Story not found.');
  const depth: ResearchDepth = taskKey.startsWith('research:in_depth:') ? 'in_depth' : 'standard';
  const focus = task.focus ?? null;

  // What the interface shows while this runs: only the steps actually taken, with their counts.
  const progress = progressRecorder(taskKey, deps.now);
  progress.step('sources');
  const own = await SourceArticle.find({ _id: { $in: story.sourceArticleIds } })
    .sort({ publishedAt: -1 })
    .limit(6)
    .lean();
  progress.count({ sources: own.length });

  progress.step('search');
  const research = await gatherResearchSources({
    story,
    task,
    depth,
    known: new Set(own.map((a) => a.canonicalUrl)),
    deps,
    progress,
  });

  const labelled = [...own, ...research.articles]
    .slice(0, MAX_SOURCES)
    .map((article, i) => ({ label: `S${i + 1}`, article }));
  if (labelled.length === 0) throw new AppError('NO_SOURCES', 'This story has no sources.', 422);

  progress.step('write', { sources: labelled.length });
  const notices = {
    onRetry: () => progress.notice('retrying'),
    onRepair: () => progress.notice('repairing'),
  };
  const tier = depth === 'in_depth' ? 'escalation' : 'primary';
  const content = researchPrompt(story, labelled, LIMITS[depth].excerptChars, focus, depth);
  const context = { storyId: String(story._id), taskId: taskKey };
  const citable = new Map<string, CitableSource>(
    labelled.map(({ label, article }) => [
      label,
      { label, id: String(article._id), text: article.content || article.snippet },
    ]),
  );
  const known = (labels: readonly string[]) => labels.filter((l) => citable.has(l));
  const dropped: DroppedClaim[] = [];
  const check = (claims: Parameters<typeof checkClaims>[0]): CheckedClaim[] => {
    const checked = checkClaims(claims, citable);
    dropped.push(...checked.dropped);
    return checked.claims;
  };

  let written: {
    model: string;
    sections: Array<{ kind: SectionKind; title: string; claims: CheckedClaim[] }>;
    overview: string;
    peopleToApproach: Array<{ name: string; role: string; why: string; sourceLabels: string[] }>;
    verificationChecklist: string[];
    evidence: 'sufficient' | 'partial' | 'insufficient' | null;
    evidenceCheck: EvidenceCheck | null;
  };
  if (focus) {
    // A lead: the answer to one question, never a new briefing around it.
    const result = await deps.llm.generateObject({
      operation: 'research.focused',
      tier,
      system: FOCUSED_RESEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
      maxOutputTokens: 2_000,
      schema: focusedAnswerOutputSchema,
      context,
      ...notices,
    });
    progress.step('check');
    const answer = check(result.data.answer);
    const toConfirm = check(result.data.toConfirm);
    flagConflicts([...answer, ...toConfirm]);
    // The model's "sufficient" stands only if the checks bear it out (ADR-039).
    const judged = judgeEvidence({
      evidence: result.data.evidence,
      claims: answer,
      question: focus,
    });
    written = {
      model: result.model,
      sections: [
        { kind: 'answer' as const, title: SECTION_TITLES.answer, claims: answer },
        { kind: 'to_confirm' as const, title: SECTION_TITLES.to_confirm, claims: toConfirm },
      ].filter((section) => section.claims.length > 0),
      overview: answer.map((c) => c.text).join(' '),
      peopleToApproach: [],
      verificationChecklist: result.data.nextSteps,
      evidence: judged.evidence,
      evidenceCheck: judged.check,
    };
  } else {
    const result = await deps.llm.generateObject({
      operation: depth === 'in_depth' ? 'research.brief.in_depth' : 'research.brief',
      tier,
      system: RESEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
      maxOutputTokens: 6_000,
      schema: researchBriefOutputSchema,
      context,
      ...notices,
    });
    progress.step('check');
    const sections = BRIEF_KINDS.map((kind) => ({
      kind,
      title: SECTION_TITLES[kind],
      claims: check(result.data[BRIEF_PART[kind]]),
    })).filter((section) => section.claims.length > 0);
    // A date or figure one section gives differently from another is settled in neither.
    flagConflicts(sections.flatMap((section) => section.claims));
    written = {
      model: result.model,
      sections,
      // Only claims that passed the checks, so a dropped claim never survives in the overview.
      overview: (sections.find((s) => s.kind === 'overview')?.claims ?? [])
        .map((c) => c.text)
        .join(' '),
      peopleToApproach: result.data.peopleToApproach.map((p) => ({
        name: p.name,
        role: p.role,
        why: p.why,
        sourceLabels: known(p.sources),
      })),
      verificationChecklist: result.data.verificationChecklist,
      evidence: null,
      evidenceCheck: null,
    };
  }

  try {
    const brief = await ResearchBrief.create({
      storyId: story._id,
      taskId: taskKey,
      requestedBy: task.requestedBy,
      depth,
      requestKind: task.requestKind ?? 'manual',
      focus,
      fromMessageId: task.fromMessageId ?? null,
      discardedResults: research.discarded,
      searchFailures: research.searchFailures,
      model: written.model,
      tier,
      sources: labelled.map(({ label, article }) => ({
        label,
        sourceArticleId: article._id,
        contentHash: article.contentHash,
        origin: article.origin,
      })),
      searchQueries: research.queries,
      overview: written.overview,
      sections: written.sections,
      peopleToApproach: written.peopleToApproach,
      verificationChecklist: written.verificationChecklist,
      evidence: written.evidence,
      evidenceCheck: written.evidenceCheck,
      droppedClaims: dropped,
    });
    await completeTask(taskKey, 'succeeded', progress.final());
    return { briefId: String(brief._id) };
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const existing = (await ResearchBrief.findOne({ taskId: taskKey }, { _id: 1 }).lean())!;
    await completeTask(taskKey);
    return { briefId: String(existing._id) };
  }
}

// ── Shared with chat and drafts ─────────────────────────────────────────────

/**
 * One label space across several briefs (given newest first; the oldest brief's sources are
 * labelled first): each stored source gets a single S-label, so a chat reply or a draft can cite
 * evidence from the first brief or a later focused one.
 */
export function labelBriefSources(
  briefs: readonly ResearchBriefDoc[],
  articles: ReadonlyMap<string, SourceArticleDoc>,
  max = MAX_CHAT_SOURCES,
  options: { citedFirst?: boolean } = {},
) {
  const labelOf = new Map<string, string>();
  const ordered: Array<{ label: string; article: SourceArticleDoc }> = [];
  const add = (sourceArticleId: Types.ObjectId) => {
    const id = String(sourceArticleId);
    const article = articles.get(id);
    if (!article || labelOf.has(id) || ordered.length >= max) return;
    const label = `S${ordered.length + 1}`;
    labelOf.set(id, label);
    ordered.push({ label, article });
  };
  // Chat: the sources the briefs' points cite come first, newest brief first, so what later
  // research found is never crowded out of the limit by sources nothing relies on.
  if (options.citedFirst)
    for (const brief of briefs)
      for (const claim of brief.sections.flatMap((section) => section.claims))
        for (const label of claim.sourceLabels) {
          const source = brief.sources.find((s) => s.label === label);
          if (source) add(source.sourceArticleId);
        }
  for (const brief of [...briefs].reverse())
    for (const source of brief.sources) add(source.sourceArticleId);
  return { ordered, labelOf };
}
