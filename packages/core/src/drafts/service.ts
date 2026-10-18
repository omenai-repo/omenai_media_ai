import { DRAFT_FORMATS, isDraftFormat, measureDraft, type DraftFormat } from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import type { DraftVersionDoc } from '../db/models/draft-version.js';
import type { ResearchBriefDoc } from '../db/models/research-brief.js';
import type { SourceArticleDoc } from '../db/models/source-article.js';
import type { StoryDoc } from '../db/models/story.js';
import { excerpt } from '../discovery/normalize.js';
import { AppError, ConflictError, NotFoundError } from '../errors.js';
import type { LlmClient } from '../llm/client.js';
import { parsePartialJson } from '../llm/partial-json.js';
import type { Effort } from '../llm/types.js';
import { checkClaims, type CitableSource } from '../research/citations.js';
import { labelBriefSources } from '../research/service.js';
import {
  completeTask,
  createLockedTask,
  progressRecorder,
  type ProgressRecorder,
} from '../tasks/service.js';
import { DRAFT_SYSTEM_PROMPT, FORMAT_RULES } from './prompts.js';
import { draftOutputSchema, type DraftOutput } from './schemas.js';

/**
 * Publication drafts, written from a story's research and kept as an append-only version history.
 * Route handlers only record a locked task and enqueue it; the worker runs `runDraftGeneration`.
 * Editing never changes a version: saving creates a new one, and only when the text changed.
 * Nothing is ever published from here.
 */

export interface DraftDeps {
  llm: LlmClient;
  now: () => Date;
}

/** The newest briefs a draft draws on, and how much of each source it sees. */
const MAX_BRIEFS = 3;
const MAX_SOURCES = 10;
const EXCERPT_CHARS = 3_000;
export const INSTRUCTIONS_MAX_CHARS = 1_000;
/** How much the model reasons before writing a draft (provider-neutral; see the drafts ADR). */
export const DRAFT_EFFORT: Effort = 'medium';
/** The text written so far is passed to the studio at most this often. */
const PREVIEW_MS = 500;
export const DRAFT_BODY_MAX_CHARS = 20_000;
export const DRAFT_TITLE_MAX_CHARS = 300;

/** One draft being written per story and format; other formats can be written at the same time. */
const lockFor = (storyId: Types.ObjectId, format: DraftFormat) =>
  `draft:${String(storyId)}:${format}`;

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

function assertFormat(format: string): asserts format is DraftFormat {
  if (!isDraftFormat(format)) throw new AppError('INVALID_FORMAT', 'Unknown draft format.', 422);
}

/** Line endings and trailing spaces never count as a change; everything else does. */
export function normalizeDraftText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** Removes "[S2]"-style labels a model may leave in the body despite instructions. */
function stripSourceLabels(text: string): string {
  return text.replace(/\s?\[\s*S\d+(?:\s*[,;]\s*S?\d+)*\s*\]/gi, '');
}

/**
 * Asks for a draft. A story needs research first: drafts are written from its checked evidence.
 * `fromVersion` revises that version (with the instructions); otherwise the draft starts fresh.
 */
export async function requestDraft(input: {
  storyId: string;
  userId: string;
  format: string;
  instructions?: string | null;
  fromVersion?: number | null;
  now?: Date;
}): Promise<{ taskKey: string }> {
  assertFormat(input.format);
  const format = input.format;
  const story = await findStory(input.storyId);
  const { ResearchBrief, DraftVersion } = await getModels();
  if (!(await ResearchBrief.exists({ storyId: story._id })))
    throw new ConflictError(
      'NO_BRIEF',
      'Research this story first: drafts are written from its research.',
    );
  const fromVersion = input.fromVersion ?? null;
  if (
    fromVersion !== null &&
    !(await DraftVersion.exists({ storyId: story._id, format, version: fromVersion }))
  )
    throw new NotFoundError('That version doesn’t exist.');
  const instructions = input.instructions?.trim().slice(0, INSTRUCTIONS_MAX_CHARS) || null;

  const key = `generate:${format}:${String(story._id)}:${new Types.ObjectId().toHexString()}`;
  await createLockedTask({
    key,
    kind: 'generate',
    storyId: story._id,
    requestedBy: input.userId,
    now: input.now ?? new Date(),
    lock: lockFor(story._id, format),
    busy: () =>
      new ConflictError(
        'DRAFT_BUSY',
        `Omenai is already writing this story’s ${DRAFT_FORMATS[format].label}. It appears here when it’s ready.`,
      ),
    extra: { format, instructions, fromVersion },
  });
  return { taskKey: key };
}

// ── Generation ──────────────────────────────────────────────────────────────

