import { DRAFT_FORMAT_IDS, isDraftFormat, type DraftFormat } from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import type { CITATION_STATUSES, CLAIM_TYPES } from '../db/models/research-brief.js';
import { NotFoundError } from '../errors.js';
import {
  isStalled,
  toTaskProgress,
  type ResearchSourceDto,
  type TaskProgressDto,
} from '../research/queries.js';
import { STALE_LOCK_MS } from '../tasks/service.js';

export interface DraftClaimDto {
  type: (typeof CLAIM_TYPES)[number];
  text: string;
  sourceLabels: string[];
  excerpt: string | null;
  citationStatus: (typeof CITATION_STATUSES)[number];
}

export interface DraftVersionDto {
  id: string;
  format: DraftFormat;
  version: number;
  origin: 'generated' | 'edited';
  title: string;
  body: string;
  createdAt: string;
  /** Who asked for it or wrote it (a name, never an id). */
  author: string;
  basedOnVersion: number | null;
  /** An edit whose text is exactly an earlier version's: a restore. */
  restoredFrom: number | null;
  instructions: string | null;
  /** The generated version whose statement checks apply (this one, or the one it was edited from). */
  checksFrom: number | null;
  claims: DraftClaimDto[];
  droppedClaims: number;
  /** Labels used by the claims, mapped to source ids. */
  sources: Array<{ label: string; sourceId: string }>;
  shortened: boolean;
}

export interface DraftTaskDto extends TaskProgressDto {
  key: string;
  message: string | null;
  requestedBy: string | null;
  instructions: string | null;
  fromVersion: number | null;
  /** The text written so far: never a saved version, and gone once the task ends. */
  preview: { title: string; body: string } | null;
}

export interface DraftFormatDto {
  format: DraftFormat;
  /** Newest first. */
  versions: DraftVersionDto[];
  activeTask: DraftTaskDto | null;
  /** The latest request for this format, if it failed after the newest version. */
  lastFailure: DraftTaskDto | null;
}

export interface DraftsViewDto {
  /** The server's time when this was read, so elapsed times don't depend on the browser's clock. */
  now: string;
  research: {
    briefs: number;
    latestAt: string | null;
    /** What the research still needs confirmed: shown beside every draft. */
    toConfirm: string[];
  };
  formats: Record<DraftFormat, DraftFormatDto>;
  sources: Record<string, ResearchSourceDto>;
}

