import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const source = readFileSync(join(import.meta.dir, '../../scripts/ci-local.sh'), 'utf8');
const phasesStart = source.indexOf('# Step 2: build the phase command.');
const phasesEnd = source.indexOf('\necho ""\necho "[ci-local] All checks passed."', phasesStart);
const gateStart = source.indexOf('# Full gate: everything below runs for any diff that is not doc-only.');

test('the local gate avoids GNU-only xargs flags', () => {
  // `xargs -a FILE` is GNU-only; BSD xargs (macOS hosts) rejects it.
  expect(source).not.toMatch(/xargs\s+-a\b/);
});

function runPhases(noShard: boolean, diff: boolean, failStage = '') {
  const home = mkdtempSync(join(tmpdir(), 'devmodel-ci-phases-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    mkdirSync(join(home, 'scripts'));
    const trace = join(home, 'trace');
    const put = (path: string, body: string) => writeFileSync(join(home, path), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    put('bin/bun', `
case "$*" in
  "run verify") stage=verify ;;
  "run test:serial") stage=serial ;;
  "run test:slow") stage=slow ;;
  *) exit 0 ;;
esac
printf '%s:%s\\n' "$stage" "\${DATABASE_URL-unset}" >> "$TRACE"
[ "$FAIL_STAGE" != "$stage" ] || exit 7
`);
    put('scripts/check-bun-test-timeout.sh', `
printf 'timeout_guard:%s\\n' "\${DATABASE_URL-unset}" >> "$TRACE"
[ "$FAIL_STAGE" != timeout_guard ] || exit 7
`);
    put('scripts/run-unit-shard.sh', `
printf 'unit:%s:%s\\n' "\${SHARD-all}" "\${DATABASE_URL-unset}" >> "$TRACE"
printf '%s\\n' 'early diagnostic retained beyond summary tail' >&2
for line in {1..35}; do printf 'fixture progress %s\\n' "$line"; done
[ -z "\${DATABASE_URL:-}" ] || exit 41
[ "$FAIL_STAGE" != unit ] || exit 7
`);
    put('scripts/run-e2e.sh', `
printf 'e2e:%s:%s\\n' "\${SHARD-all}" "$*" >> "$TRACE"
[ "$FAIL_STAGE" != e2e ] || exit 7
`);
    expect(phasesStart).toBeGreaterThanOrEqual(0);
    expect(phasesEnd).toBeGreaterThan(phasesStart);
    const script = source.slice(phasesStart, phasesEnd);
    const result = spawnSync('bash', ['-c', script], {
      cwd: home, encoding: 'utf8', timeout: 5_000,
      env: {
        ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TRACE: trace,
        NO_SHARD: noShard ? '1' : '0', DIFF: diff ? '1' : '0', FAIL_STAGE: failStage,
        DATABASE_URL: 'ambient-fixture', GBRAIN_DATABASE_URL: 'ambient-fixture',
      },
    });
    const archivedLogs = [1, 2, 3, 4].map(shard => {
      const path = join(home, '.context/ci-local-shards', `shard-${shard}.log`);
      return existsSync(path) ? readFileSync(path, 'utf8') : '';
    });
    return { ...result, archivedLogs, trace: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [] };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('ci-local execution coverage', () => {
  for (const noShard of [false, true]) {
    for (const diff of [false, true]) {
      test(`serial and slow precede unit/E2E (no-shard=${noShard}, diff=${diff})`, () => {
        const result = runPhases(noShard, diff);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.trace.slice(0, 4)).toEqual(['timeout_guard:ambient-fixture', 'verify:ambient-fixture', 'serial:unset', 'slow:unset']);
        const units = result.trace.filter(line => line.startsWith('unit:'));
        const e2e = result.trace.filter(line => line.startsWith('e2e:'));
        expect(units).toHaveLength(noShard ? 1 : 4);
        expect(units.every(line => line.endsWith(':unset'))).toBe(true);
        expect(e2e).toHaveLength(noShard ? 1 : 4);
        // --diff no longer narrows: every shard runs run-e2e.sh's full discovery.
        expect(e2e.every(line => line.endsWith(':'))).toBe(true);
        if (!noShard) {
          expect(result.stdout).toContain('Complete shard logs saved to .context/ci-local-shards/');
          for (const log of result.archivedLogs) {
            expect(log).toContain('early diagnostic retained beyond summary tail');
            expect(log).toContain('DONE');
          }
        }
      });
    }
  }

  for (const failStage of ['timeout_guard', 'verify', 'serial', 'slow', 'unit', 'e2e']) {
    test(`a failed ${failStage} stage cannot produce a green local CI result`, () => {
      const result = runPhases(false, false, failStage);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('All 4 shards passed');
      if (failStage !== 'e2e') expect(result.trace.some(line => line.startsWith('e2e:'))).toBe(false);
      if (['timeout_guard', 'verify', 'serial', 'slow'].includes(failStage)) {
        expect(result.status).toBe(7);
        expect(result.trace.some(line => line.startsWith('unit:'))).toBe(false);
        if (failStage === 'timeout_guard') expect(result.trace.some(line => line.startsWith('verify:'))).toBe(false);
      } else {
        for (const log of result.archivedLogs) {
          expect(log).toContain('early diagnostic retained beyond summary tail');
          expect(log).toContain(`${failStage.toUpperCase()} FAILED`);
        }
      }
    });
  }

  for (const gitleaks of ['missing', 'success', 'failure']) {
    test(`doc-only diff requires a successful gitleaks scan (${gitleaks})`, () => {
      const home = mkdtempSync(join(tmpdir(), 'devmodel-ci-docs-'));
      try {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        mkdirSync(join(home, 'scripts'));
        writeFileSync(join(bin, 'bun'), '#!/bin/sh\necho DOC_ONLY\n', { mode: 0o755 });
        writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SCAN_LOG"\n[ "$SCAN_MODE" != failure ]\n', { mode: 0o755 });
        const script = `command() { if [ "$1" = -v ] && [ "\${2:-}" = gitleaks ] && [ "$SCAN_MODE" = missing ]; then return 1; fi; builtin command "$@"; }\n${source.slice(0, gateStart)}`;
        const log = join(home, 'scans');
        // Keep this branch-routing fixture focused on the scanner result;
        // the real detector/configuration canary runs separately in CI.
        writeFileSync(join(home, 'scripts/test-gitleaks-config.sh'), 'exit 0\n');
        writeFileSync(join(home, 'scripts/scan-worktree-secrets.sh'), 'gitleaks dir . --redact --no-banner\n');
        writeFileSync(join(home, 'scripts/ci-doc-checks.sh'), 'printf "%s\\n" docs >> "$SCAN_LOG"\n');
        const result = spawnSync('bash', ['-c', script, join(home, 'scripts/ci-local.sh'), '--diff'], {
          encoding: 'utf8', timeout: 5_000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCAN_MODE: gitleaks, SCAN_LOG: log },
        });
        expect(result.status, result.stderr).toBe(gitleaks === 'success' ? 0 : 1);
        const scans = existsSync(log) ? readFileSync(log, 'utf8') : '';
        expect(scans).toBe(gitleaks === 'success' ? 'dir\ngit\ndocs\n' : gitleaks === 'failure' ? 'dir\n' : '');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  function diffPreflight(classification: string, docChecks = 'exit 0') {
    const home = mkdtempSync(join(tmpdir(), 'devmodel-ci-diff-'));
    try {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      mkdirSync(join(home, 'scripts'));
      writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho ${classification}\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(home, 'scripts/test-gitleaks-config.sh'), 'exit 0\n');
      writeFileSync(join(home, 'scripts/scan-worktree-secrets.sh'), 'exit 0\n');
      writeFileSync(join(home, 'scripts/ci-doc-checks.sh'), `${docChecks}\n`);
      return spawnSync('bash', ['-c', `${source.slice(0, gateStart)}\necho FULL_GATE_CONTINUES`, join(home, 'scripts/ci-local.sh'), '--diff'], {
        encoding: 'utf8', timeout: 5_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('doc-only diff fails when a doc check fails (e.g. llms.txt not rebuilt)', () => {
    const result = diffPreflight('DOC_ONLY', 'echo "Fix: bun run build:llms" >&2; exit 1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Fix: bun run build:llms');
    expect(result.stdout).not.toContain('FULL_GATE_CONTINUES');
  });

  for (const classification of ['SRC', 'EMPTY', 'ERR']) {
    test(`a ${classification} diff says narrowing is retired and runs the full gate`, () => {
      const result = diffPreflight(classification);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('E2E narrowing is retired; running the full E2E corpus (see docs/TESTING.md#e2e-selection)');
      expect(result.stdout).toContain('FULL_GATE_CONTINUES');
    });
  }
});

describe('local test configuration through run-e2e', () => {
  for (const disabled of ['1', '0', undefined]) {
    test(`preserves configuration isolation flag ${disabled ?? '(absent)'} through the actual Bun child`, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'devmodel-e2e-env-file-'));
      const repo = resolve(import.meta.dir, '../..');
      try {
        mkdirSync(join(fixture, 'scripts/lib'), { recursive: true });
        mkdirSync(join(fixture, 'test/e2e'), { recursive: true });
        writeFileSync(join(fixture, 'scripts/run-e2e.sh'), readFileSync(join(repo, 'scripts/run-e2e.sh')));
        writeFileSync(join(fixture, 'scripts/lib/test-env.sh'), readFileSync(join(repo, 'scripts/lib/test-env.sh')));
        const expected = {
          disabled: disabled ?? null,
          operatorOverride: null,
        };
        writeFileSync(join(fixture, 'test/e2e/config-file-probe.test.ts'), `
import { expect, test } from 'bun:test';
test('configuration file respects the parent isolation policy', () => {
  expect({
    disabled: process.env.DEVMODEL_CI_DISABLE_TEST_ENV_FILE ?? null,
    operatorOverride: process.env.GBRAIN_SOURCE ?? null,
  }).toEqual(${JSON.stringify(expected)});
});
`);
        const env: Record<string, string | undefined> = {
          ...process.env, HOME: fixture, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
          SHARD: '', COVERAGE_DIR: '', DATABASE_URL: '', GBRAIN_DATABASE_URL: '',
          GBRAIN_SOURCE: 'ambient-must-be-removed',
          DEVMODEL_CI_DISABLE_TEST_ENV_FILE: disabled,
        };
        const result = spawnSync('bash', [join(fixture, 'scripts/run-e2e.sh'), 'test/e2e/config-file-probe.test.ts'], {
          cwd: fixture, encoding: 'utf8', timeout: 20_000, env,
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('1 pass');
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    }, 25_000);
  }
});
