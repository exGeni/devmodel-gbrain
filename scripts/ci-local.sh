#!/usr/bin/env bash
# scripts/ci-local.sh
#
# Local CI gate. Runs the same checks GH Actions does on this checkout, on the
# host: gitleaks, the guards, the serial and slow lanes, then the unit and E2E
# lanes sharded four ways.
#
# Modes:
#   bash scripts/ci-local.sh              # full local gate: gitleaks + guards + serial + slow + unit + ALL E2E (4-way sharded)
#   bash scripts/ci-local.sh --diff       # doc-only diff: gitleaks + doc checks; any other diff: the full gate
#   bash scripts/ci-local.sh --no-shard   # debug: run unit and E2E unsharded
#
# 4-way sharding: the unit files and the test/e2e/ files each split by weight
# into 4 partitions (SHARD=N/4); the 4 shards run in parallel. Within a shard,
# unit files run first, then E2E files sequentially (see run-e2e.sh).
#
# Stronger than PR CI: PR CI runs a handful of named files across its tiers; this runs every test/e2e file.

set -euo pipefail

cd "$(dirname "$0")/.."

DIFF=0
NO_SHARD=0

for arg in "$@"; do
  case "$arg" in
    --diff) DIFF=1 ;;
    --no-shard) NO_SHARD=1 ;;
    *)
      echo "Usage: $0 [--diff] [--no-shard]" >&2
      exit 1
      ;;
  esac
done

# --diff: a doc-only diff skips the heavy gate (guards + unit + E2E) and runs
# gitleaks plus the doc checks (seconds instead of minutes). Any other diff
# runs the full gate: E2E narrowing is retired (a typical E2E file imports
# most of the product code, so no diff map ever narrowed).
if [ "$DIFF" = "1" ]; then
  CLASSIFICATION=$(bun run scripts/select-e2e.ts --classify-only 2>/dev/null || echo "ERR")
  if [ "$CLASSIFICATION" = "DOC_ONLY" ]; then
    echo "[ci-local] --diff: diff is doc-only — skipping unit + E2E; running gitleaks and the doc checks."
    if ! command -v gitleaks >/dev/null 2>&1; then
      echo "[ci-local] ERROR: gitleaks not installed; the required secrets scan cannot run. Install gitleaks and retry." >&2
      exit 1
    fi
    bash scripts/test-gitleaks-config.sh
    bash scripts/scan-worktree-secrets.sh
    gitleaks git . --redact --no-banner --log-opts="origin/main..HEAD"
    bash scripts/ci-doc-checks.sh
    echo "[ci-local] Doc-only fast-path complete. No code paths exercised."
    exit 0
  fi
  echo "[ci-local] --diff: E2E narrowing is retired; running the full E2E corpus (see docs/TESTING.md#e2e-selection). Classification: $CLASSIFICATION"
fi

# Full gate: everything below runs for any diff that is not doc-only.

# Step 0: gitleaks on the host. Mirrors test.yml's separate gitleaks job. Fail
# loudly if not installed.
echo "[ci-local] gitleaks detect (host)..."
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[ci-local] ERROR: gitleaks not installed on host." >&2
  echo "[ci-local]   macOS:  brew install gitleaks" >&2
  echo "[ci-local]   Linux:  https://github.com/gitleaks/gitleaks/releases" >&2
  exit 1
fi
# Two scopes for pre-push:
#   1. Working-tree files (catch uncommitted secrets sitting in files)
#   2. Branch commits vs origin/main (catch secrets committed on this branch)
# A full-history scan is slow and not useful pre-push.
bash scripts/test-gitleaks-config.sh
bash scripts/scan-worktree-secrets.sh
gitleaks git . --redact --no-banner --log-opts="origin/main..HEAD"

# Step 1: smoke-test run-e2e.sh argv + shard handling.
echo "[ci-local] Smoke: run-e2e.sh argv + shard..."
bash scripts/ci-local-e2e-smoke.sh

# Step 2: build the phase command.
# 4-shard parallel UNIT + E2E. Each shard runs its unit files, then its E2E
# files. Guards + typecheck run ONCE before fan-out. --no-shard runs the
# unsharded flow (debug aid).
if [ "$NO_SHARD" = "1" ]; then
  RUN_PHASES_CMD='echo "[runner] guards + typecheck"
