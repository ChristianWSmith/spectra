// Read-through cache tests for services.js (A1): same-args returns the
// same promise instance, different args miss, every data-carrying
// spectra:* event (and the explicit invalidate()/mutating wrappers)
// flush so the next call refetches — spectra:asset-progress being the
// one spectra:* event that does NOT (pure progress, no row changes).
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
