import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';

// Full CI on pull requests (docs/ci-event-parity.md#full-ci-on-pull-requests):
// a pull request runs the cheap tier, the full-ci dispatch runs the full suite
// on its head, and a master push may reuse a passed full-suite run of its tree.
type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; 'continue-on-error'?: boolean; env?: Record<string, string>; with?: Record<string, string> };
type Job = { if?: string; name?: string; needs?: string[] | string; outputs?: Record<string, string>; permissions?: Record<string, string>; steps?: Step[] };
type Workflow = { on: Record<string, { types?: string[]; branches?: string[] } | null>; permissions?: unknown; jobs: Record<string, Job> };
const root = join(import.meta.dir, '../..');
const workflow = (name: string) => load(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow;
const unit = workflow('test.yml');
const dispatcher = workflow('full-ci.yml');

type Context = { event: string; inputs?: Record<string, unknown>; outputs?: Record<string, string>; action?: string; label?: string; pr?: Record<string, unknown>;
  verdicts?: Record<string, string>; changes?: string };
function evaluate(expression: string, context: Context): unknown {
  const js = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/needs\.(\w+(?:-\w+)+)\./g, (_, job) => `needs['${job}'].`)
    .replace(/outputs\.(\w+(?:-\w+)+)/g, (_, key) => `outputs['${key}']`)
    .replace(/labels\.\*\.name/g, 'labels.map(label => label.name)');
  const outputs = { reuse: '', ...context.outputs };
  return runInNewContext(js, {
    always: () => true,
    cancelled: () => false,
    contains: (list: unknown[], item: unknown) => list.includes(item),
    format: (f: string, ...a: unknown[]) => f.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)])),
    vars: { DEVMODEL_PAID_LANES: '' },
    github: { event_name: context.event, repository: 'acme-example/gbrain',
      event: { action: context.action, label: { name: context.label }, pull_request: context.pr ?? {} } },
    inputs: context.inputs ?? {},
    needs: { changes: { outputs, result: context.changes ?? 'success' }, 'dynamic-ci': { outputs: context.verdicts ?? {} } },
  }, { timeout: 100 });
}
const template = (value: string, context: Context) => value.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => String(evaluate(expression.trim(), context)));
const runs = (w: Workflow, context: Context) =>
  Object.entries(w.jobs).filter(([, job]) => !job.if || Boolean(evaluate(job.if, context))).map(([name]) => name).sort();
const step = (job: Job, name: string) => job.steps!.find(s => s.name === name)!;
const bash = (script: string, env: Record<string, string>, cwd = root) =>
  spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

const CHEAP = ['changes', 'cheap-tier', 'dependency-audit', 'executed-receipts', 'gitleaks', 'stress-changed-tests', 'typecheck', 'verify'];
const FULL_ONLY = ['serial-tests', 'test', 'e2e', 'coverage-report', 'test-status', 'full-suite'];

