import { PILLARS } from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import type { ChatMessageDoc } from '../db/models/chat-message.js';
import type { ResearchBriefDoc } from '../db/models/research-brief.js';
import type { SourceArticleDoc } from '../db/models/source-article.js';
import type { StoryDoc } from '../db/models/story.js';
import { AppError, NotFoundError } from '../errors.js';
import type { LlmClient } from '../llm/client.js';
import { parsePartialJson } from '../llm/partial-json.js';
import { LlmError, type RetryPolicy } from '../llm/types.js';
import { UsageLimitError } from '../ops/budget.js';
import {
  CHAT_STOPPED_MESSAGE,
  completeTask,
  failTask,
  progressRecorder,
  startTaskAttempt,
} from '../tasks/service.js';
import { checkClaims, type CitableSource } from './citations.js';
import { judgeEvidence } from './evidence.js';
import { planFollowUp } from './follow-up.js';
import { passagesFor } from './passages.js';
import { CHAT_SYSTEM_PROMPT } from './prompts.js';
import {
  CHAT_ANSWER_SCOPES,
  CHAT_ASSESSMENTS,
  chatAnswerSchema,
  type ChatAnswer,
} from './schemas.js';
import { labelBriefSources, startFollowUpResearch, type FollowUpSkip } from './service.js';

/**
 * The research assistant's replies, streamed (ADR-035). One model call reads the story's saved
 * research, judges what it means for the question (`assessment`) and writes the answer as
 * checkable statements; the text is passed on as it arrives, then every statement's quote is
 * checked against the stored sources before the reply is saved. The reply runs inside the web
 * request, bound by one deadline that includes retries ("Time budgets", ADR-036), and keeps the
 * story's lock, so it never races research or another reply. When the saved research doesn't
 * establish the answer, the reply starts focused research once it is saved (ADR-038).
 */

/** The whole reply, from the request arriving to the answer saved. */
export const CHAT_DEADLINE_MS = 60_000;
/** Kept back from the model for checking and saving the answer. */
const SAVE_RESERVE_MS = 5_000;
/** One attempt (one HTTP request) at most; the rest of the model's time allows one retry. */
const CHAT_ATTEMPT_MS = 25_000;
/** One quick retry of a rejected request (rate limited, overloaded) before any text arrives. */
const CHAT_RETRY: RetryPolicy = { attempts: 2, initialDelayMs: 1_000, maxDelayMs: 2_000 };
/** A repair round starts only with this much of the model's time left. */
const CHAT_MIN_REPAIR_MS = 10_000;
const CANCEL_POLL_MS = 1_000;
/** Text updates are passed on at most this often. */
const TEXT_EVENT_MS = 50;
const CHAT_HISTORY = 12;
/**
 * The research trail a reply reads: the latest full briefs and follow-ups (newest of up to
 * `TRAIL_LOADED`, all of which are checked before research on the same question is repeated).
 */
const TRAIL_LOADED = 30;
const TRAIL_FULL_BRIEFS = 2;
const TRAIL_FOLLOW_UPS = 8;

export interface ChatDeps {
  llm: LlmClient;
  now: () => Date;
}

export type ChatScope = (typeof CHAT_ANSWER_SCOPES)[number];
export type ChatAssessment = (typeof CHAT_ASSESSMENTS)[number];

export type ChatFailureCode =
  'stopped' | 'timeout' | 'unavailable' | 'usage_limit' | 'unchecked' | 'declined' | 'error';

/**
 * What a reply in progress reports, in order. `text` is the whole visible answer so far;
 * `context` says what the answer is being written from, once it has been read.
 */
export type ChatEvent =
  | { type: 'started' }
  | { type: 'context'; briefs: number; sources: number }
  | { type: 'retrying'; status: number }
  | { type: 'text'; text: string }
  | { type: 'checking' }
  /** The saved research didn't establish the answer: focused research has started for it. */
  | { type: 'research'; taskKey: string; question: string }
  /** It didn't establish the answer, but research didn't start (already done, busy, limits). */
  | { type: 'research_skipped'; reason: FollowUpSkip; question: string }
  | { type: 'done'; messageId: string }
  | { type: 'failed'; code: ChatFailureCode; message: string };

