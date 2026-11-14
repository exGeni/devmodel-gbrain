# Key files: per-file index

Read a file's entry before editing it. This page routes to two bounded
subsystem references; **do not load more than the entries you need**.

Find a path's entry:

```bash
rg -n -F 'scripts/run-verify-parallel.sh' docs/architecture/key-files/
```

Edit the subsystem entry, not this page, when behavior changes.
Keep entries current-state: history belongs in CHANGELOG and Git.
Where a new check, workflow, runner script or test goes:
[CONTRIBUTING.md](../../CONTRIBUTING.md#where-does-my-change-go).
`scripts/check-key-files-current-state.sh` guards each page against bolded
release markers and size growth. A full page links its next page from its last
line; never raise the cap.

| Subsystem | Entry range / scope |
|---|---|
| [Tooling And Tests](key-files/tooling-and-tests.md) | `.github/workflows/test.yml` and `stress.yml`, the lane runners, sharding and weights, the stress harness, coverage gates, `test/helpers/` and the tests of that tooling |
| [CI Health And Test Guards](key-files/ci-health-and-test-guards.md) | The other workflows, nightly-watch and the CI health report, the `scripts/ci-*` support scripts, the contributor-audit and fix-wave tools, the `scripts/check-*` guards and the tests of those scripts |
