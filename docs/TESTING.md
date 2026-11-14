# Testing

How this repository is tested: which lanes exist, what each one proves, how CI runs them and the
guards that keep those claims honest. It describes current behavior only. The repository holds a
development harness (runners, guards, CI workflows, contributor tools) and no product code: there
is no `src/` tree, no database and no server. Per-file detail lives in the tests and scripts
themselves, and [docs/architecture/KEY_FILES.md](architecture/KEY_FILES.md) indexes them.

How to read what a runner or guard prints, and what to do next:
[AGENT_OPERATOR_v1](protocol/AGENT_OPERATOR_v1.md).

## Quick start

Prerequisites: Bun 1.4.4 or newer (`engines.bun`; CI pins 1.4.4), Git and bash. `python3` must be
on `PATH` once the E2E runner has a file to run (it validates Bun's JUnit reports with the
standard-library XML parser). `bun run ci:local` also needs `gitleaks`. No test needs a database or
a provider key.

```bash
bun install --frozen-lockfile && bun run test && bun run verify
```

`bun run test` is the parallel unit loop plus the serial pass. `bun run verify` is the guard battery
CI runs: the guards listed in `scripts/run-verify-parallel.sh` and the typecheck. `bun run test:full` runs verify, the unit loop,
the slow lane and the E2E lane, in that order, and exits with the status of the first step that
fails. `bun run ci:local` runs the CI lanes on this machine.

A single file: `bun test --timeout=60000 test/<name>.test.ts`. Bun ignores `bunfig.toml`'s
`timeout`, so every runner passes `--timeout` itself and `scripts/check-bun-test-timeout.sh` fails
on a bare `bun test` in a workflow or runner script. The runners export `AGENT=0`
(`scripts/lib/test-env.sh`): Bun switches to failure-only output when it detects an agent, and a
passing file with no header then reads as incomplete to the runners' file census.

Where a failure goes:

