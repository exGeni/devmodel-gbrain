/**
 * GBRA-135 L6: a lane fails when its tests did not all run.
 * A keyless or all-skip `bun test` exits 0, so scripts/require-executed-tests.ts
 * reads the run's receipts and refuses zero passes, any skip and any failure.
 */
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executedProblems } from '../../scripts/require-executed-tests.ts';

const REPO = join(import.meta.dir, '../..');

function receiptsFor(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-require-executed-'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/t2.test.ts'), `import { describe, test, expect } from 'bun:test';\n${body}`);
  const receipts = join(root, 'receipts');
  const run = spawnSync('bash', [join(REPO, 'scripts/run-with-receipt.sh'), 'tier2', 'skills', '--', 'bun', 'test', '--timeout=60000', join(root, 'test/t2.test.ts')], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, GBRAIN_TEST_RECEIPT_DIR: receipts },
  });
  return { root, receipts, run };
}

const guard = (dir: string, lane = 'tier2') =>
  spawnSync('bun', [join(REPO, 'scripts/require-executed-tests.ts'), dir, lane], { cwd: REPO, encoding: 'utf8' });

describe('require-executed-tests', () => {
  test('a file that skips everything exits 0, and the guard fails it', () => {
    const { root, receipts, run } = receiptsFor(`describe('t2', () => { test.skip('keyed', () => {}); });`);
    try {
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const g = guard(receipts);
      expect(g.status).toBe(1);
      expect(g.stderr).toContain('tier2 ran 0 tests');
      expect(g.stderr).toMatch(/skip: .*t2\.test\.ts > t2 > keyed/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('passes only when at least one test ran and every test passed', () => {
    const { root, receipts, run } = receiptsFor(`describe('t2', () => { test('a', () => expect(1).toBe(1)); test('b', () => {}); });`);
    try {
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(executedProblems(receipts, 'tier2')).toEqual([]);
      const g = guard(receipts);
      expect(g.status, g.stderr).toBe(0);
      expect(g.stdout).toContain('tier2: every test ran and passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a partial skip fails even when other tests passed', () => {
    const { root, receipts } = receiptsFor(`describe('t2', () => { test('a', () => {}); test.skip('keyed', () => {}); });`);
    try {
      const problems = executedProblems(receipts, 'tier2');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^skip: .*t2\.test\.ts > t2 > keyed$/);
      expect(guard(receipts).status).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a failed test, a missing receipt and another lane all fail', () => {
    const { root, receipts, run } = receiptsFor(`test('broken', () => expect(1).toBe(2));`);
    try {
      expect(run.status).not.toBe(0);
      expect(executedProblems(receipts, 'tier2')).toEqual(['tier2 ran 0 tests', expect.stringMatching(/^fail: .*t2\.test\.ts > broken$/)]);
      expect(executedProblems(receipts, 'tier1')).toEqual([`no tier1 receipt in ${receipts}: the test step did not run`]);
      expect(executedProblems(join(root, 'absent'), 'tier2')[0]).toContain('the test step did not run');
      expect(guard(join(root, 'absent')).status).toBe(1);
      expect(guard('').status).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an E2E shard whose files all skip exits 0 through run-e2e.sh, and the guard fails it (#8003)', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-require-executed-grad-'));
    try {
      for (const dir of ['scripts/lib', 'test/e2e']) mkdirSync(join(root, dir), { recursive: true });
      for (const file of ['run-e2e.sh', 'sharding.ts', 'lib/test-env.sh']) copyFileSync(join(REPO, 'scripts', file), join(root, 'scripts', file));
      writeFileSync(join(root, 'test/e2e/grad.test.ts'), "import { describe, test } from 'bun:test';\ndescribe('grad', () => { test.skip('keyed history round trip', () => {}); });\n");
      const receipts = join(root, 'receipts');
      const env: Record<string, string | undefined> = { ...process.env, GBRAIN_TEST_RECEIPT_DIR: receipts, GBRAIN_TEST_RECEIPT_LANE: 'tier1', SHARD: '1/1' };
      delete env.DATABASE_URL;
      const run = spawnSync('bash', ['scripts/run-e2e.sh', 'test/e2e/grad.test.ts'], { cwd: root, encoding: 'utf8', env });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const g = guard(receipts, 'tier1');
      expect(g.status).toBe(1);
      expect(g.stderr).toContain('tier1 ran 0 tests');
      expect(g.stderr).toContain('skip: test/e2e/grad.test.ts > grad > keyed history round trip');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
