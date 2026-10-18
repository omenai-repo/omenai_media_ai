import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const TASK_KINDS = [
  'discovery.prepare',
  'discovery.evaluate',
  'discovery.finalize',
  'research',
  'chat',
  'generate',
] as const;
export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped'] as const;
/** Why research was requested (see `requestKind`). */
export const RESEARCH_REQUEST_KINDS = ['auto', 'manual', 'lead', 'followup'] as const;

/**
 * A unit of background work with a deterministic `key`, so retries and duplicate triggers find
 * the same record. `activeLock` is set only while a task is queued or running; its sparse unique
 * index prevents two concurrent tasks of the same kind on the same story.
 */
const taskSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: TASK_KINDS, required: true },
    runKey: { type: String, default: null },
    storyId: { type: Schema.Types.ObjectId, default: null },
    status: { type: String, enum: TASK_STATUSES, default: 'queued' },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    /**
     * What the current attempt is doing, for the interface: written only while the work runs, and
     * started afresh by each attempt. Steps are recorded as they are reached, so nothing is shown
     * that didn't happen (`@repo/shared` progress).
     */
    progress: {
      step: { type: String, default: null },
      message: { type: String, default: null },
      pct: { type: Number, default: null },
      /** When the current step started. */
      startedAt: { type: Date, default: null },
      /** Every step reached in this attempt, in order, with what it found (counts only). */
      steps: {
        type: [
          {
            _id: false,
            step: { type: String, required: true },
            startedAt: { type: Date, required: true },
            counts: { type: Schema.Types.Mixed, default: null },
          },
        ],
        default: undefined,
      },
      /** A passing condition of the current step: `retrying` or `repairing`. */
      notice: { type: String, default: null },
      /**
       * Drafts only: the text written so far. A preview, never a saved version: it is cleared
       * when the task ends, whatever the outcome.
       */
      preview: {
        type: { _id: false, title: { type: String, default: '' }, body: { type: String } },
        default: undefined,
      },
    },
    activeLock: { type: String, default: undefined },
    triggerRunId: { type: String, default: null },
    requestedBy: { type: String, default: null },
    /**
     * Research only: why it was requested, and the reply it follows up (if any): `lead` when an
     * editor chose to research a reply's question, `followup` when the reply started it itself.
     */
    requestKind: { type: String, enum: RESEARCH_REQUEST_KINDS, default: null },
    focus: { type: String, default: null },
    fromMessageId: { type: Schema.Types.ObjectId, default: null },
    /** Sources a research attempt already found and stored, reused on retry (no new searches). */
    foundSourceIds: { type: [Schema.Types.ObjectId], default: undefined },
    discardedResults: { type: Number, default: 0 },
    /** Drafts only: the format, the editor's instructions and the version to revise (if any). */
    format: { type: String, default: null },
    instructions: { type: String, default: null },
    fromVersion: { type: Number, default: null },
    /** Chat only: the editor pressed Stop. The running reply checks it and ends without saving. */
    cancelRequested: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { collection: 'tasks', timestamps: true },
);

taskSchema.index({ activeLock: 1 }, { unique: true, sparse: true });
taskSchema.index({ runKey: 1, kind: 1, status: 1 });
taskSchema.index({ storyId: 1, kind: 1, createdAt: -1 });
taskSchema.index({ status: 1, updatedAt: -1 });

export type TaskDoc = InferSchemaType<typeof taskSchema> & { _id: Types.ObjectId };

export function taskModel(connection: Connection): Model<TaskDoc> {
  return (
    (connection.models.Task as Model<TaskDoc> | undefined) ??
    connection.model<TaskDoc>('Task', taskSchema)
  );
}
