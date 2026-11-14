#!/usr/bin/env bash
# CI guard: fail if any non-serial unit test file violates intra-process
# isolation rules. The parallel runner loads multiple test files into one bun
# process per shard; module-level state (env vars, mock.module overrides)
# leaks across files in that process and silently flakes other tests.
#
# Rules enforced (non-serial unit test files only; the ids are stable, other
# files name them):
#  R1: no `process.env.X = ...`, `process.env['X'] = ...`,
#      `delete process.env.X`, `Object.assign(process.env, ...)`,
#      `Reflect.set(process.env, ...)` mutations. Use withEnv() helper or
#      rename the file to `*.serial.test.ts`.
#  R2: no `mock.module(...)` anywhere. Top-level module mocks affect every
#      other file in the same shard process. Rename to `*.serial.test.ts`.
#  R8: no scratch directory inside the source tree
#      (`join(import.meta.dir, '.tmp-...')`). Guards such as
#      test-reads-source-smell walk test/ in the same lane, and a scratch
#      directory created and removed by another file mid-walk fails them with
#      ENOENT. Use mkdtempSync(join(tmpdir(), '...')).
#
# Scope:
#  - Recursively scans `test/**/*.test.ts`.
#  - Skips `*.serial.test.ts` entirely (the quarantine escape hatch).
#  - Skips `test/e2e/**` (E2E runs sequentially in its own runner; not in
#    the parallel pool).
#
# Allow-list:
#  Files in `scripts/check-test-isolation.allowlist` (one filename per
#  line, # comments allowed) are skipped. New files MUST NOT be added: the
#  allow-list shrinks over time, never grows.
#
# Usage: scripts/check-test-isolation.sh [TARGET_DIR]
#        scripts/check-test-isolation.sh --as-parallel FILE...
#   --as-parallel lints the named files (serial ones included) as if they
#   ran in the parallel pool: the check a *.serial.test.ts file must pass
#   before it rejoins the unit lane (scripts/serial-files.tsv).
# Exit:  0 when clean, 1 when un-allow-listed violations found.

set -euo pipefail

. "$(dirname "$0")/lib/guard-candidates.sh"

# DEVMODEL_GUARD_ROOT (guard self-test): lint a fixture tree, whose unit files
# end in .test.fixture.ts so the real lint and `bun test` never collect them.
ROOT="${DEVMODEL_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"
TEST_SUFFIX='.test.ts'
[ -n "${DEVMODEL_GUARD_ROOT:-}" ] && TEST_SUFFIX='.test.fixture.ts'

AS_PARALLEL=0
if [ "${1:-}" = "--as-parallel" ]; then
  AS_PARALLEL=1
  shift
  [ "$#" -gt 0 ] || { echo "Usage: scripts/check-test-isolation.sh --as-parallel FILE..." >&2; exit 2; }
fi
TARGET_DIR="${1:-test}"
# When scanning the default root, also lint evals/**/*.test.ts — those files
# are collected into the CI matrix (scripts/test-shard.sh) and must obey the
# same isolation rules as everything else CI executes. An explicit TARGET_DIR
# argument (guard self-test fixtures) scans only itself.
EXTRA_DIRS=""
if [ "$TARGET_DIR" = "test" ] && [ -d evals ]; then
  EXTRA_DIRS="evals"
fi
ALLOWLIST_FILE="$ROOT/scripts/check-test-isolation.allowlist"

# Read allowlist (one filename per line, # comments allowed). Empty file
# is fine — every violation will fail. The scan matches whole lines.
ALLOWLIST=""
if [ -f "$ALLOWLIST_FILE" ]; then
  ALLOWLIST="$(grep -v '^[[:space:]]*#' "$ALLOWLIST_FILE" | grep -v '^[[:space:]]*$' || true)"
fi

# Find non-serial unit test files (excluding test/e2e). Portable across
# bash 3.2 (macOS default) and bash 4+; no mapfile.
if [ "$AS_PARALLEL" = 1 ]; then
  FILE_LIST="$(printf '%s\n' "$@")"
