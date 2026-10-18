import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

/**
 * Raw consumption per external call (LLM, search, extraction). No prices are stored: they change
 * and differ by plan, so cost is derived later from these counts and current provider pricing.
 */
const aiUsageSchema = new Schema(
  {
    provider: { type: String, required: true },
    kind: { type: String, enum: ['llm', 'search', 'extract'], required: true },
    operation: { type: String, required: true },
    model: { type: String, default: null },
    tier: { type: String, default: null },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cachedInputTokens: { type: Number, default: 0 },
    reasoningTokens: { type: Number, default: 0 },
    /** Provider-reported credits or request units (e.g. Tavily), when exposed. */
    units: { type: Number, default: null },
    outcome: { type: String, enum: ['ok', 'error'], required: true },
    errorKind: { type: String, default: null },
    runKey: { type: String, default: null },
    taskId: { type: String, default: null },
    storyId: { type: String, default: null },
    /**
     * Timing and attempts, recorded since 2026-10-16 so latency and retries can be measured per
     * operation and provider (earlier rows have none): wall time, time to the first streamed
     * piece, HTTP attempts and the statuses of failed ones, and why a repair round was needed.
     */
    latencyMs: { type: Number, default: null },
    firstChunkMs: { type: Number, default: null },
    attempts: { type: Number, default: null },
    retryStatuses: { type: [Number], default: undefined },
    repairReason: { type: String, default: null },
    /** Written by development fixtures only: invented activity, never reported by a provider. */
    simulated: { type: Boolean, default: false },
  },
  { collection: 'aiUsage', timestamps: { createdAt: true, updatedAt: false } },
);

aiUsageSchema.index({ createdAt: -1 });
aiUsageSchema.index({ runKey: 1 });
aiUsageSchema.index({ operation: 1, createdAt: -1 });

export type AiUsageDoc = InferSchemaType<typeof aiUsageSchema>;

export function aiUsageModel(connection: Connection): Model<AiUsageDoc> {
  return (
    (connection.models.AiUsage as Model<AiUsageDoc> | undefined) ??
    connection.model<AiUsageDoc>('AiUsage', aiUsageSchema)
  );
}
