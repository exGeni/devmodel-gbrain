import { describe, test } from 'bun:test';

// DEVMODEL_TEST_* survives the scrub.
describe.skipIf(!process.env.DEVMODEL_TEST_FIXTURE_COMPILE_SMOKE)('compiled smoke', () => {
  test('runs', () => {});
});

// A file that sets the name itself may gate on it.
process.env.DEVMODEL_FIXTURE_SELF_SET = '1';
if (process.env.DEVMODEL_FIXTURE_SELF_SET !== '1') throw new Error('unreachable');

// A product setting (read in src/) asserted absent is hermeticity, not an opt-in.
if (process.env.DEVMODEL_FIXTURE_PRODUCT_SETTING === '1') throw new Error('product escape hatch is on');

// Non-gating reads are out of scope.
const budget = 100 * (Number(process.env.DEVMODEL_FIXTURE_MULTIPLIER) || 1);
export { budget };
