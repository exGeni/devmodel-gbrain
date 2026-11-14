#!/usr/bin/env bash
# scripts/run-verify-parallel.sh — parallel verify dispatcher.
#
# Runs the verify checks (privacy, test hygiene, docs, size ratchets, … +
# typecheck) as background jobs through a bounded pool, then the
# self-timed SOLO_CHECKS one at a time, waits for all, aggregates exit codes,
# surfaces failed-check name + tail of its log to stderr. The CHECKS array
# plus SOLO_CHECKS below are the single source of truth for what runs (count
# them, don't trust prose).
#
# Replaces the sequential `&&`-chain in package.json's `verify` script.
# Wallclock: the pool makespan (the longest check, typecheck, dominates) plus
# the solo phase (the guard self-test alone, ~15-19 s).
#
# Usage:
#   bash scripts/run-verify-parallel.sh              # run every CHECK below
#   bash scripts/run-verify-parallel.sh --dry-list   # print check list, exit
#
# Env overrides:
#   DEVMODEL_VERIFY_TIMEOUT       per-check wallclock cap, seconds (default 120)
#   DEVMODEL_VERIFY_SKIP_TYPECHECK=1  leave typecheck out: test.yml's typecheck job
#                               runs tsc in parallel under its own measured timeout
#   DEVMODEL_VERIFY_LOG_DIR       where to write per-check logs (default tempdir,
#                               removed on success and kept on failure)
#   DEVMODEL_TEST_RECEIPT_DIR     also write the verify receipt (X2): one JUnit
#                               testcase per check with its real outcome
#
# Outcomes: every check is recorded as pass, fail, timeout or skip in
# <log dir>/outcomes.tsv and in the receipt. A check that exits 0 without
# checking anything (its subject is absent) must print a line starting with
# `DEVMODEL_CHECK_SKIPPED: <reason>`; the recorder reads that marker, so a
# self-skip is never counted as a pass.
#
# Exit codes:
#   0   all checks passed
#   1   one or more checks failed (full details in stderr)
#   2   usage error / no checks defined

set -uo pipefail

cd "$(dirname "$0")/.."

# detect_cpus and the receipt helpers.
. scripts/lib/test-env.sh
receipts_init verify || exit 2

