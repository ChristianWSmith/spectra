// Decoy lifecycle plan tests (lib/replay/decoy.js): the throw→rest→noise
// →explosion pairing, the DETERMINISTIC fake-gunshot cadence (3–5 s
// windows × 1–3 shots, bolt mains exactly 1), the never-guess-a-weapon
// rule (no state stream / no inventory / no side → NO shots) and the
// freeze belt. Run: node --test src/lib/decoy.test.js
// (from frontend/; the lib test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECOY_WEAPON,
  DECOY_SETTLE_S,
  DECOY_INTERVAL_MIN_S,
  DECOY_INTERVAL_MAX_S,
  DECOY_SHOTS_MIN,
  DECOY_SHOTS_MAX,
  mulberry32,
  decoyShotSchedule,
  buildDecoyPlan,
} from './replay/decoy.js';
import { buildStateIndex, STATE_FIELDS } from './replay/state.js';

const TR = 64;

// --- cadence generator -----------------------------------------------------

test('decoyShotSchedule: windows of 3–5 s × 1–3 shots, from rest + settle to the blast', () => {
  // Scripted rand (floors) → fully predictable output:
  //   r()=0        → window 3 s, 1 shot at the window's midpoint
  //   r()=0.9999…  → window 5 s, 3 shots at 1/4, 2/4, 3/4 of the window
  const land = 1000;
  const start = land + Math.round(DECOY_SETTLE_S * TR); // +32 → 1032
  const floor = decoyShotSchedule({
    landTick: land,
    detTick: 1900,
    tickRate: TR,
    weapon: 'AK-47',
    rand: () => 0,
  });
  // 3 s = 192 ticks; windows start at 1032, 1224, 1416, 1608, 1800
  // (all < 1900); one shot at each window's midpoint (+96).
  assert.deepEqual(
    floor.map((s) => s.tick),
    [1128, 1320, 1512, 1704, 1896],
  );
  const ceil = decoyShotSchedule({
    landTick: land,
    detTick: 1032 + 640 + 10, // the third window's first shot lands past the blast
    tickRate: TR,
    weapon: 'AK-47',
    rand: () => 0.9999999,
  });
  // 5 s = 320 ticks; windows at 1032 and 1352 fire 3 shots each at
  // +80/+160/+240 (i·len/4); the window starting at 1672 only has shots
  // at/after 1752 ≥ 1682 → capped by the blast (never scheduled).
  assert.deepEqual(
    ceil.map((s) => s.tick),
    [1112, 1192, 1272, 1432, 1512, 1592],
  );
  // The spec's bounds, expressed through the constants.
  assert.equal(DECOY_INTERVAL_MIN_S, 3);
  assert.equal(DECOY_INTERVAL_MAX_S, 5);
  assert.equal(DECOY_SHOTS_MIN, 1);
  assert.equal(DECOY_SHOTS_MAX, 3);
  assert.equal(DECOY_SETTLE_S, 0.5);
});

test('decoyShotSchedule: SSG 08/AWP mains fire EXACTLY 1 shot per interval', () => {
  const land = 1000;
  const det = 1032 + 640 + 10; // two 5 s windows
  const bolt = decoyShotSchedule({
    landTick: land,
    detTick: det,
    tickRate: TR,
    weapon: 'AWP', // the spec's bolt rule
    rand: () => 0.9999999,
  });
  // Same rand as the 3-shot run above, but the bolt rule pins n=1: one
  // shot per window at its midpoint (+160 of 320).
  assert.deepEqual(
    bolt.map((s) => s.tick),
    [1192, 1512],
  );
  for (const w of ['SSG 08', 'AWP']) {
    const shots = decoyShotSchedule({
      landTick: land,
      detTick: det,
      tickRate: TR,
      weapon: w,
      rand: () => 0,
    });
    // rand()=0 → 3 s windows at 1032/1224/1416/1608: the first three
    // fire (midpoint +96), the one starting 1608 fires at 1704 ≥ 1682
    // → capped by the blast. Exactly ONE shot per firing window.
    assert.equal(shots.length, 3, `${w}: exactly one shot per 3 s window`);
    assert.deepEqual(
      shots.map((s) => s.tick),
      [1128, 1320, 1512],
    );
  }
  // …while a rifle on the SAME rand bursts: 3 shots per window instead
  // of the bolt rule's 1 (non-vacuous contrast — same seed, same
  // windows).
  const rifle = decoyShotSchedule({
    landTick: land,
    detTick: det,
    tickRate: TR,
    weapon: 'AK-47',
    rand: () => 0.9999999,
  });
  assert.equal(rifle.length, 6, 'three shots per firing window (2 × 3)');
});

