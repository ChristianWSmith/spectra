// Tests for the heatmap kind registry (lib/heatkinds.js): the id list the
// Heatmaps selector renders, its label spellings, the region-drill
// category projection, and — the pin that matters — parity with the Go
// registry (heatmap.go grenadeHeatmapKinds) so a grenade type added on
// one side cannot silently vanish on the other.
// Run: node --test src/lib/heatkinds.test.js   (from frontend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  HEAT_CORE_KINDS,
  HEAT_GRENADE_TYPES,
  HEAT_GRENADE_THROW_KINDS,
  HEAT_GRENADE_DET_KINDS,
  HEAT_KINDS,
  heatKindLabel,
  heatRegionCats,
} from './heatkinds.js';
import { categoryById } from './replay/landmarks.js';

test('kind registry: core + one thrown/det pair per grenade type, no duplicates', () => {
  assert.deepEqual(HEAT_CORE_KINDS, ['presence', 'kills', 'deaths', 'damage', 'kd']);
  assert.deepEqual(
    HEAT_GRENADE_THROW_KINDS,
    HEAT_GRENADE_TYPES.map((t) => `${t}_thrown`),
  );
  assert.deepEqual(
    HEAT_GRENADE_DET_KINDS,
    HEAT_GRENADE_TYPES.map((t) => `${t}_det`),
  );
  assert.deepEqual(HEAT_KINDS, [
    ...HEAT_CORE_KINDS,
    ...HEAT_GRENADE_THROW_KINDS,
    ...HEAT_GRENADE_DET_KINDS,
  ]);
  assert.equal(new Set(HEAT_KINDS).size, HEAT_KINDS.length, 'duplicate kind id');
  for (const k of HEAT_GRENADE_THROW_KINDS.concat(HEAT_GRENADE_DET_KINDS)) {
    const [type, flavor] = [k.slice(0, k.lastIndexOf('_')), k.slice(k.lastIndexOf('_') + 1)];
    assert.ok(HEAT_GRENADE_TYPES.includes(type), `${k}: unknown grenade type`);
    assert.ok(['thrown', 'det'].includes(flavor), `${k}: unknown flavor`);
  }
});

test('grenade ids match the Go registry (heatmap.go grenadeHeatmapKinds)', () => {
  // Source-level pin: the Go map keys are literal "<util>_<flavor>" ids,
  // so the two lists are compared as sets — either side gaining a kind
  // (or splitting Molotov/Incendiary) fails here until the other follows.
  const goSrc = readFileSync(
    fileURLToPath(new URL('../../../heatmap.go', import.meta.url)),
    'utf8',
  );
  const goIds = new Set(goSrc.match(/"[a-z]+_(?:thrown|det)"/g) || []);
  assert.ok(goIds.size > 0, 'no grenade kind ids found in heatmap.go');
  const jsIds = new Set(HEAT_GRENADE_THROW_KINDS.concat(HEAT_GRENADE_DET_KINDS));
  assert.deepEqual(
    [...goIds].map((s) => s.slice(1, -1)).sort(),
    [...jsIds].sort(),
    'frontend and Go grenade kind ids differ',
  );
});

test('labels read as the kind on screen', () => {
  assert.equal(heatKindLabel('kd'), 'K/D');
  for (const k of HEAT_CORE_KINDS) {
    if (k === 'kd') continue;
    assert.equal(heatKindLabel(k), k, `${k} reads as itself`);
  }
  assert.equal(heatKindLabel('he_thrown'), 'HE thrown');
  assert.equal(heatKindLabel('he_det'), 'HE detonation');
  assert.equal(heatKindLabel('flash_thrown'), 'Flash thrown');
  assert.equal(heatKindLabel('smoke_det'), 'Smoke detonation');
  // Molotov ≡ Incendiary: the one option says both spellings.
  assert.equal(heatKindLabel('molotov_thrown'), 'Molotov/Incendiary thrown');
  assert.equal(heatKindLabel('molotov_det'), 'Molotov/Incendiary detonation');
  assert.equal(heatKindLabel('decoy_det'), 'Decoy detonation');
  // Unknown ids pass through instead of rendering blank.
  assert.equal(heatKindLabel('mystery'), 'mystery');
});

test('region drills open the matching landmark categories', () => {
  for (const k of HEAT_GRENADE_THROW_KINDS) {
    const cats = heatRegionCats(k);
    assert.deepEqual(cats, ['grenade_throws'], k);
    const cat = categoryById(cats[0]);
    assert.ok(cat, `${cats[0]} is not a landmark category`);
    assert.deepEqual(cat.kinds, ['grenade_throw'], k);
  }
  for (const k of HEAT_GRENADE_DET_KINDS) {
    const cats = heatRegionCats(k);
    assert.deepEqual(cats, ['grenade_dets'], k);
    const cat = categoryById(cats[0]);
    assert.ok(cat, `${cats[0]} is not a landmark category`);
    assert.deepEqual(cat.kinds, ['grenade'], k);
  }
  assert.deepEqual(heatRegionCats('damage'), ['kills', 'damage']);
  for (const k of ['presence', 'kd', 'kills', 'deaths']) {
    assert.equal(heatRegionCats(k), undefined, `${k} narrows no category`);
  }
});
