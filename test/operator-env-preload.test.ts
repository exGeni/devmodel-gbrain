/**
 * #4023 operator-context hermeticity: a bare `bun test` must not inherit the
 * operator's ambient agent/workspace context. A stray GBRAIN_SOURCE
 * short-circuits source resolution at tier `env` before the tier under test;
 * a GBRAIN_CYCLE_FRESHNESS_WARN_HOURS moves the very threshold
 * doctor-cycle-freshness asserts; CONDUCTOR_/MCP_/OPENCLAW_ workspace vars
 * are one `gbrain init`-shaped test away from the same class. run-e2e.sh
 * already scrubs these for the E2E lane; test/helpers/operator-env-preload.ts
 * is the unit-lane equivalent, and the repo's own test machinery (the
 * DEVMODEL_TEST_ / DEVMODEL_CI_ / DEVMODEL_E2E_ prefixes + the exact keeps) must
 * survive it.
 *
 * Each case spawns a real `bun test` child on a probe fixture with a
 * controlled environment (the database-url-guard-preload.test.ts pattern), so
 * what's asserted is the actual preload behavior, not a re-implementation of
 * it. The probe reports the surviving values as JSON; all asserting happens
 * here.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PROBE = 'test/fixtures/preload-guard/operator-env-probe.test.ts';

/**
 * Base child env: inherit, then strip every var these cases assert on plus
 * the guard/scrub opt-ins, so a dev shell's own exports can't contaminate
 * either direction of an assertion.
 */
function baseEnv(probed: string[]): Record<string, string> {
  const drop = new Set([
    ...probed,
    'DATABASE_URL',
    'GBRAIN_DATABASE_URL',
    'DEVMODEL_TEST_ALLOW_DATABASE_URL',
    'DEVMODEL_TEST_KEEP_AMBIENT_ENV',
    'DEVMODEL_DEBUG_PRELOAD',
  ]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || drop.has(k)) continue;
    env[k] = v;
  }
  return env;
}

