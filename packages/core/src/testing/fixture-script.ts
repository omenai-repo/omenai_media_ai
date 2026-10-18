/**
 * TEST FIXTURE ONLY. The scripted model answers for the fixture articles, shared by the pipeline
 * tests and the fixture seed command. Invented content; never real reporting.
 */
import type { ModelTier } from '../llm/types.js';
import type { UsageRecorder } from '../llm/usage.js';
import { fixtureEvaluation, scores } from './discovery-fixtures.js';
import { createScriptedLlm, promptArticles, promptStories } from './fake-llm.js';

export function evaluationFor(prompt: string, tier: ModelTier) {
  const lead = promptArticles(prompt)[0]?.headline ?? '';
  const headline = lead;
  if (/Gele/.test(lead))
    return fixtureEvaluation(
      scores(4, { human_interest_access: 3, audience_relevance: 3, commercial_adjacency: 2 }),
      {
        headline,
        geography: [
          { country: 'Nigeria', city: 'Lagos', region: 'west_africa', confidence: 'high' },
        ],
      },
    );
  if (/10 art exhibitions/.test(lead))
    return fixtureEvaluation(scores(3), {
      headline,
      exclusions: [
        { id: 'thin_listicle_seo', evidence: 'Ten openings, one line each.', exception: null },
      ],
    });
  if (/whisky/.test(lead))
    // Scores 100, yet gates must still reject it.
    return fixtureEvaluation(scores(5), {
      headline,
      exclusions: [
        {
          id: 'generic_luxury_promotion',
          evidence: 'Sponsored brand event copy.',
          exception: null,
        },
        { id: 'press_release_repackaged', evidence: 'Mirrors the brand release.', exception: null },
      ],
    });
  if (/punk/.test(lead))
    return tier === 'escalation'
      ? fixtureEvaluation(scores(3, { commercial_adjacency: 1 }), { headline })
      : fixtureEvaluation(scores(3, { originality: 4, commercial_adjacency: 1 }), { headline });
  if (/Zeitz MOCAA opens/.test(lead))
    return fixtureEvaluation(
      scores(4, { cultural_significance: 5, visual_potential: 5, commercial_adjacency: 3 }),
      {
        headline,
        entities: ['Zeitz MOCAA', 'Kwame Asante'],
      },
    );
  if (/Unseen archive/.test(lead))
    return fixtureEvaluation(scores(4, { cultural_significance: 5 }), {
      headline,
      criticalIssues: [
        {
          kind: 'rights',
          severity: 'hold',
          evidence: 'Photographs of unknown provenance and rights.',
        },
      ],
    });
  if (/auction record/.test(lead))
    return fixtureEvaluation(scores(4, { cultural_significance: 5, timeliness: 5 }), {
      headline,
      noveltyStatus: 'developing',
      timeliness: 'urgent',
    });
  throw new Error(`No fixture evaluation for "${lead}"`);
}

export function createFixtureLlm(options: { recordUsage?: UsageRecorder } = {}) {
  return createScriptedLlm(
    {
      triage: (prompt) => ({
        articles: promptArticles(prompt).map((a) => ({
          ref: a.ref,
          inScope: !/For Sale/.test(a.headline),
          reason: /For Sale/.test(a.headline)
            ? 'A sales listing, not a story.'
            : 'Cultural development.',
          eventSummary: a.headline,
          eventDate: null,
          entities: [],
          places: [],
          exclusionSignals: [],
        })),
      }),
      cluster: (prompt) => {
        const stories = promptStories(prompt);
        const asante = stories.find((s) => /Kwame Asante/.test(s.headline))?.ref ?? null;
        return {
          // The model leaves syndicated copies apart; deterministic pre-grouping must merge them.
          groups: promptArticles(prompt).map((a) => {
            if (/draws crowds/.test(a.headline))
              return {
                items: [a.ref],
                relation: 'same_development_no_new_info',
                relatedStory: asante,
                signature: 'Asante retrospective',
              };
            if (/auction record/.test(a.headline))
              return {
                items: [a.ref],
                relation: 'new_development',
                relatedStory: asante,
                signature: 'Asante auction record',
              };
            return { items: [a.ref], relation: 'new', relatedStory: null, signature: a.headline };
          }),
        };
      },
      evaluate: evaluationFor,
      change: () => ({
        changeKind: 'updated_reporting',
        summary: 'Should not be needed in these fixtures.',
      }),
    },
    options,
  );
}
