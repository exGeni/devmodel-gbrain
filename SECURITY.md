# Security

## Reporting vulnerabilities

If you find a security issue in this repository, report it privately. Where the repository
has GitHub's private vulnerability reporting turned on (GitHub offers it for public
repositories), open the **Security** tab and choose **Report a vulnerability**, which opens a
private security advisory. Otherwise tell the repository owner directly.

Do not open a public issue for a security vulnerability.

## Automated security scanning

CI runs five automated checks. None needs a secret.

| Check | Where | When | Result |
|---|---|---|---|
| Secret scan, gitleaks CLI 8.30.1 with `.gitleaks.toml` | `test.yml`, job `gitleaks` | Every event `test.yml` runs on, except a dispatch that only runs the stress diagnostic | `gitleaks detect --redact` over the commits the event introduces: the pull request's commits, the merge-queue entry's, or the push's. It first runs `scripts/test-gitleaks-config.sh`, which proves the scanner still flags a synthetic secret while the exact fixture exceptions stay narrow. The pinned gitleaks download is verified against its published checksum on every run |
| Dependency advisories, `bun audit` | `test.yml`, job `dependency-audit` (`scripts/ci-dependency-audit.sh`) | Every event | Blocks on pushes, scheduled runs and manual runs. On a pull request or merge-queue entry it blocks only when the change touches `bun.lock`, `patches/` or a `package.json` dependency field, or the PR carries the `dependency-audit` label; otherwise an advisory is a warning. An audit that got no answer from the registry blocks a blocking run, because nothing was checked |
| Dependency vulnerabilities, OSV-Scanner | `.github/workflows/osv-scanner.yml` | A pull request that touches `package.json` or `bun.lock`; weekly on Monday at 06:30 UTC; manual | Findings go to the job log and a SARIF artifact on the run. Nothing is uploaded to code scanning, so the workflow stays read-only |
| Static analysis, Semgrep CE | `.github/workflows/semgrep.yml` | Every pull request; weekly on Monday at 07:30 UTC; manual | On a pull request, job `semgrep` fails only on findings new since the merge base (`--baseline-commit`), so a finding that already exists never blocks an unrelated PR. The weekly and manual run, job `semgrep-full`, scans the whole tree, reports only, and uploads SARIF to code scanning |
| Workflow lint, actionlint | `.github/workflows/actionlint.yml` | A push or pull request to `main` that changes `.github/workflows/**` or `.github/actionlint.yaml` | Fails on a malformed workflow, a bad action reference or a missing-permission bug |

Every workflow pins its external actions to a commit SHA, and the scanning workflows
declare `permissions: contents: read`. Only the job that needs more asks for it: the
OSV-Scanner caller grants `security-events: write` because its reusable workflow requires
the grant at startup, and `semgrep-full` holds it to upload SARIF.

On your own machine, `bun run ci:local` runs the same secret scan over the working tree
(`scripts/scan-worktree-secrets.sh`) and over `origin/main..HEAD`. It needs `gitleaks`
and Python 3 installed.

## Environment variables in tests

