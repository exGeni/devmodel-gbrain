# Stress runner and PR stress gate

`bun run test:stress` runs test files repeatedly on one checkout to prove they
are deterministic. The same runner drives two callers: local runs and the PR
stress gate (`stress-changed-tests`, inside `test-status`). The CI lane lives
in `.github/workflows/stress.yml`, called from `test.yml`.

| File | Role |
| --- | --- |
| `scripts/stress/run.ts` | The runner (`bun run test:stress`) |
| `scripts/stress/plan.ts` | Changed files, helper fan-in, profiles, shards, reproduce lines |
| `scripts/stress/gate.ts` | CI planner and reporter for the gate (`plan`, `report`) |
| `scripts/stress/iteration-weights.json` | Measured stress iterations, in milliseconds, per test file |

## Running it locally

```bash
bun run test:stress                                   # files changed versus origin/main, 10 iterations
bun run test:stress test/a.test.ts --iterations 20    # explicit files
bun run test:stress --base <ref> --head <ref>         # the files a commit range touched
bun run test:stress --dry-run                         # print the plan only
```

Without files the runner takes every `test/**/*.test.ts` added or modified
versus the merge base with `origin/main` (renames at the new path,
deletions skipped, working tree and untracked files included), plus direct
importers of changed `test/helpers/` files by the fan-in rule below.

Every run prints one line per iteration, setup and run time, and for each
failing file a reproduce command plus its context line:

```
FAIL [stress_failure]: test/a.test.ts failed in 2 iteration(s) (first: iteration 7, …)
    bun run test:stress test/a.test.ts --iterations 10 --first-iteration 7 --seed 412207
    # sha 1a2b3c4d5e6f, Bun 1.4.2, profile unit, iteration 7, seed 412213, artifact <run url>
```

The reproduce line is the exact command with the recorded values; credentials
never appear in it or in any log (`redact()`). The manifest
(`.context/test-stress/stress-manifest.json`) records SHA, Bun version,
profile, iteration, seed and every failure. Exit codes: 0 every file
passed, 1 a failure, 2 a usage or setup error, 130/143 cancelled.

## Execution profiles

| Profile | Files | Command and environment |
| --- | --- | --- |
| `unit` | `*.test.ts` | `bun test --timeout=60000`, `DATABASE_URL` unset |
| `serial` | `*.serial.test.ts` | `bun test --max-concurrency=1 --timeout=120000`, `DATABASE_URL` unset; files run one at a time |
| `slow` | `*.slow.test.ts` | `bun test --timeout=120000`, plus the workflow's pull-request values for the files named in `SPECIAL_FILES` in `plan.ts` |
| `e2e` | `test/e2e/*.test.ts` | `bash scripts/run-e2e.sh <file>` |

Paid-provider files (`*.live.test.ts`, `test/live/`,
`scripts/e2e-live-key-only.txt`) are listed as not stressed. A file whose
every test skips on this platform, skips without an unavailable secret, or
skips without a prerequisite its owning job in a workflow named in
`OWNING_WORKFLOWS` (`run.ts`) installs, is listed as not stressed with that
reason; any other run with zero executed tests fails.

## Receipts

Every iteration writes an executed-test receipt (`<out>/receipts/<file>--i<n>/`:
the receipt, its file list and Bun's JUnit report). The first iteration's
executed tests are the expected set: a later iteration that does not run one
of them is an unexpected skip and fails. Each iteration has a 15-minute wall
cap (`DEVMODEL_STRESS_ITERATION_TIMEOUT_MS`).
Seeds: iteration `n` exports `DEVMODEL_TEST_SEED=<base>+n-1`; the base is
`--seed` or a hash of the commit and file, and `--randomize` passes it to
Bun's test-order randomizer.

## PR stress gate

`stress-changed-tests` runs on every event and always concludes success or
failure: outside `pull_request` and `merge_group` it succeeds with "not a PR
event"; if the changed-file list cannot be computed it fails with the fetch
step. Otherwise every changed test file runs 10 times in shards.

- **Helper fan-in.** A changed helper with at most 25 direct test importers
  stresses all of them. Above 25 it stresses the helper's own tests and 10
  importers sampled deterministically from the head SHA, and lists the rest.
  Changed test files are never sampled or skipped.
- **Shards.** Work items (a file's iterations, split when ten exceed the
  budget) pack into the fewest shards whose measured estimates stay under 25
  minutes. A file's estimate is its measured stress iteration
  (`scripts/stress/iteration-weights.json`, mined from stress shard job logs
  with `bun scripts/stress/gate.ts mine-iterations <log>…`, which merges into
  the map), else its lane weight, else the lane's p75: a stress iteration can
  be slower than the file's lane run.
  There is no shard-count cap; `max-parallel: 12` keeps a large PR
  from starving other jobs. Shard jobs record results and exit 0 on test
  failures; the result job decides, so a planned iteration without a receipt
  fails the check as incomplete.
- **Failure.** The result names the file, the failing iteration and the
  reproduce line, and says a flaky touched file must be root-caused in this PR.
- **Exemptions.** A failure passes only when its file, test name and
  failure signature match an unexpired record in an open `master-red`, `flake`
  or `nightly-red` issue that predates the PR and was opened or labeled by the
  nightly-watch bot or a maintainer (write access). Records live in the issue
  body or in a comment by the bot or a maintainer. Any other failure in that
  file, or a new signature, still fails. A GitHub API failure grants nothing.
  There is no override label. A record may carry a `backend` key (older records
  do); it is ignored. Record format:

  ````
  <!-- devmodel-stress-exemption -->
  ```json
  {"file":"test/a.test.ts","test":"suite > case","signature":"<from the manifest>","owner":"@release-duty","expires":"2026-10-20"}
  ```
  ````

- **Dispatch.** `gh workflow run test.yml -f stress_files="test/a.test.ts test/b.test.ts"`
  or `-f stress_base=<ref> [-f stress_head=<ref>]` runs only the gate,
  labeled diagnostic. Inputs reach the planner through `env:` only; paths must
  match `^test/[\w./-]+\.test\.ts$` and refs must pass `git check-ref-format`
  or be 40-hex SHAs.
- **Summary.** Files stressed, not-stressed files with reasons, touched files
  with an open issue, runner-minutes, and p95 queue and completion time of the
  shard jobs.
