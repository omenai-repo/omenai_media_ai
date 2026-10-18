import { SOURCE_QUALITY } from '@repo/shared';
import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const ARTICLE_ORIGINS = ['discovery', 'research'] as const;
export const EXTRACTION_STATUSES = ['pending', 'extracted', 'failed', 'skipped'] as const;
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
    searchQuery: { type: String, default: null },
    searchScore: { type: Number, default: 0 },
  },
  { collection: 'sourceArticles', timestamps: true },
);

sourceArticleSchema.index({ firstRunKey: 1 });
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
