// Sound-effect cue math tests (lib/replay/sfx.js): the utility-cue
// derivation (flashbang double-dispatch dedupe, the decoy→HE detonation
// remap, C4 on its own bus, the equip skip, the freeze gate), the throw
// cues (`<weapon> throw` manifest keys), the knife damage cues, the
// plant/defuse lifecycle cues (bombActionCues — the four manifest
// groups, silent cancels, the shared bomb.js ACTION_KINDS taxonomy), the
// ANNOUNCER lines (roundEndCues winner/draw/counted gating,
// bombAnnouncerCues, the bombdef→win ordering rule) and the match-POINT
// freeze cue (matchPointBefore's MR12/MR3 clinch predicate,
// matchPointCues' freeze-start placement, silence on unresolvable
// scorelines), the
// bullet cue window, the decoy fake-gunshot plan window, the C4 beep
// synthesis (bomb rows → schedule → deterministic site group),
// the range/seek guards, the random variant pick, the internal gain
// scales and the weapon-name-less manifest boundary.
// Run: node --test src/lib/sfx.test.js
// (from frontend/; the lib test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';
// bomb.js is pure (no services/bindings imports), so it loads fine
// before the hook install below — ACTION_KINDS is the taxonomy
// bombActionCues keys its cue names from.
import { ACTION_KINDS } from './replay/bomb.js';
// rounds.js is pure too — inFreezeTime pins that the match-point cue
// sits INSIDE the round's freeze window (the one cue list that must not
// carry a freeze gate of its own).
import { inFreezeTime } from './rounds.js';

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
  C4_GAIN_SCALE,
  SOUND_DETONATION_BUCKETS,
  ANNOUNCER_ORDER_DELAY_S,
  grenadeCues,
  throwCues,
  knifeCues,
  bombActionCues,
  roundEndCues,
  bombAnnouncerCues,
  matchPointBefore,
  matchPointCues,
  announcerOrder,
  utilCuesInRange,
  bulletCuesInRange,
  decoyCues,
  decoyCuesInRange,
  cueGapJump,
  pickVariant,
  prefVolume,
  normalizeSoundManifest,
  c4BeepRows,
  c4BombAt,
  c4BeepRate,
  c4BeepTicks,
  c4BeepGroup,
  createSfxEngine,
  resetSoundManifest,
} = await import('./replay/sfx.js');

// --- utility cues ----------------------------------------------------------

const row = (over) => ({ kind: 'grenade', bucket: 'he', weapon: 'HE Grenade', tick: 100, ...over });

// The freeze window the gate tests use (rounds.js inFreezeTime's shape):
// round 1 freezes ticks [0, 64), round 2 [500, 560).
const FREEZE_ROUNDS = [
  { number: 1, startTick: 0, freezeEndTick: 64 },
  { number: 2, startTick: 500, freezeEndTick: 560 },
];

test('grenadeCues keeps only detonation buckets (equips and throws skipped)', () => {
  const cues = grenadeCues([
    row({ tick: 10, bucket: 'he' }),
    row({ tick: 20, bucket: 'flash', weapon: 'Flashbang' }),
    // The DECOY detonation buckets 'he' now (landmarks.detonationStyle —
    // BaseGrenade.Explode) and cues the HE GROUP via the remap: the
    // manifest has no "Decoy Grenade" key (CS2.md: the decoy has no
    // detonation sound of its own), so without it the cue would be silent.
    row({ tick: 30, bucket: 'he', weapon: 'Decoy Grenade' }),
    row({ tick: 40, bucket: 'smoke', weapon: 'Smoke Grenade' }),
    row({ tick: 50, bucket: 'fire', weapon: 'Molotov' }),
    row({ tick: 60, bucket: 'detonation', weapon: 'Weird Nade' }),
    { kind: 'grenade_throw', bucket: 'throw', weapon: 'HE Grenade', tick: 70 }, // a throw, not a detonation
    { kind: 'kill', bucket: 'kill', weapon: 'AK-47', tick: 80 },
  ]);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['10:HE Grenade', '20:Flashbang', '30:HE Grenade', '40:Smoke Grenade', '50:Molotov', '60:Weird Nade'],
  );
  // Every grenade detonation rides the UTILITY bus (only the C4
  // explosion leaves it — see the bomb_explode test below).
  assert.ok(cues.every((c) => c.bucket === 'utility'), JSON.stringify(cues));
  // Every drawable detonation bucket has a sound path: the old 'decoy'
  // exclusion died with the bucket (there is no 'decoy' bucket anymore).
  assert.deepEqual([...SOUND_DETONATION_BUCKETS], ['detonation', 'smoke', 'fire', 'flash', 'he']);
});

test('grenadeCues: the decoy→HE remap keys off the WEAPON (two grenades, two sounds)', () => {
  const cues = grenadeCues([
    row({ tick: 100, bucket: 'he', weapon: 'Decoy Grenade' }),
    row({ tick: 100, bucket: 'he', weapon: 'Decoy Grenade' }), // duplicate dispatch → one cue
    row({ tick: 100, bucket: 'he', weapon: 'HE Grenade' }), // same tick, OTHER grenade → kept
    row({ tick: 120, bucket: 'he', weapon: 'Decoy Grenade' }),
  ]);
  // The dedupe runs on the row's WEAPON (before the remap), so an HE and
  // a decoy exploding on the same tick still make TWO sounds — they are
  // two grenades; the remap only picks the manifest key.
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['100:HE Grenade', '100:HE Grenade', '120:HE Grenade'],
  );
});

