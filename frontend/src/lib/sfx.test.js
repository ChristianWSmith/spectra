// Sound-effect cue math tests (lib/replay/sfx.js): the utility-cue
// derivation (flashbang double-dispatch dedupe, decoy skip, C4, the
// equip/throw skip, the freeze gate), the knife damage cues, the bullet
// cue window, the range/seek guards, the random variant pick, the
// internal gain scales and the weapon-name-less manifest boundary.
// Run: node --test src/lib/sfx.test.js
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
  GUNS_GAIN_SCALE,
  UTILITY_GAIN_SCALE,
  SOUND_DETONATION_BUCKETS,
  grenadeCues,
  knifeCues,
  utilCuesInRange,
  bulletCuesInRange,
  cueGapJump,
  pickVariant,
  prefVolume,
  normalizeSoundManifest,
} = await import('./replay/sfx.js');

// --- utility cues ----------------------------------------------------------

const row = (over) => ({ kind: 'grenade', bucket: 'he', weapon: 'HE Grenade', tick: 100, ...over });

// The freeze window the gate tests use (rounds.js inFreezeTime's shape):
// round 1 freezes ticks [0, 64), round 2 [500, 560).
const FREEZE_ROUNDS = [
  { number: 1, startTick: 0, freezeEndTick: 64 },
  { number: 2, startTick: 500, freezeEndTick: 560 },
];

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