test('decoyShotSchedule: the default rand is seeded by landTick (deterministic)', () => {
  const args = { landTick: 6400, detTick: 6400 + 20 * TR, tickRate: TR, weapon: 'AK-47' };
  const a = decoyShotSchedule(args);
  const b = decoyShotSchedule(args);
  assert.ok(a.length > 0, 'a 20 s noise window schedules shots');
  assert.deepEqual(a, b, 'same seed → same schedule (every redraw/seek)');
  const other = decoyShotSchedule({ ...args, landTick: 6401 });
  assert.notDeepEqual(a, other, 'a different decoy gets its own schedule');
  // Property bounds over the default sequence: every shot inside
  // [rest+settle, blast), strictly increasing, count inside the
  // cadence envelope (windows of 3–5 s × 1–3 shots over ~19.5 s of
  // noise).
  const start = 6400 + Math.round(DECOY_SETTLE_S * TR);
  const det = 6400 + 20 * TR;
  let prev = -Infinity;
  for (const s of a) {
    assert.ok(s.tick >= start, `shot ${s.tick} starts after the settle (${start})`);
    assert.ok(s.tick < det, `shot ${s.tick} stays before the blast (${det})`);
    assert.ok(s.tick > prev, 'shots strictly increase');
    prev = s.tick;
  }
  // Cadence envelope over ~19.5 s of noise: windows tile back-to-back
  // at 3–5 s each → at least ceil(19.5/5) = 4 windows × ≥1 shot, at
  // most ceil(19.5/3) = 7 windows × ≤3 shots.
  assert.ok(a.length >= 4, `at least one shot per 5 s window (got ${a.length})`);
  assert.ok(a.length <= 21, `at most three shots per 3 s window (got ${a.length})`);
});

test('decoyShotSchedule: unusable input never throws and never schedules', () => {
  assert.deepEqual(decoyShotSchedule({ landTick: NaN, detTick: 100, tickRate: TR }), []);
  assert.deepEqual(decoyShotSchedule({ landTick: 100, detTick: NaN, tickRate: TR }), []);
  // No room between rest and the blast (settle not even elapsed).
  assert.deepEqual(decoyShotSchedule({ landTick: 100, detTick: 110, tickRate: TR }), []);
  assert.deepEqual(decoyShotSchedule({ landTick: 100, detTick: 100, tickRate: TR }), []);
  assert.deepEqual(decoyShotSchedule({ landTick: 100, detTick: 90, tickRate: TR }), []);
});

test('mulberry32: deterministic unit-interval stream (the schedule\'s seed)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `in [0,1): ${v}`);
  assert.notDeepEqual(seqA, [mulberry32(43)(), mulberry32(43)(), mulberry32(43)()]);
});

// --- plan derivation -------------------------------------------------------

// A drawNorm-shaped landing + detonation pair (normalizeEvent aliases
// x/y and steamId; kind/weapon/tick/round are the contract this module
// reads).
const landRow = (over = {}) => ({
  id: 1,
  seq: 1,
  kind: 'grenade_land',
  weapon: DECOY_WEAPON,
  tick: 1000,
  round: 1,
  steamId: '1',
  attacker: '1',
  x: 100,
  y: 200,
  ...over,
});
const detRow = (over = {}) => ({
  id: 2,
  seq: 2,
  kind: 'grenade',
  weapon: DECOY_WEAPON,
  tick: 1000 + 17 * TR,
  round: 1,
  steamId: '1',
  attacker: '1',
  x: 100,
  y: 200,
  ...over,
});

const PLAYERS = [{ steamId: '1', name: 'alice', side: 'ct' }];
const stateWith = (inventory) =>
  buildStateIndex(
    [{ frame: 0, slot: 0, mask: STATE_FIELDS.INVENTORY, inventory }],
    1,
  );
const OPTS = (over = {}) => ({
  stateIndex: null,
  resolveFrame: () => 0,
  sideAt: () => 'ct',
  players: PLAYERS,
  tickRate: TR,
  ...over,
});

test('buildDecoyPlan: pairs the landing with the NEXT same-round detonation', () => {
  const plan = buildDecoyPlan(
    [landRow(), detRow()],
    [],
    OPTS(),
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].landTick, 1000);
  assert.equal(plan[0].detTick, 1000 + 17 * TR);
  assert.equal(plan[0].x, 100);
  assert.equal(plan[0].y, 200);
  // An EARLIER detonation (already blown up when the decoy lands) never
  // pairs; the next one does.
  const two = buildDecoyPlan(
    [landRow({ tick: 3000 }), detRow({ tick: 500 }), detRow({ tick: 3000 + 17 * TR })],
    [],
    OPTS(),
  );
  assert.equal(two.length, 1);
  assert.equal(two[0].detTick, 3000 + 17 * TR, 'pairs forward, not to the stale blast');
  // A detonation in ANOTHER round never pairs (same-round rule).
  assert.deepEqual(
    buildDecoyPlan([landRow(), detRow({ round: 2 })], [], OPTS()),
    [],
    'no same-round explosion → no plan entry (fail soft, never a guessed end)',
  );
});

