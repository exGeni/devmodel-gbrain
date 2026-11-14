/**
 * Empty-subject paths of four verify guards that have no test file of their
 * own: check-test-real-names.sh, check-fixture-privacy.sh,
 * check-trailing-newline.sh and check-file-url-pathname.sh.
 *
 * scripts/run-verify-parallel.sh records a check that exits 0 as a pass unless
 * its output has a line starting with `DEVMODEL_CHECK_SKIPPED: <reason>`. A guard
 * with nothing to scan must print that line, so a tree that lost its subject
 * reads as a skip, and a guard that scanned something must not print it.
 * Each case builds a throwaway tree and runs the guard against it
 * (DEVMODEL_GUARD_ROOT where the guard has that seam, otherwise a git repo as
 * the working directory).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const BASH = Bun.which('bash')!;
const SKIP_LINE = /^DEVMODEL_CHECK_SKIPPED: \S/m;
// Built in two pieces so this file is not itself a hit of check-file-url-pathname.sh.
const PATHNAME_HIT = `new URL('x', import.meta${'.url'}).pathname`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string> = {}, dirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'devmodel-empty-subject-'));
  roots.push(root);
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function guard(script: string, root: string, env: Record<string, string> = {}) {
  const r = spawnSync(BASH, [join(REPO, 'scripts', script)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DEVMODEL_GUARD_ROOT: root, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('check-test-real-names.sh', () => {
  // Without DEVMODEL_GUARD_ROOT the guard works in the git toplevel, else the cwd.
  const realNames = (root: string, env: Record<string, string> = {}) => {
    spawnSync('git', ['init', '-q'], { cwd: root });
    return guard('check-test-real-names.sh', root, env);
  };
  const bannedName = ['Tech', 'nium'].join('');

  /** A PATH holding only the tools the guard needs, with or without a stub `rg` that finds nothing. */
  const toolPath = (withRg: boolean): string => {
    const bin = tree();
    for (const tool of ['git', 'grep', 'find', 'head']) symlinkSync(Bun.which(tool)!, join(bin, tool));
    if (withRg) {
      writeFileSync(join(bin, 'rg'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(bin, 'rg'), 0o755);
    }
    return bin;
  };

  test('a tree with no test/ or evals/ reports a skip, not a pass', () => {
    const r = realNames(tree({ 'README.md': 'x\n' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(SKIP_LINE);
    expect(r.stdout).toContain('DEVMODEL_CHECK_SKIPPED: no TypeScript files under test/ or evals/ to scan');
  });

  test('a test/ without a test file reports a skip', () => {
    const r = realNames(tree({ 'test/notes.md': 'x\n' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(SKIP_LINE);
  });

  test('a scanned clean test file passes without a skip; a banned name still fails', () => {
    const clean = realNames(tree({ 'test/a.test.ts': "test('ok', () => {});\n" }));
    expect(clean.status).toBe(0);
    expect(clean.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
    const dirty = realNames(tree({ 'test/a.test.ts': `// ${bannedName}\n` }));
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
    expect(dirty.stderr).toContain('banned real-name references');
  });

  test('the subject follows the tool: rg scans every TypeScript file, the grep fallback only *.test.ts', () => {
    const helperOnly = { 'test/helper.ts': 'export const x = 1;\n' };
    const viaGrep = realNames(tree(helperOnly), { PATH: toolPath(false) });
    expect(viaGrep.status).toBe(0);
    expect(viaGrep.stdout).toMatch(SKIP_LINE);
    const viaRg = realNames(tree(helperOnly), { PATH: toolPath(true) });
    expect(viaRg.status).toBe(0);
    expect(viaRg.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
  });
});

describe('check-fixture-privacy.sh', () => {
  test('a tree with none of the fixture, eval or audit paths reports a skip and keeps its human line', () => {
    const r = guard('check-fixture-privacy.sh', tree({ 'README.md': 'x\n' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[check-fixture-privacy] no fixture dirs exist; nothing to check');
    expect(r.stdout).toMatch(SKIP_LINE);
    expect(r.stdout).toContain('DEVMODEL_CHECK_SKIPPED: none of the fixture, eval or audit paths exist');
    expect(r.stdout).not.toContain('OK: no banned tokens');
  });

  test('fixture directories with no file report a skip', () => {
    const r = guard('check-fixture-privacy.sh', tree({}, ['test/fixtures/transcripts', 'evals', 'docs/test-audit']));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DEVMODEL_CHECK_SKIPPED: the fixture, eval and audit paths hold no files');
    expect(r.stdout).not.toContain('OK: no banned tokens');
  });

  test('a scanned clean fixture passes without a skip; a banned token still fails', () => {
    const clean = guard('check-fixture-privacy.sh', tree({ 'test/fixtures/transcripts/a.json': '{"name":"alice-example"}\n' }));
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('OK: no banned tokens found');
    expect(clean.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
    const dirty = guard('check-fixture-privacy.sh', tree({ 'test/fixtures/transcripts/a.json': '{"fund":"Sequoia"}\n' }));
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
  });
});

describe('check-trailing-newline.sh', () => {
  test('a tree with no checked text file reports a skip, not a pass', () => {
    const noCheckedFile: Array<Record<string, string>> = [{}, { 'src/empty.ts': '' }, { 'notes.txt': 'not a checked type' }];
    for (const files of noCheckedFile) {
      const r = guard('check-trailing-newline.sh', tree(files));
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(SKIP_LINE);
      expect(r.stdout).toContain('DEVMODEL_CHECK_SKIPPED: no non-empty tracked text files');
      expect(r.stdout).not.toContain('trailing-newline check: ok');
    }
  });

  test('a checked file passes without a skip; a missing newline still fails', () => {
    const clean = guard('check-trailing-newline.sh', tree({ 'src/a.ts': 'export const a = 1;\n' }));
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('trailing-newline check: ok (1 files)');
    expect(clean.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
    const dirty = guard('check-trailing-newline.sh', tree({ 'src/a.ts': 'export const a = 1;' }));
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
  });
});

describe('check-file-url-pathname.sh', () => {
  test('a test/ with no source file outside the guard fixtures reports a skip', () => {
    const noScannedFile: Array<Record<string, string>> = [
      { 'test/notes.md': 'x\n' },
      { 'test/fixtures/guards/g/bad/a.ts': `${PATHNAME_HIT};\n` },
    ];
    for (const files of noScannedFile) {
      const r = guard('check-file-url-pathname.sh', tree(files, ['test']));
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(SKIP_LINE);
      expect(r.stdout).toContain('DEVMODEL_CHECK_SKIPPED: no .ts, .mts, .js or .mjs files under test/ to scan');
      expect(r.stdout).not.toContain('check-file-url-pathname: ok');
    }
  });

  test('a tree with no test/ stays a failure, not a skip', () => {
    const r = guard('check-file-url-pathname.sh', tree({ 'README.md': 'x\n' }));
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
  });

  test('a scanned clean file passes without a skip; a .pathname hit still fails', () => {
    const clean = guard('check-file-url-pathname.sh', tree({ 'test/a.test.ts': "import { fileURLToPath } from 'node:url';\n" }));
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('check-file-url-pathname: ok');
    expect(clean.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
    const dirty = guard('check-file-url-pathname.sh', tree({ 'test/a.test.ts': `const p = ${PATHNAME_HIT};\n` }));
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).not.toContain('DEVMODEL_CHECK_SKIPPED');
  });
});
