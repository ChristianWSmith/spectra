// Tests for lib/replay/engine.js — the FIRST tests to PUMP the rAF
// playback loop (renderer.test.js stubs requestAnimationFrame to a no-op,
// so loop() has never run there): the freeze auto-skip hook (skipFreeze →
// rounds.freezeWindowAt — jump the pre-round freeze during playback) and
// the loop-exit guard shared by seekTick/seekFrame (a seek landing
// outside the armed range cancels it, bounds retained).
// Run: node --test src/lib/engine.test.js   (from frontend/)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine, parsePositions } from './replay/engine.js';
import { freezeWindowAt } from './rounds.js';

// --- headless clock --------------------------------------------------------
// loop(now) is rAF-driven and seeds lastT from performance.now(): capture
// the queued callback and VIRTUALIZE the clock so every dt is exact — a
// real clock would make the freeze/loop boundary arithmetic depend on how
// long the test process happens to take.
let queued = null;
let nowMs = 0;
globalThis.requestAnimationFrame = (cb) => {
  queued = cb;
  return 1;
};
globalThis.cancelAnimationFrame = () => {
  queued = null;
};
Object.defineProperty(performance, 'now', {
  value: () => nowMs,
  configurable: true,
  writable: true,
});
after(() => {
  delete performance.now; // back to the prototype method
});

// pump runs exactly ONE frame: advance the virtual clock by dtMs and hand
// the queued callback the new timestamp (what a browser does per vsync).
function pump(dtMs = 250) {
  const cb = queued;
  assert.ok(cb, 'a frame must be scheduled while playing');
  queued = null;
  nowMs += dtMs;
  cb(nowMs);
}

// synth builds a real position store through the engine's OWN parser:
// one 6-byte frame header (int32 tick + uint16 mask = 0 — no players
// alive), so the store shape is exactly what the sidecar yields.
function synth(ticks) {
  const buf = new ArrayBuffer(ticks.length * 6);
  const dv = new DataView(buf);
  ticks.forEach((t, i) => {
    dv.setInt32(i * 6, t, true);
    dv.setUint16(i * 6 + 4, 0, true);
  });
  return parsePositions(buf, 0);
}

// 64 frames at the 64-tick rate → ticks 0 … 4032. F maps a frame tick to
// its index (loop bounds are frames, not ticks).
const TICKS = Array.from({ length: 64 }, (_, i) => i * 64);
const F = (tick) => TICKS.indexOf(tick);

// Two real freeze windows whose ends do NOT sit on a frame tick (700 / 2300
// fall between 640/704 and 2240/2304) — that is what pins "lands on the
// FIRST frame at/after freezeEndTick". The warmup row ships fe = 0 (no
// window); round 1's endTick leaves the round-over GAP that must NOT be
// skipped (it is not a freeze).
const ROUNDS = [
  { number: -1, startTick: 128, freezeEndTick: 0, warmup: true, pregame: false },
  { number: 1, startTick: 512, freezeEndTick: 700, endTick: 1984, warmup: false, pregame: false },
  { number: 2, startTick: 2048, freezeEndTick: 2300, endTick: 4000, warmup: false, pregame: false },
];

function fresh(rounds = ROUNDS) {
  queued = null;
  nowMs = 0;
  const e = createEngine(synth(TICKS), 64);
  e.setRounds(rounds);
  return e;
}

// playFrom seeks to `tick`, starts playback and pumps frames of dtMs until
// the loop stops scheduling (end of stream) or `pumps` runs out, recording
// every state.tick the engine reports.
function playFrom(e, tick, { pumps = 400, dtMs = 250 } = {}) {
  e.seekTick(tick);
  const seen = [e.state.tick];
  e.play();
  for (let i = 0; i < pumps && queued; i++) {
    pump(dtMs);
    seen.push(e.state.tick);
  }
  return seen;
}

// distinct collapses consecutive repeats: the ticks the viewer actually
// SAW (state.tick holds a frame for several pumps at a time).
const distinct = (a) => a.filter((t, i) => i === 0 || t !== a[i - 1]);

function assertMonotone(d) {
  for (let i = 1; i < d.length; i++) {
    assert.ok(d[i] >= d[i - 1], `playhead went backwards: ${d[i - 1]} → ${d[i]}`);
  }
}

// crossings: every transition INTO [fe, …) (the landing tick after a
// skip) and back BELOW fe (an oscillation — must never happen).
function crossings(d, fe) {
  const into = [];
  const back = [];
  for (let i = 1; i < d.length; i++) {
    if (d[i] >= fe && d[i - 1] < fe) into.push(d[i]);
    if (d[i] < fe && d[i - 1] >= fe) back.push(d[i]);
  }
  return { into, back };
}

