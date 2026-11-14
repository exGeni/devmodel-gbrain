import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Reading the environment, a comparison and a tmpdir scratch directory are all fine.
test('x', () => {
  expect(process.env.EXAMPLE_FLAG === '1').toBe(false);
  expect(mkdtempSync(join(tmpdir(), 'example-')).length).toBeGreaterThan(0);
});
