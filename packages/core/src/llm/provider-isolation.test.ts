/**
 * Guards the provider switch: only the adapters may import a provider SDK. If business logic
 * imported one, switching LLM_PROVIDER would silently leave provider-specific behaviour behind.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const PROVIDER_SDK = /from ['"](@google\/genai|@anthropic-ai\/sdk)(\/[^'"]*)?['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.next') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Every non-test source file of the core package and both apps, relative to the repo root. */
function repoSources(): string[] {
  return ['packages/core/src', 'apps/web/src', 'apps/worker/src'].flatMap((dir) =>
    sourceFiles(join(REPO, dir)).map((path) => relative(REPO, path)),
  );
}

function offenders(pattern: RegExp, allowed: (path: string) => boolean): string[] {
  return repoSources().filter(
    (path) => !allowed(path) && pattern.test(readFileSync(join(REPO, path), 'utf8')),
  );
}

describe('provider isolation', () => {
  it('imports provider SDKs only inside llm/providers', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !path.startsWith(join('llm', 'providers')))
      .filter((path) => PROVIDER_SDK.test(readFileSync(join(SRC, path), 'utf8')));
    expect(offenders).toEqual([]);
  });

  /**
   * One resolution path: a workload can't pick its own provider, so the production rule in
   * `llm/config.ts` (Anthropic only) covers every task, route and retry.
   */
  it('constructs provider adapters only in the client factory', () => {
    expect(
      offenders(
        /\bcreate(Gemini|Anthropic)Provider\(/,
        (path) => path === 'packages/core/src/llm/client.ts' || path.includes('/llm/providers/'),
      ),
    ).toEqual([]);
  });

  it('reads provider and model settings only in the LLM configuration', () => {
    expect(
      offenders(
        // A read names the variable in a string or on process.env (comments may mention it).
        /(['"]|process\.env\.)(LLM_PROVIDER|GEMINI_API_KEY|ANTHROPIC_API_KEY|(GEMINI|ANTHROPIC)_MODEL_)/,
        (path) =>
          path === 'packages/core/src/llm/config.ts' ||
          // The env check prints and compares settings; it never calls a model.
          path === 'packages/core/src/cli/check-env.ts',
      ),
    ).toEqual([]);
  });

  it('gives the apps model clients only through getLlmClient (or fixtures, gated)', () => {
    expect(offenders(/\bcreateLlmClient\(/, (path) => !path.startsWith('apps/'))).toEqual([]);
  });
});
