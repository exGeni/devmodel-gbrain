/**
 * scripts/ci-reuse.ts: a push to main reuses the complete full run of the
 * same workflow (a workflow_dispatch on the PR head, or an earlier push) only
 * when that run's latest attempt and its full-suite job succeeded and its
 * tested-tree artifact (profile full) records the push commit's tree.
 * Pull-request runs (the cheap tier) are never candidates, and a diagnostic
 * dispatch skips full-suite. Every other case (API error, cancelled, partial,
 * re-run in progress, artifact missing or cheap, tree mismatch, non-merge
 * push) falls back to a full run with a reason code. Fixtures only; no network.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { apiDeps, attemptJobs, checkRecord, decide, PROFILES, writeDecision, type Commit, type JobRow, type FullRun, type ReuseDeps } from '../../scripts/ci-reuse.ts';
import { GET_RETRY_DELAYS_MS, restClient, type GitHubClient } from '../../scripts/lib/gh-issue.ts';
import { withEnv } from '../helpers/with-env.ts';

const REPO = 'owner-example/repo-example';
const M = '1'.repeat(40);
const BASE = '2'.repeat(40);
const H = '3'.repeat(40);
const H2 = '4'.repeat(40);
const T = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const prRun = (over: Partial<FullRun> = {}): FullRun => ({
  id: 500, run_number: 50, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: H, event: 'workflow_dispatch',
  head_repository: { full_name: REPO }, ...over,
});
const treeJson = (run: FullRun, over: Record<string, unknown> = {}) => ({ tree: T, sha: run.head_sha, head_sha: run.head_sha, workflow: 'Test', event: run.event, run_id: run.id, run_attempt: run.run_attempt, profile: 'full', ...over });

interface Fixture {
  commits?: Record<string, Commit>;
  runs?: FullRun[];
  jobs?: Record<string, JobRow[]>;
  artifacts?: Record<number, { value?: unknown; reason?: string }>;
  fail?: 'runs' | 'jobs' | 'commit';
}

function fixture(f: Fixture): ReuseDeps & { jobCalls: string[] } {
  const commits = f.commits ?? { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] } };
  const runs = f.runs ?? [];
  const jobCalls: string[] = [];
  return {
    jobCalls,
    async commit(sha) {
      if (f.fail === 'commit' || !commits[sha]) throw new Error(`GitHub API GET git/commits/${sha} -> 404`);
      return commits[sha]!;
    },
    async runsForHead(file, sha) {
      if (f.fail === 'runs') throw new Error('GitHub API GET actions/runs -> 502: bad gateway');
      expect(file).toBe('test.yml');
      return runs.filter(r => r.head_sha === sha);
    },
    async recentSuccessfulRuns() { return runs.filter(r => r.conclusion === 'success'); },
    async jobs(runId, attempt) {
      if (f.fail === 'jobs') throw new Error('GitHub API GET jobs -> 500');
      jobCalls.push(`${runId}/${attempt}`);
      return f.jobs?.[`${runId}/${attempt}`] ?? [{ name: 'full-suite', status: 'completed', conclusion: 'success' }];
    },
    async artifact(runId, name) {
      expect(name).toBe('full-suite-tree');
      return f.artifacts?.[runId] ?? { reason: `run ${runId} has no '${name}' artifact` };
    },
  };
}

const green = (run = prRun()) => fixture({ runs: [run], artifacts: { [run.id]: { value: treeJson(run) } } });

/** A one-file zip archive, as GitHub serves an artifact. */
function zipOf(name: string, content: string): Uint8Array {
  const data = Buffer.from(content), body = deflateRawSync(data), file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + file.length, 12); end.writeUInt32LE(30 + file.length + body.length, 16);
  return new Uint8Array(Buffer.concat([local, file, body, central, file, end]));
}
/** A client whose runs hold `doc` as their full-suite-tree artifact (or none). */
const treeClient = (doc: unknown, listed = true): GitHubClient => ({
  async request<T>(_m: string, path: string): Promise<T> {
    if (/^repos\/\{repo\}\/actions\/runs\/\d+\/artifacts\?name=full-suite-tree&per_page=10$/.test(path)) return { artifacts: listed ? [{ id: 9, name: 'full-suite-tree', expired: false }] : [] } as T;
    throw new Error(`unexpected ${path}`);
  },
  async download() { return zipOf('tree.json', JSON.stringify(doc)); },
});

