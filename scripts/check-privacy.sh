#!/bin/bash
#
# check-privacy.sh — enforces the Privacy rule in CLAUDE.md.
#
# CLAUDE.md forbids the private OpenClaw fork name in public artifacts:
# CHANGELOG.md, README.md, docs/, skills/, PR titles + bodies, commit
# messages, and comments in checked-in code. This script greps for the
# banned name in either the staged index (for pre-commit hooks) or the
# working tree (for CI) and fails loudly if found.
#
# The allow-list below whitelists files where the name is legitimate
# — specifically, this script itself (where we reference the name to
# describe the rule) and upgrade guides that historically referenced
# the pre-rename fork name.
#
# Usage:
#   scripts/check-privacy.sh          # scan working tree
#   scripts/check-privacy.sh --staged # scan git staged index
#   scripts/check-privacy.sh --help
#
# Exit codes:
#   0  clean, or nothing to scan (then it prints `GBRAIN_CHECK_SKIPPED: <reason>`,
#      which `bun run verify` records as a skip, not a pass)
#   1  banned name found (or --help printed)
#   2  git / grep not available

set -euo pipefail

. "$(dirname "$0")/lib/guard-candidates.sh"

BANNED_NAME='wintermute'
# v0.25.1 (codex T7): additional patterns from wintermute-specific filesystem
# layouts that would leak private fork context if they slipped through a port.
# `wintermute_only` already matches via the case-insensitive `wintermute` regex
# above; this list is for orthogonal patterns.
BANNED_PATHS=(
  '/data/brain/'
  '/data/.openclaw/'
)

usage() {
  cat <<EOF
scripts/check-privacy.sh — scan for the banned OpenClaw fork name.

USAGE:
  scripts/check-privacy.sh           Scan all tracked files in the working tree.
  scripts/check-privacy.sh --staged  Scan only files staged for commit.
  scripts/check-privacy.sh --help    Show this message.

The script greps for '${BANNED_NAME}' (case-insensitive) in:
  - CHANGELOG.md, README.md
  - docs/**
  - skills/**
  - src/**
  - test/**
  - scripts/**

Allow-list (references to the name are permitted):
  - scripts/check-privacy.sh itself
  - .git/** (branch names, commit history — not checked in artifacts)

Exit codes: 0 clean, 1 banned name found, 2 setup error.
EOF
}

MODE=working
for arg in "$@"; do
  case "$arg" in
    --staged) MODE=staged ;;
    --help|-h) usage; exit 1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "check-privacy: git not found" >&2
  exit 2
fi

# Build the file list by scanning-mode.
if [ "$MODE" = staged ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
else
  FILES=$(git ls-files 2>/dev/null || true)
fi

# Nothing to scan: the runner counts this marker as a skip, not a pass.
if [ -z "$FILES" ]; then
  if [ "$MODE" = staged ]; then
    echo "GBRAIN_CHECK_SKIPPED: no staged files to scan"
  else
    echo "GBRAIN_CHECK_SKIPPED: git lists no tracked files to scan"
  fi
  exit 0
fi

SCAN_PATTERNS=(-iF -e "$BANNED_NAME")
for path in "${BANNED_PATHS[@]}"; do
  SCAN_PATTERNS+=(-e "$path")
done
FILES="$(guard_candidates "${SCAN_PATTERNS[@]}" <<< "$FILES")"

# Allow-list: files in which the banned name is legitimate.
# Meta-rule docs (define the rule itself), auto-generated LLM indexes,
# historical upgrade guides, and the test that enforces the rule
# against recipes/ all reference the banned name by necessity.
ALLOW_LIST=(
  'scripts/check-privacy.sh'
  # Sibling rule-enforcement script for test/fixtures/conversation-formats/.
  # Same meta-exception as check-privacy.sh itself — the script's
  # BANNED_TOKENS array literally names the tokens it forbids.
  'scripts/check-fixture-privacy.sh'
  'CLAUDE.md'
  # CHANGELOG.md: documents the BANNED_PATHS literals in describing what the
  # guard forbids, so it is exempt from the PATH check only. The fork-name
  # check still runs on it (see the loop below): the notes are the most-read
  # public artifact and the name has leaked there.
  'CHANGELOG.md'
  # The sibling check-test-real-names.sh enforces the same privacy rule for
  # test fixtures and lists the banned names literally inside its
  # BANNED_NAMES + ALLOWLIST arrays. Same meta-rule-enforcement exception as
  # scripts/check-privacy.sh itself.
  'scripts/check-test-real-names.sh'
  # scripts/check-proposal-pii.sh and its test list the banned literal as part
  # of the structural denylist they enforce against docs/proposals/*.md. Same
  # meta-rule-enforcement exception as the entries above — describing what the
  # rule forbids requires naming it.
  'scripts/check-proposal-pii.sh'
  'test/scripts/check-proposal-pii.test.ts'
)

is_allowed() {
  local f="$1"
  for a in "${ALLOW_LIST[@]}"; do
    if [ "$f" = "$a" ]; then
      return 0
    fi
  done
  return 1
}

FOUND=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ ! -f "$file" ] && continue
  if is_allowed "$file"; then
    # CHANGELOG.md is allow-listed for the BANNED_PATHS literals only; the
    # fork-name check applies to it like any other public artifact.
    if [ "$file" = "CHANGELOG.md" ] && grep -in "$BANNED_NAME" "$file" >/dev/null 2>&1; then
      echo "[check-privacy] BANNED NAME in $file:" >&2
      grep -in "$BANNED_NAME" "$file" | sed 's|^|  |' >&2
      FOUND=1
    fi
    continue
  fi
  # Case-insensitive grep; only specific extensions + known docs.
  case "$file" in
    *.md|*.ts|*.tsx|*.mjs|*.js|*.jsx|*.py|*.sh|*.json|*.yaml|*.yml|*.txt|README*|CHANGELOG*|CLAUDE*|AGENTS*)
      if grep -in "$BANNED_NAME" "$file" >/dev/null 2>&1; then
        echo "[check-privacy] BANNED NAME in $file:" >&2
        grep -in "$BANNED_NAME" "$file" | sed 's|^|  |' >&2
        FOUND=1
      fi
      # Banned wintermute-specific filesystem paths (codex T7).
      for path in "${BANNED_PATHS[@]}"; do
        if grep -nF "$path" "$file" >/dev/null 2>&1; then
          echo "[check-privacy] BANNED PATH '$path' in $file:" >&2
          grep -nF "$path" "$file" | sed 's|^|  |' >&2
          FOUND=1
        fi
      done
      ;;
  esac
done <<< "$FILES"

if [ "$FOUND" -eq 1 ]; then
  echo "" >&2
  echo "The private OpenClaw fork name is banned in public artifacts." >&2
  echo "CLAUDE.md, Privacy rule. Replace with 'your OpenClaw', 'OpenClaw reference deployment', or 'openclaw-reference'." >&2
  exit 1
fi

exit 0
