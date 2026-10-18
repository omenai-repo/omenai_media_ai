import { STEP_NOTICES, type StepCounts, type StepNotice, type StepRecord } from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import type { CHAT_ASSESSMENTS, CHAT_SCOPES, FOLLOW_UP_SKIPS } from '../db/models/chat-message.js';
import { RESEARCH_REQUEST_KINDS } from '../db/models/task.js';
import { TASK_MAX_ATTEMPTS } from '../tasks/contracts.js';
import { abandonedMessage, staleAfterMs } from '../tasks/service.js';
import type {
  BRIEF_SECTION_KINDS,
  CITATION_STATUSES,
  CLAIM_TYPES,
  EVIDENCE_CHECKS,
} from '../db/models/research-brief.js';
import { NotFoundError } from '../errors.js';

/**
 * The research workspace's view of one story: every brief and every chat message, in order, with
 * sources resolved from our records (never from model text), plus any task running or recently
 * failed. The workspace polls it while work runs.
 */

type Status = (typeof CITATION_STATUSES)[number];
type RequestKind = (typeof RESEARCH_REQUEST_KINDS)[number];
const requestKindOf = (kind: string | null | undefined): RequestKind | null =>
  (RESEARCH_REQUEST_KINDS as readonly string[]).includes(kind ?? '') ? (kind as RequestKind) : null;

export interface ResearchSourceDto {
  id: string;
  url: string;
  publisher: string;
  headline: string;
  publishedAt: string | null;
  origin: string;
  sourceQuality: string;
}

export interface BriefClaimDto {
  type: (typeof CLAIM_TYPES)[number];
  text: string;
  sourceLabels: string[];
  excerpt: string | null;
  citationStatus: Status;
}

export interface ResearchBriefDto {
  id: string;
  createdAt: string;
  depth: 'standard' | 'in_depth';
  /**
   * auto: started by Omenai; manual: an editor asked; lead: an editor chose to research a reply's
   * question; followup: the reply started it because the saved research didn't settle the question.
   */
  requestKind: RequestKind;
  requestedBy: string | null;
  focus: string | null;
  /** The assistant reply whose lead this brief follows up. */
  fromMessageId: string | null;
  overview: string;
  /** `kind` is null on briefs written before the concise format. */
  sections: Array<{
    kind: (typeof BRIEF_SECTION_KINDS)[number] | null;
    title: string;
    claims: BriefClaimDto[];
  }>;
  /** This brief's own labels (S1…) mapped to source ids. */
  sources: Array<{ label: string; sourceId: string }>;
  peopleToApproach: Array<{ name: string; role: string; why: string; sourceLabels: string[] }>;
  verificationChecklist: string[];
  droppedClaims: number;
  discardedResults: number;
  /** Searches that failed, so the brief may be missing sources. */
  searchFailures: number;
  /** Unconfirmed: the quote wasn't found, lacks a detail, is about something else, or conflicts. */
  counts: { verified: number; unconfirmed: number; uncited: number };
  /** Focused follow-ups: how fully the sources answer the question (null for briefs). */
  evidence: 'sufficient' | 'partial' | 'insufficient' | null;
  /** Why the checks lowered the model's own "sufficient" (ADR-039), if they did. */
  evidenceCheck: (typeof EVIDENCE_CHECKS)[number] | null;
}

/** A statement of a chat reply: its labels resolved to the stored sources they name. */
export interface ChatClaimDto extends BriefClaimDto {
  /** Source ids, in the order of `sourceLabels`. */
  sourceIds: string[];
}

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  author: string;
  createdAt: string;
  citations: Array<{
    label: string;
    sourceId: string;
    excerpt: string | null;
    citationStatus: Status;
  }>;
  droppedLabels: string[];
  /**
   * Replies since 2026-10-16: the answer as checked statements, each with its own sources and
   * quote. Null on earlier replies, which carry `citations` and markers in `content` instead.
   */
  claims: ChatClaimDto[] | null;
  /** Statements removed because they cited no source, or an unknown one. */
  droppedClaims: number;
  scope: (typeof CHAT_SCOPES)[number] | null;
  evidence: 'sufficient' | 'partial' | 'insufficient' | null;
  /** Why the checks lowered the model's own "sufficient" (ADR-039), if they did. */
  evidenceCheck: (typeof EVIDENCE_CHECKS)[number] | null;
  /** Present when the editor can ask Omenai to research this lead. */
  suggestedFocus: string | null;
  /** Replies since 2026-10-17: what the saved research meant for the question (ADR-038). */
  assessment: (typeof CHAT_ASSESSMENTS)[number] | null;
  /**
   * Research the reply started on its own (its findings are the brief whose `fromMessageId` is
   * this reply), or why it didn't start.
   */
  followUp: {
    status: 'started' | 'skipped';
    reason: (typeof FOLLOW_UP_SKIPS)[number] | null;
    question: string;
    taskKey: string | null;
  } | null;
}

