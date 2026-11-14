#!/usr/bin/env bash
# Run E2E tests ONE FILE AT A TIME (within a shard).
#
# Bun's default is to run test files in parallel (each in its own worker).
# E2E files share external state (fixtures, ports, one test environment), and
# files running in parallel against it race: file A's setup can clobber file
# B's fixtures, producing fails that depend on timing.
#
# Running files sequentially eliminates the race entirely. Parallelism is
# recovered ACROSS shards instead: the SHARD=N/M env below fans shards out
# (scripts/ci-local.sh runs 4), each against its own environment. Within a
# shard, per-file bun startup (~1-2s) amortizes under the natural per-file
# test time of 5-10s.
#
# Reports every file failure, then exits non-zero if any file failed.
#
# `--timeout=60000` matches the unit test suite. Bun's default is 5s,
# which is too tight for setup hooks on CI runners under load.
#
# HOME isolation: E2E tests call paths that resolve to a config file under
# HOME and would otherwise write the user's real ~/.gbrain/config.json. The
# wrapper redirects HOME and GBRAIN_HOME to a tmpdir before bun starts so
# config writes land in the tmpdir, then verifies the user's real config md5
# didn't change after the run.
# Both env vars are required: loadConfig/saveConfig resolve via HOME, while
# configPath honors GBRAIN_HOME; setting only one leaves the
# other path escaping isolation. HOME is set before bun starts because Bun's
# os.homedir() caches at first call and in-process mutation would not take.
# Trap cleans up the tmpdir even on test failure.

set -euo pipefail
RUNNER_SHARD="${SHARD:-}"
unset SHARD

cd "$(dirname "$0")/.."
# Executed-test receipts (X2): captured here, before the GBRAIN_* scrub below,
# and unset so test processes never inherit them. Each file pass keeps its
# native JUnit report as a receipt (lane e2e unless GBRAIN_TEST_RECEIPT_LANE
# says otherwise).
. scripts/lib/test-env.sh
receipts_init e2e || exit 2