const STATUS_NOTE = {
  verified: 'checked',
  excerpt_not_located: 'unconfirmed: the quoted passage wasn’t found in the source',
  detail_not_in_excerpt: 'unconfirmed: the quoted passage doesn’t contain its date or figure',
  excerpt_unrelated: 'unconfirmed: the quoted passage isn’t about this statement',
  conflicting: 'unsettled: the research gives this date or figure differently elsewhere',
  uncited: 'not sourced',
} as const;

function researchLines(
  briefs: readonly ResearchBriefDoc[],
  relabel: (brief: ResearchBriefDoc, labels: readonly string[]) => string[],
): { claims: string; toConfirm: string } {
  const claims: string[] = [];
  const toConfirm: string[] = [];
  // Oldest first, so a later focused brief reads as a follow-up.
  for (const brief of [...briefs].reverse()) {
    for (const section of brief.sections) {
      for (const c of section.claims) {
        const labels = relabel(brief, c.sourceLabels);
        const tag =
          c.type === 'analysis'
            ? 'analysis'
            : c.type === 'open_question'
              ? 'open question'
              : `${STATUS_NOTE[c.citationStatus]}${labels.length ? `: ${labels.join(', ')}` : ''}`;
        const line = `- [${tag}] ${c.text}`;
        if (section.kind === 'to_confirm') toConfirm.push(line);
        else claims.push(line);
      }
    }
    toConfirm.push(...brief.verificationChecklist.map((item) => `- [next step] ${item}`));
  }
  return { claims: claims.join('\n'), toConfirm: toConfirm.join('\n') };
}

