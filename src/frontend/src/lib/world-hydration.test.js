// GRENade-entity hydration characterization (lib/replay/world.js
// hydrateGrenadeEntities, driven through the public loadWorld): pins the
// EXACT entity stamps the world rows carry for a known set of grenade
// rows — the derived `entity` values, the rows that stay entity-less and
// the untouched rows — so the per-row → BULK detail read swap can be
// proved output-identical (bulk == per-row) instead of trusted.
//
// The detail reads are scripted through the bindings stub, so the test
// also records WHICH read path ran: `t.diagnostic` prints the per-row
// (GetEvent) vs bulk (GetEventDetails) call counts — one GetEvent per
// grenade row before the swap, one GetEventDetails per chunk after it.
// Two more tests pin the swap's SHAPE: the ids chunk at BULK_CHUNK with
// zero per-row round trips, and a failed chunk fails soft over exactly
// its own rows. The onProgress suite (loadWorld's optional progress
// callback — the preload ledger's world-stage denominator) pins the
// {done, total, unit} contract: the denominator lands before any read
// runs and counts UNIQUE ids, done counts ids ATTEMPTED (a settle is a
// settle — every chunk rejecting still reaches total), and the two
// paths where NO read will run (no bounce rows / unresolvable binding)
// report nothing at all.
//
// Run: node --test src/lib/world-hydration.test.js (from frontend/; the
// lib test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

installEsmDirHook();