# COVERAGE_DIR (opt-in lcov coverage) must be an ABSOLUTE path: this script
# redirects HOME (and E2E tests spawn CLI subprocesses with varying cwd), so
# a relative --coverage-dir would scatter lcov output across working dirs.
# Normalize it once against the repo root, before HOME moves. COVERAGE_DIR is
# deliberately NOT GBRAIN-prefixed: the hermetic env scrub below drops
# GBRAIN_*/operator prefixes, and this variable must survive that scrub.
if [ -n "${COVERAGE_DIR:-}" ]; then
  case "$COVERAGE_DIR" in
    /*) ;;
    *) COVERAGE_DIR="$PWD/$COVERAGE_DIR" ;;
  esac
fi

# #3485: E2E tests need no database server — strip ambient DB URLs at this
# wrapper boundary so the bunfig preload guard (database-url-guard-preload.ts)
# passes and nothing can reach a real database.
unset DATABASE_URL GBRAIN_DATABASE_URL
# Provider keys: the unit-lane preload (provider-keys-preload.ts) strips
# ambient ANTHROPIC/OPENAI keys for keyless-CI parity; e2e is the lane where
# real keys are deliberate (live embed/parity tests skip-gate on them), so
# opt back in at this boundary.
export GBRAIN_TEST_KEEP_PROVIDER_KEYS=1

# --- HOME isolation: snapshot real user config before switching ---
# Tolerate unset HOME (minimal containers, exotic CI shells) without tripping set -u.
REAL_HOME="${HOME:-/tmp}"
USER_CONFIG="$REAL_HOME/.gbrain/config.json"
USER_CONFIG_EXISTED=0
USER_CONFIG_MD5=""
# `{ ... } || true` swallows non-zero exit when the file is missing or md5 isn't
# installed, so set -e never aborts before the post-run breach detector can run.
md5_of() {
  { if command -v md5 >/dev/null 2>&1; then
      md5 -q "$1" 2>/dev/null
    elif command -v md5sum >/dev/null 2>&1; then
      md5sum "$1" 2>/dev/null | awk '{print $1}'
    fi
  } || true
}
if [ -f "$USER_CONFIG" ]; then
  USER_CONFIG_EXISTED=1
  USER_CONFIG_MD5=$(md5_of "$USER_CONFIG")
fi

# Portable mktemp: explicit XXXXXX is required by GNU mktemp on Linux CI.
# `-t prefix` works on BSD but errors on GNU when the template lacks Xs.
E2E_TMP_HOME=$(mktemp -d "${TMPDIR:-/tmp}/gbrain-e2e.XXXXXX")
trap 'rm -rf "$E2E_TMP_HOME"' EXIT

# The foreground file runs as an owned child so signals interrupt wait promptly.
# Snapshot descendants before signalling: reparented children cannot be found later.
ACTIVE_E2E_PID=""
e2e_descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    e2e_descendants "$child"
    printf '%s\n' "$child"
  done
}
interrupt_e2e() {
  local code="$1" descendants="" pid
  trap '' INT TERM
  if [ -n "$ACTIVE_E2E_PID" ]; then
    descendants=$(e2e_descendants "$ACTIVE_E2E_PID")
    kill -TERM "$ACTIVE_E2E_PID" 2>/dev/null || true
    for pid in $descendants; do kill -TERM "$pid" 2>/dev/null || true; done
    sleep 1
    for pid in $descendants; do kill -KILL "$pid" 2>/dev/null || true; done
    kill -KILL "$ACTIVE_E2E_PID" 2>/dev/null || true
    wait "$ACTIVE_E2E_PID" 2>/dev/null || true
  fi
  exit "$code"
}
trap 'interrupt_e2e 130' INT
trap 'interrupt_e2e 143' TERM

export HOME="$E2E_TMP_HOME"
export GBRAIN_HOME="$E2E_TMP_HOME"
mkdir -p "$E2E_TMP_HOME/.gbrain"

# --- Hermetic env scrub: operator/agent context must not bleed into E2E ---
# A dev shell or a Conductor workspace exports CONDUCTOR_*, MCP_*, OPENCLAW_*,
# HERMES_*, and GBRAIN_* config overrides (e.g. a stray GBRAIN_BRAIN_ID,
# GBRAIN_SOURCE, GBRAIN_*_THRESHOLD, GBRAIN_SUPERVISOR_PID_FILE, an operator's
# HERMES_BIN/HERMES_HOME) that would silently change test behavior — making
# "hermetic" E2E non-hermetic and its failures unreproducible across machines.
# Drop them before bun starts. This is a DENYLIST of operator-context prefixes
# (not an allowlist rebuild), so PATH, HOME, TMPDIR, CI, and bun
# internals survive untouched. We keep GBRAIN_HOME (just set above for HOME
# isolation); everything else GBRAIN_* is an operator override the suite must
# not inherit. GROK_ also drops an operator's GROK_BIN/GROK_HOME; OPENCODE_
# drops OPENCODE_BIN and the OPENCODE_CONFIG* trio. Adapts GStack's
# buildHermeticEnv() allowlist to this shell E2E runner.
for _e2e_var in $(env | grep -oE '^(CONDUCTOR_|MCP_|OPENCLAW_|HERMES_|GROK_|OPENCODE_|GBRAIN_)[A-Za-z0-9_]*' | sort -u); do
  case "$_e2e_var" in
    GBRAIN_HOME) ;;  # required for HOME isolation (set above) — keep
    GBRAIN_TEST_KEEP_PROVIDER_KEYS) ;;  # provider-keys preload opt-in (set above) — keep
    GBRAIN_CI_DISABLE_TEST_ENV_FILE) ;;  # CI forbids loading checkout-local .env.testing — keep through Bun startup
    GBRAIN_TEST_WAIT_MULTIPLIER) ;;  # coverage deadline multiplier read by test/helpers/wait-for.ts — keep
    GBRAIN_E2E_FILE_TIMEOUT) ;;  # per-file cap override — read AFTER this scrub, so it must survive it
    *) unset "$_e2e_var" || true ;;
  esac
done

# --dry-run-list: print the resolved file list (one per line) and exit. Used
# by scripts/ci-local.sh to smoke-test the argv branching at startup.
DRY_RUN_LIST=0
if [ "${1:-}" = "--dry-run-list" ]; then
  DRY_RUN_LIST=1
  shift
fi

# Argv-driven file list (used by `ci:local:diff`); fall back to the full glob.
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  # Key-gated live files no CI job provides keys for; run them by name
  # (docs/TESTING.md). One shared list, also read by ci-local-e2e-smoke.sh.
  live_key_only=" $({ grep -v '^[[:space:]]*#' "$(dirname "${BASH_SOURCE[0]}")/e2e-live-key-only.txt" || true; } | tr '\n' ' ') "
  files=()
  for f in test/e2e/*.test.ts; do
    [ -e "$f" ] || continue
    case "$live_key_only" in *" $f "*) continue ;; esac
    files+=("$f")
  done
fi

# Weighted across shards, sequential within each shard.
if [ -n "$RUNNER_SHARD" ]; then
  if ! [[ "$RUNNER_SHARD" =~ ^[0-9]+/[0-9]+$ ]]; then
    echo "ERROR: invalid SHARD=$RUNNER_SHARD (expected N/M)" >&2
    exit 2
  fi
  shard_n=${RUNNER_SHARD%/*}
  shard_m=${RUNNER_SHARD#*/}
  selected=""
  if [ "${#files[@]}" -gt 0 ]; then
    selected=$(printf '%s\n' "${files[@]}" | bun scripts/sharding.ts "$shard_n" "$shard_m" --weights scripts/e2e-weights.json)
  fi
  files=()
  while IFS= read -r f; do
    [ -n "$f" ] && files+=("$f")
  done <<< "$selected"
