# AGENT_OPERATOR v1: how an agent reads this repository's harness

This repository's guards, test runners and CI assume an agent runs them unattended. This page
says how to read what they print and what to do next. The messages are written to gstack's
[agent-ready error contract](https://github.com/garrytan/gstack/blob/main/docs/agent-ready-errors.md);
this page covers what this repository's tools actually print. When a tool's output changes, this
page changes in the same pull request.

## Quick contract

1. **The exit status is the verdict.** Save a command's whole output to a file, then read the
   file; never cut it with `tail` or `head` before it is saved.
2. **A failure block** is a headline (`FAIL:`, `✗`, `ERROR:` or a `::error` annotation), then
   `Why:`, `Fix:`, and `See:` or `Docs:`. Do what `Fix:` says, read the `Docs:` anchor when the fix
   is not enough, and rerun the same command.
3. **A skip is not a pass.** A check that had nothing to check prints
   `GBRAIN_CHECK_SKIPPED: <reason>`; report it as skipped, with the reason.
4. **Never weaken, skip or delete a check to make it pass.** A check goes only with its subject.
5. **Ask the owner** when the fix needs a credential, a repository setting, consent or a decision
   no record settles. Say what you need, why, and what else you considered.

## Failure lines

| Line | Meaning |
|---|---|
| `FAIL: <what>` | One finding, first in its block. Some guards tag it: `[check-fixture-privacy] FAIL: ...`. |
| `✗ <check>: <count> ...` | The verdict of a guard with several findings, usually its last line. |
| `ERROR: <what>` | A usage or environment error (exit 2), or a finding in a few guards. |
| `Why:` | Why the rule exists. Always before `Fix:`. |
| `Fix:` | The exact command, flag or edit. Not always the block's last line. |
| `See:` / `Docs:` | The page and anchor that explain the rule. |
| `Reproduce:` / `Next:` | The command that reproduces a CI failure, or the next step, before `Docs:`. |
| `WARN:` | Not fatal: exit 0, recorded as a pass. |
| `::error`, `::warning`, `::notice` | A GitHub annotation; `Why:`, `Fix:` and `Docs:` sit inside the same line. |

Parse the labels with `^(Why|Fix|See|Docs):\s+`: some guards put two spaces after the colon.
`scripts/check-orphan-modules.mjs` and `scripts/check-test-placeholders.mjs` use their own
lower-case lines (`reason:`, `remedy:`, `rerun:`, `docs:`). A few guards print the remedy as plain
prose with no `Fix:` label; the text after the headline is then the fix. Success text is not
uniform (`OK:`, `✓`, `ok`): rely on the exit status.

## Verify: `bun run verify`

`scripts/run-verify-parallel.sh` runs every check in its `CHECKS` list in a bounded pool, then the
`SOLO_CHECKS` one at a time; `--dry-list` prints them.

- **Outcomes.** Each check is recorded as `pass`, `fail`, `timeout` (over `GBRAIN_VERIFY_TIMEOUT`,
  120 s by default) or `skip`, in `outcomes.tsv` in the log directory and in the verify receipt. The
  log directory is `GBRAIN_VERIFY_LOG_DIR` when set; otherwise a temporary one, deleted on success
  and kept on failure, and the last line names it.
- **The failure banner** lists the failing checks and shows the last 30 lines of each one's log.
  The whole log is in the log directory. A drift in a generated artifact, golden or manifest is
  fixed with `bun run regen:all`, which the banner also says.
- **Skips.** A check whose subject is absent prints `GBRAIN_CHECK_SKIPPED: <reason>` and exits 0;
  verify records it as `skip`, lists it under `self-skipped (recorded as skip, not pass)` and still
  exits 0. The size and orphan ratchets skip while `src/` is empty.
- **The guard self-test** (`scripts/guard-self-test.sh`) runs each guard listed `selftest yes` in
  `scripts/guards-manifest.tsv` against its `bad` and `good` fixtures. A green self-test proves the
  guards still fail on bad input; it does not prove a skipped ratchet measured anything.
- **Exit:** 0 every check passed or skipped; 1 a check failed or timed out; 2 usage or
  environment.

## Test lanes

| Lane | Command | Exit | Read failures in |
|---|---|---|---|
| unit | `bun run test` (`scripts/run-unit-parallel.sh`) | 0, 1, 2 usage; 130/143 interrupted | `.context/test-shards/shard-N.log` |
| unit, CI shard | `bash scripts/test-shard.sh`, `bash scripts/test-shard-pack.sh` | 0, **123** when any test fails, 1 or 2 usage | the job log and its `::error` line |
| serial | `bun run test:serial` (`scripts/run-serial-tests.sh`) | 0, 1, 2 | its output and `.context/serial-timings.json` |
| slow | `bun run test:slow` (`scripts/run-slow-tests.sh`) | Bun's status | its output |
| E2E | `bash scripts/run-e2e.sh` | 0, 1, 2 | its output; one bun process per file |
| all | `bun run test:full` | the first failing step's status | the step that failed: later steps did not run |
| CI on this machine | `bun run ci:local` | the first failing phase; 123 from its sharded phase | `.context/ci-local-shards/` |

- **The unit failure log.** The banner names `.context/test-failures.log`. Each block there
  starts at a `(fail)` line, but Bun prints a test's error and diff above that line, so the
  block holds the start of the next failure instead; read the diff in
  `.context/test-shards/shard-N.log`. `.context/test-summary.txt` has one line per shard.
  `bun run test --dry-run` clears all three.
- **Empty lanes.** A lane with no files exits 0 and says so (`No files for shard (unsharded);
  exiting clean.` for E2E). An empty lane is not a passing lane: say it ran nothing.
- **Exit 123.** The CI unit shards run Bun through `xargs`, which turns any failing test into
  123. Treat 123 as "tests failed", not as a crash.
- **`ci:local`** needs `gitleaks` on the machine and stops at once without it.

### Rescues and warnings

These end green or red without being a plain pass or fail; report them as what they are.

- **OOM rescue.** A shard that failed with the WebAssembly out-of-memory signature is re-run
  serially. A green rescue exits 0 and the last line ends `oom_rescued=<n>files(...)`; the old
  failure blocks stay in the failure log. `GBRAIN_TEST_NO_OOM_FALLBACK=1` turns the rescue off.
- **Killed externally** (`KILLED externally ...`) or **WEDGED** (`WEDGED after <n>s`): the
  first is queued for the serial rescue, the second is red.
- **EXIT-HANG** (`EXIT-HANG ... warn-pass`): a shard whose files all started and passed but whose
  process did not exit is a pass with a warning, and its pass count is low.
- **Memory adaptation.** The first banner line says `mem-adapted 4x4→2x1 (...)` or `mem-ok`: the
  shard count follows free memory, so shard numbers differ between runs.
- **Serial lane:** `KILLED ... queued for serial rescue` is re-run; `FAIL ... exit 137 (hang
  survived SIGTERM ...)` is a real failure.

A rescued green is not a fix: when you see one, say so in the pull request.

## Environment guards

Every `bun test` loads the preloads in `bunfig.toml` (details:
[test preloads](../TESTING.md#test-preloads)):

| Preload | What it does |
|---|---|
| `test/helpers/database-url-guard-preload.ts` | Refuses to start while `DATABASE_URL` or `GBRAIN_DATABASE_URL` is set: `TEST-RUN GUARD: refusing to start — DATABASE_URL is set.`, exit 1. Unset the variable. |
| `test/helpers/operator-env-preload.ts` | Removes the operator's own variables from the test process; test opt-ins survive under the `GBRAIN_TEST_` prefix ([opt-in naming rule](../TESTING.md#opt-in-naming-rule)). An opt-in set under its old name exits 2 with `Why:` and `Fix:`. |
| `test/helpers/provider-keys-preload.ts` | Removes model-provider keys, so tests run keyless. |
| `test/helpers/real-home-guard-preload.ts` | Fails the test that changes install files under the real home. |
| `test/helpers/gbrain-home-preload.ts` | Points `GBRAIN_HOME` at a fresh temporary directory. |
| `test/helpers/git-hermetic-preload.ts` | Drops git variables that locate a repository and turns off commit signing for test git processes. |

`scripts/run-e2e.sh` also gives each file its own `HOME` and fails a file that leaves a process
writing to it.

## Executed-test receipts

With `GBRAIN_TEST_RECEIPT_DIR` set, every runner writes receipts
([executed-test receipts](../TESTING.md#executed-test-receipts)); CI uploads them as `receipts-*`.

- A file counts as run only when one of its attempts left a well-formed JUnit report. A receipt
  without `exit=` means the runner never saw the process return.
- A later attempt (rerun, rescue) supersedes an earlier one for the files it ran.
- A shard that was given no files writes a receipt with `empty=1`, so it is not read as missing.
- `scripts/ci-executed-counts.ts` and `scripts/ci-manifest.ts` prove which tests ran and which
  failed, not that the run passed: a `PASS` ledger or a `complete` manifest can list failing
  tests. The job's exit status is the outcome.

## CI issues

nightly-watch keeps `nightly-red` issues for scheduled runs and `master-red` and `flake` issues for
pushes to main ([ownership and response times](../RELEASING.md#nightly-red-issues),
[labels and recovery](../ci-red-runbook.md#ci-issue-labels)). Each body ends with
`### Next step for the agent`, a paragraph, and a fenced JSON block after a marker
(`<!-- nightly-watch:json -->`, `<!-- master-red:json -->`, `<!-- flake:json -->`). Read the JSON,
not the prose. For `nightly-red`, `next_step` is one of:

- `code_fix`: open a repair PR whose body says `Fixes #<issue>`.
- `owner_action`: tell the owner exactly what is needed (a secret, a setting) and stop.
- `known_red_wait`: a `.github/nightly-known-red.tsv` row covers it; nothing until its review-by
  date.
- `review_by_passed`: fix it, or re-justify the row with a new date.
- `none`: green.

Never widen a timeout or weaken an assertion to close a CI issue.

## Exit codes of the other tools

| Tool | Exit |
|---|---|
| `check-*` guards | 0 clean or skipped; 1 findings; 2 usage or environment in some guards, 1 in others |
| `bun run regen:all` (`scripts/regen-all.ts`) | 0 fresh or regenerated; 1 `--check` found stale artifacts; 2 usage |
| `scripts/check-test-discriminates.sh` | 0 the test fails without the fix; 1 it passes without the fix; 2 usage; 3 it fails without a failing test |
| `scripts/ci-executed-counts.ts` | 0 complete; 1 a dropped or incomplete lane; 2 usage or download error |
| `scripts/nightly-issue.ts` | 0 any verdict; 1 run or known-red file unreadable; 2 usage |
| `bun run test:stress` | 0 every file passed; 1 a file failed; 2 usage; 130/143 cancelled |

## Products built on this repository

A product built on this repository adds its own section for its own surfaces (its CLI, server or
tool errors) beside this one. This page covers the harness only.
