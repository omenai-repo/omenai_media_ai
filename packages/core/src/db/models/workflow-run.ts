import { CANDIDATE_OUTCOMES, SHORTFALL_CODES } from '@repo/shared';
import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
/** `incomplete`: recovery stopped with work left (a budget or a failure); it can be resumed. */
export const RECOVERY_STATUSES = ['running', 'completed', 'incomplete'] as const;
export const RUN_STAGES = [
  'queued',
  'discover',
  'revisit',
  'extract',
  'triage',
  'cluster',
  'evaluate',
  'rank',
  'done',
] as const;

/**
 * One discovery run, keyed by `runKey` (unique). A lease (`leaseOwner`, `leaseExpiresAt`) lets
 * exactly one worker execute it at a time and lets a crashed run be resumed after expiry.
 */
const workflowRunSchema = new Schema(
  {
    runKey: { type: String, required: true, unique: true },
    trigger: { type: String, enum: ['schedule', 'manual'], required: true },
    requestedBy: { type: String, default: null },
    status: { type: String, enum: RUN_STATUSES, default: 'queued' },
    stage: { type: String, enum: RUN_STAGES, default: 'queued' },
    attempts: { type: Number, default: 0 },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    deadlines: {
      soft: { type: Date, default: null },
      extension: { type: Date, default: null },
      hard: { type: Date, default: null },
    },
    candidateSetClosedAt: { type: Date, default: null },
    /** Stages whose results are persisted; a resumed run skips them (no repeated search spend). */
    completedStages: { type: [String], enum: RUN_STAGES, default: [] },
    /** Per-stage counts, set once when a stage completes (so retries never double-count). */
    stageStats: { type: Schema.Types.Mixed, default: {} },
    escalationsUsed: { type: Number, default: 0 },
    /** The thresholds, caps and models this run used, recorded once at its start (audit trail). */
    config: { type: Schema.Types.Mixed, default: null },
    candidateStoryIds: { type: [Schema.Types.ObjectId], default: [] },
    funnel: { type: Schema.Types.Mixed, default: null },
    outcomes: {
      type: [
        {
          storyId: Schema.Types.ObjectId,
          outcome: { type: String, enum: CANDIDATE_OUTCOMES },
          detail: String,
          _id: false,
        },
      ],
      default: [],
    },
    shortlist: {
      type: [
        {
          storyId: Schema.Types.ObjectId,
          rank: Number,
          score: Number,
          isUpdate: Boolean,
          _id: false,
        },
      ],
      default: [],
    },
    shortfallReasons: {
      type: [
        {
          code: { type: String, enum: SHORTFALL_CODES },
          count: Number,
          message: String,
          breakdown: Schema.Types.Mixed,
          _id: false,
        },
      ],
      default: [],
    },
    runErrors: {
      type: [{ stage: String, message: String, at: Date, _id: false }],
      default: [],
    },
    triggerRunId: { type: String, default: null },
    /**
     * A targeted recovery of this run's assessments after a failure that wasn't the stories' own
     * (ADR-046). The run keeps its key, errors and stage statistics; `before` keeps the outcome
     * counts it had, `counts` what recovery has done so far. Null for runs never recovered.
     */
    recovery: {
      type: new Schema(
        {
          id: { type: String, required: true },
          status: { type: String, enum: RECOVERY_STATUSES, required: true },
          reason: { type: String, default: '' },
          startedAt: { type: Date, required: true },
          updatedAt: { type: Date, required: true },
          completedAt: { type: Date, default: null },
          before: { type: Schema.Types.Mixed, default: null },
          counts: { type: Schema.Types.Mixed, default: null },
          note: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { collection: 'workflowRuns', timestamps: true },
);

workflowRunSchema.index({ status: 1, createdAt: -1 });
workflowRunSchema.index({ completedAt: -1 });

export type WorkflowRunDoc = InferSchemaType<typeof workflowRunSchema> & { _id: Types.ObjectId };

export function workflowRunModel(connection: Connection): Model<WorkflowRunDoc> {
  return (
    (connection.models.WorkflowRun as Model<WorkflowRunDoc> | undefined) ??
    connection.model<WorkflowRunDoc>('WorkflowRun', workflowRunSchema)
  );
}
