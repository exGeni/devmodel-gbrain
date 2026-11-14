/**
 * Fixture-driven unit tests for scripts/check-test-isolation.sh.
 *
 * Spawns the script in a tmpdir with hand-crafted fake test files and
 * asserts the lint's exit code + violation messages match expectations.
 * No env mutation, no mock.module — this test file is itself
 * subject to the lint (it ships outside *.serial.test.ts and outside
 * test/e2e/).
 */

import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const LINT_SH = resolve(REPO_ROOT, 'scripts/check-test-isolation.sh');

interface FakeFile {
  /** Path relative to the tmpdir's `test/` directory. */
  path: string;
  contents: string;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runLintIn(files: FakeFile[], allowlist: string[] = [], env: Record<string, string> = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'lint-isolation-'));
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });

  for (const f of files) {
    const full = join(dir, 'test', f.path);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, f.contents);
  }
  // Empty allowlist file ensures the script reads OUR allowlist, not the
  // real repo's, regardless of git toplevel resolution.
  writeFileSync(
    join(dir, 'scripts/check-test-isolation.allowlist'),
    allowlist.length > 0 ? allowlist.join('\n') + '\n' : '',
  );

  const r = spawnSync('bash', [LINT_SH, 'test'], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe('check-test-isolation.sh', () => {
  describe('clean files', () => {
    it('returns 0 when no test files violate any rule', () => {
      const r = runLintIn([
        {
          path: 'a.test.ts',
          contents: `import { test, expect } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n`,
        },
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('check-test-isolation: OK');
    });

    it('batches candidate scans instead of starting grep for every clean file', () => {
      const bin = mkdtempSync(join(tmpdir(), 'lint-grep-count-'));
      const log = join(bin, 'calls');
      writeFileSync(join(bin, 'grep'), `#!/usr/bin/env bash\nprintf 'grep\\n' >> "$GREP_CALL_LOG"\nexec "$REAL_GREP" "$@"\n`, { mode: 0o755 });
      try {
        const files = Array.from({ length: 260 }, (_, i) => ({ path: `clean ${i}.test.ts`, contents: 'if (process.env.TEST_MODE === "yes") {}\n' }));
        const env = { PATH: `${bin}:${process.env.PATH}`, GREP_CALL_LOG: log, REAL_GREP: Bun.which('grep')! };
        const r = runLintIn(
          files,
          [],
          env,
        );
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('260 non-serial unit files scanned');
        expect(readFileSync(log, 'utf8').trim().split('\n').length).toBeLessThan(10);
        const bad = runLintIn([...files, { path: 'z bad.test.ts', contents: `Reflect.set(process.env, 'OOPS', 'bad');\n` }], [], env);
        expect(bad.status).toBe(1);
        expect(bad.stdout).toContain('z bad.test.ts');
        expect(bad.stdout).toContain('rule R1');
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
    it('lints candidate files in one pass instead of starting grep or awk per file (#8053)', () => {
      const bin = mkdtempSync(join(tmpdir(), 'lint-candidate-count-'));
      const log = join(bin, 'calls');
      for (const tool of ['grep', 'awk']) {
        writeFileSync(join(bin, tool), '#!/usr/bin/env bash\nprintf "' + tool + '\\n" >> "$CALL_LOG"\nexec "' + Bun.which(tool)! + '" "$@"\n', { mode: 0o755 });
      }
      try {
        // Every file matches a rule pattern (so it is a grep candidate) and is
        // allow-listed (so the one awk pass skips it): 200 candidates, one pass.
        const candidate = "process.env.EXAMPLE_FLAG = '1';\n";
        const files = Array.from({ length: 200 }, (_, i) => ({ path: 'candidate ' + i + '.test.ts', contents: candidate }));
        const allowlist = files.map((f) => 'test/' + f.path);
        const env = { PATH: bin + ':' + process.env.PATH, CALL_LOG: log };
        const r = runLintIn(files, allowlist, env);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('200 non-serial unit files scanned');
        expect(readFileSync(log, 'utf8').trim().split('\n').length).toBeLessThan(12);
        const badContents = "process.env.EXAMPLE_FLAG = '1';\nmock.module('x', () => ({}));\n";
        const bad = runLintIn([...files, { path: 'z bad.test.ts', contents: badContents }], allowlist, env);
        expect(bad.status).toBe(1);
        expect(bad.stdout).toContain('ERROR: test/z bad.test.ts\n       rule R1:');
        expect(bad.stdout).toContain("         1:process.env.EXAMPLE_FLAG = '1';\nERROR: test/z bad.test.ts\n       rule R2:");
        expect(bad.stdout).toContain('check-test-isolation: FAIL (2 violation(s))');
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  });

  describe('R1 — env mutation', () => {
    it('flags process.env.X = assignment', () => {
      const r = runLintIn([
        {
          path: 'env-write.test.ts',
          contents: `process.env.OOPS = 'bad';\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
      expect(r.stdout).toContain('env-write.test.ts');
    });

    it('flags process.env[bracket] = assignment', () => {
      const r = runLintIn([
        {
          path: 'env-bracket.test.ts',
          contents: `process.env['OOPS'] = 'bad';\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
    });

    it('flags delete process.env.X', () => {
      const r = runLintIn([
        {
          path: 'env-delete.test.ts',
          contents: `delete process.env.OOPS;\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
    });

    it('flags Object.assign(process.env, ...)', () => {
      const r = runLintIn([
        {
          path: 'env-assign.test.ts',
          contents: `Object.assign(process.env, { OOPS: 'bad' });\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
    });

    it('flags Reflect.set(process.env, ...)', () => {
      const r = runLintIn([
        {
          path: 'env-reflect.test.ts',
          contents: `Reflect.set(process.env, 'OOPS', 'bad');\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
    });

    it('does NOT flag a comparison like process.env.X === ...', () => {
      const r = runLintIn([
        {
          path: 'env-read.test.ts',
          contents: `if (process.env.X === 'y') {}\n`,
        },
      ]);
      expect(r.status).toBe(0);
    });
  });

  describe('R2 — mock.module()', () => {
    it('flags mock.module(...)', () => {
      const r = runLintIn([
        {
          path: 'mocks.test.ts',
          contents: `import { mock } from 'bun:test';\nmock.module('foo', () => ({}));\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R2');
    });
  });

  describe('scope', () => {
    it('skips *.serial.test.ts files entirely', () => {
      const r = runLintIn([
        {
          path: 'naughty.serial.test.ts',
          contents: `process.env.OOPS = 'bad';\nimport { mock } from 'bun:test';\nmock.module('foo', () => ({}));\n`,
        },
      ]);
      expect(r.status).toBe(0);
    });

    it('skips test/e2e/ subtree', () => {
      const r = runLintIn([
        {
          path: 'e2e/leak.test.ts',
          contents: `process.env.OOPS = 'bad';\n`,
        },
      ]);
      expect(r.status).toBe(0);
    });
  });

  describe('allowlist', () => {
    it('skips files listed in the allowlist', () => {
      const r = runLintIn(
        [
          {
            path: 'legacy.test.ts',
            contents: `process.env.OOPS = 'bad';\n`,
          },
        ],
        ['test/legacy.test.ts'],
      );
      expect(r.status).toBe(0);
    });

    it('still flags files NOT in the allowlist when allowlist is non-empty', () => {
      const r = runLintIn(
        [
          {
            path: 'allowed.test.ts',
            contents: `process.env.X = 'a';\n`,
          },
          {
            path: 'fresh.test.ts',
            contents: `process.env.Y = 'b';\n`,
          },
        ],
        ['test/allowed.test.ts'],
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('fresh.test.ts');
      expect(r.stdout).not.toContain('allowed.test.ts');
    });

    it('treats # comments and blank lines in allowlist as no-ops', () => {
      const r = runLintIn(
        [
          {
            path: 'legacy.test.ts',
            contents: `process.env.OOPS = 'bad';\n`,
          },
        ],
        ['# legacy file', '', 'test/legacy.test.ts'],
      );
      expect(r.status).toBe(0);
    });
  });
});

describe('check-test-isolation.sh --as-parallel', () => {
  function runAsParallel(files: FakeFile[], targets: string[]): RunResult {
    const dir = mkdtempSync(join(tmpdir(), 'lint-isolation-parallel-'));
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts/check-test-isolation.allowlist'), '');
      for (const f of files) {
        const full = join(dir, 'test', f.path);
        mkdirSync(resolve(full, '..'), { recursive: true });
        writeFileSync(full, f.contents);
      }
      const r = spawnSync('bash', [LINT_SH, '--as-parallel', ...targets.map(t => `test/${t}`)], { cwd: dir, encoding: 'utf-8' });
      return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('lints a serial file as if it ran in the parallel pool', () => {
    const r = runAsParallel([{ path: 'env.serial.test.ts', contents: "process.env.EXAMPLE_FLAG = '1';\n" }], ['env.serial.test.ts']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('ERROR: test/env.serial.test.ts');
    expect(r.stdout).toContain('rule R1');
  });

  it('passes a parallel-safe serial file and lints only the named files', () => {
    const r = runAsParallel([
      { path: 'clean.serial.test.ts', contents: "import { test } from 'bun:test';\ntest('x', () => {});\n" },
      { path: 'other.serial.test.ts', contents: "mock.module('x', () => ({}));\n" },
    ], ['clean.serial.test.ts']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK (1 ');
  });

  it('requires at least one file', () => {
    const r = runAsParallel([], []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--as-parallel FILE');
  });
});
