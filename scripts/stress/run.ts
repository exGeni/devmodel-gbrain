#!/usr/bin/env bun
/**
 * bun run test:stress (scripts/stress/run.ts) — run test files repeatedly to prove they are
 * deterministic. The one runner behind the PR stress gate and local runs
 * (scripts/stress/README.md, docs/TESTING.md#stress-gate).
 *
 *   bun run test:stress [files…] [--iterations N] [--base <ref>] [--head <ref>]
 *                       [--seed N] [--first-iteration N] [--randomize]
 *                       [--work <json>] [--out <dir>] [--dry-run]
 *
 * Files default to the test files changed versus the merge base with
 * origin/main (plus direct importers of changed test/helpers/ files, by the
 * fan-in rule). Each file runs in its own execution profile (unit, serial,
 * slow with the workflow's pull-request values, or E2E through
 * scripts/run-e2e.sh).
 *
 * Every iteration writes an executed-test receipt (JUnit) and must execute the
 * same tests as the first; zero executed tests or an unexpected skip fails the
 * run. Output: one line per iteration, a summary with the reproduce command
 * for each failure, and a manifest (<out>/stress-manifest.json).
 * Exit: 0 every file passed, 1 a failure, 2 usage or setup error, 130/143 cancelled.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJUnit, type TestCase } from '../ci-executed-counts.ts';
import {
  DEFAULT_ITERATIONS, STRESS_DOCS, TEST_PATH_RE, allTestFiles, changedFiles, defaultSeed, expandHelper,
  notStressedReason, parseFileList, profileFor, redact, reproduceLine, validRef, type HelperExpansion, type Profile,
} from './plan.ts';

/** GBRAIN_STRESS_ROOT is a test seam: a fixture tree whose test files the runner executes. */
const ROOT = process.env.GBRAIN_STRESS_ROOT ? resolve(process.env.GBRAIN_STRESS_ROOT) : resolve(import.meta.dir, '..', '..');
const ITERATION_CAP_MS = Number(process.env.GBRAIN_STRESS_ITERATION_TIMEOUT_MS ?? 15 * 60_000);

export interface Args {
  files: string[]; iterations: number; firstIteration: number; base: string; head?: string;
  seed?: number; randomize: boolean; out: string; dryRun: boolean;
  work?: Array<{ file: string; first: number; count: number }>;
}

export function parseArgs(argv: string[]): Args | string {
  const a: Args = { files: [], iterations: DEFAULT_ITERATIONS, firstIteration: 1, base: 'origin/main', randomize: false, out: '.context/test-stress', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    try {
      switch (arg) {
        case '--iterations': a.iterations = Number(value()); break;
        case '--first-iteration': a.firstIteration = Number(value()); break;
        case '--base': a.base = value(); break;
        case '--head': a.head = value(); break;
        case '--seed': a.seed = Number(value()); break;
        case '--out': a.out = value(); break;
        case '--work': a.work = JSON.parse(value()); break;
        case '--randomize': a.randomize = true; break;
        case '--dry-run': a.dryRun = true; break;
        case '-h': case '--help': return 'help';
        default:
          if (arg.startsWith('-')) return `unknown flag ${arg}`;
          a.files.push(arg.replace(/^\.\//, ''));
      }
    } catch (e) { return (e as Error).message; }
  }
  if (!Number.isInteger(a.iterations) || a.iterations < 1) return '--iterations must be a positive integer';
  if (!Number.isInteger(a.firstIteration) || a.firstIteration < 1) return '--first-iteration must be a positive integer';
  if (a.seed !== undefined && (!Number.isInteger(a.seed) || a.seed < 0)) return '--seed must be a non-negative integer';
  if (!validRef(a.base) || (a.head && !validRef(a.head))) return '--base/--head must be a 40-hex SHA or a valid ref name';
  const bad = parseFileList(a.files.join(' ')).invalid;
  if (bad.length) return `not a repo-relative test file: ${bad.join(', ')} (expected test/…/*.test.ts)`;
  if (a.work) {
    if (!Array.isArray(a.work) || a.work.some(w => !w || typeof w.file !== 'string' || !TEST_PATH_RE.test(w.file) || w.file.includes('..') || !Number.isInteger(w.first) || w.first < 1 || !Number.isInteger(w.count) || w.count < 1)) {
      return '--work must be a JSON array of {"file":"test/…/*.test.ts","first":N,"count":N}';
    }
  }
  return a;
}

// ── One iteration ─────────────────────────────────────────────────────────────

export interface Failure { test: string; signature: string; message: string }
export interface IterationResult {
  index: number; seed: number; exit: number; durationMs: number; executed: number; skipped: number;
  failures: Failure[]; missing: string[]; timedOut: boolean; receipt: string;
}

/** Stable failure signature: the first lines of the message with numbers, temp paths and UUIDs masked. */
export function failureSignature(message: string): string {
  return message.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4).join(' ')
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/\S+/g, '<tmp>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'N').replace(/\s+/g, ' ').slice(0, 200);
}

const ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (t: string) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (w, r: string) => r[0] === '#' ? String.fromCodePoint(r[1] === 'x' ? parseInt(r.slice(2), 16) : Number(r.slice(1))) : ENTITY[r] ?? w);