// (1) default OFF — the freeze plays through, frame by frame.
test('skipFreeze defaults OFF: crossing a freeze boundary advances through it', () => {
  const e = fresh();
  assert.equal(e.state.skipFreeze, false, 'the skip is opt-in');
  const d = distinct(playFrom(e, 384));
  // Every frame of round 1's freeze (512 ≤ t < 700) is DISPLAYED.
  for (const t of [512, 576, 640]) {
    assert.ok(freezeWindowAt(ROUNDS, t), `tick ${t} must be inside a window`);
    assert.ok(d.includes(t), `tick ${t} is shown — no jump with the skip off`);
  }
  assert.ok(d.includes(704), 'playback continues past the freeze');
  assertMonotone(d);
  e.pause();
});

// (2) ON — the crossing lands on the FIRST frame at/after freezeEndTick,
// exactly once per crossing, monotone (no oscillation back in).
test('skipFreeze ON: each crossing lands on the first frame ≥ freezeEndTick, once', () => {
  const e = fresh();
  e.setSkipFreeze(true);
  assert.equal(e.state.skipFreeze, true);
  const d = distinct(playFrom(e, 384));
  assertMonotone(d);
  // Round 1: [512, 700) → the landing is 704 (the first frame ≥ 700).
  const r1 = crossings(d, 700);
  assert.deepEqual(r1.into, [704], 'exactly one skip, landing on the first frame ≥ fe');
  assert.deepEqual(r1.back, [], 'the playhead never re-enters the freeze it left');
  // Round 2: [2048, 2300) → the landing is 2304.
  const r2 = crossings(d, 2300);
  assert.deepEqual(r2.into, [2304], 'the second crossing skips too');
  assert.deepEqual(r2.back, [], 'no oscillation there either');
  // Interior frames of both freezes are never shown…
  for (const t of [576, 640, 2112, 2176, 2240]) {
    assert.ok(!d.includes(t), `freeze frame ${t} must be skipped`);
  }
  // …while the round-over GAP (endTick → next startTick) is not a window
  // and plays through untouched.
  assert.ok(d.includes(1984) && d.includes(2048), 'the round-over gap is NOT skipped');
  e.pause();
});

// (3) data-driven: rows without a usable window are never skipped.
test('skipFreeze never fires on a warmup (fe = 0) or a corrupt window (fe ≤ start)', () => {
  const rounds = [
    { number: -1, startTick: 128, freezeEndTick: 0, warmup: true }, // warmup ships fe = 0
    { number: 1, startTick: 384, freezeEndTick: 300 }, // corrupt: fe ≤ start
  ];
  const e = fresh(rounds);
  e.setSkipFreeze(true);
  const d = distinct(playFrom(e, 0));
  assert.equal(d.length, TICKS.length, 'every frame is shown — nothing to skip');
  for (let i = 1; i < d.length; i++) {
    assert.equal(d[i] - d[i - 1], 64, `frame jumped from ${d[i - 1]} to ${d[i]}`);
  }
  e.pause();
});

// (4) the skip fires on PLAYBACK advance only — a paused scrub/step
// inspects a freeze freely; pressing play inside one skips at once.
test('paused seeks inspect a freeze freely; play inside one skips on the first frame', () => {
  const e = fresh();
  e.setSkipFreeze(true);
  e.seekTick(512); // the freeze's own start tick — paused
  assert.equal(e.state.tick, 512, 'a paused seek never jumps');
  e.seekTick(640); // deep inside the freeze — still paused
  assert.equal(e.state.tick, 640, 'still no jump while paused');
  e.seekFrame(F(576));
  assert.equal(e.state.tick, 576, 'a paused frame step inspects the freeze too');
  e.play();
  pump(250); // the first PLAYBACK frame, still inside [512, 700)
  assert.equal(e.state.tick, 704, 'play inside a freeze → jump to freezeEndTick immediately');
  e.pause();
});

// (5) at 8× one pump crosses the boundary in a single 128-tick leap: the
// skip is a SEEK to freezeEndTick, never a stepped walk through it.
test('at 8× one frame is ONE jump to freezeEndTick (a seek, not a step)', () => {
  const e = fresh();
  e.setSkipFreeze(true);
  e.setSpeed(8);
  e.seekTick(448);
  e.play();
  let emits = 0;
  const off = e.onChange(() => emits++);
  pump(250); // 448 + 64 × 0.25 × 8 = 576 → inside round 1's freeze
  off();
  assert.equal(e.state.tick, 704, 'one pump lands on the first frame at/after freezeEndTick');
  assert.equal(emits, 1, 'exactly one engine change per pump — a single seek');
  e.pause();
});

// (6a) skip yields to an ARMED LOOP whose range ends inside the freeze:
// the skip target would sit past loopTo (the loop could never wrap), so
// the freeze plays out and the wrap wins.
test('a loop ending inside a freeze suppresses the skip and still wraps', () => {
  const e = fresh();
  e.setSkipFreeze(true);
  e.setLoop(F(384), F(640)); // loopTo = 640, INSIDE [512, 700)
  e.setLoopEnabled(true);
  const d = distinct(playFrom(e, 384, { pumps: 60 }));
  assert.ok(!d.includes(704), 'skip suppressed — its target frame is past loopTo');
  assert.ok(d.includes(576) && d.includes(640), 'the freeze plays out up to loopTo');
  assert.ok(
    d.some((t, i) => i > 0 && t < d[i - 1]),
    'the wrap still fires',
  );
  assert.equal(e.state.loopEnabled, true, 'the loop stays armed');
  e.pause();
});

