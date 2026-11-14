# Verify scheduling

How `bun run verify` schedules its checks and why `typecheck` sets its own heap
ceiling. Test tiers and the rest of CI live in [TESTING.md](../TESTING.md).

## Verify solo checks

`scripts/run-verify-parallel.sh` runs `CHECKS` through a worker pool sized to
the CPU count (`DEVMODEL_VERIFY_MAX_PARALLEL` overrides it), heaviest first, then
runs each `SOLO_CHECKS` entry alone after the pool has drained. A solo check is
one that enforces its own wall-clock budget: today only `check:guard-self-test`
(30 s, `BUDGET_SECONDS` in `scripts/guard-self-test.sh`). Inside the pool that
budget would measure the neighbouring heavy checks instead of the guards.

Add a new check as one line in the right block of `CHECKS`. Add to
`SOLO_CHECKS` only a check that times itself. The 120 s per-check cap
(`DEVMODEL_VERIFY_TIMEOUT`) applies to both phases. No workflow sets it, so every
runner keeps the 120 s default;
`test/scripts/run-verify-parallel.test.ts` pins that.

Every run writes `outcomes.tsv` in the log directory (`DEVMODEL_VERIFY_LOG_DIR`;
the default temporary directory is removed on success and kept on failure) with
each check's outcome and wall seconds, and the summary line names the five
slowest checks, so an overrun shows whether the check or its neighbours grew.
An outcome is `pass`, `fail`, `timeout` or `skip`: a check that exits 0 without
checking anything prints `DEVMODEL_CHECK_SKIPPED: <reason>`, and the recorder
counts it as a skip, never a pass.

`DEVMODEL_VERIFY_SKIP_TYPECHECK=1` leaves `typecheck` out of the pool. The
`verify` job in `test.yml` sets it because the separate `typecheck` job runs
tsc in parallel under its own timeout.

## Typecheck heap

`bun run typecheck` runs `node --max-old-space-size=8192
node_modules/typescript/bin/tsc --noEmit --incremental`, with its state in
`node_modules/.cache/devmodel-typecheck.tsbuildinfo`. Without the flag tsc can
abort with `JavaScript heap out of memory` on a host with little memory. The
value is a ceiling, not a reservation. If tsc reaches the ceiling, find what
grew the program (the `Files` and `Memory used` lines of `--extendedDiagnostics`)
before raising it.

In CI the `typecheck` job runs the same command through
`scripts/ci-typecheck.sh`. An attempt that ends by abort or signal (exit status
above 128) deletes the incremental state and runs once more from cold; a type
error is never retried. `DEVMODEL_TYPECHECK_ATTEMPT_SECONDS` bounds each attempt
(default 360).
