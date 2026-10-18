import { DRAFT_FORMAT_IDS } from '@repo/shared';
import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

import { CITATION_STATUSES, CLAIM_TYPES } from './research-brief.js';

export const DRAFT_ORIGINS = ['generated', 'edited'] as const;

/**
 * One version of one publication draft for a story. Versions are only ever added, never changed
 * or removed, so the history is complete: `version` is unique per story and format, and a
 * generated version is unique per task (`taskId`), so a retried task never writes two.
 *
 * `claims` are the statements of fact the model said it drew from the sources, checked against
 * the stored source text exactly like a research brief's. An edited version keeps no claims of its
 * own: the editor's changes can't be checked, so the studio shows the checks of the version it was
 * based on and says so.
 */
const draftVersionSchema = new Schema(
  {
    storyId: { type: Schema.Types.ObjectId, required: true },
    format: { type: String, enum: DRAFT_FORMAT_IDS, required: true },
    version: { type: Number, required: true, min: 1 },
    origin: { type: String, enum: DRAFT_ORIGINS, required: true },
    title: { type: String, default: '' },
    body: { type: String, required: true },
    createdBy: { type: String, required: true },
    /** The version this one was edited from, or that a generation was asked to revise. */
    basedOnVersion: { type: Number, default: null },
    /** Generated only: the editor's instructions, as given. */
    instructions: { type: String, default: null },
    taskId: { type: String, default: undefined },
    /** Generated only: the research briefs it drew on, and their sources by label. */
    briefIds: { type: [Schema.Types.ObjectId], default: [] },
    sources: {
      type: [
        {
          label: { type: String, required: true },
          sourceArticleId: { type: Schema.Types.ObjectId, required: true },
          _id: false,
        },
      ],
      default: [],
    },
    claims: {
      type: [
        {
          type: { type: String, enum: CLAIM_TYPES, required: true },
          text: { type: String, required: true },
          sourceLabels: { type: [String], default: [] },
          sourceArticleIds: { type: [Schema.Types.ObjectId], default: [] },
          excerpt: { type: String, default: null },
          citationStatus: { type: String, enum: CITATION_STATUSES, required: true },
          _id: false,
        },
      ],
      default: [],
    },
    /** Statements removed because they cited no source we hold (kept for the audit trail). */
    droppedClaims: { type: Number, default: 0 },
    /** The first answer was over the channel limit and the model was asked once to shorten it. */
    shortened: { type: Boolean, default: false },
    model: { type: String, default: null },
    tier: { type: String, default: null },
  },
  { collection: 'draftVersions', timestamps: { createdAt: true, updatedAt: false } },
);

draftVersionSchema.index({ storyId: 1, format: 1, version: 1 }, { unique: true });
draftVersionSchema.index({ taskId: 1 }, { unique: true, sparse: true });

export type DraftVersionDoc = InferSchemaType<typeof draftVersionSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export function draftVersionModel(connection: Connection): Model<DraftVersionDoc> {
  return (
    (connection.models.DraftVersion as Model<DraftVersionDoc> | undefined) ??
    connection.model<DraftVersionDoc>('DraftVersion', draftVersionSchema)
  );
}