fi

if [ "$DRY_RUN_LIST" = "1" ]; then
  if [ "${#files[@]}" -eq 0 ]; then
    exit 0
  fi
  printf '%s\n' "${files[@]}"
  exit 0
fi

RECEIPT_SHARD=""
RECEIPT_OF=""
RECEIPT_TAG="run"
if [ -n "$RUNNER_SHARD" ]; then
  RECEIPT_SHARD="$shard_n"
  RECEIPT_OF="$shard_m"
  RECEIPT_TAG="s${shard_n}of${shard_m}"
fi

if [ "${#files[@]}" -eq 0 ]; then
  # Empty shard (e.g. SHARD=4/4 with only 3 files): nothing to do.
  echo "No files for shard ${RUNNER_SHARD:-(unsharded)}; exiting clean."
  receipt_empty "$RECEIPT_TAG" "$RECEIPT_SHARD" "$RECEIPT_OF"
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to validate native E2E JUnit reports." >&2
  exit 1
fi

if [ -n "${COVERAGE_DIR:-}" ]; then
  mkdir -p "$(dirname "$COVERAGE_DIR")"
  if ! mkdir "$COVERAGE_DIR"; then
    echo "ERROR: COVERAGE_DIR must be a new, unused directory for each E2E invocation." >&2
    exit 1
  fi
fi

pass_files=0
fail_files=0
fail_list=()
total_pass=0
total_fail=0
file_idx=0