- A failing `bun run test` writes failure blocks to `.context/test-failures.log`, one line per shard
  to `.context/test-summary.txt` and each shard's whole output to `.context/test-shards/shard-N.log`
  ([Failure-first logging](#failure-first-logging)).
- A failing `bun run verify` keeps the log of every check in a directory and its last line names it.
- A red unit shard in CI lists its failing tests in the job's step summary, each with a
  `bun test … -t` reproduce command (`scripts/capture-test-log.ts`).
- Red CI on `main`: [CI red runbook](ci-red-runbook.md).

| File suffix or location | Lane | Command | Runs in CI |
|---|---|---|---|
| `*.test.ts` | unit (parallel shards) | `bun run test` | full runs: 4 weighted shards, two per job |
| `*.slow.test.ts` | slow (cold paths, long workloads) | `bun run test:slow` | full runs: inside the unit shards |
| `*.serial.test.ts` | serial (one Bun process per file, pooled; rows in `scripts/serial-files.tsv`) | `bun run test:serial` | full runs: 4 workers |
| `test/e2e/*.test.ts` | E2E (one file at a time) | `bun run test:e2e` | full runs: the `e2e` job |
| `tests/heavy/*.sh` | ops-shape shell scripts | `bun run test:heavy` | no workflow runs them |

A pull request runs only the cheap tier. The lanes above run on the full profile
([Event parity](#event-parity)).

## Test lanes

### Test command tiers

| Command | What it runs | When to use |
|---|---|---|
| `bun run test` | The parallel unit loop (`scripts/run-unit-parallel.sh`): weighted shards, each a sequence of one Bun process per file (`scripts/run-unit-shard.sh`), then the serial pass. It leaves out `*.slow.test.ts` and `test/e2e/` and does no typecheck. The shard count is the CPU count, at most 4 unless `--shards N` or `SHARDS=N` says otherwise (cap 8). Total concurrency is capped to available memory at `GBRAIN_TEST_MEM_PER_FILE_MB` (default 1536) per slot, shedding intra-shard width before shards. A shard that fails with the WebAssembly out-of-memory signature or is killed externally gets one serial rescue pass ([rescues](protocol/AGENT_OPERATOR_v1.md#rescues-and-warnings)). Knobs: `--shards N`, `--max-concurrency N`, `--dry-run`, `GBRAIN_TEST_NO_MEM_ADAPT=1`, `GBRAIN_TEST_NO_OOM_FALLBACK=1`, `GBRAIN_TEST_MAX_CONCURRENCY` (default 4), `GBRAIN_TEST_SHARD_TIMEOUT`, `GBRAIN_TEST_SHARD_KILL_AFTER`. | The inner edit loop. |
| `bun run verify` | The guard battery, fanned out by `scripts/run-verify-parallel.sh` through a bounded pool (`GBRAIN_VERIFY_MAX_PARALLEL`, default the CPU count). The heavy checks start first, then the self-timed `SOLO_CHECKS` run alone ([why](operations/verify-and-nightly-e2e.md#verify-solo-checks)). Each check is capped at `GBRAIN_VERIFY_TIMEOUT` seconds (default 120). The `CHECKS` array in that script is the one list of what runs; `--dry-list` prints it. CI's `verify` job runs it with the typecheck left out (`GBRAIN_VERIFY_SKIP_TYPECHECK=1`) because the `typecheck` job runs it. | Before pushing and before `/ship`. |
| `bun run test:full` | `verify`, then `scripts/run-unit-parallel.sh`, then `bun run test:slow`, then `bash scripts/run-e2e.sh`. A failing step stops the chain and its status is the command's status. | Before opening a pull request. |
| `bun run ci:local` | The CI lanes on this machine: gitleaks scans (`scripts/test-gitleaks-config.sh`, `scripts/scan-worktree-secrets.sh` and `gitleaks git` over `origin/main..HEAD`), a smoke test of `run-e2e.sh`'s arguments, `scripts/check-bun-test-timeout.sh`, `bun run verify`, the serial and slow lanes, then four unit shards, each followed by its E2E shard (`SHARD=N/4`), run in parallel with `xargs -P4`. The sharded lane sets `GBRAIN_TEST_TIMEOUT_MULTIPLIER` to 6 unless the caller set it. `--no-shard` runs unit and E2E without shards. Complete shard logs are in `.context/ci-local-shards/`. `ci:local:diff` (`--diff`) runs only gitleaks and `scripts/ci-doc-checks.sh` on a doc-only diff and the whole gate otherwise ([E2E selection](#e2e-selection)). It stops at once without `gitleaks`. | The full local gate before shipping. |
| `bun run test:slow` | `scripts/run-slow-tests.sh`: every `*.slow.test.ts` file in one Bun process, per-test timeout 120 s. File arguments replace discovery. With no slow file it prints that and exits 0. | After touching slow-path code. |
| `bun run test:serial` | `scripts/run-serial-tests.sh`: the `*.serial.test.ts` files, one Bun process per file, through a pool of `min(CPU count, 4)` processes (memory-adapted, `GBRAIN_SERIAL_POOL=N` overrides) that takes the heaviest file first from `scripts/serial-weights.json`. Per-test timeout 120 s; a pooled file is killed at 300 s (`GBRAIN_SERIAL_FILE_TIMEOUT`). The `EXCLUSIVE_FILES` of that script (machine-global state or timing, at most 4) run one at a time after the pool, on shard 1 only. `SHARD=N/M` partitions the pooled files. An externally killed file gets one sequential rescue run. It writes `.context/serial-timings.json` and `.context/serial-durations.txt`. | Debugging quarantined files; the CI serial workers. |
| `bun run test:e2e` | `bash scripts/run-e2e.sh` ([E2E lane](#e2e-lane)). | Before shipping; every full run. |
| `bun run test:stress` | Runs test files repeatedly to prove they are deterministic ([Stress gate](#stress-gate)). | Before pushing a new or changed test file. |
| `bun run test:heavy` | `scripts/run-heavy.sh`: every `*.sh` under `tests/heavy/` in turn, skipping files that start with `_`. Every script runs even after one fails; the exit status is the first failure's. With no script it prints that and exits 0. | Ops-shape scripts that do not belong in a Bun test. |
| `bun run test:profile` | Reads a captured `bun test` log on stdin and prints the N slowest tests (`-n N`, default 10): `bun test 2>&1 \| bun run test:profile`. | Finding slow tests to fix or rename to `*.slow.test.ts`. |
| `bun run regen:all` | Regenerates every generated artifact in `scripts/regen-all.ts` offline and keyless and lists what changed; a second run changes nothing. `--check` is read-only and runs in `verify` as `check:regen-all`. `--goldens` also regenerates offline contract goldens, a deliberate act each pull request justifies. | After a change a freshness check flags. |
| `bun run typecheck` | `tsc --noEmit --incremental` under an 8 GB heap. | Before pushing. |
| `bun run ci:select-e2e` | Prints which E2E files the working tree selects ([E2E selection](#e2e-selection)). | Checking a selection. |
| `bun run audit:contributors` | Re-proves discrimination for every commit in a range ([Contributor audit](#contributor-audit)). | Reviewing a batch of merged or open changes. |
| `bun run weights:mine` | Rewrites a shard weight map from CI run logs ([Keeping CI partitions balanced](#keeping-ci-partitions-balanced)). | After a test wave or sustained shard imbalance. |
| `bun run wave-security-scan` | A mechanical sweep of a commit range for shapes worth a human look (`scripts/wave-security-scan.sh`); exit 1 means look, not unsafe. | Reviewing outside contributions. |
| `scripts/ship-remote-tests.sh` | Pushes the branch, dispatches `test.yml` (`--workflow` and `--ref` change that) on GitHub's runners and waits with `gh run watch --exit-status`, so its exit status is the run's. Needs an authenticated `gh`. | Offloading the suite from a saturated machine. |

`verify` has one execution list, the `CHECKS` array in `scripts/run-verify-parallel.sh`: a second,
hand-synced list of guards would drift from it and leave checks that never run. The guard registry
is `scripts/guards-manifest.tsv` ([Guard registry and
self-test](#guard-registry-and-self-test)).

`bun run typecheck` ([heap ceiling](operations/verify-and-nightly-e2e.md#typecheck-heap)) keeps
TypeScript's incremental state in `node_modules/.cache/gbrain-typecheck.tsbuildinfo`. Every
invocation still runs the compiler; source, configuration and dependency changes invalidate the
affected analysis, and cached diagnostics stay failures. CI's `typecheck` job restores that file and
saves it after the check, also when the check finds type errors; it saves nothing when `tsc` aborted
or timed out (`scripts/ci-typecheck.sh`).

### File taxonomy

- `*.test.ts`: the parallel unit loop.
- `*.slow.test.ts`: `bun run test:slow` only (intentional cold-path or long workloads that would
  dominate the fast loop). The local fast loop leaves them out; CI's unit shards include them.
- `*.serial.test.ts`: `bun run test:serial` after the parallel pass, one Bun process per file
  (`--max-concurrency=1` in a shared process still leaks `mock.module` through the module registry),
  with those processes pooled. Each file is listed with its class and reason in
  `scripts/serial-files.tsv` (see [When to quarantine](#when-to-quarantine-instead-of-fix)).
  Machine-global or timing-bound files go on the sequential `EXCLUSIVE_FILES` lane, at most four.
  Do not put parallelism back on a serial file without fixing the contention root cause.
- `test/e2e/*.test.ts`: the E2E lane ([E2E lane](#e2e-lane)).
- `tests/heavy/*.sh`: ops-shape shell scripts that cost minutes, run by `bun run test:heavy`. Files
  prefixed `_` are helpers the runner skips.

The suffixes say where a test runs. A second, independent axis is intent:

- **Behavioral** tests execute code and assert on behavior. This is the default.
- **Structural** suites read repository source or document text and assert on its shape: wiring
  guards, drift pins. They are real invariants but execute no product path, so they add to the test
  count without adding line coverage. The inventory is `scripts/structural-suites.tsv`, generated by
  `scripts/classify-tests.ts` from content-based detectors (repo-anchored `readFileSync` and
  `Bun.file` readers, scanners that exec `scripts/check-*.sh`) and kept fresh by
  `bun run check:structural-manifest` in `verify`. Regenerate with
  `bun scripts/classify-tests.ts`. The inventory is approximate by design: fix a misclassification in
  the classifier's detectors, never by editing the TSV. CI's coverage report prints behavioral and
  structural counts side by side.

### Failure-first logging

`scripts/run-unit-parallel.sh` (`bun run test`) writes, all cleared at the start of a run:

| File | Content |
|---|---|
| `.context/test-shards/shard-N.log` | Shard N's whole output, with `shard-N.exit`, `.start` and `.end` beside it. The serial pass and the rescue pass write `serial.log` and `oom-rescue.log` there too. |
| `.context/test-failures.log` | Failure blocks, described below. |
| `.context/test-summary.txt` | One line per shard: `shard N/M: pass=X fail=Y skip=Z rc=W`. A serial pass adds `serial: pass=N rc=0` or `serial: rc=R fail=N`. A shard that did not run normally has its own line: `EXIT-HANG ... warn-pass`, `WEDGED after Ns`, `KILLED externally ...` or `oom-rescue: ...`. |
| `.context/test-receipts/` | [Executed-test receipts](#executed-test-receipts), unless `GBRAIN_TEST_RECEIPT_DIR` names another directory. |

Without a writable `.context/` the log, summary and shard directory go to `/tmp` instead
(`gbrain-test-failures.log`, `gbrain-test-summary.txt`, `gbrain-test-shards-<pid>`). `.context/` is
gitignored.

A failure block starts at a `(fail)` or `✗` line, is prefixed
`--- shard N: ` (`--- shard serial: ` for the serial pass), and runs to the next pass or skip marker
or blank line. Bun prints a test's error and diff above its `(fail)` line, so the block holds the
start of the next failure, not the diff of its own. Read the diff in the shard log. Two other
blocks exist:

- `--- shard N: rc=R, no (fail) markers — full log follows ---`, then the shard's whole log: the
  shard exited non-zero without a `(fail)` line, so there was nothing to cut out.
- `--- shard N: WEDGED after Ns ---` and the last 50 lines of the shard log: the shard hit its
  wall-clock cap.

When any failure remains, the wrapper prints a banner on stderr: a rule line, `❌ N TEST FAILURES —
full details:`, the absolute path of the failure log, the last 30 lines of that log and a closing
`[unit-parallel] elapsed=…s | pass=… fail=… skip=…` line. The banner is on stderr so a `| head` on
stdout does not hide it. While shards run, a `[heartbeat]` line per shard appears every 10 seconds.
The exit status is 0 or 1 (2 for a usage error).

A shard that outlives `GBRAIN_TEST_SHARD_TIMEOUT` (default 3000 s; `GBRAIN_TEST_SHARD_KILL_AFTER`
is the grace after TERM, default 30 s) is classified as one of two things:

- **EXIT-HANG, warn-pass.** Its log had been silent for 300 s or more, shows no `(fail)` marker and
  every file assigned to the shard had started: the shard finished its work, leaked a handle and
  never exited. The wrapper prints a `⚠️ shard N/M: EXIT-HANG ... Treating as pass-with-warning`
  banner and writes the `warn-pass` summary line. Its pass count is low, because Bun never printed
  its final summary. Bun's per-test `--timeout` turns a hung test into a printed `(fail)`, so this
  classification cannot hide a hung test.
- **WEDGED, hard failure.** Anything else. The run is red.

An EXIT-HANG line in the summary is not a test failure, so do not bisect it. A WEDGED line is one.

CI's unit shards do not use this wrapper. `scripts/test-shard.sh` runs Bun through `xargs`, which
turns any failing test into exit status 123, so read 123 as "tests failed", not as a crash.
`scripts/test-shard-pack.sh` runs the two shards of a job at once, prints each shard's console output
as the shard ends and exits with the first failing shard's status. For each failing shard it prints an
`::error` line that names the reproduce command, `bash scripts/test-shard.sh <shard> <total>`.

### CI vs local: intentionally divergent file sets

- **CI** (`.github/workflows/test.yml`) runs `scripts/test-shard.sh` in four shards, two per job
  (`scripts/test-shard-pack.sh`), split by weight-aware bin-packing (`scripts/sharding.ts`;
  unweighted files get the p75 weight). A CI shard includes `*.slow.test.ts` files, leaves out
  `*.serial.test.ts` and `test/e2e/`, runs its files in the planned order and prints its predicted
  weight. Serial files run in four `serial-tests` workers through
  `bun run test:serial`. `verify`, `typecheck`, `gitleaks`, `dependency-audit` and the stress gate
  have their own jobs, and `test-status` aggregates them. Only a push to `main` reuses results: those
  of a passed full run of the exact tree (`scripts/ci-reuse.ts`). CI is the ground truth for "did
  everything pass".
- **The local fast loop** (`scripts/run-unit-shard.sh`, called by the parallel wrapper) uses the same
  partitioner and leaves out `*.slow.test.ts` and `*.serial.test.ts`. Each shard runs its complete
  ordered selection with a fresh Bun process per file, runs later files after a failure, and fails
  the shard when a file's summary or header is missing. Local trades coverage for inner-loop speed;
  CI catches what local skips.

`test/scripts/run-unit-shard.test.ts` pins what the local loop includes.
`test/scripts/run-unit-parallel.test.ts` pins memory-adaptive concurrency, the rescue pass and
interrupt teardown (Ctrl-C kills every descendant).

### E2E lane

`scripts/run-e2e.sh` (`bun run test:e2e`) runs `test/e2e/*.test.ts` one file at a time, because E2E
files share external state and files running in parallel against it race. It reports every failing
file and then exits non-zero. The lane has no file yet. A lane with nothing to run exits 0 and says
so (`No files for shard (unsharded); exiting clean.`), and an empty lane is not a passing lane: say it
ran nothing.

What the runner does around each file:

- `HOME` and `GBRAIN_HOME` point at a fresh temporary directory per file, removed after the file
  exits, also after a failure and in the runner's exit trap. A process still running with that
  `HOME` is killed and named; a `HOME` that cannot be removed fails that file by name. After the
  run the runner compares the operator's real config file before and after and exits 2 when it
  changed (an isolation breach).
- Every `CONDUCTOR_`, `MCP_`, `OPENCLAW_`, `HERMES_`, `GROK_`, `OPENCODE_` and `GBRAIN_` variable is
  dropped, except `GBRAIN_HOME`, `GBRAIN_TEST_KEEP_PROVIDER_KEYS`, `GBRAIN_CI_DISABLE_TEST_ENV_FILE`,
  `GBRAIN_TEST_WAIT_MULTIPLIER` and `GBRAIN_E2E_FILE_TIMEOUT`. `DATABASE_URL` and
  `GBRAIN_DATABASE_URL` are unset. Provider keys are kept (`GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`),
  because an E2E file is where a real key is deliberate.
- Each file runs under a hard outer timeout, 180 s by default (`GBRAIN_E2E_FILE_TIMEOUT` or
  `E2E_FILE_TIMEOUT_SECS`), because a call that blocks the event loop outlives Bun's timer-based
  `--timeout`. Bun runs with `--timeout=60000` and a JUnit reporter.
- A file counts as passed only when `python3` finds a complete native Bun report for exactly that
  file whose counts match the console totals.
- File arguments replace the glob. Files named in `scripts/e2e-live-key-only.txt` are left out of
  the default list and run by name. `SHARD=N/M` takes a weighted share from
  `scripts/e2e-weights.json`. `--dry-run-list` prints the resolved list.
- Exit status: 0 every file passed, 1 a file failed, 2 a usage error or an isolation breach.

`scripts/ci-local-e2e-smoke.sh` (run by `ci:local`) checks the argument and shard handling: the four
shards together must cover the whole default list.

### Shell dispatch and Windows

`test`, `verify`, `ci:local` and `test:e2e` hand off to shell scripts under `scripts/`. Every
`check:*` entry in `package.json` that runs a shell script invokes it as `bash scripts/<name>.sh`
instead of relying on the shebang, because Bun on Windows cannot exec a `.sh` directly. Add a new
shell-script check with the same prefix. The `scripts/*.ts` entries run under Bun and take no
prefix.

The scripts must also be on disk with Unix line endings. A strict bash (WSL, Linux CI, macOS)
rejects CRLF and dies on the script's first meaningful line, while the Cygwin bash that ships with
Git for Windows tolerates it, so a green local run is not evidence that a script is CRLF-clean. The
root `.gitattributes` pins `*.sh`, `*.md` and `*.tsv` to `eol=lf`, which overrides the
`core.autocrlf=true` default of Git for Windows. A working copy cloned before those pins needs a
one-time `git rm --cached -r . -q && git reset --hard`; the Windows section of
[CONTRIBUTING.md](../CONTRIBUTING.md) has the detail.

## CI

### Event parity

Test (`.github/workflows/test.yml`) runs on a push to `main`, a pull request, the merge queue
(`merge_group`), a nightly schedule and a manual dispatch. A pull request runs the cheap tier:
`dynamic-ci`, `changes`, `gitleaks`, `dependency-audit`, `verify`, `typecheck` and
`stress-changed-tests`. The `cheap-tier (full suite not run)` job aggregates them
(`scripts/ci-cheap-tier.sh`) and says in its name that the full suite did not run. Every other event
runs those jobs and the full profile: the unit shards (`test`), `serial-tests`, `e2e`,
`coverage-report` and the aggregates `test-status` and `full-suite`. A push to `main` whose tree equals the tree of a
passed full run skips its full lanes (`scripts/ci-reuse.ts`;
[master-push reuse](ci-event-parity.md#master-push-reuse)).

Merge needs the `full-suite` check on the exact head. A maintainer adds the `full-ci` label, and
`full-ci.yml` dispatches Test on the head branch, again on every later push while the label stays
([full CI for pull requests](ci-event-parity.md#full-ci-on-pull-requests)).

The `full-suite` job records the tested tree as the `full-suite-tree` artifact
(`scripts/ci-full-suite-tree.sh`). `.gstack/pregate.json` names that job and artifact as the run
profile `test`.

Every narrower pull-request behavior is a named exception whose comment, beside the condition,
says `Event parity` and names the run that covers it. `test/scripts/ci-pr-scope.test.ts` fails on
an event-conditional job or block in `test.yml`, `stress.yml` or `semgrep.yml` without that comment.
The other workflows, each with its own trigger and scope: `osv-scanner.yml` (pull requests only
when `bun.lock` or `package.json` changes, and weekly), `semgrep.yml` (a pull-request diff scan and
a weekly full-tree scan), `actionlint.yml` (when a workflow file changes), `nightly-watch.yml`,
`ci-health.yml` (weekly), `fix-wave-gate.yml`, `fix-wave-closeout.yml` and `full-ci.yml`. Table,
audit rule and cost: [docs/ci-event-parity.md](ci-event-parity.md).

`gitleaks` scans the commit range each event introduces, and `test-status` fails when a required job
fails, is cancelled or is skipped. Merge-queue entry is inert until the queue is enabled
([merge queue](RELEASING.md#merge-queue)).

### Executed-test receipts

A green job proves only that nothing failed; receipts prove which tests ran. With
`GBRAIN_TEST_RECEIPT_DIR` set, every Bun invocation a runner makes writes one receipt: the
`<id>.receipt` file (key=value lines: lane, kind `primary|rerun|rescue`, shard, commit, run id and
attempt, and `exit=` once the invocation returns), `<id>.files` (the assigned files) and
`<id>.junit.xml` (Bun's native JUnit report). The writers are `scripts/test-shard.sh`,
`scripts/run-unit-shard.sh` (per file), the parallel wrapper's rescue pass,
`scripts/run-serial-tests.sh` (pooled runs and rescues), `scripts/run-slow-tests.sh`,
`scripts/run-e2e.sh`, `scripts/run-verify-parallel.sh` and `scripts/run-with-receipt.sh <lane> <tag>
-- bun test …` for a bare `bun test` CI step. `GBRAIN_TEST_RECEIPT_LANE` overrides the runner's lane
name. `scripts/lib/test-env.sh` (`receipts_init`) reads both variables and unsets them, so tests and
nested runners never inherit them. `bun run test` writes receipts to `.context/test-receipts/` by
default.

`bun run verify` records each check as pass, fail, timeout or skip in `<log dir>/outcomes.tsv` and in
a JUnit receipt (one testcase per check). A check whose subject is absent prints
`GBRAIN_CHECK_SKIPPED: <reason>` and exits 0; the recorder counts it as a skip, never a pass.

`scripts/ci-executed-counts.ts` is the ledger. It accounts for every executed test by identity,
(lane, file, test name, arm); repeated names inside a file are numbered by order
(`name [#2]`). One side prints the per-lane executed, skipped and failed table and every
completeness problem; two sides also list every base identity that no longer executes in head:

```bash
bun scripts/ci-executed-counts.ts --head-run <test-run>
bun scripts/ci-executed-counts.ts --base-run <run> --head-run <run> --summary pr-table.md --json ledger.json
bun scripts/ci-executed-counts.ts --base-dir <receipts> --head-dir <receipts>
```

A comparison is `incomplete`, and fails, when an assigned file has no valid JUnit report from any
attempt, a report is truncated or comes from an earlier run attempt, a shard is missing, a lane
executed zero tests, or a base artifact is missing from head. A later rescue or rerun supersedes an
earlier attempt for the files it re-ran. A dropped identity passes only when
`docs/test-audit/2026-10-04/expected-deltas.tsv` declares it as `retire` (with a
[Retiring a test](#retiring-a-test) evidence pointer), `move` (new lane, file or test name), `skip`
or `job`; otherwise the tool prints the exact row to add. New tests need no row.
`--fail-on-additions` compares two baseline runs for stability, `--report-only` always exits 0 and
`--missing-keys K1,K2` counts skipped tests in files that read those keys. Exit status: 0 pass,
1 a drop or an incomplete lane, 2 usage or download error.

`scripts/ci-manifest.ts` turns the receipts of a run into one versioned `ci-manifest.json` bound to
the workflow, event, commit, run id and attempt: each failing test with its JUnit message, each
file's executed, failed and skipped counts, and a `complete` flag that is false when any lane is
incomplete. An incomplete manifest still lists the failures it saw but never counts as proof that a
file passed ([CI failure manifest](ci-red-runbook.md#ci-failure-manifest)).

The ledger and the manifest prove completeness, not outcomes. A ledger that exits 0 or a manifest
with `complete: true` can list failing tests; the job's exit status is the outcome.

`test.yml` uploads `receipts-<lane>` artifacts from the `verify`, unit, serial and `e2e` jobs. Its
`executed-receipts` job writes the ledger to the step summary in report-only mode, uploads it as
`executed-identities` and builds and uploads the manifest as `ci-manifest`.

### Coverage responsibilities before consolidation

Assign ownership to an **assertion and its execution boundary**, not to a test filename or a shared
helper. Record the contract, runtime version, operating system, process and storage boundary,
workload size and required cadence. Shared scenario code is not duplicate coverage when the
boundaries differ.

| Responsibility | Execution owner | What it does not establish |
|---|---|---|
| Keyless behavior and shared contracts | The unit shards in `test.yml` on a full run; `bun run test` locally | Anything on a pull request's cheap tier, which runs no unit shard |
| Structural guards and generated-artifact freshness | `verify` and `typecheck` jobs, every event | Behavior of the code they read |
| State that cannot share a process | The serial lane and its four workers on a full run | A pass on a pull request: the cheap tier runs no serial worker |
| Real-process end-to-end behavior | The `e2e` job (`scripts/run-e2e.sh`) | A lane with no file ran nothing |
| Flakiness of a touched test file | The stress gate, every pull request | A test no change touched |
| Secrets, advisories, static findings | `gitleaks` and `dependency-audit` in `test.yml`, `osv-scanner.yml`, `semgrep.yml` | Code no scanner rule describes |
| Line coverage accounting | The `coverage-report` job over the unit and serial lanes | Subprocess coverage, or that every discovered case executed |

Before removing repeated work, identify the surviving owner for the same contract and every relevant
boundary, prove that owner actually executes ([receipts](#executed-test-receipts), not skip output)
and retain its cadence, failure gate and coverage artifacts.

Name the profile when reporting "all tests". The local fast loop (`bun run test`), `bun run
test:full`, `bun run ci:local`, a pull request's cheap tier and a full CI run are not interchangeable
supersets. Report matched executed timings separately from dry-run partition estimates, including
setup, queueing and retries, and never count skip-only output as coverage.

### Stress gate

`stress-changed-tests` (in `test-status`) runs each touched test file 10 times, in shards, on a pull
request or merge-queue entry: every added or modified test file, plus the direct importers of a
changed `test/helpers/` file. On any other event it succeeds with "not a PR event". A failure passes
only when its file, test name and signature match an unexpired record in an open `master-red`,
`flake` or `nightly-red` issue. The local twin is `bun run test:stress`. A dispatch with
`stress_files` or `stress_base` (and `stress_head`) runs only the gate, as a diagnostic:
`gh workflow run test.yml -f stress_files="test/x.test.ts test/y.test.ts"`. Details, the fan-in rule
and exit codes: [scripts/stress/README.md](../scripts/stress/README.md).

### Keeping CI partitions balanced

Required CI runs four weighted unit shards (two per job), four serial workers with bounded per-file
pools and one unsharded `e2e` job. Shards are packed longest-first by `scripts/sharding.ts` from the
committed weight maps: `scripts/test-weights.json` (unit, milliseconds), `scripts/serial-weights.json`
(serial, seconds) and `scripts/e2e-weights.json` (E2E, milliseconds), each with a
`*-weights.metadata.json` beside it. A file with no weight is packed at the lane's p75 weight, so a
new test file works at once. `test.yml` runs unit shards as `bash scripts/test-shard-pack.sh 4 <a>
<b>`; shard `s` writes its coverage, receipts and timing log under `$GBRAIN_SHARD_PACK_DIR/<s>/`,
and `test/scripts/ci-gates.test.ts` pins the matrix, the shard step and the coverage manifest to
`UNIT_SHARDS` and `UNIT_SHARDS_PER_JOB` in `scripts/sharding.ts`.

Twice a unit shard's mined weight, plus a minute of setup and a minute of margin, must fit the job's
22 minutes (`UNIT_SHARD_BUDGET_MS`, 600 s; `test/scripts/unit-shard-budget.test.ts`). When a shard is
over, re-mine the weights, then raise `UNIT_SHARDS` together with the workflow matrix.

Refresh the maps after a large test wave or when the longest shard repeatedly exceeds the mean shard
by 25%. `bun run check:weight-coverage` (in `verify`) fails on an entry naming a missing file. When a
lane's unweighted share passes 5% (unit) or 10% (serial, E2E) it warns on pull requests, pushes and
local runs, fails the scheduled run, and prints the lane's miner command:

```bash
bun run weights:mine --lane unit --run <run> --run <run> ...
bun run weights:mine --lane serial --run <run> --run <run> ...
bun run weights:mine --lane e2e --run <successful-run>
```

The miner (`scripts/mine-shard-weights.ts`) takes the timestamped GitHub-format log of a successful
run through `--run`, or a log through `--from-file` or stdin, and writes the map (`--out` to inspect
it first). Unit timing reads the `timings-unit-N` artifacts and closes each file at the Bun summary;
serial timing uses the runner's per-file durations, never the timestamps of buffered output; E2E
uses each file's Bun summary from the `e2e` job. Repeated `--run` (5 to 10 runs) takes each file's
median, because one run carries its runner's speed. Only a complete GitHub run of a lane replaces
its whole map: unit and serial from any number of runs, and E2E from exactly one run, checked
against the source checkout's E2E file list. A log read from a file or stdin merges into the
existing map instead. Captured artifacts need their final successful completion marker, and
incomplete or failed input leaves the map intact. Files git no longer tracks drop out.

CI keeps the timestamped unit logs, the serial timing records and the receipts for 14 days. Compare
cold and warm caches separately, and treat partition estimates as projections until matched
workflow runs confirm them.

### E2E selection

`bun run ci:select-e2e` (`scripts/select-e2e.ts`) classifies the changed files, taken from git as the
working-tree diff against `origin/main` plus untracked files:

| Classification | Meaning | Selects |
|---|---|---|
| `EMPTY` | no changed file | every `test/e2e/*.test.ts` file |
| `DOC_ONLY` | every path is `LICENSE`, `VERSION`, a root `*.md` file or under `docs/` | nothing (the only empty selection) |
| `SRC` | anything else, `.github/**/*.md` included | every `test/e2e/*.test.ts` file |

There is no per-file narrowing: a change that is not doc-only selects every E2E file. A git failure
exits 2; `--classify-only` prints the classification. CI does not select: the `e2e` job runs
`scripts/run-e2e.sh` on every full run.

Locally, `ci:local:diff` runs gitleaks and `scripts/ci-doc-checks.sh` on a doc-only diff and the
full gate otherwise. The doc checks are `check:doc-history`, `check:docs-repo-paths`,
`check:privacy` and `check:fixture-privacy`: a doc-only change can still break a size cap, a
documented path or a privacy rule. The coverage diff gate passes a doc-only diff by the same
classification.

### Coverage lanes and gates

Line coverage is opt-in through `COVERAGE_DIR`. When it is set, the shell lanes
(`scripts/test-shard.sh`, `scripts/run-serial-tests.sh`, `scripts/run-e2e.sh`) pass
`--coverage --coverage-reporter=lcov` to Bun; when unset, the command line is the one of a run with
no coverage. Every Bun process gets its own coverage directory (`$COVERAGE_DIR/shard`,
`serial-<n>`, `e2e-<n>`) because a reused directory silently overwrites `lcov.info`, and the shard
runner pins `xargs` to one batch so an argument overflow fails loudly. `run-e2e.sh` normalizes
`COVERAGE_DIR` to an absolute path before it moves `HOME` and refuses a directory that already
exists. A green lane writes `$COVERAGE_DIR/lane-manifest.json` (`{lane, sha, lcovCount, complete}`);
a red run writes none, which merging treats as an incomplete lane. The E2E lane also writes
`executed-files.txt`, also on a red run. Coverage lanes set `GBRAIN_TEST_WAIT_MULTIPLIER` to 2 unless
the caller chose a value ([helpers](#speed--environment-helpers-testhelpers)).

**The corpus.** `prCorpus` is the eight coverage-collecting lanes in `test.yml`: four unit shards
and four serial partitions. The merge, render and gate tools also accept the name `fullCorpus`; no
workflow here produces it.

**Merge** (`scripts/merge-lcov.ts`) sums DA hits per file and line across the input directories,
normalizes paths, and emits a merged lcov plus a summary JSON: totals, per-directory and per-file
percentages, the `lineHits` map the diff gate reads and the list of source files no test loaded.
The totals count files under `src/` only. `--manifest-expect` pins the lane set and `--sha` the
commit. A missing or incomplete manifest, unparseable lcov, a duplicate lane identity or a `shard`
lane with `lcovCount != 1` marks the summary `degraded: true`; the merge still exits 0, and both
gates print `WOULD PASS` or `WOULD FAIL` instead of enforcing.

**Diff gate** (`scripts/coverage-diff-gate.ts`) requires at least 80% of the added or changed
executable lines of `git diff origin/main...HEAD` under `src/` (minus tests, generated files and
`.d.ts`) to be covered, and no changed gate-scoped file to be absent from the coverage data. An
empty or doc-only diff passes. Escape hatches: a commit body with `[coverage-exempt: reason]` (a loud
warning), and `scripts/coverage-gate-exemptions.txt`, read from `origin/main` so a pull request
cannot exempt itself, which only shrinks. Exit 0 is pass or report-only, 1 a failure while
`COVERAGE_GATE_ENFORCE=1`, 2 an infrastructure error.

**Baseline gate** (`scripts/coverage-baseline-gate.ts`) reads `scripts/coverage-baseline.json` from
`origin/main` and compares like for like by corpus: a global drop over 0.5 points, a per-directory
drop over 1.0 point or more never-loaded files fails. A `null` corpus section is an ungated first
landing, and `provisional: true` keeps the gate report-only; the committed baseline is provisional
with both sections unseeded. `scripts/update-coverage-baseline.ts --summary <json> --corpus <c>
[--promote]` writes it, and `--promote` flips `provisional` to `false`.

**CI wiring.** The `coverage-report` job runs on a full profile: it downloads the `coverage-*`
artifacts, merges them with `COVERAGE_CORPUS=prCorpus`, renders `scripts/render-coverage-summary.ts`
(with behavioral and structural counts from `scripts/structural-suites.tsv`) to the step summary and
runs both gates with `COVERAGE_GATE_ENFORCE: '0'`. It is advisory and not in `test-status`'s needs.

**Bun caveats.** Bun emits line records only, so function coverage is informational. There is no
subprocess coverage: code reached only through a spawned process is undercounted. A source file no
test imports has no lcov record; the summary lists those as a count and a sorted list, never as a
percentage.

**Local smoke** (one shard of four; it checks the plumbing, not the number):

```bash
COVERAGE_DIR=$PWD/.coverage bash scripts/test-shard.sh 1 4 \
  && bun scripts/merge-lcov.ts --out-lcov .coverage/merged.lcov --out-json .coverage/summary.json .coverage \
  && bun scripts/render-coverage-summary.ts --summary .coverage/summary.json --structural scripts/structural-suites.tsv
```

## Writing and retiring tests

### Authoring gate

Before adding a test, answer four questions in the pull request description or the test header:

1. What observable behavior or contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch it?
4. Does it need a production seam that no production caller needs?

A regression test must fail when its fix is reverted; prove it with
`bash scripts/check-test-discriminates.sh <test-file> <source-file>...`. It puts the named source
files back to their pre-fix state (`DISCRIMINATE_BASE=<ref>` names the pre-fix ref of a committed
fix), runs the test, restores the files and exits 0 when the test fails without the fix, 1 when it
still passes, 3 when the run ends non-zero with no failing test (a crash, not a discrimination)
and 2 on a usage error. If question 1 has no answer, or the answer to question 3 names an existing
owner at the same boundary, do not add the test.

Good: `test/scripts/check-weight-coverage.test.ts` builds a fixture tree whose weight map names a
deleted file, runs the guard and asserts exit 1 with the file named in the output. It protects a
contract someone relies on, fails if the rule stops firing and needs no seam.

Bad: a test that reads `scripts/check-weight-coverage.ts` and asserts it contains `existsSync`. It
passes when the guard is broken in a way that keeps the token, fails on a harmless rename and
duplicates the behavioral test above.

### Contributor audit

`bun run audit:contributors <base>..<head> [--prs <manifest>] [--json]`
(`scripts/contributor-audit.ts`) re-proves discrimination for every first-parent commit in the range
and for each pull request head in `--prs`, trial-merged onto `<head>`. In an isolated worktree of
`<head>` it runs the change's test files, one Bun process per file as the unit loop does (a green
baseline is required), reverses only that change's product hunks (the merge's diff of its non-test, non-doc files, applied
in reverse; tests and docs stay), reruns, restores, checks the tree is identical and re-verifies
green. Hunks that no longer apply at `<head>` are audited at the merge commit itself.

Results use the vocabulary of `scripts/check-test-discriminates.sh` (`discriminates`,
`does_not_discriminate`, `vacuous_failure`) plus `setup_failed`, `conflict` and `not_audited`, each
with a reason. Human verdicts (`accept`, `rework`, `reject`, `not_yet_proven`) live in a separate
`--verdicts` file and print in their own column. The audit also runs `wave-security-scan` over the
range and each pull request, from the trusted checkout; `--skip-security` opts out of it and of the
gitleaks and `python3` preflight.

Preflight checks Bun against `engines.bun`, the refs, and (without `--skip-security`) `gitleaks` and
`python3`. Pull request heads are pinned into `<run-dir>/prs.pinned.json`. State and per-step logs
live in the run directory (default `<git-dir>/contributor-audit/<base>-<head>/`), so `--resume`
skips finished cases and refuses when refs or pins differ. `--step-timeout` (default 900 s) bounds
each step; `--keep-worktrees` leaves the isolated checkouts on disk. Exit status: 0 clean, 1 needs a
human look, 2 usage or preflight refusal (an agent-contract error envelope), 130 interrupted.

Untrusted code (`bun install --ignore-scripts`, the tests) runs under `env -i` with an allowlist: a
temporary `HOME` and `GBRAIN_HOME`, no credential files, `DATABASE_URL` and `GBRAIN_DATABASE_URL`
empty, and `bun --no-env-file`. First run: `bun scripts/contributor-audit-fixture.ts <dir>` builds
an offline range covering each result. Tests: `test/scripts/contributor-audit.test.ts`.

### Retiring a test

Delete or merge a test only with evidence, recorded in the pull request body:

1. Name the contract the test claims to protect and classify the evidence case below.
2. Probe it: make a behavior-breaking edit to the production code (or, for a vacuous assertion, show
   that such an edit passes), run the test and the surviving owner, then revert. Behavior-preserving
   edits that fail the test are useful extra evidence of implementation coupling.
3. Confirm the surviving owner executes ([executed-test receipts](#executed-test-receipts), not skip
   output) at the same or a more frequent cadence, with an equal or stronger failure gate, per
   [Coverage responsibilities before consolidation](#coverage-responsibilities-before-consolidation).
4. Remove the deleted file's entries from `scripts/test-weights.json`, `scripts/serial-weights.json`
   and `scripts/e2e-weights.json` (`bun run check:weight-coverage` fails on a leftover), grep
   `scripts/`, `docs/` and `.github/` for the path (`bun run check:docs-repo-paths` fails on a
   documented path that no longer exists), and regenerate `scripts/structural-suites.tsv`
   (`bun scripts/classify-tests.ts`). A test the ledger would report as dropped also needs its row in
   `docs/test-audit/2026-10-04/expected-deltas.tsv`.

Evidence cases:

- **Retained contract:** the contract still matters. Evidence is a surviving owner at the same
  boundary plus an executed mutation that fails it.
- **Intentionally abandoned contract:** the behavior is being removed or was never shipped. Evidence
  is the approved disposition plus reachability proof (no production caller) and a check that no
  user-facing promise (docs, `--help`, CHANGELOG) still describes it.
- **Vacuous assertion:** the test asserts nothing about behavior (a constant compared to itself, a
  copied function, a `typeof` probe that typecheck already enforces). Evidence is a demonstration
  that a behavior-breaking edit leaves it passing, or that it imports no product code.

Evidence template:

| Deleted test | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|
| `test/x.test.ts` › "name" | `scripts/y.ts`: what changed | deleted test passes (blind) | `test/z.test.ts` › "name" | fails (N of M) |

### Source reads in tests

`test/test-reads-source-smell.test.ts` finds test code that reads `src/` text: `readFileSync`,
`readFile` (including `fs.promises.readFile`) and `Bun.file` calls whose arguments name a `src/`
literal, a `'src'` path segment or a constant holding such a path. Each read site needs a tagged
marker on its line or within the three lines above:

```ts
// test-reads-source-ok[structural]: <why a source read is the right tool>
```

The category is one of `prompt-byte`, `trust-boundary`, `generated-artifact`, `structural` or
`raw-bytes`, and every marker must carry one. Files that predate the rule are ratcheted by their
exact count of unjustified read sites (the `GRANDFATHERED` map in that test), so a new untagged read
in such a file fails and a count that drops must be lowered. The map is empty. The ratchet counts
read sites only: a new assertion over an existing source binding is not detected and remains the
[authoring gate](#authoring-gate)'s job. Rerun with `bun test test/test-reads-source-smell.test.ts`.

### Test-isolation lint and helpers

**The canonical home of the test-isolation rules.** `scripts/check-test-isolation.sh` (in `bun run
verify`) enforces them on non-serial unit files: `test/**/*.test.ts` (and `evals/**/*.test.ts` when
that directory exists) except `*.serial.test.ts` and `test/e2e/`. The ids are stable and other
files name them:

| Rule | What it bans | Fix |
|---|---|---|
| **R1** | `process.env` writes: assignment, `delete`, `Object.assign`, `Reflect.set` | `withEnv()` (`test/helpers/with-env.ts`) or `*.serial.test.ts` |
| **R2** | `mock.module(...)` anywhere in the file | `*.serial.test.ts` |
| **R8** | A scratch directory inside the source tree (`join(import.meta.dir, '.tmp-...')`): a tree walker in the same lane fails with `ENOENT` when it is created or removed mid-walk | `mkdtempSync(join(tmpdir(), '...'))` |

`scripts/check-test-isolation.allowlist` lists files exempt from the lint. It only shrinks: never add
an entry. It holds two permanent entries, the lint's own test and the `withEnv` test, whose fixture
strings match the lint's patterns. `--as-parallel FILE...` lints the named files, serial ones
included, as if they ran in the parallel pool.

#### Opt-in naming rule

`test/helpers/operator-env-preload.ts` deletes every `GBRAIN_*` variable outside the keep-list in
`test/helpers/operator-env-policy.ts`, and every `CONDUCTOR_*`, `MCP_*` and `OPENCLAW_*` variable,
before any test file loads, so an opt-in under any other name is a silent no-op. Name test opt-ins
`GBRAIN_TEST_<AREA>_<WHAT>`, and paid ones `GBRAIN_TEST_LIVE_<WHAT>`. The keep-list is the
`GBRAIN_TEST_`, `GBRAIN_CI_` and `GBRAIN_E2E_` prefixes plus `GBRAIN_HOME`, `GBRAIN_DATABASE_URL`,
`GBRAIN_MODEL_DISCOVERY` and `GBRAIN_DEBUG_PRELOAD`. Renamed opt-ins are listed in the policy's
`RENAMED` map (its one entry maps `GBRAIN_BASH32_REQUIRE` to `GBRAIN_TEST_BASH32_REQUIRE`); setting
an old name stops the run with the rename command. `GBRAIN_TEST_KEEP_AMBIENT_ENV=1` turns the scrub
off and `GBRAIN_DEBUG_PRELOAD=1` logs the names it removed, never the values.

`bun run check:test-env-opt-ins` (in `verify`) parses every test file under `test/` and `evals/` and
fails on an execution-gating read (`describe.skipIf`, `if (...) return`, a constant used that way) of
a `GBRAIN_*` name the preload strips, unless the same file assigns that name itself.

#### `withEnv` pattern

```ts
import { withEnv } from './helpers/with-env.ts';

test('sees the override', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    expect(process.env.OPENAI_API_KEY).toBe('sk-test');
  });
});

// Delete a var (override is undefined):
await withEnv({ GBRAIN_HOME: undefined }, fn);

// Multiple keys:
await withEnv({ A: '1', B: '2', C: undefined }, fn);
```

`withEnv` saves the prior value of every key it touches and restores it in a `finally`, including
when the callback throws. Nested calls restore to the outer value. An absent `TZ` is restored as
the zone that was in effect, because Bun keeps the last explicitly set zone when `TZ` is deleted.
**It is cross-test safe but not safe for concurrent use inside one file.** `process.env` is
process-global, so two `test.concurrent()` calls in one file that touch the same key race. A file
that uses `withEnv` stays out of `test.concurrent()`.

#### Speed + environment helpers (`test/helpers/`)

Reach for these before hand-rolling one:

- `wait-for.ts`: `waitFor(predicate, {timeoutMs, intervalMs, label})` and `waitForValue` poll until
  the condition holds and fail with a labeled error, instead of a fixed `setTimeout` sleep.
  `testWaitMs(ms)` scales a deadline by `GBRAIN_TEST_WAIT_MULTIPLIER` (1 to 4, default 1; any other
  value fails the test loudly), capped at 50 s so a slow condition fails as a labeled `waitFor` error
  and never as an anonymous Bun timeout. `waitFor` applies it to its own deadline.
  `scripts/lib/test-env.sh` sets the multiplier to 2 whenever `COVERAGE_DIR` is set, and
  `run-e2e.sh` keeps it through its environment scrub. It is separate from
  `GBRAIN_TEST_TIMEOUT_MULTIPLIER`, which scales Bun's `--timeout` in `run-unit-shard.sh`.
- `with-env.ts`: `withEnv` (above) and `emptyHome()`, a fresh empty temporary directory for
  `GBRAIN_HOME`.
- `git-fixture.ts`: `await makeGitFixture(dir)` builds a git repository once; `reset()` and
  `commitAll()` between tests replace a `git init` chain per test.
- `git-env.ts`: `gitChildEnv`, the environment for a git child process in a test, with the variables
  that locate a repository and the global pathspec switches dropped.
- `git-publication.ts`: `git` and `gitAsync`, and `gitFixture()` and `gitFixtureAsync()`, which
  build a worktree with a bare remote. Prefer the asynchronous forms in test bodies.
- `stream-text.ts`: `pumpText(stream)` and `waitForText` drain a child's output from the moment it
  is spawned; racing `reader.read()` against a timer loses output.
- `cpu-time.ts`, `hypervisor-steal.ts`, `interleaved-timing.ts`: timing helpers for tests that
  assert on elapsed time. They measure thread CPU time, retry a window across which the VM's steal
  counter moved, or alternate two shapes so a short stall hits both.
- `large-worktree.ts`: writes many small Markdown files and commits them as a fixture repository.
- `golden.ts`: `expectGolden` compares an output with a stored golden through a named normalizer;
  regenerate deliberately with `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test <file>`, and justify the
  changed golden in the pull request.

#### When to quarantine instead of fix

Rename to `*.serial.test.ts` when:

- The file uses `mock.module(...)` (R2: there is no clean fix without changing production code).
- The file is genuinely env-coupled: module-load environment readers and ESM caching defeat
  dynamic-import-after-env tricks.
- The file touches other process-wide state (`process.exitCode`, `console`, `process.argv`, signal
  handlers, bound ports).
- The file's tests intentionally share state across `it()` boundaries.

`scripts/serial-files.tsv` is the serial manifest: every `*.serial.test.ts` outside `test/e2e/` with
its class (`R1` env mutation, `R2` `mock.module`, `global-state`, or `exclusive` for the
`EXCLUSIVE_FILES` lane in `scripts/run-serial-tests.sh`) and a reason taken from what the file
actually touches. `test/scripts/serial-files.test.ts` requires the manifest to match the tree
exactly, rejects boilerplate or short reasons ("flaky", "needs serial") and fails when the exclusive
list grows past four entries. Before adding a row, lint the file as if it were parallel:

```bash
bash scripts/check-test-isolation.sh --as-parallel test/<name>.serial.test.ts
```

When that passes and the file touches no process-wide state, rename it to `*.test.ts` instead; it
then runs in the parallel shards. The quarantine is debt: prefer fixing the contention root cause
when one exists.

### Test preloads

`bunfig.toml`'s `[test]` preloads apply to every `bun test` started at the repository root, in this
order:

1. **Database-URL run guard** (`test/helpers/database-url-guard-preload.ts`). `bun test` refuses to
   start while `DATABASE_URL` or `GBRAIN_DATABASE_URL` is set, because a test may run destructive
   statements against whatever those URLs name: `TEST-RUN GUARD: refusing to start — DATABASE_URL is
   set.`, exit 1. It fails with instructions instead of unsetting, which would turn gated tests into
   green skips. `GBRAIN_TEST_ALLOW_DATABASE_URL=1` opts in for one run; avoid exporting it from a shell
   profile. The unit, slow and serial wrappers and `run-e2e.sh` unset both variables at their own
   boundary.
2. **Operator-env scrub** (`operator-env-preload.ts`): [Opt-in naming rule](#opt-in-naming-rule).
3. **Provider-key strip** (`provider-keys-preload.ts`): removes the ambient provider credentials
   listed in `test/helpers/provider-env.ts`, so a run behaves as in keyless CI, and defaults
   `GBRAIN_MODEL_DISCOVERY` to `off`. A test that wants a key injects it itself (`withEnv`).
   `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1` keeps the ambient keys; `run-e2e.sh` sets it.
4. **Real-home guard** (`real-home-guard-preload.ts`): compares metadata (size, modification time,
   inode, mode) of a fixed list of install files under the operator's real home before and after
   each test and fails the test that changed one. It detects; it does not intercept, and it never
   reads file contents. `GBRAIN_TEST_ALLOW_REAL_HOME_WRITES=1` disarms it, with a warning, for a
   deliberate one-shot test inside an isolated child home. `test/real-home-guard-preload.test.ts`
   checks the guard.
5. **`GBRAIN_HOME` isolation** (`gbrain-home-preload.ts`): points `GBRAIN_HOME` at a fresh temporary
   directory per run unless it is already set, so tests never read or change the operator's real
   configuration. A test that spawns a child sets both `HOME` and `GBRAIN_HOME` in the child's
   environment: `HOME` alone loses to the inherited value, and an in-process `HOME` change loses to
   Bun's cached `os.homedir()`. `GBRAIN_DEBUG_PRELOAD=1` prints the allocated home.
6. **Hermetic git** (`git-hermetic-preload.ts`): drops the git variables that locate a repository
   (`GIT_DIR`, `GIT_WORK_TREE`, ...), so a run started from a git hook never writes into the
   caller's repository, and turns off commit and tag signing for every git process in the run
   through `GIT_CONFIG_COUNT` entries. It also makes `Bun.spawn` and `Bun.spawnSync` default `env`
   to `process.env`.

### API keys and running all tests

No test in this repository needs a provider key, and the unit preload removes provider keys from the
test environment. `run-e2e.sh` keeps them, because an E2E file is where a real key is deliberate. An
E2E file that needs a key no CI job has goes in `scripts/e2e-live-key-only.txt`; the default E2E
list leaves it out, and naming it on the command line still runs it:

```bash
bash scripts/run-e2e.sh test/e2e/<name>.test.ts
```

A skipped test is not a passing test: `scripts/ci-executed-counts.ts --missing-keys K1,K2` counts the
skipped tests in files that read those keys. `bun run test:full` runs every lane (verify, the unit
loop with its serial pass, the slow lane and the E2E lane). Name the profile you ran
([Coverage responsibilities before consolidation](#coverage-responsibilities-before-consolidation)).

## Guards

### Guard registry and self-test

The privacy and test-isolation guards use `scripts/lib/guard-candidates.sh` to scan fresh file
contents in bounded batches before applying their detailed per-file rules. They do not cache passing
results. A scanner failure fails the guard, and matching files keep the same allowlists and
diagnostics.

`scripts/guards-manifest.tsv` is the single registry of `scripts/check-*` guards, each classified
`scanner` (greps or parses repository sources and must eventually carry fixtures), `buildfresh` or
`repostate` (build, freshness and repository-state guards are exempt with a reason).
`scripts/guard-self-test.sh` (`bun run check:guard-self-test`, a solo check in `bun run verify`)
proves every `selftest yes` scanner can fail: it runs each against a known-bad tree (must exit
non-zero) and a known-good tree (must pass) under `test/fixtures/guards/<guard>/{bad,good}/`, through
the `GBRAIN_GUARD_ROOT` seam. Guards run four at a time (`GUARD_SELF_TEST_JOBS` overrides), results
print in manifest order, and the whole pass must finish inside its 30 s budget. The self-test also
enforces manifest completeness: a new `scripts/check-*` script with no manifest row fails. A guard
whose pattern rots into a permanently green no-op fails CI instead of passing as coverage. A guard
may carry extra known-bad trees named `bad-<variant>/`; each must fail on its own. A green
self-test does not prove that a guard that skipped measured anything.

**Skips.** A guard whose subject is absent prints `GBRAIN_CHECK_SKIPPED: <reason>` and exits 0:
nothing to scan, nothing to measure. `bun run verify` records it as `skip`, lists it under
`self-skipped (recorded as skip, not pass)` and still exits 0. The size and orphan ratchets
(`check:module-size`, `check:function-size`, `check:orphan-modules`) skip while `src/` has no source
file and their lists have no row. A skip is not a pass: report it as a skip, with its reason.
`scripts/check-bash32.sh`, which runs outside `verify`, prints its own skip line instead
([Bash 3.2 parse guard](#bash-32-parse-guard)).

#### Retired-phrase guard

`scripts/check-retired-phrases.sh` (`bun run check:retired-phrases`, in `bun run verify`) keeps the
instructions agents follow literally in step with the code. It greps `CLAUDE.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `docs/`, `skills/`, `scripts/`, `.github/` and `package.json` (each when it
exists) for retired phrases: contributor-workflow phrases, and the vocabulary of product code that
is not in this repository (a path into a `src/` subdirectory, the embedded database engine, the
product's table names and the commands of its command-line tool). The patterns and the current
instruction for each live in the script's `RETIRED` table. Historical records may quote them
and are exempt: `docs/designs/`, `docs/test-audit/`, `docs/incidents/`, `docs/plans/`,
`docs/proposals/`, `docs/research/`, `docs/issues/`, `docs/superpowers/`, `docs/migrations/`,
`skills/migrations/` and `docs/architecture/wave-1-*`; the script exempts itself and
`CHANGELOG.md` is not scanned. Each hit prints `FAIL: <file:line> retired phrase "<match>"`, then
`Why:`, `Fix:` with the current instruction, and `See:`. The fix is to rewrite the sentence to the
current workflow, never to exempt the file. To retire another phrase, add a row to `RETIRED`.
Fixtures: `test/fixtures/guards/check-retired-phrases.sh/` (one `bad-<location>` tree per scanned
location); every pattern and the exemptions are driven in
`test/scripts/check-retired-phrases.test.ts`.

#### Bash 3.2 parse guard

macOS ships GNU bash 3.2.57 as `/bin/bash`, and its parser rejects shapes bash 5 accepts. The one
that broke every Mac is a heredoc inside `$(...)` whose body holds an odd quote.
`scripts/check-bash32.sh` (`bun run check:bash32`) runs the real 3.2 parser, `bash -n`, over every
tracked `*.sh` except the guard fixtures under `test/fixtures/guards/`. It uses the first parser
available: `GBRAIN_BASH32=<path>` (a bash 3.x binary), `/bin/bash` when it is bash 3.x (stock
macOS), or the digest-pinned `bash:3.2` Docker image (`GBRAIN_BASH32=docker` forces the image). With
none it prints one skip line and exits 0; `GBRAIN_TEST_BASH32_REQUIRE=1` makes that exit 2. Each
failure prints `FAIL: <file:line>`, `Why:` (macOS `/bin/bash` is 3.2), `Fix:` (read heredoc text with
`IFS= read -r -d '' VAR <<'EOF' || true`) and `See:`. To reproduce one file by hand:
`docker run --rm -v "$PWD":/w -w /w bash:3.2 bash -n <file>`.

The guard checks parsing only. It is not in `bun run verify`, which must not need Docker. The
`test.yml` `verify` job runs it with `GBRAIN_TEST_BASH32_REQUIRE=1`, together with
`test/scripts/check-bash32.test.ts`, whose real-parser cases feed it the
`test/fixtures/guards/check-bash32.sh/{bad,good}` trees.

### Placeholder assertions

`scripts/check-test-placeholders.mjs` (`bun run check:test-placeholders`, in `bun run verify`)
parses every `test/**/*.test.ts` file outside `test/fixtures/` with the TypeScript compiler API and
fails on the no-op forms `expect(true)` with no matcher, `expect(true).toBe(true)`,
`expect(true).toBeTruthy()` and `expect(1).toBe(1)`. Text inside strings and template literals is
ignored, and `expect(true).toBe(false)` fail sentinels are allowed. Remaining sites (type-only
contracts enforced by typecheck, skip-arm markers, gates that fail by throwing) belong in the
script's reasoned `ALLOWLIST`, keyed by file, test name and exact count; a site above its count fails
as new, and an entry whose file, test or count shrank fails as stale. The list is empty. This is a
hygiene check for one pattern, not a detector of low-value tests in general; the
[authoring gate](#authoring-gate) owns that.

### Function-size ratchet

`scripts/check-function-size.ts` (`bun run check:function-size`, in `bun run verify`) measures every
function-like node in `src/**/*.ts` except `*.generated.ts` and `.d.ts` with the TypeScript
compiler API, every function form included. A nested function is measured on its own and also counts
toward its parent. Code under `test/` is out of scope. Its sibling `scripts/check-module-size.sh`
(`bun run check:module-size`) holds per-file line ceilings in `scripts/module-size-limits.tsv`.

`scripts/function-size-baseline.tsv` holds one row per function over 300 lines: `path`, `name`,
`lines`, `justification`. The name is a path built from declarations, property names and call
context, never line numbers, so edits above a function do not touch its row (key grammar in the
script header). The guard fails when a function over 300 lines has no row, a baselined function
grows, a baselined function drops to 300 lines or fewer (remove the row), a row has more than 50
lines of stale slack (lower it), a row names a function that no longer exists, or a row is
malformed, duplicated or out of order. A row raised above, or added since, the baseline at the
merge base with `origin/main` needs an issue or TODO id in its justification; the summary prints
every raise.

Each failure prints `FAIL: <file:line> <what>` with the computed key, then one `Why:` / `Fix:` /
`See:` block. The fix is extraction: move a cohesive block into a named helper or sibling module.
After a move-only commit changes a function's key, `bun scripts/check-function-size.ts --transfer`
moves the row to the verified identical function (rules in the script header). Fixtures:
`test/fixtures/guards/check-function-size.ts/{bad,good}`; every rule is driven in
`test/scripts/check-function-size.test.ts`.

### Orphan-module guard

`bun run check:orphan-modules` (`scripts/check-orphan-modules.mjs`, in `verify`) walks static,
dynamic and `require` relative imports from the runtime entrypoints (the `ENTRYPOINTS` list in the
script and the targets of `package.json`'s `exports`). Every `src/` module it cannot reach needs a
disposition:

- Imported by nothing, not even tests: fails as `hard-orphan` unless it has a reasoned `ALLOWLIST`
  entry (shrink-only).
- Imported only by tests or scripts: fails as `unpermitted-test-only` unless it is named in
  `PERMITTED_TEST_ONLY` with a `reason`. The set may grow only with a reason in a reviewer-visible
  edit; modules reached from `scripts/**` use the reason `script-reachable`, which the guard
  verifies.
- A permitted entry whose module was deleted, wired into a runtime entrypoint, dropped by every
  test, or tagged `script-reachable` without a `scripts/**` importer fails as
  `stale-permitted-entry`. Remove or correct the record; never restore code to satisfy the list.

Each failure prints the rule, the module, the tests that import it, the reason, the remedy, the
rerun command and this anchor. The entrypoint list, the allowlist and the permitted set are empty
while `src/` is, and then the guard skips. Fixture mode (`GBRAIN_GUARD_ROOT`) reads the permitted set
from `<root>/permitted-test-only.json`; `test/scripts/check-orphan-modules.test.ts` proves every rule
fails on a bad tree.

### Move-only verifier

`scripts/verify-move-only.ts` proves a commit tagged `Move-Only: yes` moves code without editing it:
every top-level statement of every touched TypeScript file on the base side reappears token for
token on the head side, and nothing else appears (tokens from `scripts/lib/normalize-tokens.ts`, so
whitespace and comments are ignored and string and template text is exact). Imports, `export ... from`
lines, bare export lists and toggling the `export` or `default` modifier on a moved statement are
allowed and counted. Run `bun scripts/verify-move-only.ts <commit>` (a commit, or `<base>..<head>`;
the default is `HEAD~1..HEAD`); `--rename-map <json>` applies identifier rewrites to the base side
for `Mechanical-Rename: yes` commits. Exit status: 0 move-only, 1 edited tokens, 2 usage error.
Failures print `FAIL: <file:line>` with the first differing token. Pinned by
`test/scripts/verify-move-only.test.ts`.

### Docs navigation checks

Documents are checked by one unit test and four `verify` checks:

- `test/docs-navigation.test.ts` (a unit test) checks that local links and `#fragment` anchors
  resolve in `CLAUDE.md`, `AGENTS.md`, `docs/architecture/KEY_FILES.md` and every
  `docs/architecture/key-files/*.md` page, and that every page is reachable from the index.
- `bun run check:docs-repo-paths` (`test/docs-repo-paths.test.ts`) fails on a `scripts/` or `test/`
  file path in `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/` or `.github/` that
  does not exist. Placeholder names are skipped, `<!-- repo-paths: historical -->` exempts the rest of
  its section, and a reasoned `ALLOWLIST` row covers a path that lives outside this repository; a
  stale row fails.
- `bun run check:doc-history` (`scripts/check-key-files-current-state.sh`) keeps the reference
  documents current-state: it bans the bolded release marker, caps the size of `CLAUDE.md`, the
  index, each key-files page and this page (`docs/TESTING.md` is a ratchet: it only goes down, and
  detail belongs beside its code), and allows one bullet per source file. Its fixture suite is
  `test/scripts/check-key-files-current-state.test.ts`.
- The [retired-phrase guard](#retired-phrase-guard), and `bun run check:newlines`, which requires
  every tracked `*.md` file to end with a newline.
