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
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const bindings = await import('../../test/stubs/bindings.mjs');
const { loadWorld } = await import('./replay/world.js');

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