describe('ci-reuse decision', () => {
  test('reuses the complete full-suite dispatch run on the merged PR head when its tested tree equals the push tree', async () => {
    const d = await decide(green(), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: true, reason: 'identical_tree_full_run', tree: T, source: { run_id: 500, run_attempt: 1, sha: H } });
  });

  test('a pull_request run (the cheap tier) on the merged head is never a candidate', async () => {
    const run = prRun({ event: 'pull_request' });
    const d = await decide(green(run), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'no_candidate', rejected: [] });
    expect(d.detail).toContain('workflow_dispatch or push');
  });

  test('a recorded tree that differs from the push tree falls back', async () => {
    const run = prRun();
    const d = await decide(fixture({ runs: [run], artifacts: { [run.id]: { value: treeJson(run, { tree: OTHER }) } } }), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'tree_mismatch' });
  });

  test('a recorded tree equal to the push tree but not the tree of the run head commit falls back', async () => {
    const run = prRun();
    const deps = fixture({ commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: OTHER, parents: [BASE] } }, runs: [run], artifacts: { [run.id]: { value: treeJson(run) } } });
    expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'tree_mismatch' });
  });

  test('a cancelled run falls back', async () => {
    const run = prRun({ conclusion: 'cancelled' });
    expect(await decide(green(run), PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'run_cancelled' });
  });

  test('a failed latest attempt falls back even when an earlier attempt was green', async () => {
    const run = prRun({ run_attempt: 2, conclusion: 'failure' });
    const deps = fixture({ runs: [run], jobs: { '500/1': [{ name: 'full-suite', conclusion: 'success' }] }, artifacts: { [run.id]: { value: treeJson(run, { run_attempt: 1 }) } } });
    expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'run_failed' });
    expect(deps.jobCalls).toEqual([]);
  });

  test('a re-run in progress falls back', async () => {
    const run = prRun({ run_attempt: 2, status: 'in_progress', conclusion: null });
    expect(await decide(green(run), PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'run_in_progress' });
  });

  test('a missing or unreadable artifact falls back', async () => {
    const d = await decide(fixture({ runs: [prRun()] }), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'artifact_missing' });
    expect(d.detail).toContain("no 'full-suite-tree' artifact");
    const junk = await decide(fixture({ runs: [prRun()], artifacts: { 500: { value: 'not a json object' } } }), PROFILES.test, M, REPO);
    expect(junk).toMatchObject({ reuse: false, reason: 'artifact_mismatch' });
  });

  test('an artifact with profile cheap falls back', async () => {
    const run = prRun();
    const d = await decide(fixture({ runs: [run], artifacts: { [run.id]: { value: treeJson(run, { profile: 'cheap' }) } } }), PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'artifact_not_full' });
  });

  test('an artifact recorded by another attempt, run, head or workflow falls back', async () => {
    const run = prRun({ run_attempt: 2 });
    for (const over of [{ run_attempt: 1 }, { run_id: 499 }, { sha: H2 }, { head_sha: H2 }, { event: 'pull_request' }, { workflow: 'Other workflow' }]) {
      const deps = fixture({ runs: [run], jobs: { '500/2': [{ name: 'full-suite', conclusion: 'success' }] }, artifacts: { [run.id]: { value: treeJson(run, over) } } });
      expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'artifact_mismatch' });
    }
  });

  test('a skipped full-suite job (a partial run or a diagnostic dispatch) falls back; a run without the job falls back', async () => {
    const run = prRun();
    const artifacts = { [run.id]: { value: treeJson(run) } };
    const skipped = fixture({ runs: [run], jobs: { '500/1': [{ name: 'full-suite', conclusion: 'skipped' }] }, artifacts });
    expect(await decide(skipped, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'full_suite_not_success' });
    const cheap = fixture({ runs: [run], jobs: { '500/1': [{ name: 'test-status', conclusion: 'success' }] }, artifacts });
    expect(await decide(cheap, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'full_suite_missing' });
    const twice = fixture({ runs: [run], jobs: { '500/1': [{ name: 'full-suite', conclusion: 'success' }, { name: 'full-suite', conclusion: 'success' }] }, artifacts });
    expect(await decide(twice, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'full_suite_ambiguous' });
  });

  test('an API error falls back', async () => {
    for (const fail of ['runs', 'jobs', 'commit'] as const) {
      const run = prRun();
      const d = await decide(fixture({ runs: [run], artifacts: { [run.id]: { value: treeJson(run) } }, fail }), PROFILES.test, M, REPO);
      expect(d).toMatchObject({ reuse: false, reason: 'api_error' });
    }
  });

  test('a push that is not a merge commit falls back', async () => {
    const run = prRun();
    const deps = fixture({ commits: { [M]: { tree: T, parents: [BASE] }, [H]: { tree: T, parents: [BASE] } }, runs: [run], artifacts: { [run.id]: { value: treeJson(run) } } });
    expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'not_merge_commit' });
  });

  test('a run from a fork falls back', async () => {
    const run = prRun({ head_repository: { full_name: 'someone-example/repo-example' } });
    expect(await decide(green(run), PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'fork_run' });
  });

  test('no full run on the push tree falls back', async () => {
    expect(await decide(fixture({}), PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'no_candidate' });
  });

  test('prefers runs on the merged head (newest first), then any dispatch or push run whose head tree equals the push tree', async () => {
    const cheapNewer = prRun({ id: 600, run_number: 60 });
    const fullOlder = prRun({ id: 550, run_number: 55 });
    const deps = fixture({ runs: [fullOlder, cheapNewer], jobs: { '600/1': [{ name: 'test-status', conclusion: 'success' }] }, artifacts: { 550: { value: treeJson(fullOlder) } } });
    expect(await decide(deps, PROFILES.test, M, REPO)).toMatchObject({ reuse: true, source: { run_id: 550 } });
    expect(deps.jobCalls).toEqual(['600/1', '550/1']);

    const elsewhere = prRun({ id: 700, head_sha: H2 });
    const unrelated = prRun({ id: 710, head_sha: BASE });
    const fallback = fixture({
      commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] }, [H2]: { tree: T, parents: [BASE] }, [BASE]: { tree: OTHER, parents: [] } },
      runs: [unrelated, elsewhere], artifacts: { 700: { value: treeJson(elsewhere) }, 710: { value: treeJson(unrelated, { tree: T }) } },
    });
    expect(await decide(fallback, PROFILES.test, M, REPO)).toMatchObject({ reuse: true, source: { run_id: 700, sha: H2 } });

    const onlyUnrelated = fixture({ commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] }, [BASE]: { tree: OTHER, parents: [] } }, runs: [unrelated], artifacts: { 710: { value: treeJson(unrelated, { tree: T }) } } });
    expect(await decide(onlyUnrelated, PROFILES.test, M, REPO)).toMatchObject({ reuse: false, reason: 'no_candidate' });

    const earlierPush = prRun({ id: 720, head_sha: H2, event: 'push' });
    const cheapElsewhere = prRun({ id: 730, head_sha: H2, event: 'pull_request' });
    const viaPush = fixture({
      commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] }, [H2]: { tree: T, parents: [BASE] } },
      runs: [cheapElsewhere, earlierPush], artifacts: { 720: { value: treeJson(earlierPush) }, 730: { value: treeJson(cheapElsewhere) } },
    });
    expect(await decide(viaPush, PROFILES.test, M, REPO)).toMatchObject({ reuse: true, source: { run_id: 720, sha: H2 } });
    expect(viaPush.jobCalls).toEqual(['720/1']);
  });

  test('the reported reason is the merged-head candidate when every candidate fails', async () => {
    const run = prRun({ conclusion: 'cancelled' });
    const other = prRun({ id: 700, head_sha: H2 });
    const deps = fixture({ commits: { [M]: { tree: T, parents: [BASE, H] }, [H]: { tree: T, parents: [BASE] }, [H2]: { tree: T, parents: [BASE] } }, runs: [run, other] });
    const d = await decide(deps, PROFILES.test, M, REPO);
    expect(d).toMatchObject({ reuse: false, reason: 'run_cancelled' });
    expect(d.rejected.map(r => r.reason)).toEqual(['run_cancelled', 'artifact_missing']);
  });

  test('the test profile names its workflow file, job and artifact', () => {
    expect(PROFILES.test).toMatchObject({ file: 'test.yml', workflow: 'Test', job: 'full-suite', artifact: 'full-suite-tree' });
  });
});

