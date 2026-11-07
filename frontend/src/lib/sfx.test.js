// Sound-effect cue math tests (lib/replay/sfx.js): the utility-cue
// derivation (flashbang double-dispatch dedupe, decoy skip, C4), the
// range/seek guards, the random variant pick, the weapon-name resolver
// and the rising-edge gun cues. Run: node --test src/lib/sfx.test.js
// (from frontend/; the lib test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

installEsmDirHook();

// sfx.js imports services.js (errText) for its error strings — the real
// bindings talk to a live Wails backend, so redirect them to the test
// stubs before the module graph loads (same hooks as
// services-cache.test.js; hooks are per-process, this file runs alone).
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const {
  AUDIO_VOL_DEFAULT,
  SOUND_DETONATION_BUCKETS,
  grenadeCues,
  utilCuesInRange,
  cueGapJump,
  pickVariant,
  weaponNameOf,
  gunCues,
  prefVolume,
  normalizeSoundManifest,
} = await import('./replay/sfx.js');

// --- utility cues ----------------------------------------------------------

const row = (over) => ({ kind: 'grenade', bucket: 'he', weapon: 'HE Grenade', tick: 100, ...over });

test('grenadeCues keeps only detonation buckets (decoy and throws skipped)', () => {
  const cues = grenadeCues([
    row({ tick: 10, bucket: 'he' }),
    row({ tick: 20, bucket: 'flash', weapon: 'Flashbang' }),
    row({ tick: 30, bucket: 'decoy', weapon: 'Decoy Grenade' }), // no such sound in CS2
    row({ tick: 40, bucket: 'smoke', weapon: 'Smoke Grenade' }),
    row({ tick: 50, bucket: 'fire', weapon: 'Molotov' }),
    row({ tick: 60, bucket: 'detonation', weapon: 'Weird Nade' }),
    { kind: 'grenade_throw', bucket: 'throw', weapon: 'HE Grenade', tick: 70 }, // not a detonation
    { kind: 'kill', bucket: 'kill', weapon: 'AK-47', tick: 80 },
  ]);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['10:HE Grenade', '20:Flashbang', '40:Smoke Grenade', '50:Molotov', '60:Weird Nade'],
  );
});

test('grenadeCues dedupes the doubled flashbang dispatch (CS2.md: FlashExplode fires twice)', () => {
  // demoinfocs v6 dispatches events.FlashExplode from BOTH the game event
  // and the projectile's entity on-destroy — 182 rows at 91 distinct
  // ticks in the golden demo. Without the (tick, weapon) dedupe every
  // flashbang would play twice.
  const cues = grenadeCues([
    row({ tick: 500, bucket: 'flash', weapon: 'Flashbang' }),
    row({ tick: 500, bucket: 'flash', weapon: 'Flashbang' }),
    row({ tick: 500, bucket: 'flash', weapon: 'Flashbang' }), // triple is still one
    row({ tick: 500, bucket: 'he', weapon: 'HE Grenade' }), // same tick, OTHER weapon: kept
  ]);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['500:Flashbang', '500:HE Grenade'],
  );
});

test('grenadeCues includes the C4 explosion via bomb_explode and sorts by tick', () => {
  const cues = grenadeCues([
    { kind: 'bomb_explode', bucket: 'explode', weapon: 'C4', tick: 900 },
    row({ tick: 100, bucket: 'he' }),
    { kind: 'bomb_explode', bucket: 'explode', weapon: '', tick: 50 }, // no weapon → dropped, never invented
    { kind: 'bomb_plant', bucket: 'plant', weapon: 'C4', tick: 10 }, // not an explosion
    { kind: 'grenade', bucket: 'he', weapon: 'HE Grenade' }, // no tick → dropped
    null, // hostile input never throws
  ]);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['100:HE Grenade', '900:C4'],
  );
});

test('utilCuesInRange is open at the left and closed at the right', () => {
  const cues = [
    { tick: 100, name: 'A' },
    { tick: 200, name: 'B' },
    { tick: 300, name: 'C' },
  ];
  assert.deepEqual(utilCuesInRange(cues, 100, 300).map((c) => c.name), ['B', 'C']); // 100 already played
  assert.deepEqual(utilCuesInRange(cues, 99, 100).map((c) => c.name), ['A']);
  assert.deepEqual(utilCuesInRange(cues, 300, 400), []); // past the end
  assert.deepEqual(utilCuesInRange(cues, 0, 50).map((c) => c.name), []); // before the start
  assert.deepEqual(utilCuesInRange([], 0, 50), []);
  assert.deepEqual(utilCuesInRange(cues, NaN, 500), []);
});

