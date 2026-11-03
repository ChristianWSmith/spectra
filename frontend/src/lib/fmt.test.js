// Unit tests for fmt.js — currently the clock formatter added for the
// Utility view's tick display (existing helpers keep their own behavior
// and are covered by the views that use them).
// Run: node --test src/lib/fmt.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtClock, tickSeconds, fmtDuration } from './fmt.js';

test('fmtClock renders m:ss with a zero-padded seconds part', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(45), '0:45');
  assert.equal(fmtClock(44.6), '0:45'); // rounds to the nearest second
  assert.equal(fmtClock(59.4), '0:59');
  assert.equal(fmtClock(60), '1:00');
  assert.equal(fmtClock(154), '2:34');
  assert.equal(fmtClock(599), '9:59');
  assert.equal(fmtClock(600), '10:00');
  assert.equal(fmtClock(659), '10:59');
});

test('fmtClock switches to h:mm:ss from one hour on', () => {
  assert.equal(fmtClock(3600), '1:00:00');
  assert.equal(fmtClock(3661), '1:01:01');
  assert.equal(fmtClock(36000), '10:00:00');
  assert.equal(fmtClock(7384), '2:03:04');
});

test('fmtClock rejects non-finite and negative input', () => {
  assert.equal(fmtClock(NaN), '—');
  assert.equal(fmtClock(Infinity), '—');
  assert.equal(fmtClock(-1), '—');
  assert.equal(fmtClock(undefined), '—');
});

test('fmtClock composes with tickSeconds at the match tickrate', () => {
  // 128 tick: 19200 ticks = 150 s → 2:30.
  assert.equal(fmtClock(tickSeconds(19200, 128)), '2:30');
  // Unknown/invalid tickrate falls back to 64 (tickSeconds contract).
  assert.equal(fmtClock(tickSeconds(64, 0)), '0:01');
});

test('existing duration formatting is untouched', () => {
  assert.equal(fmtDuration(35 * 60 + 39), '35m39s');
  assert.equal(fmtDuration(42), '42s');
});
