/**
 * Guards the provider switch: only the adapters may import a provider SDK. If business logic
 * imported one, switching LLM_PROVIDER would silently leave provider-specific behaviour behind.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const PROVIDER_SDK = /from ['"](@google\/genai|@anthropic-ai\/sdk)(\/[^'"]*)?['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('provider isolation', () => {
  it('imports provider SDKs only inside llm/providers', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !path.startsWith(join('llm', 'providers')))
      .filter((path) => PROVIDER_SDK.test(readFileSync(join(SRC, path), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
