// Read-through cache tests for services.js (A1): same-args returns the
// same promise instance, different args miss, every data-carrying
// spectra:* event (and the explicit invalidate()/mutating wrappers)
// flush so the next call refetches — spectra:asset-progress,
// spectra:heatmap-progress and spectra:analysis-progress being the
// progress-only events that do NOT (they change no row), and
// spectra:analysis-done being the recompute's completion flush (the
// wrapper itself submits and returns, so completion — not submission —
// is where the cache is invalidated).
//
// services.js is loaded against TEST STUBS for its two runtime
// dependencies (test/stubs/) — the real bindings talk to a live Wails
// backend and the real event bus only fires over webview IPC. services.js
// itself is the real module. The GetMatchSummary/GetTeamNames wrappers
// are deliberately NOT exercised here (their bindings do not exist yet);
// the cache is shared cachedRead() code, covered through the wrappers
// that do exist.
// Run: node --test src/lib/services-cache.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

installEsmDirHook();

// Redirect '@wailsio/runtime' and the generated bindings directory to the
// stubs before services.js is imported (hooks are per-process; this file
// runs in its own process under node --test).
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const services = await import('./services.js');
const { fire, listenerCount } = await import('../../test/stubs/wails-runtime.mjs');
const bindings = await import('../../test/stubs/bindings.mjs');

const SPECTRA_EVENTS = [
  'spectra:library-changed',
  'spectra:job-done',
  'spectra:job-progress',
  'spectra:files-dropped',
];

test('the four spectra:* events each register an invalidation listener', () => {
  for (const name of SPECTRA_EVENTS) {
    assert.ok(listenerCount(name) >= 1, `${name} has a listener`);
  }
});

test('same args -> the same promise instance (cache hit)', async () => {
  services.invalidate();
  bindings.resetCalls();
  const a = services.getMatch(7);
  const b = services.getMatch(7);
  assert.equal(a, b, 'identical args must return the identical promise');
  await a;
  assert.equal(bindings.callCount('GetMatch'), 1, 'backend called once');
});

test('different args miss (separate entries, one call each)', async () => {
  services.invalidate();
  bindings.resetCalls();
  const [a, b] = [services.getMatch(7), services.getMatch(8)];
  assert.notEqual(a, b);
  await Promise.all([a, b]);
  assert.equal(bindings.callCount('GetMatch'), 2);

  // per-argument freshness: sort args are part of the key
  const [s1, s2] = [services.getScoreboard(7, 'kills', true), services.getScoreboard(7, 'adr', false)];
  assert.notEqual(s1, s2);
  await Promise.all([s1, s2]);
  assert.equal(bindings.callCount('GetScoreboard'), 2);

  // ...and so are listMatches' query/sort arguments
  const [l1, l2] = [services.listMatches('', 'extracted_at', true), services.listMatches('mirage', 'extracted_at', true)];
  assert.notEqual(l1, l2);
  await Promise.all([l1, l2]);
  assert.equal(bindings.callCount('ListMatches'), 2);
});

test('methods do not share entries across their keys', async () => {
  services.invalidate();
  bindings.resetCalls();
  const m = services.getMatch(7);
  const r = services.getRounds(7);
  assert.notEqual(m, r);
  await Promise.all([m, r]);
  assert.equal(bindings.callCount('GetMatch'), 1);
  assert.equal(bindings.callCount('GetRounds'), 1);
});

for (const name of SPECTRA_EVENTS) {
  test(`${name} invalidates -> the next call refetches`, async () => {
    services.invalidate();
    bindings.resetCalls();
    const first = services.getMatch(7);
    await first;
    fire(name, { jobId: 1 });
    const second = services.getMatch(7);
    assert.notEqual(second, first, 'event must flush the entry');
    await second;
    assert.equal(bindings.callCount('GetMatch'), 2);
  });
}

