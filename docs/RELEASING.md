# Releasing

gstack ships, lands and releases this repository: `/ship` opens the pull request,
`gstack-ship-queue land` merges it, `gstack-release-stamp open` opens a release PR. Their
rules are gstack's documents, linked from each section below. This page holds what this
repository sets for them and the repository's own CI mechanisms that its tools link to.
Use `/ship`; never hand-roll a release.

[ship-policy]: https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md

## Ship policy

`.gstack/ship-policy.json` ([schema][ship-policy]):

| Key | Value here | gstack |
|---|---|---|
| `bump` | `patch` | [schema](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#schema-v1) |
| `queue_mode` | `stamp-at-merge` | [stamp-at-merge](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#stamp-at-merge) |
| `merge` | `direct` | [land --pin](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#land-direct) |
| `land.merged_checks` | `bun run typecheck`, `bun run verify` | [land --pin](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#land-direct) |
| `changelog_fragments` | `changelog.d` | [changelog fragments](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#changelog-fragments) |
| `changelog`, `stamp_files` | `CHANGELOG.md`; `VERSION`, `package.json`, `CHANGELOG.md` | [release PR](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#release-stamp) |
| `history` | `merge-only` | [schema](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#schema-v1) |
| `review_exclude_paths` | `docs/**` | [review_exclude_paths](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#review-exclude-paths) |
| `maintainers` | none | [schema](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#schema-v1); also read by the [fix-wave gate](#fix-wave-gate) |
| `min_gstack_version` | `1.98.0.0` | [schema](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#schema-v1) |

`.gstack/pregate.json`: [pregate](https://github.com/garrytan/gstack/blob/main/docs/pregate.md).
`gstack-ship-policy validate` checks the policy against the installed gstack.

## Before shipping

`bun run verify` (guards and typecheck) before every push. The full run is
`bun run test:full`: verify, then the unit, slow and E2E lanes. `bun run ci:local`
runs CI's lanes on this machine. The lanes and their runners: [TESTING.md](TESTING.md).

## Releases per batch

A pull request carries its CHANGELOG entry as `changelog.d/<branch-slug>.md`, which
`/ship` writes, and never edits the `stamp_files`. A release PR from
`gstack-release-stamp open` gives every fragment on main one version, and it lands with
`gstack-ship-queue land --pr <n> --pin <head>`
([release PR](https://github.com/garrytan/gstack/blob/main/docs/ship-policy.md#release-stamp)).
No workflow here cuts a tagged release or moves a stable branch; gstack's release cut
does that for a repository that wires it
([releases](https://github.com/garrytan/gstack/blob/main/docs/releases.md)).

## CHANGELOG + VERSION are branch-scoped

A pull request never edits a released CHANGELOG section. `check:changelog-headings`
(in `bun run verify`) fails when `CHANGELOG.md` lacks a release heading the base branch
has.

An entry is release notes for someone using the repository: what they can now do, in
plain words. It names no plan ids, review rounds or decision tags, and puts
contributor-facing changes under `### For contributors` at the bottom.

## Generated artifacts

`bun run regen:all` regenerates every generated artifact offline and keyless and lists
the files it changed; a second run changes nothing. `bun run verify` runs the read-only
half, `check:regen-all`, whose failure names each stale artifact and the same fix. The
artifacts are the `ARTIFACTS` list in `scripts/regen-all.ts` (today the
structural-suites manifest, `scripts/structural-suites.tsv`). Contract goldens are
regenerated only with `--goldens`, and each changed golden needs a reason in the PR body.

## Nightly-red issues

`.github/workflows/nightly-watch.yml` runs `scripts/nightly-issue.ts` after every
scheduled run of a watched workflow and keeps one issue per workflow titled
`Nightly red: <workflow>` (label `nightly-red`). The body lists the failing job and step
pairs, the first red run, the commits since the last green one, the re-check command,
and a "Next step for the agent" block plus a JSON block.

- **Owner:** the agent on release duty owns every open `nightly-red` issue; the
  repository owner is the escalation for owner-only actions (secrets, repository
  settings).
- **Response within 24 hours:** a repair PR, or a row in `.github/nightly-known-red.tsv`
  (its header lists the columns; at most 3 rows, so fix one before adding another; each
  row names the `TODOS.md` entry that owns the fix). A matching row keeps the issue open
  with the `known-red` label; a new failure in the same job opens a new incident; a
  passed review-by date asks for a fix again.
- **Closing:** nightly-watch closes the issue only when a later scheduled run is green
  with complete evidence and every previously failing job executed. A skipped job never
  closes it.
- **Re-check after a fix:** `gh workflow run <workflow>.yml --ref main`, then
  `gh workflow run nightly-watch.yml -f run_id=<that run id>`; add `-f dry_run=true` to
  preview the issue update.
- **Dependency advisories:** pull requests block on `bun audit` only when they change
  `bun.lock`, `patches/` or a `package.json` dependency field, or carry the
  `dependency-audit` label; pushes and scheduled runs always block.

## Master-red issues

nightly-watch keeps one `master-red` issue, `Master red: Test`, for push-to-main runs of
Test; scheduled runs stay in `nightly-red`. The body names each failing job, every
failing test file with its `bun run test:stress` reproduce line, and the suspect range
(last green push SHA, first red SHA, merged PRs). Labels, close rules and recovery:
[CI red runbook](ci-red-runbook.md#ci-issue-labels).

- **Owner:** the agent on release duty, as for `nightly-red`.
- **First response within 1 hour:** a comment or a linked repair PR. The
  [CI health report](ci-red-runbook.md#ci-health-report) measures it; nothing enforces
  it.
- **Response:** a repair PR whose body says `Fixes #<issue>`. Known-red rows never apply
  to push runs.
- **Closing:** nightly-watch closes the issue on a green push run where every previously
  failing job ran and passed with complete evidence. Without a merged repair PR it opens
  `flake` issues.

## Merge queue

`test.yml` carries a `merge_group` trigger, inert until a merge queue is enabled for
`main` in the repository settings (`gh api repos/<owner>/<repo>/rulesets` shows it).
Queue runs use the pull-request profile against the queued merge commit. With the queue
on, `gh pr merge` only enqueues a PR: wait until it is merged
(`gh pr view <n> --json state,mergedAt`) before starting work that depends on it.

## GitHub Actions SHA maintenance

Every action in `.github/workflows/` is pinned to a commit SHA, with its tag in a
comment. Before `/ship` or `/review`, compare each pin with its tag:

```bash
for action in actions/checkout oven-sh/setup-bun actions/cache actions/upload-artifact actions/download-artifact; do
  tag=$(grep -rh "$action@" .github/workflows/ | head -1 | grep -o '#.*' | tr -d '# ')
  [ -n "$tag" ] && echo "$action@$tag: $(gh api repos/$action/git/ref/tags/$tag --jq .object.sha 2>/dev/null)"
done
```

If a SHA differs from the workflow files, update the pin and its comment.

## Community PR wave process

A contributor pull request never merges into main directly. It lands through a fix wave:

1. **Sort** the open PRs by theme. When two fix the same thing, keep the one that
   changes fewer lines and close the other with a note pointing at it.
2. **Collector branch:** a branch of this repository on which the best fixes are
   re-implemented. Never merge a PR branch directly: read the diff and write the fix.
3. **Test the wave** with `bun run test:full`; every fix in it has test coverage.
   `bun run audit:contributors <base>..<collector-head> --prs <manifest>` re-proves, per
   change and per open PR, that its tests fail with its product hunks reversed
   ([contributor audit](TESTING.md#contributor-audit)); paste its table into the wave PR
   body.
4. **Security review:** `bun run wave-security-scan <base>..<collector-head>`. Exit 1
   means read every ALARM row and the context lists and confirm each is benign, not
   "unsafe". Link the result, or a one-line "clean", in the wave PR body; a human still
   reads the diffs.
5. **Close with context:** put each folded-in PR on a `Supersedes #N` line and each fixed
   issue on a `Fixes #N` line of the wave PR body, so the
   [fix-wave closeout](#fix-wave-closeout) and GitHub close them on merge. Write
   `Addresses #N` or `Refs #N` for anything only partly done. Close declined or
   duplicate PRs by hand, with the reason.
6. **Ship as one PR**, keeping every contributor's credit: `Contributed by @<handle>` and
   a `Co-Authored-By:` trailer.

Ask the owner before accepting a change to voice, tone or promotional text (the README
introduction, CHANGELOG voice, skill templates).

### Fix-wave gate

`.github/workflows/fix-wave-gate.yml` (job `contributor-gate`) fails every PR into main
unless its head repository is this repository (`GITHUB_REPOSITORY`) or the
`maintainer-override` label counts, so a fork PR fails whatever its branch is called.
When a contributor PR opens, a second job posts one comment with the same text as the
failure: the work is welcome, and it lands through a fix wave with credit.

The workflow uses `pull_request_target`, so the workflow and `scripts/fix-wave-gate.ts`
always come from the default branch, and a PR that edits either cannot change its own
result. It reads only the event payload and the PR timeline, never PR code.

**`maintainer-override`** counts only when the most recent `labeled` timeline event for
it was made by a human listed in `maintainers` of `.gstack/ship-policy.json` (none here,
so nobody can apply it). Bots never qualify, and removing the label fails the PR again.
The run log and step summary name who applied it, when, and the timeline event id.

**Turning it on** (the owner, in the repository settings): Rules → Rulesets, or the
`main` branch protection rule → require status checks → add `contributor-gate` with
GitHub Actions as the source. The check must have run once on a PR before GitHub offers
it. Until then it is advisory.

**Residual risk:** a branch of this repository that carries contributor commits passes by
design; review keeps contributor work inside a fix wave.

### Fix-wave closeout

`.github/workflows/fix-wave-closeout.yml` (job `close-superseded`) runs when a PR into
main closes. If it merged from this repository, `scripts/fix-wave-closeout.ts` closes
every open pull request named on a `Supersedes #N` line of its body; only the list right
after the keyword counts. Each closed PR gets one comment, keyed by
`<!-- fix-wave-closeout -->`, that thanks the contributor, links the wave, and says the
work landed with credit when the wave body contains `Contributed by @<their handle>`.
Issues and closed PRs are skipped, one run closes at most 50 PRs, and the step summary
lists each number with what happened to it. `Fixes #N` in the same body closes issues
through GitHub. Preview a body without writing anything:
`bun scripts/fix-wave-closeout.ts --event <payload.json> --dry-run`. Like the gate, it
uses `pull_request_target` and never checks out or runs PR code.
