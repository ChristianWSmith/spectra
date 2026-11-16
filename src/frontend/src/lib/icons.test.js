// Unit tests for the icon-manifest loader (pure parts): fail-soft
// normalization of any/absent/malformed manifest bodies, canonical-name
// → URL lookup, the map-name → logo lookup over the SPLIT maps half
// (count stays the icons size), and the null fallback that means
// "render the text label". The fetch/preload halves need a browser
// (Image) or a live backend, so they're exercised by the app, not here.
// Run: node --test src/lib/icons.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeManifest, iconURL, mapIconURL, loadIconManifest, resetIconManifest } from './replay/icons.js';

const FULL = {
  extracted: true,
  count: 2,
  icons: { 'AK-47': '/api/icons/ak47.svg', 'Smoke Grenade': '/api/icons/smokegrenade.svg' },
  maps: { de_mirage: '/api/icons/map_icon_de_mirage.svg' },
  mapCount: 1,
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
    assert.deepEqual(m.maps, {}, `${JSON.stringify(raw)} → empty maps half`);
    assert.equal(m.mapCount, 0);
    assert.equal(iconURL('AK-47', m), null, 'lookup misses on the empty manifest');
    assert.equal(mapIconURL('de_mirage', m), null, 'map lookup misses on the empty manifest');
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

test('normalizeManifest carries the maps half (string→string only, frozen, split count)', () => {
  const m = normalizeManifest({
    extracted: true,
    count: 9,
    icons: { 'AK-47': '/api/icons/ak47.svg' },
    maps: {
      de_mirage: '/api/icons/map_icon_de_mirage.svg',
      bad: 42,
      blank: '',
      nope: null,
    },
    mapCount: 99, // server lie — recomputed like count
  });
  assert.deepEqual(Object.keys(m.maps), ['de_mirage']);
  assert.equal(m.mapCount, 1, 'mapCount === surviving map entries');
  assert.equal(m.count, 1, 'count stays the ICONS size — maps never inflate it');
  assert.ok(Object.isFrozen(m.maps), 'maps is frozen like icons');
  assert.ok(Object.isFrozen(m), 'the manifest itself is frozen');
});

test('normalizeManifest still returns the shared empty manifest when nothing survives', () => {
  // Both halves empty → the one fail-soft shape (a maps-only payload
  // with nothing servable is not a manifest either).
  const m = normalizeManifest({ extracted: true, icons: {}, maps: { bad: 7 } });
  assert.equal(m.count, 0);
  assert.equal(m.mapCount, 0);
  assert.deepEqual(m.maps, {});
  assert.equal(m.extracted, false);
});

test('iconURL is an exact-match lookup that misses to null', () => {
  const m = normalizeManifest(FULL);
  assert.equal(iconURL('AK-47', m), '/api/icons/ak47.svg');
  // Case variants are NOT the canonical vocabulary — miss, don't guess.
  assert.equal(iconURL('ak-47', m), null);
  assert.equal(iconURL('C4', m), null, 'unmapped name → text-label fallback');
  assert.equal(iconURL('de_mirage', m), null, 'a MAP name never resolves through icons');
  assert.equal(iconURL('AK-47', null), null, 'no manifest → null, never throws');
  assert.equal(iconURL('AK-47', undefined), null);
  assert.equal(iconURL('AK-47', { extracted: true }), null, 'manifest without icons');
  assert.equal(iconURL(undefined, m), null);
});

test('mapIconURL resolves a map name through the maps half and misses to null', () => {
  const m = normalizeManifest(FULL);
  assert.equal(mapIconURL('de_mirage', m), '/api/icons/map_icon_de_mirage.svg');
  // The half is a plain exact-match table: no guessing, no fallbacks.
  assert.equal(mapIconURL('de_dust2', m), null, 'unlisted map → the bare map name');
  assert.equal(mapIconURL('DE_MIRAGE', m), null, 'case variants are not map names');
  assert.equal(mapIconURL('AK-47', m), null, 'equipment names never resolve through maps');
  assert.equal(mapIconURL('de_mirage', null), null, 'no manifest → null, never throws');
  assert.equal(mapIconURL('de_mirage', undefined), null);
  assert.equal(mapIconURL('de_mirage', { extracted: true }), null, 'manifest without maps');
  assert.equal(mapIconURL(undefined, m), null);
  assert.equal(mapIconURL('', m), null, 'the empty map cell (—) never resolves');
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
