import type {
  CandidateOutcome,
  Confidence,
  CrossCuttingTag,
  PillarId,
  RecommendedAction,
  RegionId,
  ScoreBand,
  ScoringDimension,
  ShortfallReason,
  SubcategoryId,
  RunFunnel,
} from '@repo/shared';

/**
 * Plain, JSON-serialisable views for the dashboard (dates as ISO strings). Server components
 * read these through the newsroom services and can pass them straight to client components.
 */
export interface StoryCardDto {
  id: string;
  headline: string;
  summary: string;
  whyItMatters: string;
  angle: string;
  whyNow: string;
  primaryPillar: PillarId | null;
  subcategories: SubcategoryId[];
  crossCuttingTags: CrossCuttingTag[];
  geography: Array<{ country: string; city: string | null; region: RegionId }>;
  tier: number;
  score: { total: number | null; band: ScoreBand | null; confidence: Confidence | null };
  outcome: CandidateOutcome | null;
  recommendedAction: RecommendedAction | null;
  timeliness: string | null;
  noveltyStatus: string | null;
  relation: string;
  editorialState: 'none' | 'saved' | 'skipped';
  sourceCount: number;
  publishers: string[];
  firstSeenRunKey: string;
  lastRecommendedAt: string | null;
  createdAt: string | null;
  /** Position in a run's shortlist, when shown in that context. */
  rank?: number;
  isUpdate?: boolean;
}

export interface SourceDto {
  id: string;
  url: string;
  publisher: string;
  headline: string;
  publishedAt: string | null;
  retrievedAt: string | null;
  sourceQuality: string;
  extractionStatus: string;
  origin: string;
}

export interface StoryDetailDto extends StoryCardDto {
  whatHappened: string;
  editorialTest: { canAnswer: boolean; answer: string };
  culturalConnections: string[];
  entities: string[];
  formatPotential: Array<{ format: string; rationale: string }>;
  verificationNeeds: string[];
  peopleToApproach: Array<{ name: string; role: string; basis: string }>;
  visualOpportunities: string[];
  dimensions: Array<{ dimension: ScoringDimension; score: number; rationale: string }>;
  gates: Array<{ gate: string; outcome: 'pass' | 'hold' | 'reject'; reason: string }>;
  sources: SourceDto[];
  parent: { id: string; headline: string; editorialState: string } | null;
  developments: Array<{ id: string; headline: string; createdAt: string | null }>;
  decisions: Array<{ action: string; userName: string; reason: string | null; at: string }>;
  recommendations: Array<{ runKey: string; rank: number; score: number; isUpdate: boolean; at: string }>;
  evaluation: {
    status: string;
    model: string | null;
    escalated: boolean;
    evaluatedAt: string | null;
    error: string | null;
    runKey: string | null;
  };
}

export interface RunSummaryDto {
  runKey: string;
  trigger: 'schedule' | 'manual';
  status: string;
  stage: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  candidates: number;
  qualified: number;
  shortlisted: number;
  shortfallReasons: ShortfallReason[];
}

export interface UsageRowDto {
  provider: string;
  operation: string;
  model: string | null;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  units: number;
}

export interface RunDetailDto extends RunSummaryDto {
  requestedBy: string | null;
  funnel: RunFunnel | null;
  deadlines: { soft: string | null; extension: string | null; hard: string | null };
  candidateSetClosedAt: string | null;
  outcomes: Array<{ storyId: string; headline: string; outcome: string; detail: string; score: number | null }>;
  errors: Array<{ stage: string; message: string; at: string | null }>;
  failedTasks: Array<{ key: string; kind: string; attempts: number; lastError: string | null; updatedAt: string | null }>;
  usage: UsageRowDto[];
}