// spectra:asset-progress (Settings' CS2-asset extraction) is the one
// spectra:* event that carries no data change: it must reach its own
// subscriber and must NOT sit in the flush list at the top of services.js.
test('onAssetProgress delivers the payload and flushes nothing', async () => {
  assert.equal(
    listenerCount('spectra:asset-progress'),
    0,
    'no cache-flush listener for a progress-only event',
  );
  services.invalidate();
  bindings.resetCalls();
  const first = services.getMatch(7);
  await first;

  const seen = [];
  const off = services.onAssetProgress((p) => seen.push(p));
  const payload = { family: 'map-packs', stage: 'extract', done: 4, total: 18 };
  fire('spectra:asset-progress', payload);
  assert.deepEqual(seen, [payload], 'the subscriber gets the Go payload');

  const second = services.getMatch(7);
  assert.equal(second, first, 'progress must not evict the cached read');
  await second;
  assert.equal(bindings.callCount('GetMatch'), 1, 'no refetch on progress');
  off();
});

// spectra:heatmap-progress (Heatmaps' generate) and
// spectra:analysis-progress (a background re-run's start note) are
// progress-only like asset-progress: they reach their own subscribers
// through the generic onEvent and must NOT sit in the flush list.
test('heatmap-progress and analysis-progress deliver payloads and flush nothing', async () => {
  assert.equal(listenerCount('spectra:heatmap-progress'), 0, 'no cache-flush listener for heatmap progress');
  assert.equal(listenerCount('spectra:analysis-progress'), 0, 'no cache-flush listener for analysis progress');
  services.invalidate();
  bindings.resetCalls();
  const first = services.getMatch(7);
  await first;

  const heat = [];
  const analysis = [];
  const offHeat = services.onEvent('spectra:heatmap-progress', (p) => heat.push(p));
  const offAn = services.onEvent('spectra:analysis-progress', (p) => analysis.push(p));
  const heatPayload = { stage: 'load', done: 512, total: 2048 };
  const anPayload = { matchId: 7, stage: 'analyze', done: 0, total: 0 };
  fire('spectra:heatmap-progress', heatPayload);
  fire('spectra:analysis-progress', anPayload);
  assert.deepEqual(heat, [heatPayload], 'the heatmap subscriber gets the Go payload');
  assert.deepEqual(analysis, [anPayload], 'the analysis subscriber gets the Go payload');

  const second = services.getMatch(7);
  assert.equal(second, first, 'progress must not evict the cached read');
  await second;
  assert.equal(bindings.callCount('GetMatch'), 1, 'no refetch on progress');
  offHeat();
  offAn();
});

// spectra:analysis-done is the recompute's DATA change (the derived rows
// were replaced): it flushes the read cache exactly like the wrapper's
// old post-return invalidate() did.
test('spectra:analysis-done invalidates -> the next call refetches', async () => {
  assert.ok(listenerCount('spectra:analysis-done') >= 1, 'the completion listener is registered');
  services.invalidate();
  bindings.resetCalls();
  const first = services.getMatch(7);
  await first;
  fire('spectra:analysis-done', { matchId: 7, error: '' });
  const second = services.getMatch(7);
  assert.notEqual(second, first, 'completion must flush the entry');
  await second;
  assert.equal(bindings.callCount('GetMatch'), 2);
});

// The invalidation-ORDERING rule: the wrapper submits a background
// compute and resolves at submission, so it must NOT flush then (a read
// issued during the compute would re-cache pre-compute rows) — the
// completion event is the flush point.
test('recomputeAnalysis invalidates at completion, not submission', async () => {
  services.invalidate();
  bindings.resetCalls();
  const first = services.getMatch(7);
  await first;

  await services.recomputeAnalysis(7); // submission only (Go returns at queue time)
  const during = services.getMatch(7);
  assert.equal(during, first, 'submission alone must not flush');
  await during;
  assert.equal(bindings.callCount('GetMatch'), 1, 'still one call before completion');

  fire('spectra:analysis-done', { matchId: 7, error: '' });
  const after = services.getMatch(7);
  assert.notEqual(after, first, 'completion must flush');
  await after;
  assert.equal(bindings.callCount('GetMatch'), 2);
});

test('invalidate() flushes explicitly (recompute/reprocess call sites)', async () => {
  services.invalidate();
  bindings.resetCalls();
  const first = services.getRounds(7);
  await first;
  services.invalidate();
  const second = services.getRounds(7);
  assert.notEqual(second, first);
  await second;
  assert.equal(bindings.callCount('GetRounds'), 2);
});

