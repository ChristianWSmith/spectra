// Unit tests for the download helpers (B3) — filename → extension
// derivation and the promise contracts (reject on failure, "" on cancel).
// The save plumbing itself (lib/save.js → DialogService) is behind a
// native dialog and is covered by the app, not here: save.js is stubbed.
// Run: node --test src/lib/download.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

// download.js → save.js → services.js → the generated bindings, which node
// imports as a directory (see esm-dir-hook.mjs).
installEsmDirHook();
const { extFromName } = await import('./download.js');

test('extFromName takes the trailing extension', () => {
  assert.equal(extFromName('report.md'), 'md');
  assert.equal(extFromName('spectra-match-42.html'), 'html');
  assert.equal(extFromName('clip-42-1000.webm'), 'webm');
  assert.equal(extFromName('replay-42-99.png'), 'png');
  assert.equal(extFromName('spectra-library.db'), 'db');
});

test('extFromName falls back when there is no extension', () => {
  assert.equal(extFromName('archive'), 'txt');
  assert.equal(extFromName('', 'csv'), 'csv');
  assert.equal(extFromName(undefined, 'bin'), 'bin');
  assert.equal(extFromName('noext', 'csv'), 'csv'); // explicit fallback
  // Leading dot is not an extension (`dot > 0`).
  assert.equal(extFromName('.hidden'), 'txt');
  // A trailing dot yields the empty suffix.
  assert.equal(extFromName('archive.', 'txt'), '');
});

test('extFromName keeps multi-part names on the last segment', () => {
  assert.equal(extFromName('match-1.tar.gz'), 'gz');
  assert.equal(extFromName('C:\\exports\\report.md'), 'md'); // Windows path
});
