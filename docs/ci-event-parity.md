# CI event parity

The classification table [docs/TESTING.md](TESTING.md#event-parity) links to.

A red that only a push to main can produce is a red no pull request could have
caught. So every event-conditional behavior in the workflows is either parity
(every event does the same work) or a named exception whose comment, beside
the condition, names the scheduled run that covers it. A condition with no
covering scheduled run defaults to parity; anything else needs a new scheduled
run or a decision recorded beside the condition.
`test/scripts/ci-pr-scope.test.ts` fails on an event-conditional job or block
in `test.yml`, `stress.yml` or `semgrep.yml` that carries no such comment, and
when the table below omits one of the workflows it names. The `full-suite` job
and its `full-suite-tree` artifact ([below](#full-ci-on-pull-requests)) are what
master-push reuse and gstack's run evidence read, never per-cell matrix names.

## Classification

| Workflow | Condition | Class | Covered by |
| --- | --- | --- | --- |
| `test.yml` | `dynamic-ci` filter (Trunk Dynamic CI) on pull requests; its gated job, `stress-changed-tests`, runs unless the verdict is exactly `'false'` | Named exception ([below](#trunk-dynamic-ci)): pull requests only, Learning mode skips nothing | The full-ci dispatch, every push to main, a merge-queue entry (when a queue is enabled) and the nightly schedule, which never run the filter |
| `test.yml` | Cheap tier on pull requests: no unit shards, `serial-tests`, `e2e` lane, `coverage-report`, `test-status` or `full-suite`; the pull request gets `cheap-tier (full suite not run)` instead | Named exception ([below](#full-ci-on-pull-requests)) | The full-ci dispatch on the head before merge, every push to main, a merge-queue entry (when a queue is enabled) and the nightly Test schedule run the full profile |
| `test.yml` | `changes` computes the master-push reuse decision on `push` only; a push whose tree equals a passed full run skips the full lanes and both aggregates | Named exception ([below](#master-push-reuse)) | The reused run (same tree, full profile); schedules, merge-queue entries and dispatches never reuse |
| `test.yml` | `gitleaks` commit range by event | Parity: each event scans the range it introduces | — |
| `test.yml` | `dependency-audit` blocking scope | Named exception with a rule ([below](#dependency-audit-rule)) | Every push to main, the nightly Test schedule and every manual run (always blocking) |
| `test.yml`, `stress.yml` | `stress-changed-tests` file set: only `pull_request` and `merge_group` runs plan files; elsewhere the job succeeds with "not a PR event" | Named exception: pull-request gate | Push and nightly runs execute every test file once in the full suite |
| `test.yml` | `stress_files`, `stress_base` and `stress_head` dispatch inputs; the `-diagnostic` and `-nightly` concurrency suffixes | Parity: a manual diagnostic mode and run grouping, never applied to pull request, push, merge-queue or schedule events | — |
| `semgrep.yml` | Pull-request diff scan (`semgrep`) against full-tree scan (`semgrep-full`, schedule and dispatch) | Named exception | Weekly Semgrep schedule |
| `osv-scanner.yml` | Pull requests scan only when `bun.lock` or `package.json` changes | Named exception | Weekly OSV schedule; `dependency-audit` on every pull request |
| `actionlint.yml` | Runs only when a file under `.github/workflows/` or `.github/actionlint.yaml` changes (push, pull request or dispatch) | Named exception: path filter | Itself, on the change that touched the workflow files |
| `nightly-watch.yml` | `workflow_run` event guard | Not a test scope: it files issues from scheduled runs and push-to-main runs of Test | — |
| `ci-health.yml` | Schedule and dispatch only | Not a test scope: it reports on CI runs | — |
| `fix-wave-gate.yml`, `fix-wave-closeout.yml` | `pull_request_target` action and merge state | Not a test scope: merge-process automation | — |
| `full-ci.yml` | `full-ci` label, later pushes to a labeled pull request, same-repository head | Not a test scope: dispatches Test (full profile) on the head | — |

## Full CI on pull requests

Every pull-request push runs the cheap tier in Test: `verify`, `typecheck`,
`gitleaks`, the dependency audit and the stress gate on changed tests. The
`cheap-tier (full suite not run)` check aggregates them
(`scripts/ci-cheap-tier.sh`): a lane that did not succeed fails it, and its
summary says the full suite did not run. The unit shards, the serial shards and
the `e2e` lane (`scripts/run-e2e.sh`) do not run on pull requests. The
`executed-receipts` job also runs and uploads the manifest, but the aggregate
does not read it.

The full suite runs on the exact head before merge, with the same shape as a
push to main: every unit shard, every serial shard and the `e2e` lane. A
maintainer adds the `full-ci` label (a label needs triage access, so
contributors cannot add one). `full-ci.yml` then dispatches Test on the head
branch, and again on every later push while the label stays. A fork's branch is
never dispatched. A thread that wants the full suite earlier, for a risky
change, dispatches it itself: `gh workflow run test.yml --ref <branch>`.

`full-suite` succeeds only when its own run's aggregate (`test-status`) did.
No branch protection makes it a required check in this repository, so it does
not block a merge: under `merge: direct`, `gstack-ship-queue land` gates on
GitHub's required checks and on `land.merged_checks` in
`.gstack/ship-policy.json` (`bun run typecheck`, `bun run verify`)
([gstack docs/ship-policy.md#land-direct](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#land-direct)). A pull-request run skips both
and names them `full-suite-not-run`, so a cheap green can never produce either.
`full-suite` uploads `full-suite-tree`, a `tree.json` recording the tested tree
(`scripts/ci-full-suite-tree.sh`). Pushes to main, merge-queue entries and
schedules always run the full profile.

A dispatch with `stress_files` or `stress_base` runs only the stress gate, under
its own `-diagnostic` concurrency group. Its aggregates are named
`full-suite-not-run`, and nightly-watch never evaluates it.

A push to main is keyed by its commit, so a newer push never cancels its run:
nightly-watch evaluates every push run ([CI red runbook](ci-red-runbook.md#master-red-reconciliation)).

## Master-push reuse

A push to main runs nothing again when its tree equals the tree of a passed,
complete full-suite run of Test (`scripts/ci-reuse.ts`, in the `changes` job).
The push itself must be a merge commit. The candidate must meet all of these:

- It is a `workflow_dispatch` or `push` run from this repository.
- Its latest attempt completed with success.
- Its single `full-suite` job succeeded in that attempt.
- Its `tree.json` matches the run (id, attempt, commit, event, workflow,
  profile `full`).
- The recorded tree equals both the push tree and the tree of the run's head.

The script tries the runs on the merged head first, newest first, then recent
successful runs on other heads with the same tree. Anything else, an API error
or a partial, cancelled or diagnostic run included, leaves reuse unset, so the
push runs in full. A reusing push skips the unit, serial and `e2e` lanes, the
coverage report, the receipts ledger and both aggregates. It records the reused
run in its summary and runs the `reused-full-suite` job with the `reuse.json`
artifact. `verify`, `typecheck`, `gitleaks` and the dependency audit still run.
nightly-watch judges a reusing push by the run `reuse.json` names. Schedules
never reuse.

## Run evidence for gstack (`gstack-pregate clear --run`)

gstack can take a GitHub run of Test as evidence itself, so a slot does not run
the full suite a second time
([gstack docs/pregate.md#run-evidence](https://github.com/garrytan/gstack/blob/main/docs/pregate.md#run-evidence)).
This repository's side of it:

- `.gstack/pregate.json` declares one run profile, `test`: workflow `test.yml`,
  job `full-suite`, artifact `full-suite-tree`, events `workflow_dispatch` and
  `push`.
- `tree.json` carries `files` (every test file the run loaded, repo-relative)
  and `tests` (its executed test count). `scripts/ci-full-suite-tree.sh` takes
  them from the run's `ci-manifest.json`, and only when that manifest is
  complete and names the same run, attempt and commit. Otherwise both are left
  out with a warning: the run still counts as a passed full suite, but gstack
  cannot take it as evidence.
- A push that reused a run has no `full-suite` job, so it is never evidence.
- gstack accepts only runs whose newest attempt succeeded. **A flaky job means
  re-running the whole workflow.** "Re-run failed jobs" carries every job that
  passed, the `executed-receipts` job that writes the manifest included, over
  from the older attempt, so the new attempt has no manifest of its own and its
  `tree.json` has no `files`.

<a id="ship-lanes"></a>
## /ship lanes and CI carry

CI's full run is this repository's one full test run. gstack's pregate and
/ship can carry a test lane from a passed run at the exact, clean tree instead
of running it again
([gstack docs/pregate.md#ci-carry](https://github.com/garrytan/gstack/blob/main/docs/pregate.md#ci-carry)).
A /ship lane carries only when `.gstack/pregate.json` maps its exact command
under `ship_lanes_from`; this repository sets no such mapping, so every /ship
test lane runs where /ship runs it. `bun run verify` and `bun run typecheck`
never carry: `tree.json` records test files only, so no inventory can show that
CI ran them.

## Dependency-audit rule

`dependency-audit` blocks on pushes, schedules, manual runs and pull requests
or merge-queue entries that change a dependency manifest or carry the
`dependency-audit` label; on other pull requests a new upstream advisory is a
warning, so one published advisory cannot turn every open PR red at once.
The red it produces lands on main instead, and is handled like any other:
a push-to-main red opens the Test `master-red` issue, a scheduled red the
`nightly-red` issue. The repair PR bumps, overrides, patches or removes the
dependency. When no fix exists, an ignore entry needs a maintainer's approval
and an expiry date.

## Trunk Dynamic CI

Trunk Dynamic CI ([docs](https://docs.trunk.io/ci/dynamic-ci)) decides per
pull-request push which jobs still need to run, from this repository's own CI
history. A `dynamic-ci` job in `test.yml` runs `trunk-io/dynamic-ci` (pinned to
a commit SHA) with the `TRUNK_API_TOKEN` repository secret and writes one output
per gated job. The step has `continue-on-error: true` and a 3-minute step
timeout inside the job's 5, so a failed or hung Trunk call leaves the outputs
empty and the check green instead of red on the head (a lost runner still fails
the job).

- **Gated jobs.** `stress-changed-tests` in `test.yml` is the only gated job.
  `gitleaks`, `dependency-audit`, `verify`, `typecheck`, `cheap-tier` and the
  aggregates are not gated.
- **Form.** A gated job lists `dynamic-ci` in `needs` and its `if` starts
  `!cancelled() && needs.dynamic-ci.outputs.<job key> != 'false' &&`, followed
  by `needs.<other>.result == 'success'` for every other job it needs and then
  its original condition. `!cancelled()` keeps a skipped or failed filter from
  skipping the job, `!= 'false'` makes an empty output (no token, a Trunk
  outage, no verdict yet) run it, and the `result == 'success'` checks keep what
  the implicit `success()` did before.
- **Events.** The filter's `if` is `github.event_name == 'pull_request'`. On a
  push, merge-queue entry, schedule or dispatch (the full-ci run) it is skipped,
  every output is empty, and every gated job runs exactly as before, so
  `full-suite` and the reuse evidence are unchanged.
- **Modes.** A repository starts in Learning mode: Trunk records a verdict for
  every gated job and skips nothing. Enforcement is the Mode setting on Trunk's
  Dynamic CI settings page, not this file. Under enforcement `cheap-tier`
  accepts a gated lane that skipped only when its verdict was exactly `'false'`
  (`scripts/ci-cheap-tier.sh`). Before enforcing, weigh one gap:
  `stress-changed-tests` repeats changed tests only on pull requests (no full
  run repeats them), so a skip there removes that check for the push.
- **Guard.** `scripts/check-dynamic-ci.ts` (`bun run check:dynamic-ci`, in
  `bun run verify`) fails when a filter job can run on another event, sits in a
  workflow without a pull-request trigger, is not SHA-pinned, takes its token
  from anywhere but `secrets.TRUNK_API_TOKEN`, lacks `continue-on-error: true` or
  a step timeout below the job's, or exports outputs that differ from its
  `job-keys`; when a gated job's `if` lacks the form above, a check of another
  need's result, or has a top-level `||` after the prefix; and when a merge or
  release aggregate (`full-suite`, `test-status`, `executed-receipts`,
  `reused-full-suite`, `cheap-tier`) is gated.