# ──────────────────────────────────────────────────────────────────────────
# Checks to run. Each entry is a bun-script name (the `package.json`
# "scripts" key), invoked as `bun run <name>`.
#
# ORDER MATTERS for wallclock: the spawn loop below is capped at
# DEVMODEL_VERIFY_MAX_PARALLEL workers, so the heaviest checks go FIRST
# (LPT-style — makespan ≈ max(longest check, total/POOL)). The heavy block:
# typecheck (tsc) and the whole-tree scans. Everything after is sub-second;
# that tail keeps its historical order for grep-ability. The guard self-test
# is not here: it times itself, so it runs in SOLO_CHECKS below.
#
# To add a check: add one line to the right block of CHECKS (a plain list).
# To skip in CI temporarily, comment the line — the runner doesn't care
# about count.
# ──────────────────────────────────────────────────────────────────────────
CHECKS=(
  # ── heavy (longest-first) ──
  "typecheck"
  # B4 (test-gap wave 2): runtime-reachability walk over src/** — hard-fails
  # true orphans (unreachable from every entrypoint AND every test) and any
  # test-only module without a reasoned PERMITTED_TEST_ONLY entry. ~1s.
  "check:orphan-modules"
  # No-op placeholder assertions (expect(true).toBe(true) and friends) in
  # test/**/*.test.ts; TypeScript AST scan, ~3s over the full corpus.
  "check:test-placeholders"
  "check:privacy"
  "check:test-names"
  "check:test-isolation"
  # D7: a test that gates execution on a DEVMODEL_* or GBRAIN_* opt-in the operator-env
  # preload strips is a silent skip; TS AST scan, ~2s.
  "check:test-env-opt-ins"
  # C2: weight maps name only existing files; the unweighted share per lane
  # warns (step summary) and fails only on the scheduled run.
  "check:weight-coverage"
  # ── light tail (sub-second greps; historical order) ──
  "check:proposal-pii"
  "check:no-tracked-symlinks"
  "check:doc-history"
  # GST-2548: documented scripts/ and test/ paths exist. The unit and census
  # lanes skip a doc-only pull request; verify does not.
  "check:docs-repo-paths"
  "check:fixture-privacy"
  "check:file-url-pathname"
  # Previously reachable ONLY from the deleted check:all (i.e. never run):
  "check:newlines"
  # Containment sprint: module-size ratchet + structural-suite freshness.
  "check:module-size"
  # W5 (refactor wave 1): per-function line ratchet over src/**/*.ts (TS AST,
  # ~1.5s); baseline scripts/function-size-baseline.tsv.
  "check:function-size"
  # Trunk Dynamic CI: the filter runs only on pull_request and every gated job
  # keeps the fail-open !cancelled() && != 'false' form.
  "check:dynamic-ci"
  # W7 (refactor wave 1): workflow phrases the wave retired stay out of the
  # docs agents follow (CLAUDE.md, AGENTS.md, CONTRIBUTING.md, docs/, skills/),
  # and so does the vocabulary of the product code that was cut.
  "check:retired-phrases"
  # CHANGELOG.md keeps every release heading origin/main has (a cut file is refused).
  "check:changelog-headings"
  "check:structural-manifest"
  # Every generated artifact's freshness in one place (GBRA-47 B8); its Fix
  # line is `bun run regen:all`, the same code path that regenerates them.
  "check:regen-all"
)

# ──────────────────────────────────────────────────────────────────────────
# Solo checks: a check that enforces its OWN wall-clock budget runs here, one
# at a time, after the pool above has drained, with the whole machine. In the
# pool its budget measured the neighbours: on the 8-vCPU verify runner the
# guard self-test (15-19 s alone) crossed its 30 s budget beside typecheck and
# the binary builds (31 s, job 111694069284; 32 s on macOS 26). Everything
# else belongs in CHECKS; add here only a check that times itself.
# ──────────────────────────────────────────────────────────────────────────
SOLO_CHECKS=(
  # W0 fix-wave (Tier-1 #11): guard self-tests — every scanner guard proves it
  # can fail (bad fixture → exit 1) before it counts as coverage. Registry:
  # scripts/guards-manifest.tsv (package.json's stale `check:all` copy deleted).
  # Budget: 30 s wall clock (scripts/guard-self-test.sh BUDGET_SECONDS).
  "check:guard-self-test"
)
if [ "${DEVMODEL_VERIFY_SKIP_TYPECHECK:-}" = "1" ]; then
  KEPT=()
  for c in "${CHECKS[@]}"; do [ "$c" = "typecheck" ] || KEPT+=("$c"); done
  CHECKS=("${KEPT[@]}")
fi
ALL_CHECKS=("${CHECKS[@]}" "${SOLO_CHECKS[@]}")

if [ "${#CHECKS[@]}" -eq 0 ]; then
  echo "ERROR: no checks defined in run-verify-parallel.sh" >&2
  exit 2
fi

# Dry-run path: list checks, exit. Used by tests + ops debugging.
if [ "${1:-}" = "--dry-list" ]; then
  printf '%s\n' "${ALL_CHECKS[@]}"
  exit 0
fi

if [ "$#" -gt 0 ] && [ "${1:-}" != "" ]; then
  echo "ERROR: unknown arg: $1" >&2
  echo "usage: bash scripts/run-verify-parallel.sh [--dry-list]" >&2
  exit 2
fi

TIMEOUT="${DEVMODEL_VERIFY_TIMEOUT:-120}"

