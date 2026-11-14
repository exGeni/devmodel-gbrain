import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');

describe('pull-request CI scope', () => {
  test('every event-conditional job or block in a test workflow carries its event-parity classification', () => {
    const conditional = /github\.event_name|github\.event\.(?:pull_request|merge_group|action)|inputs\.scope|"\$EVENT"|\$EVENT\b/;
    const dispatchMode = /github\.event_name\s*(?:!=|==)\s*'workflow_dispatch'/g;
    const unclassified: string[] = [];
    for (const name of ['test', 'stress', 'semgrep']) {
      const lines = readFileSync(join(root, '.github/workflows', `${name}.yml`), 'utf8').split('\n');
      // Blocks: each job (from the comments directly above its key to the next job) and the top-level preamble.
      const starts = lines.flatMap((line, i) => (/^  [\w-]+:\s*$/.test(line) && lines.slice(0, i).some(l => l === 'jobs:') ? [i] : []));
      const blocks: Array<{ label: string; from: number; to: number }> = [];
      const commentTop = (i: number) => { let j = i; while (j > 0 && /^\s*#/.test(lines[j - 1]!)) j--; return j; };
      const jobsLine = lines.indexOf('jobs:');
      blocks.push({ label: 'top level', from: 0, to: jobsLine });
      starts.forEach((start, k) => blocks.push({ label: lines[start]!.trim(), from: commentTop(start), to: k + 1 < starts.length ? commentTop(starts[k + 1]!) : lines.length }));
      for (const block of blocks) {
        const text = lines.slice(block.from, block.to);
        const code = text.filter(l => !/^\s*#/.test(l)).join('\n').replace(dispatchMode, '');
        if (!conditional.test(code)) continue;
        if (!text.some(l => /^\s*#.*docs\/(?:TESTING\.md#event-parity|ci-event-parity\.md#dependency-audit-rule)/.test(l) || /^\s*#\s*Event parity/.test(l))) unclassified.push(`${name}.yml › ${block.label}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  test('the event-parity table lists every classified workflow', () => {
    expect(readFileSync(join(root, 'docs/TESTING.md'), 'utf8')).toContain('### Event parity');
    const docs = readFileSync(join(root, 'docs/ci-event-parity.md'), 'utf8');
    const section = docs.slice(docs.indexOf('## Classification'), docs.indexOf('## Dependency-audit rule'));
    for (const name of ['test', 'stress', 'semgrep', 'osv-scanner', 'nightly-watch']) {
      expect(section, name).toContain(`${name}.yml`);
    }
    expect(docs).toContain('## Dependency-audit rule');
  });
});