// (6b) a round-span loop (start → end, fe < loopTo) skips EVERY cycle —
// and the skip never cancels the loop it runs inside.
test('a round-span loop skips its freeze every cycle and stays armed', () => {
  const e = fresh();
  e.setSkipFreeze(true);
  e.setLoop(F(512), F(1984)); // round 1: start → end
  e.setLoopEnabled(true);
  const d = distinct(playFrom(e, 512, { pumps: 400 }));
  const wrapIdx = d.map((t, i) => (i > 0 && t < d[i - 1] ? i : -1)).filter((i) => i >= 0);
  assert.ok(wrapIdx.length >= 3, `at least three cycles, got ${wrapIdx.length}`);
  for (const i of wrapIdx) {
    assert.equal(d[i], 704, 'every cycle lands its skip on freezeEndTick');
  }
  for (const t of [576, 640]) {
    assert.ok(!d.includes(t), `freeze frame ${t} is never shown`);
  }
  assert.equal(e.state.loopEnabled, true, 'the skip never cancels the loop');
  e.pause();
});

// (7) the loop-exit guard: one shared rule at the end of BOTH seeks.
test('a seek landing outside the armed loop cancels it — bounds retained, ends inclusive', () => {
  const e = fresh();
  const from = F(512);
  const to = F(1024);
  e.setLoop(from, to);
  e.setLoopEnabled(true);

  // Inclusive boundaries: landing exactly on from/to keeps the loop
  // (the wrap's own test is `tickF > to`).
  e.seekTick(512);
  assert.equal(e.state.loopEnabled, true, 'landing on loopFrom keeps it');
  e.seekTick(1024);
  assert.equal(e.state.loopEnabled, true, 'landing on loopTo keeps it');

  // Past either bound → cancelled, BOUNDS RETAINED for a one-click re-arm.
  e.seekTick(2048);
  assert.equal(e.state.loopEnabled, false, 'a seek past loopTo cancels');
  assert.equal(e.state.loopFrom, from, 'loopFrom retained');
  assert.equal(e.state.loopTo, to, 'loopTo retained');

  e.setLoopEnabled(true); // re-arm
  e.seekTick(128); // before loopFrom
  assert.equal(e.state.loopEnabled, false, 'a seek before loopFrom cancels too');

  // The scrubber / keyboard-step path (seekFrame): inside keeps it, and a
  // step ACROSS a bound cancels.
  e.setLoop(from, to);
  e.setLoopEnabled(true);
  e.seekFrame(to); // the exact to-frame
  assert.equal(e.state.loopEnabled, true, 'landing exactly on loopTo keeps it');
  e.step(1); // one frame past loopTo
  assert.equal(e.state.loopEnabled, false, 'step across the bound cancels');
});

// (7, cont.) the direct-tickF writers are exempt BY CONSTRUCTION: the rAF
// wrap, the end clamp and the armed play() restart never consult the guard.
test('the rAF wrap and the armed play() restart do NOT cancel the loop', () => {
  const e = fresh();
  e.setLoop(F(512), F(1024));
  e.setLoopEnabled(true);
  const d = distinct(playFrom(e, 512, { pumps: 80 })); // seek lands ON loopFrom
  assert.ok(
    d.some((t, i) => i > 0 && t < d[i - 1]),
    'the wrap fired (tickF written directly in loop())',
  );
  assert.equal(e.state.loopEnabled, true, 'a wrap past loopTo does NOT cancel');
  e.pause();

  // Armed play() restart: parked on the LAST frame with loopTo = the last
  // frame, play() jumps back to loopFrom — in range, no guard, no cancel.
  const e2 = fresh();
  const last = TICKS.length - 1;
  e2.setLoop(last - 5, last);
  e2.setLoopEnabled(true);
  e2.seekFrame(last); // exact boundary landing → stays armed
  assert.equal(e2.state.loopEnabled, true, 'the boundary landing keeps it');
  e2.play();
  assert.equal(e2.state.tick, TICKS[last - 5], 'play() restarts at loopFrom');
  assert.equal(e2.state.loopEnabled, true, 'the armed restart does NOT cancel');
  e2.pause();

  // Entry seeks run BEFORE ?loop= arms (Replay's startEngine order), so an
  // out-of-range landing before arming cancels nothing.
  const e3 = fresh();
  e3.seekTick(4000);
  e3.setLoop(F(512), F(1024));
  e3.setLoopEnabled(true);
  assert.equal(e3.state.loopEnabled, true, 'arming after an out-of-range seek keeps the loop');
});