function runProbe(
  ambient: Record<string, string>,
  probed: string[],
): { exitCode: number; stderr: string; report: Record<string, string | null> } {
  const dir = mkdtempSync(join(tmpdir(), 'gb-operator-env-probe-'));
  const out = join(dir, 'report.json');
  try {
    const proc = Bun.spawnSync(['bun', 'test', '--timeout=15000', PROBE], {
      cwd: REPO_ROOT,
      env: {
        ...baseEnv(probed),
        ...ambient,
        DEVMODEL_TEST_OPERATOR_ENV_PROBE_OUT: out,
        DEVMODEL_TEST_OPERATOR_ENV_PROBE_NAMES: probed.join(','),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      // A hung child would otherwise block the sync call past bun's own
      // per-test timeout (which cannot preempt a native sync call).
      timeout: 20_000,
      killSignal: 'SIGKILL',
    });
    let report: Record<string, string | null> = {};
    try {
      report = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      // Leave {} — the exitCode assertion will surface the child failure.
    }
    return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString(), report };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('operator-env-preload (#4023)', () => {
  test('strips ambient operator context: CONDUCTOR_/MCP_/OPENCLAW_ wholesale, GBRAIN_ config overrides', () => {
    const probed = [
      'CONDUCTOR_WORKSPACE_NAME',
      'MCP_SCOPE',
      'OPENCLAW_WORKSPACE',
      'GBRAIN_SOURCE',
      'GBRAIN_CYCLE_FRESHNESS_WARN_HOURS',
      'GBRAIN_BRAIN_ID',
    ];
    const r = runProbe(
      {
        CONDUCTOR_WORKSPACE_NAME: 'ambient-leak',
        MCP_SCOPE: 'ambient-leak',
        OPENCLAW_WORKSPACE: 'ambient-leak',
        GBRAIN_SOURCE: 'default',
        GBRAIN_CYCLE_FRESHNESS_WARN_HOURS: '10',
        GBRAIN_BRAIN_ID: 'ambient-leak',
      },
      probed,
    );
    expect(r.exitCode).toBe(0);
    for (const name of probed) expect({ [name]: r.report[name] }).toEqual({ [name]: null });
  }, 30_000);

  test('keeps the test machinery the runners and CI workflows export', () => {
    const probed = [
      'GBRAIN_MODEL_DISCOVERY',
      'DEVMODEL_TEST_SENTINEL',
      'DEVMODEL_CI_EXAMPLE_PORT',
      'DEVMODEL_E2E_ALLOW_DB',
    ];
    const ambient: Record<string, string> = {
      // '1' (not 'off') so a strip is distinguishable from provider-keys-
      // preload's own default of 'off' when the var is absent.
      GBRAIN_MODEL_DISCOVERY: '1',
      DEVMODEL_TEST_SENTINEL: 'kept',
      DEVMODEL_CI_EXAMPLE_PORT: '5434',
      DEVMODEL_E2E_ALLOW_DB: 'gbrain_probe_db',
    };
    const r = runProbe(ambient, probed);
    expect(r.exitCode).toBe(0);
    for (const name of probed) expect({ [name]: r.report[name] }).toEqual({ [name]: ambient[name] });
  }, 30_000);

  test('keeps GBRAIN_DATABASE_URL in the opted-in e2e lane', () => {
    // GBRAIN_DATABASE_URL is on the keep-list: the database-url guard
    // preload, registered first, has already approved the run.
    const url = 'postgresql://localhost:5434/gbrain_probe';
    const r = runProbe(
      { GBRAIN_DATABASE_URL: url, DEVMODEL_TEST_ALLOW_DATABASE_URL: '1' },
      ['GBRAIN_DATABASE_URL'],
    );
    expect(r.exitCode).toBe(0);
    expect(r.report.GBRAIN_DATABASE_URL).toBe(url);
  }, 30_000);

  test('DEVMODEL_TEST_KEEP_AMBIENT_ENV=1 disables the scrub', () => {
    const r = runProbe(
      { GBRAIN_SOURCE: 'default', DEVMODEL_TEST_KEEP_AMBIENT_ENV: '1' },
      ['GBRAIN_SOURCE'],
    );
    expect(r.exitCode).toBe(0);
    expect(r.report.GBRAIN_SOURCE).toBe('default');
  }, 30_000);

  test('a renamed test opt-in set under its old name stops the run with the rename line', () => {
    // Under the old names the scrub deleted these before any test read them,
    // so the gated tests skipped silently (D7). The preload now exits first.
    for (const [old, next] of [
      ['GBRAIN_BASH32_REQUIRE', 'DEVMODEL_TEST_BASH32_REQUIRE'],
      ['GBRAIN_TEST_KEEP_PROVIDER_KEYS', 'DEVMODEL_TEST_KEEP_PROVIDER_KEYS'],
      ['GBRAIN_E2E_FILE_TIMEOUT', 'DEVMODEL_E2E_FILE_TIMEOUT'],
    ]) {
      // Also with the scrub disabled: the old-name check runs before it.
      const r = runProbe({ [old]: '1', DEVMODEL_TEST_KEEP_AMBIENT_ENV: '1' }, [old]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(`${old} was renamed to ${next}.`);
      expect(r.stderr).toContain(`Fix: unset ${old} && export ${next}=1`);
      expect(r.stderr).toContain('Docs: docs/TESTING.md#test-isolation-lint-and-helpers');
      expect(r.report).toEqual({});
    }
  }, 60_000);

  test('the new opt-in names survive the scrub', () => {
    const probed = ['DEVMODEL_TEST_EXAMPLE_FLAG', 'DEVMODEL_TEST_BASH32_REQUIRE', 'DEVMODEL_TEST_EXAMPLE_MULTIPLIER'];
    const ambient = { DEVMODEL_TEST_EXAMPLE_FLAG: '1', DEVMODEL_TEST_BASH32_REQUIRE: '1', DEVMODEL_TEST_EXAMPLE_MULTIPLIER: '3' };
    const r = runProbe(ambient, probed);
    expect(r.exitCode).toBe(0);
    expect(r.report).toEqual(ambient);
  }, 30_000);

  test('DEVMODEL_DEBUG_PRELOAD=1 logs removed names, never values', () => {
    const r = runProbe(
      { GBRAIN_SOURCE: 'hunter2-not-for-logs', DEVMODEL_DEBUG_PRELOAD: '1' },
      ['GBRAIN_SOURCE'],
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('GBRAIN_SOURCE');
    expect(r.stderr).not.toContain('hunter2-not-for-logs');
  }, 30_000);
});