completed_e2e_passes() {
  python3 - "${1#./}" "$E2E_TMP_HOME/current.junit.xml" "$E2E_TMP_HOME/current.log" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

expected, report, log = sys.argv[1:]
try:
    root = ET.parse(report).getroot()
    suites = root.findall('testsuite')
    if root.tag != 'testsuites' or len(suites) != 1 or suites[0].get('file') != expected:
        raise ValueError('wrong selected-file suite')
    for node in [root, *root.iter('testsuite')]:
        cases = list(node.iter('testcase'))
        skipped = sum(case.find('skipped') is not None for case in cases)
        if any(case.find('failure') is not None or case.find('error') is not None for case in cases):
            raise ValueError('failed testcase')
        for key, count in [('tests', len(cases)), ('failures', 0), ('skipped', skipped)]:
            if node.get(key) != str(count):
                raise ValueError(f'inconsistent {key} count')
        if node.get('errors', '0') != '0':
            raise ValueError('reported errors')
    tests = int(root.get('tests'))
    skipped = int(root.get('skipped'))
    header = False
    counts = {}
    final = None
    with open(log) as stream:
        for raw in stream:
            line = re.sub(r'\x1b\[[0-9;]*m', '', raw.rstrip('\n'))
            header = header or line in (expected + ':', '::group::' + expected + ':')
            count = re.fullmatch(r'\s*(\d+) (pass|fail|skip|todo)\s*', line)
            if count:
                value, kind = count.groups()
                if kind == 'pass':
                    counts = {'skip': 0, 'todo': 0}
                counts[kind] = int(value)
            summary = re.match(r'^Ran (\d+) tests? across (\d+) files?\. \[[0-9.]+(?:ms|s)\]', line)
            if summary:
                final = (int(summary[1]), int(summary[2]), counts.copy())
    if not header or final is None:
        raise ValueError('missing final console report')
    final_tests, final_files, counts = final
    if final_tests != tests or final_files != 1 or counts.get('pass') != tests - skipped or counts.get('fail') != 0:
        raise ValueError('missing or inconsistent final console report')
    if counts.get('skip', 0) + counts.get('todo', 0) != skipped:
        raise ValueError('inconsistent skipped/todo count')
    print(tests - skipped)
except (OSError, ET.ParseError, ValueError, TypeError) as error:
    print(f'E2E report validation: {error}', file=sys.stderr)
    sys.exit(1)
PY
}

# A file's HOME must be removable once its bun process exits. Anything still
# running with HOME=<file home> is a leaked child of that file (the B2 class:
# a detached refresh still writing Bun's install cache). Kill those first
# (Linux /proc scan; elsewhere none can be found), then remove the HOME. A
# HOME that still cannot be removed fails THIS file by name instead of
# letting `set -e` abort the rest of the partition. Prints a note on stdout
# (empty when nothing leaked); returns 1 when the HOME is still there.
remove_file_home() {
  local home="$1" leaked="" pid cmd details=""
  if [ -d /proc/self ]; then
    leaked=$(grep -lzxF "HOME=$home" /proc/[0-9]*/environ 2>/dev/null | sed 's|^/proc/||; s|/environ$||' || true)
  fi
  for pid in $leaked; do
    [ "$pid" = "$$" ] && continue
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-200 || true)
    details="$details
    pid $pid: ${cmd:-<exited>}"
    kill -KILL "$pid" 2>/dev/null || true
  done
  if rm -rf "$home" 2>/dev/null || { sleep 1; rm -rf "$home" 2>/dev/null; }; then
    [ -z "$details" ] || echo "WARN: $name left processes running with HOME=$home after its bun process exited (killed):$details"
    return 0
  fi
  echo "FAILED: $name left a process writing to its HOME; cleanup could not remove $home"
  echo "  Why: a test started a child (often detached) that outlived the test file and kept writing under HOME."
  echo "  Fix: make the test wait for or stop its children; reproduce with: bash scripts/run-e2e.sh $f"
  [ -z "$details" ] || echo "  Leaked processes (killed):$details"
  find "$home" -mindepth 1 -maxdepth 4 2>/dev/null | head -10 | sed 's/^/  Remaining: /'
  return 1
}

