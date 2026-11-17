// Tests for lib/workstate.svelte.js — the background-work aggregate
// behind the floating bottom-right indicator: the visibility rule
// (visible ⇔ some source active ∧ not dismissed, plus the held-error
// override), the per-source refcount of runWork, dismissal, the new-
// source re-show, the last-idle hide + dismissal reset, the ~400 ms
// settle window, the held failure line (never hidden), and the
// determinate-vs-indeterminate aggregation for the chip.
// Run: node --test src/lib/workstate.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

installEsmDirHook();

// Same redirection as jobprogress.test.js: the real bindings/event bus
// only exist inside a live Wails app; the stubs are per-process.
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const work = await import('./workstate.svelte.js');
const services = await import('./services.js');
const { fire } = await import('../../test/stubs/wails-runtime.mjs');
const bindings = await import('../../test/stubs/bindings.mjs');

const SETTLE = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One subscriber for the whole file — the latest snapshot is the read.
let last = null;
work.subscribeWork((s) => (last = s));

// Every test starts from a clean slate (the wire stays — idempotent).
// The stores in services.js are PROCESS-scoped like the real event bus —
// a job/metric/analysis entry a previous test left behind would keep its
// source active, so each test first drives those stores to empty through
// the same events the backend would send.
test.beforeEach(() => {
  for (const jobId of [1, 2, 3]) fire('spectra:job-done', { jobId });
  fire('spectra:metric-done');
  fire('spectra:analysis-done', { matchId: 5, error: '' });
  work.resetWorkState();
  bindings.resetCalls();
  // The bindings stub only implements the methods other suites use;
  // listDemoFiles scripts itself directly on the namespace object.
  bindings.LibraryService.ListDemoFiles = async () => [];
  bindings.handlers.ExtractMapPacks = async () => ({ maps: ['de_mirage'], errors: [] });
  bindings.handlers.ExtractIcons = async () => ({ count: 120, note: '' });
  bindings.handlers.ExtractSounds = async () => ({ count: 45, note: '' });
});

test('hidden at rest; a job-progress turns the pill on with its determinate point', () => {
  assert.equal(last.visible, false, 'fresh state is hidden');
  fire('spectra:job-progress', { jobId: 1, stage: 'parse', progress: 0.42 });
  assert.equal(last.visible, true, 'active work shows the pill');
  assert.equal(last.status, 'running');
  assert.equal(last.progress, 0.42, 'the single live job drives the chip');
  assert.equal(last.stage, 'parse');
  assert.equal(last.error, '');
});

test('determinate aggregation: one entry only — a second job or another source falls back to indeterminate', () => {
  fire('spectra:job-progress', { jobId: 1, stage: 'parse', progress: 0.42 });
  assert.equal(last.progress, 0.42);
  fire('spectra:job-progress', { jobId: 2, stage: 'store', progress: 0.9 });
  assert.equal(last.visible, true, 'two jobs still show the pill');
  assert.equal(last.progress, 0, 'two determinate entries → indeterminate, no invented aggregate');
  fire('spectra:job-done', { jobId: 2 });
  assert.equal(last.progress, 0.42, 'back to the single live job');
  // A metric sweep beside the job also makes it two active sources.
  fire('spectra:metric-progress', { metricId: 'm1', stage: 'compute', done: 1, total: 4 });
  assert.equal(last.progress, 0, 'jobs + metrics → indeterminate');
  fire('spectra:metric-done');
  assert.equal(last.progress, 0.42, 'metrics finished → the job’s point again');
  fire('spectra:job-done', { jobId: 1 });
});

test('runWork refcounts concurrent same-source runs (busy until the LAST one settles)', async () => {
  let releaseA, releaseB;
  const a = work.runWork('scan', new Promise((r) => (releaseA = r)));
  const b = work.runWork('scan', new Promise((r) => (releaseB = r)));
  assert.equal(last.visible, true);
  releaseA();
  await a;
  assert.equal(last.visible, true, 'one run still going — no flicker off');
  releaseB();
  await b;
  assert.equal(last.visible, true, 'still inside the settle window');
  await sleep(SETTLE + 50);
  assert.equal(last.visible, false, 'all runs done → hides after the settle window');
});

test('dismiss hides while work continues; same-source updates never re-show it', () => {
  fire('spectra:job-progress', { jobId: 1, stage: 'parse', progress: 0.1 });
  work.dismissWork();
  assert.equal(last.visible, false, 'the ✕ hides the pill');
  fire('spectra:job-progress', { jobId: 1, stage: 'parse', progress: 0.5 });
  fire('spectra:job-progress', { jobId: 2, stage: 'store', progress: 0.2 });
  assert.equal(last.visible, false, 'jobs are the same source — no re-show while it never went idle');
});

test('a NEW source starting re-shows a dismissed pill', () => {
  fire('spectra:job-progress', { jobId: 1, stage: 'parse', progress: 0.1 });
  work.dismissWork();
  assert.equal(last.visible, false);
  work.runWork('heatmap', new Promise(() => {})); // stays open for the rest of the test
  assert.equal(last.visible, true, 'heatmap’s idle→busy transition clears the dismissal (Q3)');
});

