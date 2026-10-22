import { shortenProse } from '@repo/shared';

import { getModels } from '../../db/models.js';
import type { SourceArticleDoc } from '../../db/models/source-article.js';
import { LlmError, type LlmErrorKind, type OutputNormalizer } from '../../llm/types.js';
import { excerpt } from '../normalize.js';
import { TRIAGE_SYSTEM_PROMPT } from '../prompts.js';
import { articleIntake, fairOrder } from '../intake.js';
import { recordRunError } from '../runs.js';
import { TRIAGE_REASON_MAX, triageOutputSchema, type TriageOutput } from '../schemas.js';
import type { DiscoveryDeps } from './context.js';

export interface TriageCounts {
  triaged: number;
  inScope: number;
  outOfScope: number;
  /** Requests for a batch of articles (a batch may be a single article after a split). */
  batches: number;
  /** Articles left "Triage unavailable" and passed to clustering for the full evaluation. */
  fallbacks: number;
  /** Batches split after a truncated or invalid answer (ADR-046). */
  splits: number;
  /** Explanations shortened to their limit before validation; decisions are never changed. */
  shortenedReasons: number;
  /** Left exactly as they were because the caller's budget stopped further requests. */
  deferred: number;
}

export interface TriageStats extends TriageCounts, Record<string, unknown> {
  /** Articles left untriaged by a run that failed, taken on by this one. */
  adopted: number;
}

/**
 * Visible answer per article. Production, 2026-10-22 (Haiku 5.5): an 8-article answer used
 * 1,458–1,689 tokens, about 180–210 per article with reasons over 300 characters, so the old 220
 * left too little room and three batches stopped at their limit. The prompt now asks for
 * shorter reasons; 300 leaves about 40% over the longest observed. The adapter adds thinking room.
 */
export const TRIAGE_TOKENS_PER_ARTICLE = 300;
/** The answer's wrapper and the first article's keys. */
export const TRIAGE_TOKENS_BASE = 200;

/** Each article's tries: in its batch, then in half of it, then alone (ADR-046). */
export const TRIAGE_ATTEMPTS = 3;

/** Failures a smaller batch can avoid: a long answer, an invalid one, a refusal of one item. */
const SPLITTABLE = new Set<LlmErrorKind>([
  'truncated',
  'invalid_output',
  'refusal',
  'safety_blocked',
]);

const UNAVAILABLE_REASON = 'Triage unavailable; passed to clustering for full evaluation.';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Shortens a `reason` that overran its limit, so one long explanation can't invalidate a batch
 * whose decisions are sound. Only the explanation changes; the decision, references, entities and
 * every other field are passed on untouched and validated as they are.
 */
export const normalizeTriage: OutputNormalizer = (candidate) => {
  const notes: string[] = [];
  if (!isRecord(candidate) || !Array.isArray(candidate.articles))
    return { value: candidate, notes };
  const articles = candidate.articles.map((item: unknown, i) => {
    if (!isRecord(item) || typeof item.reason !== 'string') return item;
    const length = item.reason.trim().length;
    if (length <= TRIAGE_REASON_MAX) return item;
    const reason = shortenProse(item.reason, TRIAGE_REASON_MAX);
    notes.push(`articles.${i}.reason shortened from ${length} to ${reason.length} characters`);
    return { ...item, reason };
  });
  return { value: { ...candidate, articles }, notes };
};

/** Halves, or single articles for the last try. */
function split<T>(items: readonly T[], singles: boolean): T[][] {
  if (singles) return items.map((item) => [item]);
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}

/**
 * Triages the given articles in batches on the triage tier and saves each result as it comes.
 * An answer that is truncated or invalid is not regenerated whole: the batch is split and only
 * its parts are asked again, with at most `attempts` tries per article; a single article gets
 * the client's one repair round. A permanent request error stops further requests in this stage.
 * Articles still without a result get the explicit "Triage unavailable" record and go forward to
 * clustering, where the full evaluation decides (never silently dropped).
 *
 * `replace` limits writes: `untriaged` (the pipeline) writes only where no triage exists yet;
 * `fallback` (recovery) only over a "Triage unavailable" record, never over a real decision.
 * `shouldContinue`, checked before each request, lets a caller with a budget stop: the articles
 * not yet asked about are then left as they were, for a later run.
 */