/** A reply the editor stopped: nothing is saved and the question stays. */
export class ChatStoppedError extends AppError {
  constructor() {
    super('STOPPED', 'You stopped this reply.', 409);
  }
}

/**
 * Replies running in this process, by task key: Stop handled by the same server instance ends a
 * reply at once. The flag on the task record (polled every second) covers other instances.
 */
const running = new Map<string, () => void>();

/** The reply for a question outside the workspace. Written by the server, never by a model. */
export function outOfScopeReply(headline: string): string {
  return `That’s outside what I can help with here. This workspace is for Omenai’s editorial research, starting with “${headline}”: ask me about the story and the people and institutions in it, how it fits Omenai’s coverage of art and culture, its wider cultural context, possible angles, or what still needs checking.`;
}

const LABEL_MARKER = /\s?\[\s*S\d{1,3}\s*\]/gi;

/** Statement text without source labels or doubled spaces (labels belong in `sources`). */
function cleanText(text: string): string {
  return text.replace(LABEL_MARKER, '').replace(/\s+/g, ' ').trim();
}

/**
 * The answer as far as it has arrived: its assessment once complete, and its statements' text so
 * far. A preview only; the reply that is saved is parsed and checked in full.
 */
export function readAnswerPreview(raw: string): {
  assessment: ChatAssessment | null;
  text: string;
} {
  const partial = parsePartialJson(raw) as
    { assessment?: unknown; statements?: Array<{ text?: unknown }> } | undefined;
  const assessment =
    typeof partial?.assessment === 'string' &&
    (CHAT_ASSESSMENTS as readonly string[]).includes(partial.assessment)
      ? (partial.assessment as ChatAssessment)
      : null;
  const text = (Array.isArray(partial?.statements) ? partial.statements : [])
    .map((s) => (typeof s?.text === 'string' ? cleanText(s.text) : ''))
    .filter(Boolean)
    .join(' ');
  return { assessment, text };
}

/** What ended a reply, in words for the editor (the error itself stays on the task record). */
function failureOf(error: unknown): { code: ChatFailureCode; message: string } {
  if (error instanceof ChatStoppedError) return { code: 'stopped', message: error.message };
  if (error instanceof UsageLimitError)
    return {
      code: 'usage_limit',
      message: 'Today’s AI usage limit has been reached. It frees up as earlier use ages out.',
    };
  if (error instanceof LlmError) {
    if (error.kind === 'timeout')
      return { code: 'timeout', message: 'This took longer than expected, so the reply stopped.' };
    if (error.kind === 'rate_limited' || error.kind === 'unavailable')
      return {
        code: 'unavailable',
        message: 'The AI service is busy right now and didn’t answer.',
      };
    if (error.kind === 'invalid_output' || error.kind === 'truncated')
      return {
        code: 'unchecked',
        message: 'The answer wasn’t in a form we could check, so it wasn’t kept.',
      };
    if (error.kind === 'refusal' || error.kind === 'safety_blocked')
      return { code: 'declined', message: 'The AI service declined to answer this.' };
  }
  return { code: 'error', message: 'Something went wrong while writing the reply.' };
}

const dateOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : 'date unknown');

type SavedClaim = ResearchBriefDoc['sections'][number]['claims'][number];

/**
 * How a saved point was checked, in the words the prompt explains: a fact whose quote wasn't found
 * (or lacks its date or figure) is unconfirmed, however it was phrased when it was saved.
 */
function howChecked(claim: SavedClaim): string {
  if (claim.type === 'analysis') return 'analysis';
  if (claim.type === 'open_question') return 'open question';
  if (claim.citationStatus === 'verified') return `${claim.type}, quote found`;
  if (claim.citationStatus === 'uncited') return `${claim.type}, no source`;
  if (claim.citationStatus === 'conflicting') return `${claim.type}, sources disagree`;
  return `${claim.type}, unconfirmed`;
}