test('buildDecoyPlan: NO detonation row → NO plan entry (documented fail-soft)', () => {
  // Without the explosion the noise window cannot be bounded — an icon
  // that outlives the demo would be a lie, so the honest simple choice
  // is nothing at all.
  assert.deepEqual(buildDecoyPlan([landRow()], [], OPTS()), []);
  // A landing WITHOUT a position still plans (the sfx shots don't need
  // one); the renderer skips the icon via its own hasPos guard.
  const noPos = buildDecoyPlan([landRow({ x: null, y: null }), detRow({ x: null, y: null })], [], OPTS());
  assert.equal(noPos.length, 1);
  assert.equal(noPos[0].x, null);
});

test('buildDecoyPlan: freeze-time landings are dropped (belt and braces)', () => {
  const rounds = [{ number: 1, startTick: 0, freezeEndTick: 64 }];
  assert.deepEqual(
    buildDecoyPlan([landRow({ tick: 32 }), detRow({ tick: 100 })], rounds, OPTS()),
    [],
    'a decoy cannot come to rest during freeze',
  );
  const kept = buildDecoyPlan([landRow({ tick: 100 }), detRow({ tick: 500 })], rounds, OPTS());
  assert.equal(kept.length, 1, 'outside freeze the plan stands');
});

test('buildDecoyPlan: NO state stream → icon/explosion plan, NO shots (never a guessed gun)', () => {
  const [row] = buildDecoyPlan([landRow(), detRow()], [], OPTS({ stateIndex: null }));
  assert.ok(row, 'the icon window still plans without a state stream');
  assert.equal(row.weapon, null);
  assert.deepEqual(row.shots, []);
  // A state stream but no frame resolver (the load-time push, before the
  // engine exists) → same: no shots, startEngine re-pushes the real plan.
  const noFrame = buildDecoyPlan([landRow(), detRow()], [], OPTS({ resolveFrame: null }));
  assert.equal(noFrame[0].weapon, null);
  assert.deepEqual(noFrame[0].shots, []);
  // A thrower outside the roster → no slot → no shots.
  const noSlot = buildDecoyPlan(
    [landRow({ steamId: '999', attacker: '999' }), detRow()],
    [],
    OPTS({ stateIndex: stateWith(['AK-47']) }),
  );
  assert.equal(noSlot[0].weapon, null);
  assert.deepEqual(noSlot[0].shots, []);
});

test('buildDecoyPlan: resolves the mimic weapon through mainWeaponOf (primary → secondary → starter)', () => {
  const rows = [landRow(), detRow()];
  // Primary wins over a secondary also in the inventory.
  const primary = buildDecoyPlan(rows, [], OPTS({ stateIndex: stateWith(['Glock-18', 'AK-47']) }));
  assert.equal(primary[0].weapon, 'AK-47');
  assert.ok(primary[0].shots.length > 0, 'a resolved weapon schedules shots');
  // Secondary when no primary is carried.
  const pistol = buildDecoyPlan(rows, [], OPTS({ stateIndex: stateWith(['P250']) }));
  assert.equal(pistol[0].weapon, 'P250');
  // No gun at all → the SIDE's starter pistol (starter: true — the
  // spec's Glock-18/USP-S rule), but ONLY with a resolvable side.
  const starter = buildDecoyPlan(
    rows,
    [],
    OPTS({ stateIndex: stateWith([]), sideAt: () => 't' }),
  );
  assert.equal(starter[0].weapon, 'Glock-18');
  const noSide = buildDecoyPlan(
    rows,
    [],
    OPTS({ stateIndex: stateWith([]), sideAt: () => '' }),
  );
  assert.equal(noSide[0].weapon, null, 'an unresolvable side never guesses the starter');
  assert.deepEqual(noSide[0].shots, []);
  // The side reaches the plan for the icon tint either way.
  assert.equal(primary[0].side, 'ct');
});

test('buildDecoyPlan: raw EventRow positions (posX/posY) work too; output is sorted + deterministic', () => {
  // The renderer/sfx hand this drawNorm (x/y aliases), but a raw
  // EventRow must plan identically — the row is data, not a shape test.
  const raw = [
    { ...landRow(), x: undefined, y: undefined, posX: 100, posY: 200 },
    { ...detRow(), x: undefined, y: undefined, posX: 100, posY: 200 },
  ];
  const plan = buildDecoyPlan(raw, [], OPTS());
  assert.equal(plan[0].x, 100);
  assert.equal(plan[0].y, 200);

  const rows = [
    landRow({ tick: 5000 }),
    detRow({ tick: 5000 + 17 * TR }),
    landRow({ tick: 1000 }),
    detRow(),
  ];
  const a = buildDecoyPlan(rows, [], OPTS({ stateIndex: stateWith(['AK-47']) }));
  const b = buildDecoyPlan(rows, [], OPTS({ stateIndex: stateWith(['AK-47']) }));
  assert.deepEqual(
    a.map((p) => p.landTick),
    [1000, 5000],
    'sorted by landTick',
  );
  assert.deepEqual(a, b, 'the whole plan (schedule included) is deterministic');
});