export interface DraftStatusDto {
  /** Formats with at least one version. */
  formats: number;
  versions: number;
  writing: boolean;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function getDraftsView(storyId: string): Promise<DraftsViewDto> {
  if (!Types.ObjectId.isValid(storyId)) throw new NotFoundError('Story not found.');
  const id = new Types.ObjectId(storyId);
  const { Story, ResearchBrief, DraftVersion, Task, SourceArticle, AuthUser } = await getModels();
  if (!(await Story.exists({ _id: id }))) throw new NotFoundError('Story not found.');

  const [briefs, versions, tasks] = await Promise.all([
    ResearchBrief.find({ storyId: id }, { sections: 1, verificationChecklist: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    DraftVersion.find({ storyId: id }).sort({ format: 1, version: -1 }).limit(500).lean(),
    // The newest request per format is enough: it's either running, failed or done.
    Task.find({ storyId: id, kind: 'generate' }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  const userIds = [
    ...new Set(
      [...versions.map((v) => v.createdBy), ...tasks.map((t) => t.requestedBy)].filter(
        (u): u is string => typeof u === 'string' && Types.ObjectId.isValid(u),
      ),
    ),
  ];
  const sourceIds = versions.flatMap((v) => v.sources.map((s) => s.sourceArticleId));
  const [people, articles] = await Promise.all([
    AuthUser.find({ _id: { $in: userIds.map((u) => new Types.ObjectId(u)) } }).lean(),
    SourceArticle.find({ _id: { $in: sourceIds } }).lean(),
  ]);
  const users = new Map(people.map((u) => [String(u._id), u.name || u.email]));
  const sources: Record<string, ResearchSourceDto> = {};
  for (const a of articles) {
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

  const toTask = (task: (typeof tasks)[number]): DraftTaskDto =>
    toDraftTask(task, task.requestedBy ? (users.get(task.requestedBy) ?? null) : null);

  const formats = {} as Record<DraftFormat, DraftFormatDto>;
  for (const format of DRAFT_FORMAT_IDS) {
    const own = versions.filter((v) => v.format === format);
    const byNumber = new Map(own.map((v) => [v.version, v]));
    const generatedAncestor = (version: number | null | undefined): number | null => {
      for (let v = version ?? null, hops = 0; v !== null && hops < 500; hops += 1) {
        const doc = byNumber.get(v);
        if (!doc) return null;
        if (doc.origin === 'generated') return doc.version;
        v = doc.basedOnVersion ?? null;
      }
      return null;
    };
    const latestTask = tasks.find((t) => t.format === format);
    const active =
      latestTask && (latestTask.status === 'queued' || latestTask.status === 'running')
        ? latestTask
        : null;
    const stalled = isStalled(active);
    // A task saves its version a moment before it completes; don't show both.
    const finishing = active && own.some((v) => v.taskId === active.key);
    const newest = own[0];
    formats[format] = {
      format,
      versions: own.map((v) => {
        const base = v.basedOnVersion != null ? byNumber.get(v.basedOnVersion) : undefined;
        return {
          id: String(v._id),
          format,
          version: v.version,
          origin: v.origin,
          title: v.title ?? '',
          body: v.body,
          createdAt: iso(v.createdAt)!,
          author: users.get(v.createdBy) ?? 'An editor',
          basedOnVersion: v.basedOnVersion ?? null,
          restoredFrom:
            v.origin === 'edited' && base && base.title === v.title && base.body === v.body
              ? base.version
              : null,
          instructions: v.instructions ?? null,
          checksFrom: v.origin === 'generated' ? v.version : generatedAncestor(v.basedOnVersion),
          claims: v.claims.map((c) => ({
            type: c.type,
            text: c.text,
            sourceLabels: c.sourceLabels,
            excerpt: c.excerpt ?? null,
            citationStatus: c.citationStatus,
          })),
          droppedClaims: v.droppedClaims ?? 0,
          sources: v.sources.map((s) => ({ label: s.label, sourceId: String(s.sourceArticleId) })),
          shortened: v.shortened ?? false,
        };
      }),
      activeTask: active && !finishing && !stalled ? toTask(active) : null,
      // Stopped without recording an error (a timeout, a worker that went away) reads as
      // stopped, with "Try again"; the next request takes over its lock.
      lastFailure:
        stalled && active
          ? toTask({
              ...active,
              status: 'failed',
              lastError: 'Abandoned: no progress for 45 minutes.',
            })
          : latestTask?.status === 'failed' && (!newest || latestTask.updatedAt > newest.createdAt)
            ? toTask(latestTask)
            : null,
    };
  }

  const toConfirm = [
    ...new Set(
      briefs.flatMap((b) => [
        ...b.sections
          .filter((s) => s.kind === 'to_confirm')
          .flatMap((s) => s.claims.map((c) => c.text)),
        ...b.verificationChecklist,
      ]),
    ),
  ].slice(0, 8);

  return {
    now: new Date().toISOString(),
    research: { briefs: briefs.length, latestAt: iso(briefs[0]?.createdAt), toConfirm },
    formats,
    sources,
  };
}

type StoredDraftTask = Parameters<typeof toTaskProgress>[0] & {
  key: string;
  progress?:
    | (NonNullable<Parameters<typeof toTaskProgress>[0]['progress']> & {
        message?: string | null;
        preview?: { title?: string | null; body?: string | null } | null;
      })
    | null;
  instructions?: string | null;
  fromVersion?: number | null;
};

function toDraftTask(task: StoredDraftTask, requestedBy: string | null): DraftTaskDto {
  const preview = task.progress?.preview;
  return {
    ...toTaskProgress(task),
    key: task.key,
    message: task.progress?.message ?? null,
    requestedBy,
    instructions: task.instructions ?? null,
    fromVersion: task.fromVersion ?? null,
    // Only while the work runs: a queued retry starts again from nothing.
    preview:
      task.status === 'running' && preview?.body
        ? { title: preview.title ?? '', body: preview.body }
        : null,
  };
}

/** The drafts being written for a story, by format: what the studio polls while they run. */
export interface DraftProgressDto {
  now: string;
  formats: Partial<Record<DraftFormat, DraftTaskDto>>;
}

/**
 * The studio's light poll while a draft is written: one query for the story's running draft
 * tasks, with their steps and the text so far. Work that has stopped responding (the abandoned
 * window) or whose version is already saved isn't listed; the full view shows the outcome.
 */
export async function getDraftProgress(storyId: string): Promise<DraftProgressDto> {
  if (!Types.ObjectId.isValid(storyId)) throw new NotFoundError('Story not found.');
  const id = new Types.ObjectId(storyId);
  const { Task, DraftVersion } = await getModels();
  const tasks = await Task.find({
    storyId: id,
    kind: 'generate',
    status: { $in: ['queued', 'running'] },
    activeLock: { $exists: true },
  })
    .sort({ createdAt: -1 })
    .limit(DRAFT_FORMAT_IDS.length)
    .lean();
  const saved = new Set(
    (
      await DraftVersion.find({ taskId: { $in: tasks.map((t) => t.key) } }, { taskId: 1 }).lean()
    ).map((v) => v.taskId),
  );
  const formats: Partial<Record<DraftFormat, DraftTaskDto>> = {};
  for (const task of tasks) {
    if (!isDraftFormat(task.format) || formats[task.format]) continue;
    if (isStalled(task) || saved.has(task.key)) continue;
    formats[task.format] = toDraftTask(task, null);
  }
  return { now: new Date().toISOString(), formats };
}

/** For the story page: how far drafting has got. */
export async function getDraftStatus(storyId: string): Promise<DraftStatusDto> {
  if (!Types.ObjectId.isValid(storyId)) throw new NotFoundError('Story not found.');
  const id = new Types.ObjectId(storyId);
  const { DraftVersion, Task } = await getModels();
  const [perFormat, writing] = await Promise.all([
    DraftVersion.aggregate<{ _id: string; versions: number }>([
      { $match: { storyId: id } },
      { $group: { _id: '$format', versions: { $sum: 1 } } },
    ]),
    Task.exists({
      storyId: id,
      kind: 'generate',
      status: { $in: ['queued', 'running'] },
      // Work quiet for longer than the abandoned-lock window has stopped, not "writing".
      updatedAt: { $gte: new Date(Date.now() - STALE_LOCK_MS) },
    }),
  ]);
  const known = perFormat.filter((f) => isDraftFormat(f._id));
  return {
    formats: known.length,
    versions: known.reduce((sum, f) => sum + f.versions, 0),
    writing: writing !== null,
  };
}
