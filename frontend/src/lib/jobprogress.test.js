// Job-progress store lifecycle (services.js): subscribeJobProgress
// delivers the CURRENT snapshot immediately, then every spectra:job-
// progress payload keyed by jobId, drops an entry when spectra:job-done
// announces the outcome, and stops delivering after unsubscribe. The
// Library's chips read this snapshot (jobView falls back to the jobs row
// when no live point arrived), so the lifecycle is the contract behind
// every determinate bar.
// Run: node --test src/lib/jobprogress.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

installEsmDirHook();

// Same redirection as services-cache.test.js: the real bindings/event bus
// only exist inside a live Wails app; the stubs are per-process.
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const services = await import('./services.js');
const { fire } = await import('../../test/stubs/wails-runtime.mjs');

test('subscribeJobProgress: immediate snapshot → live points → job-done cleanup → unsubscribe', () => {
  const seen = [];
  const off = services.subscribeJobProgress((snap) => seen.push(snap));

  // Immediate delivery of the current snapshot (empty on a fresh module).
  assert.equal(seen.length, 1, 'subscriber called on registration');
  assert.ok(seen[0] instanceof Map, 'payload is a Map keyed by jobId');
  assert.equal(seen[0].size, 0, 'fresh store is empty');

  // Two live jobs accumulate.
  fire('spectra:job-progress', { jobId: 7, stage: 'parse', progress: 0.42, matchId: 3 });
  assert.equal(seen.length, 2, 'one snapshot per progress event');
  assert.deepEqual(seen[1].get(7), { jobId: 7, stage: 'parse', progress: 0.42, matchId: 3 });
  fire('spectra:job-progress', { jobId: 8, stage: 'hash', progress: 0.05, matchId: 0 });
  assert.equal(seen[2].size, 2, 'both jobs tracked');
  assert.equal(seen[2].get(8).stage, 'hash');

  // job-done removes only its own job (the other one keeps its bar).
  fire('spectra:job-done', { jobId: 7, matchId: 3, status: 'done', error: '' });
  assert.equal(seen[3].size, 1, 'finished job dropped');
  assert.equal(seen[3].has(7), false);
  assert.equal(seen[3].has(8), true);

  // Unsubscribe stops delivery (the $effect cleanup path).
  off();
  fire('spectra:job-progress', { jobId: 9, stage: 'store', progress: 0.9, matchId: 3 });
  assert.equal(seen.length, 4, 'no snapshot after unsubscribe');
});