test('grenadeCues: equip/throw-shaped landmarks make NO cue (detonation only)', () => {
  // The util-sound bug this pins: the old attack-edge gun path played
  // the manifest's DETONATION sample on every grenade equip and throw.
  // The cue list must come from detonation rows alone — a throw or
  // equip-shaped landmark is silence HERE (the throw's own sound is the
  // separate throwCues list below).
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
  // Bus migration: the explosion left the UTILITY bus for the C4 bus
  // (its own fader/mute — prefs.go c4_volume), the grenade stays.
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.bucket}`),
    ['100:utility', '900:c4'],
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

// --- throw cues (Feature A) -------------------------------------------------

test('throwCues: grenade_throw rows cue `<weapon> throw` — one group per grenade', () => {
  const cues = throwCues([
    { kind: 'grenade_throw', bucket: 'throw', weapon: 'HE Grenade', tick: 10 },
    { kind: 'grenade_throw', bucket: 'throw', weapon: 'Flashbang', tick: 20 },
    { kind: 'grenade_throw', bucket: 'throw', weapon: 'Smoke Grenade', tick: 30 },
    { kind: 'grenade_throw', bucket: 'throw', weapon: 'Molotov', tick: 40 },
    { kind: 'grenade_throw', bucket: 'throw', weapon: 'Incendiary Grenade', tick: 50 },
    { kind: 'grenade_throw', bucket: 'throw', weapon: 'Decoy Grenade', tick: 60 },
    // NOT a grenade_throw row → no throw cue (equip-shaped and
    // detonation-shaped landmarks stay silent here):
    { kind: 'grenade', bucket: 'equip', weapon: 'HE Grenade', tick: 70 },
    { kind: 'grenade', bucket: 'he', weapon: 'HE Grenade', tick: 80 },
    // No weapon → no cue (the manifest key is never invented).
    { kind: 'grenade_throw', bucket: 'throw', weapon: '', tick: 90 },
    null, // hostile input never throws
  ]);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    [
      '10:HE Grenade throw',
      '20:Flashbang throw',
      '30:Smoke Grenade throw',
      '40:Molotov throw',
      '50:Incendiary Grenade throw',
      '60:Decoy Grenade throw',
    ],
  );
  // Sorted by tick (the engine's range window relies on it).
  assert.ok(cues.every((c, i) => i === 0 || cues[i - 1].tick <= c.tick));
});

test('throwCues: FREEZE time gates the throw, (tick|name) dedupes', () => {
  const cues = throwCues(
    [
      { kind: 'grenade_throw', weapon: 'HE Grenade', tick: 32 }, // round-1 freeze → dropped
      { kind: 'grenade_throw', weapon: 'HE Grenade', tick: 100 }, // live → kept
      { kind: 'grenade_throw', weapon: 'HE Grenade', tick: 100 }, // duplicate → one cue
      { kind: 'grenade_throw', weapon: 'Flashbang', tick: 100 }, // same tick, OTHER grenade → kept
    ],
    FREEZE_ROUNDS,
  );
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['100:HE Grenade throw', '100:Flashbang throw'],
  );
  // No rounds pushed → nothing gated (the gate fails open, it never
  // invents a freeze window).
  assert.equal(throwCues([{ kind: 'grenade_throw', weapon: 'HE Grenade', tick: 32 }]).length, 1);
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

// --- plant/defuse lifecycle cues --------------------------------------------

// The four cues key the manifest groups internal/mappack/sounds.go
// extracts (one soundevent FILE each: c4.initiate / c4.plant /
// c4.disarmstart / c4.disarmfinish), and the kind → name table is keyed
// off bomb.js ACTION_KINDS — the same taxonomy the renderer's progress
// rings read, so the arc and the sound can never disagree.

test('bombActionCues: the four lifecycle moments key the manifest’s cue groups', () => {
  const cues = bombActionCues([
    { kind: 'bomb_plant', bucket: 'plant', tick: 300, round: 7 },
    { kind: 'bomb_plant_begin', bucket: 'plant_begin', tick: 100, round: 7 },
    { kind: 'bomb_defuse', bucket: 'defuse', tick: 920, round: 7 },
    { kind: 'bomb_defuse_start', bucket: 'defuse_start', tick: 600, round: 7 },
    { kind: 'kill', bucket: 'kill', tick: 50 }, // any other row: silence
    null, // hostile input never throws
  ]);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    [
      '100:C4 plant start',
      '300:C4 plant complete',
      '600:C4 defuse start',
      '920:C4 defuse complete',
    ],
  );
  // All four ride the C4 bus (the bomb's own fader/mute, like the
  // explosion and the beeps).
  assert.ok(cues.every((c) => c.bucket === 'c4'), JSON.stringify(cues));
});

test('bombActionCues: a CANCELLED attempt is silent (abort rows make no cue)', () => {
  // The START still cues — c4.initiate sounds the moment arming begins —
  // but the game plays nothing when a plant/defuse is abandoned, and
  // spectra ships no cancel sound to extract.
  const cues = bombActionCues([
    { kind: 'bomb_plant_begin', bucket: 'plant_begin', tick: 100, round: 7 },
    { kind: 'bomb_plant_abort', bucket: 'plant_abort', tick: 112, round: 7 },
    { kind: 'bomb_plant', bucket: 'plant', tick: 300, round: 7 },
    { kind: 'bomb_defuse_start', bucket: 'defuse_start', tick: 500, round: 7 },
    { kind: 'bomb_defuse_abort', bucket: 'defuse_abort', tick: 515, round: 7 },
  ]);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['100:C4 plant start', '300:C4 plant complete', '500:C4 defuse start'],
  );
});

test('bombActionCues: the cue names follow bomb.js ACTION_KINDS (the one taxonomy)', () => {
  // Renaming a kind in ACTION_KINDS without updating this table would
  // silently mute the cue — this pins the mapping both sides read.
  assert.deepEqual(ACTION_KINDS, {
    plant: { begin: 'bomb_plant_begin', complete: 'bomb_plant', abort: 'bomb_plant_abort' },
    defuse: { begin: 'bomb_defuse_start', complete: 'bomb_defuse', abort: 'bomb_defuse_abort' },
  });
  const cues = bombActionCues([
    { kind: ACTION_KINDS.plant.begin, tick: 1 },
    { kind: ACTION_KINDS.plant.complete, tick: 2 },
    { kind: ACTION_KINDS.defuse.begin, tick: 3 },
    { kind: ACTION_KINDS.defuse.complete, tick: 4 },
  ]);
  assert.deepEqual(
    cues.map((c) => c.name),
    ['C4 plant start', 'C4 plant complete', 'C4 defuse start', 'C4 defuse complete'],
  );
});

test('bombActionCues: freeze time gates the cue, (tick|name) dedupes', () => {
  const cues = bombActionCues(
    [
      { kind: 'bomb_plant_begin', tick: 32 }, // round-1 freeze → dropped
      { kind: 'bomb_plant_begin', tick: 100 }, // live → kept
      { kind: 'bomb_plant_begin', tick: 100 }, // duplicate dispatch → one
      { kind: 'bomb_plant', tick: 100 }, // same tick, OTHER cue → kept
    ],
    FREEZE_ROUNDS,
  );
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['100:C4 plant start', '100:C4 plant complete'],
  );
});

// --- announcer lines (ctwin / terwin / rounddraw / bombpl / bombdef) --------
// Owner-provided mapping 2026-11-09 (NOT verified against primary
// sources): a counted round end → ctwin (winner ct) / terwin (winner t)
// / rounddraw (winner '' + reason 'Draw'), a plant event row → bombpl,
// a defuse event row → bombdef (before the win line — announcerOrder).
// All five ride the 'announcer' bus (their own fader/mute).

// The rounds the round-end cue tests join against: round 1 CT win,
// round 2 T win, round 3 a DRAW (empty winner, Draw reason, ended),
// round -2 a knife round (non-counted — isCounted), round 4 a draw that
// never ended (endTick 0 — no evidence the round resolved).
const ANN_ROUNDS = [
  { number: 1, winner: 'ct', reason: 'Elimination', startTick: 0, freezeEndTick: 0, endTick: 1000 },
  { number: 2, winner: 't', reason: 'Bomb exploded', startTick: 1100, freezeEndTick: 1110, endTick: 2000 },
  { number: 3, winner: '', reason: 'Draw', startTick: 2100, freezeEndTick: 2110, endTick: 3000 },
  { number: -2, winner: 'ct', reason: 'Elimination', startTick: 3100, freezeEndTick: 3110, endTick: 3400 },
  { number: 4, winner: '', reason: 'Draw', startTick: 3500, freezeEndTick: 3510, endTick: 0 },
  { number: 5, winner: 'ct', reason: 'Hostages rescued', startTick: 4100, freezeEndTick: 4110, endTick: 5000 },
];

const annRoundEnd = (over) => ({
  kind: 'round_end',
  bucket: 'round',
  tick: 1000,
  round: 1,
  ...over,
});

test('roundEndCues: winner decides the line — ct → ctwin, t → terwin (reason-independent)', () => {
  const cues = roundEndCues(
    [
      annRoundEnd({ tick: 1000, round: 1 }),
      annRoundEnd({ tick: 2000, round: 2 }),
      // Any reason is a win line — the mapping never keys on it.
      annRoundEnd({ tick: 5000, round: 5 }),
      annRoundEnd({ tick: 6000, round: 99 }), // a round the lookup does not know → silence
      { kind: 'round_start', bucket: 'start', tick: 1100, round: 1 }, // not a round_end
      null, // hostile input never throws
    ],
    ANN_ROUNDS,
  );
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['1000:ctwin', '2000:terwin', '5000:ctwin'],
  );
  // Every line rides the ANNOUNCER bus (its own fader/mute).
  assert.ok(cues.every((c) => c.bucket === 'announcer'), JSON.stringify(cues));
  // Sorted by tick (the engine's window selector relies on it).
  assert.ok(cues.every((c, i) => i === 0 || cues[i - 1].tick <= c.tick));
});

test('roundEndCues: a DRAW (winner "", reason "Draw", endTick > 0) cues rounddraw', () => {
  const cues = roundEndCues([annRoundEnd({ tick: 3000, round: 3 })], ANN_ROUNDS);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['3000:rounddraw'],
  );
  // The gates that make it silence instead: a draw that never ENDED
  // (endTick 0) and an empty winner that is not a Draw.
  assert.deepEqual(
    roundEndCues([annRoundEnd({ tick: 3600, round: 4 })], ANN_ROUNDS).map((c) => c.name),
    [],
  );
  const noEnd = ANN_ROUNDS.map((r) =>
    r.number === 3 ? { ...r, endTick: 0, reason: 'Draw' } : r,
  );
  assert.deepEqual(
    roundEndCues([annRoundEnd({ tick: 3000, round: 3 })], noEnd).map((c) => c.name),
    [],
  );
  const notDraw = ANN_ROUNDS.map((r) =>
    r.number === 3 ? { ...r, winner: '', reason: 'Time expired' } : r,
  );
  assert.deepEqual(
    roundEndCues([annRoundEnd({ tick: 3000, round: 3 })], notDraw).map((c) => c.name),
    [],
  );
});

test('roundEndCues: knife/warmup rounds and a missing rounds list are silence', () => {
  // The counted gate (lib/rounds.js isCounted): a negative-numbered
  // knife/warmup round never announces, even with a winner.
  assert.deepEqual(
    roundEndCues([annRoundEnd({ tick: 3400, round: -2 })], ANN_ROUNDS).map((c) => c.name),
    [],
  );
  // No rounds pushed → the winner is unknown → nothing (never a guess).
  assert.deepEqual(roundEndCues([annRoundEnd({ tick: 1000, round: 1 })], null), []);
  assert.deepEqual(roundEndCues([annRoundEnd({ tick: 1000, round: 1 })], []), []);
  // Deduped by (tick|name): a duplicated round_end row is one line.
  const dup = roundEndCues(
    [annRoundEnd({ tick: 1000, round: 1 }), annRoundEnd({ tick: 1000, round: 1 })],
    ANN_ROUNDS,
  );
  assert.equal(dup.length, 1);
});

test('bombAnnouncerCues: the canonical completion rows cue bombpl/bombdef — attempts stay silent', () => {
  const cues = bombAnnouncerCues(
    [
      { kind: 'bomb_plant', bucket: 'plant', tick: 300, round: 1 },
      { kind: 'bomb_defuse', bucket: 'defuse', tick: 920, round: 1 },
      { kind: 'bomb_plant_begin', bucket: 'plant_begin', tick: 100, round: 1 },
      { kind: 'bomb_defuse_start', bucket: 'defuse_start', tick: 600, round: 1 },
      { kind: 'bomb_plant_abort', bucket: 'plant_abort', tick: 400, round: 1 },
      { kind: 'bomb_defuse_abort', bucket: 'defuse_abort', tick: 700, round: 1 },
      { kind: 'kill', bucket: 'kill', tick: 50, round: 1 }, // any other row: silence
      null, // hostile input never throws
    ],
    ANN_ROUNDS,
  );
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    ['300:bombpl', '920:bombdef'],
  );
  assert.ok(cues.every((c) => c.bucket === 'announcer'), JSON.stringify(cues));
});

test('bombAnnouncerCues: known knife/warmup rounds are silent, unknown rounds are kept, freeze gates', () => {
  // Knife/warmup round -2 (the canonical "known and not counted →
  // dropped" convention)…
  assert.deepEqual(
    bombAnnouncerCues([{ kind: 'bomb_plant', tick: 3400, round: -2 }], ANN_ROUNDS).map((c) => c.name),
    [],
  );
  // …a round the lookup does not know is kept (normalizeEvent's
  // convention) — the cue needs no winner to sound…
  assert.deepEqual(
    bombAnnouncerCues([{ kind: 'bomb_plant', tick: 5000, round: 99 }], ANN_ROUNDS).map((c) => c.name),
    ['bombpl'],
  );
  // …and no rounds at all fails OPEN (the freeze-gate convention: an
  // absent list never invents a window to gate by).
  assert.deepEqual(bombAnnouncerCues([{ kind: 'bomb_plant', tick: 5000, round: 1 }], null).map((c) => c.name), ['bombpl']);
  // Freeze time (round 2 freezes [1100, 1110)) gates the completion.
  const frozen = bombAnnouncerCues([{ kind: 'bomb_plant', tick: 1105, round: 2 }], ANN_ROUNDS);
  assert.deepEqual(frozen.map((c) => c.name), []);
  // (tick|name) dedupe.
  const dup = bombAnnouncerCues(
    [
      { kind: 'bomb_plant', tick: 300, round: 1 },
      { kind: 'bomb_plant', tick: 300, round: 1 },
    ],
    ANN_ROUNDS,
  );
  assert.equal(dup.length, 1);
});

test('announcerOrder: a defuse in the window delays ONLY the round-end line', () => {
  // No defuse → every cue starts on arrival (delay 0).
  const plain = announcerOrder([
    { tick: 100, name: 'bombpl', bucket: 'announcer' },
    { tick: 200, name: 'ctwin', bucket: 'announcer' },
  ]);
  assert.deepEqual(
    plain.map((c) => `${c.name}:${c.delay}`),
    ['bombpl:0', 'ctwin:0'],
  );
  // A window sharing a defuse: bombdef now, the win line
  // ANNOUNCER_ORDER_DELAY_S later — the owner-observed ordering made
  // deterministic (both rows usually share a tick).
  const ordered = announcerOrder([
    { tick: 920, name: 'bombdef', bucket: 'announcer' },
    { tick: 920, name: 'ctwin', bucket: 'announcer' },
  ]);
  assert.deepEqual(
    ordered.map((c) => `${c.name}:${c.delay}`),
    [`bombdef:0`, `ctwin:${ANNOUNCER_ORDER_DELAY_S}`],
  );
  // The other round-end lines follow the same rule (they cannot co-occur
  // with a defuse in practice — the rule stays general).
  assert.deepEqual(
    announcerOrder([
      { tick: 1, name: 'bombdef' },
      { tick: 2, name: 'terwin' },
      { tick: 3, name: 'rounddraw' },
      { tick: 4, name: 'bombpl' },
    ]).map((c) => c.delay),
    [0, ANNOUNCER_ORDER_DELAY_S, ANNOUNCER_ORDER_DELAY_S, 0],
  );
  // COPIES: the stored cue list is never mutated.
  const stored = [{ tick: 920, name: 'ctwin', bucket: 'announcer' }];
  const out = announcerOrder([{ tick: 900, name: 'bombdef' }, ...stored]);
  assert.equal(stored[0].delay, undefined);
  assert.notEqual(out[1], stored[0]);
  // Hostile input never throws.
  assert.deepEqual(announcerOrder(null), []);
  assert.deepEqual(announcerOrder([]), []);
});

// --- match-point freeze cue (matchPointBefore / matchPointCues) -------------
// The match-POINT stinger: soundTable "matchpoint" →
// sounds/music/cs_stinger.vsnd_c (the game's Music.Match.MatchPoint
// soundevent — cs2find-discovered + existence-verified 2026-11-09; no
// match-point line exists under sounds/vo/announcer/cs2_classic/). The
// cue joins drawNorm round_start rows to GetRounds like roundEndCues,
// but its tick is the round's FREEZE START (the round_start row shares
// the round row's startTick — extract.agg.roundStart — which is where
// rounds.js inFreezeTime's window [startTick, freezeEndTick) opens).

// matchPointBefore — the MR12 + MR3 clinch predicate (CS2.md "MR12
// regulation + MR3 overtime"; predicate sources in the sfx.js comment).
test('matchPointBefore: regulation MR12 — 12-X is a point, 11-11 and 12-12 are not', () => {
  assert.equal(matchPointBefore(12, 8), true);
  assert.equal(matchPointBefore(8, 12), true); // either side can hold the point
  assert.equal(matchPointBefore(12, 11), true);
  assert.equal(matchPointBefore(11, 12), true);
  assert.equal(matchPointBefore(11, 11), false);
  // 12-12 ENDS regulation (max 24 rounds): overtime — or a tie where
  // there is none — follows, so the next round is not a 13th-win clinch.
  assert.equal(matchPointBefore(12, 12), false);
  assert.equal(matchPointBefore(10, 10), false);
  assert.equal(matchPointBefore(0, 0), false);
  // Unreachable / hostile scorelines are never a point (never a guess):
  // 13-10 means the match is already over, a missing opponent is not a
  // scoreline at all.
  assert.equal(matchPointBefore(13, 10), false);
  assert.equal(matchPointBefore(-1, 12), false);
  assert.equal(matchPointBefore(NaN, 12), false);
  assert.equal(matchPointBefore(12), false);
  assert.equal(matchPointBefore(), false);
});

test('matchPointBefore: OT MR3 — 3 block wins is a point, a completed 3-3 block is not', () => {
  // First OT block: overall 15-X is 12 + 3 block wins (opponent ≤14).
  assert.equal(matchPointBefore(15, 12), true);
  assert.equal(matchPointBefore(15, 13), true);
  assert.equal(matchPointBefore(15, 14), true);
  assert.equal(matchPointBefore(12, 15), true);
  assert.equal(matchPointBefore(14, 15), true);
  // An in-progress block below 3 wins is not a point (13-12 = block 1-0,
  // 14-13 = block 2-1)…
  assert.equal(matchPointBefore(13, 12), false);
  assert.equal(matchPointBefore(14, 12), false);
  assert.equal(matchPointBefore(14, 13), false);
  // …and 15-15 is a COMPLETED 3-3 block: Premier ends there (draw), a
  // repeating config starts a fresh 0-0 block — never a point.
  assert.equal(matchPointBefore(15, 15), false);
  // Second OT block (after the tied 3-3): overall 18-X = 3+3+3.
  assert.equal(matchPointBefore(18, 15), true);
  assert.equal(matchPointBefore(18, 17), true);
  assert.equal(matchPointBefore(17, 18), true);
  assert.equal(matchPointBefore(18, 18), false);
  // A clinched match never cues again (16-14 = block 4-2, over).
  assert.equal(matchPointBefore(16, 14), false);
  assert.equal(matchPointBefore(19, 15), false);
  // Unreachable OT shapes → false.
  assert.equal(matchPointBefore(14, 11), false);
});

// The rounds behind the cue tests: winners in round order — CT sweeps
// rounds 1-12 (12-0), T takes 13-24 (12-12 → overtime), CT takes the
// first four OT rounds 25-28 (16-12, clinched). Every round freezes
// [startTick, startTick + 10) like a real GetRounds row.
const MP_WINNERS = [
  ...Array(12).fill('ct'), // rounds 1-12  → 12-0
  ...Array(12).fill('t'), // rounds 13-24 → 12-12
  ...Array(4).fill('ct'), // rounds 25-28 → 16-12 (OT block 4-0)
];
const MP_ROUNDS = MP_WINNERS.map((winner, i) => ({
  number: i + 1,
  winner,
  reason: 'Elimination',
  startTick: 1000 + i * 100,
  freezeEndTick: 1010 + i * 100,
  endTick: 1090 + i * 100,
}));
const mpStart = (n) => MP_ROUNDS[n - 1].startTick;
const mpRow = (n) => ({ kind: 'round_start', bucket: 'start', tick: mpStart(n), round: n });
// The same rounds with an extra KNIFE round claiming a CT win (number
// -2, the extract renumber convention): the scoreline walk must ignore
// it through isCounted — a knife winner is never a phantom round win.
const MP_WITH_KNIFE = [
  ...MP_ROUNDS,
  { number: -2, winner: 'ct', reason: 'Elimination', startTick: 900, freezeEndTick: 905, endTick: 950 },
];
// The match-point rounds of that scoreline: 12-0 … 12-11 (rounds 13-24)
// are all one CT win from 13, then 12-12 starts overtime (silent) and
// the OT block is silent until 15-12 (round 28) makes it a point again.
const MP_POINT_ROUNDS = Array.from({ length: 12 }, (_, i) => i + 13).concat(28);

test('matchPointCues: one cue per match-point round at the FREEZE START, literal key, announcer bus', () => {
  const cues = matchPointCues(MP_ROUNDS.map((r) => mpRow(r.number)), MP_ROUNDS);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.name}`),
    MP_POINT_ROUNDS.map((n) => `${mpStart(n)}:matchpoint`),
  );
  // Every cue rides the ANNOUNCER bus (the spec's bus choice — no new
  // gain, no new pref) and the list stays tick-sorted for the ONE
  // window selector.
  assert.ok(cues.every((c) => c.bucket === 'announcer'), JSON.stringify(cues));
  assert.ok(cues.every((c, i) => i === 0 || cues[i - 1].tick <= c.tick));
  // FREEZE-START placement: each cue's tick is its round's startTick —
  // the instant the round's freeze window [startTick, freezeEndTick)
  // opens, which is exactly why this builder carries NO freeze gate
  // (inFreezeTime would drop every one of its own cues).
  for (const c of cues) {
    const rnd = MP_ROUNDS.find((r) => r.startTick === c.tick);
    assert.ok(rnd, `no round starts at ${c.tick}`);
    assert.equal(c.tick, rnd.startTick);
    assert.ok(inFreezeTime(MP_ROUNDS, c.tick), `tick ${c.tick} is not in freeze time`);
  }
});

