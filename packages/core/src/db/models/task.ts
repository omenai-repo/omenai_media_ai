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
    progress: {
      step: { type: String, default: null },
      message: { type: String, default: null },
      pct: { type: Number, default: null },
    },
    activeLock: { type: String, default: undefined },
    triggerRunId: { type: String, default: null },
    requestedBy: { type: String, default: null },
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
