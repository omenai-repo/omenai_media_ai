import {
  CONFIDENCE_LEVELS,
  CRITICAL_ISSUE_KINDS,
  CROSS_CUTTING_TAGS,
  EXCLUSIONS,
  FORMAT_POTENTIAL,
  NOVELTY_STATUS,
  PILLAR_IDS,
  REGION_IDS,
  SOURCE_QUALITY,
  SUBCATEGORY_IDS,
  TIMELINESS,
  type ScoringDimension,
} from '@repo/shared';
import * as z from 'zod';

import { STORY_RELATIONS } from '../db/models/story.js';

/**
 * Contracts for model output. Articles and stories are referred to by short labels the prompt
 * assigns (A1, S3) — never by URL — so a model cannot introduce a source we didn't retrieve.
 * Schemas avoid features the providers can't express (records, tuples); constraints the provider
 * drops are still enforced when the client validates with these Zod schemas.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const articleRef = z.string().regex(/^A\d+$/);
const storyRef = z.string().regex(/^S\d+$/);

export const triageOutputSchema = z.object({
  articles: z
    .array(
      z.object({
        ref: articleRef,
        inScope: z.boolean().describe('Within Omenai’s cultural territory and worth a closer look'),
        reason: text(300),
        eventSummary: z
          .string()
          .max(240)
          .nullable()
          .describe('One neutral sentence: what happened'),
        eventDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .describe('Date of the event itself if stated, YYYY-MM-DD'),
        entities: z.array(text(80)).max(12),
        places: z.array(text(80)).max(6),
        exclusionSignals: z.array(z.enum(EXCLUSIONS.ids)).max(4),
      }),
    )
    .min(1),
});
export type TriageOutput = z.output<typeof triageOutputSchema>;

export const changeOutputSchema = z.object({
  changeKind: z.enum(['cosmetic', 'updated_reporting', 'new_development']),
  summary: text(400).describe('What changed, in one or two sentences'),
});
export type ChangeOutput = z.output<typeof changeOutputSchema>;

export const clusterOutputSchema = z.object({
  groups: z
    .array(
      z.object({
        items: z.array(articleRef).min(1),
        relation: z.enum(STORY_RELATIONS),
        relatedStory: storyRef.nullable().describe('Required unless relation is "new"'),
        signature: text(200).describe('Who/what/where/when that identifies this development'),
      }),
    )
    .min(1),
});
export type ClusterOutput = z.output<typeof clusterOutputSchema>;

const dimension = z.object({
  score: z.number().int().min(0).max(5),
  rationale: text(400).describe('Evidence-based; distinguish evidence from inference'),
});

const scores = z.object({
  cultural_significance: dimension,
  distinctive_angle: dimension,
  originality: dimension,
  human_interest_access: dimension,
  visual_potential: dimension,
  audience_relevance: dimension,
  timeliness: dimension,
  commercial_adjacency: dimension,
} satisfies Record<ScoringDimension, typeof dimension>);

export const evaluationOutputSchema = z.object({
  headline: text(140).describe('Working headline; no clickbait or unsupported claims'),
  summary: text(600).describe('Neutral 2–4 sentence summary'),
  whatHappened: text(500).describe('Neutral account with date and source labels'),
  editorialTest: z.object({
    canAnswer: z.boolean(),
    answer: z.string().max(600).describe('Completes: "This matters to Omenai’s audience because…"'),
  }),
  whyItMatters: z.string().max(500).describe('Two specific sentences on significance and fit'),
  angle: z
    .string()
    .max(500)
    .describe('Question, tension, historical connection or overlooked perspective'),
  whyNow: z.string().max(300),
  primaryPillar: z.enum(PILLAR_IDS),
  subcategories: z.array(z.enum(SUBCATEGORY_IDS)).min(1).max(4),
  crossCuttingTags: z.array(z.enum(CROSS_CUTTING_TAGS.ids)).max(4),
  geography: z
    .array(
      z.object({
        country: text(60),
        city: z.string().max(60).nullable(),
        region: z.enum(REGION_IDS),
        confidence: z.enum(CONFIDENCE_LEVELS),
      }),
    )
    .min(1)
    .max(5),
  culturalConnections: z.array(text(160)).max(6),
  entities: z.array(text(80)).max(15),
  noveltyStatus: z.enum(NOVELTY_STATUS.ids),
  timeliness: z.enum(TIMELINESS.ids),
  formatPotential: z
    .array(z.object({ format: z.enum(FORMAT_POTENTIAL.ids), rationale: text(200) }))
    .max(4),
  verificationNeeds: z.array(text(200)).max(8),
  peopleToApproach: z
    .array(
      z.object({
        name: text(80),
        role: text(120),
        basis: text(200).describe('Which source names them'),
      }),
    )
    .max(6),
  visualOpportunities: z.array(text(200)).max(6),
  sourceQuality: z.array(z.object({ ref: articleRef, quality: z.enum(SOURCE_QUALITY.ids) })),
  scores,
  confidence: z.enum(CONFIDENCE_LEVELS),
  exclusions: z
    .array(
      z.object({
        id: z.enum(EXCLUSIONS.ids),
        evidence: text(300),
        exception: z.string().max(400).nullable(),
      }),
    )
    .max(6),
  criticalIssues: z
    .array(
      z.object({
        kind: z.enum(CRITICAL_ISSUE_KINDS.ids),
        severity: z.enum(['hold', 'reject']),
        evidence: text(300),
      }),
    )
    .max(4),
  needsEscalation: z
    .boolean()
    .describe('True only for conflicting sources or ethics/rights ambiguity'),
  escalationReason: z.string().max(300).nullable(),
});
export type EvaluationOutput = z.output<typeof evaluationOutputSchema>;