test('matchPointCues: knife/warmup, unknown rows and a missing rounds list are silence', () => {
  // The counted gate (lib/rounds.js isCounted): a knife round never
  // cues, even at a point-looking scoreline.
  assert.deepEqual(
    matchPointCues([{ kind: 'round_start', bucket: 'start', tick: 900, round: -2 }], MP_WITH_KNIFE),
    [],
  );
  // A round the lookup does not know → silence (never a guess)…
  assert.deepEqual(matchPointCues([{ kind: 'round_start', bucket: 'start', tick: 5000, round: 99 }], MP_ROUNDS), []);
  // …and no rounds pushed at all (setRounds has not arrived) → silence.
  assert.deepEqual(matchPointCues([mpRow(23)], null), []);
  assert.deepEqual(matchPointCues([mpRow(23)], []), []);
  // Only round_start rows cue: a round_end/kill row at the same tick,
  // and hostile input, make nothing.
  assert.deepEqual(matchPointCues([{ kind: 'round_end', bucket: 'round', tick: mpStart(23), round: 23 }], MP_ROUNDS), []);
  assert.deepEqual(matchPointCues([{ kind: 'kill', bucket: 'kill', tick: mpStart(23), round: 23 }], MP_ROUNDS), []);
  assert.deepEqual(matchPointCues([null, { kind: 'round_start' }], MP_ROUNDS), []);
  // (tick|name) dedupe: a duplicated round_start row is one line.
  assert.equal(matchPointCues([mpRow(23), mpRow(23)], MP_ROUNDS).length, 1);
});