bash scripts/check-bun-test-timeout.sh
bun run verify
echo "[runner] serial tests (DATABASE_URL unset)"
env -u DATABASE_URL -u GBRAIN_DATABASE_URL bun run test:serial
echo "[runner] slow tests (DATABASE_URL unset)"
env -u DATABASE_URL -u GBRAIN_DATABASE_URL bun run test:slow
echo "[runner] unit (unsharded, DATABASE_URL unset)"
env -u DATABASE_URL bash scripts/run-unit-shard.sh
echo "[runner] e2e (unsharded)"
bash scripts/run-e2e.sh'
else
  # Sharded path. Each shard runs unit then E2E sequentially. Shards run in
  # parallel via xargs -P4.
  RUN_PHASES_CMD="echo \"[runner] guards + typecheck (run once before sharding)\"
bash scripts/check-bun-test-timeout.sh
bun run verify
echo \"[runner] serial tests (DATABASE_URL unset)\"
env -u DATABASE_URL -u GBRAIN_DATABASE_URL bun run test:serial
echo \"[runner] slow tests (DATABASE_URL unset)\"
env -u DATABASE_URL -u GBRAIN_DATABASE_URL bun run test:slow
# 4-way shard contention makes subprocess tests several times slower per file
# than a quiet run — timeout-class failures that pass alone. Scale the
# per-test ceiling for the sharded lane (overridable).
export GBRAIN_TEST_TIMEOUT_MULTIPLIER=\${GBRAIN_TEST_TIMEOUT_MULTIPLIER:-6}
mkdir -p .context/ci-local-shards
echo \"[runner] 4-shard parallel unit + E2E (xargs -P4)\"
set +e
printf '%s\\n' 1 2 3 4 | xargs -P4 -I{} sh -c '
  shard=\$1
  log=.context/ci-local-shards/shard-\${shard}.log
  echo \"[shard \${shard}] start\" > \$log
  echo \"[shard \${shard}] unit phase (SHARD=\${shard}/4, DATABASE_URL unset)\" >> \$log
  env -u DATABASE_URL SHARD=\${shard}/4 bash scripts/run-unit-shard.sh >> \$log 2>&1
  unit_exit=\$?
  if [ \$unit_exit -ne 0 ]; then
    echo \"[shard \${shard}] UNIT FAILED (exit=\$unit_exit)\" >> \$log
    exit \$unit_exit
  fi
  echo \"[shard \${shard}] e2e phase (SHARD=\${shard}/4)\" >> \$log
  SHARD=\${shard}/4 bash scripts/run-e2e.sh >> \$log 2>&1
  e2e_exit=\$?
  if [ \$e2e_exit -ne 0 ]; then
    echo \"[shard \${shard}] E2E FAILED (exit=\$e2e_exit)\" >> \$log
    exit \$e2e_exit
  fi
  echo \"[shard \${shard}] DONE\" >> \$log
' _ {}
shard_xargs_exit=\$?
set -e
echo \"[runner] Complete shard logs saved to .context/ci-local-shards/\"
echo \"\"
echo \"=== SHARD LOGS (last 30 lines each + unit/e2e summaries) ===\"
for s in 1 2 3 4; do
  echo \"\"
  echo \"--- shard \$s ---\"
  if [ -f .context/ci-local-shards/shard-\$s.log ]; then
    # Pull the unit + E2E summary lines explicitly so they survive even if
    # the file is huge. Match: bun's '<N> pass / <N> fail' pairs, run-e2e.sh's
    # 'Files: ... / Tests: ...' summary, and our own shard markers.
    grep -E '^\\[shard|^Files: |^Tests: |Ran [0-9]+ tests|^[[:space:]]+[0-9]+ (pass|fail|skip)\$' .context/ci-local-shards/shard-\$s.log || true
    echo \"  (last 30 lines for context)\"
    tail -30 .context/ci-local-shards/shard-\$s.log
  else
    echo \"(no log file written — shard never started)\"
  fi
done
echo \"\"
if [ \$shard_xargs_exit -ne 0 ]; then
  echo \"[runner] One or more shards failed (xargs exit=\$shard_xargs_exit). See SHARD LOGS above.\"
  exit \$shard_xargs_exit
fi
echo \"[runner] All 4 shards passed.\""
fi

# Step 3: run the phases.
echo "[ci-local] Running checks..."
bash -c "set -euo pipefail
$RUN_PHASES_CMD"

echo ""
echo "[ci-local] All checks passed."