executed_files=()
for f in "${files[@]}"; do
  name=$(basename "$f")
  executed_files+=("$f")
  file_idx=$((file_idx + 1))
  # COVERAGE_DIR (opt-in): each E2E file runs in its OWN bun process, so each
  # needs its OWN coverage dir — a second bun process reusing a coverage dir
  # OVERWRITES lcov.info. Empty/unset COVERAGE_DIR leaves the exec line
  # byte-identical to the pre-coverage behavior.
  COVERAGE_ARGS=()
  if [ -n "${COVERAGE_DIR:-}" ]; then
    COVERAGE_ARGS=(--coverage --coverage-reporter=lcov --coverage-dir="$COVERAGE_DIR/e2e-$file_idx")
  fi
  echo ""
  echo "=== $name ==="
  # Hard outer timeout (default 180s per file; GBRAIN_E2E_FILE_TIMEOUT or
  # E2E_FILE_TIMEOUT_SECS overrides — the GBRAIN_ name is kept in the scrub
  # keep-list above, the non-GBRAIN name survives the scrub by construction;
  # nightly coverage runs use it to absorb instrumentation overhead). bun's
  # --timeout covers tests AND hooks, but it's timer-based: a call that blocks
  # the event loop synchronously never lets the timer fire and the file wedges
  # indefinitely.
  # gtimeout/timeout SIGKILLs the file so the suite advances. gtimeout (macOS
  # via coreutils) preferred; timeout (Linux) fallback; bare bun (no outer
  # cap) if neither is installed.
  file_timeout="${GBRAIN_E2E_FILE_TIMEOUT:-${E2E_FILE_TIMEOUT_SECS:-180}}"
  # Digits-only validation (same strict positive-int posture as the TS env
  # knobs): a malformed value falls back to the default instead of
  # word-splitting into extra gtimeout arguments.
  case "$file_timeout" in ''|*[!0-9]*) file_timeout=180 ;; esac
  if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_CMD="gtimeout $file_timeout"
  elif command -v timeout >/dev/null 2>&1; then
    TIMEOUT_CMD="timeout $file_timeout"
  else
    TIMEOUT_CMD=""
  fi
  FILE_HOME="$E2E_TMP_HOME/file-$file_idx"
  mkdir -p "$FILE_HOME/.gbrain"
  rc=0
  p=0
  rm -f "$E2E_TMP_HOME/current.junit.xml"
  receipt_begin primary "$RECEIPT_TAG-f$file_idx" "$RECEIPT_SHARD" "$RECEIPT_OF" "" "${f#./}"
  env HOME="$FILE_HOME" GBRAIN_HOME="$FILE_HOME" $TIMEOUT_CMD bun test --timeout=60000 --reporter=junit --reporter-outfile="$E2E_TMP_HOME/current.junit.xml" ${COVERAGE_ARGS[@]+"${COVERAGE_ARGS[@]}"} "$f" > "$E2E_TMP_HOME/current.log" 2>&1 &
  ACTIVE_E2E_PID=$!
  wait "$ACTIVE_E2E_PID" || rc=$?
  ACTIVE_E2E_PID=""
  if [ -n "$RECEIPT_ID" ] && [ -f "$E2E_TMP_HOME/current.junit.xml" ]; then
    cp "$E2E_TMP_HOME/current.junit.xml" "$TEST_RECEIPT_DIR/$RECEIPT_ID.junit.xml"
  fi
  receipt_end "$rc"
  output=$(cat "$E2E_TMP_HOME/current.log")
  if ! cleanup_note=$(remove_file_home "$FILE_HOME"); then
    output="$output
$cleanup_note"
    rc=1
  else
    [ -z "$cleanup_note" ] || echo "$cleanup_note"
    if [ "$rc" -eq 0 ] && ! p=$(completed_e2e_passes "$f"); then
      echo "FAILED: $name did not produce a complete native Bun report for the selected file"
      rc=1
    fi
  fi
  if [ "$rc" -eq 0 ]; then
    pass_files=$((pass_files + 1))
    total_pass=$((total_pass + p))
    echo "$output" | tail -8
  else
    fail_files=$((fail_files + 1))
    fail_list+=("$name")
    p=$(echo "$output" | grep -oE '[0-9]+ pass' | tail -1 | grep -oE '[0-9]+' || echo 0)
    fl=$(echo "$output" | grep -oE '[0-9]+ fail' | tail -1 | grep -oE '[0-9]+' || echo 0)
    total_pass=$((total_pass + p))
    total_fail=$((total_fail + fl))
    echo "$output"
    echo ""
    echo "FAILED: $name"
    # Continue so we see all failures; exit nonzero at the end.
  fi
