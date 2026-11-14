# Agents working on this repository

This repository is a development model: test lanes, guards, CI workflows and contributor tools
that agents run, shipped with gstack. This page is the entry for any agent (Claude Code,
OpenClaw, Codex). The rules live in [`./CLAUDE.md`](./CLAUDE.md); Claude Code loads it on its
own, and every other agent reads it next.

## Read this order

1. `./AGENTS.md` (this file).
2. [`./CLAUDE.md`](./CLAUDE.md): the North Star, the invariants, the reference map and the
   inline ship rules.
3. [`./docs/protocol/AGENT_OPERATOR_v1.md`](./docs/protocol/AGENT_OPERATOR_v1.md): how to read
   what the tools print (failure lines, exit codes, skips, receipts, CI issues).
4. [`./docs/TESTING.md`](./docs/TESTING.md): the test lanes, guards and isolation rules.
5. [`./docs/architecture/KEY_FILES.md`](./docs/architecture/KEY_FILES.md): what each file does.
   Read a file's entry before editing it.
6. [`./CONTRIBUTING.md`](./CONTRIBUTING.md): where a change goes and how a contributor PR lands.

## Agent operator protocol

Every tool here prints its failures as a headline, then `Why:`, `Fix:` and `Docs:`. The exit
status is the verdict; a `DEVMODEL_CHECK_SKIPPED:` line is a skip, not a pass; save a command's
whole output before reading it. The full contract:
[`docs/protocol/AGENT_OPERATOR_v1.md`](./docs/protocol/AGENT_OPERATOR_v1.md).

## Before shipping

Run `bun run verify` before every push. The full local run is `bun run test:full` (verify, then
the unit, slow and E2E lanes); `bun run ci:local` runs CI's lanes on this machine and needs
`gitleaks`. In a multi-lane wave, lanes run targeted suites; only the integrator runs the full
gate.

Ship with `/ship`, never by hand. **PRs carry no version:** `/ship` writes a
`changelog.d/<branch-slug>.md` fragment, and gstack's release PR writes every stamp
([releases per batch](docs/RELEASING.md#releases-per-batch)). The release process, CI issues
and the fix-wave process: [`./docs/RELEASING.md`](./docs/RELEASING.md).

## Privacy

Never commit real names of people, companies, funds or private agents into public artifacts,
fixtures included. Use the placeholders in the Privacy rule of [`./CLAUDE.md`](./CLAUDE.md)
(`alice-example`, `acme-example`, `fund-a`).
