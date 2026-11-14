/**
 * The operator-env scrub policy, shared by test/helpers/operator-env-preload.ts
 * (which applies it before any test file loads) and
 * scripts/check-test-env-opt-ins.ts (which fails on a test that gates
 * execution on a GBRAIN_* name this policy strips). Side-effect free.
 *
 * Naming rule for test opt-ins: `GBRAIN_TEST_<AREA>_<WHAT>`; paid ones
 * `GBRAIN_TEST_LIVE_<WHAT>`. The `GBRAIN_TEST_` prefix survives the scrub, so a
 * test opt-in under it can never be silently stripped. Documented exceptions
 * kept for compatibility: the `GBRAIN_E2E_*` and `GBRAIN_CI_*` prefixes.
 */

/** Operator/agent workspace prefixes with no test-machinery tenants. */
export const STRIP_PREFIX = /^(CONDUCTOR_|MCP_|OPENCLAW_)/;

export const KEEP_EXACT: ReadonlySet<string> = new Set([
  'GBRAIN_HOME', // per-run HOME isolation — gbrain-home-preload and run-e2e.sh both respect a pre-set value
  'GBRAIN_DATABASE_URL', // e2e DB target; database-url-guard-preload (registered first) already vetoed un-opted runs
  'GBRAIN_MODEL_DISCOVERY', // operator override provider-keys-preload deliberately respects
  'GBRAIN_AUDIT_DIR', // audit-dir-preload honors a wrapper pre-set (inspect audit output after a run)
  'GBRAIN_SYNC_FAILURES_DIR', // same wrapper pre-set contract in sync-failures-preload
  'GBRAIN_DEBUG_PRELOAD', // the preload stack's own logging hatch
]);

// GBRAIN_TEST_*: test-control opt-ins (ALLOW_DATABASE_URL, KEEP_PROVIDER_KEYS,
// shard/memory knobs) must survive their own scrub or every escape hatch is a
// dead end. GBRAIN_CI_*: ci-local.sh port plumbing. GBRAIN_E2E_*: db-guard's
// name-floor opt-in (its error message tells operators to set it) + e2e
// runner knobs.
export const KEEP_PREFIX = /^GBRAIN_(TEST_|CI_|E2E_)/;

/**
 * Test opt-ins renamed into the GBRAIN_TEST_ namespace. Under their old names
 * the scrub deleted them before any test read them, so every opt-in below was
 * a silent no-op. Setting an old name now stops the run with the rename line
 * instead of skipping silently. Shell readers (scripts/check-bash32.sh) carry
 * the same check for the names they read.
 */
export const RENAMED: Readonly<Record<string, string>> = {
  GBRAIN_BASH32_REQUIRE: 'GBRAIN_TEST_BASH32_REQUIRE',
};

/** Whether the scrub deletes `name` from a test process's environment. */
export function isStripped(name: string): boolean {
  if (STRIP_PREFIX.test(name)) return true;
  return name.startsWith('GBRAIN_') && !KEEP_EXACT.has(name) && !KEEP_PREFIX.test(name);
}

/** The fail-fast message for an old opt-in name, or null when `name` was not renamed. */
export function renamedOptInMessage(name: string, value: string): string | null {
  const next = RENAMED[name];
  if (!next) return null;
  return [
    `${name} was renamed to ${next}.`,
    'Why: test opt-ins must survive the operator-env scrub (test/helpers/operator-env-preload.ts), which deletes GBRAIN_* names outside GBRAIN_TEST_*; under the old name this opt-in was silently ignored.',
    `Fix: unset ${name} && export ${next}=${value}`,
    'Docs: docs/TESTING.md#test-isolation-lint-and-helpers',
  ].join('\n');
}
