#!/usr/bin/env bun
// scripts/select-e2e.ts
//
// E2E selection: a doc-only change runs no E2E; every other change runs the
// whole corpus. Diff narrowing is retired (GBRA-47 C6): a typical E2E file
// imports most of src/, so a file-to-test map selected every file on 40 of 40
// merged pull requests while half of them had to edit it.
//
// Changed files come from git: the working-tree diff vs origin/main plus
// untracked files.
//
//   EMPTY    (no changed files)        -> every test/e2e/*.test.ts
//   DOC_ONLY (every path is a doc)     -> nothing (the only empty stdout)
//   SRC      (anything else)           -> every test/e2e/*.test.ts
//
// On git failure the selector exits 2.
//
// Usage:
//   bun run scripts/select-e2e.ts [--classify-only]

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const NARROWING_RETIRED = "E2E narrowing is retired; running the full E2E corpus (see docs/TESTING.md#e2e-selection)";

// A path counts as doc-only ONLY if it matches one of these patterns.
// Unrecognized paths fall through to SRC. skills/ is product input, not docs.
const DOC_ROOT_FILES = new Set(["LICENSE", "VERSION"]);

function isDocPath(p: string): boolean {
  if (DOC_ROOT_FILES.has(p)) return true;
  if (!p.includes("/") && p.endsWith(".md")) return true;
  return p.startsWith("docs/");
}

export type Classification = "EMPTY" | "DOC_ONLY" | "SRC";

export function classify(changedFiles: string[]): Classification {
  if (changedFiles.length === 0) return "EMPTY";
  return changedFiles.every(isDocPath) ? "DOC_ONLY" : "SRC";
}

export function selectTests(changedFiles: string[], allE2ETests: string[]): string[] {
  return classify(changedFiles) === "DOC_ONLY" ? [] : allE2ETests.slice().sort();
}

function listAllE2ETests(repoRoot: string): string[] {
  const dir = join(repoRoot, "test/e2e");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => `test/e2e/${f}`).sort();
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`select-e2e: git ${args.join(" ")} failed: ${(result.stderr || "").trim()}\n`);
    process.exit(2);
  }
  return result.stdout || "";
}

function splitLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function readChangedFiles(repoRoot: string): string[] {
  const set = new Set<string>();
  for (const args of [["diff", "--name-only", "origin/main...HEAD"], ["diff", "--name-only", "HEAD"], ["ls-files", "--others", "--exclude-standard"]]) {
    for (const line of splitLines(runGit(args, repoRoot))) set.add(line);
  }
  return [...set].sort();
}

if (import.meta.main) {
  const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim();
  if (!repoRoot) {
    process.stderr.write("select-e2e: not a git repository\n");
    process.exit(2);
  }
  const changedFiles = readChangedFiles(repoRoot);
  const classification = classify(changedFiles);
  if (process.argv.includes("--classify-only")) {
    process.stdout.write(classification + "\n");
    process.exit(0);
  }
  if (classification !== "DOC_ONLY") process.stderr.write(NARROWING_RETIRED + "\n");
  const tests = selectTests(changedFiles, listAllE2ETests(repoRoot));
  process.stdout.write(tests.join("\n"));
  if (tests.length > 0) process.stdout.write("\n");
}
