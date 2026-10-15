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
}

export type UsageRecorder = (record: LlmUsageRecord) => Promise<void>;

/** Persists usage to `aiUsage`. Recording failures are logged and never fail the model call. */
export const recordUsageInDatabase: UsageRecorder = async (record) => {
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
    });
  } catch (error) {
    console.error('Failed to record LLM usage', error);
  }
};