/** The briefs a reply reads, newest first: the latest full briefs and the latest follow-ups. */
function researchTrail(briefs: readonly ResearchBriefDoc[]): ResearchBriefDoc[] {
  const full = briefs.filter((b) => !b.focus).slice(0, TRAIL_FULL_BRIEFS);
  const followUps = briefs.filter((b) => b.focus).slice(0, TRAIL_FOLLOW_UPS);
  return briefs.filter((b) => full.includes(b) || followUps.includes(b));
}

function chatPrompt(input: {
  story: StoryDoc;
  briefs: readonly ResearchBriefDoc[];
  ordered: ReadonlyArray<{ label: string; article: SourceArticleDoc }>;
  labelOf: ReadonlyMap<string, string>;
  history: readonly ChatMessageDoc[];
  question: string;
}): string {
  const { story, briefs, ordered, labelOf, history, question } = input;
  const places = (story.geography ?? [])
    .map((g) => (g.city ? `${g.city}, ${g.country}` : g.country))
    .join('; ');
  const pillar = story.primaryPillar ? PILLARS[story.primaryPillar]?.label : null;
  const card = [
    `HEADLINE: ${story.headline}`,
    story.summary ? `SUMMARY: ${story.summary}` : null,
    pillar ? `PILLAR (assessment): ${pillar}` : null,
    places ? `PLACES: ${places}` : null,
    story.whyItMatters ? `WHY IT MATTERS (assessment): ${story.whyItMatters}` : null,
    story.angle ? `ANGLE (assessment): ${story.angle}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const relabel = (brief: ResearchBriefDoc, labels: readonly string[]) =>
    labels
      .map((label) => {
        const source = brief.sources.find((s) => s.label === label);
        return source ? labelOf.get(String(source.sourceArticleId)) : undefined;
      })
      .filter((l): l is string => Boolean(l));
  const briefText = [...briefs]
    .reverse()
    .map((brief) =>
      [
        // Dated, and a follow-up says what it was asked and how fully its sources answered it.
        // The overview is already a section, except on briefs written before sections had kinds.
        `BRIEF ${dateOf(brief.createdAt)}${brief.focus ? ` (follow-up question: ${brief.focus}; its sources answered it: ${brief.evidence ?? 'not recorded'})` : ''}:${brief.sections.some((s) => s.kind === 'overview' || s.kind === 'answer') ? '' : ` ${brief.overview}`}`,
        ...brief.sections.flatMap((section) => [
          `## ${section.title}`,
          ...section.claims.map((c) => {
            const labels = relabel(brief, c.sourceLabels);
            // Only a quote found in its source is passed on, so it can be reused as found.
            const quote =
              c.citationStatus === 'verified' && c.excerpt ? ` Quote: "${c.excerpt}"` : '';
            return `- (${howChecked(c)}) ${c.text}${labels.length ? ` [${labels.join(', ')}]` : ''}${quote}`;
          }),
        ]),
      ].join('\n'),
    )
    .join('\n\n');
  const sourceText = ordered
    .map(
      ({ label, article }) =>
        `${label} | ${article.publisher} | published ${dateOf(article.publishedAt)} | ${article.originalHeadline}\n` +
        // The passages that bear on this question, not just the opening (often navigation).
        passagesFor(article.content || article.snippet, question, 3_000),
    )
    .join('\n---\n');
  const conversation = history
    .map((m) => `${m.role === 'user' ? 'EDITOR' : 'ASSISTANT'}: ${m.content}`)
    .join('\n');
  return `STORY:\n${card}\n\nRESEARCH BRIEFS:\n${briefText}\n\nSOURCES:\n${sourceText}\n\n${conversation ? `CONVERSATION SO FAR:\n${conversation}\n\n` : ''}QUESTION: ${question}`;
}

/**
 * Writes the reply to the latest question of a chat task, passing its text on as it arrives.
 * Idempotent per task (the reply's `taskId` is unique). Ends one of three ways:
 * - saved: `done` (the reply was checked and stored, the lock released)
 * - stopped: the editor pressed Stop; nothing is saved, the question stays
 * - failed: deadline, provider or database failure; nothing partial is saved
 * A stopped or failed reply emits `failed` and throws; the lock is released either way.
 */
