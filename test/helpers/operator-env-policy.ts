/**
 * The operator-env scrub policy, shared by test/helpers/operator-env-preload.ts
 * (which applies it before any test file loads) and
 * scripts/check-test-env-opt-ins.ts (which fails on a test that gates
 * execution on a name this policy strips). Side-effect free.
 *
 * Two namespaces are scrubbed. `DEVMODEL_*` is this repository's own: its
 * test opt-ins and runner knobs. `GBRAIN_*` belongs to the real gbrain an
 * operator runs beside the repository; its settings must not reach a test.
 *
 * Naming rule for test opt-ins: `DEVMODEL_TEST_<AREA>_<WHAT>`; paid ones
 * `DEVMODEL_TEST_LIVE_<WHAT>`. The `DEVMODEL_TEST_` prefix survives the scrub,
 * so a test opt-in under it can never be silently stripped. Documented
 * exceptions: the `DEVMODEL_E2E_*` and `DEVMODEL_CI_*` prefixes.
 */

/** Operator/agent workspace prefixes with no test-machinery tenants. */
export const STRIP_PREFIX = /^(CONDUCTOR_|MCP_|OPENCLAW_)/;

/** Namespaces scrubbed outside the keep-lists below. */
export const SCRUBBED_PREFIX = /^(GBRAIN_|DEVMODEL_)/;

export const KEEP_EXACT: ReadonlySet<string> = new Set([
  'GBRAIN_HOME', // per-run HOME isolation — gbrain-home-preload and run-e2e.sh both respect a pre-set value
  'GBRAIN_DATABASE_URL', // database-url-guard-preload (registered first) already vetoed un-opted runs
  'GBRAIN_MODEL_DISCOVERY', // operator override provider-keys-preload deliberately respects
  'DEVMODEL_DEBUG_PRELOAD', // the preload stack's own logging hatch
]);

// DEVMODEL_TEST_*: test-control opt-ins (ALLOW_DATABASE_URL, KEEP_PROVIDER_KEYS,
// shard/memory knobs) must survive their own scrub or every escape hatch is a
// dead end. DEVMODEL_CI_*: ci-local.sh port plumbing. DEVMODEL_E2E_*: e2e
// runner knobs.
export const KEEP_PREFIX = /^DEVMODEL_(TEST_|CI_|E2E_)/;

/**
 * Old names of this repository's opt-ins. The kept namespaces were
 * `GBRAIN_TEST_`, `GBRAIN_CI_` and `GBRAIN_E2E_` before they moved under
 * `DEVMODEL_`, and the scrub deletes every `GBRAIN_*` name, so an opt-in set
 * under its old name would be a silent no-op. Setting one stops the run with
 * the rename line instead. Shell readers (scripts/check-bash32.sh) carry the
 * same check for the names they read.
 */
export const RENAMED: Readonly<Record<string, string>> = {
  GBRAIN_BASH32_REQUIRE: 'DEVMODEL_TEST_BASH32_REQUIRE',
};
const RENAMED_PREFIX = /^GBRAIN_(TEST_|CI_|E2E_)/;

/** Whether the scrub deletes `name` from a test process's environment. */
export function isStripped(name: string): boolean {
  if (STRIP_PREFIX.test(name)) return true;
  return SCRUBBED_PREFIX.test(name) && !KEEP_EXACT.has(name) && !KEEP_PREFIX.test(name);
}

/** The new name of an old opt-in name, or null when `name` was not renamed. */
export function renamedTo(name: string): string | null {
  if (RENAMED[name]) return RENAMED[name]!;
  return RENAMED_PREFIX.test(name) ? `DEVMODEL_${name.slice('GBRAIN_'.length)}` : null;
}

/** The fail-fast message for an old opt-in name, or null when `name` was not renamed. */
export function renamedOptInMessage(name: string, value: string): string | null {
  const next = renamedTo(name);
  if (!next) return null;
  return [
    `${name} was renamed to ${next}.`,
    'Why: test opt-ins must survive the operator-env scrub (test/helpers/operator-env-preload.ts), which deletes GBRAIN_* names and DEVMODEL_* names outside DEVMODEL_TEST_*; under the old name this opt-in was silently ignored.',
    `Fix: unset ${name} && export ${next}=${value}`,
    'Docs: docs/TESTING.md#test-isolation-lint-and-helpers',
  ].join('\n');
}
