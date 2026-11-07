// Tests for lib/replay/bullets.js — per-bullet derivation from the
// state stream: magAmmo steps are shots (guns only, freeze filtered),
// and `draw` picks the tracer lines (semi draws every shot, auto sprays
// draw burst index 1, 4, 7, …).
// Run: node --test src/lib/replay/bullets.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStateIndex, STATE_FIELDS } from './replay/state.js';
import {
  deriveBullets,
  isGunWeapon,
  isAutoWeapon,
  GUN_WEAPONS,
  AUTO_WEAPONS,
} from './replay/bullets.js';

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
const opts = (rounds = [], tickRate = 64) => ({ ticks: ticksOf(400), rounds, tickRate });

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

test('full-auto sprays draw the first bullet then every 3rd', () => {
  const recs = [wm(0, 0, 'AK-47', 30)];
  for (let i = 1; i <= 9; i++) recs.push(m(10 + i, 0, 30 - i));
  const rows = deriveBullets(idx(recs), opts());
  assert.equal(rows.length, 9, 'every bullet is a row — sounds play all of them');
  assert.deepEqual(
    rows.map((r) => r.draw),
    [true, false, false, true, false, false, true, false, false],
    'burst indices 1, 4, 7 draw',
  );
});

test('semi/bolt/pump weapons draw every shot', () => {
  const recs = [wm(0, 0, 'Desert Eagle', 7)];
  for (let i = 1; i <= 4; i++) recs.push(m(10 + i, 0, 7 - i));
  const rows = deriveBullets(idx(recs), opts());
  assert.equal(rows.length, 4);
  assert.ok(
    rows.every((r) => r.draw),
    'one press = one shot = one tracer',
  );
});

test('a lone auto bullet draws exactly one tracer', () => {
  const rows = deriveBullets(idx([wm(0, 0, 'AK-47', 30), m(10, 0, 29)]), opts());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].draw, true, 'the first bullet of a burst always draws');
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

test('an auto burst restarts after a pause beyond the half-second gap', () => {
  const rows = deriveBullets(
    idx([wm(0, 0, 'AK-47', 30), m(10, 0, 29), m(11, 0, 28), m(100, 0, 27)]),
    opts(),
  );
  assert.deepEqual(
    rows.map((r) => r.draw),
    [true, false, true],
    'frames 10/11 are one burst; frame 100 starts a new one whose first shot draws',
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

test('weapon membership: guns only, auto subset only', () => {
  assert.ok(isGunWeapon('AK-47'));
  assert.ok(isGunWeapon('Zeus x27'));
  for (const bad of ['Knife', 'HE Grenade', 'Smoke Grenade', 'C4', 'Kevlar Vest', 'Defuse Kit', 'Decoy Grenade']) {
    assert.ok(!isGunWeapon(bad), `${bad} is not a gun`);
  }
  for (const name of GUN_WEAPONS) assert.ok(isGunWeapon(name));
  for (const name of AUTO_WEAPONS) assert.ok(GUN_WEAPONS.has(name), `${name} must be a gun too`);
  assert.ok(isAutoWeapon('CZ75 Auto'));
  assert.ok(isAutoWeapon('Negev'));
  assert.ok(!isAutoWeapon('Desert Eagle'), 'pistols are semi');
  assert.ok(!isAutoWeapon('AWP'), 'bolt action draws every shot');
  assert.ok(!isAutoWeapon('Nova'), 'pump draws every shot');
});
