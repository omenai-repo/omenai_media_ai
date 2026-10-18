import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { ConfigError } from '../config/env.js';
import { AppError, ConflictError, NotFoundError } from '../errors.js';
import { LlmError } from '../llm/types.js';
import { isPermanentError } from './errors.js';

describe('which background failures are worth retrying', () => {
  it('stops at once for configuration, refusals, invalid requests and missing records', () => {
    expect(isPermanentError(new ConfigError('GEMINI_API_KEY'))).toBe(true);
    expect(
      isPermanentError(new LlmError('invalid_request', 'bad', 'gemini', { status: 400 })),
    ).toBe(true);
    expect(isPermanentError(new NotFoundError('Draft task not found.'))).toBe(true);
    expect(isPermanentError(new AppError('INVALID_FORMAT', 'Unknown draft format.', 422))).toBe(
      true,
    );
    expect(isPermanentError(z.object({ taskKey: z.string() }).safeParse({}).error)).toBe(true);
  });

  it('retries outages, rate limits, conflicts that can clear, and anything unknown', () => {
    expect(isPermanentError(new LlmError('unavailable', 'busy', 'gemini', { status: 503 }))).toBe(
      false,
    );
    expect(isPermanentError(new ConflictError('DRAFT_BUSY', 'Several versions at once.'))).toBe(
      false,
    );
    expect(isPermanentError(new Error('socket hang up'))).toBe(false);
  });
});
