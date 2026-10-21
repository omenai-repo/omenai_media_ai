import { SOURCE_QUALITY } from '@repo/shared';
import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const ARTICLE_ORIGINS = ['discovery', 'research'] as const;
/**
 * `skipped` was the old over-cap state (dropped for good); new overflow stays `pending` in the
 * backlog and becomes `expired` if it ages past the freshness window first (ADR-042).
 */
export const EXTRACTION_STATUSES = [
  'pending',
  'extracted',
  'failed',
  'skipped',
  'expired',
] as const;
export const CHANGE_KINDS = [
  'unchanged',
  'cosmetic',
  'updated_reporting',
  'new_development',
] as const;

/**
 * One publication's article, identified by its canonical URL. Several articles can support one
 * story. Stored text is the evidence a brief cites, so it is kept even if the live page changes.
 */
const revisionSchema = new Schema(
  {
    checkedAt: { type: Date, required: true },
    contentHash: { type: String, default: null },
    headline: { type: String, default: null },
    changeKind: { type: String, enum: CHANGE_KINDS, required: true },
    changeSummary: { type: String, default: null },
  },
  { _id: false },
);

const triageSchema = new Schema(
  {
    inScope: { type: Boolean, required: true },
    reason: { type: String, required: true },
    eventSummary: { type: String, default: null },
    eventDate: { type: String, default: null },
    entities: { type: [String], default: [] },
    places: { type: [String], default: [] },
    exclusionSignals: { type: [String], default: [] },
    model: { type: String, required: true },
    triagedAt: { type: Date, required: true },
  },
  { _id: false },
);

/** Link to the publisher's preview image. Never downloaded or hosted; rights never assumed. */
const imageSchema = new Schema(
  {
    url: { type: String, required: true },
    alt: { type: String, default: null },
    capturedAt: { type: Date, required: true },
    rights: { type: String, enum: ['unverified'], default: 'unverified' },
  },
  { _id: false },
);

const sourceArticleSchema = new Schema(
  {
    canonicalUrl: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    host: { type: String, required: true },
    publisher: { type: String, required: true },
    originalHeadline: { type: String, required: true },
    author: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    retrievedAt: { type: Date, required: true },
    origin: { type: String, enum: ARTICLE_ORIGINS, required: true },
    sourceQuality: { type: String, enum: SOURCE_QUALITY.ids, default: 'unknown' },
    /** Search snippet; the fallback text when extraction fails. */
    snippet: { type: String, default: '' },
    content: { type: String, default: '' },
    contentHash: { type: String, default: null },
    image: { type: imageSchema, default: null },
    extractionStatus: { type: String, enum: EXTRACTION_STATUSES, default: 'pending' },
    lastCheckedAt: { type: Date, default: null },
    revisions: { type: [revisionSchema], default: [] },
    triage: { type: triageSchema, default: null },
    storyIds: { type: [Schema.Types.ObjectId], default: [], index: true },
    firstRunKey: { type: String, default: null },
    lastSeenRunKey: { type: String, default: null },
    /** The query that first found it, and that query's tier: its lane for fair selection. */
    searchQuery: { type: String, default: null },
    searchTier: { type: Number, min: 1, max: 5, default: null },
    /** Every query that has returned it (audit trail; selection uses the first). */
    seenQueries: { type: [String], default: [] },
    searchScore: { type: Number, default: 0 },
    /** The run that took it from the backlog into processing (extraction onwards). */
    intakeRunKey: { type: String, default: null },
    /** When and where it aged out of the backlog unprocessed; counted, never silent. */
    expiredAt: { type: Date, default: null },
    expiredStage: { type: String, enum: ['extract', 'cluster', null], default: null },
  },
  { collection: 'sourceArticles', timestamps: true },
);

sourceArticleSchema.index({ firstRunKey: 1 });
sourceArticleSchema.index({ extractionStatus: 1, retrievedAt: 1 });
sourceArticleSchema.index({ intakeRunKey: 1 });
sourceArticleSchema.index({ lastSeenRunKey: 1 });
sourceArticleSchema.index({ lastCheckedAt: 1 });

export type SourceArticleDoc = InferSchemaType<typeof sourceArticleSchema> & {
  _id: Types.ObjectId;
};

export function sourceArticleModel(connection: Connection): Model<SourceArticleDoc> {
  return (
    (connection.models.SourceArticle as Model<SourceArticleDoc> | undefined) ??
    connection.model<SourceArticleDoc>('SourceArticle', sourceArticleSchema)
  );
}