/** Where a running task has got to, as recorded by the task itself (`progressRecorder`). */
export interface TaskProgressDto {
  status: string;
  /** Attempts started, and how many the worker makes before giving up. */
  attempts: number;
  maxAttempts: number;
  step: string | null;
  /** When the current step started. */
  stepStartedAt: string | null;
  /** The steps reached in the current attempt, in order. */
  steps: Array<StepRecord<string>>;
  notice: StepNotice | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface ResearchTaskDto extends TaskProgressDto {
  key: string;
  kind: 'research' | 'chat';
  message: string | null;
  requestKind: RequestKind | null;
  focus: string | null;
  fromMessageId: string | null;
  /** Who asked for it (a name, never an id). */
  requestedBy: string | null;
}

export interface ResearchViewDto {
  /** The server's time when this was read, so elapsed times don't depend on the browser's clock. */
  now: string;
  briefs: ResearchBriefDto[];
  messages: ChatMessageDto[];
  /** Every source any brief or reply refers to, by id. */
  sources: Record<string, ResearchSourceDto>;
  /** The research or chat task holding the story's lock. */
  activeTask: ResearchTaskDto | null;
  /** The latest research or chat task, if it failed after the latest result. */
  lastFailure: ResearchTaskDto | null;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * Work holding a lock that hasn't updated within its kind's abandoned-lock window has stopped (a
 * timeout or a process that went away never records an error): 45 minutes for background work,
 * 2 for a chat reply, which runs in a web request capped at 90 s. It is shown as stopped, not as
 * still running, and the next request takes over its lock.
 */
export function isStalled(
  task: { updatedAt?: Date | null; kind?: string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  return Boolean(
    task?.updatedAt && task.updatedAt < new Date(now.getTime() - staleAfterMs(task.kind)),
  );
}

/** A task's stored progress, as the interface reads it. */
export interface StoredProgressTask {
  kind: string;
  status?: string | null;
  attempts?: number | null;
  progress?: {
    step?: string | null;
    startedAt?: Date | null;
    steps?: Array<{ step: string; startedAt: Date; counts?: unknown }> | null;
    notice?: string | null;
  } | null;
  lastError?: string | null;
  updatedAt?: Date | null;
}

export function toTaskProgress(task: StoredProgressTask): TaskProgressDto {
  const notice = task.progress?.notice;
  return {
    status: task.status ?? 'queued',
    attempts: task.attempts ?? 0,
    maxAttempts:
      TASK_MAX_ATTEMPTS[task.kind as keyof typeof TASK_MAX_ATTEMPTS] ?? TASK_MAX_ATTEMPTS.research,
    step: task.progress?.step ?? null,
    stepStartedAt: iso(task.progress?.startedAt),
    steps: (task.progress?.steps ?? []).map((s) => ({
      step: s.step,
      startedAt: iso(s.startedAt)!,
      counts: (s.counts as StepCounts | null | undefined) ?? null,
    })),
    notice: (STEP_NOTICES as readonly string[]).includes(notice ?? '')
      ? (notice as StepNotice)
      : null,
    lastError: task.lastError ?? null,
    updatedAt: iso(task.updatedAt),
  };
}

function toTask(
  task: StoredProgressTask & {
    key: string;
    progress?: (StoredProgressTask['progress'] & { message?: string | null }) | null;
    requestKind?: string | null;
    focus?: string | null;
    fromMessageId?: Types.ObjectId | null;
    requestedBy?: string | null;
  },
  users: ReadonlyMap<string, string>,
): ResearchTaskDto {
  return {
    ...toTaskProgress(task),
    key: task.key,
    kind: task.kind === 'chat' ? 'chat' : 'research',
    message: task.progress?.message ?? null,
    requestKind: requestKindOf(task.requestKind),
    focus: task.focus ?? null,
    fromMessageId: task.fromMessageId ? String(task.fromMessageId) : null,
    requestedBy: task.requestedBy ? (users.get(task.requestedBy) ?? null) : null,
  };
}

type StoredMessage = Awaited<ReturnType<typeof loadMessages>>[number];
async function loadMessages(storyId: Types.ObjectId) {
  const { ChatMessage } = await getModels();
  return ChatMessage.find({ storyId }).sort({ createdAt: 1 }).limit(500).lean();
}

function toChatMessageDto(m: StoredMessage, users: ReadonlyMap<string, string>): ChatMessageDto {
  return {
    id: String(m._id),
    role: m.role,
    content: m.content,
    author:
      m.role === 'assistant'
        ? 'Omenai research'
        : ((m.userId ? users.get(m.userId) : undefined) ?? 'An editor'),
    createdAt: iso(m.createdAt)!,
    citations: m.citations.map((c) => ({
      label: c.label,
      sourceId: String(c.sourceArticleId),
      excerpt: c.excerpt ?? null,
      citationStatus: c.citationStatus,
    })),
    droppedLabels: m.droppedLabels,
    claims: m.claims?.length
      ? m.claims.map((c) => ({
          type: c.type,
          text: c.text,
          sourceLabels: c.sourceLabels,
          sourceIds: c.sourceArticleIds.map(String),
          excerpt: c.excerpt ?? null,
          citationStatus: c.citationStatus,
        }))
      : null,
    droppedClaims: m.droppedClaims ?? 0,
    scope: m.scope ?? null,
    evidence: m.evidence ?? null,
    evidenceCheck: m.evidenceCheck ?? null,
    suggestedFocus:
      m.role === 'assistant' && m.scope !== 'unrelated' && m.evidence !== 'sufficient'
        ? (m.suggestedFocus ?? null)
        : null,
    assessment: m.assessment ?? null,
    followUp: m.followUp
      ? {
          status: m.followUp.status,
          reason: m.followUp.reason ?? null,
          question: m.followUp.question,
          taskKey: m.followUp.taskKey ?? null,
        }
      : null,
  };
}

/**
 * One reply, as the workspace shows it: what the chat stream hands over when a reply is saved.
 * Its sources are already in the workspace's view (a reply cites only its research's sources).
 */
export async function getChatMessage(storyId: string, messageId: string): Promise<ChatMessageDto> {
  if (!Types.ObjectId.isValid(storyId) || !Types.ObjectId.isValid(messageId))
    throw new NotFoundError('Message not found.');
  const { ChatMessage } = await getModels();
  const message = await ChatMessage.findOne({
    _id: new Types.ObjectId(messageId),
    storyId: new Types.ObjectId(storyId),
  }).lean();
  if (!message) throw new NotFoundError('Message not found.');
  return toChatMessageDto(message, new Map());
}

export async function getResearchView(storyId: string): Promise<ResearchViewDto> {
  if (!Types.ObjectId.isValid(storyId)) throw new NotFoundError('Story not found.');
  const id = new Types.ObjectId(storyId);
  const { Story, ResearchBrief, Task, SourceArticle, AuthUser } = await getModels();
  if (!(await Story.exists({ _id: id }))) throw new NotFoundError('Story not found.');

  const [briefs, messages, active, latestTask] = await Promise.all([
    ResearchBrief.find({ storyId: id }).sort({ createdAt: 1 }).limit(50).lean(),
    loadMessages(id),
    // Drafts hold locks of their own; only research and chat block this workspace.
    Task.findOne({
      storyId: id,
      kind: { $in: ['research', 'chat'] },
      activeLock: { $exists: true },
    }).lean(),
    Task.findOne({ storyId: id, kind: { $in: ['research', 'chat'] } })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const userIds = [
    ...new Set(
      [
        ...briefs.map((b) => b.requestedBy),
        ...messages.map((m) => m.userId),
        active?.requestedBy,
        latestTask?.requestedBy,
      ].filter((u): u is string => typeof u === 'string' && Types.ObjectId.isValid(u)),
    ),
  ];
  const users = new Map(
    (await AuthUser.find({ _id: { $in: userIds.map((u) => new Types.ObjectId(u)) } }).lean()).map(
      (u) => [String(u._id), u.name || u.email],
    ),
  );
  const sourceIds = [
    ...briefs.flatMap((b) => b.sources.map((s) => s.sourceArticleId)),
    ...messages.flatMap((m) => m.citations.map((c) => c.sourceArticleId)),
    ...messages.flatMap((m) => (m.claims ?? []).flatMap((c) => c.sourceArticleIds)),
  ];
  const sources: Record<string, ResearchSourceDto> = {};
  for (const a of await SourceArticle.find({ _id: { $in: sourceIds } }).lean()) {
    sources[String(a._id)] = {
      id: String(a._id),
      url: a.url,
      publisher: a.publisher,
      headline: a.originalHeadline,
      publishedAt: iso(a.publishedAt),
      origin: a.origin,
      sourceQuality: a.sourceQuality ?? 'unknown',
    };
  }

  // A task saves its result a moment before it releases the lock. A poll in that gap must not
  // show the result and a running task together (a duplicate turn and a blocked composer).
  const stalled = isStalled(active);
  const finishing =
    active &&
    (briefs.some((b) => b.taskId === active.key) ||
      messages.some((m) => m.role === 'assistant' && m.taskId === active.key));

  const lastResultAt = Math.max(
    briefs.at(-1)?.createdAt?.getTime() ?? 0,
    messages.at(-1)?.createdAt?.getTime() ?? 0,
  );
  return {
    now: new Date().toISOString(),
    briefs: briefs.map((brief) => {
      const claims = brief.sections.flatMap((s) => s.claims);
      return {
        id: String(brief._id),
        createdAt: iso(brief.createdAt)!,
        depth: brief.depth === 'in_depth' ? 'in_depth' : 'standard',
        requestKind: requestKindOf(brief.requestKind) ?? 'manual',
        requestedBy: brief.requestedBy ? (users.get(brief.requestedBy) ?? null) : null,
        focus: brief.focus ?? null,
        fromMessageId: brief.fromMessageId ? String(brief.fromMessageId) : null,
        overview: brief.overview,
        sections: brief.sections.map((section) => ({
          kind: section.kind ?? null,
          title: section.title,
          claims: section.claims.map((c) => ({
            type: c.type,
            text: c.text,
            sourceLabels: c.sourceLabels,
            excerpt: c.excerpt ?? null,
            citationStatus: c.citationStatus,
          })),
        })),
        sources: brief.sources.map((s) => ({
          label: s.label,
          sourceId: String(s.sourceArticleId),
        })),
        peopleToApproach: brief.peopleToApproach.map((p) => ({
          name: p.name ?? '',
          role: p.role ?? '',
          why: p.why ?? '',
          sourceLabels: p.sourceLabels ?? [],
        })),
        verificationChecklist: brief.verificationChecklist,
        droppedClaims: brief.droppedClaims.length,
        discardedResults: brief.discardedResults ?? 0,
        searchFailures: brief.searchFailures ?? 0,
        counts: {
          verified: claims.filter((c) => c.citationStatus === 'verified').length,
          unconfirmed: claims.filter(
            (c) => c.citationStatus !== 'verified' && c.citationStatus !== 'uncited',
          ).length,
          uncited: claims.filter((c) => c.citationStatus === 'uncited').length,
        },
        evidence: brief.evidence ?? null,
        evidenceCheck: brief.evidenceCheck ?? null,
      };
    }),
    messages: messages.map((m) => toChatMessageDto(m, users)),
    sources,
    activeTask: active && !finishing && !stalled ? toTask(active, users) : null,
    lastFailure:
      stalled && active
        ? // Stopped without recording an error (a timeout, a worker that went away): say so, and
          // let the editor try again; a new request takes over the abandoned lock.
          toTask({ ...active, status: 'failed', lastError: abandonedMessage(active.kind) }, users)
        : latestTask?.status === 'failed' && (latestTask.updatedAt?.getTime() ?? 0) > lastResultAt
          ? toTask(latestTask, users)
          : null,
  };
}

/** Where a story's research stands, for the story page's next step (counts only, no content). */
export interface ResearchStatusDto {
  /** `failed`: the latest attempt failed and nothing has been written since. */
  state: 'none' | 'running' | 'ready' | 'failed';
  briefs: number;
  questions: number;
}

export async function getResearchStatus(storyId: string): Promise<ResearchStatusDto> {
  if (!Types.ObjectId.isValid(storyId)) throw new NotFoundError('Story not found.');
  const id = new Types.ObjectId(storyId);
  const { ResearchBrief, ChatMessage, Task } = await getModels();
  const [briefs, questions, active, latestTask, latestBrief] = await Promise.all([
    ResearchBrief.countDocuments({ storyId: id }),
    ChatMessage.countDocuments({ storyId: id, role: 'user' }),
    Task.findOne(
      { storyId: id, kind: { $in: ['research', 'chat'] }, activeLock: { $exists: true } },
      { key: 1, kind: 1, updatedAt: 1 },
    ).lean(),
    Task.findOne({ storyId: id, kind: 'research' }, { status: 1, updatedAt: 1 })
      .sort({ createdAt: -1 })
      .lean(),
    ResearchBrief.findOne({ storyId: id }, { taskId: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .lean(),
  ]);
  // Same rule as the research view: a task whose result is saved counts as finished. A reply
  // being written to a question isn't research in progress.
  const stalled = isStalled(active);
  const running = active?.kind === 'research' && latestBrief?.taskId !== active.key && !stalled;
  const failed =
    (stalled && active?.kind === 'research') ||
    (latestTask?.status === 'failed' &&
      (latestTask.updatedAt?.getTime() ?? 0) > (latestBrief?.createdAt?.getTime() ?? 0));
  return {
    state: running ? 'running' : briefs ? 'ready' : failed ? 'failed' : 'none',
    briefs,
    questions,
  };
}