describe('full CI on pull requests', () => {
  test('a pull request runs exactly the cheap tier; every other event runs the full profile', () => {
    expect(runs(unit, { event: 'pull_request' })).toEqual([...CHEAP, 'dynamic-ci'].sort());
    for (const event of ['push', 'merge_group', 'schedule', 'workflow_dispatch']) {
      const full = runs(unit, { event });
      for (const job of FULL_ONLY) expect(full, `${event}: ${job}`).toContain(job);
      expect(full).not.toContain('cheap-tier');
      expect(full).not.toContain('dynamic-ci');
    }
  });

  // Trunk Dynamic CI (docs/ci-event-parity.md#trunk-dynamic-ci): the filter runs only on pull requests, so every other event
  // sees empty verdicts and runs every gated job; on a pull request only an exact 'false' skips a job, and a gated job still
  // waits for its other needs to succeed.
  test('Dynamic CI skips a gated pull-request lane only on an exact false verdict and never filters another event', () => {
    const gated = Object.keys(unit.jobs['dynamic-ci']!.outputs!).sort();
    expect(gated).toEqual(['stress-changed-tests']);
    const all = runs(unit, { event: 'pull_request' });
    for (const verdict of ['', 'true']) {
      expect(runs(unit, { event: 'pull_request', verdicts: Object.fromEntries(gated.map(job => [job, verdict])) }), verdict).toEqual(all);
    }
    for (const job of gated) {
      expect(runs(unit, { event: 'pull_request', verdicts: { [job]: 'false' } }), job).toEqual(all.filter(name => name !== job));
    }
    for (const event of ['push', 'merge_group', 'schedule', 'workflow_dispatch']) {
      expect(Boolean(evaluate(unit.jobs['dynamic-ci']!.if!, { event })), event).toBe(false);
      for (const job of gated) expect(runs(unit, { event }), `${event}: ${job}`).toContain(job);
    }
  });

  test('a pull-request run never reports test-status or full-suite under any name', () => {
    for (const job of ['test-status', 'full-suite']) {
      expect(template(unit.jobs[job]!.name!, { event: 'pull_request' })).toBe('full-suite-not-run');
      for (const event of ['push', 'merge_group', 'schedule', 'workflow_dispatch']) {
        expect(template(unit.jobs[job]!.name!, { event, inputs: event === 'workflow_dispatch' ? { stress_files: '', stress_base: '' } : {} })).toBe(job);
      }
    }
    expect(unit.jobs['cheap-tier']!.name).toBe('cheap-tier (full suite not run)');
    expect(unit.jobs['full-suite']!.needs).toContain('test-status');
  });

  test.each([['test.yml', 'full-suite', 'TEST_STATUS', 'Require test-status']])(
    '%s %s succeeds only when its aggregate succeeded on the same run', (file, job, variable, name) => {
      const require = step(workflow(file).jobs[job]!, name);
      for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
        expect(bash(require.run!, { [variable]: result }).status, result).toBe(result === 'success' ? 0 : 1);
      }
    });

  test('the full-suite artifact records the tree the run checked out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devmodel-full-suite-tree-'));
    try {
      const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      git('add', 'a.txt');
      git('commit', '-qm', 'a');
      const out = join(dir, 'out');
      const result = bash(`bash ${join(root, 'scripts/ci-full-suite-tree.sh')}`,
        { ARTIFACT_DIR: out, RUN_ID: '42', RUN_ATTEMPT: '2', WORKFLOW: 'Test', EVENT: 'workflow_dispatch', GITHUB_STEP_SUMMARY: join(dir, 'summary.md') }, dir);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(out, 'tree.json'), 'utf8'))).toEqual({
        tree: git('rev-parse', 'HEAD^{tree}').stdout.trim(), sha: git('rev-parse', 'HEAD').stdout.trim(),
        workflow: 'Test', event: 'workflow_dispatch', run_id: 42, run_attempt: 2, profile: 'full',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const [w, job, artifact] of [[unit, 'full-suite', 'full-suite-tree']] as const) {
      const upload = w.jobs[job]!.steps!.find(s => s.uses?.startsWith('actions/upload-artifact@'))!;
      expect(upload.with).toMatchObject({ name: artifact, overwrite: true });
      expect(step(w.jobs[job]!, 'Record the tested tree').run).toBe('bash scripts/ci-full-suite-tree.sh');
    }
  });

  test('tree.json lists the executed test files only from a complete manifest of the same run, attempt and commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devmodel-full-suite-files-'));
    try {
      const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      git('add', 'a.txt');
      git('commit', '-qm', 'a');
      const sha = git('rev-parse', 'HEAD').stdout.trim();
      const manifest = (over: Record<string, unknown> = {}) => ({
        schema: 'devmodel-ci-manifest/v1', workflow: 'Test', event: 'workflow_dispatch', sha, run_id: 42, run_attempt: 2, complete: true, problems: [],
        files: [
          { file: 'test/b.test.ts', lane: 'unit', arm: '', executed: 3, failed: 0, skipped: 1 },
          { file: 'test/a.test.ts', lane: 'unit', arm: '', executed: 2, failed: 0, skipped: 0 },
          { file: 'test/a.test.ts', lane: 'pg-arms-bun-1.4.4', arm: 'postgres', executed: 2, failed: 0, skipped: 0 },
          { file: 'test/e2e/c.test.ts', lane: 'e2e', arm: '', executed: 0, failed: 0, skipped: 4 },
          { file: 'verify', lane: 'verify', arm: '', executed: 1, failed: 0, skipped: 0 },
        ],
        failures: [], ...over,
      });
      const record = (doc: unknown) => {
        const path = join(dir, 'ci-manifest.json');
        if (doc === undefined) rmSync(path, { force: true }); else writeFileSync(path, JSON.stringify(doc));
        const out = join(dir, 'out');
        const result = bash(`bash ${join(root, 'scripts/ci-full-suite-tree.sh')}`,
          { ARTIFACT_DIR: out, RUN_ID: '42', RUN_ATTEMPT: '2', WORKFLOW: 'Test', EVENT: 'workflow_dispatch', MANIFEST: path, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') }, dir);
        expect(result.status, result.stderr).toBe(0);
        return { tree: JSON.parse(readFileSync(join(out, 'tree.json'), 'utf8')), stdout: result.stdout };
      };
      const base = { tree: git('rev-parse', 'HEAD^{tree}').stdout.trim(), sha, workflow: 'Test', event: 'workflow_dispatch', run_id: 42, run_attempt: 2, profile: 'full' };
      expect(record(manifest()).tree).toEqual({ ...base, files: ['test/a.test.ts', 'test/b.test.ts', 'test/e2e/c.test.ts'], tests: 8 });
      for (const [doc, why] of [
        [undefined, 'no ci-manifest.json from this run'],
        [manifest({ run_attempt: 1 }), 'belongs to run 42 attempt 1, not run 42 attempt 2 (re-run the whole workflow, not only its failed jobs)'],
        [manifest({ run_id: 41 }), 'belongs to run 41 attempt 2'],
        [manifest({ sha: 'f'.repeat(40) }), `belongs to commit ${'f'.repeat(40)}`],
        [manifest({ complete: false, problems: ['unit shard 3 has no receipt'] }), 'is incomplete: unit shard 3 has no receipt'],
        [manifest({ schema: 'other/v0' }), 'has schema other/v0'],
        [manifest({ files: [{ file: 'verify', lane: 'verify', arm: '', executed: 1, failed: 0, skipped: 0 }] }), 'lists no test file'],
        [manifest({ files: null }), 'has no readable files list'],
      ] as const) {
        const { tree, stdout } = record(doc);
        expect(tree).toEqual(base);
        expect(stdout).toContain(`::warning::tree.json records no executed test files: `);
        expect(stdout).toContain(why);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const [w, job] of [[unit, 'full-suite']] as const) {
      expect(w.jobs[job]!.needs).toContain('executed-receipts');
      const steps = w.jobs[job]!.steps!;
      const download = steps.findIndex(s => s.name === 'Download the execution manifest');
      expect(steps[download]!.with).toMatchObject({ name: 'ci-manifest', path: '${{ runner.temp }}/ci-manifest' });
      expect(steps[download]!['continue-on-error']).toBe(true);
      expect(download).toBeLessThan(steps.findIndex(s => s.name === 'Record the tested tree'));
      expect(step(w.jobs[job]!, 'Record the tested tree').env!.MANIFEST).toBe('${{ runner.temp }}/ci-manifest/ci-manifest.json');
      const ledger = w.jobs['executed-receipts']!.steps!.find(s => s.run?.includes('scripts/ci-manifest.ts'))!;
      expect(ledger.run).toContain('--out "$RUNNER_TEMP/ci-manifest.json"');
    }
  });

  test('the full-ci label dispatches Test on a same-repository head', () => {
    expect(dispatcher.on.pull_request).toEqual({ branches: ['main'], types: ['labeled', 'synchronize', 'reopened'] });
    expect(dispatcher.permissions).toEqual({});
    const job = dispatcher.jobs.dispatch!;
    expect(job.permissions).toEqual({ actions: 'write', contents: 'read' });
    const own = { head: { repo: { full_name: 'acme-example/gbrain' } } };
    const fork = { head: { repo: { full_name: 'fork-a/gbrain' } } };
    const labels = (...names: string[]) => names.map(name => ({ name }));
    const cases: Array<[Context, boolean]> = [
      [{ event: 'pull_request', action: 'labeled', label: 'full-ci', pr: { ...own, labels: labels('full-ci') } }, true],
      [{ event: 'pull_request', action: 'labeled', label: 'docs', pr: { ...own, labels: labels('docs', 'full-ci') } }, false],
      [{ event: 'pull_request', action: 'synchronize', pr: { ...own, labels: labels('full-ci') } }, true],
      [{ event: 'pull_request', action: 'reopened', pr: { ...own, labels: labels('full-ci') } }, true],
      [{ event: 'pull_request', action: 'synchronize', pr: { ...own, labels: labels('docs') } }, false],
      [{ event: 'pull_request', action: 'labeled', label: 'full-ci', pr: { ...fork, labels: labels('full-ci') } }, false],
      [{ event: 'pull_request', action: 'synchronize', pr: { ...fork, labels: labels('full-ci') } }, false],
    ];
    for (const [context, expected] of cases) expect(Boolean(evaluate(job.if!, context)), JSON.stringify(context)).toBe(expected);
    const run = job.steps![0]!.run!;
    expect(run).toContain('gh workflow run test.yml -R "$REPO" --ref "$BRANCH"');
    expect(run.indexOf('"$current" != "$HEAD_SHA"')).toBeLessThan(run.indexOf('gh workflow run'));
  });

  describe('cheap-tier aggregator', () => {
    const green = { CHANGES: 'success', GITLEAKS: 'success', AUDIT: 'success', VERIFY: 'success', TYPECHECK: 'success', STRESS: 'success' };
    const aggregate = (env: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), 'devmodel-cheap-tier-'));
      try {
        const summary = join(dir, 'summary.md');
        const result = bash(`bash ${join(root, 'scripts/ci-cheap-tier.sh')}`, { ...env, GITHUB_STEP_SUMMARY: summary });
        return { status: result.status, summary: readFileSync(summary, 'utf8') };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test('green when every cheap lane passed; the summary always says the full suite did not run', () => {
      const result = aggregate(green);
      expect(result.status).toBe(0);
      expect(result.summary).toContain('## Full suite not run');
      expect(result.summary).toContain('`full-suite`');
    });

    test.each(['CHANGES', 'GITLEAKS', 'AUDIT', 'VERIFY', 'TYPECHECK', 'STRESS'])('%s not succeeding fails the tier', lane => {
      for (const result of ['failure', 'cancelled', 'skipped', '']) {
        expect(aggregate({ ...green, [lane]: result }).status, `${lane}=${result}`).toBe(1);
      }
    });

    test.each([['STRESS', 'DCI_STRESS']] as const)('%s may skip only when Trunk Dynamic CI said false', (lane, verdict) => {
      expect(aggregate({ ...green, [lane]: 'skipped', [verdict]: 'false' }).status).toBe(0);
      for (const other of ['', 'true']) expect(aggregate({ ...green, [lane]: 'skipped', [verdict]: other }).status, other).toBe(1);
      expect(aggregate({ ...green, [lane]: 'failure', [verdict]: 'false' }).status).toBe(1);
    });

    test('a failed changes job fails the tier even when Trunk said false for every gated lane', () => {
      expect(aggregate({ ...green, CHANGES: 'failure', STRESS: 'skipped', DCI_STRESS: 'false' }).status).toBe(1);
    });
  });
});

describe('master-push reuse of a passed full-suite run', () => {
  test('only a push computes reuse, and a crash leaves it unset (a full run)', () => {
    for (const [w, job] of [[unit, 'changes']] as const) {
      const reuse = w.jobs[job]!.steps!.find(s => s.id === 'reuse')!;
      expect(reuse.if).toBe("github.event_name == 'push'");
      expect(reuse['continue-on-error']).toBe(true);
      expect(reuse.run).toContain('--workflow test');
      expect(w.jobs[job]!.permissions).toMatchObject({ actions: 'read', contents: 'read' });
    }
  });

  test('a reusing push skips every full lane and the aggregate, and runs the reuse marker', () => {
    const reused = runs(unit, { event: 'push', outputs: { reuse: 'true' } });
    expect(reused).toContain('reused-full-suite');
    for (const job of [...FULL_ONLY, 'executed-receipts']) expect(reused, job).not.toContain(job);
    const full = runs(unit, { event: 'push' });
    expect(full).not.toContain('reused-full-suite');
    for (const job of FULL_ONLY) expect(full, job).toContain(job);
  });
});