// --- seek / pause guard ----------------------------------------------------

test('cueGapJump: ordinary playback steps are not jumps, seeks are', () => {
  const tr = 64;
  // First draw (nothing to compare against) seeds.
  assert.equal(cueGapJump(100, null, 1, tr), true);
  // Same tick (paused redraw) is not a jump.
  assert.equal(cueGapJump(100, 100, 1, tr), false);
  // Backwards = loop wrap or reverse scrub → seed.
  assert.equal(cueGapJump(50, 100, 1, tr), true);
  // Ordinary forward steps (the engine clamps dt at 0.25 s → ≤16 ticks
  // at 1×, well inside the 0.3 s window) are not jumps…
  assert.equal(cueGapJump(110, 100, 1, tr), false);
  // …but a step past the window is (a real seek, or a throttled tab).
  assert.equal(cueGapJump(130, 100, 1, tr), true);
  // A 15 s seek (the transport buttons) is way past the window.
  assert.equal(cueGapJump(100 + 15 * tr, 100, 1, tr), true);
  // The window scales with speed: one 8× rAF step (~8 ticks) is
  // ordinary, a gap past 8×0.3 s of ticks is a seek.
  assert.equal(cueGapJump(108, 100, 8, tr), false);
  assert.equal(cueGapJump(100 + 160, 100, 8, tr), true);
});

// --- random variant pick ---------------------------------------------------

test('pickVariant picks uniformly in range and never leaves the list', () => {
  const variants = ['a', 'b', 'c'];
  assert.equal(pickVariant(variants, () => 0), 'a');
  assert.equal(pickVariant(variants, () => 0.34), 'b');
  assert.equal(pickVariant(variants, () => 0.999), 'c');
  // A rand() at the very top of its range must clamp, not read past the end.
  assert.equal(pickVariant(variants, () => 1), 'c');
  assert.equal(pickVariant(['only'], () => 0.7), 'only');
  assert.equal(pickVariant([], () => 0.5), null);
  assert.equal(pickVariant(null, () => 0.5), null);
});

// --- weapon name resolution ------------------------------------------------

test('weaponNameOf: the stream carries names, indices resolve through the vocabulary', () => {
  const names = ['AK-47', 'M4A4', 'HE Grenade'];
  assert.equal(weaponNameOf('AK-47', names), 'AK-47'); // state.js interns names
  assert.equal(weaponNameOf(1, names), 'M4A4'); // raw index form
  assert.equal(weaponNameOf(9, names), null); // outside the vocabulary
  assert.equal(weaponNameOf(null, names), null);
  assert.equal(weaponNameOf('', names), null);
  assert.equal(weaponNameOf(undefined, names), null);
});

// --- gun cues --------------------------------------------------------------

// A hand-built state index in buildStateIndex's shape: per slot, per
// field, {frames, values} — every SERIES key present (absent series are
// empty, exactly as buildStateIndex leaves them).
const SERIES_KEYS = [
  'hp',
  'armor',
  'weapon',
  'inventory',
  'magAmmo',
  'reserveAmmo',
  'attack',
  'money',
  'helmet',
];
function indexWith(slotSeries) {
  return {
    slots: slotSeries.map((slot) => {
      const out = {};
      for (const key of SERIES_KEYS) out[key] = slot[key] || { frames: [], values: [] };
      return out;
    }),
    recordCount: 0,
  };
}

test('gunCues fires once per RISING attack edge and names the weapon', () => {
  const index = indexWith([
    {
      attack: { frames: [0, 10, 15, 25], values: [false, true, false, true] },
      weapon: { frames: [0, 20], values: ['AK-47', 'AWP'] },
    },
  ]);
  // (0, 30]: edge at 10 (AK-47), release at 15, edge at 25 (AWP at frame 20).
  const cues = gunCues(index, [], 0, 0, 30);
  assert.deepEqual(cues, [
    { frame: 10, name: 'AK-47' },
    { frame: 25, name: 'AWP' },
  ]);
});

