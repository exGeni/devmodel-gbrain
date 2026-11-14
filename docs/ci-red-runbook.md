# CI red runbook

What to do when a CI check on main is red, which issue tracks it, and what
closes it. The watchers are `scripts/nightly-issue.ts` (run by
`.github/workflows/nightly-watch.yml`) and `scripts/ci-health-report.ts` (run by
`.github/workflows/ci-health.yml`). Ownership and response times live in
[`docs/RELEASING.md`](RELEASING.md#master-red-issues).

## CI issue labels

| Label | Who opens it | What closes it | Owner |
|---|---|---|---|
| `master-red` | nightly-watch, on a red push-to-main run of Test (one issue, `Master red: Test`). An issue a person opens with this label and another title is never touched by the watcher. | nightly-watch, on a later green push run where every previously failing job ran and passed with complete evidence. A scheduled Test run whose commit contains the latest red commit also counts. Hand-opened issues close by hand. | The agent on release duty; first response within 1 hour (measured, not enforced). |
| `flake` | nightly-watch, when a `master-red` issue closes on green with no merged repair PR linked: one issue per previously failing test (at most 10 per close; the rest are listed in the close comment). | nightly-watch, after the repair PR linked to it merged and a later complete run passed that test's file and arm. | The agent on release duty; review by the `expires` date in its JSON block. |
| `nightly-red` | nightly-watch, on a red scheduled run of a watched workflow (Test, Semgrep, OSV-Scanner or CI health; one issue per workflow). | nightly-watch, on a later green scheduled run with complete evidence where every previously failing job executed. | The agent on release duty; respond within 24 hours. |
| `known-red` | nightly-watch adds it to a `nightly-red` issue whose only failures match `.github/nightly-known-red.tsv` rows. | Removed when the run no longer matches only known rows. Rows never apply to push runs. | The `TODOS.md` entry each row names. |
| `ci-health` | `scripts/ci-health-report.ts`, for the weekly report and for a follow-up when an explicit window missed a target ([CI health report](#ci-health-report)). | Nothing closes it; the next report refreshes it. | The agent on release duty. |

Every watcher issue body ends with a "Next step for the agent" block and a
fenced JSON block (`master-red:json`, `flake:json`, `nightly-watch:json`,
`ci-health:json`). Read the JSON instead of parsing the prose. A `master-red`
failure has one response: a repair PR whose body says `Fixes #<issue>`.

## Master-red reconciliation

- **Which runs count:** completed push-to-main runs of Test from this
  repository. Pull-request, fork, other-branch and other-workflow push runs
  are refused with a next step. Scheduled runs go to `nightly-red`.
- **Order:** every watch reads that workflow's push runs and evaluates each run
  above the high-water mark (`evaluated`: run number, then attempt) in the newest
  issue's JSON block. A dropped or superseded watch therefore loses nothing; a
  run that completes after a newer one was evaluated is ignored; a successful
  re-run is a newer attempt; a cancelled run changes nothing. The first watch
  for a workflow with no master-red issue yet opens only an incident that is
  still red.
- **Cancelled jobs are not run:** a job cancelled with its run (a newer push,
  a user, fail-fast) neither fails nor clears anything, in master-red and
  nightly-red alike. A run whose only failures are aggregators of cancelled
  jobs changes no state. A cancelled job whose annotation says it exceeded its
  timeout is a timed-out failure.
- **Missing or malformed JSON block:** the state is rebuilt from the actions API
  by folding from the last green run before the newest red one. The body says
  so. If the API cannot be read, the watch fails and writes nothing.
- **Suspect range:** the last green push SHA, the first red SHA, the compare link
  and the PRs merged in that range.
- **Not run since:** a failing job that has not run and passed since (renamed or
  skipped) keeps the issue open. Close it by hand with a comment naming the
  replacement, or wait for the next push run or the nightly scheduled run that
  runs it.
- **Reused full-suite runs:** a push run that reused an identical-tree full
  run (a succeeded `reused-full-suite` job) is judged by the run its
  `reuse.json` names, at the recorded attempt: its jobs and its complete
  `ci-manifest` clear or confirm failures as if the push had run them. An
  unreadable or mismatched record, a different tree, or a missing or
  incomplete source manifest is incomplete evidence and clears nothing.
- **Closed by hand:** a closed issue whose JSON block is still red ends that
  incident. The watch records later runs on it as green (its body says it was
  closed by hand) and never reopens it or opens a new issue for its failures;
  only a new red push run opens a new incident.
- **Serialization:** each watch queues on one group per repository, target
  workflow and track (`schedule` or `push`). Before the first write it re-reads
  the issue and re-plans when the issue moved. When two watches create the same
  issue at once, the newer one closes itself as a duplicate and re-plans.
- **Re-check:** `gh workflow run nightly-watch.yml -f run_id=<run id>`, with
  `-f dry_run=true` to preview.

## Flake issues

A `flake` issue records one intermittent failure: the file, test name, lane,
arm, platform, failing job, failure signature, first red run, owner and an
expiry date 14 days out. The stress gate can exempt only a failure whose file,
exact test name and failure signature match an unexpired record in an open
issue. The watcher writes those as `<!-- gbrain-stress-exemption -->` JSON
records (file, exact test name, backend `unit` or `e2e`, the gate's failure
signature, owner `agent on release duty`, expiry) in `master-red`, `flake` and
`nightly-red` bodies, one per failing test identity from the manifest. A
failure without an exact test name, or whose message carries a credential, gets
no record. Master-red and nightly-red records expire 14 days after the watcher
last saw the failure; flake records at the flake's expiry. Next step: run the
reproduce line (`bun run test:stress <file> --iterations 10`) until it fails,
find the race, and open a repair PR with `Fixes #<issue>`. Never widen a
timeout or weaken an assertion. When the signature names a runner, disk or
secret problem, ask the repository owner for that fix instead of a code PR.

## CI failure manifest

The `executed-receipts` job of `test.yml` runs `scripts/ci-manifest.ts` and
uploads the `ci-manifest` artifact: a versioned JSON file
(`gbrain-ci-manifest/v1`) bound to the workflow, event, SHA, run id and run
attempt. It lists every failing test identity (lane, file, test, arm) and, per
file, how many tests executed, failed and were skipped. It is `complete` only
when every lane's receipts are valid (no killed shard, truncated report, older
attempt, or lane that executed nothing without a declared skip row).

nightly-watch also reads the failing jobs' annotations. A manifest or annotation
that cannot be read, or a manifest from another SHA or attempt, is incomplete
evidence. It is reported, never read as zero failures, and never clears a
failure, closes an issue or grants an exemption. After a partial re-run
("re-run failed jobs") the manifest is incomplete. Wait for the next push run,
or re-run the whole workflow.

## CI health report

`bun scripts/ci-health-report.ts --since <date> --until <date> --dry-run` prints
the report for a window; outside Actions it needs `--repo <owner>/<name>` (or
`GITHUB_REPOSITORY`) and a `GH_TOKEN`.
`gh workflow run ci-health.yml -f since=<date> -f until=<date> -f dry_run=false`
writes it as `CI health (<since>..<until>)`. The weekly schedule writes
`CI health (week of <date>)`. The report covers:

- first-attempt pass rates for pull-request and push-to-main runs of
  `test.yml` (a re-run counts as a failed first attempt; cancelled, skipped,
  dispatch and scheduled runs are excluded);
- the exit criteria: push-to-main Test at least 95%, pull-request `test.yml` at
  least 90%. A window that cannot be read in full is indeterminate, which is
  never satisfied. In an explicit window, a missed target opens
  `CI health targets missed (...)` listing the top failing files;
- stress-gate failures and the failure classes (stress gate, test or check,
  infrastructure), plus cancellation and completion coverage;
- master-red time to first response: the first comment by the repository owner,
  a member, a collaborator or a `--responders` login (bots do not count), or
  the first linked PR from anyone;
- the nightly-watch residual: skipped watch runs, and watched-workflow runs on
  main outside the schedule and push allowlist, which still start a skipped
  watch run;
- the test files with the most failure annotations, the shard spread with the
  `bun run weights:mine` command that rebalances it, serial test files added in
  the window, and nightly-watch's own latest status.

The agent on release duty dispatches the report on day 8 after a wave merges,
with the window starting at the merge date, and records the numbers on the CI
health issue.
