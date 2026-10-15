/**
 * §8 Story Scoring & Decision Rules. Models score each dimension 0–5 with a rationale; the
 * weighted total is always computed here, never taken from a model. Scores prioritise human
 * attention: they never approve a story by themselves.
 */

export const SCORING_DIMENSIONS = {
  cultural_significance: {
    label: 'Cultural significance',
    weight: 25,
    highMeans:
      'Changes, deepens or complicates understanding of culture; evidence-based significance.',
  },
  distinctive_angle: {
    label: 'Distinctive Omenai angle',
    weight: 20,
    highMeans:
      'A specific perspective, question, person, history or connection beyond the announcement.',
  },
  originality: {
    label: 'Originality / under-covered value',
    weight: 15,
    highMeans: 'Not saturated, or Omenai can contribute original reporting, access or synthesis.',
  },
  human_interest_access: {
    label: 'Human interest / access',
    weight: 10,
    highMeans: 'Compelling people, voices, first-hand perspectives or meaningful access to pursue.',
  },
  visual_potential: {
    label: 'Visual / film potential',
    weight: 10,
    highMeans:
      'Images, environments, objects, processes or people can support strong visual storytelling.',
  },
  audience_relevance: {
    label: 'Audience relevance / lasting value',
    weight: 10,
    highMeans: 'Matters to culturally curious readers beyond a fleeting click.',
  },
  timeliness: {
    label: 'Timeliness',
    weight: 5,
    highMeans: 'Clear reason to cover now, or a timely hook for evergreen work.',
  },
  commercial_adjacency: {
    label: 'Commercial adjacency',
    weight: 5,
    highMeans: 'Natural fit with partners without compromising editorial independence.',
  },
} as const;

export type ScoringDimension = keyof typeof SCORING_DIMENSIONS;
export const SCORING_DIMENSION_IDS = Object.keys(SCORING_DIMENSIONS) as ScoringDimension[];
export const MAX_DIMENSION_SCORE = 5;

export const SCORE_THRESHOLDS = {
  /** 80–100: priority candidate for human review; not automatic approval. */
  priority: 80,
  /** 65–79: shortlist or research queue if there is a plausible angle. Below: don't recommend. */
  shortlist: 65,
} as const;

export type ScoreBand = 'priority' | 'shortlist' | 'below_threshold';

export type DimensionScores = Record<ScoringDimension, number>;

/**
 * Total = Σ (score / 5 × weight), on a 0–100 scale, rounded to one decimal.
 * Throws on anything other than an integer 0–5 for every dimension.
 */
export function weightedTotal(scores: DimensionScores): number {
  let total = 0;
  for (const dimension of SCORING_DIMENSION_IDS) {
    const score = scores[dimension];
    if (!Number.isInteger(score) || score < 0 || score > MAX_DIMENSION_SCORE) {
      throw new RangeError(`${dimension} must be an integer from 0 to 5, received ${score}`);
    }
    total += (score / MAX_DIMENSION_SCORE) * SCORING_DIMENSIONS[dimension].weight;
  }
  return Math.round(total * 10) / 10;
}

export function scoreBand(
  total: number,
  thresholds: { priority: number; shortlist: number } = SCORE_THRESHOLDS,
): ScoreBand {
  if (total >= thresholds.priority) return 'priority';
  if (total >= thresholds.shortlist) return 'shortlist';
  return 'below_threshold';
}