/** Executed cases plus the failure message of each failing case, in report order. */
export function readReport(xml: string): { cases: TestCase[]; messages: string[] } {
  const cases = parseJUnit(xml);
  const messages: string[] = [];
  for (const [, body] of xml.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const m = /<(?:failure|error)\b[^>]*?message="([^"]*)"/.exec(body ?? '');
    if (m || /<(?:failure|error)\b/.test(body ?? '')) messages.push(decode(m?.[1] ?? 'failure without a message'));
  }
  return { cases, messages };
}

const slug = (file: string) => file.replace(/^test\//, '').replace(/[^\w.-]+/g, '_');

interface RunContext { args: Args; sha: string; bun: string; out: string; child?: ReturnType<typeof spawn> }

function childEnv(profile: Profile, seed: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_TEST_RECEIPT_DIR', 'GBRAIN_TEST_RECEIPT_LANE', 'GBRAIN_STRESS_ROOT']) delete env[k];
  env.GBRAIN_TEST_SEED = String(seed);
  return { ...env, ...profile.vars };
}

async function runIteration(ctx: RunContext, file: string, profile: Profile, index: number, seed: number): Promise<IterationResult> {
  const dir = join(ctx.out, 'receipts', `${slug(file)}--i${index}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = childEnv(profile, seed);
  const junit = join(dir, 'stress.junit.xml');
  let cmd: string[];
  if (profile.name === 'e2e') {
    env.GBRAIN_TEST_RECEIPT_DIR = dir;
    env.GBRAIN_TEST_RECEIPT_LANE = 'stress-e2e';
    cmd = ['bash', 'scripts/run-e2e.sh', file];
  } else {
    cmd = ['bun', 'test', `--timeout=${profile.timeoutMs}`,
      ...(profile.name === 'serial' ? ['--max-concurrency=1'] : []),
      ...(ctx.args.randomize ? ['--randomize', `--seed=${seed}`] : []),
      '--reporter=junit', `--reporter-outfile=${junit}`, file];
  }
  const started = Date.now();
  const log = join(dir, 'output.log');
  let timedOut = false;
  const exit = await new Promise<number>(res => {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.child = child;
    const chunks: Buffer[] = [];
    child.stdout!.on('data', c => chunks.push(c));
    child.stderr!.on('data', c => chunks.push(c));
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid!); }, ITERATION_CAP_MS);
    child.on('close', code => { clearTimeout(timer); ctx.child = undefined; writeFileSync(log, redact(Buffer.concat(chunks).toString('utf8'))); res(code ?? 1); });
  });
  const durationMs = Date.now() - started;
  if (profile.name !== 'e2e') {
    const receipt = [`version=1`, `lane=stress`, `kind=primary`, `tag=${slug(file)}-i${index}`, `shard=`, `of=`, `arm=`,
      `sha=${ctx.sha}`, `root=${ROOT}`, `run_id=${process.env.GITHUB_RUN_ID ?? ''}`, `run_attempt=${process.env.GITHUB_RUN_ATTEMPT ?? ''}`,
      `job=${process.env.GITHUB_JOB ?? ''}`, `started=${Math.floor(started / 1000)}`, `exit=${exit}`].join('\n');
    writeFileSync(join(dir, `stress--${slug(file)}-i${index}--primary.receipt`), `${receipt}\n`);
    writeFileSync(join(dir, `stress--${slug(file)}-i${index}--primary.files`), `${file}\n`);
  }
  const report = profile.name === 'e2e' ? readdirSync(dir).find(f => f.endsWith('.junit.xml')) : existsSync(junit) ? 'stress.junit.xml' : undefined;
  let cases: TestCase[] = [];
  let messages: string[] = [];
  let reportError = '';
  if (report) {
    try { ({ cases, messages } = readReport(readFileSync(join(dir, report), 'utf8'))); } catch (e) { reportError = (e as Error).message; }
  } else reportError = 'no JUnit report was written';
  const failed = cases.filter(c => c.status === 'fail');
  const failures: Failure[] = failed.map((c, i) => ({ test: c.test, message: redact(messages[i] ?? ''), signature: failureSignature(messages[i] ?? '') }));
  if (exit !== 0 && !failures.length) {
    const tail = readFileSync(log, 'utf8').split('\n').filter(l => l.trim()).slice(-40);
    const first = tail.find(l => /error|Error|FAIL|timed out|panic/.test(l)) ?? tail[tail.length - 1] ?? `exit ${exit}`;
    const why = timedOut ? `iteration exceeded the ${Math.round(ITERATION_CAP_MS / 60000)}-minute iteration cap and was killed` : reportError ? `${first} (${reportError})` : first;
    failures.push({ test: '(file-level)', message: redact(why), signature: failureSignature(why) });
  }
  return {
    index, seed, exit, durationMs, timedOut, receipt: relativeToRoot(dir),
    executed: cases.filter(c => c.status === 'pass' || c.status === 'fail').length,
    skipped: cases.filter(c => c.status === 'skip' || c.status === 'todo').length,
    failures, missing: [],
  };
}

const relativeToRoot = (p: string) => p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
function killTree(pid: number) { try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref(); }

function executedIdentities(dir: string): string[] {
  const full = resolve(ROOT, dir);
  const report = readdirSync(full).find(f => f.endsWith('.junit.xml'));
  if (!report) return [];
  try { return parseJUnit(readFileSync(join(full, report), 'utf8')).filter(c => c.status === 'pass' || c.status === 'fail').map(c => c.test); } catch { return []; }
}

// ── One file ──────────────────────────────────────────────────────────────────

export interface FileResult {
  file: string; profile: Profile['name']; status: 'pass' | 'fail' | 'not-stressed';
  reason?: string; seedBase: number; firstIteration: number; iterations: IterationResult[]; reproduce: string;
}

/** Workflows whose dedicated jobs provide prerequisites (agent binaries, native targets) the stress shards lack. */
const OWNING_WORKFLOWS: string[] = [];

/** Credentialed URLs of external services that no CI job provides: a secret by another name. */
const EXTERNAL_SERVICE_URLS: string[] = [];

export function skipReason(file: string): string | null {
  const text = readFileSync(join(ROOT, file), 'utf8');
  if (/process\.platform/.test(text)) return `every test skipped on ${process.platform}: platform-only tests, run by their owning native lane; not stressed`;
  const keys = [...new Set([...text.matchAll(/process\.env\.([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET))/g)].map(m => m[1]!))];
  if (keys.length) return `every test skipped without ${keys.join(', ')} (secret not available here); not stressed`;
  const external = EXTERNAL_SERVICE_URLS.filter(name => text.includes(`process.env.${name}`) && !process.env[name]);
  if (external.length) return `every test skipped without ${external.join(', ')} (a credentialed external service no CI job holds); not stressed`;
  const owner = OWNING_WORKFLOWS.find(w => { const p = join(ROOT, '.github/workflows', w); return existsSync(p) && readFileSync(p, 'utf8').includes(file); });
  if (owner) return `every test skipped here: its prerequisite (agent binary or native target) comes from its owning job in .github/workflows/${owner}; not stressed`;
  return null;
}

async function stressFile(ctx: RunContext, file: string, profile: Profile, first: number, count: number): Promise<FileResult> {
  const { args } = ctx;
  const seedBase = args.seed ?? defaultSeed(ctx.sha, file);
  const result: FileResult = {
    file, profile: profile.name, status: 'pass', seedBase, firstIteration: first, iterations: [],
    reproduce: reproduceLine({ file, iterations: count, firstIteration: first, seed: seedBase, randomize: args.randomize }),
  };
  let expected: string[] | undefined;
  for (let index = first; index < first + count; index++) {
    const seed = seedBase + index - 1;
    const it = await runIteration(ctx, file, profile, index, seed);
    if (!it.failures.length) {
      const ids = executedIdentities(it.receipt);
      if (index === first) {
        if (it.executed === 0) {
          const reason = skipReason(file);
          if (reason) { result.status = 'not-stressed'; result.reason = reason; result.iterations.push(it); log(`  - ${file} ${reason}`); return result; }
          it.failures.push({ test: '(file-level)', message: 'zero tests executed', signature: 'zero tests executed' });
        }
        expected = ids;
      } else if (expected) {
        const seen = new Set(ids);
        it.missing = expected.filter(t => !seen.has(t));
        if (it.missing.length) it.failures.push({ test: '(file-level)', message: `unexpected skip: ${it.missing.length} test(s) that ran in iteration ${first} did not run: ${it.missing.slice(0, 3).join('; ')}`, signature: 'unexpected skip' });
      }
    }
    result.iterations.push(it);
    const mark = it.failures.length ? '✗' : '✓';
    log(`  ${mark} ${file} iteration ${index} (seed ${seed}) ${(it.durationMs / 1000).toFixed(1)}s, ${it.executed} executed${it.failures.length ? `: ${it.failures[0]!.test}: ${it.failures[0]!.message.split('\n')[0]}` : ''}`);
    if (it.failures.length) result.status = 'fail';
  }
  return result;
}

const log = (line: string) => console.log(line);

// ── Main ──────────────────────────────────────────────────────────────────────

const USAGE = `usage: bun run test:stress [files…] [--iterations N] [--base <ref>] [--head <ref>]
                         [--seed N] [--first-iteration N] [--randomize] [--work <json>] [--out <dir>] [--dry-run]
Docs: ${STRESS_DOCS}`;

export interface Selection { files: string[]; helpers: HelperExpansion[]; mergeBase?: string; error?: string }

/** The files a run stresses: explicit files, or changed tests plus helper importers versus the merge base. */
export function selectFiles(args: Args, sha: string): Selection {
  if (args.work) return { files: [...new Set(args.work.map(w => w.file))], helpers: [] };
  if (args.files.length) return { files: args.files, helpers: [] };
  const changed = changedFiles(ROOT, args.base, args.head);
  if (changed.error) return { files: [], helpers: [], error: changed.error };
  const tests = changed.helpers.length ? allTestFiles(ROOT) : [];
  const helpers = changed.helpers.map(h => expandHelper(ROOT, h, tests, sha));
  return { files: [...new Set([...changed.tests, ...helpers.flatMap(h => h.stressed)])].sort(), helpers, mergeBase: changed.mergeBase };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === 'help') { console.log(USAGE); return 0; }
  if (typeof parsed === 'string') { console.error(`test:stress: ${parsed}\n${USAGE}`); return 2; }
  const args = parsed;
  const sha = process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'unknown';
  const bun = Bun.version;
  const setupStarted = Date.now();
  const selection = selectFiles(args, sha);
  if (selection.error) {
    console.error(`test:stress: the changed-file list could not be computed: ${selection.error}\n  Why: the stress set is every test file the diff touches; a guessed list could skip one.\n  Docs: ${STRESS_DOCS}`);
    return 2;
  }
  const livePath = join(ROOT, 'scripts/e2e-live-key-only.txt');
  const liveKeyOnly = new Set(existsSync(livePath) ? readFileSync(livePath, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : []);
  const missing = selection.files.filter(f => !existsSync(join(ROOT, f)));
  if (missing.length) { console.error(`test:stress: no such file: ${missing.join(', ')}. Fix: pass repo-relative paths of existing test files. Docs: ${STRESS_DOCS}`); return 2; }
  const plan = selection.files.map(file => ({ file, reason: notStressedReason(file, liveKeyOnly), profile: profileFor(file) }));
  log(`test:stress: ${plan.length} file(s) × ${args.work ? 'planned' : args.iterations} iteration(s) at ${sha.slice(0, 12)} on Bun ${bun}${selection.mergeBase ? `, changed versus ${selection.mergeBase.slice(0, 12)}` : ''}`);
  for (const h of selection.helpers) log(`  helper ${h.helper}: ${h.importers} direct importer(s), ${h.mode === 'sampled' ? `stressing its own tests and a sample of ${h.stressed.length}; ${h.listedOnly.length} listed only` : 'stressing all'}`);
  for (const p of plan) log(`  ${p.reason ? 'skip' : p.profile.name.padEnd(12)} ${p.file}${p.reason ? ` (${p.reason})` : ''}`);
  if (args.dryRun) return 0;
  if (!plan.length) { log(`test:stress: no changed test files; nothing to stress. Pass files explicitly or --base <ref>. Docs: ${STRESS_DOCS}`); return 0; }

  const out = resolve(ROOT, args.out);
  mkdirSync(out, { recursive: true });
  const ctx: RunContext = { args, sha, bun, out };
  let cancelled = 0;
  const onSignal = (code: number) => async () => {
    if (cancelled) return;
    cancelled = code;
    log(`\ntest:stress: interrupted; stopping the running file`);
    if (ctx.child?.pid) killTree(ctx.child.pid);
    process.exit(code);
  };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));

  const results: FileResult[] = [];
  let setupMs = 0;
  const runStarted = Date.now();
  try {
    setupMs = Date.now() - setupStarted;
    log(`  setup ${(setupMs / 1000).toFixed(1)}s`);
    for (const p of plan) {
      if (p.reason) { results.push({ file: p.file, profile: p.profile.name, status: 'not-stressed', reason: p.reason, seedBase: 0, firstIteration: 1, iterations: [], reproduce: '' }); continue; }
      const items = args.work ? args.work.filter(w => w.file === p.file) : [{ file: p.file, first: args.firstIteration, count: args.iterations }];
      for (const item of items) results.push(await stressFile(ctx, p.file, p.profile, item.first, item.count));
    }
    const runMs = Date.now() - runStarted;
    const manifest = writeManifest(ctx, results, selection, setupMs, runMs);
    return summarize(results, manifest, setupMs, runMs);
  } catch (e) {
    console.error(`test:stress: ${(e as Error).message || String(e)}\n  Docs: ${STRESS_DOCS}`);
    if (results.length) writeManifest(ctx, results, selection, setupMs, Date.now() - runStarted);
    return 2;
  }
}

function artifactUrl(): string {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = process.env;
  return process.env.GBRAIN_STRESS_ARTIFACT_URL || (server && repo && run ? `${server}/${repo}/actions/runs/${run}` : '');
}

/** The context line printed under every reproduce command. */
export function contextLine(ctx: { sha: string; bun: string }, r: FileResult, it: IterationResult, artifact: string): string {
  return `sha ${ctx.sha.slice(0, 12)}, Bun ${ctx.bun}, profile ${r.profile}, iteration ${it.index}, seed ${it.seed}${artifact ? `, artifact ${artifact}` : ''}`;
}

function writeManifest(ctx: RunContext, results: FileResult[], selection: Selection, setupMs: number, runMs: number): string {
  const artifact = artifactUrl();
  const failures = results.flatMap(r => r.iterations.flatMap(it => it.failures.map(f => ({
    file: r.file, iteration: it.index, seed: it.seed, test: f.test, signature: f.signature, message: f.message,
    reproduce: reproduceLine({ file: r.file, iterations: Math.max(1, r.iterations.length), firstIteration: it.index, seed: r.seedBase, randomize: ctx.args.randomize }),
    context: contextLine(ctx, r, it, artifact),
  }))));
  const manifest = {
    version: 1, kind: 'gbrain-stress-manifest', sha: ctx.sha, bun: ctx.bun, randomize: ctx.args.randomize,
    run_id: process.env.GITHUB_RUN_ID ?? '', run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? '', artifact,
    setup_ms: setupMs, run_ms: runMs, helpers: selection.helpers,
    files: results.map(r => ({ ...r, iterations: r.iterations.map(({ receipt, ...it }) => ({ ...it, receipt })) })),
    not_stressed: results.filter(r => r.status === 'not-stressed').map(r => ({ file: r.file, reason: r.reason })),
    failures,
  };
  const path = join(ctx.out, 'stress-manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

function summarize(results: FileResult[], manifestPath: string, setupMs: number, runMs: number): number {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { failures: Array<{ file: string; iteration: number; test: string; message: string; reproduce: string; context: string }> };
  const failedFiles = [...new Set(results.filter(r => r.status === 'fail').map(r => r.file))];
  log(`\ntest:stress: ${results.filter(r => r.status === 'pass').length} passed, ${failedFiles.length} failed, ${results.filter(r => r.status === 'not-stressed').length} not stressed (setup ${(setupMs / 1000).toFixed(1)}s, run ${(runMs / 1000).toFixed(1)}s). Manifest: ${relativeToRoot(manifestPath)}`);
  if (!failedFiles.length) return 0;
  for (const file of failedFiles) {
    const fs = manifest.failures.filter(f => f.file === file);
    const iterations = [...new Set(fs.map(f => f.iteration))];
    const first = fs[0]!;
    log(`\nFAIL [stress_failure]: ${file} failed in ${iterations.length} iteration(s) (first: iteration ${first.iteration}, ${first.test}: ${first.message.split('\n')[0]})`);
    log(`  Why: the same checkout passed and failed across iterations, so the file is nondeterministic (or broken).`);
    log(`  Fix: root-cause the race in the product or the test; never widen a timeout or weaken an assertion. Replay:`);
    log(`    ${first.reproduce}`);
    log(`    # ${first.context}`);
    log(`  Docs: ${STRESS_DOCS}`);
  }
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
