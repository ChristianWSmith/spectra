// sizememory.test.js — the last rendered height of a mounted component is kept by
// name, for the process: a remount reserves the height its last render had.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberHeight, recalledHeight, setSizeStore, loadSizes, onSizesLoaded } from './sizememory.js';

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

test('persisted heights load at startup, and a save waits for the load', async () => {
  let stored = { 'builtin-test-c': 410 };
  const saves = [];
  setSizeStore({
    load: async () => stored,
    save: async (v) => {
      saves.push(v);
    },
  });
  // A height reported before the load lands is not saved yet.
  rememberHeight('builtin-test-d', 120);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(saves.length, 0, 'no save before the stored sizes are read');
  let notified = 0;
  const off = onSizesLoaded(() => notified++);
  await loadSizes();
  off();
  assert.equal(notified, 1, 'subscribers are told the load landed');
  assert.equal(recalledHeight('builtin-test-c'), 410, 'the persisted height is recalled');
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(saves.length, 1, 'the deferred height is saved once the load landed');
  assert.equal(saves[0]['builtin-test-d'], 120);
  assert.equal(saves[0]['builtin-test-c'], 410);
});

test('a height remembered this session beats the stored one', async () => {
  setSizeStore({ load: async () => ({ 'builtin-test-e': 300 }), save: async () => {} });
  rememberHeight('builtin-test-e', 500);
  await loadSizes();
  assert.equal(recalledHeight('builtin-test-e'), 500);
});
