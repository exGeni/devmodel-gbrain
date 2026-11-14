// test/select-e2e.test.ts
//
// The E2E selector after narrowing retired (GBRA-47 C6): doc-only changes
// select nothing and every other change selects the whole corpus. The changed
// files come from git: the working tree against origin/main.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { classify, NARROWING_RETIRED, selectTests } from "../scripts/select-e2e.ts";

const ALL_E2E = ["test/e2e/sync.test.ts", "test/e2e/cycle.test.ts", "test/e2e/mechanical.test.ts"];
const SELECTOR = join(import.meta.dir, "../scripts/select-e2e.ts");

describe("classify", () => {
  test("empty -> EMPTY", () => {
    expect(classify([])).toBe("EMPTY");
  });
  test("only doc paths -> DOC_ONLY", () => {
    expect(classify(["README.md", "docs/foo.md", "CHANGELOG.md"])).toBe(
      "DOC_ONLY"
    );
  });
  test("any non-doc path -> SRC", () => {
    expect(classify(["README.md", "src/cli.ts"])).toBe("SRC");
  });
  test("skills/ is NOT doc-only (Codex F4)", () => {
    expect(classify(["skills/RESOLVER.md"])).toBe("SRC");
  });
});

describe("selectTests", () => {
  test("a doc-only change selects nothing", () => {
    expect(selectTests(["docs/guides/example.md", "README.md"], ALL_E2E)).toEqual([]);
  });
  test.each([
    ["an empty change", []],
    ["a source change", ["src/core/search/intent.ts"]],
    ["a direct test edit", ["test/e2e/sync.test.ts"]],
    ["a workflow edit", [".github/workflows/test.yml"]],
    ["mixed docs and source", ["docs/foo.md", "src/cli.ts"]],
  ])("%s selects the whole corpus, sorted", (_label, changed) => {
    expect(selectTests(changed, ALL_E2E)).toEqual([...ALL_E2E].sort());
  });
});

describe("selector CLI", () => {
  /** A repository whose base commit tracks the two E2E files; `files` are then written on top of it, uncommitted. */
  function run(args: string[], files: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "gbrain-select-e2e-"));
    try {
      const git = (...a: string[]) => expect(spawnSync("git", a, { cwd: dir, encoding: "utf8" }).status).toBe(0);
      git("init", "-q");
      mkdirSync(join(dir, "test/e2e"), { recursive: true });
      for (const file of ["test/e2e/a.test.ts", "test/e2e/b.test.ts"]) writeFileSync(join(dir, file), "// fixture\n");
      git("add", "-A");
      git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "base");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), body);
      }
      return spawnSync(process.execPath, ["--no-env-file", SELECTOR, ...args], { cwd: dir, encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a code change in the working tree lists every E2E file and says narrowing is retired", () => {
    const r = run([], { "src/cli.ts": "// change\n" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("test/e2e/a.test.ts\ntest/e2e/b.test.ts\n");
    expect(r.stderr).toContain(NARROWING_RETIRED);
  });

  test("a doc-only change in the working tree selects nothing", () => {
    const r = run([], { "docs/a.md": "# doc\n", "README.md": "# readme\n" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain(NARROWING_RETIRED);
  });

  test("a tree with no change selects everything (the fail-closed fallback)", () => {
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("test/e2e/a.test.ts\ntest/e2e/b.test.ts\n");
  });

  test.each([
    ["a code change", { "src/cli.ts": "// change\n" }, "SRC"],
    ["a doc-only change", { "docs/a.md": "# doc\n" }, "DOC_ONLY"],
    ["no change", {}, "EMPTY"],
  ])("--classify-only prints the classification of %s", (_label, files, expected) => {
    const r = run(["--classify-only"], files);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${expected}\n`);
  });
});
