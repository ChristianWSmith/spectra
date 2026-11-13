// Tests for lib/replay/frameprobe.js — the ADDITIVE frame-time probe's
// stats accumulator: nearest-rank percentiles, the capped-window
// bookkeeping (what stays whole-session exact vs what becomes
// recent-window), the resume-gap rejection, the empty-session honesty,
// the enabled gate, the reset contract, the console exposure, and the
// raster-vs-DOM split (forced-sync readback sampling: the 1-in-N gate,
// the flush + readback series, the line's additive raster segment and
// the EXACT frame-gap quarantine that keeps the frame series clean).
// Pure stats over an INJECTED clock — no DOM, no canvas, no rAF.
// Run: node --test src/lib/frameprobe.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFrameProbe,
  frameProbe,
  probeEnabled,
  FRAME_PROBE_CAP,
  FRAME_GAP_MAX_MS,
  RASTER_SAMPLE_EVERY,
} from './replay/frameprobe.js';
import { parseHash } from './router.js';

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

test('defaults: 4096-sample window (4097th sample flips windowed on), the 250 ms gap bound and the 1-in-60 raster rate', () => {
  assert.equal(FRAME_PROBE_CAP, 4096);
  assert.equal(FRAME_GAP_MAX_MS, 250);
  assert.equal(RASTER_SAMPLE_EVERY, 60, 'the raster split samples every 60th draw by default');
  assert.equal(createFrameProbe({ now: () => 0 }).rasterEvery, RASTER_SAMPLE_EVERY);
  const p = createFrameProbe({ now: () => 0 });
  for (let i = 1; i <= FRAME_PROBE_CAP + 1; i++) p.recordDraw(i);
  const d = p.summarize().draws;
  assert.equal(d.count, FRAME_PROBE_CAP + 1);
  assert.equal(d.windowed, true); // the oldest sample fell out of the ring
  assert.equal(d.min, 1); // …but the whole-session totals still hold it
  assert.equal(d.max, FRAME_PROBE_CAP + 1);
});

test('probeEnabled: THE ?probe=1 gate — literal "1" on the router-parsed query only', () => {
  // Absent / wrong value / wrong key → never (the HUD must not appear
  // without the param). Values arrive as STRINGS (URLSearchParams).
  assert.equal(probeEnabled(null), false);
  assert.equal(probeEnabled(undefined), false);
  assert.equal(probeEnabled({}), false);
  assert.equal(probeEnabled({ probe: '0' }), false);
  assert.equal(probeEnabled({ probe: 'true' }), false);
  assert.equal(probeEnabled({ probe: 1 }), false);
  assert.equal(probeEnabled({ other: '1' }), false);
  assert.equal(probeEnabled({ probe: '1' }), true);
  // The integration pin: the gate reads the ROUTER's own parseHash
  // query (the one query parser — frameprobe never parses a URL).
  assert.equal(parseHash('#/replay/1?probe=1').query.probe, '1');
  assert.equal(probeEnabled(parseHash('#/replay/1?probe=1').query), true);
  assert.equal(probeEnabled(parseHash('#/replay/1').query), false);
});

test('showHud: the runtime console toggle defaults on and flips without touching collection', () => {
  assert.equal(frameProbe.showHud, true);
  frameProbe.showHud = false;
  assert.equal(frameProbe.showHud, false);
  // Hiding the strip never stops the SAMPLES (App's tick only reads it).
  frameProbe.enabled = true;
  frameProbe.recordDraw(1);
  assert.equal(frameProbe.summarize().draws.count > 0, true);
  frameProbe.showHud = true; // restore the default for anything after
});

// --- the raster-vs-DOM split (forced-sync readback sampling) ----------------
//
// The split's contract: an optional 1-in-`rasterEvery` sampled pair of
// getImageData calls (performed by renderer.js draw()), recorded as TWO
// additive series (flush = forced completion + readback — an UPPER bound
// on raster; readback = the no-pending-work floor — the probe's own
// cost), plus an EXACT quarantine of the one frame gap whose window
// contains the sample. Existing series/line semantics stay untouched:
// without raster samples the line is byte-identical to the old format.

test('raster split: shouldSampleRaster samples every rasterEvery-th enabled draw; 0 disables', () => {
  const p = createFrameProbe({ now: () => 0 });
  p.rasterEvery = 3;
  const hits = [];
  for (let i = 1; i <= 9; i++) hits.push(p.shouldSampleRaster());
  assert.deepEqual(hits, [false, false, true, false, false, true, false, false, true], 'every 3rd call samples');
  // A disabled probe doesn't consume the schedule (re-enabling resumes it).
  p.enabled = false;
  assert.equal(p.shouldSampleRaster(), false, 'disabled → never samples');
  p.enabled = true;
  assert.equal(p.shouldSampleRaster(), false, 'the schedule did not advance while disabled (9 → 10)');
  assert.equal(p.shouldSampleRaster(), false, '10');
  assert.equal(p.shouldSampleRaster(), true, '12 → sample (the disabled call didn’t count)');
  p.rasterEvery = 0;
  assert.equal(p.shouldSampleRaster(), false, 'rasterEvery = 0 disables the split outright');
});

