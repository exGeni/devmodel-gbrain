/**
 * scripts/check-dynamic-ci.ts (docs/ci-event-parity.md#trunk-dynamic-ci): the
 * Trunk Dynamic CI filter runs only on pull_request, fails open, and gates only
 * jobs whose if keeps the !cancelled() && != 'false' form. Each case breaks the
 * real test.yml one way and expects the guard to name it; the real tree passes.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { checkWorkflow } from '../../scripts/check-dynamic-ci.ts';

const REPO = resolve(import.meta.dir, '..', '..');
type Doc = { on: Record<string, unknown>; jobs: Record<string, Record<string, any>> };
const real = (name: string) => load(readFileSync(join(REPO, '.github/workflows', name), 'utf8')) as Doc;
const broken = (mutate: (doc: Doc) => void, name = 'test.yml') => { const doc = structuredClone(real(name)); mutate(doc); return checkWorkflow(name, doc); };
const filterStep = (doc: Doc) => doc.jobs['dynamic-ci']!.steps.find((s: { uses?: string }) => s.uses?.startsWith('trunk-io/dynamic-ci@'));

describe('check-dynamic-ci.ts', () => {
  test('the real workflows pass', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts/check-dynamic-ci.ts')], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: '' } });
    expect(r.status, r.stderr).toBe(0);
    expect(checkWorkflow('test.yml', real('test.yml'))).toEqual([]);
  });

  test.each<[string, (doc: Doc) => void, RegExp]>([
    ['the filter runs on every event', doc => { delete doc.jobs['dynamic-ci']!.if; }, /must have if: github.event_name == 'pull_request'/],
    ['the filter also runs on pushes', doc => { doc.jobs['dynamic-ci']!.if = "github.event_name == 'pull_request' || github.event_name == 'push'"; }, /must have if: github.event_name == 'pull_request'/],
    ['the filter is in a workflow without a pull_request trigger', doc => { delete doc.on.pull_request; }, /no pull_request trigger/],
    ['the action is not pinned to a SHA', doc => { filterStep(doc).uses = 'trunk-io/dynamic-ci@v1'; }, /full commit SHA/],
    ['the token is not the repo secret', doc => { filterStep(doc).with.token = 'abc'; }, /secrets\.TRUNK_API_TOKEN/],
    ['job-keys and outputs disagree', doc => { filterStep(doc).with['job-keys'] = 'verify'; }, /job-keys \[verify\] must name exactly/],
    ['an output reads the wrong step output', doc => { doc.jobs['dynamic-ci']!.outputs['stress-changed-tests'] = '${{ steps.dynamic-ci.outputs.verify }}'; }, /output stress-changed-tests must be/],
    ['a gated job drops !cancelled()', doc => { doc.jobs['stress-changed-tests']!.if = doc.jobs['stress-changed-tests']!.if.replace('!cancelled() && ', ''); }, /stress-changed-tests: a gated job's if must start with/],
    ['a gated job tests == true instead of != false', doc => { doc.jobs['stress-changed-tests']!.if = doc.jobs['stress-changed-tests']!.if.replace("!= 'false'", "== 'true'"); }, /stress-changed-tests: a gated job's if must start with/],
    ['a gated job needs another job but drops its success check', doc => { doc.jobs['stress-changed-tests']!.needs = ['dynamic-ci', 'changes']; }, /add needs\.changes\.result == 'success'/],
    ['a gated job adds always()', doc => { doc.jobs['stress-changed-tests']!.if = doc.jobs['stress-changed-tests']!.if.replace("!= 'false'", "!= 'false' && always()"); }, /no other status function/],
    ['a gated job forgets to need the filter', doc => { doc.jobs['stress-changed-tests']!.needs = []; }, /stress-changed-tests: a gated job must list dynamic-ci in needs/],
    ['an aggregate is gated', doc => { doc.jobs['dynamic-ci']!.outputs['full-suite'] = '${{ steps.dynamic-ci.outputs.full-suite }}'; filterStep(doc).with['job-keys'] += ',full-suite'; }, /full-suite: merge and release aggregates are never gated/],
    ['the dynamic-ci step can fail the job', doc => { delete filterStep(doc)['continue-on-error']; }, /needs continue-on-error: true/],
    ['the dynamic-ci step has no timeout of its own', doc => { delete filterStep(doc)['timeout-minutes']; }, /needs a timeout-minutes below the job's/],
    ['the dynamic-ci step timeout is not below the job timeout', doc => { filterStep(doc)['timeout-minutes'] = 5; }, /needs a timeout-minutes below the job's/],
    ['the dynamic-ci step has no id', doc => { delete filterStep(doc).id; }, /the dynamic-ci step needs an id/],
    ['an output names no job', doc => { doc.jobs['dynamic-ci']!.outputs.ghost = '${{ steps.dynamic-ci.outputs.ghost }}'; filterStep(doc).with['job-keys'] += ',ghost'; }, /output ghost names no job/],
    ['a gated job ORs past the gate', doc => { doc.jobs['stress-changed-tests']!.if = doc.jobs['stress-changed-tests']!.if.replace(/ \}\}$/, " && github.event_name == 'push' || github.event_name == 'schedule' }}"); }, /stress-changed-tests: wrap the condition after the gate prefix in parentheses/],
    ['a non-aggregate job reads the verdicts', doc => { doc.jobs.verify!.needs = ['dynamic-ci']; }, /verify: needs dynamic-ci but is not one of its outputs/],
  ])('fails when %s', (_, mutate, message) => {
    const problems = broken(mutate);
    expect(problems.join('\n')).toMatch(message);
  });
});
