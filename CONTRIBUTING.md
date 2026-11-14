# Contributing

This repository is a development model: test lanes, guards, CI workflows and contributor
tools that people and agents run, shipped with gstack. It holds no product code yet; a
product built on it adds its own `src/`. The documents that bind a change are listed in
[README.md](README.md#where-the-contract-lives).

## Setup

```bash
git clone <this repository's URL>
cd <the clone's directory>
bun install --frozen-lockfile && bun run test && bun run verify
```

`bun run test` is the parallel unit loop; `bun run verify` is CI's guard battery.
[`docs/TESTING.md`](docs/TESTING.md#quick-start) covers the lanes and the failure logs.

Requires Bun 1.4.4 or newer, matching `package.json`, plus Git and bash.

### Windows

`bun run test`, `verify`, `ci:local` and `test:e2e` all dispatch through bash, so
the shell scripts under `scripts/` must be checked out with Unix line endings.
The root `.gitattributes` pins `*.sh text eol=lf`, which overrides the
`core.autocrlf=true` that Git for Windows installs by default. A fresh clone is
correct with no extra steps.

`.gitattributes` pins `*.md` and `*.tsv` to LF too. Under a CRLF checkout every row of a
`.tsv` ratchet baseline ends in `\r`, no row matches, and `bun run verify` reports every
grandfathered entry as new.

If you cloned before the pins existed, your working copy still has the old
Windows line endings. Bash fails with `$'\r': command not found`. Refresh it once,
from the repository root. `git reset --hard` discards uncommitted changes, so
commit them or run `git stash -u` first.

```bash
git rm --cached -r . -q
git reset --hard
bash -n scripts/run-unit-parallel.sh          # silence means bash can read the scripts
git ls-files --eol -- '*.md' | grep -cE 'w/(crlf|mixed)' # 0 means Markdown is clean
```

Every `check:*` entry in `package.json` invokes its script as `bash scripts/<name>.sh`
rather than relying on the shebang, because bun on Windows cannot exec a `.sh`
directly. Keep that prefix when you add a new shell-script check.

## Project structure

```
scripts/                  Guards, test runners, CI helpers and generators
  check-*                 Guards that bun run verify runs (.sh, .ts, .mjs)
  guards-manifest.tsv     The registry of every check-* guard
  run-*.sh, test-shard*.sh  Runners for the unit, serial, slow, E2E and verify lanes
  ci-*.sh, ci-*.ts        Helpers that the workflows and ci:local call
  lib/                    Code the scripts share
  stress/                 The repeated-run lane behind bun run test:stress
  *.tsv, *.json           Manifests, ratchet baselines and shard weight maps
test/
  *.test.ts               Unit tests
  scripts/                Tests of the scripts
  helpers/                Shared test helpers and the bun test preloads
  fixtures/               Input data for tests
.github/
  workflows/              The CI workflows
  nightly-known-red.tsv   Known-red nightly cells, each with an owner and a review-by date
.gstack/                  gstack's per-repository policy: ship-policy.json, pregate.json
docs/                     The contract documents listed in README.md
bunfig.toml               bun test settings and the test preloads
package.json              The test, verify, check:* and ci:* entries
```

Per-file invariants live in `docs/architecture/KEY_FILES.md`; read a file's entry
before editing it.

## Running tests

The canonical reference for test lanes, isolation rules, timing and failure logs is
[`docs/TESTING.md`](docs/TESTING.md). The short version:

```bash
bun run verify                    # CI's guard battery and typecheck
bun run test                      # unit lane: parallel shards, then the serial pass
bun test --timeout=60000 test/docs-navigation.test.ts   # one file

bun run test:full                 # verify, then the unit, slow and E2E lanes
bun run test:slow                 # *.slow.test.ts only
bun run test:serial               # *.serial.test.ts only
bun run test:e2e                  # test/e2e/ files; empty until a product adds some
```

Bun does not apply `bunfig.toml`'s test timeout, so the runners pass
`--timeout=60000` themselves; pass it yourself when you run `bun test` directly.

Save a command's whole output to a file, read the file, and report the real exit status.
Piping test output into `tail` hides failures. The output formats and what to do next
are in [`docs/protocol/AGENT_OPERATOR_v1.md`](docs/protocol/AGENT_OPERATOR_v1.md).

A bare `bun test` refuses to start while `DATABASE_URL` or `GBRAIN_DATABASE_URL` is set
in your environment. Unset the variable, or use the runners, which unset both at their
boundary. The other variables the test preloads remove, and the opt-outs, are in
[`SECURITY.md`](SECURITY.md#environment-variables-in-tests).

`bun run verify` runs the checks listed in `scripts/run-verify-parallel.sh` in a bounded
pool (`bash scripts/run-verify-parallel.sh --dry-list` prints them), then the guard
self-test. They include the privacy guards (`scripts/check-privacy.sh`), the
test-isolation lint (`scripts/check-test-isolation.sh`, see "Writing tests that survive
the parallel loop" below), the documented-paths check (`bun run check:docs-repo-paths`),
the generated-artifact check (`bun run check:regen-all`) and typecheck. The guard
registry is `scripts/guards-manifest.tsv`. `scripts/guard-self-test.sh` runs each guard
marked `selftest yes` against known-bad and known-good fixtures, so a guard that can no
longer fail is caught, and it fails a `scripts/check-*` file that has no manifest row.

### Writing tests that survive the parallel loop

`bun run test` shards the unit-test files across worker processes. Files in the same
shard share a process, so process-global state leaks between them.
`scripts/check-test-isolation.sh` enforces three lint rules: no direct `process.env`
mutation (use `withEnv()` from `test/helpers/with-env.ts`), no `mock.module(...)` outside
`*.serial.test.ts`, and no scratch directory inside the source tree (use
`mkdtempSync(join(tmpdir(), ...))`).

**The full rules, the `withEnv` pattern and the `*.serial.test.ts` quarantine policy live
in [`docs/TESTING.md`](docs/TESTING.md#test-isolation-lint-and-helpers); read that before
writing a new test file.** Files that predate the rules are listed in
`scripts/check-test-isolation.allowlist`; the allow-list must shrink over time, so never
add new entries.

### Discrimination test

A fix's test is only worth anything if it **fails without the fix**. A test that passes
both ways is worse than no test: it inflates reviewer confidence, gets weighted into the
CI shards forever, and keeps passing after a later refactor silently breaks the behavior.

Every PR that fixes behavior fills the **Discrimination test** field of the PR template
with the actual result of checking this:

> Discrimination test: reverted `<source file(s)>` to `<ref>`, ran
> `<test file>` → `N pass / M fail`. Restored → all pass.

The helper does the whole dance in one command:

```bash
bash scripts/check-test-discriminates.sh <test-file> <source-file> [<source-file>...]
```

It reverts the source files to the pre-fix state (plain file copies, no git stash), runs
the test file, requires at least one EXECUTED test to fail (a non-zero exit alone does not
count, because a missing file or an import crash also exits non-zero: exit 3, the
vacuous-failure class), restores the files, and prints the paste-ready field line. Exit 1
means the test passed with the fix reverted: tighten the assertions before asking for
review. For a committed fix the pre-fix state comes from `DISCRIMINATE_BASE=<ref>`; with
it unset the helper uses the merge base with `origin/main`, then `HEAD~1`.

Vacuous-assertion shapes to avoid (they recur):

- asserting only `exit ≠ 0` (a missing binary also exits non-zero);
- asserting membership in a set that covers every reachable value (`['warn','fail']`
  when those are the only outputs);
- asserting a substring that would also appear in the broken output; assert parsed
  structure instead.

For a whole range of merged changes or open PRs, the contributor audit runs the same
check per change without the helper's whole-file revert: it reverses only that change's
product hunks at the audited head, so later fixes stay in place. Try it on the offline
fixture first:

```bash
bun scripts/contributor-audit-fixture.ts <empty-dir>   # prints the audit command for the fixture range
bun run audit:contributors <base>..<head> [--prs <manifest>] [--json]
```

Details, exit codes and the scrubbed sandbox: [Contributor audit](docs/TESTING.md#contributor-audit).

Before adding a test, answer the four questions in the
[authoring gate](docs/TESTING.md#authoring-gate); before deleting one, follow
[Retiring a test](docs/TESTING.md#retiring-a-test) and record its evidence table in the
PR body.

Relatedly, a test whose only assertion is a regex over source text pins spelling, not
behavior. A test that reads a `src/` path (`readFileSync`, `readFile` or `Bun.file`,
directly or through a path constant) needs a tagged marker on or just above the read:
`// test-reads-source-ok[<category>]: <why>`, with the category one of `prompt-byte`,
`trust-boundary`, `generated-artifact`, `structural` or `raw-bytes`.
`test/test-reads-source-smell.test.ts` enforces this. It counts read sites only, so new
assertions over an existing source binding still need the authoring gate. See
[Source reads in tests](docs/TESTING.md#source-reads-in-tests).

### Local CI gate

```bash
bun run ci:local         # CI's gate on this machine: gitleaks, guards, serial, slow, unit and E2E lanes
bun run ci:local:diff    # doc-only diff: gitleaks and the doc checks; any other diff: the full gate
bun run ci:select-e2e    # print the E2E files the diff selects (none for a doc-only diff)
```

`ci:local` needs `gitleaks` and Python 3 on the machine and stops at once without
`gitleaks`. It scans the working tree and `origin/main..HEAD` for secrets, runs
`bun run verify`, then the serial and slow lanes, then the unit and E2E lanes sharded
four ways. A doc-only diff (every path is `LICENSE`, `VERSION`, a root `*.md` or under
`docs/`) still runs gitleaks and `scripts/ci-doc-checks.sh`: the byte caps and
current-state voice of `KEY_FILES.md` and `TESTING.md`, the documented-paths check and the
privacy guards. Any other diff selects every E2E file; see
[E2E selection](docs/TESTING.md#e2e-selection).

### PR-side security checks

Besides the test gate, a PR can trigger three security workflows: Semgrep CE (every PR,
blocking for findings new since the merge base), OSV-Scanner (only when `package.json` or
`bun.lock` change) and actionlint (only when `.github/workflows/**` change). The `Test`
workflow also runs gitleaks and `bun audit`. See
[`SECURITY.md`](SECURITY.md#automated-security-scanning).

## Where does my change go?

A harness change lands in one of the places below. Every row ends with the same pre-merge
gate: `bun run verify`, and `bun run test` for the files it touches. Every row also adds a
test of its own; the last column names the smallest check that proves the change.

| Change kind | Create or edit | Registry to touch | Regenerate | Smallest check |
|---|---|---|---|---|
| Guard (a check that fails the build on a rule) | `scripts/check-<name>.sh`, `.ts` or `.mjs`. On a finding it prints `FAIL:`, `Why:`, `Fix:` and `See:` or `Docs:` ([the format](docs/protocol/AGENT_OPERATOR_v1.md)); with nothing to check it prints `GBRAIN_CHECK_SKIPPED: <reason>` and exits 0; it honors `GBRAIN_GUARD_ROOT` so the self-test can point it at a fixture tree | A row in `scripts/guards-manifest.tsv` (class `scanner`, `buildfresh` or `repostate`; `selftest` `yes`, `todo` or `exempt`); a `check:<name>` entry in `package.json`; a line in `CHECKS` of `scripts/run-verify-parallel.sh` (`SOLO_CHECKS` for a guard that times itself) | Nothing | `bash scripts/guard-self-test.sh`; for `selftest yes`, `test/fixtures/guards/<guard>/bad` (and any `bad-<variant>`) and `good`; the guard's own cases in `test/scripts/<guard>.test.ts` |
| Test | `test/<name>.test.ts`; the test of a script is `test/scripts/<script>.test.ts`. A file that cannot share a process is `*.serial.test.ts`; a cold-path or long workload is `*.slow.test.ts` | A `*.serial.test.ts` file needs a row in `scripts/serial-files.tsv` with its class and reason; never add to `scripts/check-test-isolation.allowlist` | `bun run regen:all` when `scripts/structural-suites.tsv` is stale (a test that reads repo text); `bun run weights:mine` for the shard weight maps ([Keeping CI partitions balanced](docs/TESTING.md#keeping-ci-partitions-balanced)) | `bun test --timeout=60000 <file>`; `bash scripts/check-test-isolation.sh --as-parallel <file>` shows whether a serial file could rejoin the unit lane |
| Test helper or preload | `test/helpers/<name>.ts` with its test beside it. A preload also goes into the `[test] preload` list of `bunfig.toml`, in the order it must run | A new test opt-in variable is named `GBRAIN_TEST_<AREA>_<WHAT>` or the operator-env preload strips it ([Opt-in naming rule](docs/TESTING.md#opt-in-naming-rule)) | Nothing | `bun run check:test-env-opt-ins`; for a preload, its test in `test/` (for example `test/operator-env-preload.test.ts`) and the probes under `test/fixtures/preload-guard/` |
| Test fixture | Input data under `test/fixtures/`. A guard's fixtures are `test/fixtures/guards/<guard>/{bad,good}`, and a test file in them is named `*.test.fixture.ts` so `bun test` never collects it | None; use placeholder names such as `alice-example` and `acme-example` | Nothing | `bun run check:fixture-privacy`, `bun run check:test-names`, `bun run check:privacy` |
| Runner or CI script | `scripts/run-*.sh`, `scripts/test-shard*.sh`, `scripts/ci-*.sh` or `.ts`, with its test in `test/scripts/`. Shell scripts must parse under bash 3.2 ([Bash 3.2 parse guard](docs/TESTING.md#bash-32-parse-guard)) | A `package.json` entry runs a shell script as `bash scripts/<name>.sh` | Nothing | `bun test --timeout=60000 test/scripts/<script>.test.ts`; `bun run check:bash32` |
| Ratchet baseline | `scripts/module-size-limits.tsv` (line ceilings per file), `scripts/function-size-baseline.tsv` (functions over 300 lines), `scripts/check-test-isolation.allowlist` | The two size ratchets measure `src/` and skip while it holds no source file and their baseline holds no row. Lower a module ceiling in the commit that shrinks the file; raising one is a reviewer-visible edit. Function-size rows and the allow-list only shrink | Nothing | `bun run check:module-size`, `bun run check:function-size`, `bun run check:test-isolation` ([Function-size ratchet](docs/TESTING.md#function-size-ratchet)) |
| Generated file | Its generator, never the output. The list is `ARTIFACTS` in `scripts/regen-all.ts` | The generator's entry in `ARTIFACTS` | `bun run regen:all`; `--goldens` only for a deliberate golden change, with its reason in the PR body ([Generated artifacts](docs/RELEASING.md#generated-artifacts)) | `bun run check:regen-all` |
| Workflow | `.github/workflows/<name>.yml`. Pin each action to a commit SHA with its tag in a comment ([SHA maintenance](docs/RELEASING.md#github-actions-sha-maintenance)) | A job in `test.yml`, `stress.yml` or `semgrep.yml` that depends on the event carries a comment naming the run that covers it, and a row in [Classification](docs/ci-event-parity.md#classification) ([Event parity](docs/TESTING.md#event-parity)). A workflow with a `schedule` trigger is listed in `nightly-watch.yml` | Nothing | `bun run check:dynamic-ci`; `bun test test/scripts/ci-pr-scope.test.ts test/scripts/nightly-issue.test.ts`; `actionlint.yml` lints every workflow change in CI |
| Document | `docs/**`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, `SECURITY.md`. Describe current behavior only; link gstack's documents instead of retelling them | Before renaming a heading, grep the repository for `<file>#`: tools print some anchors and tests pin others | Nothing | `bun run check:docs-repo-paths`, `bun run check:doc-history`, `bun run check:retired-phrases`, `bun run check:newlines`, `bun test test/docs-navigation.test.ts` |
| Changelog entry | `changelog.d/<branch-slug>.md`: the entry text only, no version heading; `/ship` writes it | None. Never edit `VERSION`, `package.json`'s version or a released `CHANGELOG.md` section | Nothing | `bun run check:changelog-headings` ([docs](docs/RELEASING.md#releases-per-batch)) |
| Flake hunt for a touched test | Nothing: `bun run test:stress [files…] [--iterations N] [--base <ref>]` (default: the test files changed against the merge base with `origin/main`, 10 iterations) | None | Nothing | The same command; a failing iteration prints its reproduce line |

The PR stress gate (`stress-changed-tests`) runs every test file the PR adds or changes,
and the direct importers of a changed `test/helpers/` file, 10 times with that same
`bun run test:stress` command. A touched file that fails an iteration is root-caused in
the same PR, never retried green ([Stress gate](docs/TESTING.md#stress-gate)).

A golden regenerated on purpose is a reviewer-visible diff: say in the PR body why the
output changed. Regenerate generated files instead of merging them.

## Shipping

Releases go through the `/ship` skill, never hand-rolled. The release process, the
changelog fragment rule and the fix-wave process are in
[`docs/RELEASING.md`](docs/RELEASING.md). A PR title says in plain words what changed for
someone using the repository, with no `type(scope):` prefix
([gstack plain titles](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#plain-titles))
and no version: a release PR gives the batch its version.
Contributor attribution stays attached through `Co-Authored-By:` trailers.

### gstack repo config (`.gstack/`)

Two committed files tell gstack about this repository's gates.

- `.gstack/pregate.json` ([gstack pregate](https://github.com/garrytan/gstack/blob/main/docs/pregate.md)):
  `dependencies` maps a file glob to the tests that cover it. `guards` runs a command when
  the branch touches its files: `bun test test/scripts/serial-files.test.ts` for
  `*.serial.test.ts`, `scripts/serial-files.tsv` and `scripts/run-serial-tests.sh`, and
  `bun scripts/regen-all.ts --check` for `scripts/classify-tests.ts`,
  `scripts/structural-suites.tsv` and any test file. A failing guard prints its fix line. `sealed` lists eval output paths and transcripts that must
  never reach the repository; `gstack-pregate sealed` refuses a push that adds
  one. `run_profiles` names the run that counts as a full test run: workflow `test.yml`,
  job `full-suite`, artifact `full-suite-tree`, from a `workflow_dispatch` or `push`. How
  CI's full run and `/ship` share it:
  [/ship lanes and CI carry](docs/ci-event-parity.md#ship-lanes-and-ci-carry).
- `.gstack/ship-policy.json`: the release policy: changelog fragments in `changelog.d`,
  the stamp files, the checks `land` runs after a merge, `review_exclude_paths`
  (`docs/**`, kept out of `/ship`'s reviewer diffs), `maintainers` and
  `min_gstack_version`. Every key and what gstack does with it:
  [Ship policy](docs/RELEASING.md#ship-policy).

### How a contributor PR lands

Contributor PRs are never merged into main as-is. A maintainer folds the change into a
fix-wave PR, revises it there (tests, agent-facing errors, conventions) and lands it with
credit: the commit says `Contributed by @handle` and carries a `Co-Authored-By:` trailer.
Your PR stays open until then. When the fix wave merges, a workflow closes your PR with a
comment that links the wave.

The **Fix-wave gate** check enforces this. It fails every PR into main whose head
repository is not this repository, and posts one comment saying so when the PR opens. A
red gate on a contributor PR is expected and is not a judgment of the work.

The `maintainer-override` label passes the gate for one PR a maintainer has decided may
land from its fork. It counts only when the most recent `labeled` event was made by a
human listed in `maintainers` of `.gstack/ship-policy.json`; bots never count. Every
override is written to the check's run log and step summary with who applied it and when.
Process and settings: [docs/RELEASING.md](docs/RELEASING.md#fix-wave-gate).

## Welcome PRs

- Self-test fixtures for the scanner guards still marked `todo` in
  `scripts/guards-manifest.tsv`
- Fixes for the files listed in `scripts/check-test-isolation.allowlist`; each fix removes
  its row
- Guard and tool messages that lack the `Why:`, `Fix:` or `Docs:` lines the
  [operator contract](docs/protocol/AGENT_OPERATOR_v1.md) describes
- Faster or steadier test lanes