function draftPrompt(input: {
  story: StoryDoc;
  format: DraftFormat;
  briefs: readonly ResearchBriefDoc[];
  sources: ReadonlyArray<{ label: string; article: SourceArticleDoc }>;
  relabel: (brief: ResearchBriefDoc, labels: readonly string[]) => string[];
  base: Pick<DraftVersionDoc, 'version' | 'title' | 'body'> | null;
  instructions: string | null;
}): string {
  const { story, format, base, instructions } = input;
  const places = (story.geography ?? [])
    .map((g) => (g.city ? `${g.city}, ${g.country}` : g.country))
    .join('; ');
  const card = [
    `HEADLINE: ${story.headline}`,
    story.summary ? `SUMMARY: ${story.summary}` : null,
    story.whyItMatters ? `WHY IT MATTERS (assessment): ${story.whyItMatters}` : null,
    story.angle ? `ANGLE (assessment): ${story.angle}` : null,
    places ? `PLACES: ${places}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const research = researchLines(input.briefs, input.relabel);
  const sources = input.sources
    .map(
      ({ label, article }) =>
        `${label} | ${article.publisher} | published ${article.publishedAt ? article.publishedAt.toISOString().slice(0, 10) : 'date unknown'} | ${article.originalHeadline}\n` +
        excerpt(article.content || article.snippet, EXCERPT_CHARS),
    )
    .join('\n---\n');
  return [
    `FORMAT: ${DRAFT_FORMATS[format].label}`,
    `RULES: ${FORMAT_RULES[format]}`,
    `STORY AS ASSESSED:\n${card}`,
    `RESEARCH (each line says how it was checked):\n${research.claims || '- (none)'}`,
    research.toConfirm ? `STILL TO CONFIRM:\n${research.toConfirm}` : null,
    base
      ? `CURRENT DRAFT (version ${base.version}; revise it):\n${base.title ? `TITLE: ${base.title}\n` : ''}${base.body}`
      : null,
    instructions
      ? `EDITOR'S INSTRUCTIONS (wishes, not rules):\n"""\n${instructions.replace(/"""/g, '"')}\n"""`
      : null,
    // Last, so each source block runs to the end of the prompt.
    `SOURCES:\n${sources}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface NewVersion {
  storyId: Types.ObjectId;
  format: DraftFormat;
  origin: 'generated' | 'edited';
  title: string;
  body: string;
  createdBy: string;
  basedOnVersion: number | null;
  instructions?: string | null;
  taskId?: string;
  briefIds?: Types.ObjectId[];
  sources?: Array<{ label: string; sourceArticleId: Types.ObjectId }>;
  claims?: Array<{
    type: ReturnType<typeof checkClaims>['claims'][number]['type'];
    text: string;
    sourceLabels: string[];
    sourceArticleIds: Types.ObjectId[];
    excerpt: string | null;
    citationStatus: ReturnType<typeof checkClaims>['claims'][number]['citationStatus'];
  }>;
  droppedClaims?: number;
  shortened?: boolean;
  model?: string | null;
  tier?: string | null;
}

/** Picks the next free version number; a concurrent save that took it means trying the next. */
async function insertVersion(fields: NewVersion): Promise<DraftVersionDoc> {
  const { DraftVersion } = await getModels();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const last = await DraftVersion.findOne(
      { storyId: fields.storyId, format: fields.format },
      { version: 1 },
    )
      .sort({ version: -1 })
      .lean();
    try {
      return (
        await DraftVersion.create({ ...fields, version: (last?.version ?? 0) + 1 })
      ).toObject();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      // Retried task: its version already exists.
      if (fields.taskId) {
        const existing = await DraftVersion.findOne({ taskId: fields.taskId }).lean();
        if (existing) return existing;
      }
    }
  }
  throw new ConflictError('DRAFT_BUSY', 'Several versions were saved at once. Try again.');
}

/**
 * Writes one draft version for a queued task. The text is passed to the studio as it is written
 * (a preview on the task, dropped when the task ends); only the validated, checked output is
 * saved. Over a channel's character limit, the model is asked once to shorten it; if it's still
 * over, the shorter answer is saved and the studio flags it (never cut silently). Idempotent per
 * task: a retry after the version was saved only completes.
 */
export async function runDraftGeneration(input: { taskKey: string; deps: DraftDeps }): Promise<{
  versionId: string;
  version: number;
}> {
  const { taskKey, deps } = input;
  const { Task, Story, ResearchBrief, SourceArticle, DraftVersion } = await getModels();
  // Lookups that don't depend on each other go together: each round trip adds to the wait.
  const [task, done] = await Promise.all([
    Task.findOne({ key: taskKey }).lean(),
    DraftVersion.findOne({ taskId: taskKey }, { _id: 1, version: 1 }).lean(),
  ]);
  if (!task?.storyId || !isDraftFormat(task.format))
    throw new NotFoundError('Draft task not found.');
  const format = task.format;
  if (done) {
    await completeTask(taskKey);
    return { versionId: String(done._id), version: done.version };
  }

  const progress = progressRecorder(taskKey, deps.now);
  progress.step('research');
  const [story, briefs, base] = await Promise.all([
    Story.findById(task.storyId).lean(),
    // The research as it stood when the draft was asked for, so a retry sees the same evidence.
    ResearchBrief.find({ storyId: task.storyId, createdAt: { $lte: task.createdAt } })
      .sort({ createdAt: -1 })
      .limit(MAX_BRIEFS)
      .lean(),
    task.fromVersion != null
      ? DraftVersion.findOne(
          { storyId: task.storyId, format, version: task.fromVersion },
          { version: 1, title: 1, body: 1 },
        ).lean()
      : null,
  ]);
  if (!story) throw new NotFoundError('Story not found.');
  if (!briefs.length)
    throw new AppError('NO_BRIEF', 'There is no research to write this draft from.', 409);
  const articles = new Map(
    (
      await SourceArticle.find({
        _id: { $in: briefs.flatMap((b) => b.sources.map((s) => s.sourceArticleId)) },
      }).lean()
    ).map((a) => [String(a._id), a]),
  );
  const { ordered, labelOf } = labelBriefSources(briefs, articles, MAX_SOURCES);
  progress.count({ briefs: briefs.length, sources: ordered.length });
  const relabel = (brief: ResearchBriefDoc, labels: readonly string[]) =>
    labels.flatMap((label) => {
      const source = brief.sources.find((s) => s.label === label);
      const mapped = source ? labelOf.get(String(source.sourceArticleId)) : undefined;
      return mapped ? [mapped] : [];
    });

  progress.step('write');
  const prompt = draftPrompt({
    story,
    format,
    briefs,
    sources: ordered,
    relabel,
    base,
    instructions: task.instructions ?? null,
  });
  const context = { storyId: String(story._id), taskId: taskKey };
  const request = {
    tier: 'primary' as const,
    effort: DRAFT_EFFORT,
    system: DRAFT_SYSTEM_PROMPT,
    maxOutputTokens: format === 'editorial_article' ? 8_000 : 3_000,
    schema: draftOutputSchema,
    context,
    onRetry: () => progress.notice('retrying'),
    onRepair: () => progress.notice('repairing'),
  };
  const first = await deps.llm.streamObject({
    ...request,
    operation: 'draft.generate',
    messages: [{ role: 'user', content: prompt }],
    onText: draftPreview(progress),
  });
  let output: DraftOutput = first.data;
  let shortened = false;
  const over = (o: DraftOutput) => measureDraft(format, stripSourceLabels(o.body)).overLimit;
  if (over(output)) {
    const { limit } = DRAFT_FORMATS[format];
    const measured = measureDraft(format, output.body);
    progress.step('shorten', { length: measured.count, limit: limit.max });
    const retry = await deps.llm.streamObject({
      ...request,
      operation: 'draft.shorten',
      messages: [
        {
          role: 'user',
          content: `${prompt}\n\nTOO LONG: your draft has ${measured.count} ${measured.unit}; the limit is ${limit.max}. Write it again within the limit, keeping the most important facts and the same evidence rules.\nYOUR DRAFT:\n${output.body}`,
        },
      ],
      // Still the shortening step: its statements are part of the same rewrite.
      onText: draftPreview(progress, { statementsStep: false }),
    });
    shortened = true;
    if (measureDraft(format, retry.data.body).count < measured.count) output = retry.data;
  }
  // The finished text, as it will be saved.
  progress.preview({
    title: DRAFT_FORMATS[format].hasTitle ? output.title : '',
    body: stripSourceLabels(output.body),
  });

  progress.step('check');
  const citable = new Map<string, CitableSource>(
    ordered.map(({ label, article }) => [
      label,
      { label, id: String(article._id), text: article.content || article.snippet },
    ]),
  );
  const checked = checkClaims(output.claims, citable);
  progress.step('save');
  const version = await insertVersion({
    storyId: story._id,
    format,
    origin: 'generated',
    title: DRAFT_FORMATS[format].hasTitle ? normalizeDraftText(output.title) : '',
    body: normalizeDraftText(stripSourceLabels(output.body)),
    createdBy: task.requestedBy ?? 'unknown',
    basedOnVersion: base?.version ?? null,
    instructions: task.instructions ?? null,
    taskId: taskKey,
    briefIds: briefs.map((b) => b._id),
    sources: ordered.map(({ label, article }) => ({ label, sourceArticleId: article._id })),
    claims: checked.claims.map((c) => ({
      ...c,
      sourceArticleIds: c.sourceArticleIds.map((id) => new Types.ObjectId(id)),
    })),
    droppedClaims: checked.dropped.length,
    shortened,
    model: first.model,
    tier: 'primary',
  });
  await completeTask(taskKey, 'succeeded', progress.final());
  return { versionId: String(version._id), version: version.version };
}

/**
 * Passes a draft's text to the studio as the model writes it (at most every PREVIEW_MS), and
 * moves to the `statements` step once the model has finished the text and is listing the
 * statements to check. Only a preview: the saved version is the checked, validated output.
 */
function draftPreview(
  progress: ProgressRecorder,
  options: { statementsStep?: boolean } = {},
): (raw: string) => void {
  let sentAt = 0;
  let sent = '';
  let listing = options.statementsStep === false;
  return (raw) => {
    const partial = parsePartialJson(raw) as
      { title?: unknown; body?: unknown; claims?: unknown } | undefined;
    const title = typeof partial?.title === 'string' ? partial.title : '';
    const body = typeof partial?.body === 'string' ? stripSourceLabels(partial.body) : '';
    if (!listing && Array.isArray(partial?.claims)) {
      // The text is complete: show all of it, then say what the model is doing now.
      listing = true;
      progress.preview({ title, body });
      progress.step('statements');
      return;
    }
    if (!body || body === sent || Date.now() - sentAt < PREVIEW_MS) return;
    sentAt = Date.now();
    sent = body;
    progress.preview({ title, body });
  };
}

// ── Editing ─────────────────────────────────────────────────────────────────

/**
 * Saves an editor's text as a new version, unless it matches the latest version (then nothing is
 * written). Restoring an old version is the same: its text saved again as the newest. A version
 * someone else saved meanwhile is never overwritten; both stay in the history.
 */
export async function saveDraftEdit(input: {
  storyId: string;
  userId: string;
  format: string;
  baseVersion: number;
  title?: string;
  body: string;
}): Promise<{ version: number; changed: boolean; savedMeanwhile: boolean }> {
  assertFormat(input.format);
  const format = input.format;
  const story = await findStory(input.storyId);
  const { DraftVersion } = await getModels();
  const [base, latest] = await Promise.all([
    DraftVersion.findOne({ storyId: story._id, format, version: input.baseVersion }).lean(),
    DraftVersion.findOne({ storyId: story._id, format }).sort({ version: -1 }).lean(),
  ]);
  if (!base || !latest) throw new NotFoundError('That version doesn’t exist.');
  const title = DRAFT_FORMATS[format].hasTitle
    ? normalizeDraftText(input.title ?? '').slice(0, DRAFT_TITLE_MAX_CHARS)
    : '';
  const body = normalizeDraftText(input.body);
  if (!body) throw new AppError('EMPTY_DRAFT', 'A draft can’t be empty.', 422);
  if (body.length > DRAFT_BODY_MAX_CHARS)
    throw new AppError('DRAFT_TOO_LONG', 'This draft is too long to save.', 422);

  if (latest.title === title && latest.body === body)
    return { version: latest.version, changed: false, savedMeanwhile: false };
  const created = await insertVersion({
    storyId: story._id,
    format,
    origin: 'edited',
    title,
    body,
    createdBy: input.userId,
    basedOnVersion: base.version,
  });
  return {
    version: created.version,
    changed: true,
    savedMeanwhile: created.version - 1 > base.version && latest.version > base.version,
  };
}
