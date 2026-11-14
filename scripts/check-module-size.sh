#!/usr/bin/env bash
# CI guard: module-size ratchet (containment sprint).
#
# Giant modules get that way one innocent commit at a time. This guard freezes
# every oversized file at a committed ceiling (scripts/module-size-limits.tsv)
# and caps every UNLISTED src file at a hard limit, so the only way to grow a
# giant is a reviewer-visible TSV edit.
#
# TSV columns (tab-separated): path  max_lines  policy  note
#   policy=ratchet        line count (wc -l) must stay <= max_lines
#                         (the only policy)
#
# Rules (all violations reported, then one exit):
#   1. measured > max_lines            -> FAIL (growth; raise the ceiling
#                                         consciously via a TSV edit)
#   2. max_lines - measured > SLACK    -> FAIL (stale ceiling after a shrink;
#                                         lower it so the ratchet holds)
#   3. TSV path does not exist         -> FAIL (remove the row)
#   4. unlisted src file > NEWFILE_CAP -> FAIL (split it, or add a TSV row
#                                         consciously)
#
# Self-test seams: DEVMODEL_GUARD_ROOT (fixture tree root; TSV read from
# <root>/scripts/module-size-limits.tsv), DEVMODEL_MODULE_SIZE_SLACK,
# DEVMODEL_MODULE_SIZE_NEWFILE_CAP.
#
# While src/ holds no source file and the TSV has no row, there is nothing to
# measure: the guard prints `DEVMODEL_CHECK_SKIPPED: <reason>` and exits 0, which
# the verify runner counts as a skip.

set -uo pipefail

ROOT="${DEVMODEL_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 1

TSV="scripts/module-size-limits.tsv"
SLACK="${DEVMODEL_MODULE_SIZE_SLACK:-50}"
NEWFILE_CAP="${DEVMODEL_MODULE_SIZE_NEWFILE_CAP:-1500}"

if [ ! -f "$TSV" ]; then
  echo "FAIL: $TSV not found under $ROOT" >&2
  exit 1
fi

fail=0

listed_paths=""

while IFS=$'\t' read -r path max policy note; do
  case "$path" in ''|'#'*) continue ;; esac
  listed_paths="$listed_paths $path"

  if [ ! -f "$path" ]; then
    echo "FAIL: $TSV lists $path but the file does not exist — remove the row." >&2
    fail=1
    continue
  fi

  case "$policy" in
    ratchet)
      measured=$(wc -l < "$path" | tr -d ' ')
      label="lines"
      ;;
    *)
      echo "FAIL: $TSV row for $path has unknown policy '$policy' (ratchet)." >&2
      fail=1
      continue
      ;;
  esac

  if [ "$measured" -gt "$max" ]; then
    echo "FAIL: $path is $measured $label, over its $max ceiling." >&2
    echo "Why:  growing a size-ratcheted module is a conscious, reviewer-visible decision." >&2
    echo "Fix:  move new logic into a sibling module (preferred), or raise the ceiling to" >&2
    echo "      $measured in $TSV in this same commit." >&2
    fail=1
  elif [ $((max - measured)) -gt "$SLACK" ]; then
    echo "FAIL: $path shrank to $measured $label but its ceiling is still $max." >&2
    echo "      Lower the ceiling in $TSV to $measured so the ratchet holds the win." >&2
    fail=1
  fi
done < "$TSV"

# Rule 4: every unlisted src .ts file (non-test, non-generated) obeys the cap.
src_files=0
while IFS= read -r f; do
  src_files=$((src_files + 1))
  case " $listed_paths " in *" $f "*) continue ;; esac
  lines=$(wc -l < "$f" | tr -d ' ')
  if [ "$lines" -gt "$NEWFILE_CAP" ]; then
    echo "FAIL: $f is $lines lines, over the $NEWFILE_CAP cap for files not listed in $TSV." >&2
    echo "      Split it into sibling modules, or add a TSV row consciously." >&2
    fail=1
  fi
done < <(find src -name '*.ts' -not -name '*.generated.ts' -not -name '*.test.ts' 2>/dev/null | sort)

if [ "$fail" -ne 0 ]; then
  exit 1
fi

# Nothing to measure: no src/ source file and no TSV row (a stale row already
# failed above). The runner counts this marker as a skip, not a pass.
if [ "$src_files" -eq 0 ] && [ -z "$listed_paths" ]; then
  echo "DEVMODEL_CHECK_SKIPPED: no source files under src/ and no rows in $TSV"
  exit 0
fi

echo "OK: module sizes within committed ceilings ($TSV; new-file cap $NEWFILE_CAP)."
