import { describe, expect, it } from 'vitest';

import { isRequestConfigurationFailure } from './failures.js';

describe('isRequestConfigurationFailure', () => {
  it.each([
    'Anthropic API error 400: Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large, which would cause performance issues."}}',
    'Schema is too complex for compilation.',
    'discovery.evaluate: not sent. schema_rejected earlier in this process',
    'invalid_request: Gemini API error 400: Request contains an invalid argument.',
    'Anthropic API error 401: invalid x-api-key',
    'Anthropic API error 403: forbidden',
  ])('needs a fix, not a retry: %s', (detail) => {
    expect(isRequestConfigurationFailure(detail)).toBe(true);
  });

  it.each([
    'Anthropic API error 529: overloaded_error',
    'unavailable: Gemini API error 503: high demand',
    'Anthropic API error 429: rate_limit_error',
    'The usage limit of 60 AI calls in 24 hours has been reached (AI_DAILY_CALL_LIMIT).',
    'discovery.evaluate: the AI service didn’t finish within 240 s.',
    'discovery.evaluate: output failed validation after a repair attempt.',
    'Story 6ad99af1496277f17ca51400 not found',
  ])('is not a request-construction failure: %s', (detail) => {
    expect(isRequestConfigurationFailure(detail)).toBe(false);
  });
});