else
FILE_LIST="$(find "$TARGET_DIR" $EXTRA_DIRS -name "*$TEST_SUFFIX" \
  -not -name "*.serial$TEST_SUFFIX" \
  -not -path "*/e2e/*" \
  -type f 2>/dev/null | sort)"
fi

ENV_MUTATION_PATTERN='process\.env\.[A-Za-z_][A-Za-z_0-9]*[[:space:]]*=[^=]|process\.env\[[^]]+\][[:space:]]*=[^=]|delete[[:space:]]+process\.env\.|delete[[:space:]]+process\.env\[|Object\.assign[[:space:]]*\([[:space:]]*process\.env|Reflect\.set[[:space:]]*\([[:space:]]*process\.env'
MODULE_MOCK_PATTERN='mock\.module[[:space:]]*\('
# R8: a scratch path joined onto this file's own directory.
SOURCE_TREE_SCRATCH_PATTERN="(import\\.meta\\.dir(name)?|__dirname)[[:space:]]*,[[:space:]]*['\"\`]\\.?tmp[-_./'\"\`]"

# One awk process lints every candidate file (#8053): a grep or awk process
# per rule per file cost about 90 s for 2,000 candidates. Each file is read
# once and every rule runs over its lines, in rule order.
read -r -d '' SCAN_AWK <<'AWK' || true
function emit(f, rule, detail, lines,   n, a, i) {
  print "ERROR: " f
  print "       rule " rule ": " detail
  sub(/\n+$/, "", lines)
  if (lines != "") {
    n = split(lines, a, "\n")
    for (i = 1; i <= n && i <= 3; i++) print "         " a[i]
  }
}
function scan(f,   nl, line, env, mock, scratch) {
  nl = 0
  while ((getline line < f) > 0) {
    nl++
    if (line ~ ENV_RE) env = env nl ":" line "\n"
    if (line ~ MOCK_RE) mock = mock nl ":" line "\n"
    if (line ~ SCRATCH_RE) scratch = scratch nl ":" line "\n"
  }
  close(f)

  # R1: env mutations.
  if (env != "") emit(f, "R1", "process.env mutation; use withEnv() or rename to *.serial.test.ts", env)
  # R2: mock.module() anywhere.
  if (mock != "") emit(f, "R2", "mock.module() leaks across files in the shard process; rename to *.serial.test.ts", mock)
  # R8: scratch directory inside the source tree.
  if (scratch != "") emit(f, "R8", "scratch directory inside the source tree; tree walkers in the same lane (test-reads-source-smell) fail with ENOENT when it is created or removed mid-walk. Use mkdtempSync(join(tmpdir(), '...'))", scratch)
}
BEGIN {
  ENV_RE = ENVIRON["ENV_MUTATION_PATTERN"]; MOCK_RE = ENVIRON["MODULE_MOCK_PATTERN"]
  SCRATCH_RE = ENVIRON["SOURCE_TREE_SCRATCH_PATTERN"]
  n = split(ENVIRON["ALLOWLIST"], a, "\n")
  for (i = 1; i <= n; i++) allowed[a[i]] = 1
}
$0 != "" && !($0 in allowed) { scan($0) }
AWK

CANDIDATES="$(guard_candidates -E -e "$ENV_MUTATION_PATTERN" -e "$MODULE_MOCK_PATTERN" -e "$SOURCE_TREE_SCRATCH_PATTERN" <<< "$FILE_LIST")"
REPORT=""
if [ -n "$CANDIDATES" ]; then
  REPORT="$(printf '%s\n' "$CANDIDATES" | ENV_MUTATION_PATTERN="$ENV_MUTATION_PATTERN" MODULE_MOCK_PATTERN="$MODULE_MOCK_PATTERN" \
    SOURCE_TREE_SCRATCH_PATTERN="$SOURCE_TREE_SCRATCH_PATTERN" ALLOWLIST="$ALLOWLIST" awk "$SCAN_AWK")"
fi
file_count="$(printf '%s\n' "$FILE_LIST" | grep -c . || true)"
violations="$(printf '%s\n' "$REPORT" | grep -c '^ERROR: ' || true)"
if [ -n "$REPORT" ]; then
  printf '%s\n' "$REPORT"
fi

if [ $violations -gt 0 ]; then
  echo
  echo "check-test-isolation: FAIL ($violations violation(s))"
  echo
  echo "Fix:"
  echo "  - For env mutations, use withEnv() from test/helpers/with-env.ts"
  echo "  - For mock.module(), rename to *.serial.test.ts (quarantine)"
  echo "  - For a scratch directory, use mkdtempSync(join(tmpdir(), '...'))."
  echo
  echo "Or, if this is a baseline file from before the lint shipped,"
  echo "add it to scripts/check-test-isolation.allowlist (with a TODO"
  echo "comment naming the sweep PR that will remove it)."
  exit 1
fi

# Nothing to lint: the runner counts the marker as a skip, not a pass.
if [ "$file_count" -eq 0 ]; then
  echo "DEVMODEL_CHECK_SKIPPED: no non-serial unit test files under $TARGET_DIR${EXTRA_DIRS:+ or $EXTRA_DIRS}"
  exit 0
fi
echo "check-test-isolation: OK ($file_count non-serial unit files scanned)"