test('gunCues seeds from the previous frame (a held trigger is not a new edge)', () => {
  const index = indexWith([
    {
      attack: { frames: [0, 10], values: [false, true] },
      weapon: { frames: [0], values: ['AK-47'] },
    },
  ]);
  // Starting INSIDE the hold (10 → 30): attack is already true at 10, so
  // no edge — only a fresh false→true inside the range would fire.
  assert.deepEqual(gunCues(index, [], 0, 10, 30), []);
  // A release + re-hold inside the range fires the second edge only.
  assert.deepEqual(gunCues(index, [], 0, 5, 30), [{ frame: 10, name: 'AK-47' }]);
});

test('gunCues visits EVERY skipped frame (8× passes several frames per draw)', () => {
  const index = indexWith([
    {
      // false at 0, true at 3, false at 5, true at 8 — three frames
      // between two rAFs at 8×; only the frame-8 edge is NEW here.
      attack: { frames: [0, 3, 5, 8], values: [false, true, false, true] },
      weapon: { frames: [0], values: ['MP9'] },
    },
  ]);
  assert.deepEqual(gunCues(index, [], 0, 0, 10), [
    { frame: 3, name: 'MP9' },
    { frame: 8, name: 'MP9' },
  ]);
});

test('gunCues: paused redraws, missing slots and unknown weapons never throw', () => {
  const index = indexWith([
    { attack: { frames: [0], values: [true] }, weapon: { frames: [0], values: ['AK-47'] } },
  ]);
  assert.deepEqual(gunCues(index, [], 0, 5, 5), []); // toFrame === fromFrame
  assert.deepEqual(gunCues(index, [], 0, 9, 4), []); // backwards never iterates
  assert.deepEqual(gunCues(index, [], 7, 0, 10), []); // slot does not exist
  assert.deepEqual(gunCues(null, [], 0, 0, 10), []); // no state stream
  // weapon null (never carried) → the edge fires no cue.
  const noWeapon = indexWith([
    { attack: { frames: [0, 5], values: [false, true] }, weapon: { frames: [], values: [] } },
  ]);
  assert.deepEqual(gunCues(noWeapon, [], 0, 0, 10), []);
});

// --- prefs + manifest boundary ---------------------------------------------

test('prefVolume: unset/corrupt falls to the default, 0 stays 0', () => {
  assert.equal(prefVolume(null), AUDIO_VOL_DEFAULT);
  assert.equal(prefVolume(undefined), AUDIO_VOL_DEFAULT);
  assert.equal(prefVolume('nope'), AUDIO_VOL_DEFAULT);
  assert.equal(prefVolume(2), AUDIO_VOL_DEFAULT); // out of range
  assert.equal(prefVolume(-1), AUDIO_VOL_DEFAULT);
  assert.equal(prefVolume(0), 0); // a real 0-fader is a valid choice
  assert.equal(prefVolume(0.35), 0.35);
  assert.equal(prefVolume('0.5'), 0.5); // JSON round-trip through a string
  assert.equal(prefVolume(null, 0.25), 0.25); // explicit default
});

test('normalizeSoundManifest: fail-soft shape, variant lists only', () => {
  const empty = normalizeSoundManifest(null);
  assert.equal(empty.extracted, false);
  assert.equal(empty.count, 0);
  assert.deepEqual({ ...empty.sounds }, {});
  // Bad entries are dropped; count follows the surviving names.
  const m = normalizeSoundManifest({
    extracted: true,
    note: 42, // non-string note → dropped
    sounds: {
      'AK-47': ['/api/sounds/ak47_01.wav', 7, '', '/api/sounds/ak47_02.wav'],
      Empty: [],
      Broken: 'not-a-list',
      Bad: [null],
    },
  });
  assert.equal(m.extracted, true);
  assert.equal(m.count, 1);
  assert.deepEqual(m.sounds['AK-47'], [
    '/api/sounds/ak47_01.wav',
    '/api/sounds/ak47_02.wav',
  ]);
  assert.equal(m.note, '');
  // Nothing usable → the frozen empty manifest (never null).
  assert.equal(normalizeSoundManifest({ sounds: { x: [] } }).extracted, false);
});
