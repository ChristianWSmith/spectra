// sizememory.test.js — the last rendered height of a mounted component is kept by
// name, for the process: a remount reserves the height its last render had.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberHeight, recalledHeight } from './sizememory.js';

test('a height is recalled by name after it is remembered', () => {
  assert.equal(recalledHeight('builtin-test-a'), null, 'nothing remembered yet');
  rememberHeight('builtin-test-a', 240);
  assert.equal(recalledHeight('builtin-test-a'), 240);
  rememberHeight('builtin-test-a', 310);
  assert.equal(recalledHeight('builtin-test-a'), 310, 'the last render wins');
});

test('an empty or unnamed render remembers nothing', () => {
  rememberHeight('builtin-test-b', 0);
  rememberHeight('builtin-test-b', NaN);
  rememberHeight(null, 200);
  assert.equal(recalledHeight('builtin-test-b'), null);
  assert.equal(recalledHeight(null), null);
});
