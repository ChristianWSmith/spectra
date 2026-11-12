// Pre-emptive bundle tests (lib/replay/preload.js) — the two revised
// contracts of the loading-ladder follow-up:
//
//   1. PREFS NEVER RIDE THE MEMO. kvstore writes emit NO flush event, so
//      a pref read at preload time would be stale by the time Replay
//      serves it — Replay reads the eight load-time prefs FRESH at load
//      time (as a Promise.all alongside the bundle await). Proven
//      behaviorally: a FULL happy-path bundle (hasSidecar, every group
//      resolved) completes with ZERO KVStoreService.Get calls and
//      carries no `prefs` field to serve stale.
//   2. A SURFACED rejection is DROPPED, not sticky. Within one visit the
//      memo keeps the rejection (the SAME promise — no refetch loop — and
//      no unhandled rejection even when nobody awaits it); Replay's
//      surfacing call drops it, so the NEXT visit retries fresh. A
//      healthy memo is never dropped by that call.
//
// services.js loads against the test stubs (test/stubs/) — the real
// module, scripted bindings; the service objects are shared mutable
// exports of the SAME stub instance, so the reads the bundle needs that
// services-cache does not drive are added here.
// Run: node --test src/lib/preload.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

installEsmDirHook();

// Redirect '@wailsio/runtime' and the generated bindings directory to the
// stubs before preload.js/services.js are imported (hooks are
// per-process; this file runs in its own process under node --test).
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const bindings = await import('../../test/stubs/bindings.mjs');
const { calls, handlers, callCount, resetCalls, ReplayService, MatchService, LibraryService } = bindings;
const { preloadReplay, resetReplayPreload, dropRejectedReplayPreload, onReplayPreloadProgress } =
  await import('./replay/preload.js');

// The shared stub only implements what services-cache drives; these are
// the bundle's reads. Same recording shape as the stub's own `rec`
// (record + consult handlers[method] + resolve null when unscripted).
const rec = (method) => (...args) => {
  calls.push({ method, args });
  const h = handlers[method];
  return h ? Promise.resolve(h(...args)) : Promise.resolve(null);
};
ReplayService.GetReplayMeta = rec('GetReplayMeta');
MatchService.GetTeamNames = rec('GetTeamNames');
MatchService.GetEvents = rec('GetEvents');
MatchService.GetDropDetails = rec('GetDropDetails');
MatchService.GetChat = rec('GetChat');
MatchService.GetBlindDurations = rec('GetBlindDurations');
LibraryService.GetGenericEvents = rec('GetGenericEvents');

// The sidecar/asset HTTP routes the bundle fetches: positions (empty
// stream — parsePositions yields frames:0 without throwing), the state
// stream (absent-parse is fail-soft either way), sidecar meta.json, and
// map-pack meta.json MISSING on both sources (loadMapPack → null → the
// empty pack, so no Image decode runs in node).
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/positions')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null }, // no Content-Length → indeterminate stage
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
  if (u.includes('/state')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  if (u.endsWith('/meta')) {
    return { ok: true, status: 200, json: async () => ({ players: [], weaponNames: [] }) };
  }
  return { ok: false, status: 404 };
};

// One fresh fixture per test: no memo, no scripted handlers, no recorded
// calls (the read-cache inside services is per-process and only serves
// MORE cache hits — it can never invent a GetPref call).
function fresh() {
  resetReplayPreload();
  for (const k of Object.keys(handlers)) delete handlers[k];
  resetCalls();
}

test('a FULL bundle resolves with ZERO pref reads — prefs are never memoized', async () => {
  fresh();
  // hasSidecar TRUE, so every group runs (this is NOT the early
  // noSidecar shortcut — the deep path is the one that used to bundle
  // the prefs).
  handlers.GetReplayMeta = () => ({
    hasSidecar: true,
    tickRate: 64,
    frames: 0,
    players: [{ steamId: '1', name: 'x', side: 'ct' }],
  });
  handlers.GetMatch = () => ({ map: 'de_dust2', sideSwitches: 1 });
  handlers.GetRounds = () => [];
  handlers.GetTeamNames = () => ({ ct: 'Alpha', t: 'Bravo' });
  handlers.GetEvents = () => [];
  handlers.GetDropDetails = () => [];
  handlers.GetGenericEvents = () => [];
  handlers.GetChat = () => [];
  handlers.GetBlindDurations = () => [];

  const bundle = await preloadReplay(99, { force: true });
  // The deep path really ran: positions were fetched + parsed and the
  // world was built — not an early return.
  assert.ok(bundle.meta && bundle.meta.hasSidecar, 'the hasSidecar path');
  assert.ok(bundle.data && bundle.data.frames === 0, 'the positions group ran');
  assert.ok(bundle.world && Array.isArray(bundle.world.rows), 'loadWorld ran');
  assert.ok(Array.isArray(bundle.connRows) && Array.isArray(bundle.chatLines), 'the row reads ran');
  // THE contract: not one kvstore read, and no prefs field to serve.
  assert.equal(callCount('GetPref'), 0, 'the preload must not read a single pref');
  assert.equal('prefs' in bundle, false, 'the bundle carries no prefs to go stale');
});

