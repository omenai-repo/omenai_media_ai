import { getModels } from '../../db/models.js';
import type { SourceArticleDoc } from '../../db/models/source-article.js';
import { LlmError } from '../../llm/types.js';
import { excerpt } from '../normalize.js';
import { TRIAGE_SYSTEM_PROMPT } from '../prompts.js';
import { articleIntake, fairOrder } from '../intake.js';
import { recordRunError } from '../runs.js';
import { triageOutputSchema } from '../schemas.js';
import type { DiscoveryDeps } from './context.js';

export interface TriageStats extends Record<string, unknown> {
  triaged: number;
  /** Articles left untriaged by a run that failed, taken on by this one. */
  adopted: number;
  inScope: number;
  outOfScope: number;
  batches: number;
  fallbacks: number;
}

function isoDate(date: Date | null | undefined): string {
  return date ? date.toISOString().slice(0, 10) : 'date unknown';
}

export function triagePrompt(articles: readonly SourceArticleDoc[], excerptChars: number): string {
  return articles
    .map(
      (article, i) =>
        `A${i + 1} | ${article.publisher} | ${isoDate(article.publishedAt)} | ${article.originalHeadline}\n` +
        excerpt(article.content || article.snippet, excerptChars),
    )
    .join('\n---\n');
}

/**
 * First-pass triage of every article that has been read but not triaged: this run's intake, and
 * any a failed run left behind. The intake cap bounds how many there are. Small batches on the
 * triage tier; results are saved per article, so a resumed run only triages what is left. If a
 * batch's output stays invalid after the client's repair round, its articles go forward to
 * clustering rather than being silently dropped (evaluation then decides).
 */
export async function triageStage(runKey: string, deps: DiscoveryDeps): Promise<TriageStats> {
  const { SourceArticle } = await getModels();
  const { config } = deps;
  const unread = await SourceArticle.find({
    origin: 'discovery',
    extractionStatus: { $in: ['extracted', 'failed'] },
    triage: null,
  }).lean();
  const pending = fairOrder(unread.map((a) => ({ ...articleIntake(a), article: a }))).map(
    (o) => o.article,
  );

  const stats: TriageStats = {
    triaged: 0,
    adopted: pending.filter((a) => (a.intakeRunKey ?? a.firstRunKey) !== runKey).length,
    inScope: 0,
    outOfScope: 0,
    batches: 0,
    fallbacks: 0,
  };
  for (let i = 0; i < pending.length; i += config.triageBatchSize) {
    const batch = pending.slice(i, i + config.triageBatchSize);
    stats.batches += 1;
    let results = new Map<
      string,
      ReturnType<typeof triageOutputSchema.parse>['articles'][number]
    >();
    let model = 'none';
    try {
      const response = await deps.llm.generateObject({
        operation: 'discovery.triage',
        tier: 'triage',
        system: TRIAGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: triagePrompt(batch, config.triageExcerptChars) }],
        maxOutputTokens: 220 * batch.length,
        schema: triageOutputSchema,
        context: { runKey },
      });
      results = new Map(response.data.articles.map((a) => [a.ref, a]));
      model = response.model;
    } catch (error) {
      // Transient provider errors propagate so the task retries; other failures fall back.
      if (error instanceof LlmError && error.retryable) throw error;
      await recordRunError(runKey, 'triage', `Batch fallback: ${String(error)}`);
    }

    const now = deps.now();
    for (const [index, article] of batch.entries()) {
      const result = results.get(`A${index + 1}`);
      if (!result) stats.fallbacks += 1;
      const triage = result
        ? { ...result, model, triagedAt: now }
        : {
            inScope: true,
            reason: 'Triage unavailable; passed to clustering for full evaluation.',
            eventSummary: null,
            eventDate: null,
            entities: [],
            places: [],
            exclusionSignals: [],
            model: 'none',
            triagedAt: now,
          };
      await SourceArticle.updateOne({ _id: article._id }, { $set: { triage } });
      stats.triaged += 1;
      if (triage.inScope) stats.inScope += 1;
      else stats.outOfScope += 1;
    }
  }
  return stats;
}
