/**
 * Regression pin for the local-lane green wave's harness contract.
 *
 * test/helpers/gbrain-home-preload.ts sets GBRAIN_HOME to per-run scratch when
 * unset and respects a pre-set value. Every unit test's isolation from the
 * operator's real ~/.gbrain depends on it.
 *
 * The pins spawn a fresh bun process: the contract is about process-start
 * module-load behavior, which can't be observed in-process.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

const REPO = join(import.meta.dir, '..');

function runBunEval(script: string, env: Record<string, string | undefined>): string {
  const res = spawnSync('bun', ['-e', script], {
    encoding: 'utf-8',
    timeout: 60_000,
    cwd: REPO,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  });
  return (res.stdout ?? '').trim();
}

describe('gbrain-home-preload contract', () => {
  const PRELOAD = join(REPO, 'test', 'helpers', 'gbrain-home-preload.ts');

  test('sets GBRAIN_HOME to per-run scratch when unset', () => {
    const script = [
      `await import(${JSON.stringify(PRELOAD)});`,
      `console.log(JSON.stringify({ home: process.env.GBRAIN_HOME ?? null }));`,
    ].join('\n');
    const out = runBunEval(script, { GBRAIN_HOME: undefined });
    const parsed = JSON.parse(out.split('\n').pop()!) as { home: string | null };
    expect(parsed.home).not.toBeNull();
    expect(parsed.home!).toContain('devmodel-test-home-');
  });

  test('respects a pre-set GBRAIN_HOME (the e2e wrapper sets its own)', () => {
    const script = [
      `await import(${JSON.stringify(PRELOAD)});`,
      `console.log(JSON.stringify({ home: process.env.GBRAIN_HOME ?? null }));`,
    ].join('\n');
    const out = runBunEval(script, { GBRAIN_HOME: '/tmp/devmodel-preload-preset-pin' });
    const parsed = JSON.parse(out.split('\n').pop()!) as { home: string | null };
    expect(parsed.home).toBe('/tmp/devmodel-preload-preset-pin');
  });
});
