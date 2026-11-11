// Tests for the heatmap kind registry (lib/heatkinds.js): the id list the
// Heatmaps selector renders, its label spellings, the region-drill
// filter projection (categories, bbox capability and the settings →
// landmark-filter mapping behind a region click), and — the pin that
// matters — parity with the Go registry (heatmap.go grenadeHeatmapKinds)
// so a grenade type added on one side cannot silently vanish on the
// other.
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
  heatRegionFilter,
  heatRegionTakesBBox,
} from './heatkinds.js';
import { categoryById, serializeLandmarkFilter } from './replay/landmarks.js';

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
  // 'decoy' here is the STORED utility-kind vocabulary (models.UtilityWeaponKind
  // → heatmap.go grenadeHeatmapKinds) — a DIFFERENT vocabulary from the
  // replay's detonation buckets, where 'decoy' was removed (a decoy
  // detonation buckets 'he' now). Inert w.r.t. that change: decoy rows
  // still store kind 'grenade' + weapon 'Decoy Grenade', so the decoy_det
  // heatmaps keep working.
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
  // DELIBERATE PIN CHANGES (bbox empty-arrival fix, then the enabled-
  // claim flip): kills/kd/deaths used to narrow NO category, so a region
  // drill arrived with the sparse default ['round_starts'] — round-start
  // rows store no position, and the bbox then excluded EVERY row
  // (guaranteed-empty arrival); they projected onto the KILLS category,
  // and deaths followed it while no stamping existed. With enabled-claim
  // stamping in the SAME commit (landmarks.rowCategory), DEATHS projects
  // onto ['deaths'] so the arrival's kill rows PRESENT as deaths there —
  // and killRoleFor derives the victim player role from those same
  // category ids; the store's either-endpoint bbox (queries.go) matches
  // their victim positions either way. kd spans both views but keeps the
  // kills projection (owner ruling).
  for (const k of ['kills', 'kd']) {
    assert.deepEqual(heatRegionCats(k), ['kills'], k);
  }
  assert.deepEqual(heatRegionCats('deaths'), ['deaths']);
  const deathsCat = categoryById('deaths');
  assert.ok(deathsCat, 'deaths is a landmark category');
  assert.deepEqual(deathsCat.kinds, ['kill'], 'deaths claims the kill kind');
  // presence keeps narrowing nothing: it has no event counterpart — and
  // heatRegionTakesBBox keeps its bbox out of the arrival as well (a bbox
  // it cannot satisfy would guarantee an empty feed).
  assert.equal(heatRegionCats('presence'), undefined);
  assert.equal(heatRegionTakesBBox('presence'), false);
  for (const k of HEAT_KINDS) {
    if (k === 'presence') continue;
    assert.equal(heatRegionTakesBBox(k), true, `${k} drills with its bbox`);
  }
});

test('heatRegionFilter: cats + player + round range, sentinels omitted', () => {
  // No settings → only the kind's category projection; presence has none,
  // so a presence click with no settings is a PLAIN arrival ({}).
  assert.deepEqual(heatRegionFilter('kills', {}), { cats: ['kills'] });
  assert.deepEqual(heatRegionFilter('presence', {}), {});
  // The player selector: '' (All players) omits, a steam id maps to the
  // filter's player key (steamId — serialize emits it as ?player=).
  assert.deepEqual(heatRegionFilter('kills', { player: '' }), { cats: ['kills'] });
  assert.deepEqual(heatRegionFilter('kd', { player: '76561198012345678' }), {
    cats: ['kills'],
    steamId: '76561198012345678',
  });
  // The heatmap's `-1 = all` sentinel maps to the filter's `0 = open`
  // bound (landmarks.DEFAULT_FILTER): both omit the key. 0 omits too.
  assert.deepEqual(heatRegionFilter('damage', { roundFrom: -1, roundTo: -1 }), {
    cats: ['kills', 'damage'],
  });
  assert.deepEqual(heatRegionFilter('damage', { roundFrom: 0, roundTo: 0 }), {
    cats: ['kills', 'damage'],
  });
  // A real range keeps BOTH bounds (partial ranges are legal — an open
  // side simply stays omitted).
  assert.deepEqual(heatRegionFilter('damage', { roundFrom: 7, roundTo: -1 }), {
    cats: ['kills', 'damage'],
    roundFrom: 7,
  });
  assert.deepEqual(heatRegionFilter('kills', { roundFrom: 3, roundTo: 12 }), {
    cats: ['kills'],
    roundFrom: 3,
    roundTo: 12,
  });
  // Absent / junk settings never throw and never invent a bound.
  assert.deepEqual(heatRegionFilter('kills'), { cats: ['kills'] });
  assert.deepEqual(heatRegionFilter('kills', { roundFrom: 'x', roundTo: NaN, player: null }), {
    cats: ['kills'],
  });
  // NO side/team key: the heatmap's team selector has no filter counterpart
  // (queued separately), so a team setting is ignored rather than invented.
  assert.deepEqual(heatRegionFilter('kills', { team: 'ct', player: '1', roundFrom: 1, roundTo: 2 }), {
    cats: ['kills'],
    steamId: '1',
    roundFrom: 1,
    roundTo: 2,
  });
});

test('heatRegionFilter output round-trips through the URL (feed reveal keys)', () => {
  // The arrival is built with replayHash → serializeLandmarkFilter: every
  // key the helper emits must survive as a non-default URL param (which
  // is also what shouldRevealFeed keys off) — and {} must serialize to
  // nothing (a plain arrival stays silent).
  assert.deepEqual(
    serializeLandmarkFilter(heatRegionFilter('kills', { player: '1', roundFrom: 3, roundTo: 9 })),
    { cat: 'kills', player: '1', roundFrom: '3', roundTo: '9' },
  );
  assert.deepEqual(serializeLandmarkFilter(heatRegionFilter('presence', {})), {});
});
