import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

import { RESEARCH_REQUEST_KINDS } from './task.js';

export const CLAIM_TYPES = ['fact', 'attributed', 'analysis', 'open_question'] as const;
/**
 * `verified`: the evidence excerpt was found in the stored text of a cited source. That locates
 * the passage; it doesn't show the passage supports the claim.
 * `excerpt_not_located`: the cited source exists, but the excerpt wasn't found in its stored text.
 * `detail_not_in_excerpt`: the excerpt was found, but a date, figure or quoted words the claim
 * gives aren't in it. A deterministic safeguard that can only lower confidence (2026-10-16).
 * `excerpt_unrelated`: the excerpt was found, but it isn't about the claim (none of the names the
 * claim gives, or too few of its words). A floor, not a support check (2026-10-18).
 * `conflicting`: another claim says nearly the same thing with a different date or figure; neither
 * is settled (2026-10-18).
 * `uncited`: analysis or an open question that cites nothing (never a fact).
 * Only `verified` is a found quote with no flag, and even that shows where a claim came from, not
 * that the passage supports it.
 */
export const CITATION_STATUSES = [
  'verified',
  'excerpt_not_located',
  'detail_not_in_excerpt',
  'excerpt_unrelated',
  'conflicting',
  'uncited',
] as const;
/**
 * The parts of a brief. The first four are the reply the editor reads first; `background` is
 * opened on request. `answer` is the direct answer of a focused follow-up (a lead), which has
 * only `answer` and `to_confirm`. Titles are fixed by the server, never written by the model.
 */
export const BRIEF_SECTION_KINDS = [
  'overview',
  'why_it_matters',
  'findings',
  'to_confirm',
  'background',
  'answer',
] as const;

export const EVIDENCE_LEVELS = ['sufficient', 'partial', 'insufficient'] as const;
/**
 * Why the checks lowered an answer's own "sufficient" (ADR-039): none of its factual statements
 * kept a found quote; it doesn't contain a checked date or figure for the one asked for; or its
 * statements contradict each other. The checks can lower a judgement, never raise one.
 */
export const EVIDENCE_CHECKS = [
  'no_checked_facts',
  'asked_detail_unchecked',
  'conflicting',
] as const;

/** One checked statement: in briefs, focused answers and chat replies alike. */
export const claimSchema = new Schema(
  {
    type: { type: String, enum: CLAIM_TYPES, required: true },
    text: { type: String, required: true },
    sourceLabels: { type: [String], default: [] },
    sourceArticleIds: { type: [Schema.Types.ObjectId], default: [] },
    excerpt: { type: String, default: null },
    citationStatus: { type: String, enum: CITATION_STATUSES, required: true },
  },
  { _id: false },
);

/**
 * A research brief: one per completed research task (`taskId` unique, so a retried task never
 * writes two). Sources are referenced by label (`S1…`) mapped to `sourceArticles` ids, with the
 * content hash the model saw, so the evidence can be re-checked later even if the page changes.
 */
const researchBriefSchema = new Schema(
  {
    storyId: { type: Schema.Types.ObjectId, required: true },
    taskId: { type: String, required: true, unique: true },
    requestedBy: { type: String, default: null },
    depth: { type: String, enum: ['standard', 'in_depth'], default: 'standard' },
    /**
     * `auto`: started by Omenai when the workspace opened; `lead`: an editor chose to research a
     * reply's question; `followup`: the reply started it, because the saved research didn't
     * establish the answer (ADR-038).
     */
    requestKind: { type: String, enum: RESEARCH_REQUEST_KINDS, default: 'manual' },
    focus: { type: String, default: null },
    fromMessageId: { type: Schema.Types.ObjectId, default: null },
    /** Search results discarded as unrelated to the story before anything was read or stored. */
    discardedResults: { type: Number, default: 0 },
    /** Searches that failed (the brief was written without them), so the gap can be shown. */
    searchFailures: { type: Number, default: 0 },
    /** Focused follow-ups only: how fully the sources answer the question. */
    evidence: { type: String, enum: EVIDENCE_LEVELS, default: null },
    /** Why the checks lowered the model's own "sufficient", if they did. */
    evidenceCheck: { type: String, enum: EVIDENCE_CHECKS, default: null },
    model: { type: String, required: true },
    tier: { type: String, required: true },
    sources: {
      type: [
        {
          label: { type: String, required: true },
          sourceArticleId: { type: Schema.Types.ObjectId, required: true },
          contentHash: { type: String, default: null },
          origin: { type: String, required: true },
          _id: false,
        },
      ],
      default: [],
    },
    searchQueries: { type: [String], default: [] },
    /** The overview's kept claims as plain text, for prompts that need the story in brief. */
    overview: { type: String, default: '' },
    sections: {
      type: [
        {
          // Absent on briefs written before the concise format.
          kind: { type: String, enum: BRIEF_SECTION_KINDS, default: null },
          title: { type: String, required: true },
          claims: [claimSchema],
          _id: false,
        },
      ],
      default: [],
    },
    peopleToApproach: {
      type: [
        {
          name: String,
          role: String,
          why: String,
          sourceLabels: { type: [String], default: [] },
          _id: false,
        },
      ],
      default: [],
    },
    verificationChecklist: { type: [String], default: [] },
    /** Claims removed because they cited no known source; kept for the audit trail. */
    droppedClaims: {
      type: [{ text: String, reason: String, labels: [String], _id: false }],
      default: [],
    },
  },
  { collection: 'researchBriefs', timestamps: true },
);

researchBriefSchema.index({ storyId: 1, createdAt: -1 });

export type ResearchBriefDoc = InferSchemaType<typeof researchBriefSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export function researchBriefModel(connection: Connection): Model<ResearchBriefDoc> {
  return (
    (connection.models.ResearchBrief as Model<ResearchBriefDoc> | undefined) ??
    connection.model<ResearchBriefDoc>('ResearchBrief', researchBriefSchema)
  );
}