describe('ci-reuse API layer', () => {
  test('reads commits, pull request runs by head, and every page of the latest attempt jobs', async () => {
    const paths: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `job ${i}`, conclusion: 'success' }));
    const client: GitHubClient = {
      async request<T>(_m: string, path: string): Promise<T> {
        paths.push(path);
        if (path === `repos/{repo}/git/commits/${M}`) return { tree: { sha: T }, parents: [{ sha: BASE }, { sha: H }] } as T;
        if (path.includes('/jobs?per_page=100&page=1')) return { total_count: 101, jobs: page1 } as T;
        if (path.includes('/jobs?per_page=100&page=2')) return { total_count: 101, jobs: [{ name: 'full-suite', conclusion: 'success' }] } as T;
        if (path.includes('/runs?')) return { workflow_runs: [prRun({ id: paths.length })] } as T;
        throw new Error(`unexpected ${path}`);
      },
    };
    const api = apiDeps(client);
    expect(await api.commit(M)).toEqual({ tree: T, parents: [BASE, H] });
    expect(await api.runsForHead('test.yml', H)).toHaveLength(1);
    expect(paths).toContain(`repos/{repo}/actions/workflows/test.yml/runs?head_sha=${H}&per_page=100`);
    expect(await api.recentSuccessfulRuns('test.yml')).toHaveLength(2);
    expect(paths).toContain('repos/{repo}/actions/workflows/test.yml/runs?event=workflow_dispatch&status=success&per_page=100');
    expect(paths).toContain('repos/{repo}/actions/workflows/test.yml/runs?event=push&status=success&per_page=100');
    const jobs = await api.jobs(500, 2);
    expect(jobs).toHaveLength(101);
    expect(jobs.at(-1)!.name).toBe('full-suite');
    expect(paths.filter(p => p.startsWith('repos/{repo}/actions/runs/500/attempts/2/jobs'))).toHaveLength(2);
    expect((await api.artifact(500, 'full-suite-tree')).reason).toContain('cannot download');
  });

  test('a job listing that 502s at 100 per page after the client retries is read again at 30 per page (Release run 39712021085)', async () => {
    const all = Array.from({ length: 109 }, (_, i) => ({ name: `job ${i}`, conclusion: 'success' }));
    const urls: string[] = []; const slept: number[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input)); urls.push(url.pathname + url.search);
      const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
      if (per === 100) return new Response('<html>502 Bad Gateway</html>', { status: 502 });
      return Response.json({ total_count: all.length, jobs: all.slice((page - 1) * per, page * per) });
    }) as typeof fetch;
    try {
      const jobs = await attemptJobs(restClient('acme-example/repo', 'token-example', async ms => { slept.push(ms); }), 500, 2);
      expect(jobs.map(j => j.name)).toEqual(all.map(j => j.name));
    } finally { globalThis.fetch = realFetch; }
    expect(slept).toEqual(GET_RETRY_DELAYS_MS);
    expect(urls).toEqual([
      ...Array(GET_RETRY_DELAYS_MS.length + 1).fill('/repos/acme-example/repo/actions/runs/500/attempts/2/jobs?per_page=100&page=1'),
      ...[1, 2, 3, 4].map(page => `/repos/acme-example/repo/actions/runs/500/attempts/2/jobs?per_page=30&page=${page}`),
    ]);
  });

  test('a job listing still refused at 30 per page, or refused with a client error, surfaces the error', async () => {
    const refusing = (status: (per: number) => number): GitHubClient => ({
      async request<T>(_m: string, path: string): Promise<T> {
        const code = status(Number(new URL(path, 'https://x.invalid/').searchParams.get('per_page')));
        throw Object.assign(new Error(`GitHub API GET ${path} -> ${code}`), { status: code });
      },
    });
    await expect(attemptJobs(refusing(() => 502), 500, 2)).rejects.toThrow('per_page=30&page=1 -> 502');
    await expect(attemptJobs(refusing(() => 404), 500, 2)).rejects.toThrow('per_page=100&page=1 -> 404');
  });
});

