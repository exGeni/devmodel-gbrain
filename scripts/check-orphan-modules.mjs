#!/usr/bin/env node
// check-orphan-modules.mjs — transitive-reachability guard for src/ modules.
//
// Walks static `from '...'`, dynamic `import('...')`, and `require('...')`
// RELATIVE specifiers from the runtime entrypoints (ENTRYPOINTS below) plus
// every package.json `exports` target, and fails when a src/**/*.ts module is
// unreachable and not on the reasoned allowlist below. An orphan module is
// dead weight that still compiles, still greps, and silently rots (a
// spend-cap module with zero callers means the cap is off in production).
//
// Tooling decision (test-gap plan B4, boring-by-default evaluated first):
// knip v5 was tried and REJECTED with evidence — `bunx knip@5` hard-crashes
// on this repo's layout (ENOTDIR scandir on test/**.test.ts during its
// workspace scan, with and without ignore globs, 2026-08-25), and
// deliberate lazy `require()`/`import()` seams would need per-site
// annotations anyway. This walker counts BOTH static and dynamic relative
// imports, so those lazy seams are reachable by construction.
//
// While src/ holds no source file and the allowlist and permitted set are
// empty there is nothing to walk: the guard prints
// `GBRAIN_CHECK_SKIPPED: <reason>` and exits 0, which the verify runner counts
// as a skip. A stale entry still fails.
//
// Self-test seam: argv[2] (or GBRAIN_GUARD_ROOT) points at a fixture tree;
// in fixture mode the entries are the entry*.ts files under src, the
// hard-orphan allowlist is empty, and the permitted test-only set is read from
// `<root>/permitted-test-only.json` (absent = empty), so
// scripts/guard-self-test.sh and test/scripts/check-orphan-modules.test.ts
// can prove every rule fails on bad and passes on good trees.
//
// Exit: 0 clean · 1 orphans, unpermitted test-only modules, or stale
// entries · 2 infra error.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const root = process.argv[2] || process.env.GBRAIN_GUARD_ROOT || '.';
const fixtureMode = !!(process.argv[2] || process.env.GBRAIN_GUARD_ROOT);

const RERUN = 'bun run check:orphan-modules';
const DOCS = 'docs/TESTING.md#orphan-module-guard';
const SELF = 'scripts/check-orphan-modules.mjs';

// Hard-orphan allowlist (repo mode only): modules imported by nothing, not
// even tests. SHRINK-ONLY: a stale entry (module became reachable or was
// deleted) fails the guard so the list can't rot.
const ALLOWLIST = new Map([
  // Empty: every module is reachable from an entrypoint or a test.
]);

// Permitted test-only modules (repo mode): unreachable from every runtime
// entrypoint but imported by the test tree. Every such module must be named
// here with a reason; a test-only module missing from the set fails, and an
// entry that is deleted, wired into a runtime entrypoint, or no longer
// imported by any test fails as stale. The set may grow only with a reason
// string in a reviewer-visible edit. Modules reached from `scripts/**` carry
// reason 'script-reachable', which the guard verifies.
const PERMITTED_TEST_ONLY = [
  // Empty: no module is test-only. Add { path, reason } here, with a reason.
];

// Runtime entrypoints (repo mode), as paths under src/. Every module must be
// reachable from one of these, a package.json `exports` target, or the test
// tree. Empty while src/ is: name the entrypoints when product code lands.
const ENTRYPOINTS = [];

const RULES = {
  hardOrphan: 'orphan-modules/hard-orphan',
  unpermitted: 'orphan-modules/unpermitted-test-only',
  invalidEntry: 'orphan-modules/invalid-permitted-entry',
  stalePermitted: 'orphan-modules/stale-permitted-entry',
  staleAllowlist: 'orphan-modules/stale-allowlist-entry',
};

function walkDir(dir, match, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === '.git') continue;
      walkDir(p, match, out);
    } else if (match(p)) {
      out.push(p);
    }
  }
  return out;
}