test('grenadeCues: equip/throw-shaped landmarks make NO cue (detonation only)', () => {
  // The util-sound bug this pins: the old attack-edge gun path played
  // the manifest's DETONATION sample on every grenade equip and throw.
  // The cue list must come from detonation rows alone — a throw or
  // equip-shaped landmark is silence, no matter how the game labels it.
  const cues = grenadeCues([
    { kind: 'grenade', bucket: 'throw', weapon: 'HE Grenade', tick: 10 }, // the throw event
    { kind: 'grenade', bucket: 'equip', weapon: 'HE Grenade', tick: 20 }, // equipping it
    { kind: 'grenade_throw', bucket: 'throw', weapon: 'Flashbang', tick: 30 },
    row({ tick: 40, bucket: 'he' }),
  ]);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['40:HE Grenade'],
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

test('grenadeCues: utility and bomb cues inside FREEZE time are dropped', () => {
  // Freeze gate (rounds.js inFreezeTime — the ONE predicate): the game
  // forbids utility during freeze, so no detonation sound may play there.
  const cues = grenadeCues(
    [
      row({ tick: 32, bucket: 'he' }), // round-1 freeze → dropped
      row({ tick: 100, bucket: 'he' }), // live → kept
      { kind: 'bomb_explode', bucket: 'explode', weapon: 'C4', tick: 520 }, // round-2 freeze → dropped
      row({ tick: 600, bucket: 'flash', weapon: 'Flashbang' }), // live → kept
    ],
    FREEZE_ROUNDS,
  );
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['100:HE Grenade', '600:Flashbang'],
  );
  // No rounds pushed → nothing is gated (the gate fails open, it never
  // invents a freeze window).
  assert.equal(grenadeCues([row({ tick: 32 })]).length, 1);
});

// --- knife cues ------------------------------------------------------------

test('knifeCues: damage rows are the knife\u2019s ONLY sound source', () => {
  const cues = knifeCues([
    { kind: 'damage', weapon: 'Knife', tick: 100 },
    { kind: 'kill', weapon: 'Knife', tick: 200 }, // a knife KILL without a damage row → no cue
    { kind: 'damage', weapon: 'AK-47', tick: 300 }, // bullet damage is not a knife hit
    { kind: 'grenade', bucket: 'he', weapon: 'HE Grenade', tick: 400 },
    null, // hostile input never throws
  ]);
  assert.deepEqual(cues, [{ tick: 100, name: 'Knife' }]);
  // Swings are client-local foley — they are not damage rows at all, so
  // they can never reach this list (a swing plays NOTHING).
  assert.equal(knifeCues([{ kind: 'kill', weapon: 'Knife', tick: 50 }]).length, 0);
});

test('knifeCues: freeze time gates the hit sound (rounds.js)', () => {
  const cues = knifeCues(
    [
      { kind: 'damage', weapon: 'Knife', tick: 32 }, // round-1 freeze → dropped
      { kind: 'damage', weapon: 'Knife', tick: 100 }, // live → kept
    ],
    FREEZE_ROUNDS,
  );
  assert.deepEqual(cues, [{ tick: 100, name: 'Knife' }]);
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

// --- gun cues (bullets.js rows) --------------------------------------------

// The attack-edge gun path is GONE: its rising edges played the
// manifest's DETONATION sample under the guns bucket on every grenade
// equip/throw/hold (the util-sound bug). Gun sounds now come from
// bullets.js rows — one per shot. bullets.test.js pins the row
// DERIVATION (guns-only, freeze-filtered, globally tick-sorted, `draw`
// = tracer selection); this file pins the sfx side: the (prevTick,
// curTick] window selection.
const shot = (tick, weapon = 'AK-47', over = {}) => ({
  tick,
  frame: 0,
  slot: 0,
  weapon,
  draw: true,
  ...over,
});

test('bulletCuesInRange: EVERY row in the window plays — draw is tracer-only', () => {
  const rows = [
    shot(100),
    shot(104, 'AWP', { draw: false }), // draw:false still makes a sound
    shot(110, 'MP9'),
    shot(111, 'MP9', { slot: 1 }), // two players, adjacent ticks
    shot(120, 'AWP', { draw: false }),
    shot(200),
  ];
  const ticksOf = (from, to) => bulletCuesInRange(rows, from, to).map((r) => `${r.tick}:${r.weapon}`);
  // Open at the left (100 already played), closed at the right (120
  // reached this draw) — every row in between sounds, at any cadence.
  assert.deepEqual(ticksOf(100, 120), [
    '104:AWP',
    '110:MP9',
    '111:MP9',
    '120:AWP',
  ]);
  assert.deepEqual(ticksOf(0, 100), ['100:AK-47']); // closed right: tick 100 plays once
  assert.deepEqual(ticksOf(111, 111), []); // the compare point itself never re-plays
  assert.deepEqual(ticksOf(110, 111), ['111:MP9']);
  assert.deepEqual(ticksOf(199, 1000), ['200:AK-47']);
});

test('bulletCuesInRange: empty/NaN inputs and unsorted-tolerance never throw', () => {
  assert.deepEqual(bulletCuesInRange([], 0, 10), []);
  assert.deepEqual(bulletCuesInRange(null, 0, 10), []);
  assert.deepEqual(bulletCuesInRange([shot(5)], NaN, 10), []);
  assert.deepEqual(bulletCuesInRange([shot(5)], 0, NaN), []);
  // Rows are tick-sorted by deriveBullets' contract; the engine relies
  // on it (the binary search), so no unsorted input is exercised here.
});

test('bulletCuesInRange: a seek jump never plays the crossed rows (cueGapJump re-seeds)', () => {
  const rows = [shot(100), shot(104), shot(1000)];
  // A 15 s seek is a jump: the engine does NOT call the range selector
  // across it (onEngineChange gates on !cueGapJump), so the crossed rows
  // stay silent and the compare point re-seeds.
  assert.equal(cueGapJump(1000, 100, 1, 64), true);
  // Ordinary playback steps are not jumps — the crossed rows sound.
  assert.equal(cueGapJump(108, 100, 1, 64), false);
  assert.deepEqual(
    bulletCuesInRange(rows, 100, 108).map((r) => r.tick),
    [104],
  );
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

// --- internal mix calibration ----------------------------------------------

test('gain scales: guns cut to 1/3, utility to 2/3, both internal to the mixer', () => {
  // applyGains() multiplies the fader level by these — the pref default,
  // the sliders and prefs.go never move (a user-facing 80% still reads
  // 80%), so pinning the constants here pins the mix. Voice is
  // deliberately unscaled (no constant exists for it — its master gain
  // IS the fader value, see sfx.js).
  assert.equal(GUNS_GAIN_SCALE, 1 / 3); // default weapon volume cut by 2/3
  assert.equal(UTILITY_GAIN_SCALE, 2 / 3); // default utility volume cut by 1/3
  assert.equal(AUDIO_VOL_DEFAULT, 0.8); // the user-facing default is untouched
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
