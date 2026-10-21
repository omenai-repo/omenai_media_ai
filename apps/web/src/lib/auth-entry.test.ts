/**
 * Every use of Better Auth goes through `getReadyAuth()`, which repairs the shared database
 * client before the adapter touches it. A direct `getAuth()` would bring back production's
 * "Topology is closed" failures after one failed connect (2026-10-21).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

describe('Better Auth entry points', () => {
  it('reach the auth instance only through getReadyAuth', () => {
    const direct = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => path !== join('lib', 'auth.ts'))
      .filter((path) => /\bgetAuth\(\)/.test(readFileSync(join(SRC, path), 'utf8')));
    expect(direct).toEqual([]);
  });
});
