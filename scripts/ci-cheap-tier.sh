#!/usr/bin/env bash
# test.yml cheap-tier aggregator (docs/ci-event-parity.md#full-ci-on-pull-requests).
# Inputs: job results in CHANGES GITLEAKS AUDIT VERIFY TYPECHECK STRESS.
# Every cheap lane must succeed. A lane gated by Trunk Dynamic CI (DCI_STRESS,
# docs/ci-event-parity.md#trunk-dynamic-ci) may also be skipped when its verdict
# is exactly 'false'; Learning mode never says 'false'. The step summary always
# says the full suite did not run.
set -euo pipefail

fail=0
trunk_skipped() {
  [ "$1" = skipped ] && [ "$2" = false ] || return 1
  echo "  skipped by Trunk Dynamic CI (verdict false)"
}
for row in "changes|${CHANGES:-}|" "gitleaks|${GITLEAKS:-}|" "dependency-audit|${AUDIT:-}|" \
  "verify|${VERIFY:-}|" "typecheck|${TYPECHECK:-}|" "stress-changed-tests|${STRESS:-}|${DCI_STRESS:-}"; do
  IFS='|' read -r name result verdict <<< "$row"
  echo "$name=$result"
  if trunk_skipped "$result" "$verdict"; then continue; fi
  if [ "$result" != success ]; then echo "✗ $name did not succeed (got $result)"; fail=1; fi
done

{
  echo "## Full suite not run"
  echo "This pull request ran the cheap tier: verify, typecheck, gitleaks, the dependency audit and the stress gate on changed tests. Unit shards, serial and the E2E lane did not run."
  echo "The full suite runs when a maintainer adds the \`full-ci\` label, which dispatches Test on the head branch (a thread can dispatch it itself: \`gh workflow run test.yml --ref <branch>\`). Only that run reports the \`full-suite\` check."
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo "::notice::Full suite not run on this head (cheap tier). Add the full-ci label to run it."

if [ "$fail" -ne 0 ]; then echo "✗ cheap tier failed"; exit 1; fi
echo "✓ cheap tier green (full suite not run)"