function loadPermitted() {
  if (!fixtureMode) return PERMITTED_TEST_ONLY;
  const file = join(root, 'permitted-test-only.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`check-orphan-modules: cannot parse ${file}: ${err.message}`);
    process.exit(2);
  }
}

function report(rule, path, lines) {
  console.error(`FAIL [${rule}] ${path}`);
  for (const line of lines) console.error(`  ${line}`);
  console.error(`  rerun: ${RERUN}`);
  console.error(`  docs: ${DOCS}`);
}

function main() {
  const srcDir = join(root, 'src');
  const isTs = (p) => p.endsWith('.ts') && !p.endsWith('.d.ts');
  const srcFiles = walkDir(srcDir, isTs).map(p => relative(root, p));
  const srcSet = new Set(srcFiles);

  const allow = fixtureMode ? new Map() : ALLOWLIST;
  const permittedList = loadPermitted();
  if (srcFiles.length === 0 && allow.size === 0 && permittedList.length === 0) {
    console.log('GBRAIN_CHECK_SKIPPED: no source files under src/ and no allowlist or permitted test-only entries');
    process.exit(0);
  }

  let entries = [];
  if (fixtureMode) {
    entries = srcFiles.filter(f => /(^|\/)entry[^/]*\.ts$/.test(f));
  } else {
    entries = ENTRYPOINTS.filter(f => srcSet.has(f));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const target of Object.values(pkg.exports ?? {})) {
      const rel = String(target).replace(/^\.\//, '');
      if (srcSet.has(rel)) entries.push(rel);
    }
  }
  if (entries.length === 0 && srcFiles.length > 0) {
    console.error('check-orphan-modules: no entrypoints found');
    process.exit(2);
  }

  // Relative-specifier extraction: static, dynamic, and require forms.
  const IMPORT_RE = /(?:from\s+|import\(\s*|require\(\s*)['"](\.[^'"]+)['"]/g;
  const resolveSpec = (fromFile, spec, allowOutsideSrc) => {
    const base = join(root, dirname(fromFile), spec);
    for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
      const rel = relative(root, cand);
      if (srcSet.has(rel)) return rel;
      if (allowOutsideSrc && allowOutsideSrc(rel) && existsSync(cand) && statSync(cand).isFile()) return rel;
    }
    return null;
  };

  // Crawls from seed files; files outside src/ are followed only when
  // `allowOutsideSrc` accepts them. Records each file's direct importers.
  const crawl = (seedFiles, allowOutsideSrc) => {
    const seen = new Set();
    const importers = new Map();
    const stack = [...seedFiles];
    while (stack.length > 0) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      let text;
      try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
      let m;
      const re = new RegExp(IMPORT_RE.source, 'g');
      while ((m = re.exec(text)) !== null) {
        const dep = resolveSpec(f, m[1], allowOutsideSrc);
        if (!dep) continue;
        if (!importers.has(dep)) importers.set(dep, new Set());
        importers.get(dep).add(f);
        if (!seen.has(dep)) stack.push(dep);
      }
    }
    return { seen, importers };
  };

  const runtimeReachable = crawl(entries).seen;

  const testSeeds = walkDir(join(root, 'test'), (p) => p.endsWith('.ts')).map(p => relative(root, p));
  const testCrawl = crawl(testSeeds, (rel) => rel.startsWith('test/'));
  const testReachable = new Set([...testCrawl.seen].filter(f => srcSet.has(f)));

  const scriptSeeds = walkDir(join(root, 'scripts'), (p) => /\.(ts|mjs|js)$/.test(p)).map(p => relative(root, p));
  const scriptCrawl = crawl(scriptSeeds, (rel) => rel.startsWith('scripts/'));
  const scriptReachable = new Set([...scriptCrawl.seen].filter(f => srcSet.has(f)));

  const permitted = new Map();
  const invalid = [];
  for (const entry of permittedList) {
    const path = entry?.path;
    if (typeof path !== 'string' || path.length === 0) {
      invalid.push({ path: JSON.stringify(entry), why: 'entry has no path' });
    } else if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      invalid.push({ path, why: 'entry has no reason; every permitted test-only module needs one' });
    } else if (permitted.has(path)) {
      invalid.push({ path, why: 'duplicate entry' });
    } else {
      permitted.set(path, entry.reason);
    }
  }

  const testImporters = (f) => {
    const direct = [...(testCrawl.importers.get(f) ?? [])].sort();
    const fromTests = direct.filter(p => p.startsWith('test/'));
    return fromTests.length > 0 ? fromTests : direct;
  };

  const notRuntime = srcFiles.filter(f => !runtimeReachable.has(f));
  const hardOrphans = notRuntime.filter(f => !testReachable.has(f) && !allow.has(f) && !permitted.has(f)).sort();
  const testOnly = notRuntime.filter(f => testReachable.has(f) && !allow.has(f)).sort();
  const unpermitted = testOnly.filter(f => !permitted.has(f));

  const stalePermitted = [];
  for (const [path, reason] of permitted) {
    if (!srcSet.has(path)) stalePermitted.push({ path, why: 'the module no longer exists' });
    else if (runtimeReachable.has(path)) stalePermitted.push({ path, why: 'the module is now reachable from a runtime entrypoint' });
    else if (!testReachable.has(path)) stalePermitted.push({ path, why: 'no test imports the module any more' });
    else if (reason === 'script-reachable' && !scriptReachable.has(path)) stalePermitted.push({ path, why: "tagged 'script-reachable' but no scripts/** file imports it" });
  }
  stalePermitted.sort((a, b) => a.path.localeCompare(b.path));
  const staleAllow = [...allow.keys()].filter(f => !srcSet.has(f) || runtimeReachable.has(f)).sort();

  for (const f of hardOrphans) {
    report(RULES.hardOrphan, f, [
      'reason: unreachable from every runtime entrypoint and every test',
      `remedy: wire the module into a runtime caller or delete it; a deliberate keep needs a reasoned ALLOWLIST entry in ${SELF}`,
    ]);
  }
  for (const f of unpermitted) {
    const via = testImporters(f);
    report(RULES.unpermitted, f, [
      `imported by: ${via.length > 0 ? via.join(', ') : '(transitively, via the test tree)'}`,
      'reason: reachable from tests but from no runtime entrypoint (ENTRYPOINTS, package exports)',
      `remedy: wire the module into a runtime caller, delete it with its tests, or add { path, reason } to PERMITTED_TEST_ONLY in ${SELF} (reason 'script-reachable' when scripts/** imports it)`,
    ]);
  }
  for (const { path, why } of invalid) {
    report(RULES.invalidEntry, path, [
      `reason: ${why}`,
      `remedy: fix the record in PERMITTED_TEST_ONLY in ${SELF}`,
    ]);
  }
  for (const { path, why } of stalePermitted) {
    report(RULES.stalePermitted, path, [
      `reason: ${why}`,
      `remedy: remove this record from PERMITTED_TEST_ONLY in ${SELF} (or correct its reason); do not restore code to satisfy the list`,
    ]);
  }
  for (const f of staleAllow) {
    report(RULES.staleAllowlist, f, [
      'reason: allowlisted as a hard orphan but now runtime-reachable or deleted',
      `remedy: remove this record from ALLOWLIST in ${SELF}; do not restore code to satisfy the list`,
    ]);
  }

  const failures = hardOrphans.length + unpermitted.length + invalid.length + stalePermitted.length + staleAllow.length;
  if (failures > 0) {
    console.error(`check-orphan-modules: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(
    `check-orphan-modules: OK (${srcFiles.length} modules, ${entries.length} entrypoints, ` +
    `${allow.size} allowlisted, ${testOnly.length} permitted test-only)`,
  );
}

main();
