// Recorded lingering-area ends (lib/replay/world.js loadAreaEnds +
// stampAreaEnd): the demo's `smokegrenade_expired` / `inferno_expire`
// generic rows pair to their START rows by entityid + round (the CS2.md
// pairing) and stamp `areaEndTick` onto the typed smoke/fire row — the
// absolute end the renderer's areaOwnEndTick prefers over its measured
// fallback. Pins:
//   · the PAIRING: entityid + round → the right end tick, bridged to the
//     typed row by (bucket, round, tick);
//   · the honest ABSENCE: every row that cannot pair carries NO field
//     (never a stamped 0), including a non-area row sharing the smoke's
//     round+tick, a cross-round expire and an expire preceding its start;
//   · the EXPLICIT page (the store's default 500 would truncate a name
//     the dev pool measured up to 774 rows in one match);
//   · fail-soft: a rejected read stamps nothing for its pair and never
//     fails the load.
//
// Run: node --test src/lib/world-area-ends.test.js (from frontend/; the
// lib test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

installEsmDirHook();

// world.js → services.js → the generated bindings: the real bindings talk
// to a live Wails backend, so redirect them to the test stubs before the
// module graph loads (hooks are per-process, this file runs alone — the
// world-hydration.test.js pattern).
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) {
      return { url: stub('bindings.mjs'), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const bindings = await import('../../test/stubs/bindings.mjs');
const { loadWorld } = await import('./replay/world.js');

// The typed anchor rows: every smoke/fire row matches its generic start
// row on (bucket, round, tick). The kill at the SAME round+tick as the
// smoke at 500 pins that the stamp never reaches a non-area row.
const ROWS = [
  { id: 1, seq: 1, tick: 100, round: 1, kind: 'grenade', attacker: '1', weapon: 'Smoke Grenade', posX: 50, posY: 50 },
  { id: 2, seq: 2, tick: 200, round: 1, kind: 'grenade', attacker: '1', weapon: 'Molotov', posX: 60, posY: 60 },
  { id: 3, seq: 3, tick: 400, round: 1, kind: 'grenade', attacker: '1', weapon: 'Incendiary Grenade', posX: 70, posY: 70 },
  { id: 4, seq: 4, tick: 500, round: 1, kind: 'grenade', attacker: '1', weapon: 'Smoke Grenade', posX: 80, posY: 80 },
  { id: 5, seq: 5, tick: 500, round: 1, kind: 'kill', attacker: '1', victim: '2', weapon: 'ak47', posX: 80, posY: 80 },
  { id: 6, seq: 6, tick: 700, round: 1, kind: 'grenade', attacker: '1', weapon: 'Smoke Grenade', posX: 90, posY: 90 },
  { id: 7, seq: 7, tick: 800, round: 1, kind: 'grenade', attacker: '1', weapon: 'Molotov', posX: 95, posY: 95 },
];

// The generic rows by name — payloads shaped like the extractor's raw
// game-event JSON: `entityid` is the game event's OWN field (the pairing
// key). Row-by-row intent is noted beside each entry.
const GENERIC = {
  smokegrenade_detonate: [
    { rowId: 11, tick: 100, round: 1, payloadJson: '{"entityid":7}' }, // → row 1
    { rowId: 12, tick: 500, round: 1, payloadJson: '{"entityid":9}' }, // → row 4 (the kill at 500 stays out)
    { rowId: 13, tick: 700, round: 1, payloadJson: '{"entityid":12}' }, // its expire lands in round 2 → no pair
  ],
  smokegrenade_expired: [
    { rowId: 21, tick: 1512, round: 1, payloadJson: '{"entityid":7}' },
    { rowId: 22, tick: 1600, round: 1, payloadJson: '{"entityid":9}' },
    { rowId: 23, tick: 1812, round: 2, payloadJson: '{"entityid":12}' }, // wrong round for its start
    { rowId: 24, tick: 900, round: 1, payloadJson: '{}' }, // no entityid → never pairs
  ],
  inferno_startburn: [
    { rowId: 31, tick: 200, round: 1, payloadJson: '{"entityid":11}' }, // → row 2, extinguished at +100
    { rowId: 32, tick: 800, round: 1, payloadJson: '{"entityid":13}' }, // its expire PRECEDES it → no pair
  ],
  inferno_expire: [
    { rowId: 41, tick: 300, round: 1, payloadJson: '{"entityid":11}' },
    { rowId: 42, tick: 750, round: 1, payloadJson: '{"entityid":13}' },
  ],
};

// scriptWorld — reset the call log and script every world read (the
// world-hydration.test.js harness): no bounces → the detail reads never
// run; buytime_ended answers [] (the kit evidence's empty-boundary path).
function scriptWorld() {
  bindings.resetCalls();
  bindings.handlers.GetEvents = () => ROWS.map((r) => ({ ...r }));
  bindings.handlers.GetDropDetails = () => [];
  bindings.handlers.GetEvent = () => null;
  bindings.handlers.GetEventDetails = () => [];
  bindings.handlers.GetGenericEvents = (id, name) =>
    (GENERIC[name] || []).map((r) => ({ matchId: id, name, ...r }));
}

function load() {
  return loadWorld({ matchId: 7, players: [], stateIndex: null, ticks: null, tickRate: 64 });
}

function rowsById(world) {
  return new Map(world.rows.map((r) => [r.id, r]));
}

test('loadWorld stamps the recorded area end on PAIRED smoke/fire rows (entityid + round)', async () => {
  scriptWorld();
  const world = await load();
  const byId = rowsById(world);
  assert.equal(world.rows.length, ROWS.length, 'every anchor row survives normalization');
  assert.equal(byId.get(1).areaEndTick, 1512, 'the smoke takes its recorded smokegrenade_expired tick');
  assert.equal(
    byId.get(2).areaEndTick,
    300,
    'the extinguished fire takes its EARLY inferno_expire (+100), never the 450-tick window',
  );
  assert.equal(byId.get(4).areaEndTick, 1600, 'a second pair in the same round stamps its own end');
});

test('rows that cannot honestly pair carry NO areaEndTick (absent, never a stamped 0)', async () => {
  scriptWorld();
  const world = await load();
  const byId = rowsById(world);
  const cases = [
    [3, 'no startburn row for it at all'],
    [5, 'a kill at the same round+tick is never stamped (the stamp is bucket-scoped)'],
    [6, 'its expire lands in ANOTHER round → the round-scoped key never matches'],
    [7, 'its expire PRECEDES the start → not this area’s end'],
  ];
  for (const [id, why] of cases) {
    const row = byId.get(id);
    assert.ok(row, `row ${id} present`);
    assert.equal('areaEndTick' in row, false, `row ${id} must stay unstamped: ${why}`);
  }
  // the unstamped rows keep every other field (the stamp is additive)
  assert.equal(byId.get(3).bucket, 'fire', 'the row itself is untouched');
});

test('the area-end reads pass an EXPLICIT page (the store default 500 would truncate)', async () => {
  scriptWorld();
  await load();
  const areaNames = new Set([
    'smokegrenade_detonate',
    'smokegrenade_expired',
    'inferno_startburn',
    'inferno_expire',
  ]);
  const reads = bindings.calls.filter((c) => c.method === 'GetGenericEvents' && areaNames.has(c.args[1]));
  assert.equal(reads.length, 4, 'one read per AREA_END_JOBS name');
  for (const c of reads) {
    assert.equal(c.args[2], -1, 'round -1 = every round in ONE call');
    assert.ok(
      c.args[3] >= 774,
      `explicit page ≥ the densest measured single-name count (774 rows/match), got ${c.args[3]}`,
    );
  }
});

test('a rejected area-end read fails soft: no stamp for that pair, the load still resolves', async () => {
  scriptWorld();
  bindings.handlers.GetGenericEvents = (id, name) => {
    if (name === 'smokegrenade_expired') return Promise.reject(new Error('read failed'));
    return (GENERIC[name] || []).map((r) => ({ matchId: id, name, ...r }));
  };
  const world = await load();
  const byId = rowsById(world);
  assert.equal(world.rows.length, ROWS.length, 'a failed side channel never fails the load');
  assert.equal('areaEndTick' in byId.get(1), false, 'the smoke stays unstamped (fallback lifetime applies)');
  assert.equal('areaEndTick' in byId.get(4), false, '…for every smoke in that pair');
  assert.equal(byId.get(2).areaEndTick, 300, 'the fire pair (a different read) still stamps');
});