test('matchPointCues: an unresolvable scoreline is silence, never a 12-X guess', () => {
  // A prior counted round with an UNKNOWN winner (not a settled draw):
  // the pre-round scoreline is unknown → no cue, even though the known
  // halves would read 12-10 (a point).
  const unknownWinner = MP_ROUNDS.map((r) => (r.number === 22 ? { ...r, winner: '', reason: '' } : r));
  assert.deepEqual(matchPointCues([mpRow(23)], unknownWinner), []);
  // A draw with no end tick is not evidence of a settled draw either
  // (the roundEndCues draw rule: winner '' + reason 'Draw' + endTick > 0).
  const unresolvedDraw = MP_ROUNDS.map((r) =>
    r.number === 22 ? { ...r, winner: '', reason: 'Draw', endTick: 0 } : r,
  );
  assert.deepEqual(matchPointCues([mpRow(23)], unresolvedDraw), []);
  // A SETTLED draw resolves to no points for either side: round 22
  // drawn leaves 12-9 before round 23 — still a point, still cued.
  const settledDraw = MP_ROUNDS.map((r) =>
    r.number === 22 ? { ...r, winner: '', reason: 'Draw', endTick: r.endTick } : r,
  );
  assert.deepEqual(
    matchPointCues([mpRow(23)], settledDraw).map((c) => c.tick),
    [mpStart(23)],
  );
  // Knife/warmup rows are skipped by the same scoreline walk, so the
  // CT win stamped on the knife round never becomes a phantom round
  // win (counting it would read 13-10 — already over — and silence the
  // round-23 point).
  assert.deepEqual(matchPointCues([mpRow(23)], MP_WITH_KNIFE).map((c) => c.tick), [mpStart(23)]);
});



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

// --- decoy fake-gunshot cues (Feature C) ------------------------------------