describe('ci-reuse outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-reuse-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const paths = (prefix: string) => ({ output: join(dir, `${prefix}-out`), summary: join(dir, `${prefix}-summary`), record: join(dir, `${prefix}-record.json`) });

  test('writes the outputs, a summary line naming the reused run URL, and the reuse record', async () => {
    const d = await decide(green(), PROFILES.test, M, REPO);
    const p = paths('ok');
    writeDecision(d, PROFILES.test, { repo: REPO, sha: M, ...p });
    expect(readFileSync(p.output, 'utf8')).toBe(`reuse=true\nsource_run_id=500\nsource_run_attempt=1\nsource_sha=${H}\ntree=${T}\nreason=identical_tree_full_run\n`);
    expect(readFileSync(p.summary, 'utf8')).toContain(`https://github.com/${REPO}/actions/runs/500/attempts/1`);
    const rec = JSON.parse(readFileSync(p.record, 'utf8'));
    expect(rec).toMatchObject({ reuse: true, workflow: 'Test', push_sha: M, tree: T, source_run_id: 500, source_run_attempt: 1, source_sha: H });
    expect(checkRecord(rec, 'Test', M)).toEqual({ run_id: 500, run_attempt: 1, sha: H });
  });

  test('a fallback writes reuse=false with empty source fields and the reason in the summary', async () => {
    const d = await decide(fixture({ runs: [prRun({ conclusion: 'cancelled' })] }), PROFILES.test, M, REPO);
    const p = paths('no');
    writeDecision(d, PROFILES.test, { repo: REPO, sha: M, ...p });
    expect(readFileSync(p.output, 'utf8')).toBe(`reuse=false\nsource_run_id=\nsource_run_attempt=\nsource_sha=\ntree=${T}\nreason=run_cancelled\n`);
    const summary = readFileSync(p.summary, 'utf8');
    expect(summary).toContain('full run');
    expect(summary).toContain('run_cancelled');
    expect(checkRecord(JSON.parse(readFileSync(p.record, 'utf8')), 'Test', M)).toContain('reuse is not true');
  });

  test('checkRecord refuses a record for another workflow or push, or without a source run', () => {
    const rec = { reuse: true, workflow: 'Test', push_sha: M, tree: T, source_run_id: 500, source_run_attempt: 1, source_sha: H };
    expect(typeof checkRecord({ ...rec, workflow: 'Other workflow' }, 'Test', M)).toBe('string');
    expect(typeof checkRecord({ ...rec, push_sha: H2 }, 'Test', M)).toBe('string');
    expect(typeof checkRecord({ ...rec, source_run_id: 0 }, 'Test', M)).toBe('string');
    expect(typeof checkRecord(undefined, 'Test', M)).toBe('string');
  });
});