test('raster split: recordRaster records flush + readback and the line gains the raster segment', () => {
  let t = 0;
  const p = createFrameProbe({ now: () => t });
  // No samples → the line is byte-identical to the pre-split format
  // (the exact-string pins above stay green because of exactly this).
  assert.ok(!p.line().includes('raster'), 'no raster samples → no raster segment');
  t = 1000;
  p.recordRaster(4.5, 0.5);
  t = 1010;
  p.recordRaster(6.25, 0.75);
  const s = p.summarize().raster;
  assert.equal(s.flush.count, 2, 'both forced-completion deltas recorded');
  assert.equal(s.flush.max, 6.25, 'whole-session exact like every series');
  assert.equal(s.readback.count, 2, 'the probe’s own readback cost is measured beside them');
  assert.equal(s.readback.p50, 0.5, 'nearest-rank over [0.5, 0.75]');
  assert.equal(s.every, 60, 'the rate rides on the summary');
  assert.equal(s.quarantined, 0, 'nothing quarantined without recordFrame');
  assert.equal(p.summarize().sessionMs, 10, 'the samples extend the session span like any other');
  assert.match(
    p.line(),
    /\| draw n=0 p50=n\/a p95=n\/a p99=n\/a max=n\/a \| raster n=2 p50=4\.5 p95=6\.3 p99=6\.3 max=6\.3 readback p50=0\.5 \| longtasks unsupported \|/,
    'the raster segment sits between draw and longtasks, existing segments untouched',
  );
});

test('raster split: recordFrame quarantines exactly the gap carrying a sample’s forced cost', () => {
  let t = 1000;
  const p = createFrameProbe({ now: () => t });
  p.recordRaster(5, 0.5); // sample at t=1000
  // The next rAF (t=1016, gap 16.7 → window [999.3, 1016] CONTAINS the
  // sample): dropped from `frames`, counted as quarantined — and not as
  // a resume gap (it was a clean frame).
  t = 1016;
  p.recordFrame(16.7);
  let s = p.summarize();
  assert.equal(s.frames.count, 0, 'the contaminated gap is never a frame sample');
  assert.equal(s.raster.quarantined, 1, '…it is counted as quarantined');
  assert.equal(s.gaps, 0, '…and not as a resume gap');
  // The following frame records normally (the quarantine is one-shot).
  t = 1033;
  p.recordFrame(16.7);
  s = p.summarize();
  assert.equal(s.frames.count, 1, 'the next clean gap records');
  assert.equal(s.raster.quarantined, 1, 'only the contaminated one was dropped');
  // A gap that STARTS after the sample (play() reset lastT on a resume)
  // contains none of its cost → records normally.
  p.recordRaster(5, 0.5); // sample at t=1033
  t = 5000;
  p.recordFrame(16.7); // window [4983.3, 5000] — starts long after the sample
  s = p.summarize();
  assert.equal(s.frames.count, 2, 'a post-resume gap is not quarantined');
  assert.equal(s.raster.quarantined, 1, '…the sample’s window has passed');
  // An INVALID gap carrying a sample still lands in `gaps` — it never
  // reaches the series either way, so nothing is double-counted.
  p.recordRaster(5, 0.5);
  t = 5400;
  p.recordFrame(9999); // resume gap — invalid
  s = p.summarize();
  assert.equal(s.gaps, 1, 'the resume gap counts as a gap');
  assert.equal(s.raster.quarantined, 1, '…it was already excluded from frames');
});

test('raster split: a disabled probe records nothing; reset() clears the raster state but keeps the wiring', () => {
  let t = 0;
  const p = createFrameProbe({ now: () => t });
  p.rasterEvery = 1;
  p.enabled = false;
  assert.equal(p.shouldSampleRaster(), false, 'disabled → no sampling');
  p.recordRaster(5, 0.5);
  let s = p.summarize().raster;
  assert.equal(s.flush.count, 0, 'disabled → no raster samples');
  p.enabled = true;
  t = 100;
  p.recordRaster(5, 0.5);
  t = 116;
  p.recordFrame(16.7); // window [99.3, 116] contains the sample → quarantined
  s = p.summarize().raster;
  assert.equal(s.flush.count, 1, 'enabled → sampled');
  assert.equal(s.quarantined, 1, '…and its gap quarantined');
  p.reset();
  s = p.summarize().raster;
  assert.equal(s.flush.count, 0, 'reset clears the flush series');
  assert.equal(s.readback.count, 0, '…the readback series');
  assert.equal(s.quarantined, 0, '…and the quarantine counter');
  assert.equal(p.summarize().frames.count, 0, '…with every other sample');
  assert.equal(p.rasterEvery, 1, 'reset keeps the wiring (the rate survives)');
  assert.equal(p.enabled, true, '…enabled too');
});