test('a surfaced rejection is dropped — within the visit: same promise, later visit: fresh retry', async () => {
  fresh();
  handlers.GetReplayMeta = () => {
    throw new Error('sidecar unreadable');
  };

  const p1 = preloadReplay(7, { force: true });
  await assert.rejects(p1, /sidecar unreadable/);

  // ONE visit: the memo keeps the rejection — the SAME promise (no
  // refetch loop; load() runs once per mount) and exactly one backend
  // call for the whole visit.
  assert.equal(preloadReplay(7, { force: true }), p1, 'same promise within the visit');
  assert.equal(callCount('GetReplayMeta'), 1, 'no refetch while the failure is un-surfaced');

  // Replay sets loadError from that rejection and calls the drop.
  dropRejectedReplayPreload(7);

  // LATER visit: a fresh start, not a replayed failure.
  const p2 = preloadReplay(7, { force: true });
  assert.notEqual(p2, p1, 'the surfaced failure no longer pins the memo');
  await assert.rejects(p2, /sidecar unreadable/);
  assert.equal(callCount('GetReplayMeta'), 2, 'the next visit retried the backend');
});

test('the surfacing drop never touches a healthy memo', async () => {
  fresh();
  handlers.GetReplayMeta = () => ({ hasSidecar: false }); // the noSidecar bundle

  const p = preloadReplay(8, { force: true });
  await p;
  // An unrelated load() failure (e.g. startEngine) surfacing through the
  // same catch must not evict a good bundle: the guard is entry.rejected.
  dropRejectedReplayPreload(8);
  assert.equal(preloadReplay(8, { force: true }), p, 'a resolved memo survives the drop');
  assert.equal(callCount('GetReplayMeta'), 1, 'and nothing refetched');
});

test('a rejected preload nobody awaits never surfaces as an unhandled rejection', async () => {
  fresh();
  handlers.GetReplayMeta = () => {
    throw new Error('quiet failure');
  };
  // A listener both RECORDS an unhandled rejection and stops Node from
  // crashing on it — without preload's no-op handler this window would
  // see one.
  const seen = [];
  const onUr = (e) => seen.push(e);
  process.on('unhandledRejection', onUr);
  try {
    preloadReplay(9, { force: true }); // deliberately never awaited here
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10)); // let Node's bookkeeping fire
    assert.deepEqual(seen, [], 'no unhandled rejection while the memo holds the failure');
    await assert.rejects(preloadReplay(9, { force: true }), /quiet failure/);
  } finally {
    process.removeListener('unhandledRejection', onUr);
  }
  resetReplayPreload();
});

// The world-stage wiring pin (the loading-ladder audit's Q4): loadWorld's
// onProgress feeds the EXISTING updateStage ledger helper, so while the
// bundle hydrates grenade entities the head stage 'world' carries a real
// denominator (total = the unique grenade ids, unit 'grenade reads') and
// reaches done === total — instead of staying indeterminate. The other
// loadWorld phases (anchor/drop/buytime reads) report nothing, so the
// stage's denominator is exactly the hydration work.
test('the world stage carries a real denominator while the bundle hydrates grenades', async () => {
  fresh();
  handlers.GetReplayMeta = () => ({
    hasSidecar: true,
    tickRate: 64,
    frames: 0,
    players: [{ steamId: '1', name: 'x', side: 'ct' }],
  });
  handlers.GetMatch = () => ({ map: 'de_dust2', sideSwitches: 1 });
  handlers.GetRounds = () => [];
  handlers.GetTeamNames = () => ({ ct: 'Alpha', t: 'Bravo' });
  // The anchor read (DRAW_KINDS → includes grenade_bounce) carries a
  // bounce row + grenade rows (the hydration gate opens); the ids are
  // the denominator. The feed's own conn/blind reads get nothing.
  handlers.GetEvents = (f) =>
    f && Array.isArray(f.kinds) && f.kinds.includes('grenade_bounce')
      ? [
          { id: 11, seq: 0, tick: 100, round: 1, kind: 'grenade_bounce', attacker: '100', weapon: 'hegrenade' },
          { id: 12, seq: 1, tick: 110, round: 1, kind: 'grenade', attacker: '100', weapon: 'smokegrenade' },
          { id: 13, seq: 2, tick: 120, round: 1, kind: 'grenade', attacker: '100', weapon: 'flashbang' },
        ]
      : [];
  handlers.GetEventDetails = (ids) =>
    ids.map((id) => ({ id, detailJson: '{"entity":4242}' }));
  handlers.GetDropDetails = () => [];
  handlers.GetGenericEvents = () => [];
  handlers.GetChat = () => [];
  handlers.GetBlindDurations = () => [];

  const seen = [];
  const p = preloadReplay(55, { force: true });
  const off = onReplayPreloadProgress(55, (snap) => seen.push({ ...snap }));
  try {
    const bundle = await p;
    assert.ok(bundle.world && bundle.world.rows.length === 3, 'loadWorld ran');

    const world = seen.filter((s) => s.stage === 'loading world events');
    assert.ok(world.length > 0, 'the world stage surfaced to the subscriber');
    const firstWithTotal = world.find((s) => s.total > 0);
    assert.ok(
      firstWithTotal,
      `the world stage carried a denominator (saw: ${JSON.stringify(world)})`,
    );
    assert.equal(firstWithTotal.total, 3, 'the denominator = the unique grenade ids');
    assert.equal(firstWithTotal.unit, 'grenade reads');
    assert.ok(
      world.some((s) => s.done === s.total && s.total > 0),
      'the stage reached done === total while still head',
    );
  } finally {
    off();
  }
});