export async function streamChatReply(input: {
  taskKey: string;
  deps: ChatDeps;
  onEvent?: (event: ChatEvent) => void;
  /** When the request arrived (epoch ms): the deadline counts from here. */
  receivedAt?: number;
}): Promise<{ messageId: string; followUp: { taskKey: string } | null }> {
  const { taskKey, deps } = input;
  const emit = (event: ChatEvent) => {
    try {
      input.onEvent?.(event);
    } catch {
      // A listener that went away (a closed connection) never stops the reply being saved.
    }
  };
  const deadlineAt = (input.receivedAt ?? Date.now()) + CHAT_DEADLINE_MS;
  const { Task, Story, ResearchBrief, ChatMessage, SourceArticle } = await getModels();
  const task = await Task.findOne({ key: taskKey }).lean();
  if (!task?.storyId || task.kind !== 'chat') throw new NotFoundError('Chat task not found.');
  const existing = await ChatMessage.findOne({ taskId: taskKey }, { _id: 1 }).lean();
  if (existing) {
    await completeTask(taskKey);
    emit({ type: 'done', messageId: String(existing._id) });
    return { messageId: String(existing._id), followUp: null };
  }
  if (task.status === 'failed' || task.status === 'succeeded')
    throw new AppError('REPLY_ENDED', 'This reply has already ended.', 409);

  const controller = new AbortController();
  // The same steps on the task record, so a page opened mid-reply shows where it has got to.
  const progress = progressRecorder(taskKey, deps.now);
  let ended: 'stopped' | 'unrelated' | null = null;
  let finished = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  // Stop is a flag on the task record, so it works whichever server instance runs the reply.
  const pollForStop = () => {
    pollTimer = setTimeout(() => {
      Task.findOne({ key: taskKey }, { cancelRequested: 1 })
        .lean()
        .then((current) => {
          if (finished || ended) return;
          if (current?.cancelRequested) {
            ended = 'stopped';
            controller.abort();
          } else pollForStop();
        })
        .catch(() => {
          if (!finished && !ended) pollForStop();
        });
    }, CANCEL_POLL_MS);
    pollTimer.unref?.();
  };

  running.set(taskKey, () => {
    if (finished || ended) return;
    ended = 'stopped';
    controller.abort();
  });
  try {
    await startTaskAttempt(taskKey, 1, null);
    progress.step('read');
    emit({ type: 'started' });
    pollForStop();

    const [story, loadedBriefs, recent] = await Promise.all([
      Story.findById(task.storyId).lean(),
      ResearchBrief.find({ storyId: task.storyId })
        .sort({ createdAt: -1 })
        .limit(TRAIL_LOADED)
        .lean(),
      ChatMessage.find({ storyId: task.storyId })
        .sort({ createdAt: -1 })
        .limit(CHAT_HISTORY)
        .lean(),
    ]);
    if (!story) throw new NotFoundError('Story not found.');
    const briefs = researchTrail(loadedBriefs);
    const latest = briefs[0];
    if (!latest) throw new AppError('NO_BRIEF', 'There is no research brief to answer from.', 409);
    const history = [...recent].reverse();
    const question = history.findLast((m) => m.role === 'user');
    if (!question) throw new AppError('NO_QUESTION', 'There is no question to answer.', 409);

    const articles = new Map(
      (
        await SourceArticle.find({
          _id: { $in: briefs.flatMap((b) => b.sources.map((s) => s.sourceArticleId)) },
        }).lean()
      ).map((a) => [String(a._id), a]),
    );
    const { ordered, labelOf } = labelBriefSources(briefs, articles, undefined, {
      citedFirst: true,
    });
    const context = { storyId: String(task.storyId), taskId: taskKey };
    progress.count({ briefs: briefs.length, sources: ordered.length });
    progress.step('compose');
    emit({ type: 'context', briefs: briefs.length, sources: ordered.length });

    const save = async (fields: Record<string, unknown>) => {
      try {
        const message = await ChatMessage.create({
          storyId: story._id,
          role: 'assistant',
          briefId: latest._id,
          taskId: taskKey,
          ...fields,
        });
        await completeTask(taskKey, 'succeeded', progress.final());
        return { messageId: String(message._id) };
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        const saved = (await ChatMessage.findOne({ taskId: taskKey }, { _id: 1 }).lean())!;
        await completeTask(taskKey, 'succeeded', progress.final());
        return { messageId: String(saved._id) };
      }
    };
    const redirect = async (model: string | null) => ({
      ...(await save({
        content: outOfScopeReply(story.headline),
        scope: 'unrelated',
        assessment: 'out_of_scope',
        model,
      })),
      followUp: null,
    });

    let shown = '';
    let sent = '';
    let lastSent = 0;
    const sendText = () => {
      textTimer = undefined;
      lastSent = Date.now();
      if (ended || shown === sent) return;
      if (!sent) progress.step('write');
      sent = shown;
      emit({ type: 'text', text: shown });
    };
    const onText = (raw: string) => {
      if (ended) return;
      const preview = readAnswerPreview(raw);
      if (preview.assessment === 'out_of_scope') {
        // The server writes this reply; nothing the model drafts for it is shown.
        ended = 'unrelated';
        controller.abort();
        return;
      }
      if (!preview.text || preview.text === shown) return;
      shown = preview.text;
      if (Date.now() - lastSent >= TEXT_EVENT_MS) sendText();
      else textTimer ??= setTimeout(sendText, TEXT_EVENT_MS);
    };

    let answer: ChatAnswer;
    let model: string;
    try {
      const result = await deps.llm.streamObject({
        operation: 'chat.reply',
        tier: 'primary',
        effort: 'low',
        system: CHAT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: chatPrompt({
              story,
              briefs,
              ordered,
              labelOf,
              history: history.filter((m) => m !== question),
              question: question.content,
            }),
          },
        ],
        maxOutputTokens: 1_500,
        schema: chatAnswerSchema,
        context,
        deadlineAt: deadlineAt - SAVE_RESERVE_MS,
        attemptTimeoutMs: CHAT_ATTEMPT_MS,
        retry: CHAT_RETRY,
        minRepairMs: CHAT_MIN_REPAIR_MS,
        signal: controller.signal,
        onText,
        onRetry: (status) => {
          progress.notice('retrying');
          emit({ type: 'retrying', status });
        },
      });
      answer = result.data;
      model = result.model;
    } catch (error) {
      if (ended === 'unrelated') {
        const saved = await redirect(null);
        emit({ type: 'done', messageId: saved.messageId });
        return saved;
      }
      if (ended === 'stopped') throw new ChatStoppedError();
      throw error;
    } finally {
      clearTimeout(textTimer);
    }
    // A stop that arrived while the answer was being finished still counts.
    if (ended === 'stopped') throw new ChatStoppedError();
    // The last piece may have been held back by the throttle: show the whole answer first.
    sendText();
    progress.step('check');
    emit({ type: 'checking' });

    if (answer.assessment === 'out_of_scope') {
      const saved = await redirect(model);
      emit({ type: 'done', messageId: saved.messageId });
      return saved;
    }
    const citable = new Map<string, CitableSource>(
      ordered.map(({ label, article }) => [
        label,
        { label, id: String(article._id), text: article.content || article.snippet },
      ]),
    );
    const checked = checkClaims(
      answer.statements.map((s) => ({ ...s, text: cleanText(s.text) })).filter((s) => s.text),
      citable,
    );
    // The model's "sufficient" stands only if the checks bear it out (ADR-039). One they don't is
    // a gap like any other, for an in-scope factual question (judgement questions aren't researched),
    // with the editor's own question when the model gave none.
    const judged = judgeEvidence({
      evidence: answer.evidence,
      claims: checked.claims,
      // A judgement question isn't held to the date-or-figure rule, whatever its wording.
      question: answer.scope === 'editorial' ? null : question.content,
    });
    const lowered =
      judged.check !== null && answer.assessment === 'sufficient' && answer.scope !== 'editorial';
    const assessment = lowered ? 'needs_research' : answer.assessment;
    const researchQuestion = (
      answer.researchQuestion.replace(/\s+/g, ' ').trim() || (lowered ? question.content : '')
    ).slice(0, 300);
    // Whether the saved research leaves a gap that research should fill: that judgement, with the
    // rules around it (no repeat of recent research on the same question).
    const decision = planFollowUp({
      answer: {
        assessment,
        evidence: judged.evidence ?? answer.evidence,
        researchQuestion,
        researchDepth: answer.researchDepth,
      },
      briefs: loadedBriefs,
      now: deps.now(),
    });
    const saved = await save({
      content:
        checked.claims.map((c) => c.text).join(' ') ||
        'I couldn’t answer that from the research so far.',
      model,
      claims: checked.claims.map((c) => ({
        ...c,
        sourceArticleIds: c.sourceArticleIds.map((id) => new Types.ObjectId(id)),
      })),
      droppedClaims: checked.dropped.length,
      scope: answer.scope,
      assessment,
      evidence: judged.evidence,
      evidenceCheck: judged.check,
      // The research question stays on the reply, so it can still be researched by hand.
      suggestedFocus: assessment === 'needs_research' && researchQuestion ? researchQuestion : null,
      ...(decision?.kind === 'already_researched'
        ? {
            followUp: {
              status: 'skipped',
              reason: 'already_researched',
              question: decision.question,
              depth: 'standard',
              taskKey: null,
            },
          }
        : {}),
    });
    let followUp: { taskKey: string } | null = null;
    if (decision?.kind === 'research') {
      // The reply is saved and the story unlocked: the research takes the lock next.
      const started = await startFollowUpResearch({
        storyId: story._id,
        messageId: new Types.ObjectId(saved.messageId),
        requestedBy: task.requestedBy ?? 'unknown',
        plan: decision.plan,
        now: deps.now(),
      });
      if ('taskKey' in started) {
        followUp = started;
        emit({ type: 'research', taskKey: started.taskKey, question: decision.plan.question });
      } else {
        emit({
          type: 'research_skipped',
          reason: started.skipped,
          question: decision.plan.question,
        });
      }
    } else if (decision?.kind === 'already_researched') {
      emit({ type: 'research_skipped', reason: 'already_researched', question: decision.question });
    }
    emit({ type: 'done', messageId: saved.messageId });
    return { messageId: saved.messageId, followUp };
  } catch (error) {
    const stopped = error instanceof ChatStoppedError;
    const failure = failureOf(error);
    await failTask(
      taskKey,
      stopped ? CHAT_STOPPED_MESSAGE : error instanceof Error ? error.message : String(error),
      true,
    ).catch(() => undefined);
    emit({ type: 'failed', ...failure });
    throw error;
  } finally {
    finished = true;
    running.delete(taskKey);
    clearTimeout(pollTimer);
  }
}

/** The same reply without streaming (the fixture seed, tests and scripted runs). */
export function runChatReply(input: {
  taskKey: string;
  deps: ChatDeps;
}): Promise<{ messageId: string; followUp: { taskKey: string } | null }> {
  return streamChatReply(input);
}

/**
 * Asks a running reply to stop: at once if this process is running it, otherwise within about a
 * second (the reply checks the flag on its task). It ends without saving anything. Returns false
 * when there was nothing running to stop.
 */
export async function requestChatStop(input: {
  storyId: string;
  taskKey: string;
}): Promise<boolean> {
  if (!Types.ObjectId.isValid(input.storyId)) return false;
  const { Task } = await getModels();
  const result = await Task.updateOne(
    {
      key: input.taskKey,
      storyId: new Types.ObjectId(input.storyId),
      kind: 'chat',
      activeLock: { $exists: true },
    },
    { $set: { cancelRequested: true } },
  );
  if (result.matchedCount > 0) running.get(input.taskKey)?.();
  return result.matchedCount > 0;
}