export async function triageArticles(
  articles: readonly SourceArticleDoc[],
  runKey: string,
  deps: DiscoveryDeps,
  options: {
    replace?: 'untriaged' | 'fallback';
    attempts?: number;
    shouldContinue?: () => boolean;
  } = {},
): Promise<TriageCounts> {
  const { SourceArticle } = await getModels();
  const { config } = deps;
  const attempts = options.attempts ?? TRIAGE_ATTEMPTS;
  const guard = options.replace === 'fallback' ? { 'triage.model': 'none' } : { triage: null };
  const stats: TriageCounts = {
    triaged: 0,
    inScope: 0,
    outOfScope: 0,
    batches: 0,
    fallbacks: 0,
    splits: 0,
    shortenedReasons: 0,
    deferred: 0,
  };
  let stopped: LlmError | null = null;

  async function save(
    article: SourceArticleDoc,
    result: TriageOutput['articles'][number] | null,
    model: string,
  ): Promise<void> {
    const triagedAt = deps.now();
    const triage = result
      ? { ...result, model, triagedAt }
      : {
          inScope: true,
          reason: UNAVAILABLE_REASON,
          eventSummary: null,
          eventDate: null,
          entities: [],
          places: [],
          exclusionSignals: [],
          model: 'none',
          triagedAt,
        };
    // Conditional, so a repeated delivery or a concurrent writer never replaces a decision.
    const written = await SourceArticle.updateOne(
      { _id: article._id, ...guard },
      { $set: { triage } },
    );
    if (written.modifiedCount !== 1) return;
    stats.triaged += 1;
    if (!result) stats.fallbacks += 1;
    if (triage.inScope) stats.inScope += 1;
    else stats.outOfScope += 1;
  }

  async function fallback(group: readonly SourceArticleDoc[]): Promise<void> {
    for (const article of group) await save(article, null, 'none');
  }

  async function triageGroup(group: readonly SourceArticleDoc[], attempt: number): Promise<void> {
    if (stopped) return fallback(group);
    if (options.shouldContinue && !options.shouldContinue()) {
      stats.deferred += group.length;
      return;
    }
    const last = attempt >= attempts;
    stats.batches += 1;
    let response;
    try {
      response = await deps.llm.generateObject({
        operation: 'discovery.triage',
        tier: 'triage',
        system: TRIAGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: triagePrompt(group, config.triageExcerptChars) }],
        maxOutputTokens: TRIAGE_TOKENS_PER_ARTICLE * group.length + TRIAGE_TOKENS_BASE,
        schema: triageOutputSchema,
        normalize: normalizeTriage,
        // A batch is split rather than written again whole; one article gets the repair round.
        repair: group.length === 1,
        context: { runKey },
      });
    } catch (error) {
      // Transient provider errors propagate so the task retries; saved results are kept.
      if (error instanceof LlmError && error.retryable) throw error;
      const splittable = error instanceof LlmError && SPLITTABLE.has(error.kind);
      if (splittable && group.length > 1 && !last) {
        stats.splits += 1;
        await recordRunError(
          runKey,
          'triage',
          `Batch of ${group.length} split after ${error.kind} (try ${attempt} of ${attempts}): ${error.message}`,
        );
        for (const part of split(group, attempt + 1 >= attempts))
          await triageGroup(part, attempt + 1);
        return;
      }
      if (!splittable) stopped = error instanceof LlmError ? error : null;
      await recordRunError(
        runKey,
        'triage',
        `Batch fallback (${group.length} article(s), try ${attempt} of ${attempts}${stopped ? '; no further triage requests in this stage' : ''}): ${String(error)}`,
      );
      return fallback(group);
    }

    stats.shortenedReasons += response.normalized?.length ?? 0;
    const results = new Map(response.data.articles.map((a) => [a.ref, a]));
    const missing: SourceArticleDoc[] = [];
    for (const [index, article] of group.entries()) {
      const result = results.get(`A${index + 1}`);
      if (result) await save(article, result, response.model);
      else missing.push(article);
    }
    if (missing.length === 0) return;
    // An answer that left articles out: ask again for those alone, within their tries.
    if (!last) {
      for (const part of split(missing, missing.length === 1 || attempt + 1 >= attempts))
        await triageGroup(part, attempt + 1);
    } else {
      await recordRunError(
        runKey,
        'triage',
        `Batch fallback: the answer left out ${missing.length} article(s) on their last try.`,
      );
      await fallback(missing);
    }
  }

  for (let i = 0; i < articles.length; i += config.triageBatchSize)
    await triageGroup(articles.slice(i, i + config.triageBatchSize), 1);
  return stats;
}

/**
 * First-pass triage of every article that has been read but not triaged: this run's intake, and
 * any a failed run left behind. The intake cap bounds how many there are. Results are saved per
 * article, so a resumed run only triages what is left.
 */
export async function triageStage(runKey: string, deps: DiscoveryDeps): Promise<TriageStats> {
  const { SourceArticle } = await getModels();
  const unread = await SourceArticle.find({
    origin: 'discovery',
    extractionStatus: { $in: ['extracted', 'failed'] },
    triage: null,
  }).lean();
  const pending = fairOrder(unread.map((a) => ({ ...articleIntake(a), article: a }))).map(
    (o) => o.article,
  );
  const stats = await triageArticles(pending, runKey, deps, { replace: 'untriaged' });
  return {
    ...stats,
    adopted: pending.filter((a) => (a.intakeRunKey ?? a.firstRunKey) !== runKey).length,
  };
}
