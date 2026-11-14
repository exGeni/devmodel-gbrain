# devmodel-gbrain

This repository is a development model cut from [gbrain](https://github.com/garrytan/gbrain): the test lanes, guards, CI workflows and
contributor tools that agents and people run to build and ship software, shipped with
[gstack](https://github.com/garrytan/gstack). gstack ships, lands and releases it: `/ship`
opens the pull request, `gstack-ship-queue land` merges it and `gstack-release-stamp open`
opens a release PR, under the policy in `.gstack/ship-policy.json`.

It holds no product code. A product is built on this repository and adds its own `src/`,
its own tests and its own section in the operator contract.

## What it gives you

- **Test lanes:** unit, serial, slow and E2E runners that shard by weight, rescue
  out-of-memory kills and write receipts of what ran.
- **Guards:** `bun run verify` runs the checks in `scripts/run-verify-parallel.sh`, and a
  guard self-test proves each scanner guard can still fail.
- **CI workflows:** `.github/workflows/` holds the test, stress, security-scan, nightly-watch,
  CI-health and fix-wave workflows.
- **Contributor tools:** the discrimination helper, the contributor audit and the stress
  runner, described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

Needs Bun 1.4.4 or newer, Git and bash.

```bash
bun install --frozen-lockfile
bun run verify      # guards and typecheck
bun run test        # unit lane: parallel shards, then the serial pass
bun run test:full   # verify, then the unit, slow and E2E lanes
```

Save a command's whole output to a file and read the file; the exit status is the verdict.

## Where the contract lives

| Document | What it holds |
|---|---|
| [CLAUDE.md](CLAUDE.md) | The rules and the map for an agent working here; Claude Code reads it automatically |
| [AGENTS.md](AGENTS.md) | The entry point for other agent harnesses |
| [docs/TESTING.md](docs/TESTING.md) | The lanes, the guards, the isolation rules and how CI runs them |
| [docs/RELEASING.md](docs/RELEASING.md) | The ship policy, changelog fragments, release PRs and the fix-wave gate |
| [docs/protocol/AGENT_OPERATOR_v1.md](docs/protocol/AGENT_OPERATOR_v1.md) | How to read what the tools print and what to do next |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, writing tests, where a change goes, how a contributor PR lands |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, the scans CI runs, what the test preloads remove |

## License

MIT, see [LICENSE](LICENSE).