# Per-check temp dir. Each check gets its own subdir so writes can't race
# on shared scratch state (the checks themselves are read-only — they grep
# the working tree — but defense-in-depth.)
if [ -n "${DEVMODEL_VERIFY_LOG_DIR:-}" ]; then
  LOG_DIR="$DEVMODEL_VERIFY_LOG_DIR"
  mkdir -p "$LOG_DIR" || { echo "ERROR: cannot create $LOG_DIR" >&2; exit 2; }
else
  LOG_DIR="$(mktemp -d /tmp/devmodel-verify-XXXXXX)"
  KEEP_LOGS=0
  trap '[ "$KEEP_LOGS" = "1" ] || rm -rf "$LOG_DIR"' EXIT
fi

# Resolve `timeout` for per-check wallclock cap. macOS doesn't ship one;
# brew coreutils provides `gtimeout`. If neither is available, fall back to
# bg-pid + sleep-cap (slightly less reliable but still bounded).
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
fi

# Bounded worker pool. Unbounded fan-out ran tsc and ~40 greps
# simultaneously on a 4-vCPU CI runner — pushing slow checks into the
# 120s per-check timeout (the documented flake class on slower hosts).
# Default = detect_cpus so a many-core dev machine keeps its wide fan-out;
# escape hatch: DEVMODEL_VERIFY_MAX_PARALLEL=999.
MAX_PAR="${DEVMODEL_VERIFY_MAX_PARALLEL:-$(detect_cpus)}"
if ! printf '%s' "$MAX_PAR" | grep -qE '^[0-9]+$' || [ "$MAX_PAR" -lt 1 ]; then
  echo "ERROR: invalid DEVMODEL_VERIFY_MAX_PARALLEL: $MAX_PAR" >&2
  exit 2
fi

START_TS=$(date +%s)
echo "[verify-parallel] running ${#ALL_CHECKS[@]} checks: ${#CHECKS[@]} in the pool, then ${#SOLO_CHECKS[@]} solo (pool=$MAX_PAR, timeout=${TIMEOUT}s, logs=$LOG_DIR)" >&2

