import { mock, test } from 'bun:test';

// R2: a module mock applies to every other file the shard process loads.
mock.module('node:os', () => ({ hostname: () => 'example' }));
test('x', () => {});
