// Tests for lib/replay/bullets.js — per-bullet derivation from the
// state stream: magAmmo steps are shots (guns only, freeze filtered),
// every derived row carrying {tick, frame, slot, weapon} (no `draw`
// field — the tracer selection rule was retired by spec: every bullet
// animates).
// Run: node --test src/lib/replay/bullets.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStateIndex, STATE_FIELDS } from './replay/state.js';
import { deriveBullets, isGunWeapon, GUN_WEAPONS } from './replay/bullets.js';

const W = STATE_FIELDS.WEAPON;
const M = STATE_FIELDS.MAG_AMMO;

// Record builders — the state stream is per-frame ATOMIC samples, so a
// weapon switch carrying a new magazine is one record with both bits.
const wm = (frame, slot, weapon, magAmmo) => ({ frame, slot, mask: W | M, weapon, magAmmo });
const w = (frame, slot, weapon) => ({ frame, slot, mask: W, weapon });
const m = (frame, slot, magAmmo) => ({ frame, slot, mask: M, magAmmo });

const idx = (records, slotCount = 1) => buildStateIndex(records, slotCount);
// frame ≡ tick for these fixtures unless a test says otherwise.
const ticksOf = (n) => Array.from({ length: n + 8 }, (_, i) => i);
const opts = (rounds = []) => ({ ticks: ticksOf(400), rounds });

test('a magazine step down is one bullet; a step up is a reload', () => {
  const rows = deriveBullets(
    idx([wm(0, 0, 'AK-47', 30), m(10, 0, 29), m(20, 0, 28), m(30, 0, 30), m(40, 0, 29)]),
    opts(),
  );
  assert.deepEqual(
    rows.map((r) => r.frame),
    [10, 20, 40],
    'the refill at frame 30 is not a shot',
  );
  assert.ok(rows.every((r) => r.weapon === 'AK-47' && r.slot === 0 && Number.isFinite(r.tick)));
  assert.equal(rows[0].tick, 10, 'ticks come from the position stream table');
});

// The four tracer-SELECTION tests deleted from this file in the same
// pass ("full-auto sprays draw the first bullet then every 3rd",
// "semi/bolt/pump weapons draw every shot", "a lone auto bullet draws
// exactly one tracer", "an auto burst restarts after a pause beyond the
// half-second gap") — all deleted WITH the rule itself: the spec
// retired the every-3rd-auto selection ("get rid of the 'every third
// tracer' rule and just animate all tracers"), so
// AUTO_WEAPONS/isAutoWeapon/BURST_GAP_S and the `row.draw` flag are gone
// from bullets.js and no row-level draw expectation can exist anymore.
// Derivation (what IS a bullet) stays pinned below.
test('every bullet is a row for {tick, frame, slot, weapon} — no `draw` field survives', () => {
  // A 9-round full-auto spray: derivation still yields ALL nine bullets
  // (sounds play all of them; tracers now animate all of them too).
  const recs = [wm(0, 0, 'AK-47', 30)];
  for (let i = 1; i <= 9; i++) recs.push(m(10 + i, 0, 30 - i));
  const rows = deriveBullets(idx(recs), opts());
  assert.equal(rows.length, 9, 'every bullet is a row — sounds and tracers use all of them');
  for (const r of rows) {
    assert.deepEqual(
      Object.keys(r).sort(),
      ['frame', 'slot', 'tick', 'weapon'],
      'the row contract is exactly {tick, frame, slot, weapon} — `draw` is retired',
    );
    assert.ok(!('draw' in r), 'no row ever carries a draw flag');
  }
});

test('a weapon switch resyncs — its new magazine is never a bullet', () => {
  // Same-frame switch + new mag (the atomic sample).
  const rows = deriveBullets(
    idx([wm(0, 0, 'AK-47', 30), wm(10, 0, 'Desert Eagle', 7), m(11, 0, 6)]),
    opts(),
  );
  assert.deepEqual(
    rows.map((r) => [r.frame, r.weapon]),
    [[11, 'Desert Eagle']],
    'only the post-switch decrement counts',
  );
});

test('a switch between EQUAL magazines does not fire a phantom shot', () => {
  // The switch lands as a weapon-only record (mag unchanged), so a later
  // decrement must compare against the OLD weapon's standing magazine,
  // not resurrect a false step at the switch frame.
  const rows = deriveBullets(
    idx([wm(0, 0, 'AK-47', 30), w(10, 0, 'M4A4'), m(11, 0, 29)]),
    opts(),
  );
  assert.deepEqual(
    rows.map((r) => [r.frame, r.weapon]),
    [[11, 'M4A4']],
  );
});

test('non-guns never produce bullets: knife, grenades, C4, unknown names', () => {
  const rows = deriveBullets(
    idx([
      wm(0, 0, 'HE Grenade', 1),
      m(5, 0, 0),
      wm(10, 0, 'Knife', 1),
      m(11, 0, 0),
      wm(20, 0, 'C4', 1),
      m(21, 0, 0),
      wm(30, 0, 'Not A Real Gun', 10),
      m(31, 0, 9),
      wm(40, 0, null), // out-of-table weapon index → unknown
      m(41, 0, 4),
    ]),
    opts(),
  );
  assert.deepEqual(rows, [], 'a nade equip/throw or a knife swing is not a shot');
});

test('freeze-time shots are filtered; rounds without a freeze window are not', () => {
  const rounds = [
    { number: -1, startTick: 0, freezeEndTick: 0, endTick: 50 }, // warmup row: no window
    { number: 1, startTick: 100, freezeEndTick: 200, endTick: 1000 },
  ];
  const rows = deriveBullets(
    idx([
      wm(0, 0, 'AK-47', 30),
      m(10, 0, 29), // tick 10 — inside the warmup row (no freeze window) → kept
      m(150, 0, 28), // tick 150 — round 1 freeze time → dropped
      m(200, 0, 27), // tick 200 — freeze END is exclusive → kept
      m(250, 0, 26),
    ]),
    opts(rounds),
  );
  assert.deepEqual(
    rows.map((r) => r.tick),
    [10, 200, 250],
  );
});

test('multi-slot output is globally tick-sorted', () => {
  const rows = deriveBullets(
    idx([wm(0, 1, 'AWP', 10), wm(0, 0, 'AK-47', 30), m(50, 0, 29), m(10, 1, 9)], 2),
    opts(),
  );
  assert.deepEqual(
    rows.map((r) => [r.tick, r.slot]),
    [
      [10, 1],
      [50, 0],
    ],
  );
});

test('no state stream / no ticks degrade to an empty list', () => {
  assert.deepEqual(deriveBullets(null, opts()), []);
  assert.deepEqual(deriveBullets(undefined, opts()), []);
  assert.deepEqual(deriveBullets(idx([wm(0, 0, 'AK-47', 30)]), { ticks: [], rounds: [] }), []);
  assert.deepEqual(deriveBullets(idx([]), opts()), []);
});

// Gun membership only: the auto/semi SPLIT (AUTO_WEAPONS/isAutoWeapon)
// went with the retired tracer selection (justification above) — this
// pins what remains, the set loadout.js also imports.
test('weapon membership: guns only', () => {
  assert.ok(isGunWeapon('AK-47'));
  assert.ok(isGunWeapon('Zeus x27'));
  for (const bad of ['Knife', 'HE Grenade', 'Smoke Grenade', 'C4', 'Kevlar Vest', 'Defuse Kit', 'Decoy Grenade']) {
    assert.ok(!isGunWeapon(bad), `${bad} is not a gun`);
  }
  for (const name of GUN_WEAPONS) assert.ok(isGunWeapon(name));
});
