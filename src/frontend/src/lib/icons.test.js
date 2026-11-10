// Unit tests for the icon-manifest loader (pure parts): fail-soft
// normalization of any/absent/malformed manifest bodies, canonical-name
// → URL lookup, and the null fallback that means "render the text
// label". The fetch/preload halves need a browser (Image) or a live
// backend, so they're exercised by the app, not here.
// Run: node --test src/lib/icons.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeManifest, iconURL, loadIconManifest, resetIconManifest } from './replay/icons.js';

const FULL = {
  extracted: true,
  count: 2,
  icons: { 'AK-47': '/api/icons/ak47.svg', 'Smoke Grenade': '/api/icons/smokegrenade.svg' },
  note: '',
};

test('normalizeManifest keeps a well-formed manifest intact', () => {
  const m = normalizeManifest(FULL);
  assert.equal(m.extracted, true);
  assert.equal(m.count, 2);
  assert.equal(m.icons['AK-47'], '/api/icons/ak47.svg');
  assert.equal(iconURL('Smoke Grenade', m), '/api/icons/smokegrenade.svg');
});

test('normalizeManifest is fail-soft on null/garbage bodies', () => {
  for (const raw of [null, undefined, 'nope', 42, true, [], { icons: 'nope' }, { icons: 7 }]) {
    const m = normalizeManifest(raw);
    assert.equal(m.extracted, false, `${JSON.stringify(raw)} → extracted false`);
    assert.equal(m.count, 0);
    assert.deepEqual(m.icons, {});
    assert.equal(iconURL('AK-47', m), null, 'lookup misses on the empty manifest');
  }
});

test('normalizeManifest drops malformed entries and recomputes count', () => {
  const m = normalizeManifest({
    extracted: true,
    count: 99, // server lie / stale — count must match what survived
    icons: { 'AK-47': '/api/icons/ak47.svg', bad: 42, nope: null, blank: '' },
    note: 17,
  });
  assert.deepEqual(Object.keys(m.icons), ['AK-47']);
  assert.equal(m.count, 1, 'count === surviving entries');
  assert.equal(typeof m.note, 'string', 'note is always a string');
});

test('iconURL is an exact-match lookup that misses to null', () => {
  const m = normalizeManifest(FULL);
  assert.equal(iconURL('AK-47', m), '/api/icons/ak47.svg');
  // Case variants are NOT the canonical vocabulary — miss, don't guess.
  assert.equal(iconURL('ak-47', m), null);
  assert.equal(iconURL('C4', m), null, 'unmapped name → text-label fallback');
  assert.equal(iconURL('AK-47', null), null, 'no manifest → null, never throws');
  assert.equal(iconURL('AK-47', undefined), null);
  assert.equal(iconURL('AK-47', { extracted: true }), null, 'manifest without icons');
  assert.equal(iconURL(undefined, m), null);
});

test('loadIconManifest fails soft to the empty manifest and re-arms', async () => {
  resetIconManifest();
  // No fetch in node < 18-style envs / offline: global fetch exists in
  // node ≥18 but '/api/icons/...' has no server — either a network error
  // or (with a stub) a 404. Both must resolve to the empty manifest and
  // leave the memo disarmed so a later call retries.
  const first = await loadIconManifest();
  assert.equal(first.extracted, false);
  assert.deepEqual(first.icons, {});
  const second = await loadIconManifest();
  assert.equal(second.extracted, false, 'a failed load never throws on retry');
  // Never rejects: attach a rejection tripwire.
  resetIconManifest();
  await assert.doesNotReject(() => loadIconManifest().then(() => {}));
});
