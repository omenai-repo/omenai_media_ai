import {
  CANDIDATE_OUTCOMES,
  CONFIDENCE_LEVELS,
  CROSS_CUTTING_TAGS,
  FORMAT_POTENTIAL,
  NOVELTY_STATUS,
  PILLAR_IDS,
  RECOMMENDED_ACTIONS,
  REGION_IDS,
  SCORING_DIMENSION_IDS,
  SUBCATEGORY_IDS,
  TIMELINESS,
  VERIFICATION_STATUS,
} from '@repo/shared';
import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const STORY_RELATIONS = [
  'new',
  'new_development',
  'same_development_new_info',
  'same_development_no_new_info',
] as const;
export const EDITORIAL_STATES = ['none', 'saved', 'skipped'] as const;
/** `expired`: waited past the freshness window before it could be assessed (counted, ADR-042). */
export const EVALUATION_STATUSES = [
  'pending',
  'evaluated',
  'failed',
  'not_required',
  'expired',
] as const;

/**
 * An editorial development: the thing Omenai might cover. Distinct from the articles that report
 * it (`sourceArticleIds`). Holds the recommendation card, score breakdown, gate results and the
 * editors' decisions. Evidence lives in source articles and research briefs, not here.
 */
const geographySchema = new Schema(
  {
    country: { type: String, required: true },
    city: { type: String, default: null },
    region: { type: String, enum: REGION_IDS, required: true },
    confidence: { type: String, enum: CONFIDENCE_LEVELS, required: true },
  },
  { _id: false },
);

const dimensionScoreSchema = new Schema(
  {
    dimension: { type: String, enum: SCORING_DIMENSION_IDS, required: true },
    score: { type: Number, min: 0, max: 5, required: true },
    rationale: { type: String, required: true },
  },
  { _id: false },
);

const gateResultSchema = new Schema(
  {
    gate: { type: String, required: true },
    outcome: { type: String, enum: ['pass', 'hold', 'reject'], required: true },
    reason: { type: String, required: true },
  },
  { _id: false },
);

const decisionSchema = new Schema(
  {
    action: { type: String, enum: ['saved', 'unsaved', 'skipped', 'unskipped'], required: true },
    userId: { type: String, required: true },
    reason: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * A claim the recommendation rests on, with the quote the assessment gave and what the
 * deterministic checks found (ADR-041). `no_defect_found` is never proof the claim is true.
 */
const keyClaimSchema = new Schema(
  {
    statement: { type: String, required: true },
    type: { type: String, enum: ['fact', 'attributed'], required: true },
    sourceLabels: { type: [String], default: [] },
    sourceArticleIds: { type: [Schema.Types.ObjectId], default: [] },
    quote: { type: String, default: '' },
    status: {
      type: String,
      enum: [
        'no_defect_found',
        'quote_not_found',
        'detail_not_in_quote',
        'quote_unrelated',
        'conflicting',
        'unknown_source',
      ],
      required: true,
    },
  },
  { _id: false },
);

const recommendationSchema = new Schema(
  {
    runKey: { type: String, required: true },
    rank: { type: Number, required: true },
    score: { type: Number, required: true },
    isUpdate: { type: Boolean, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const storySchema = new Schema(
  {
    // Recommendation card (§11).
    headline: { type: String, required: true },
    summary: { type: String, default: '' },
    whatHappened: { type: String, default: '' },
    whyItMatters: { type: String, default: '' },
    editorialTest: {
      canAnswer: { type: Boolean, default: false },
      answer: { type: String, default: '' },
    },
    keyClaims: { type: [keyClaimSchema], default: [] },
    angle: { type: String, default: '' },
    whyNow: { type: String, default: '' },
    primaryPillar: { type: String, enum: [...PILLAR_IDS, null], default: null },
    subcategories: { type: [String], enum: SUBCATEGORY_IDS, default: [] },
    crossCuttingTags: { type: [String], enum: CROSS_CUTTING_TAGS.ids, default: [] },
    geography: { type: [geographySchema], default: [] },
    tier: { type: Number, min: 1, max: 5, default: 5 },
    culturalConnections: { type: [String], default: [] },
    entities: { type: [String], default: [] },
    noveltyStatus: { type: String, enum: NOVELTY_STATUS.ids, default: 'new' },
    timeliness: { type: String, enum: TIMELINESS.ids, default: 'this_week' },
    formatPotential: {
      type: [
        { format: { type: String, enum: FORMAT_POTENTIAL.ids }, rationale: String, _id: false },
      ],
      default: [],
    },
    verificationNeeds: { type: [String], default: [] },
    peopleToApproach: {
      type: [{ name: String, role: String, basis: String, _id: false }],
      default: [],
    },
    visualOpportunities: { type: [String], default: [] },
    // Evaluation (§8).
    score: {
      dimensions: { type: [dimensionScoreSchema], default: [] },
      total: { type: Number, default: null },
      band: {
        type: String,
        enum: ['priority', 'shortlist', 'below_threshold', null],
        default: null,
      },
      confidence: { type: String, enum: [...CONFIDENCE_LEVELS, null], default: null },
    },
    gates: {
      outcome: { type: String, enum: ['pass', 'hold', 'reject', null], default: null },
      results: { type: [gateResultSchema], default: [] },
    },
    recommendedAction: { type: String, enum: [...RECOMMENDED_ACTIONS.ids, null], default: null },
    verificationStatus: { type: String, enum: VERIFICATION_STATUS.ids, default: 'unverified' },
    evaluation: {
      status: { type: String, enum: EVALUATION_STATUSES, default: 'pending' },
      runKey: { type: String, default: null },
      outcome: { type: String, enum: [...CANDIDATE_OUTCOMES, null], default: null },
      model: { type: String, default: null },
      escalated: { type: Boolean, default: false },
      evaluatedAt: { type: Date, default: null },
      error: { type: String, default: null },
      /** Runs whose assessment failed after retries; one failure is retried in the next run. */
      failedRuns: { type: Number, default: 0 },
    },
    // Relationships.
    sourceArticleIds: { type: [Schema.Types.ObjectId], default: [] },
    relation: { type: String, enum: STORY_RELATIONS, default: 'new' },
    parentStoryId: { type: Schema.Types.ObjectId, default: null },
    relatedStoryIds: { type: [Schema.Types.ObjectId], default: [] },
    developmentSignature: { type: String, default: '' },
    firstSeenRunKey: { type: String, required: true },
    lastCandidateRunKey: { type: String, required: true },
    // Editors (§10 step 8): lightweight decisions with an audit trail.
    editorialState: { type: String, enum: EDITORIAL_STATES, default: 'none' },
    decisions: { type: [decisionSchema], default: [] },
    recommendations: { type: [recommendationSchema], default: [] },
    lastRecommendedAt: { type: Date, default: null },
  },
  { collection: 'stories', timestamps: true },
);

storySchema.index({ lastCandidateRunKey: 1 });
storySchema.index({ editorialState: 1, updatedAt: -1 });
storySchema.index({ 'evaluation.runKey': 1, 'evaluation.status': 1 });
storySchema.index({ createdAt: -1 });

export type StoryDoc = InferSchemaType<typeof storySchema> & { _id: Types.ObjectId };

export function storyModel(connection: Connection): Model<StoryDoc> {
  return (
    (connection.models.Story as Model<StoryDoc> | undefined) ??
    connection.model<StoryDoc>('Story', storySchema)
  );
}
