// Tests for lib/replay/frameprobe.js — the ADDITIVE frame-time probe's
// stats accumulator: nearest-rank percentiles, the capped-window
// bookkeeping (what stays whole-session exact vs what becomes
// recent-window), the resume-gap rejection, the empty-session honesty,
// the enabled gate, the reset contract and the console exposure.
// Pure stats over an INJECTED clock — no DOM, no canvas, no rAF.
// Run: node --test src/lib/frameprobe.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFrameProbe,
  frameProbe,
  FRAME_PROBE_CAP,
  FRAME_GAP_MAX_MS,
} from './replay/frameprobe.js';

test('empty session: no samples, nulls (never fabricated zeros), n/a line', () => {
  const p = createFrameProbe({ now: () => 0 });
  const s = p.summarize();
  assert.equal(s.enabled, true);
  assert.equal(s.sessionMs, 0);
  assert.equal(s.gaps, 0);
  for (const series of [s.draws, s.frames]) {
    assert.equal(series.count, 0);
    assert.equal(series.min, null);
    assert.equal(series.mean, null);
    assert.equal(series.p50, null);
    assert.equal(series.p95, null);
    assert.equal(series.p99, null);
    assert.equal(series.max, null);
    assert.equal(series.windowed, false);
  }
  assert.deepEqual(s.longtasks, { supported: false, count: 0, totalMs: 0 });
  assert.equal(
    p.line(),
    'frame n=0 p50=n/a p95=n/a p99=n/a max=n/a' +
      ' | draw n=0 p50=n/a p95=n/a p99=n/a max=n/a' +
      ' | longtasks unsupported | gaps=0 | span=0ms',
  );
});

test('percentiles are nearest-rank exact; count/min/mean/max whole-session exact', () => {
  const p = createFrameProbe({ now: () => 0 });
  for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) p.recordDraw(v);
  const d = p.summarize().draws;
  assert.equal(d.count, 10);
  assert.equal(d.min, 10);
  assert.equal(d.max, 100);
  assert.equal(d.mean, 55);
  assert.equal(d.p50, 50); // ceil(0.5·10) = 5th smallest
  assert.equal(d.p95, 100); // ceil(0.95·10) = 10th
  assert.equal(d.p99, 100); // ceil(0.99·10) = 10th
  assert.equal(d.windowed, false);
});

test('single sample: every percentile collapses to that sample', () => {
  const p = createFrameProbe({ now: () => 0 });
  p.recordDraw(4.25);
  const d = p.summarize().draws;
  assert.equal(d.count, 1);
  assert.equal(d.p50, 4.25);
  assert.equal(d.p95, 4.25);
  assert.equal(d.p99, 4.25);
  assert.equal(d.mean, 4.25);
  assert.equal(d.min, 4.25);
  assert.equal(d.max, 4.25);
});

test('cap: percentiles over the LAST cap samples, totals still whole-session', () => {
  const p = createFrameProbe({ cap: 4, now: () => 0 });
  for (const v of [1, 2, 3, 4, 5, 6]) p.recordDraw(v);
  const d = p.summarize().draws;
  assert.equal(d.count, 6); // whole session…
  assert.equal(d.min, 1); // …min/max/mean are session-wide…
  assert.equal(d.max, 6);
  assert.equal(d.mean, 3.5);
  assert.equal(d.windowed, true); // …percentiles are the window [3,4,5,6]
  assert.equal(d.p50, 4);
  assert.equal(d.p95, 6);
  assert.equal(d.p99, 6);
});

test('cap boundary: exactly cap samples is NOT windowed', () => {
  const p = createFrameProbe({ cap: 4, now: () => 0 });
  for (const v of [1, 2, 3, 4]) p.recordDraw(v);
  const d = p.summarize().draws;
  assert.equal(d.count, 4);
  assert.equal(d.windowed, false);
  assert.equal(d.p50, 2); // nearest-rank over [1,2,3,4]
  assert.equal(d.p95, 4);
});

test('frame cadence: resume gaps beyond the bound are counted, not recorded', () => {
  const p = createFrameProbe({ now: () => 0 });
  p.recordFrame(16.7); // a frame
  p.recordFrame(FRAME_GAP_MAX_MS); // exactly at the bound — still a frame
  p.recordFrame(FRAME_GAP_MAX_MS + 1); // resume gap
  p.recordFrame(-1); // invalid
  p.recordFrame(NaN); // invalid — must never poison the sums
  const s = p.summarize();
  assert.equal(s.frames.count, 2);
  assert.equal(s.frames.max, FRAME_GAP_MAX_MS);
  assert.equal(s.gaps, 3);
});