test('a mutating wrapper invalidates on success (no event needed)', async () => {
  services.invalidate();
  bindings.resetCalls();
  await services.getMatch(7);
  await services.deleteMatch(3, false); // DeleteMatch emits nothing in Go
  const after = services.getMatch(7);
  await after;
  assert.equal(bindings.callCount('GetMatch'), 2, 'delete flushed the cache');
});

test('voice reads are cachedRead like every other read (item: voice index)', async () => {
  services.invalidate();
  bindings.resetCalls();
  // Same args → the identical promise; one backend call per method.
  const p1 = services.getVoicePresence(7);
  const p2 = services.getVoicePresence(7);
  assert.equal(p1, p2, 'presence is a cache hit');
  const pl1 = services.getVoicePlayers(7);
  const pl2 = services.getVoicePlayers(7);
  assert.equal(pl1, pl2, 'players is a cache hit');
  const l1 = services.getVoiceLanes(7, 100);
  const l2 = services.getVoiceLanes(7, 100);
  assert.equal(l1, l2, 'lanes is a cache hit (normalized bucket arg)');
  const i1 = services.getVoiceIndex(7, 100, 64);
  const i2 = services.getVoiceIndex(7, 100, 64);
  assert.equal(i1, i2, 'the combined index read is a cache hit');
  await Promise.all([p1, pl1, l1, i1]);
  assert.equal(bindings.callCount('GetVoicePresence'), 1);
  assert.equal(bindings.callCount('GetVoicePlayers'), 1);
  assert.equal(bindings.callCount('GetVoiceLanes'), 1);
  assert.equal(bindings.callCount('GetVoiceIndex'), 1);

  // Different args miss: buckets/windowTicks are part of the key.
  await services.getVoiceLanes(7, 200);
  await services.getVoiceIndex(7, 100, 128);
  assert.equal(bindings.callCount('GetVoiceLanes'), 2);
  assert.equal(bindings.callCount('GetVoiceIndex'), 2);

  // A spectra:* data event (import/reprocess) flushes them like the rest.
  fire('spectra:job-done', { jobId: 1 });
  const again = services.getVoicePlayers(7);
  assert.notEqual(again, pl1, 'event must flush the voice entry');
  await again;
  assert.equal(bindings.callCount('GetVoicePlayers'), 2);
});

test('failed reads are not cached — the next call retries', async () => {
  services.invalidate();
  bindings.resetCalls();
  bindings.handlers.GetMatch = (id) => {
    if (id === 666) throw new Error('boom');
    return { id };
  };
  try {
    await assert.rejects(() => services.getMatch(666), /boom/);
    await assert.rejects(() => services.getMatch(666), /boom/);
    assert.equal(bindings.callCount('GetMatch'), 2, 'the rejection was not cached');
    // a successful sibling entry is unaffected
    const ok = await services.getMatch(7);
    assert.equal(ok.id, 7);
  } finally {
    delete bindings.handlers.GetMatch;
  }
});

test('analytics family is read-cached (item: warm per-match analytics)', async () => {
  services.invalidate();
  bindings.resetCalls();

  // Same args → the identical promise for every wrapped analytics read
  // (in-flight sharing: Match's warm and the tab reads join one entry).
  const pairs = [
    ['GetEconomy', services.getEconomy(7), services.getEconomy(7)],
    ['GetRoundClasses', services.getRoundClasses(7), services.getRoundClasses(7)],
    ['GetCombatStats', services.getCombatStats(7), services.getCombatStats(7)],
    ['GetClutches', services.getClutches(7), services.getClutches(7)],
    ['GetEngagements', services.getEngagements(7, ''), services.getEngagements(7)],
    ['GetUtility', services.getUtility(7), services.getUtility(7)],
  ];
  for (const [method, a, b] of pairs) {
    assert.equal(a, b, `${method} is a cache hit`);
  }
  await Promise.all(pairs.map(([, a]) => a));
  for (const [method] of pairs) {
    assert.equal(bindings.callCount(method), 1, `${method} called once`);
  }

  // Per-match keying: another match id is a separate entry.
  await services.getEconomy(8);
  assert.equal(bindings.callCount('GetEconomy'), 2);

  // A spectra:* data event flushes them like every other cached read.
  fire('spectra:job-done', { jobId: 1 });
  const again = services.getCombatStats(7);
  assert.notEqual(again, pairs[2][1], 'event must flush the analytics entry');
  await again;
  assert.equal(bindings.callCount('GetCombatStats'), 2);
});