test('last-idle hides after the settle window AND resets dismissal so the next start shows fresh', async () => {
  fire('spectra:job-progress', { jobId: 1, stage: 'parse', progress: 0.1 });
  fire('spectra:job-done', { jobId: 1 });
  assert.equal(last.visible, true, 'hide is deferred by the settle window (Q4)');
  await sleep(SETTLE + 50);
  assert.equal(last.visible, false, 'the aggregate stayed empty → hidden');
  // Dismissal was reset by the hide: the next source start shows again,
  // even though this test dismissed nothing — the reset is for a pill
  // that WAS dismissed mid-run; prove both halves.
  fire('spectra:job-progress', { jobId: 2, stage: 'parse', progress: 0.1 });
  assert.equal(last.visible, true, 'a fresh run shows');
  work.dismissWork();
  fire('spectra:job-done', { jobId: 2 }); // dismissed + last idle
  await sleep(SETTLE + 50);
  assert.equal(last.visible, false, 'hidden regardless of the dismissal');
  fire('spectra:job-progress', { jobId: 3, stage: 'parse', progress: 0.1 });
  assert.equal(last.visible, true, 'dismissed flag reset at hide — the next start shows fresh (Q3)');
  fire('spectra:job-done', { jobId: 3 });
});

test('activity during the settle window keeps the pill up (the window restarts on the new empty span)', async () => {
  fire('spectra:job-progress', { jobId: 1, stage: 'parse', progress: 0.1 });
  fire('spectra:job-done', { jobId: 1 });
  await sleep(200);
  fire('spectra:job-progress', { jobId: 2, stage: 'parse', progress: 0.2 });
  await sleep(SETTLE - 100); // 300 ms since the hide was scheduled — it must not have fired
  assert.equal(last.visible, true, 'the pending hide was cancelled by the new activity');
  fire('spectra:job-done', { jobId: 2 });
  await sleep(SETTLE + 50);
  assert.equal(last.visible, false, 'then hides for the new empty span');
});

test('a held error keeps the pill visible past the settle window; the ✕ dismisses it', async () => {
  work.reportWorkError('icons: VPK unreadable.');
  assert.equal(last.visible, true, 'a failure re-shows / shows the pill');
  assert.equal(last.status, 'failed');
  assert.equal(last.error, 'icons: VPK unreadable.');
  assert.equal(last.progress, null, 'the failed chip carries no bar');
  await sleep(SETTLE + 50);
  assert.equal(last.visible, true, 'never hidden while the failure is undismissed (Q2)');
  work.dismissWork();
  assert.equal(last.visible, false, 'the ✕ is the dismissal');
  assert.equal(last.error, '', 'dismissing drops the held message');
  await sleep(SETTLE + 50);
  assert.equal(last.visible, false);
});

test('a later failure supersedes the held message', () => {
  work.reportWorkError('first failure');
  work.reportWorkError('second failure');
  assert.equal(last.error, 'second failure');
  assert.equal(last.visible, true);
});

test('runWork reports a rejection as the held error line and rethrows for the caller', async () => {
  const p = work.runWork('scan', Promise.reject(new Error('scan exploded')));
  await assert.rejects(() => p, /scan exploded/);
  assert.equal(last.status, 'failed');
  assert.equal(last.error, 'scan exploded', 'the rejection reaches the pill (Q2)');
  assert.equal(last.visible, true);
  await sleep(SETTLE + 50);
  assert.equal(last.visible, true, 'the error holds past the settle window');
});

test('the services wrappers are wired: listDemoFiles is a wrapped scan source', async () => {
  let release;
  bindings.LibraryService.ListDemoFiles = () => new Promise((r) => (release = () => r([{ path: '/x.dem' }])));
  const p = services.listDemoFiles();
  assert.equal(last.visible, true, 'the call marks scan busy');
  release();
  await p;
  assert.equal(last.visible, true, 'settling, not gone');
  await sleep(SETTLE + 50);
  assert.equal(last.visible, false, 'scan complete → settles out');
});

test('the asset funnel wires through: extractAllAssets holds its aggregated failure on the pill', async () => {
  bindings.handlers.ExtractMapPacks = async () => {
    throw new Error('vpk open failed');
  };
  bindings.handlers.ExtractIcons = async () => ({ count: 3, note: '' });
  bindings.handlers.ExtractSounds = async () => ({ count: 5, note: '' });
  const { extractAllAssets } = await import('./assets.js');
  const out = await extractAllAssets({ dir: '/games/cs2' });
  assert.equal(out.error, 'map packs: vpk open failed.', 'assets.js still aggregates as before');
  assert.equal(last.error, 'map packs: vpk open failed.', 'the aggregated failure rides the pill (Q2)');
  assert.equal(last.status, 'failed');
  assert.equal(last.visible, true);
  await sleep(SETTLE + 50);
  assert.equal(last.visible, true, 'a partial-extraction failure is never hidden');
});

test('analysis rides its events: a run shows, the last member completion settles out', async () => {
  fire('spectra:analysis-progress', { matchId: 5, stage: 'analyze', done: 0, total: 0 });
  assert.equal(last.visible, true);
  assert.equal(last.progress, 0, 'analysis is indeterminate (no honest fraction)');
  fire('spectra:analysis-done', { matchId: 5, error: '' });
  assert.equal(last.visible, true, 'inside the settle window');
  await sleep(SETTLE + 50);
  assert.equal(last.visible, false, 'the run is over → hidden');
});

test('resetWorkState wipes everything (the cross-test isolation hook)', () => {
  fire('spectra:job-progress', { jobId: 1, stage: 'parse', progress: 0.3 });
  work.reportWorkError('stale');
  work.resetWorkState();
  assert.equal(last.visible, false);
  assert.equal(last.error, '');
  assert.equal(last.status, 'running');
});