// Artifact reads (scripts/lib/gh-issue.ts fetchArtifactJson, used by apiDeps.artifact): a permanent client error is a
// refusal; only no response, a 5xx, a 429 or a rate-limit 403 is transient.
describe('ci-reuse artifact reads', () => {
  const NAME = 'full-suite-tree';
  const artifact = (client: GitHubClient) => apiDeps(client).artifact(500, NAME);

  test('the tree artifact is read from tree.json, and an unreadable one says why', async () => {
    const client = treeClient;
    expect(await artifact(client({ tree: T }))).toEqual({ value: { tree: T } });
    expect(await artifact(client(null, false))).toEqual({ reason: "run 500 has no 'full-suite-tree' artifact" });
    const download = (bytes: () => Promise<Uint8Array>): GitHubClient => ({ ...client(null), download: bytes });
    expect(await artifact(download(async () => { throw new Error('HTTP 503'); })))
      .toEqual({ reason: "reading run 500's 'full-suite-tree' artifact failed: HTTP 503", transient: true });
    expect(await artifact(download(async () => zipOf('tree.json', '{"tree":'))))
      .toEqual({ reason: expect.stringMatching(/^reading run 500's 'full-suite-tree' artifact failed: /) });
  });

  test('#8370: a permanent 4xx reading the artifact is a refusal; only no response, a 5xx, a 429 or a rate-limit 403 is transient', async () => {
    const status = (code: number, message = `HTTP ${code}`) => Object.assign(new Error(message), { status: code });
    const download = (e: Error): GitHubClient => ({ ...treeClient(null), download: async () => { throw e; } });
    const listing = (e: Error): GitHubClient => ({ ...treeClient(null), request: async () => { throw e; } });
    for (const code of [403, 404, 410]) {
      const got = await artifact(download(status(code)));
      expect(got).toEqual({ reason: `reading run 500's 'full-suite-tree' artifact failed: HTTP ${code}` });
      expect(await artifact(listing(status(code)))).not.toHaveProperty('transient');
    }
    for (const e of [status(429), status(403, 'API rate limit exceeded for installation'), status(502), Object.assign(new Error('no response'), { network: true })]) {
      expect(await artifact(listing(e))).toMatchObject({ transient: true });
    }
  });

  test('#8370: both real clients classify a failed artifact download the same way: 403/410 refuse, a rate-limit 403 waits', async () => {
    const listing = JSON.stringify({ artifacts: [{ id: 7, name: NAME, expired: false }] });
    const zipFails = (code: number, text: string) => {
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string) => String(url).endsWith('/zip') ? new Response(text, { status: code }) : new Response(listing, { status: 200 })) as typeof fetch;
      return apiDeps(restClient(REPO, 'token-example', async () => {})).artifact(500, NAME).finally(() => { globalThis.fetch = real; });
    };
    const bin = mkdtempSync(join(tmpdir(), 'ci-reuse-gh-'));
    const ghFails = async (code: number, text: string) => {
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\ncase "$*" in *"/zip"*) echo "gh: ${text} (HTTP ${code})" >&2; exit 1;; esac\necho '${listing}'\n`, { mode: 0o755 });
      return withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => apiDeps(restClient(REPO, '', async () => {})).artifact(500, NAME));
    };
    try {
      for (const fails of [zipFails, ghFails]) {
        for (const code of [403, 404, 410]) expect(await fails(code, 'Not Found')).not.toHaveProperty('transient');
        expect(await fails(403, 'API rate limit exceeded for installation ID 1')).toMatchObject({ transient: true });
        expect(await fails(429, 'Too Many Requests')).toMatchObject({ transient: true });
        expect(await fails(502, 'Bad Gateway')).toMatchObject({ transient: true });
      }
    } finally { rmSync(bin, { recursive: true, force: true }); }
  });

  test('#8370: a refused blob-storage redirect, a rate-limit 403 known only by its headers, and the abuse-detection wording all stay transient', async () => {
    const listing = JSON.stringify({ artifacts: [{ id: 7, name: NAME, expired: false }] });
    const token = (zip: (url: string) => Response) => {
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string) => String(url).includes('/actions/runs/') ? new Response(listing, { status: 200 }) : zip(String(url))) as typeof fetch;
      return apiDeps(restClient(REPO, 'token-example', async () => {})).artifact(500, NAME).finally(() => { globalThis.fetch = real; });
    };
    const blob = 'https://blob-example.invalid/zip?sig=expired';
    expect(await token(url => url === blob ? new Response('AuthenticationFailed', { status: 403 }) : new Response(null, { status: 302, headers: { location: blob } }))).toMatchObject({ transient: true });
    expect(await token(() => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))).toMatchObject({ transient: true });
    expect(await token(() => new Response('', { status: 403, headers: { 'retry-after': '60' } }))).toMatchObject({ transient: true });
    expect(await token(() => new Response('You have triggered an abuse detection mechanism.', { status: 403 }))).toMatchObject({ transient: true });
    expect(await token(() => new Response('Resource not accessible by integration', { status: 403 }))).not.toHaveProperty('transient');
    expect(await token(() => new Response('Gone', { status: 410 }))).not.toHaveProperty('transient');
    const bin = mkdtempSync(join(tmpdir(), 'ci-reuse-gh-'));
    try {
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\ncase "$*" in *"/zip"*) echo "gh: You have triggered an abuse detection mechanism. (HTTP 403)" >&2; exit 1;; esac\necho '${listing}'\n`, { mode: 0o755 });
      expect(await withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => apiDeps(restClient(REPO, '', async () => {})).artifact(500, NAME))).toMatchObject({ transient: true });
    } finally { rmSync(bin, { recursive: true, force: true }); }
  });
});
