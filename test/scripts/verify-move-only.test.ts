/**
 * T-G12 (refactor wave 1, E3 / EO19): scripts/verify-move-only.ts.
 *
 * Protects: the move proof reviewers rely on for ~50k moved lines. A pure move
 * (re-indented, comments changed, helper newly exported, SyncRun-style rename
 * map) passes; a single edited token fails in every mode and the failure names
 * file:line and the first differing token.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyMoveOnly } from '../../scripts/verify-move-only.ts';

describe('verify-move-only: rename-map mode (Mechanical-Rename)', () => {
  const base = [{ path: 'src/commands/sync.ts', text: 'export async function phase(run: SyncRun) {\n  if (pullFailed) return 1;\n  pullFailed = true;\n  return 0;\n}\n' }];
  const head = [{ path: 'src/commands/sync.ts', text: 'export async function phase(run: SyncRun) {\n  if (run.pullFailed) return 1;\n  run.pullFailed = true;\n  return 0;\n}\n' }];

  test('identifier rewrites listed in the map pass', () => {
    expect(verifyMoveOnly(base, head, { renameMap: { pullFailed: 'run.pullFailed' } }).ok).toBe(true);
  });

  test('without the map the rewrite fails', () => {
    expect(verifyMoveOnly(base, head).ok).toBe(false);
  });

  test('one edited token beyond the map fails', () => {
    const edited = [{ path: head[0]!.path, text: head[0]!.text.replace('return 1', 'return 2') }];
    expect(verifyMoveOnly(base, edited, { renameMap: { pullFailed: 'run.pullFailed' } }).ok).toBe(false);
  });
});

describe('verify-move-only: default mode', () => {
  test('moving a function to another file, re-indented with new comments, passes', () => {
    const base = [{ path: 'a.ts', text: 'export function f(x: number) {\n  return x + 1;\n}\nexport const K = `SQL  text`;\n' }];
    const head = [
      { path: 'a.ts', text: "export { f } from './b.ts';\nexport const K = `SQL  text`;\n" },
      { path: 'b.ts', text: '// moved\nexport function f(x: number) {\n    return x + 1; // same\n}\n' },
    ];
    expect(verifyMoveOnly(base, head).ok).toBe(true);
  });

  test('whitespace inside a template literal is significant (SQL is never normalized)', () => {
    const base = [{ path: 'a.ts', text: 'export const K = `SQL  text`;\n' }];
    const head = [{ path: 'a.ts', text: 'export const K = `SQL text`;\n' }];
    expect(verifyMoveOnly(base, head).ok).toBe(false);
  });
});

describe('verify-move-only CLI over a git commit', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const SCRIPT = resolve(import.meta.dir, '..', '..', 'scripts', 'verify-move-only.ts');

  function repo(): (args: string[]) => string {
    const dir = mkdtempSync(join(tmpdir(), 'devmodel-move-only-'));
    dirs.push(dir);
    const run = (args: string[]) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    run(['init', '-q']);
    run(['config', 'user.email', 'alice-example@example.com']);
    run(['config', 'user.name', 'alice-example']);
    run(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'a.ts'), 'export function f() {\n  return 1;\n}\nexport function g() {\n  return 2;\n}\n');
    run(['add', '.']);
    run(['commit', '-qm', 'base']);
    return (args) => {
      if (args[0] === 'write') {
        writeFileSync(join(dir, args[1]!), args[2]!);
        return '';
      }
      if (args[0] === 'cli') return JSON.stringify(spawnSync('bun', [SCRIPT, ...args.slice(1)], { cwd: dir, encoding: 'utf8' }));
      return run(args);
    };
  }

  test('passes on a move commit and fails on an edit commit', () => {
    const r = repo();
    r(['write', 'a.ts', 'export function f() {\n  return 1;\n}\n']);
    r(['write', 'b.ts', 'export function g() {\n  return 2;\n}\n']);
    r(['add', '.']);
    r(['commit', '-qm', 'move g']);
    const ok = JSON.parse(r(['cli']));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('is move-only: 2 top-level statements across 2 files');

    r(['write', 'b.ts', 'export function g() {\n  return 3;\n}\n']);
    r(['add', '.']);
    r(['commit', '-qm', 'edit g']);
    const bad = JSON.parse(r(['cli', 'HEAD']));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('FAIL: b.ts:1 statement differs from b.ts:1');
  });
});