Every `bun test` run in this repository loads the preloads listed in `bunfig.toml`, in
this order. They keep a developer's shell from changing a test's result and keep a test
from reaching anything outside the run. Each preload removes only ambient shell state,
once, before any test file loads; a variable a test sets itself is never touched.
`GBRAIN_DEBUG_PRELOAD=1` makes the preloads log the names they remove, never the values.
More detail: [test preloads](docs/TESTING.md#test-preloads).

| Preload | What it does to the environment | Opt-out |
|---|---|---|
| `test/helpers/database-url-guard-preload.ts` | Refuses to start (exit 1) while `DATABASE_URL` or `GBRAIN_DATABASE_URL` is set and non-empty. It does not unset them: a silent unset would turn tests that need a database into green skips. | `GBRAIN_TEST_ALLOW_DATABASE_URL=1`, one-shot. The runners unset both variables at their boundary; do not export the opt-in from a shell profile |
| `test/helpers/operator-env-preload.ts` | Deletes `CONDUCTOR_*`, `MCP_*` and `OPENCLAW_*` variables, and every `GBRAIN_*` variable except the keep-list below. It stops the run with exit 2 when a test opt-in is set under its old name (`GBRAIN_BASH32_REQUIRE` is now `GBRAIN_TEST_BASH32_REQUIRE`). | `GBRAIN_TEST_KEEP_AMBIENT_ENV=1` |
| `test/helpers/provider-keys-preload.ts` | Deletes every variable in `PROVIDER_ENV_KEYS` (`test/helpers/provider-env.ts`): the API keys, base URLs and related settings of the model providers, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OLLAMA_BASE_URL`. It also sets `GBRAIN_MODEL_DISCOVERY=off` unless it is already set, so no test makes a discovery call. | `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1` |
| `test/helpers/real-home-guard-preload.ts` | Changes no variable. It records the size, modification time, inode and mode of the install files under the real home directory, and fails the check that sees one of them change: before a test, after a test or after the last test. | `GBRAIN_TEST_ALLOW_REAL_HOME_WRITES=1` disarms it with a warning |
| `test/helpers/gbrain-home-preload.ts` | Sets `GBRAIN_HOME` to a fresh temporary directory unless it is already set, so tests never read or write the operator's real configuration. | An exported `GBRAIN_HOME` is kept by a direct `bun test`; the unit and slow runners unset it first, and `scripts/run-e2e.sh` sets its own |
| `test/helpers/git-hermetic-preload.ts` | Deletes the git variables that locate or reconfigure one repository (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG*`, the pathspec switches and the rest of `git rev-parse --local-env-vars`), so a run started from a git hook never writes into the caller's repository. It keeps the operator's `safe.directory` entries and the transport and credential variables, then injects `commit.gpgsign=false` and `tag.gpgsign=false` through `GIT_CONFIG_COUNT`, and makes `Bun.spawn` and `Bun.spawnSync` default their `env` to `process.env`. | None for the variable drop. It leaves signing alone when `GIT_CONFIG_KEY_<n>` already sets `commit.gpgsign` or `tag.gpgsign` |

The `operator-env-preload.ts` keep-list, from `test/helpers/operator-env-policy.ts`:

- exact names: `GBRAIN_HOME`, `GBRAIN_DATABASE_URL`, `GBRAIN_MODEL_DISCOVERY` and
  `GBRAIN_DEBUG_PRELOAD`;
- the prefixes `GBRAIN_TEST_` (test opt-ins and runner knobs), `GBRAIN_CI_` (the local CI
  gate) and `GBRAIN_E2E_` (the E2E runner and its database floor).

A test opt-in under any other name is deleted before the test reads it, so name new ones
`GBRAIN_TEST_<AREA>_<WHAT>` ([Opt-in naming rule](docs/TESTING.md#opt-in-naming-rule)).
`bun run check:test-env-opt-ins` fails on a test that gates its execution on a name the
preload deletes.

The runners add their own boundary. `scripts/run-unit-parallel.sh`,
`scripts/run-unit-shard.sh`, `scripts/run-slow-tests.sh`, `scripts/run-serial-tests.sh`
and `scripts/run-e2e.sh` unset `DATABASE_URL` and `GBRAIN_DATABASE_URL`; the unit and slow
runners also unset `GBRAIN_HOME`. `scripts/run-e2e.sh` gives each test file its own `HOME`
and `GBRAIN_HOME`, sets `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`, removes `CONDUCTOR_*`,
`MCP_*`, `OPENCLAW_*`, `HERMES_*`, `GROK_*`, `OPENCODE_*` and `GBRAIN_*` variables outside a
short keep-list before Bun starts, and checks that the real user configuration did not
change. `scripts/regen-all.ts` runs its generators with provider keys (`*_API_KEY`,
`*_API_TOKEN`) and both database URLs removed.
