/**
 * .github/workflows/fix-wave-gate.yml + scripts/fix-wave-gate.ts — the contributor gate.
 *
 * Protects: contributor PRs into main fail unless the head repository is
 * the repository the workflow runs in (GITHUB_REPOSITORY) or a human on the
 * `maintainers` list of .gstack/ship-policy.json applied `maintainer-override`;
 * same-repo heads always pass; a PR cannot change its own result
 * by editing the workflow or script. Regressions it catches: trusting a branch
 * name instead of the head repository, a bot or non-maintainer override, a
 * null head.repo passing, the workflow growing a PR checkout or a
 * pull_request trigger that would run the PR's own copy.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import {
  COMMENT_MARKER, OVERRIDE_LABEL, decide, gateMessage, readMaintainers, runGate,
  type GateClient, type GateEvent, type TimelineEvent,
} from '../../scripts/fix-wave-gate.ts';
import { withEnv } from '../helpers/with-env.ts';

const ROOT = join(import.meta.dir, '..', '..');
// The workflow runs in this repository (Actions sets GITHUB_REPOSITORY); the fixtures' same-repo PRs come from it.
const IN_REPO = { GITHUB_REPOSITORY: 'acme-example/gbrain' };
const MAINTAINERS = ['maintainer-example'];
const FIXTURES = join(ROOT, 'test', 'fixtures', 'fix-wave-gate');
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as GateEvent;
const labeled = (login: string, type: string, id: number): TimelineEvent =>
  ({ id, event: 'labeled', label: { name: OVERRIDE_LABEL }, actor: { login, type }, created_at: `2026-10-05T0${id}:00:00Z` });

function fakeClient(timeline: TimelineEvent[] = [], comments: string[] = []) {
  const calls: string[] = [];
  const client: GateClient = {
    labelEvents: async () => { calls.push('labelEvents'); return timeline; },
    commentBodies: async () => { calls.push('commentBodies'); return comments; },
    createComment: async (_pr, body) => { calls.push('createComment'); comments.push(body); },
  };
  return { client, calls, comments };
}
async function gate(event: GateEvent, client: GateClient, mode: 'gate' | 'comment' = 'gate') {
  const lines: string[] = [];
  const summary: string[] = [];
  const code = await withEnv(IN_REPO, () => runGate(event, client, { line: s => lines.push(s), summary: s => summary.push(s) }, mode, MAINTAINERS));
  return { code, out: lines.join('\n'), summary: summary.join('') };
}

describe('fix-wave gate decision', () => {
  test('a fork PR with a GBRA-looking branch name fails with the fix-wave message', async () => {
    const { client, calls } = fakeClient();
    const r = await gate(load('fork-gbra-branch.opened.json'), client);
    expect(r.code).toBe(1);
    expect(r.out).toContain('The work is welcome, and this PR stays open.');
    expect(r.out).toContain('Contributed by @alice-example');
    expect(r.out).toContain('Co-Authored-By:');
    expect(r.out).toContain('CONTRIBUTING.md#where-does-my-change-go');
    expect(r.summary).toContain('fail (fork)');
    expect(calls).toEqual([]);
  });

  test('a same-repo head (a GBRA thread capy/* branch) passes without any API call', async () => {
    const { client, calls } = fakeClient();
    const r = await gate(load('same-repo.synchronize.json'), client);
    expect(r.code).toBe(0);
    expect(r.summary).toContain('pass (same_repo)');
    expect(calls).toEqual([]);
  });

  test('the override label passes only when a human maintainer applied it, and the run log names who', async () => {
    const event = load('fork-override.labeled.json');
    const ok = await gate(event, fakeClient([labeled('maintainer-example', 'User', 1)]).client);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('::notice title=Fix-wave gate override::');
    expect(ok.out).toContain(`${OVERRIDE_LABEL} applied by @maintainer-example (User) at 2026-10-05T01:00:00Z (timeline event 1)`);

    for (const actor of [['capy-ai[bot]', 'Bot'], ['github-actions[bot]', 'Bot'], ['alice-example', 'User'], ['maintainer-example[bot]', 'User'], ['maintainer-example', 'Bot']] as const) {
      const r = await gate(event, fakeClient([labeled(actor[0], actor[1], 2)]).client);
      expect(r.code, actor[0]).toBe(1);
      expect(r.summary).toContain('override_not_by_maintainer');
    }
    const relabeledByBot = await gate(event, fakeClient([
      labeled('maintainer-example', 'User', 1),
      { id: 2, event: 'unlabeled', label: { name: OVERRIDE_LABEL }, actor: { login: 'maintainer-example', type: 'User' } },
      labeled('capy-ai[bot]', 'Bot', 3),
    ]).client);
    expect(relabeledByBot.code).toBe(1);
    const noTimeline = await gate(event, fakeClient([]).client);
    expect(noTimeline.code).toBe(1);
  });

  test('removing the label fails again even though the timeline still shows the old override', () => {
    const event = load('fork-override.labeled.json');
    event.pull_request!.labels = [];
    expect(decide(event, [labeled('maintainer-example', 'User', 1)], MAINTAINERS)).toMatchObject({ pass: false, reason: 'fork' });
  });

  test('a null head repository fails closed', async () => {
    const r = await gate(load('deleted-fork.synchronize.json'), fakeClient().client);
    expect(r.code).toBe(1);
    expect(r.summary).toContain('head_repo_missing');
    expect(decide({}, [], MAINTAINERS).pass).toBe(false);
  });

  test('a timeline read failure fails closed', async () => {
    const client: GateClient = { ...fakeClient().client, labelEvents: async () => { throw new Error('HTTP 502'); } };
    const r = await gate(load('fork-override.labeled.json'), client);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not read the PR timeline');
  });

  test('the welcome comment posts once on a contributor PR and never on a same-repo PR', async () => {
    const fake = fakeClient();
    const first = await gate(load('fork-gbra-branch.opened.json'), fake.client, 'comment');
    expect(first.code).toBe(0);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]).toBe(gateMessage('alice-example', IN_REPO.GITHUB_REPOSITORY));
    expect(fake.comments[0].startsWith(COMMENT_MARKER)).toBe(true);
    await gate(load('fork-gbra-branch.opened.json'), fake.client, 'comment');
    expect(fake.comments).toHaveLength(1);
    const same = fakeClient();
    await gate(load('same-repo.synchronize.json'), same.client, 'comment');
    expect(same.calls).toEqual([]);
  });

  test('the maintainer allowlist is the maintainers array of the ship policy; a missing file or key is an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-wave-gate-policy-'));
    try {
      const policy = (body: string) => { const path = join(dir, 'ship-policy.json'); writeFileSync(path, body); return path; };
      expect(readMaintainers(policy('{"maintainers":["alice-example","bob-example"]}'))).toEqual(['alice-example', 'bob-example']);
      expect(readMaintainers(policy('{"maintainers":["alice-example",7,""]}'))).toEqual(['alice-example']);
      expect(readMaintainers(policy('{"maintainers":"alice-example"}'))).toEqual([]);
      expect(readMaintainers(policy('{}'))).toEqual([]);
      expect(readMaintainers(policy('not json'))).toEqual([]);
      expect(readMaintainers(join(dir, 'absent.json'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no maintainer on the policy nobody can override, and a repository other than the workflow\'s is never trusted', async () => {
    const event = load('fork-override.labeled.json');
    const none = await withEnv(IN_REPO, async () => decide(event, [labeled('maintainer-example', 'User', 1)], readMaintainers(join(ROOT, 'no-such-policy.json'))));
    expect(none).toMatchObject({ pass: false, reason: 'override_not_by_maintainer' });
    const elsewhere = await withEnv({ GITHUB_REPOSITORY: 'other-example/gbrain' }, async () => decide(load('same-repo.synchronize.json'), [], MAINTAINERS));
    expect(elsewhere).toMatchObject({ pass: false, reason: 'fork' });
    const unset = await withEnv({ GITHUB_REPOSITORY: undefined }, async () => decide(load('same-repo.synchronize.json'), [], MAINTAINERS));
    expect(unset.pass).toBe(false);
  });
});

describe('fix-wave gate workflow', () => {
  const text = readFileSync(join(ROOT, '.github', 'workflows', 'fix-wave-gate.yml'), 'utf8');
  type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
  const wf = loadYaml(text) as { on: Record<string, { branches: string[]; types: string[] }>; permissions: unknown; jobs: Record<string, { permissions: Record<string, string>; steps: Step[]; if?: string }> };

  test('a PR that edits the workflow or the gate script cannot change its own result', async () => {
    // pull_request_target runs the default-branch copy of both files; a pull_request trigger would run the PR's copy.
    expect(Object.keys(wf.on)).toEqual(['pull_request_target']);
    expect(wf.on.pull_request_target.branches).toEqual(['main']);
    expect([...wf.on.pull_request_target.types].sort()).toEqual(['edited', 'labeled', 'opened', 'reopened', 'synchronize', 'unlabeled']);
    for (const job of Object.values(wf.jobs)) {
      const checkout = job.steps.find(s => s.uses?.startsWith('actions/checkout@'))!;
      expect(checkout.with).toEqual({ 'persist-credentials': false, 'sparse-checkout': 'scripts/fix-wave-gate.ts\n.gstack/ship-policy.json\n', 'sparse-checkout-cone-mode': false });
    }
    expect(text).not.toMatch(/pull_request\.head|refs\/pull|head\.sha|head_ref|\bref:/);
    for (const job of Object.values(wf.jobs)) for (const s of job.steps) expect(s.run ?? '').not.toContain('${{');
    // The decision never reads the PR's files, so a fork PR that rewrites the gate still fails.
    expect((await gate(load('fork-edits-gate.synchronize.json'), fakeClient().client)).code).toBe(1);
  });

  test('permissions are minimal, actions are pinned by SHA and the script needs no dependencies', () => {
    expect(wf.permissions).toEqual({});
    expect(wf.jobs['contributor-gate'].permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(wf.jobs['welcome-comment'].permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    expect(wf.jobs['welcome-comment'].if).toBe("github.event.action == 'opened'");
    for (const job of Object.values(wf.jobs)) for (const s of job.steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    const script = readFileSync(join(ROOT, 'scripts', 'fix-wave-gate.ts'), 'utf8');
    const imports = [...script.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    expect(imports.every(i => i.startsWith('node:'))).toBe(true);
  });

  test('the CLI entry decides offline from an event payload', () => {
    const run = (name: string) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'fix-wave-gate.ts'), '--event', join(FIXTURES, name)], {
      encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_API_URL: 'http://127.0.0.1:9', ...IN_REPO },
    });
    const same = run('same-repo.synchronize.json');
    expect(same.status).toBe(0);
    expect(same.stdout).toContain('Pass.');
    const fork = run('fork-edits-gate.synchronize.json');
    expect(fork.status).toBe(1);
    expect(fork.stdout).toContain('::error title=Fix-wave gate::');
  });
});
