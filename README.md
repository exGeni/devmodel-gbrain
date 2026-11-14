# devmodel-gbrain

The development model of [gbrain](https://github.com/garrytan/gbrain), taken out of gbrain so
that another project can start from it: the test lanes, guards, CI workflows and contributor
tools that agents and people run to build and ship software, shipped with
[gstack](https://github.com/garrytan/gstack). gstack ships, lands and releases it: `/ship`
opens the pull request, `gstack-ship-queue land` merges it and `gstack-release-stamp open`
opens a release PR, under the policy in `.gstack/ship-policy.json`.

It holds no product code. A product is built on this repository and adds its own `src/`,
its own tests and its own section in the operator contract.

## Where this comes from

This is Garry Tan's and the gbrain contributors' work. gbrain is a knowledge brain for AI
agents, and around it they built a way of developing in which agents write, test and ship most
of the code. That way of working is useful well beyond gbrain, so this repository keeps it and
leaves gbrain itself where it lives.

- **Source:** [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain) at tag
  `v0.60.711.0` (commit `e9e0954b0f78`), MIT license. The first commit here is that tree as it
  was, without `.gbrain-evals/eval-results.jsonl`, which gbrain's own `.gitignore` excludes.
  [LICENSE](LICENSE) keeps gbrain's license and copyright line unchanged.
- **Kept:** the test runners, guards, CI workflows, CI watchers, contributor tools and the
  documents that describe them, rewritten where they described gbrain's product.
- **Removed:** gbrain's product: its CLI and MCP server, brains and pages, search, sync, the
  database engines, skills, plugins, install and upgrade, binaries, and gbrain's own release
  layer. Releases here go through gstack.
- **Renamed:** this repository's own settings use `DEVMODEL_*`. The `GBRAIN_*` names that are
  left belong to a real gbrain running beside the repository, which the test preloads keep
  out of every test.
- **Not an official gbrain project.** It is not made or endorsed by gbrain's authors. Report a
  problem with this repository here, and a problem with gbrain
  [to gbrain](https://github.com/garrytan/gbrain/issues).

To use gbrain or gstack themselves, install them from upstream; nothing here replaces them.

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
