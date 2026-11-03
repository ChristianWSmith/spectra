// Characterization tests for the cross-view hand-off contract (E3): one
// sessionStorage key per hand-off, written by the navigating view and
// read EXACTLY ONCE by the receiving view (read + clear on every read,
// even a failed parse).
//
// Phase 0 pinned the semantics services.js implemented inline
// (setPendingTimelineFilter / takePendingTimelineFilter /
// setPendingSeek / takePendingSeek) before they moved to lib/handoff.js;
// the cases below are unchanged by that move.
// Run: node --test src/lib/handoff.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { HANDOFF_KEYS, setHandoff, takeHandoff } from './handoff.js';

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

test('handoff keys are the published contract strings', () => {
  assert.equal(HANDOFF_KEYS.timelineFilter, 'spectra:timeline-filter');
  assert.equal(HANDOFF_KEYS.replaySeek, 'spectra:replay-seek');
  assert.equal(HANDOFF_KEYS.compareRounds, 'spectra:compare-rounds');
});

test('takeHandoff on an absent key returns null and never throws', () => {
  globalThis.sessionStorage = freshStorage();
  assert.equal(takeHandoff(HANDOFF_KEYS.timelineFilter), null);
});

test('write → read returns the value; the second read is null (read-once)', () => {
  const s = freshStorage();
  globalThis.sessionStorage = s;
  setHandoff(HANDOFF_KEYS.timelineFilter, { steamId: 'x', kind: 'kill' });
  assert.deepEqual(takeHandoff(HANDOFF_KEYS.timelineFilter), {
    steamId: 'x',
    kind: 'kill',
  });
  // cleared: nothing left to read, and the key is gone from storage
  assert.equal(takeHandoff(HANDOFF_KEYS.timelineFilter), null);
  assert.equal(s.size, 0);
});

test('takeHandoff clears even when the payload does not parse', () => {
  const s = freshStorage();
  globalThis.sessionStorage = s;
  s.setItem(HANDOFF_KEYS.replaySeek, '{not json');
  const origError = console.error;
  console.error = () => {}; // the reader logs the parse failure
  try {
    assert.equal(takeHandoff(HANDOFF_KEYS.replaySeek), null);
  } finally {
    console.error = origError;
  }
  assert.equal(s.size, 0); // removed regardless
});

test('setHandoff(key, null) clears without writing a payload', () => {
  const s = freshStorage();
  globalThis.sessionStorage = s;
  setHandoff(HANDOFF_KEYS.replaySeek, { tick: 5 });
  assert.equal(s.size, 1);
  setHandoff(HANDOFF_KEYS.replaySeek, null);
  assert.equal(s.size, 0);
  assert.equal(takeHandoff(HANDOFF_KEYS.replaySeek), null);
});

test('each hand-off key is independent', () => {
  const s = freshStorage();
  globalThis.sessionStorage = s;
  setHandoff(HANDOFF_KEYS.timelineFilter, { round: 3 });
  setHandoff(HANDOFF_KEYS.replaySeek, { tick: 9 });
  assert.deepEqual(takeHandoff(HANDOFF_KEYS.timelineFilter), { round: 3 });
  assert.deepEqual(takeHandoff(HANDOFF_KEYS.replaySeek), { tick: 9 });
  assert.equal(s.size, 0);
});

test('hand-off storage failures: reads yield null, writes throw to the caller', () => {
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
    // read failures never escape — the receiver just sees "nothing pending"
    assert.equal(takeHandoff(HANDOFF_KEYS.timelineFilter), null);
  } finally {
    console.error = origError;
  }
  // write failures surface: services.js's writers swallow+log them, Match's
  // compare picker turns them into its status line.
  assert.throws(() => setHandoff(HANDOFF_KEYS.timelineFilter, { round: 1 }), /denied/);
  assert.throws(() => setHandoff(HANDOFF_KEYS.replaySeek, null), /denied/);
});
