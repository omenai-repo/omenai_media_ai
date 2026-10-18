import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

import {
  CITATION_STATUSES,
  claimSchema,
  EVIDENCE_CHECKS,
  EVIDENCE_LEVELS,
} from './research-brief.js';

/**
 * What the saved research meant for a question, as the reply judged it (ADR-038): it answered it,
 * new research was needed, or the question was outside the newsroom's domain.
 */
export const CHAT_ASSESSMENTS = ['sufficient', 'needs_research', 'out_of_scope'] as const;

/** Why research a reply called for didn't start on its own. */
export const FOLLOW_UP_SKIPS = ['already_researched', 'busy', 'usage_limit', 'error'] as const;

/** How a question relates to the workspace. `related_lead` is the name before 2026-10-16. */
export const CHAT_SCOPES = [
  'about_story',
  'editorial',
  'related',
  'related_lead',
  'unrelated',
] as const;

/**
 * One message in a story's research conversation. An assistant reply carries the `taskId` that
 * produced it (sparse unique), so a retried or replayed reply never posts twice.
 */
const chatMessageSchema = new Schema(
  {
    storyId: { type: Schema.Types.ObjectId, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    userId: { type: String, default: null },
    briefId: { type: Schema.Types.ObjectId, default: null },
    taskId: { type: String, default: undefined },
    model: { type: String, default: null },
    citations: {
      type: [
        {
          label: { type: String, required: true },
          sourceArticleId: { type: Schema.Types.ObjectId, required: true },
          excerpt: { type: String, default: null },
          citationStatus: { type: String, enum: CITATION_STATUSES, required: true },
          _id: false,
        },
      ],
      default: [],
    },
    /** Citation markers removed from the reply because they named no source in the brief. */
    droppedLabels: { type: [String], default: [] },
    /**
     * Replies since 2026-10-16: the answer as checked statements, each with its own sources and
     * quote, so every citation sits next to the claim it is offered for. `content` holds the same
     * text joined, for history and older readers. Earlier replies have `citations` instead.
     */
    claims: { type: [claimSchema], default: undefined },
    /** Statements removed because they cited no source, or an unknown one. */
    droppedClaims: { type: Number, default: 0 },
    /** Assistant replies: the scope the answer was given in, and how well the evidence answered. */
    scope: { type: String, enum: CHAT_SCOPES, default: null },
    evidence: { type: String, enum: EVIDENCE_LEVELS, default: null },
    /** A focused research question, tied to the story, that the editor may approve. */
    suggestedFocus: { type: String, default: null },
    /** Assistant replies since 2026-10-17: what the saved research meant for the question. */
    assessment: { type: String, enum: CHAT_ASSESSMENTS, default: null },
    /** Why the checks lowered the reply's own "sufficient", if they did (ADR-039). */
    evidenceCheck: { type: String, enum: EVIDENCE_CHECKS, default: null },
    /**
     * Research this reply started on its own because the saved research didn't establish the
     * answer (`started`, with its task), or why it didn't (`skipped`). Its findings are the brief
     * whose `fromMessageId` is this reply.
     */
    followUp: {
      type: {
        _id: false,
        status: { type: String, enum: ['started', 'skipped'], required: true },
        reason: { type: String, enum: FOLLOW_UP_SKIPS, default: null },
        question: { type: String, required: true },
        depth: { type: String, enum: ['standard', 'in_depth'], default: 'standard' },
        taskKey: { type: String, default: null },
      },
      default: undefined,
    },
  },
  { collection: 'chatMessages', timestamps: true },
);

chatMessageSchema.index({ storyId: 1, createdAt: 1 });
chatMessageSchema.index({ taskId: 1 }, { unique: true, sparse: true });

export type ChatMessageDoc = InferSchemaType<typeof chatMessageSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export function chatMessageModel(connection: Connection): Model<ChatMessageDoc> {
  return (
    (connection.models.ChatMessage as Model<ChatMessageDoc> | undefined) ??
    connection.model<ChatMessageDoc>('ChatMessage', chatMessageSchema)
  );
}