test('disabled: nothing records, nothing touches the clock; re-enable resumes', () => {
  let t = 1000;
  const p = createFrameProbe({ now: () => t });
  p.enabled = false;
  p.recordDraw(5);
  p.recordFrame(16.7);
  p.recordLongTask(100);
  let s = p.summarize();
  assert.equal(s.enabled, false);
  assert.equal(s.draws.count, 0);
  assert.equal(s.frames.count, 0);
  assert.equal(s.longtasks.count, 0);
  assert.equal(s.gaps, 0);
  assert.equal(s.sessionMs, 0); // the disabled records never touched the clock
  p.enabled = true;
  t = 1005;
  p.recordDraw(1);
  t = 1015;
  p.recordDraw(1);
  s = p.summarize();
  assert.equal(s.draws.count, 2);
  // span starts at the FIRST ENABLED sample — the disabled period left no mark
  assert.equal(s.sessionMs, 10);
});

test('session span: first→last recorded sample; a rejected gap does not extend it', () => {
  let t = 1000;
  const p = createFrameProbe({ now: () => t });
  t = 1000;
  p.recordDraw(2);
  t = 1016;
  p.recordFrame(16.7);
  t = 1032;
  p.recordDraw(4);
  assert.equal(p.summarize().sessionMs, 32);
  t = 5000;
  p.recordFrame(9999); // rejected as a resume gap…
  const s = p.summarize();
  assert.equal(s.gaps, 1);
  assert.equal(s.sessionMs, 32); // …and it never touched the span
});

test('longtask tally: count + total, and the line reports `unsupported` without an observer', () => {
  const p = createFrameProbe({ now: () => 0 });
  p.recordLongTask(120);
  p.recordLongTask(80);
  let s = p.summarize();
  assert.equal(s.longtasks.supported, false); // no observer installed (node/WebKit)
  assert.equal(s.longtasks.count, 2);
  assert.equal(s.longtasks.totalMs, 200);
  assert.match(p.line(), /\| longtasks unsupported \|/);
  // …and the supported spelling once installLongTaskTally has run:
  p.longTaskObserver = {};
  s = p.summarize();
  assert.equal(s.longtasks.supported, true);
  assert.match(p.line(), /\| longtasks n=2 total=200\.0ms \|/);
});

test('reset clears the samples but keeps the wiring (enabled + observer)', () => {
  let t = 1000;
  const p = createFrameProbe({ now: () => t });
  p.longTaskObserver = {};
  p.recordDraw(3);
  t = 1010;
  p.recordFrame(9999); // a gap, so `gaps` has state to clear too
  p.recordLongTask(50);
  assert.equal(p.summarize().gaps, 1);
  p.reset();
  const s = p.summarize();
  assert.equal(s.draws.count, 0);
  assert.equal(s.frames.count, 0);
  assert.equal(s.gaps, 0);
  assert.equal(s.longtasks.count, 0);
  assert.equal(s.longtasks.totalMs, 0);
  assert.equal(s.sessionMs, 0);
  assert.equal(s.enabled, true);
  assert.equal(s.longtasks.supported, true); // the observer survives a reset
});

test('line(): exact one-liner over an injected clock', () => {
  let t = 0;
  const p = createFrameProbe({ now: () => t });
  t = 1000;
  p.recordDraw(2);
  t = 1016;
  p.recordFrame(16.7);
  t = 1032;
  p.recordDraw(4);
  assert.equal(
    p.line(),
    'frame n=1 p50=16.7 p95=16.7 p99=16.7 max=16.7' +
      ' | draw n=2 p50=2.0 p95=4.0 p99=4.0 max=4.0' +
      ' | longtasks unsupported | gaps=0 | span=32ms',
  );
});

test('dump() logs the one-liner and returns it', () => {
  const p = createFrameProbe({ now: () => 0 });
  p.recordDraw(1.25);
  const original = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    const out = p.dump();
    assert.equal(out, p.line());
  } finally {
    console.log = original;
  }
  assert.deepEqual(logged, [p.line()]);
});

test('exposure: the session singleton sits on the console-accessible global', () => {
  assert.equal(globalThis.__spectraFrameProbe, frameProbe);
  assert.equal(frameProbe.enabled, true);
  assert.equal(typeof frameProbe.dump, 'function');
  assert.equal(typeof frameProbe.summarize, 'function');
});

test('defaults: 4096-sample window (4097th sample flips windowed on) and the 250 ms gap bound', () => {
  assert.equal(FRAME_PROBE_CAP, 4096);
  assert.equal(FRAME_GAP_MAX_MS, 250);
  const p = createFrameProbe({ now: () => 0 });
  for (let i = 1; i <= FRAME_PROBE_CAP + 1; i++) p.recordDraw(i);
  const d = p.summarize().draws;
  assert.equal(d.count, FRAME_PROBE_CAP + 1);
  assert.equal(d.windowed, true); // the oldest sample fell out of the ring
  assert.equal(d.min, 1); // …but the whole-session totals still hold it
  assert.equal(d.max, FRAME_PROBE_CAP + 1);
});