test('decoyCues flattens the plan: one weapon per decoy, unresolved rows contribute nothing', () => {
  const plan = [
    { landTick: 100, detTick: 500, weapon: 'AK-47', shots: [{ tick: 140 }, { tick: 300 }] },
    { landTick: 200, detTick: 600, weapon: 'AWP', shots: [{ tick: 260 }] },
    // No resolved main weapon (no state stream / no inventory / no side)
    // → its scheduled shots are DROPPED, never played with a guessed gun.
    { landTick: 300, detTick: 700, weapon: null, shots: [{ tick: 360 }] },
  ];
  const cues = decoyCues(plan);
  assert.deepEqual(
    cues.map((c) => `${c.tick}:${c.weapon}`),
    ['140:AK-47', '260:AWP', '300:AK-47'],
  );
  // The same open/closed window as every other cue list: the compare
  // point that just played its tick never replays it.
  assert.deepEqual(decoyCuesInRange(cues, 140, 300).map((c) => c.tick), [260, 300]);
  assert.deepEqual(decoyCuesInRange(cues, 0, 139).map((c) => c.tick), []); // before the first shot
  assert.deepEqual(decoyCuesInRange(cues, 139, 140).map((c) => c.tick), [140]); // closed right
  assert.deepEqual(decoyCuesInRange(cues, 300, 999).map((c) => c.tick), []); // open left: 300 already played
  // Fail-soft inputs.
  assert.deepEqual(decoyCues(null), []);
  assert.deepEqual(decoyCues([]), []);
  assert.deepEqual(decoyCuesInRange([], 0, 10), []);
  assert.deepEqual(decoyCuesInRange(cues, NaN, 10), []);
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

test('gain scales: guns and utility run at 1/12 of the fader, C4 at 1/3 — internal to the mixer', () => {
  // applyGains() multiplies the fader level by these — the pref default,
  // the sliders and prefs.go never move (a user-facing 80% still reads
  // 80%), so pinning the constants here pins the mix. Voice is
  // deliberately unscaled (no constant exists for it — its master gain
  // IS the fader value, see sfx.js).
  // Spec 2026-11-08: "halve internal gain on guns/util one more time
  // (should go to 1/12)" — two halvings of the previous 1/3, guns and
  // utility ONLY.
  assert.equal(GUNS_GAIN_SCALE, 1 / 12);
  assert.equal(UTILITY_GAIN_SCALE, 1 / 12);
  // C4: the explosion MOVED from the utility bus to the C4 bus; it does
  // NOT follow utility's retune — its level must not change (the beeps
  // are simply quieter samples than a grenade).
  assert.equal(C4_GAIN_SCALE, 1 / 3);
  assert.equal(AUDIO_VOL_DEFAULT, 0.8); // the user-facing default is untouched
});

// --- C4 beeps ---------------------------------------------------------------

// The landmark rows the beep scheduler consumes (the Replay pushes the
// SAME drawNorm rows the renderer gets — buckets from landmarks.js
// drawBucket, site from the stored bomb_plant row).
const bombRow = (over) => ({
  kind: 'bomb_plant',
  bucket: 'plant',
  tick: 1000,
  round: 5,
  site: 'A',
  ...over,
});

test('c4BeepRows: the ONE filter of drawNorm into the bomb lifecycle lists', () => {
  const rows = c4BeepRows([
    bombRow(),
    { kind: 'bomb_explode', bucket: 'explode', tick: 3624, round: 5 },
    { kind: 'bomb_defuse', bucket: 'defuse', tick: 5200, round: 6 },
    { kind: 'round_end', bucket: 'round', tick: 5300, round: 6 },
    { kind: 'round_start', bucket: 'start', tick: 6000, round: 7 },
    { kind: 'kill', bucket: 'kill', tick: 1500 }, // not bomb lifecycle
    { kind: 'grenade', bucket: 'he', tick: 1600 },
    bombRow({ tick: undefined }), // no tick → dropped
    null, // hostile input never throws
  ]);
  assert.deepEqual(rows.plants.map((r) => r.tick), [1000]);
  assert.deepEqual(rows.explodes.map((r) => r.tick), [3624]);
  assert.deepEqual(rows.defuses.map((r) => r.tick), [5200]);
  assert.deepEqual(rows.roundEnds.map((r) => r.tick), [5300]);
  assert.deepEqual(rows.roundStarts.map((r) => r.tick), [6000]);
  assert.deepEqual(c4BeepRows(null).plants, []);
  assert.deepEqual(c4BeepRows(undefined).roundStarts, []);
});

test('c4BombAt: ticking-bomb state through bombEndTick (the ONE termination rule)', () => {
  const tr = 64;
  const rows = c4BeepRows([
    bombRow({ tick: 1000, site: 'A' }),
    { kind: 'bomb_explode', bucket: 'explode', tick: 1000 + 41 * tr, round: 5 },
    bombRow({ tick: 5000, round: 6, site: 'B' }),
    { kind: 'bomb_defuse', bucket: 'defuse', tick: 5200, round: 6 },
    { kind: 'round_end', bucket: 'round', tick: 5300, round: 6 },
    bombRow({ tick: 6100, round: 7, site: 'A' }),
    { kind: 'round_start', bucket: 'start', tick: 7000, round: 8 },
  ]);
  // Nothing planted yet.
  assert.equal(c4BombAt(rows, 999, tr), null);
  // Mid-fuse: stop and fuseEnd are the detonation (41 s plant → blast,
  // what the dev matches record), the site comes along.
  const mid = c4BombAt(rows, 1001, tr);
  assert.equal(mid.plant.tick, 1000);
  assert.equal(mid.stop, 1000 + 41 * tr);
  assert.equal(mid.fuseEnd, 1000 + 41 * tr);
  assert.equal(mid.site, 'A');
  // At (and after) the detonation nothing ticks — the explosion cue
  // owns that tick.
  assert.equal(c4BombAt(rows, 1000 + 41 * tr, tr), null);
  assert.equal(c4BombAt(rows, 4000, tr), null);
  // A DEFUSE stops the beeping but never shortens the FUSE: no explode
  // row in round 6, so the cadence runs against the 40 s C4 timer
  // (mp_c4timer) — a bomb defused at half its fuse beeps at the
  // half-fuse cadence, not one racing toward a blast that never happens.
  const defusing = c4BombAt(rows, 5100, tr);
  assert.equal(defusing.stop, 5200);
  assert.equal(defusing.fuseEnd, 5000 + 40 * tr);
  assert.equal(defusing.site, 'B');
  assert.equal(c4BombAt(rows, 5200, tr), null); // defused
  // The NEXT round's start cuts the window too (bomb.js' second cutoff),
  // and the last plant at/before the tick is the one that counts.
  const late = c4BombAt(rows, 6500, tr);
  assert.equal(late.plant.tick, 6100);
  assert.equal(late.stop, 7000);
  assert.equal(late.fuseEnd, 6100 + 40 * tr);
  assert.equal(c4BombAt(rows, 7000, tr), null);
  // Hostile inputs.
  assert.equal(c4BombAt(null, 1000, tr), null);
  assert.equal(c4BombAt(rows, NaN, tr), null);
  assert.equal(c4BombAt(rows, 1000, 0), null);
});

test('c4BeepRate: the CS:GO-measured fit at both ends (approximate for CS2)', () => {
  assert.equal(c4BeepRate(0), 1.04865); // ≈1 beep/s right after the plant
  assert.ok(Math.abs(c4BeepRate(1) - 7.8094) < 1e-3, String(c4BeepRate(1))); // ≈7.8/s at the blast
  assert.ok(Math.abs(c4BeepRate(0.5) - 1.8413) < 1e-3, String(c4BeepRate(0.5)));
  // Clamped — a hostile p can never produce an absurd rate.
  assert.equal(c4BeepRate(-3), c4BeepRate(0));
  assert.equal(c4BeepRate(9), c4BeepRate(1));
});

test('c4BeepTicks: one deterministic, accelerating schedule per fuse', () => {
  const tr = 64;
  const plant = 1000;
  const fuse = plant + 40 * tr;
  const ticks = c4BeepTicks(plant, fuse, tr);
  // The whole schedule pinned: 103 beeps over a 40 s fuse, the first
  // ~0.95 s after the plant (one g(0) interval — never ON the plant
  // tick), the last a tick before the detonation (never ON it — the
  // explosion cue owns that tick), gaps shrinking from 61 ticks to ~8
  // (≈128 ms at 64 tps — the curve's 7.8/s end).
  assert.equal(ticks.length, 103);
  assert.equal(ticks[0] - plant, 61);
  assert.equal(ticks[ticks.length - 1] - plant, 40 * tr - 1);
  assert.ok(
    ticks.every((t, i) => i === 0 || t > ticks[i - 1]),
    'strictly increasing',
  );
  const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
  assert.equal(gaps[0], 61);
  assert.equal(gaps[gaps.length - 1], 9);
  assert.ok(Math.min(...gaps) >= 8, 'never tighter than the 7.8/s end');
  assert.ok(gaps[0] > gaps[gaps.length - 1], 'the cadence accelerates');
  // Deterministic: the same inputs always yield the same schedule (the
  // engine re-derives it on every re-arm).
  assert.deepEqual(c4BeepTicks(plant, fuse, tr), ticks);
  // The 41 s plant → blast the dev matches record carries a few more.
  assert.equal(c4BeepTicks(plant, plant + 41 * tr, tr).length, 105);
});

test('c4BeepTicks: hostile inputs yield no schedule (never a throw)', () => {
  assert.deepEqual(c4BeepTicks(NaN, 100, 64), []);
  assert.deepEqual(c4BeepTicks(null, undefined, 64), []);
  assert.deepEqual(c4BeepTicks(0, 0, 64), []);
  assert.deepEqual(c4BeepTicks(100, 50, 64), []);
  assert.deepEqual(c4BeepTicks(0, 100, 0), []);
  assert.deepEqual(c4BeepTicks(0, 100, -64), []);
});

test('c4BeepGroup: deterministic site → tone key — an unknown site is silence', () => {
  // The plant row's site picks the tone (the game's C4.PlantSound /
  // C4.PlantSoundB sample pairs); nothing else picks a sample — the
  // whole fuse beeps this one tone at the established cadence.
  assert.equal(c4BeepGroup('A'), 'C4 beep A');
  assert.equal(c4BeepGroup('B'), 'C4 beep B');
  // A site we cannot name never guesses a tone.
  assert.equal(c4BeepGroup(''), null);
  assert.equal(c4BeepGroup('C'), null);
  assert.equal(c4BeepGroup(null), null);
  assert.equal(c4BeepGroup(undefined), null);
  assert.equal(c4BeepGroup(), null);
});

// --- C4 beep scheduler (engine-level) --------------------------------------
// The scheduler is the one part of sfx.js that is not pure math, so this
// drives createSfxEngine against a fake AudioContext + a fake replay
// engine and pins its OBSERVABLE contract: beeps queue AHEAD on the
// replay clock with the site's own deterministic sample, and a pause,
// a seek or a resolved bomb silences the queue (re-seeds drop what they
// crossed, never queue it twice).

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = { name: 'destination' };
    this.gains = []; // creation order in sfx.js: guns, utility, C4, announcer
    this.sources = [];
    FakeAudioContext.last = this;
  }
  createGain() {
    const g = { gain: { value: 0 }, bus: null };
    g.connect = (n) => {
      g.bus = n;
    };
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const ctx = this;
    const src = {
      buffer: null,
      bus: null,
      started: null,
      stopped: false,
      onended: null,
      connect(n) {
        src.bus = n;
      },
      disconnect() {
        src.bus = null;
      },
      start(when) {
        src.started = when === undefined ? ctx.currentTime : when;
      },
      stop() {
        src.stopped = true;
      },
    };
    this.sources.push(src);
    return src;
  }
  // The preload tags every decoded buffer with the URL it came from, so
  // the tests can tell WHICH manifest group each source plays.
  decodeAudioData(raw) {
    return Promise.resolve({ url: raw && raw.url });
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

const BEEP_MANIFEST = {
  sounds: {
    'C4 beep A': ['/api/sounds/c4_beep2.wav'],
    'C4 beep B': ['/api/sounds/c4_beep3.wav'],
    C4: ['/api/sounds/c4_explode1.wav'],
    'HE Grenade': ['/api/sounds/hegrenade_detonate_02.wav'],
    // The four plant/defuse lifecycle cues (soundTable's single-file
    // groups — one soundevent file each, see internal/mappack/sounds.go).
    'C4 plant start': ['/api/sounds/c4_initiate.wav'],
    'C4 plant complete': ['/api/sounds/c4_plant.wav'],
    'C4 defuse start': ['/api/sounds/c4_disarmstart.wav'],
    'C4 defuse complete': ['/api/sounds/c4_disarmfinish.wav'],
    // The five ANNOUNCER voice lines (soundTable's single-file groups —
    // extracted from sounds/vo/announcer/cs2_classic/…, the owner-provided
    // mapping 2026-11-09).
    ctwin: ['/api/sounds/ctwin.wav'],
    terwin: ['/api/sounds/terwin.wav'],
    rounddraw: ['/api/sounds/rounddraw.wav'],
    bombpl: ['/api/sounds/bombpl.wav'],
    bombdef: ['/api/sounds/bombdef.wav'],
    // The match-POINT stinger (soundTable "matchpoint" → the game's
    // Music.Match.MatchPoint file, sounds/music/cs_stinger.vsnd_c —
    // cs2find-discovered 2026-11-09, not one of the five VO lines).
    matchpoint: ['/api/sounds/cs_stinger.wav'],
  },
};

// createSfxEngine builds its own context from window.AudioContext (no
// window in Node — sfx.js's constructor swallows the failure, so this
// section installs the fake first).
globalThis.window = { AudioContext: FakeAudioContext };

const fakeEngine = () => {
  let cb = null;
  return {
    tickRate: 64,
    onChange(fn) {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    emit(st) {
      if (cb) cb(st);
    },
  };
};

// makeSfx — one engine with the manifest stubbed in and its preload
// drained (state.ready), plus the fake AudioContext it was built on.
async function makeSfx() {
  const engine = fakeEngine();
  const errors = [];
  const sfx = createSfxEngine({ engine, matchId: 1, onError: (m) => errors.push(m) });
  for (let i = 0; i < 500 && !sfx.state.ready; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(errors.length, 0, errors.join('; '));
  assert.ok(sfx.state.ready, JSON.stringify(sfx.state));
  return { sfx, engine, ctx: FakeAudioContext.last };
}

// The fixture bomb: planted at tick 1000, detonating 41 s later (what
// the dev matches record — see bombEndTick) — a 2624-tick fuse.
const C4_TR = 64;
const C4_PLANT = 1000;
const C4_EXPLODE = C4_PLANT + 41 * C4_TR;
const c4Rows = (site) => [
  { kind: 'bomb_plant', bucket: 'plant', tick: C4_PLANT, round: 5, site },
  { kind: 'bomb_explode', bucket: 'explode', tick: C4_EXPLODE, round: 5, weapon: 'C4' },
];

test('engine: beeps queue ahead on the replay clock with the site’s own sample', async () => {
  resetSoundManifest();
  const restoreFetch = stubManifestFetch();
  try {
    const { sfx, engine, ctx } = await makeSfx();
    sfx.setLandmarks(c4Rows('A'));
    const speed = 8; // the lookahead holds 12 replay-seconds → dozens of beeps
    engine.emit({ playing: true, speed, tick: C4_PLANT });
    // Everything the pure schedule put inside the lookahead window was
    // queued — at its exact AudioContext time (the anchor maps replay
    // ticks onto wall seconds ÷ speed) and with site A's own sample.
    const want = c4BeepTicks(C4_PLANT, C4_EXPLODE, C4_TR).filter(
      (t) => t <= C4_PLANT + 1.5 * C4_TR * speed,
    );
    assert.ok(want.length > 3, `only ${want.length} beeps inside the lookahead`);
    assert.equal(ctx.sources.length, want.length);
    want.forEach((t, i) => {
      assert.equal(ctx.sources[i].started, (t - C4_PLANT) / (C4_TR * speed), `beep ${i}`);
      assert.equal(ctx.sources[i].buffer.url, '/api/sounds/c4_beep2.wav', `beep ${i} sample`);
      assert.equal(ctx.sources[i].stopped, false);
      assert.equal(ctx.sources[i].bus, ctx.gains[2], 'the C4 bus (3rd gain)');
    });
    sfx.destroy();
  } finally {
    restoreFetch();
  }
});

test('engine: the fuse’s tail still queues the normal beep — no phase switch', async () => {
  resetSoundManifest();
  const restoreFetch = stubManifestFetch();
  try {
    const { sfx, engine, ctx } = await makeSfx();
    sfx.setLandmarks(c4Rows('A'));
    const tick = C4_EXPLODE - 5 * C4_TR; // 5 s before the blast
    engine.emit({ playing: true, speed: 8, tick });
    const inWin = c4BeepTicks(C4_PLANT, C4_EXPLODE, C4_TR).filter(
      (t) => t > tick && t <= tick + 1.5 * C4_TR * 8,
    );
    assert.ok(inWin.length > 0, 'the fuse’s tail is inside the lookahead window');
    // Every beep of the tail — including the last one before the
    // detonation — is the site’s one normal sample (c4BeepGroup has no
    // phase: the whole fuse beeps at the established cadence).
    for (const t of inWin) {
      const src = ctx.sources.find((s) => s.started === (t - tick) / (C4_TR * 8));
      assert.ok(src, `beep at ${t} was never queued`);
      assert.equal(src.buffer.url, '/api/sounds/c4_beep2.wav', `beep ${t} sample`);
    }
    sfx.destroy();
  } finally {
    restoreFetch();
  }
});

test('engine: pause silences the whole queue, resume re-arms from the playhead', async () => {
  resetSoundManifest();
  const restoreFetch = stubManifestFetch();
  try {
    const { sfx, engine, ctx } = await makeSfx();
    sfx.setLandmarks(c4Rows('B'));
    engine.emit({ playing: true, speed: 8, tick: C4_PLANT });
    assert.ok(ctx.sources.length > 0, 'the lookahead queued beeps first');
    assert.ok(
      ctx.sources.every((s) => s.buffer.url === '/api/sounds/c4_beep3.wav'),
      'site B plays the site B sample',
    );
    // Pause: every queued beep is in the future → dropped, none added.
    const queued = ctx.sources.length;
    engine.emit({ playing: false, speed: 8, tick: C4_PLANT + C4_TR });
    assert.equal(ctx.sources.length, queued, 'nothing is queued while paused');
    assert.ok(ctx.sources.every((s) => s.stopped), 'the queue went silent on pause');
    // Resume: re-armed past the playhead (the pause frame's tick), the
    // schedule's next beep onward — nothing skipped backwards, nothing
    // replayed at the plant.
    engine.emit({ playing: true, speed: 8, tick: C4_PLANT + C4_TR });
    const want = c4BeepTicks(C4_PLANT, C4_EXPLODE, C4_TR).filter(
      (t) => t > C4_PLANT + C4_TR && t <= C4_PLANT + C4_TR + 1.5 * C4_TR * 8,
    );
    const fresh = ctx.sources.slice(queued);
    assert.equal(fresh.length, want.length, 'the resume re-queues from the playhead');
    sfx.destroy();
  } finally {
    restoreFetch();
  }
});

test('engine: a seek re-seeds — the stale queue is dropped, crossed beeps never play', async () => {
  resetSoundManifest();
  const restoreFetch = stubManifestFetch();
  try {
    const { sfx, engine, ctx } = await makeSfx();
    sfx.setLandmarks(c4Rows('A'));
    engine.emit({ playing: true, speed: 8, tick: C4_PLANT });
    const before = ctx.sources.length;
    // A 20 s forward seek: cueGapJump says jump → re-seed.
    const tick = C4_PLANT + 20 * C4_TR;
    engine.emit({ playing: true, speed: 8, tick });
    assert.ok(
      ctx.sources.slice(0, before).every((s) => s.stopped),
      'the stale queue was dropped',
    );
    const want = c4BeepTicks(C4_PLANT, C4_EXPLODE, C4_TR).filter(
      (t) => t > tick && t <= tick + 1.5 * C4_TR * 8,
    );
    const fresh = ctx.sources.slice(before);
    assert.equal(fresh.length, want.length, 'only beeps past the playhead are re-queued');
    fresh.forEach((s, i) => {
      // The new queue starts at the new anchor — no beep from BEFORE the
      // seek got a second chance to play.
      assert.equal(s.started, (want[i] - tick) / (C4_TR * 8));
      assert.ok(s.started >= 0, 'never scheduled in the past');
    });
    sfx.destroy();
  } finally {
    restoreFetch();
  }
});

test('engine: the explosion cue rides the C4 bus and a resolved bomb never beeps again', async () => {
  resetSoundManifest();
  const restoreFetch = stubManifestFetch();
  try {
    const { sfx, engine, ctx } = await makeSfx();
    sfx.setLandmarks([
      ...c4Rows('A'),
      { kind: 'grenade', bucket: 'he', weapon: 'HE Grenade', tick: C4_EXPLODE - 10 },
    ]);
    // The first frame seeds the schedule (jump → no cues on arrival)…
    engine.emit({ playing: true, speed: 1, tick: C4_EXPLODE - 16 });
    // …and an ordinary forward step (16 ticks, inside the 0.3 s window)
    // crosses the detonation with the clock advanced alongside, so the
    // cue window plays BOTH blasts.
    ctx.currentTime = 16 / C4_TR;
    engine.emit({ playing: true, speed: 1, tick: C4_EXPLODE });
    const boom = ctx.sources.filter((s) => s.buffer && s.buffer.url === '/api/sounds/c4_explode1.wav');
    assert.equal(boom.length, 1, 'the C4 explosion cue plays exactly once');
    assert.equal(boom[0].bus, ctx.gains[2], 'the explosion rides the C4 bus');
    const he = ctx.sources.filter(
      (s) => s.buffer && s.buffer.url === '/api/sounds/hegrenade_detonate_02.wav',
    );
    assert.equal(he.length, 1, 'the HE detonation in the same window still plays');
    assert.equal(he[0].bus, ctx.gains[1], 'grenades stay on the utility bus');
    // The bomb is resolved (c4BombAt: tick ≥ stop) → nothing new is ever
    // queued again, on any frame.
    const after = ctx.sources.length;
    engine.emit({ playing: true, speed: 1, tick: C4_EXPLODE + C4_TR });
    assert.equal(ctx.sources.length, after, 'no beep outlives the detonation');
    engine.emit({ playing: false, speed: 1, tick: C4_EXPLODE + C4_TR });
    assert.equal(ctx.sources.length, after, 'and a later pause queues nothing either');
    sfx.destroy();
  } finally {
    restoreFetch();
  }
});

// The four plant/defuse lifecycle cues through the REAL play path:
// rows → rebuildCues → (prevTick, curTick] → playGroup on the C4 bus.
// The steps stay inside cueGapJump's ordinary-window (≤ 0.3 s at 1×) so
// each crossing is playback, not a re-seed; a jump only re-positions
// the compare point (which is exactly how a seek must behave).
test('engine: the plant/defuse lifecycle cues play on the C4 bus, cancels stay silent', async () => {
  resetSoundManifest();
  const restoreFetch = stubManifestFetch();
  try {
    const { sfx, engine, ctx } = await makeSfx();
    const BEGIN = 1000; // arm starts
    const DONE = 1200; // plant finishes (200 ticks — the measured span)
    const ABORT = 1400; // a later, cancelled attempt
    const lifecycle = () =>
      ctx.sources.filter(
        (s) =>
          s.buffer &&
          /\/api\/sounds\/c4_(initiate|plant|disarmstart|disarmfinish)\.wav$/.test(s.buffer.url),
      );
    sfx.setLandmarks([
      { kind: 'bomb_plant_begin', bucket: 'plant_begin', tick: BEGIN, round: 5 },
      { kind: 'bomb_plant', bucket: 'plant', tick: DONE, round: 5, site: 'A' },
      { kind: 'bomb_plant_abort', bucket: 'plant_abort', tick: ABORT, round: 5 },
    ]);
    // The first frame seeds the compare point (jump → nothing on arrival)…
    engine.emit({ playing: true, speed: 1, tick: BEGIN - 16 });
    // …an ordinary step crosses the arm start.
    engine.emit({ playing: true, speed: 1, tick: BEGIN + 2 });
    const arm = ctx.sources.filter((s) => s.buffer && s.buffer.url === '/api/sounds/c4_initiate.wav');
    assert.equal(arm.length, 1, 'the plant-start cue plays exactly once');
    assert.equal(arm[0].bus, ctx.gains[2], 'it rides the C4 bus (guns=0, utility=1, C4=2)');
    // A jump re-seeds without playing (nothing was due in that window),
    // then an ordinary step crosses the completion.
    engine.emit({ playing: true, speed: 1, tick: DONE - 10 });
    engine.emit({ playing: true, speed: 1, tick: DONE + 2 });
    const done = ctx.sources.filter((s) => s.buffer && s.buffer.url === '/api/sounds/c4_plant.wav');
    assert.equal(done.length, 1, 'the plant-complete cue plays exactly once');
    assert.equal(done[0].bus, ctx.gains[2], 'the completion rides the C4 bus too');
    // …and the CANCEL is silence: bombActionCues builds no cue for an
    // abort row (there is no cancel sound in the game to extract).
    const before = lifecycle().length;
    engine.emit({ playing: true, speed: 1, tick: ABORT - 10 });
    engine.emit({ playing: true, speed: 1, tick: ABORT + 2 });
    assert.equal(lifecycle().length, before, 'an aborted plant plays nothing');
    sfx.destroy();
  } finally {
    restoreFetch();
  }
});

// The ANNOUNCER lines through the REAL play path: rows → rebuildCues →
// (prevTick, curTick] → announcerOrder → playGroupAt on the announcer
// bus. Same ordinary-window stepping as the lifecycle test above (the
// steps stay inside cueGapJump's 0.3 s window, so each crossing is
// playback rather than a re-seed).
test('engine: bombdef starts before the round-win line in a shared window, on the announcer bus', async () => {
  resetSoundManifest();
  const restoreFetch = stubManifestFetch();
  try {
    const { sfx, engine, ctx } = await makeSfx();
    const DEF = 1200; // the defuse AND its round_end share this tick
    const WIN = 2600; // a later round ends normally — no defuse in view
    sfx.setRounds([
      { number: 5, winner: 'ct', reason: 'Bomb defused', startTick: 1000, freezeEndTick: 1010, endTick: DEF },
      { number: 6, winner: 't', reason: 'Elimination', startTick: 1300, freezeEndTick: 1310, endTick: WIN },
    ]);
    sfx.setLandmarks([
      { kind: 'bomb_defuse', bucket: 'defuse', tick: DEF, round: 5 },
      { kind: 'round_end', bucket: 'round', tick: DEF, round: 5 },
      { kind: 'round_end', bucket: 'round', tick: WIN, round: 6 },
    ]);
    // The first frame seeds the compare point (jump → nothing on
    // arrival)…
    engine.emit({ playing: true, speed: 1, tick: DEF - 16 });
    // …an ordinary step crosses the defuse + round end together.
    ctx.currentTime = 0.25;
    engine.emit({ playing: true, speed: 1, tick: DEF + 2 });
    const def = ctx.sources.filter((s) => s.buffer && s.buffer.url === '/api/sounds/bombdef.wav');
    const win = ctx.sources.filter((s) => s.buffer && s.buffer.url === '/api/sounds/ctwin.wav');
    assert.equal(def.length, 1, 'the defuse line plays exactly once');
    assert.equal(win.length, 1, 'the round-win line plays exactly once');
    // THE ordering: bombdef starts on arrival, the win line
    // ANNOUNCER_ORDER_DELAY_S later (the owner-observed sequence —
    // both rows share a tick, so only the explicit delay can order them).
    assert.equal(def[0].started, 0.25, 'bombdef starts now');
    assert.equal(
      win[0].started,
      def[0].started + ANNOUNCER_ORDER_DELAY_S,
      'the win line follows after the explicit delay',
    );
    // Both ride the 4th gain — the ANNOUNCER bus (guns=0, utility=1,
    // C4=2, announcer=3) — never the C4 or utility bus.
    assert.equal(def[0].bus, ctx.gains[3], 'bombdef on the announcer bus');
    assert.equal(win[0].bus, ctx.gains[3], 'ctwin on the announcer bus');
    // A window WITHOUT a defuse plays its win line on arrival (no delay).
    engine.emit({ playing: true, speed: 1, tick: WIN - 16 });
    ctx.currentTime = 1.5;
    engine.emit({ playing: true, speed: 1, tick: WIN + 2 });
    const ter = ctx.sources.filter((s) => s.buffer && s.buffer.url === '/api/sounds/terwin.wav');
    assert.equal(ter.length, 1, 'the later round-win line plays exactly once');
    assert.equal(ter[0].started, 1.5, 'no defuse in the window → no delay');
    assert.equal(ter[0].bus, ctx.gains[3], 'terwin on the announcer bus');
    sfx.destroy();
  } finally {
    restoreFetch();
  }
});

// The match-point stinger through the REAL play path: setRounds +
// setLandmarks → rebuildCues → (prevTick, curTick] → playAnnouncerInRange
// on the announcer bus. The steps stay inside cueGapJump's 0.3 s window,
// so each crossing is playback rather than a re-seed.
test('engine: the match-point stinger plays once at freeze start on the announcer bus', async () => {
  resetSoundManifest();
  const restoreFetch = stubManifestFetch();
  try {
    const { sfx, engine, ctx } = await makeSfx();
    sfx.setRounds(MP_ROUNDS);
    sfx.setLandmarks(MP_ROUNDS.map((r) => mpRow(r.number)));
    const POINT = mpStart(24); // round 24 starts at 12-11 → match point
    // The first frame seeds the compare point (jump → nothing on arrival)…
    engine.emit({ playing: true, speed: 1, tick: POINT - 16 });
    // …an ordinary step crosses the round's FREEZE START.
    ctx.currentTime = 0.5;
    engine.emit({ playing: true, speed: 1, tick: POINT + 2 });
    const mp = ctx.sources.filter((s) => s.buffer && s.buffer.url === '/api/sounds/cs_stinger.wav');
    assert.equal(mp.length, 1, 'the stinger plays exactly once');
    assert.equal(mp[0].started, 0.5, 'on arrival — no ordering delay (announcerOrder leaves it 0)');
    assert.equal(mp[0].bus, ctx.gains[3], 'on the ANNOUNCER bus (guns=0, utility=1, C4=2, announcer=3)');
    // The NEXT freeze start (round 25, scoreline 12-12 → overtime
    // begins) crosses the same way and must stay silent — only rounds
    // the predicate calls match point cue.
    engine.emit({ playing: true, speed: 1, tick: mpStart(25) - 16 }); // re-seed (a jump)
    ctx.currentTime = 0.9;
    engine.emit({ playing: true, speed: 1, tick: mpStart(25) + 2 }); // ordinary step
    const after = ctx.sources.filter((s) => s.buffer && s.buffer.url === '/api/sounds/cs_stinger.wav');
    assert.equal(after.length, 1, 'the 12-12 freeze start stays silent');
    sfx.destroy();
  } finally {
    restoreFetch();
  }
});

// stubManifestFetch — the engine's preload pulls /api/sounds/manifest.json
// and the URLs it lists; the decoded buffer is tagged with its URL so the
// tests can assert WHICH sample a source plays. Returns the un-stub.
function stubManifestFetch() {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('manifest.json')) {
      return { ok: true, json: async () => BEEP_MANIFEST };
    }
    return { ok: true, arrayBuffer: async () => ({ url: u }) };
  };
  return () => {
    globalThis.fetch = prev;
  };
}

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
