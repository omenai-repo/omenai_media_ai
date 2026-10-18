import { getModels } from '../db/models.js';
import type { LlmUsage, LlmProviderName, ModelTier, UsageContext } from './types.js';

export interface LlmUsageRecord {
  provider: LlmProviderName;
  model: string;
  tier: ModelTier;
  operation: string;
  usage: LlmUsage;
  outcome: 'ok' | 'error';
  errorKind?: string;
  context?: UsageContext;
  /** Wall time of this request, from sending it to the last byte or the failure. */
  latencyMs?: number;
  /** Streams only: time to the first piece of the answer. */
  firstChunkMs?: number | null;
  /** HTTP attempts behind this request (retries of rejected requests included), when known. */
  attempts?: number | null;
  /** Status of each failed attempt (0 for a network error). */
  retryStatuses?: number[];
  /** Why the previous answer needed a repair round: schema paths and messages only, no content. */
  repairReason?: string | null;
}

export type UsageRecorder = (record: LlmUsageRecord) => Promise<void>;

/**
 * Persists usage to `aiUsage`. Recording failures are logged and never fail the model call.
 * `simulated` marks fixture activity so it is never counted or shown as provider-reported usage.
 */
export function databaseUsageRecorder(options: { simulated?: boolean } = {}): UsageRecorder {
  return async (record) => {
    try {
      const { AiUsage } = await getModels();
      await AiUsage.create({
        provider: record.provider,
        kind: 'llm',
        operation: record.operation,
        model: record.model,
        tier: record.tier,
        ...record.usage,
        outcome: record.outcome,
        errorKind: record.errorKind ?? null,
        runKey: record.context?.runKey ?? null,
        taskId: record.context?.taskId ?? null,
        storyId: record.context?.storyId ?? null,
        latencyMs: record.latencyMs ?? null,
        firstChunkMs: record.firstChunkMs ?? null,
        attempts: record.attempts ?? null,
        retryStatuses: record.retryStatuses ?? [],
        repairReason: record.repairReason ?? null,
        simulated: options.simulated ?? false,
      });
    } catch (error) {
      console.error('Failed to record LLM usage', error);
    }
  };
}

export const recordUsageInDatabase: UsageRecorder = databaseUsageRecorder();
