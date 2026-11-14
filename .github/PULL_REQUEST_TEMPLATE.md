<!--
Title: plain words that say what changed for someone using this repository. No version
and no `type(scope):` prefix (https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#plain-titles).
A tracker reference, if any, goes last.
Changelog: add `changelog.d/<branch-slug>.md` (the entry text only, no version heading;
/ship writes it). See docs/RELEASING.md.
-->

## What

<!-- One paragraph: what changes for someone using this repository, and the issue it fixes. -->

## Why

<!-- The failure mode this closes. Link the issue. -->

## Discrimination test (required for every fix)

<!--
A fix's test is only worth anything if it FAILS without the fix. Fill in the
one-line result of actually checking that. The helper does it in one command:

    bash scripts/check-test-discriminates.sh <test-file> <source-file> [...]

It reverts the source file(s) to the pre-fix state, runs the test file,
requires >=1 executed test to FAIL (a crash or missing-file non-zero exit does
not count; see the script's exit-code contract), restores, and prints the
line below for you. For a committed fix set DISCRIMINATE_BASE=origin/main.
Tests that pass both ways are worse than no test: they inflate reviewer
confidence, cost CI time forever, and keep passing after a future refactor
breaks the behavior.

Delete this section ONLY for pure-docs / pure-refactor PRs with no behavior
change to pin.
-->

Discrimination test: reverted `<source file(s)>` to `<ref>`, ran `<test file>` → `N pass / M fail`. Restored → all pass.

## Verification

<!--
If any message or doc this PR adds tells the reader to run a command to verify
something, paste the output of that verification against a system in the
BROKEN state (remediation text that lies is the failure this catches).
Otherwise delete this section.
-->

## Tests

<!-- Test files touched or added, and the local run result: `bun run verify` and the lane you ran, each saved to a file with its exit status read from the file, never piped through tail. -->