test('listPlayers/listMetrics are library-wide reads behind cachedRead (item 3)', async () => {
  services.invalidate();
  bindings.resetCalls();

  // listPlayers(undefined) and listPlayers('') normalize to ONE entry.
  const p1 = services.listPlayers('');
  const p2 = services.listPlayers();
  assert.equal(p1, p2, 'the unfiltered player list is a cache hit');
  const m1 = services.listMetrics();
  const m2 = services.listMetrics();
  assert.equal(m1, m2, 'the metric list is a cache hit');
  await Promise.all([p1, m1]);
  assert.equal(bindings.callCount('ListPlayers'), 1);
  assert.equal(bindings.callCount('ListMetrics'), 1);

  // Typed queries get their own entries (CommandPalette), bounded by the
  // shared FIFO — same shape as the existing library-search entries.
  const q = services.listPlayers('donk');
  assert.notEqual(q, p1, 'a per-query entry must miss the unfiltered one');
  await q;
  assert.equal(bindings.callCount('ListPlayers'), 2);

  // Flush semantics come free from the shared listener list.
  fire('spectra:library-changed', {});
  const afterMetrics = services.listMetrics();
  const afterPlayers = services.listPlayers('');
  assert.notEqual(afterMetrics, m1, 'library-changed flushes listMetrics');
  assert.notEqual(afterPlayers, p1, 'library-changed flushes listPlayers');
  await Promise.all([afterMetrics, afterPlayers]);
  assert.equal(bindings.callCount('ListMetrics'), 2);
  assert.equal(bindings.callCount('ListPlayers'), 3);
});

test('getProfile/getCareerTrend are read-cached (item 6: profile cache)', async () => {
  services.invalidate();
  bindings.resetCalls();
  const SID = '76561198000000042';

  const pr1 = services.getProfile(SID);
  const pr2 = services.getProfile(SID);
  assert.equal(pr1, pr2, 'getProfile is a cache hit');
  const t1 = services.getCareerTrend(SID, 'rating');
  const t2 = services.getCareerTrend(SID, 'rating');
  assert.equal(t1, t2, 'getCareerTrend is a cache hit for the same metric');
  await Promise.all([pr1, t1]);
  assert.equal(bindings.callCount('GetProfile'), 1);
  assert.equal(bindings.callCount('GetCareerTrend'), 1);

  // The metric arg is part of the key (the trend stays click-driven, but
  // each metric still reads fresh).
  await services.getCareerTrend(SID, 'adr');
  assert.equal(bindings.callCount('GetCareerTrend'), 2);

  fire('spectra:job-done', { jobId: 1 });
  const again = services.getProfile(SID);
  assert.notEqual(again, pr1, 'event must flush the profile entry');
  await again;
  assert.equal(bindings.callCount('GetProfile'), 2);
});

test('warmProfile: hover prefetch is throttled per steamId', async () => {
  services.invalidate();
  bindings.resetCalls();
  const SID = '76561198000000042';

  // First hover warms; re-hovers inside the TTL window are no-ops.
  services.warmProfile(SID, 1_000);
  services.warmProfile(SID, 1_500);
  services.warmProfile(SID, 30_999); // 29 999 ms after the last warm
  assert.equal(bindings.callCount('GetProfile'), 1, 'one warm per TTL window');

  // The throttle is per steamId, not the cache: even after a spectra:*
  // flush drops the entry, an in-window hover does NOT refire (the point
  // of the throttle) ...
  fire('spectra:job-done', { jobId: 1 });
  services.warmProfile(SID, 2_000);
  assert.equal(bindings.callCount('GetProfile'), 1, 'flush does not bypass the throttle');

  // ... while a hover PAST the window warms again (that is exactly when
  // the entry may be gone).
  services.warmProfile(SID, 31_000); // 30 000 ms after the first warm
  assert.equal(bindings.callCount('GetProfile'), 2, 'warms again past the TTL');

  // Independent per id, and an empty id is a no-op.
  services.warmProfile('76561198000000099', 32_000);
  assert.equal(bindings.callCount('GetProfile'), 3, 'a different id warms on its own');
  services.warmProfile('', 33_000);
  assert.equal(bindings.callCount('GetProfile'), 3, 'no id, no warm');
});