done

# Execution receipt (B9): which files this lane ran, written pass or fail so a
# red nightly still records them. lane-manifest.json (complete:true) stays
# green-only, written at the end.
if [ -n "${COVERAGE_DIR:-}" ]; then
  printf '%s\n' "${executed_files[@]}" > "$COVERAGE_DIR/executed-files.txt"
fi

echo ""
echo "========================================"
echo "E2E SUMMARY (sequential execution)"
echo "========================================"
echo "Files: $((pass_files + fail_files)) total, $pass_files passed, $fail_files failed"
echo "Tests: $total_pass passed, $total_fail failed"

# --- HOME isolation verification: fail loud on any out-of-isolation write ---
# Runs regardless of test pass/fail; isolation breach is higher-severity than
# any individual test failure. Exit 2 distinguishes from exit 1 (test failure).
# Three breach modes covered:
#   1. Config existed before AND was modified (md5 changed)
#   2. Config existed before AND was deleted during the run
#   3. Config did NOT exist before but was created during the run
AFTER_EXISTS=0
[ -f "$USER_CONFIG" ] && AFTER_EXISTS=1
AFTER_MD5=""
if [ "$AFTER_EXISTS" = "1" ]; then
  AFTER_MD5=$(md5_of "$USER_CONFIG")
fi
BREACH_REASON=""
if [ "$USER_CONFIG_EXISTED" = "1" ] && [ "$AFTER_EXISTS" = "0" ]; then
  BREACH_REASON="config existed before run but was deleted"
elif [ "$USER_CONFIG_EXISTED" = "0" ] && [ "$AFTER_EXISTS" = "1" ]; then
  BREACH_REASON="config did not exist before run but was created"
elif [ -n "$USER_CONFIG_MD5" ] && [ "$AFTER_MD5" != "$USER_CONFIG_MD5" ]; then
  BREACH_REASON="config md5 changed during run"
fi
if [ -n "$BREACH_REASON" ]; then
  echo "" >&2
  echo "ERROR: HOME isolation breach detected." >&2
  echo "  Reason: $BREACH_REASON" >&2
  echo "  Path: $USER_CONFIG" >&2
  echo "  Before: existed=$USER_CONFIG_EXISTED md5=${USER_CONFIG_MD5:-none}" >&2
  echo "  After:  existed=$AFTER_EXISTS md5=${AFTER_MD5:-none}" >&2
  echo "  A test wrote outside the tmpdir HOME despite the override." >&2
  exit 2
fi

if [ ${#fail_list[@]} -gt 0 ]; then
  echo ""
  echo "Failing files:"
  for f in "${fail_list[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

# Lane manifest: written ONLY on a fully green run (isolation breach exits 2
# and failing files exit 1 above, both before reaching here), so
# complete:true means the lcov data represents the whole E2E lane.
if [ -n "${COVERAGE_DIR:-}" ]; then
  LCOV_COUNT=$(find "$COVERAGE_DIR" -name 'lcov.info' 2>/dev/null | grep -c '^' || true)
  LANE="e2e"
  [ -z "$RUNNER_SHARD" ] || LANE="e2e-$shard_n"
  RUN_SHA=$(git rev-parse HEAD)
  printf '{"lane":"%s","sha":"%s","lcovCount":%s,"complete":true}\n' \
    "$LANE" "$RUN_SHA" "${LCOV_COUNT:-0}" > "$COVERAGE_DIR/lane-manifest.json"
fi
