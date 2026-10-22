import * as z from 'zod';

import { ConfigError } from '../config/env.js';
import { AppError } from '../errors.js';
import { LlmError } from '../llm/types.js';
import { UsageLimitError } from '../ops/budget.js';
import { SearchError } from '../search/types.js';

/**
 * Request errors that no retry can change: a malformed or invalid request, a missing record, or
 * something not allowed. Conflicts (409) stay retryable: a busy lock or a version number taken by
 * a concurrent save can clear on the next attempt.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);

/** Errors no retry can fix: bad configuration or credentials, invalid requests, refusals. */
export function isPermanentError(error: unknown): boolean {
  if (error instanceof ConfigError) return true;
  // A usage limit won't lift on retry; retrying would only spend the attempts.
  if (error instanceof UsageLimitError) return true;
  if (error instanceof LlmError || error instanceof SearchError) return !error.retryable;
  if (error instanceof AppError) return PERMANENT_STATUSES.has(error.status);
  // A payload that fails validation fails the same way every time.
  if (error instanceof z.ZodError) return true;
  return false;
}

/**
 * Failures that can't be the item's own: a response schema the provider can't compile, a refused
 * key, missing configuration. Every item fails the same way until the code or configuration is
 * fixed, so such a failure is not counted against the item's own retries (ADR-046). Any other
 * rejected request (`invalid_request`) still counts: it can come from the item itself, such as a
 * prompt too long for the model.
 */
export function isRequestConfigurationError(error: unknown): boolean {
  if (error instanceof ConfigError) return true;
  return error instanceof LlmError && (error.kind === 'schema_rejected' || error.kind === 'auth');
}
