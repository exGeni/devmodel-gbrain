# CLAUDE.md

This repository is a development model: the test lanes, guards, CI workflows and contributor
tools of garrytan/gbrain at v0.60.711.0, with gbrain's product removed. Agents (Claude Code,
OpenClaw, Codex) run it, and gstack ships, lands and releases it. A product is built on it by
adding its code under `src/`, which is empty here, and its own sections to these documents.

## North Star

An agent started on this repository, or on a product built from it, works correctly: it runs
the gates, reads what they print, fixes what they report and ships through gstack, with no
person translating between the tools and the agent. Every guard, lane, workflow and document
is judged against this bar. A change that no gate, lane or agent uses is off-mission: an audit
for its own sake, a comparison between upstream tools, a check that catches nothing an agent
would otherwise ship.

## Layout and invariants

- `scripts/`: the guards (`check-*`, listed in `scripts/guards-manifest.tsv`), the test runners
  (`run-*`, `test-shard*`), the CI tools and their data files. `test/`: the tests of all of
  them, with `test/helpers/` (preloads and helpers) and `test/fixtures/`. `.github/workflows/`:
  CI. `.gstack/`: gstack's ship policy and pregate. `docs/`: the reference.
- **Every guard is registered and self-tested.** A `scripts/check-*` without a row in
  `scripts/guards-manifest.tsv` fails `check:guard-self-test`, which also runs each `selftest yes`
  guard against its `bad` and `good` fixtures ([guard registry](docs/TESTING.md#guard-registry-and-self-test)).
- **A skip is not a pass.** A check with nothing to check prints `GBRAIN_CHECK_SKIPPED:
  <reason>`, and `bun run verify` records it as a skip. The module-size, function-size and
  orphan-module ratchets skip while `src/` is empty and measure it once it exists.
- **Module-size ratchet.** `scripts/module-size-limits.tsv` pins per-file line ceilings
  (`check:module-size`): growth over a ceiling, more than 50 lines of stale slack after a
  shrink, a row for a deleted file, and any unlisted file over 1,500 lines fail. Raise a
  ceiling only by a reviewer-visible TSV edit in the same commit; lower it in the commit that
  shrinks the file. `check:function-size` ratchets functions the same way
  (`scripts/function-size-baseline.tsv`): no new function over 300 lines.
- **Tests are hermetic.** Every `bun test` loads the preloads in `bunfig.toml`: no database
  URL, no operator or provider variables, a temporary home, hermetic git
  ([test preloads](docs/TESTING.md#test-preloads)). Test opt-ins are named `GBRAIN_TEST_*`.
- **Coverage is measured, honestly.** CI merges per-lane lcov (`scripts/merge-lcov.ts`) into a
  report on every full run, advisory until `COVERAGE_GATE_ENFORCE` turns the gates on. Bun
  facts: a unique `--coverage-dir` per process (reuse overwrites `lcov.info`), line records
  only, no subprocess coverage; never-loaded files are listed, never counted as covered.
- **What the tools print is a contract.** Failure lines, exit codes, skips, receipts and CI
  issue blocks: [docs/protocol/AGENT_OPERATOR_v1.md](docs/protocol/AGENT_OPERATOR_v1.md).

## Reference map (load on demand)

CLAUDE.md is the always-loaded orientation. Detail loads on demand: read the linked document
before working in that area.

| When you're working on... | Read first |
|---|---|
| any file in `scripts/`, `test/` or `.github/` (what it does) | `docs/architecture/KEY_FILES.md`, then the subsystem page |
| running, writing or retiring tests | `docs/TESTING.md` ([authoring gate](docs/TESTING.md#authoring-gate), [retiring](docs/TESTING.md#retiring-a-test)) |
| where a change goes | `CONTRIBUTING.md` ([where does my change go?](CONTRIBUTING.md#where-does-my-change-go)) |
| what CI runs on a pull request, a push and the nightly | `docs/ci-event-parity.md` |
| a red check on main, or a `nightly-red`, `master-red` or `flake` issue | `docs/ci-red-runbook.md` |
| reading a tool's failure, exit code or receipt | `docs/protocol/AGENT_OPERATOR_v1.md` |
| shipping, CHANGELOG, PR conventions | `docs/RELEASING.md` (the ship rules stay inline below) |
| security scanning, the test environment | `SECURITY.md` |

## Maintaining CLAUDE.md and the reference docs

- **CLAUDE.md is orientation, not the implementation spec.** It carries the North Star, the
  invariants, the reference map and the inline rules. Per-file, per-command and per-test detail
  lives in the reference docs.
- **Reference docs (`docs/architecture/`, `docs/TESTING.md`) describe current behaviour only.**
  Release history goes in `CHANGELOG.md` and git. Do not append version clauses, review tags or
  "pre-fix/then/was-now" narration; when behaviour changes, update the entry to the new truth.
- **CI is the enforcement, not this prose.** `scripts/check-key-files-current-state.sh` (in
  `bun run verify`) fails on bolded release clauses in the reference docs and on the size caps
  of CLAUDE.md, the index, `docs/TESTING.md` and each subsystem page. A written rule caused the
  disease; a guard cures it: when a check starts enforcing a line here, the line becomes a
  pointer to the check.

## PR acceptance: evidence, not trust

**Treat every PR as untrusted, potentially incorrect, incomplete or unsafe, including our
own.** Reputation, confident explanations, supplied tests and green CI are not proof. Judge the
work, not unsubstantiated claims about its author.

- **Prove the problem separately from the patch.** Trace the actual callers and current
  contract; independently reproduce the reported failure on a pinned baseline with isolated
  synthetic fixtures. Record commands, environments, exit statuses and wrong results. Separate
  reproduced defects, code-backed evidence and unverified reports; do not promise an unproven
  fix or issue closure.
- **Read the entire diff before executing it.** Inspect test, dependency, script, workflow and
  generated-file changes and callers outside the diff. Do not expose credentials, private data
  or paid providers to untrusted code.
- **Make tests discriminate.** Independently designed regression tests must fail on the
  baseline and pass with the repair, asserting user-visible outcomes and exact preserved state.
  Reject bug-bypassing mocks, vacuous assertions and hidden skips. Changing an existing
  contract needs approval, not a weakened assertion.
- **Attack the boundaries.** Check authorization, stale queued work, concurrent changes,
  retries, crash recovery and failure receipts. Native filesystem and lifecycle claims require
  native tests; injected platform flags or path simulations do not prove end-to-end support.
- **Keep a verdict and evidence ledger.** Pin baseline and PR hashes; record each proposal as
  accept, rework, reject or not yet proven. Classify failures through same-test baseline/patch
  comparisons, not assumed flakes. Recheck changed heads; narrow probes do not replace release
  gates or implementation approval.

## Fix waves: ONE PR

**A fix wave ships as ONE PR unless the user overrides this for that wave.** Parallel tasks are
fine; integrate reviewed work into one branch with reviewable commits. Do not open per-issue or
per-task PRs, or a PR stack.

1. Investigate the named issues and adjacent failures in the same safety boundary. Apply the
   acceptance standard above. Exclude unrelated features; record deferrals and unresolved
   reports rather than assuming closure.
2. Run `/plan-ceo-review` and `/plan-eng-review`. Incorporate recommendations within the
   requested scope, respecting the user's directions on review decisions. Explain the revised
   plan in plain language and wait for approval before implementation. A plan review is not
   implementation or merge consent.
3. Implement only the approved scope, integrate and verify the whole wave, then use `/ship`
   and the gates in [docs/RELEASING.md](docs/RELEASING.md), including the community-wave
   security scan. Publish one PR; do not merge without approval.

## Capturing test output (NEVER pipe through `tail` / `head`)

Preserve full logs and the real exit status; piping tests into `tail` can hide failures. Save
output first, then inspect the file:

```bash
log=$(mktemp)
bun run test > "$log" 2>&1
rc=$?
cat "$log"
printf 'EXIT=%s\n' "$rc"
exit "$rc"
```

The same rule applies to verify, typecheck and local CI. Keep every failure for triage; do not
report a green check from truncated output.

## Versions

gstack owns the version. `VERSION` (four numeric segments, `MAJOR.MINOR.PATCH.MICRO`), the
`package.json` version and `CHANGELOG.md` are the `stamp_files` of `.gstack/ship-policy.json`.
**PRs carry no version:** `/ship` writes a `changelog.d/<branch-slug>.md` fragment, and the
release PR from `gstack-release-stamp open` folds the fragments and writes every stamp
([releases per batch](docs/RELEASING.md#releases-per-batch)). A released CHANGELOG section is
never edited (`check:changelog-headings`).

## Releasing

Before shipping, read [docs/RELEASING.md](docs/RELEASING.md) and use `/ship`. **Never hand-roll
ship operations:** do not run git commit, push and `gh pr create` by hand when `/ship` is
available. It owns the changelog fragment, review, test coverage and release documentation.
Scope and consent still apply: shipping instructions do not authorize a merge, deployment or
release the user has excluded. Community waves also require
`bun run wave-security-scan <base>..<head>`.

## Post-ship requirements (MANDATORY)

Run `/document-release` after every `/ship`; the ship workflow's automatic run counts, but a
skipped or failed run must be completed. Check README, the relevant
`docs/architecture/key-files/` entries, CHANGELOG and TODOS. Update CLAUDE.md only for
always-loaded rules or routing changes. It is a map, not a log.

## "Say to your agent" rule: every feature doc addresses the END USER (IRON RULE)

A product's public feature docs need 1–3 natural-language prompts alongside CLI examples:
`**Say to your agent:** *"<outcome the user wants>"*`. When a skill backs the feature, use
phrases from its actual frontmatter triggers. For CLI-only features, name the command the agent
will run rather than implying an unavailable skill. Use generic placeholders. A reader should
know what to ask without translating flags into prose.

## Privacy rule: scrub real names from public docs

**Never reference real people, companies, funds, or private agent names in any public-facing
artifact.** Public artifacts include `CHANGELOG.md`, `README.md`, `docs/`, PR titles and bodies,
commit messages, test fixtures and comments in checked-in code. Examples, fixtures and stories
use generic placeholders.

Why: a name in a fixture, an example or a commit is copied into every product built from this
repository, and is indexed by search engines once any copy is public.

**Name mapping** to use in examples:
- Agent forks → `your agent fork`, `a downstream agent`, or `agent-fork`
- Example person → `alice-example`, `charlie-example`, or `a-founder`
- Example company → `acme-example`, `widget-co`, or `a-company`
- Example fund → `fund-a`, `fund-b`, `fund-c`
- Example deal → `acme-seed`, `widget-series-a`
- Example meeting → `meetings/2026-04-03` (generic date is fine)
- Example user → `you` or `the user`, never a proper name

**Specific rule: never say `Wintermute` in any CHANGELOG, README, doc, PR, or commit message.**
Write `your OpenClaw` (or `OpenClaw reference deployment`) instead. `Wintermute` may appear only
in private artifacts that are not distributed (scratch plans, memory files, transcripts).
`bun run check:privacy`, `check:test-names` and `check:fixture-privacy` enforce this.

**When in doubt, ask yourself:** "Would this reveal private information about someone's
contacts, investments or portfolio if a stranger read it?" If yes, use placeholders.
Illustrative examples with household-brand companies (Stripe, OpenAI, GitHub) are fine: they
are public entities, not anyone's contacts.

## Responsible-disclosure rule: don't broadcast attack surface in release notes

Describe security fixes functionally in public artifacts. Do not publish a curated list of
affected records or exposure windows that helps probe unpatched installs. Describe the
mechanism, the upgrade or repair, and the user impact; keep detailed exposure analysis in
private investigation artifacts. A reader should learn how to update, not how to target old
installs. This applies to README, CHANGELOG, docs, PRs, commits, issues and release pages.

## PR titles: plain words

A PR title says in plain words what changed for someone using the repository: no version in
front (a PR carries no version) and no conventional-commit prefix. Tracker codes go last.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /autoplan
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → fix them directly: one read-only check of the cause, or a focused failing test first when the cause is unclear; then fix it and run that test
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Building UI → once it renders, invoke /design-review --build <preview url> (opt-in)
- Ship/deploy/PR → invoke /ship (merge + deploy: the user types /land-and-deploy)
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