// world.js → services.js → the generated bindings: the real bindings
// talk to a live Wails backend, so redirect them to the test stubs
// before the module graph loads (hooks are per-process, this file runs
// alone — the sfx/feed test pattern).
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
// Set by the onProgress "nothing to report" test below: the hook then
// REFUSES the bindings specifier, so hydrateGrenadeEntities' dynamic
// import rejects (the fail-soft "no resolvable binding" path) while the
// already-loaded module graph is untouched.
let refuseBindings = false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) {
      if (refuseBindings) throw new Error('bindings unresolvable (scripted)');
      return { url: stub('bindings.mjs'), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const bindings = await import('../../test/stubs/bindings.mjs');
const { loadWorld, BULK_CHUNK } = await import('./replay/world.js');

// One projectile's rows (throw → bounces → blast) plus every edge case
// the hydration must NOT stamp: entity 0 / non-numeric / absent /
// malformed payloads stay UNKNOWN (no key, never a stamped 0), a kill
// row is never a hydration target even when its detail carries an
// entity, and an id with no detail row at all is skipped.
const DETAIL_BY_ID = new Map([
  [101, { id: 101, kind: 'grenade_throw', detailJson: '{"entity":4242}' }],
  [102, { id: 102, kind: 'grenade_bounce', detailJson: '{"entity":4242}' }],
  [103, { id: 103, kind: 'grenade_bounce', detailJson: '{"entity":777}' }],
  [104, { id: 104, kind: 'grenade', detailJson: '{"entity":0}' }],
  [105, { id: 105, kind: 'grenade', detailJson: '{"entity":"abc"}' }],
  [106, { id: 106, kind: 'grenade', detailJson: null }],
  [107, { id: 107, kind: 'grenade', detailJson: 'not-json{' }],
  // 108 (kill) and 109 (grenade_throw) deliberately have NO detail row.
]);

const ROWS = [
  { id: 101, seq: 0, tick: 100, round: 1, kind: 'grenade_throw', attacker: '100', weapon: 'smokegrenade' },
  { id: 102, seq: 1, tick: 110, round: 1, kind: 'grenade_bounce', attacker: '100', weapon: 'smokegrenade' },
  { id: 103, seq: 2, tick: 120, round: 1, kind: 'grenade_bounce', attacker: '100', weapon: 'hegrenade' },
  { id: 104, seq: 3, tick: 130, round: 1, kind: 'grenade', attacker: '100', weapon: 'smokegrenade' },
  { id: 105, seq: 4, tick: 140, round: 1, kind: 'grenade', attacker: '100', weapon: 'hegrenade' },
  { id: 106, seq: 5, tick: 150, round: 1, kind: 'grenade', attacker: '100', weapon: 'molotov' },
  { id: 107, seq: 6, tick: 160, round: 1, kind: 'grenade', attacker: '100', weapon: 'incgrenade' },
  { id: 108, seq: 7, tick: 170, round: 1, kind: 'kill', attacker: '100', victim: '200', weapon: 'ak47' },
  { id: 109, seq: 8, tick: 180, round: 1, kind: 'grenade_throw', attacker: '100', weapon: 'flashbang' },
];

// scriptWorld resets the bindings stub's call log and scripts every
// world read: the anchor list, the drop/buytime side channels, and BOTH
// detail paths (the per-row GetEvent the swap replaces and the bulk
// GetEventDetails) answering from the same DETAIL_BY_ID table — that
// shared answer is what makes "bulk == per-row" checkable.
function scriptWorld() {
  bindings.resetCalls();
  bindings.handlers.GetEvents = () => ROWS.map((r) => ({ ...r }));
  bindings.handlers.GetDropDetails = () => [];
  bindings.handlers.GetGenericEvents = () => [];
  bindings.handlers.GetEvent = (id) => DETAIL_BY_ID.get(id) ?? null;
  bindings.handlers.GetEventDetails = (ids) =>
    ids.map((id) => DETAIL_BY_ID.get(id)).filter(Boolean);
}

test('loadWorld stamps the grenade entity onto the draw rows (characterization)', async (t) => {
  scriptWorld();
  const world = await loadWorld({
    matchId: 7,
    players: [],
    stateIndex: null,
    ticks: null,
    tickRate: 64,
  });
  assert.equal(world.rows.length, ROWS.length, 'every anchor row survives normalization');

  // Ordering-insensitive: the derived entity PER ROW ID, whatever order
  // the fetch returned (null = no `entity` key at all).
  const got = new Map(world.rows.map((r) => [r.id, r.entity === undefined ? null : r.entity]));
  assert.deepEqual(
    [...got.entries()].sort((a, b) => a[0] - b[0]),
    [
      [101, 4242], // throw
      [102, 4242], // bounce of the SAME projectile
      [103, 777], // a second projectile
      [104, null], // entity 0 → unknown
      [105, null], // non-numeric → unknown
      [106, null], // absent payload → unknown
      [107, null], // malformed JSON → unknown, never a throw
      [108, null], // kill row: never a hydration target
      [109, null], // grenade row with no detail row at all → skipped
    ],
  );

  // The map above hides HOW an unstamped row looks: it carries NO
  // `entity` key — "unknown" is an absent field, never a stamped 0.
  for (const id of [104, 105, 106, 107, 108, 109]) {
    const row = world.rows.find((r) => r.id === id);
    assert.equal('entity' in row, false, `row ${id} must stay entity-less`);
  }

  // Which read path actually ran (per-row before the bulk swap, one
  // chunked bulk call after it).
  t.diagnostic(
    `detail reads: GetEvent=${bindings.callCount('GetEvent')} ` +
      `GetEventDetails=${bindings.callCount('GetEventDetails')}`,
  );
});

test('hydration reads details in BULK chunks — never one call per row', async () => {
  // BULK_CHUNK + 1 grenade ids (the +1 spills into a second chunk; the
  // bounce row at the head passes the worth-doing gate) → the ids are
  // split exactly at the chunk boundary and read with ZERO per-row
  // round trips.
  const rows = [];
  for (let i = 0; i < BULK_CHUNK + 1; i++) {
    rows.push({
      id: 1000 + i,
      seq: i,
      tick: 100 + i,
      round: 1,
      kind: i === 0 ? 'grenade_bounce' : 'grenade',
      attacker: '100',
      weapon: 'hegrenade',
    });
  }
  bindings.resetCalls();
  bindings.handlers.GetEvents = () => rows.map((r) => ({ ...r }));
  bindings.handlers.GetDropDetails = () => [];
  bindings.handlers.GetGenericEvents = () => [];
  // The per-row read must NOT be touched any more; if it is, the call
  // log below catches it (the handler itself would answer anyway).
  bindings.handlers.GetEvent = () => null;
  bindings.handlers.GetEventDetails = (ids) =>
    ids.map((id) => ({ id, detailJson: `{"entity":${id}}` }));

  const world = await loadWorld({
    matchId: 7,
    players: [],
    stateIndex: null,
    ticks: null,
    tickRate: 64,
  });

  assert.equal(bindings.callCount('GetEvent'), 0, 'the per-row read must be gone');
  const detailCalls = bindings.calls.filter((c) => c.method === 'GetEventDetails');
  assert.equal(detailCalls.length, 2, 'one call per BULK_CHUNK ids (400 + 1)');
  const chunksRead = detailCalls.map((c) => c.args[0]);
  assert.deepEqual(
    chunksRead.map((c) => c.length),
    [BULK_CHUNK, 1],
    'the chunk boundary sits exactly at BULK_CHUNK',
  );
  assert.deepEqual(
    chunksRead.flat(),
    rows.map((r) => r.id),
    'every target id is read once, in input order, across the chunks',
  );

  // The stamps are byte-identical to the per-row path's: each row gets
  // its own detail's entity (characterization test pins the values).
  assert.equal(world.rows.length, rows.length);
  for (const r of world.rows) {
    assert.equal(r.entity, r.id, `row ${r.id} must carry its own entity`);
  }
});

test('a FAILED chunk leaves exactly its rows entity-less (fail-soft, per chunk)', async () => {
  // The second chunk's read rejects: its rows keep the fallback pairing
  // while the first chunk's rows still stamp — the same granularity
  // contract the per-row reader had, one read failure later.
  const rows = [];
  for (let i = 0; i < BULK_CHUNK + 1; i++) {
    rows.push({
      id: 2000 + i,
      seq: i,
      tick: 100 + i,
      round: 1,
      kind: i === 0 ? 'grenade_bounce' : 'grenade',
      attacker: '100',
      weapon: 'hegrenade',
    });
  }
  bindings.resetCalls();
  bindings.handlers.GetEvents = () => rows.map((r) => ({ ...r }));
  bindings.handlers.GetDropDetails = () => [];
  bindings.handlers.GetGenericEvents = () => [];
  bindings.handlers.GetEventDetails = (ids) => {
    if (ids.length === 1) throw new Error('second chunk read failed');
    return ids.map((id) => ({ id, detailJson: `{"entity":${id}}` }));
  };

  const world = await loadWorld({
    matchId: 7,
    players: [],
    stateIndex: null,
    ticks: null,
    tickRate: 64,
  });

  assert.equal(world.rows.length, rows.length, 'a failed read never drops rows');
  for (const r of world.rows) {
    if (r.id < 2000 + BULK_CHUNK) {
      assert.equal(r.entity, r.id, `row ${r.id} (healthy chunk) must stamp`);
    } else {
      assert.equal('entity' in r, false, `row ${r.id} (failed chunk) stays entity-less`);
    }
  }
});

// --- onProgress (the preload ledger's world-stage denominator) ---------------

test('onProgress: the denominator lands before the reads, done reaches total', async () => {
  // N = the UNIQUE grenade ids: 401 rows' ids with one id REPEATED on a
  // second row (dedupe pin) → two chunks → exactly one ordering-
  // insensitive intermediate report (done = 400 or 1, depending on which
  // chunk settles first).
  const rows = [];
  for (let i = 0; i < BULK_CHUNK + 1; i++) {
    rows.push({
      id: 1000 + i,
      seq: i,
      tick: 100 + i,
      round: 1,
      kind: i === 0 ? 'grenade_bounce' : 'grenade',
      attacker: '100',
      weapon: 'hegrenade',
    });
  }
  rows.push({ ...rows[1], seq: BULK_CHUNK + 1 }); // duplicate id — the denominator counts ids, not rows

  bindings.resetCalls();
  bindings.handlers.GetEvents = () => rows.map((r) => ({ ...r }));
  bindings.handlers.GetDropDetails = () => [];
  bindings.handlers.GetGenericEvents = () => [];
  bindings.handlers.GetEvent = () => null;
  // One interleaved log: every report AND every read, so "the
  // denominator lands BEFORE the chunks run" is checkable by ORDER.
  const log = [];
  bindings.handlers.GetEventDetails = (ids) => {
    log.push({ kind: 'read', n: ids.length });
    return ids.map((id) => ({ id, detailJson: `{"entity":${id}}` }));
  };
  const reports = [];
  const world = await loadWorld({
    matchId: 7,
    players: [],
    stateIndex: null,
    ticks: null,
    tickRate: 64,
    onProgress: (p) => {
      reports.push(p);
      log.push({ kind: 'report', ...p });
    },
  });

  const N = BULK_CHUNK + 1; // unique ids (the duplicate row is deduped away)
  assert.deepEqual(
    log[0],
    { kind: 'report', done: 0, total: N, unit: 'grenade reads' },
    'the {done:0,total:N} report fires BEFORE any chunk read runs',
  );
  assert.ok(
    log.some((e) => e.kind === 'read'),
    'the reads really ran after the report',
  );
  assert.deepEqual(reports[0], { done: 0, total: N, unit: 'grenade reads' });

  // The FINAL report reaches done === total === N.
  const last = reports[reports.length - 1];
  assert.equal(last.done, N, 'final done === N');
  assert.equal(last.total, N, 'final total === N');
  assert.equal(last.unit, 'grenade reads');

  // Ordering-insensitive on the intermediates: every report carries the
  // same denominator and unit, done never regresses, and the single
  // intermediate sits strictly inside (0, total).
  for (const r of reports) {
    assert.equal(r.total, N, 'the denominator never changes mid-run');
    assert.equal(r.unit, 'grenade reads', 'the unit never changes');
  }
  const dones = reports.map((r) => r.done);
  assert.deepEqual(dones, [...dones].sort((a, b) => a - b), 'done never regresses');
  const mid = dones.slice(1, -1);
  assert.equal(mid.length, 1, 'exactly one intermediate report (two chunks)');
  assert.ok(mid[0] > 0 && mid[0] < N, `intermediate ${mid[0]} sits strictly inside (0, ${N})`);

  // The reporting does not disturb the data path.
  assert.equal(world.rows.length, rows.length, 'every row survives');
});

test('onProgress reaches total even when EVERY chunk read rejects (fail-soft)', async () => {
  // Two chunks, both reads REJECT: a failed chunk's ids were still
  // ATTEMPTED work, so done must reach total — the bar never sticks
  // below 100% forever.
  const rows = [];
  for (let i = 0; i < BULK_CHUNK + 1; i++) {
    rows.push({
      id: 3000 + i,
      seq: i,
      tick: 100 + i,
      round: 1,
      kind: i === 0 ? 'grenade_bounce' : 'grenade',
      attacker: '100',
      weapon: 'hegrenade',
    });
  }
  bindings.resetCalls();
  bindings.handlers.GetEvents = () => rows.map((r) => ({ ...r }));
  bindings.handlers.GetDropDetails = () => [];
  bindings.handlers.GetGenericEvents = () => [];
  bindings.handlers.GetEventDetails = () => Promise.reject(new Error('all chunk reads failed'));

  const reports = [];
  const world = await loadWorld({
    matchId: 7,
    players: [],
    stateIndex: null,
    ticks: null,
    tickRate: 64,
    onProgress: (p) => reports.push(p),
  });

  const N = BULK_CHUNK + 1;
  assert.deepEqual(reports[0], { done: 0, total: N, unit: 'grenade reads' });
  const last = reports[reports.length - 1];
  assert.equal(last.done, N, 'done reaches total even when every chunk rejects');
  assert.equal(last.total, N, 'the denominator held');
  assert.equal(reports.length, 3, 'one report per chunk settle + the initial denominator');
  for (const r of reports) assert.equal(r.total, N, 'every report carries the same denominator');

  // The DATA side of fail-soft is unchanged: rows load, entity-less.
  assert.equal(world.rows.length, rows.length, 'a failed read never drops rows');
  for (const r of world.rows) assert.equal('entity' in r, false, `row ${r.id} stays entity-less`);
});

test('onProgress reports NOTHING when no hydration read will run', async () => {
  // (a) grenade rows but NO grenade_bounce → the worth-doing gate
  // early-returns: zero reads, zero reports (indeterminate, unchanged).
  bindings.resetCalls();
  bindings.handlers.GetEvents = () => [
    { id: 601, seq: 0, tick: 100, round: 1, kind: 'grenade_throw', attacker: '100', weapon: 'smokegrenade' },
    { id: 602, seq: 1, tick: 110, round: 1, kind: 'grenade', attacker: '100', weapon: 'hegrenade' },
  ];
  bindings.handlers.GetDropDetails = () => [];
  bindings.handlers.GetGenericEvents = () => [];
  bindings.handlers.GetEventDetails = () => {
    throw new Error('must not run');
  };
  const reportsA = [];
  await loadWorld({
    matchId: 7,
    players: [],
    stateIndex: null,
    ticks: null,
    tickRate: 64,
    onProgress: (p) => reportsA.push(p),
  });
  assert.deepEqual(reportsA, [], 'a match with no bounce rows reports nothing');
  assert.equal(bindings.callCount('GetEventDetails'), 0, 'and no detail read ran');

  // (a2) no grenade TARGETS at all (kills only) — the other half of the
  // same early return: same silence.
  bindings.resetCalls();
  bindings.handlers.GetEvents = () => [
    { id: 610, seq: 0, tick: 100, round: 1, kind: 'kill', attacker: '100', victim: '200', weapon: 'ak47' },
  ];
  const reportsA2 = [];
  await loadWorld({
    matchId: 7,
    players: [],
    stateIndex: null,
    ticks: null,
    tickRate: 64,
    onProgress: (p) => reportsA2.push(p),
  });
  assert.deepEqual(reportsA2, [], 'a match with no grenade targets reports nothing');
  assert.equal(bindings.callCount('GetEventDetails'), 0, 'and no detail read ran');

  // (b) bounce rows present, but the binding import FAILS → the reads
  // never run → zero reports (claiming work that never ran is not).
  bindings.resetCalls();
  bindings.handlers.GetEvents = () => [
    { id: 620, seq: 0, tick: 100, round: 1, kind: 'grenade_bounce', attacker: '100', weapon: 'hegrenade' },
    { id: 621, seq: 1, tick: 110, round: 1, kind: 'grenade', attacker: '100', weapon: 'smokegrenade' },
  ];
  bindings.handlers.GetEventDetails = () => {
    throw new Error('must not run');
  };
  refuseBindings = true;
  try {
    const reportsB = [];
    const world = await loadWorld({
      matchId: 7,
      players: [],
      stateIndex: null,
      ticks: null,
      tickRate: 64,
      onProgress: (p) => reportsB.push(p),
    });
    assert.deepEqual(reportsB, [], 'an unresolvable binding reports nothing');
    assert.equal(bindings.callCount('GetEventDetails'), 0, 'and no detail read ran');
    assert.equal(world.rows.length, 2, 'the rows still load (fail-soft)');
  } finally {
    refuseBindings = false;
  }
});
