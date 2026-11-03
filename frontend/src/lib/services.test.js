// Characterization tests for the hand-off wrappers services.js exposes
// (T1): the read-once/clear semantics the Timeline/Replay views depend
// on, exercised through the real services.js (which now delegates to
// lib/handoff.js — see handoff.test.js for the primitives). Pinning the
// wrapper behavior here catches a delegation that changes the contract.
// Run: node --test src/lib/services.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

// services.js imports the generated bindings as a directory (Vite
// resolves it, node does not) — see test/esm-dir-hook.mjs.
installEsmDirHook();
const services = await import('./services.js');

// Minimal sessionStorage stand-in — node has no Web Storage.
function freshStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get size() {
      return m.size;
    },
  };
}

test('setPendingTimelineFilter / takePendingTimelineFilter read once', () => {
  const s = freshStorage();
  globalThis.sessionStorage = s;
  services.setPendingTimelineFilter({ steamId: 'x', kind: 'kill' });
  assert.deepEqual(services.takePendingTimelineFilter(), {
    steamId: 'x',
    kind: 'kill',
  });
  assert.equal(services.takePendingTimelineFilter(), null); // cleared
  assert.equal(s.size, 0);
});

test('takePendingTimelineFilter on an absent key returns null', () => {
  globalThis.sessionStorage = freshStorage();
  assert.equal(services.takePendingTimelineFilter(), null);
});

test('setPendingSeek(null) clears a stale seek without writing one', () => {
  const s = freshStorage();
  globalThis.sessionStorage = s;
  services.setPendingSeek({ tick: 42, play: true, voice: true });
  assert.deepEqual(services.takePendingSeek(), { tick: 42, play: true, voice: true });
  services.setPendingSeek(null);
  assert.equal(s.size, 0);
  assert.equal(services.takePendingSeek(), null);
});

test('the two hand-off keys stay independent', () => {
  const s = freshStorage();
  globalThis.sessionStorage = s;
  services.setPendingTimelineFilter({ round: 3 });
  services.setPendingSeek({ tick: 9 });
  assert.deepEqual(services.takePendingTimelineFilter(), { round: 3 });
  assert.deepEqual(services.takePendingSeek(), { tick: 9 });
  assert.equal(s.size, 0);
});

test('a payload that does not parse clears the key and yields null', () => {
  const s = freshStorage();
  globalThis.sessionStorage = s;
  s.setItem('spectra:replay-seek', '{oops');
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(services.takePendingSeek(), null);
  } finally {
    console.error = origError;
  }
  assert.equal(s.size, 0);
});

test('storage failures never escape the wrappers', () => {
  globalThis.sessionStorage = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(services.takePendingSeek(), null);
    assert.equal(services.takePendingTimelineFilter(), null);
    services.setPendingSeek({ tick: 1 }); // swallowed + logged
    services.setPendingTimelineFilter({ round: 1 }); // swallowed + logged
  } finally {
    console.error = origError;
  }
});