# ──────────────────────────────────────────────────────────────────────────
# Spawn one background process per check. Each child captures its own exit
# code into a sentinel file under $LOG_DIR/<safe-name>.exit; the parent
# never trusts `wait`'s aggregate value because that maps to last-spawned.
#
# safe_name: turn `check:privacy` into `check_privacy` so it fits a filename
# without escaping.
# ──────────────────────────────────────────────────────────────────────────
PIDS=()
SAFE_NAMES=()
spawn_check() {
  c="$1"
  safe="${c//:/_}"
  SAFE_NAMES+=("$safe")
  LOG_FILE="$LOG_DIR/$safe.log"
  EXIT_FILE="$LOG_DIR/$safe.exit"
  (
    started=$(date +%s)
    if [ -n "$TIMEOUT_BIN" ]; then
      "$TIMEOUT_BIN" "${TIMEOUT}s" bun run "$c" > "$LOG_FILE" 2>&1
      rc=$?
    else
      bun run "$c" > "$LOG_FILE" 2>&1 &
      pid=$!
      # The watchdog owns no caller pipes (an orphaned sleep holding stdout
      # stalled spawnSync callers for the whole $TIMEOUT). Each of its sleeps
      # runs through `nap`: on TERM the watchdog kills that sleep and waits for
      # it, so the sleep is gone before the watchdog exits and before the
      # `wait "$cap_pid"` below returns. A TERM that lands between forking a
      # sleep and recording its pid only sets `stop`, acted on once the pid is
      # known (bash 3.2 has no signal masking).
      ( nap() {
          stop=
          trap 'stop=1' TERM
          sleep "$1" & n=$!
          trap 'kill "$n" 2>/dev/null; wait "$n" 2>/dev/null; exit 0' TERM
          if [ -n "$stop" ]; then kill "$n" 2>/dev/null; wait "$n" 2>/dev/null; exit 0; fi
          wait "$n"
        }
        nap "$TIMEOUT" && kill -TERM "$pid" 2>/dev/null && \
          nap 5 && kill -KILL "$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
      cap_pid=$!
      wait "$pid" 2>/dev/null
      # Capture the check's exit code from ITS `wait`, before any watchdog
      # teardown runs. The teardown commands below overwrite $? — the killed
      # watchdog reports 143 — which used to get stamped into every sentinel
      # on machines with no gtimeout/timeout: verify reported pass=0
      # fail=<all> while every per-check log said OK.
      rc=$?
      # Reap the watchdog's `sleep` child too (pkill -P), then the watchdog.
      # Killing only the subshell leaves the sleep orphaned until $TIMEOUT
      # elapses — same quirk the heartbeat cleanup in run-unit-parallel.sh
      # works around; CI's orphan-process sweep flags those.
      pkill -P "$cap_pid" 2>/dev/null
      kill "$cap_pid" 2>/dev/null
      wait "$cap_pid" 2>/dev/null
    fi
    echo "$(( $(date +%s) - started ))" > "$LOG_DIR/$safe.seconds"
    echo "$rc" > "$EXIT_FILE"
  ) &
  PIDS+=($!)
}

for c in "${CHECKS[@]}"; do
  # Throttle to the worker pool (bash 3.2 — no wait -n; jobs -rp reaps).
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$MAX_PAR" ]; do
    sleep 0.1
  done
  spawn_check "$c"
done

# Wait for every background job. Ignore wait's aggregate exit — exit codes
# live in the sentinel files.
for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

# Solo phase: each SOLO_CHECKS entry runs alone after the pool has drained,
# so its own wall-clock budget measures its own work, not the heavy checks.
for c in "${SOLO_CHECKS[@]}"; do
  spawn_check "$c"
  wait "$!" 2>/dev/null || true
done

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

# ──────────────────────────────────────────────────────────────────────────
# Aggregate. For each check, read its exit file; on failure, append a
# labeled block (check name + tail of log) to the failure report. Surface
# one final summary line and the report to stderr if anything failed.
# ──────────────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
FAIL_NAMES=()
SKIP_REPORT=""
FAIL_REPORT=""
OUTCOMES="$LOG_DIR/outcomes.tsv"
printf 'check\toutcome\trc\tdetail\tseconds\n' > "$OUTCOMES"
xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
JUNIT_CASES=""

for i in "${!ALL_CHECKS[@]}"; do
  c="${ALL_CHECKS[$i]}"
  safe="${SAFE_NAMES[$i]}"
  EXIT_FILE="$LOG_DIR/$safe.exit"
  LOG_FILE="$LOG_DIR/$safe.log"

  rc=1
  [ -f "$EXIT_FILE" ] && rc=$(cat "$EXIT_FILE" 2>/dev/null || echo 1)
  secs=""
  [ -f "$LOG_DIR/$safe.seconds" ] && secs=$(cat "$LOG_DIR/$safe.seconds" 2>/dev/null)
  skip_reason=""
  if [ "$rc" = "0" ] && [ -f "$LOG_FILE" ]; then
    skip_reason=$(sed -n 's/^DEVMODEL_CHECK_SKIPPED:[[:space:]]*//p' "$LOG_FILE" | head -1 | tr '\t' ' ')
    [ -n "$skip_reason" ] || ! grep -q '^DEVMODEL_CHECK_SKIPPED:' "$LOG_FILE" || skip_reason="(no reason given)"
  fi

  if [ "$rc" = "0" ] && [ -n "$skip_reason" ]; then
    SKIP=$((SKIP + 1))
    SKIP_REPORT+="  $c: $skip_reason"$'\n'
    printf '%s\tskip\t0\t%s\t%s\n' "$c" "$skip_reason" "$secs" >> "$OUTCOMES"
    JUNIT_CASES+="    <testcase name=\"$c\" classname=\"verify\" file=\"verify\"><skipped message=\"$(printf '%s' "$skip_reason" | xml_escape)\" /></testcase>"$'\n'
  elif [ "$rc" = "0" ]; then
    PASS=$((PASS + 1))
    printf '%s\tpass\t0\t\t%s\n' "$c" "$secs" >> "$OUTCOMES"
    JUNIT_CASES+="    <testcase name=\"$c\" classname=\"verify\" file=\"verify\" />"$'\n'
  else
    outcome=fail
    [ "$rc" = "124" ] && outcome=timeout
    printf '%s\t%s\t%s\t%s\t%s\n' "$c" "$outcome" "$rc" "$LOG_FILE" "$secs" >> "$OUTCOMES"
    JUNIT_CASES+="    <testcase name=\"$c\" classname=\"verify\" file=\"verify\"><failure message=\"$outcome rc=$rc\" /></testcase>"$'\n'
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$c")
    if [ "$rc" = "124" ]; then
      FAIL_REPORT+=$'\n--- '"$c"' (TIMED OUT after '"${TIMEOUT}"'s) ---'$'\n'
    else
      FAIL_REPORT+=$'\n--- '"$c"' (rc='"$rc"') ---'$'\n'
    fi
    if [ -f "$LOG_FILE" ]; then
      FAIL_REPORT+="$(tail -30 "$LOG_FILE")"
      FAIL_REPORT+=$'\n'
    fi
  fi
done

SLOWEST=$(tail -n +2 "$OUTCOMES" | awk -F'\t' '$5 != "" { print $5 "\t" $1 }' | sort -rn | head -5 |
  awk -F'\t' '{ printf "%s%s %ss", (NR > 1 ? ", " : ""), $2, $1 }')
[ -z "$SLOWEST" ] || echo "[verify-parallel] slowest checks (wall seconds, see outcomes.tsv): $SLOWEST" >&2

if [ -n "$SKIP_REPORT" ]; then
  {
    echo "[verify-parallel] $SKIP check(s) self-skipped (recorded as skip, not pass):"
    printf '%s' "$SKIP_REPORT"
  } >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### bun run verify: $SKIP check(s) skipped (not passed)"
      echo
      printf '%s' "$SKIP_REPORT" | sed 's/^  /- /'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
fi

receipt_begin primary all "" "" "" verify
if [ -n "$RECEIPT_ID" ]; then
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo "<testsuites name=\"verify\" tests=\"${#ALL_CHECKS[@]}\" failures=\"$FAIL\" skipped=\"$SKIP\">"
    echo "  <testsuite name=\"verify\" file=\"verify\" tests=\"${#ALL_CHECKS[@]}\" failures=\"$FAIL\" skipped=\"$SKIP\">"
    printf '%s' "$JUNIT_CASES"
    echo "  </testsuite>"
    echo "</testsuites>"
  } > "$TEST_RECEIPT_DIR/$RECEIPT_ID.junit.xml"
  receipt_end "$([ "$FAIL" -eq 0 ] && echo 0 || echo 1)"
fi

if [ "$FAIL" -gt 0 ]; then
  KEEP_LOGS=1
  {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "❌ verify failed: $FAIL/${#ALL_CHECKS[@]} checks did not pass"
    echo "Failed: ${FAIL_NAMES[*]}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf '%s' "$FAIL_REPORT"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Generated artifact, golden or manifest drift? Run: bun run regen:all (offline, keyless; prints what changed)."
    echo "[verify-parallel] elapsed=${ELAPSED}s | pass=$PASS fail=$FAIL skip=$SKIP"
    echo "[verify-parallel] per-check logs kept in $LOG_DIR (outcomes.tsv lists every check)"
  } >&2
  exit 1
fi

echo "[verify-parallel] elapsed=${ELAPSED}s | pass=$PASS fail=0 skip=$SKIP | all checks green" >&2
exit 0
