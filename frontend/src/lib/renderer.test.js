// Tests for the replay renderer's PURE helpers (lib/replay/renderer.js):
// the trail-continuity rule (trailConnects — the break that keeps player
// movement trails from streaking across a round reset or a
// death→respawn teleport), the smart camera's fit/ease (smartCamTarget,
// easeValue, camConverged), the world-layer geometry (chevronPath,
// crossPath, muzzleRays), the tick-window effects (windowAlpha,
// blindAlpha, voiceBloom, fireJump), the death-marker lifetime
// (killEndTick) — plus end-to-end draws over a recording 2D context
// (the world layers follow the tick: lingering smoke/fire, the death
// X's round cleanup incl. the post-round C4 kill and the EXACT
// round_start boundary seek, the C4 icon and its aspect-preserving
// draw, the WHITE dashed muzzle tracer (r+2 → r+38, dash phase advanced
// from the tick), the LIGHTER flash overlay (peak 0.6, never solid
// white) and the white talking bloom drawn BENEATH its dot, the
// death-X-under-C4 layer order, the carried-C4 badge on the carrier's
// dot and the thrower-side tint of the util flight line + icon, the
// thrower-team tint of the lingering smoke area + its detonation bloom
// ring (neutral gray when the thrower is unknown); a
// crouch-size check; and the
// HUD — the SCORE-ANCHORED team-score box (the '‹ct› – ‹t›' segment
// dead-center of the box, unequal name widths padding the shorter side,
// CT/T names in their side colors, white score), the team-side pairing
// rule (hudTeamNames — the ct slot holds the team on CT at the playhead),
// the codicon freeze clock (document.fonts.check stubbed both ways), the
// C4/0:00 clock, the tick/frame-free playback readout — plus the
// round-scoped kill feed with its rounded entry boxes, 12 px weapon-mark
// margins and the 22 px entry pitch).
// Run: node --test src/lib/renderer.test.js (from frontend/; the lib test
// glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  trailConnects,
  smartCamTarget,
  easeValue,
  camConverged,
  chevronPath,
  crossPath,
  muzzleRays,
  windowAlpha,
  blindAlpha,
  voiceBloom,
  fireJump,
  killEndTick,
  scoreLineWidth,
  scoreLineLayout,
  hudTeamNames,
  createRenderer,
} from './replay/renderer.js';
import { createEngine } from './replay/engine.js';
import { normalizeEvent } from './replay/landmarks.js';
import { buildStateIndex } from './replay/state.js';

// slotPos builds one slot's interleaved Float32Array [x, y, z, yaw] from
// a list of per-frame world positions.
function slotPos(points) {
  const a = new Float32Array(points.length * 4);
  points.forEach(([x, y], i) => {
    a[i * 4] = x;
    a[i * 4 + 1] = y;
  });
  return a;
}

test('contiguous human-speed frames connect (the normal trail)', () => {
  const ticks = [0, 1, 2, 3];
  const pos = slotPos([
    [0, 0],
    [4, 0],
    [8, 1],
    [12, 2],
  ]);
  assert.equal(trailConnects(ticks, pos, 0), true);
  assert.equal(trailConnects(ticks, pos, 1), true);
  assert.equal(trailConnects(ticks, pos, 2), true);
});

test('a teleport (round reset / respawn) breaks the trail', () => {
  const ticks = [0, 1, 2, 3];
  // frames 0-1 near the old position; frames 2-3 across the map (the
  // round reset put the player back at spawn between f1 and f2).
  const pos = slotPos([
    [100, 100],
    [104, 100],
    [1600, -900],
    [1604, -900],
  ]);
  assert.equal(trailConnects(ticks, pos, 0), true); // inside the old round
  assert.equal(trailConnects(ticks, pos, 1), false); // the reset boundary
  assert.equal(trailConnects(ticks, pos, 2), true); // fresh from spawn
});

test('a stalled tick gap breaks the trail', () => {
  const ticks = [0, 1, 2, 20];
  const pos = slotPos([
    [0, 0],
    [4, 0],
    [8, 0],
    [12, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, 1), true); // gap of 1 tick
  assert.equal(trailConnects(ticks, pos, 2), false); // gap of 18 ticks
});

test('a non-advancing tick never connects', () => {
  const ticks = [0, 0, 1];
  const pos = slotPos([
    [0, 0],
    [4, 0],
    [8, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, 0), false);
});

test('the step threshold is generous to movement, not to teleports', () => {
  const ticks = [0, 1, 2];
  const near = slotPos([
    [0, 0],
    [256, 0],
    [512, 0],
  ]);
  assert.equal(trailConnects(ticks, near, 0), true);
  const far = slotPos([
    [0, 0],
    [257, 0],
    [514, 0],
  ]);
  assert.equal(trailConnects(ticks, far, 0), false);
});

test('the segment off either end of the window does not connect', () => {
  const ticks = [0, 1];
  const pos = slotPos([
    [0, 0],
    [4, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, -1), false);
  assert.equal(trailConnects(ticks, pos, 1), false); // f+1 past the end
});

// --- smart camera (the default camera mode) ---------------------------------

test('smartCamTarget fits the box + margin into the canvas', () => {
  // 100x50 box at (0,0)-(100,50), 800x600 canvas, 50px margin: the
  // horizontal fit is exactly the available width (800 - 2*50).
  const t = smartCamTarget({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 800, 600, {
    margin: 50,
    maxZoom: 10, // widen the band so the raw fit (7x) is observable
  });
  assert.equal(t.s, 7); // 700px of box in 700px of available width
  assert.equal(t.cx, 50); // box center
  assert.equal(t.cy, 25);
  // On screen: the padded box (box ± margin) covers the canvas width.
  const boxW = 100 * t.s;
  assert.ok(boxW <= 800 - 2 * 50 + 1e-9);
});

test('smartCamTarget clamps to the zoom band (never tunnel-vision, never off-map)', () => {
  // A single point → the max-zoom cap (4), not infinity.
  const tight = smartCamTarget({ minX: 400, minY: 400, maxX: 400, maxY: 400 }, 800, 600, {});
  assert.equal(tight.s, 4);
  // A full-map spread → the min-zoom floor (0.08), below the manual
  // ZOOM_MIN on purpose: on-screen beats tight.
  const wide = smartCamTarget({ minX: 0, minY: 0, maxX: 10000, maxY: 10000 }, 800, 600, {});
  assert.equal(wide.s, 0.08);
});

test('smartCamTarget clamps the center into the image extent', () => {
  // A tiny box near the left edge: the view (400px at zoom 4 = 50 img px
  // half-width) must not show void left of the image — cx pins to halfW.
  const t = smartCamTarget({ minX: 0, minY: 400, maxX: 10, maxY: 410 }, 400, 300, {
    extW: 1024,
    extH: 1024,
  });
  assert.equal(t.s, 4);
  assert.equal(t.cx, 400 / (2 * 4)); // 50 — clamped to the left edge
  assert.equal(t.cy, 405); // fits vertically, stays on the box
  // A view WIDER than the image centers on the image instead (the
  // entities are inside it either way).
  const big = smartCamTarget({ minX: 500, minY: 500, maxX: 510, maxY: 510 }, 6000, 6000, {
    extW: 1024,
    extH: 1024,
  });
  assert.equal(big.s, 4); // zoom cap
  assert.equal(big.cx, 1024 / 2); // view (1500) wider than the image → centered
  assert.equal(big.cy, 1024 / 2);
});

test('easeValue: exponential approach — smooth, bounded, never a snap', () => {
  // One tau of time covers ~63.2% of the distance.
  const step = easeValue(0, 10, 0.18, 0.18);
  assert.ok(Math.abs(step - 10 * (1 - Math.exp(-1))) < 1e-9, String(step));
  // dt = 0 (or a stalled clock) leaves the value alone.
  assert.equal(easeValue(3, 10, 0, 0.18), 3);
  // Every step lands strictly between current and target (monotonic,
  // no overshoot), so a large seek eases across frames instead of jumping.
  let cur = 0;
  for (let i = 0; i < 300; i++) {
    const next = easeValue(cur, 100, 0.016, 0.18);
    assert.ok(next > cur && next <= 100, `step ${i}: ${next}`);
    cur = next;
  }
  assert.ok(Math.abs(cur - 100) < 1e-6, String(cur)); // converges
});

test('camConverged: within the center/zoom tolerances only', () => {
  const target = { cx: 100, cy: 200, s: 2 };
  assert.equal(camConverged({ cx: 100, cy: 200, s: 2 }, target), true);
  assert.equal(camConverged({ cx: 100.2, cy: 200, s: 2 }, target), true); // < 0.25 img px
  assert.equal(camConverged({ cx: 100.4, cy: 200, s: 2 }, target), false);
  assert.equal(camConverged({ cx: 100, cy: 200, s: 2.01 }, target), false); // > 0.2% rel
  assert.equal(camConverged({ cx: 100, cy: 200, s: 2.0039 }, target), true); // within 0.2%
});

// --- world-layer geometry (view arrow, death X, muzzle burst) ---------------

test('chevronPath: 3 points, apex along the angle, symmetric about the axis', () => {
  const size = 25;
  const p = chevronPath(100, 50, 0, size);
  assert.equal(p.length, 3);
  assert.deepEqual(p[1], [100 + size, 50]); // the APEX points east at angle 0
  // open ">" — the arm ends sit BACK from the apex (0.6·size along the
  // look direction, ±0.5·size across it), never a closed polygon/shaft
  assert.ok(Math.abs(p[0][0] - (100 + size * 0.6)) < 1e-9);
  assert.ok(Math.abs(p[0][1] - (50 - size * 0.5)) < 1e-9);
  // mirror symmetry about the look axis (index 0 ↔ 2)
  assert.ok(Math.abs(p[0][0] - p[2][0]) < 1e-9);
  assert.ok(Math.abs(p[0][1] + p[2][1] - 100) < 1e-9); // 2·cy
  // half a turn points the other way (screen y is down: +90° is south)
  const q = chevronPath(100, 50, Math.PI / 2, size);
  assert.ok(Math.abs(q[1][0] - 100) < 1e-9);
  assert.ok(Math.abs(q[1][1] - (50 + size)) < 1e-9);
  // degenerate size collapses onto the dot (never NaN, never a spike)
  const z = chevronPath(10, 20, 1.1, 0);
  assert.deepEqual(z, Array.from({ length: 3 }, () => [10, 20]));
  assert.deepEqual(chevronPath(10, 20, 0, NaN), z);
});

test('crossPath: two segments crossing at the marker, ±half on both axes', () => {
  const segs = crossPath(60, 40, 7);
  assert.equal(segs.length, 2);
  for (const [x1, y1, x2, y2] of segs) {
    assert.equal((x1 + x2) / 2, 60); // centered on the death spot
    assert.equal((y1 + y2) / 2, 40);
    assert.equal(Math.abs(x2 - x1), 14); // 2·half wide
    assert.equal(Math.abs(y2 - y1), 14);
  }
  assert.notDeepEqual(segs[0], segs[1]); // the two diagonals differ
  // degenerate half → a point at the center, no stray geometry
  assert.deepEqual(crossPath(1, 2, 0), [
    [1, 2, 1, 2],
    [1, 2, 1, 2],
  ]);
});

test('muzzleRays: count segments from inner to outer, fanned around the angle', () => {
  const rays = muzzleRays(0, 0, 0, 5, 12, 5, 0.6);
  assert.equal(rays.length, 5);
  for (const [x1, y1, x2, y2] of rays) {
    assert.ok(Math.abs(Math.hypot(x1, y1) - 5) < 1e-9, 'starts on the inner circle');
    assert.ok(Math.abs(Math.hypot(x2, y2) - 12) < 1e-9, 'ends on the outer circle');
    // every ray stays inside the ±spread fan around the look direction
    const a = Math.atan2(y2, x2);
    assert.ok(Math.abs(a) <= 0.6 + 1e-9, String(a));
    // and points outward, never back through the dot
    assert.ok(x1 * x2 + y1 * y2 > 0);
  }
  assert.deepEqual(muzzleRays(0, 0, 0, 12, 5), []); // outer ≤ inner
  assert.deepEqual(muzzleRays(0, 0, 0, 5, 12, 0), []); // no rays
  // count = 1 (the spread never applies): ONE straight ray along the aim
  // direction — the geometry of the firing tracer the renderer draws
  // dashed (r+2 → r+38).
  const line = muzzleRays(10, 20, 0.5, 11, 23, 1, 0);
  assert.equal(line.length, 1);
  const [x1, y1, x2, y2] = line[0];
  assert.ok(Math.abs(Math.hypot(x1 - 10, y1 - 20) - 11) < 1e-9, 'starts on the inner circle');
  assert.ok(Math.abs(Math.hypot(x2 - 10, y2 - 20) - 23) < 1e-9, 'ends on the outer circle');
  // …and both ends sit exactly on the look axis (straight, not fanned)
  const ux = Math.cos(0.5);
  const uy = Math.sin(0.5);
  assert.ok(Math.abs((x1 - 10) * uy - (y1 - 20) * ux) < 1e-9, 'inner end collinear');
  assert.ok(Math.abs((x2 - 10) * uy - (y2 - 20) * ux) < 1e-9, 'outer end collinear');
});

// --- tick-window effects (damage flash, muzzle flash) -----------------------

test('windowAlpha: 1 at the event, linear decay, 0 outside the window', () => {
  const tr = 64;
  const dur = 0.35;
  assert.equal(windowAlpha(1000, 1000, tr, dur), 1); // the hit itself
  assert.ok(Math.abs(windowAlpha(1000 + tr * dur * 0.5, 1000, tr, dur) - 0.5) < 1e-9);
  assert.equal(windowAlpha(1000 + Math.ceil(tr * dur), 1000, tr, dur), 0); // window closed
  assert.equal(windowAlpha(1000 + tr * dur * 2, 1000, tr, dur), 0); // long past
  assert.equal(windowAlpha(999, 1000, tr, dur), 0); // scrubbed BEFORE it
  // never a stuck flash: bad inputs all read "off"
  assert.equal(windowAlpha(1000, null, tr, dur), 0);
  assert.equal(windowAlpha(1000, 1000, 0, dur), 0);
  assert.equal(windowAlpha(1000, 1000, tr, -1), 0);
});

test('blindAlpha: peaks at 0.6 (lighter, not solid white), brief hold, linear fade to 0', () => {
  const tr = 64;
  const ms = 1000; // 1 s blind = 64 ticks
  const PEAK = 0.6; // mirrors renderer.js BLIND_PEAK_ALPHA
  // the overlay is a LIGHTENER: its ceiling is 0.6, so the team color
  // keeps showing through — it never reaches solid white
  assert.equal(blindAlpha(1000, 1000, tr, ms), PEAK); // peak at the blind tick
  assert.ok(PEAK < 1, 'peak alpha stays below 1 — the dot gets lighter');
  // the whole first quarter of the window HOLDS at the peak…
  assert.equal(blindAlpha(1000 + tr * 0.2, 1000, tr, ms), PEAK); // k = 0.2
  // …then a linear fade: PEAK · (1 − age share)/0.75 — at the midpoint
  // of the window 2/3 of the peak remains, at k=0.9 only 2/15 — and the
  // overlay is gone once the window closes.
  assert.ok(Math.abs(blindAlpha(1000 + tr * 0.5, 1000, tr, ms) - PEAK * (2 / 3)) < 1e-9);
  assert.ok(Math.abs(blindAlpha(1000 + tr * 0.9, 1000, tr, ms) - PEAK * (2 / 15)) < 1e-9);
  assert.equal(blindAlpha(1000 + Math.ceil(tr * ms / 1000), 1000, tr, ms), 0); // closed
  assert.equal(blindAlpha(999, 1000, tr, ms), 0); // scrubbed BEFORE it
  // never a stuck overlay: bad inputs all read "off"
  assert.equal(blindAlpha(1000, null, tr, ms), 0);
  assert.equal(blindAlpha(1000, 1000, 0, ms), 0);
  assert.equal(blindAlpha(1000, 1000, tr, 0), 0);
  assert.equal(blindAlpha(1000, 1000, tr, -5), 0);
  // tick-pure: the same tick always re-renders the same overlay
  assert.deepEqual(blindAlpha(1032, 1000, tr, ms), blindAlpha(1032, 1000, tr, ms));
});

test('voiceBloom: white bloom from the dot center — bounded, periodic, tick-pure', () => {
  const tr = 64;
  const dotR = 9;
  const P = 0.85; // mirrors renderer.js VOICE_BLOOM_PERIOD_S
  // bounded: the ring grows from ~3 px to dotR + 10 (r + 10 at r = 9 —
  // deliberately SMALLER than the old r + 14: it now draws UNDERNEATH
  // the dot, so a tighter halo is all that shows) and the alpha fades
  // 0.9 → 0 — never negative, never a solid flash, and the loop
  // progress stays inside [0, 1)
  for (let t = 0; t < 8 * tr; t += 1) {
    const b = voiceBloom(t, tr, dotR);
    assert.ok(b, `t=${t}`);
    assert.ok(b.k >= 0 && b.k < 1, `t=${t} k=${b.k}`);
    assert.ok(b.radius >= 3 - 1e-12 && b.radius <= dotR + 10 + 1e-12, `t=${t} r=${b.radius}`);
    assert.ok(b.alpha >= -1e-12 && b.alpha <= 0.9 + 1e-12, `t=${t} a=${b.alpha}`);
  }
  // periodic: one loop (P·tr ticks) re-renders the SAME expansion — a
  // scrub lands on the same phase (nothing wall-clock, nothing sticky)
  const period = P * tr;
  for (let t = 0; t < 5 * period; t += 7) {
    const a = voiceBloom(t, tr, dotR);
    const b = voiceBloom(t + period, tr, dotR);
    assert.ok(Math.abs(a.k - b.k) < 1e-9, `k t=${t}`);
    assert.ok(Math.abs(a.radius - b.radius) < 1e-9, `r t=${t}`);
    assert.ok(Math.abs(a.alpha - b.alpha) < 1e-9, `a t=${t}`);
  }
  // the loop restarts bright and small (inside the dot)…
  const start = voiceBloom(0, tr, dotR);
  assert.ok(Math.abs(start.radius - 3) < 1e-12, String(start.radius));
  assert.ok(Math.abs(start.alpha - 0.9) < 1e-12, String(start.alpha));
  // …and ends faint and wide (the ring reaches r + 10 as alpha → 0)
  const end = voiceBloom(period - 1, tr, dotR);
  assert.ok(end.radius > start.radius && end.alpha < start.alpha);
  // determinism (tick-pure) + the bad-input guards (never draw garbage)
  assert.deepEqual(voiceBloom(1234, tr, dotR), voiceBloom(1234, tr, dotR));
  assert.equal(voiceBloom(1000, 0, dotR), null);
  assert.equal(voiceBloom(NaN, tr, dotR), null);
  assert.equal(voiceBloom(Infinity, tr, dotR), null);
  assert.equal(voiceBloom(1000, tr, NaN), null);
  assert.equal(voiceBloom(1000, tr, -1), null);
});

test('fireJump: seeds across seeks, freezes on a paused redraw', () => {
  const tr = 64;
  // first draw / no previous tick → seed (never flash on startup)
  assert.equal(fireJump(0, null, 1, tr), true);
  // a paused redraw (same tick) is NOT a jump: the flash freezes
  assert.equal(fireJump(1000, 1000, 1, tr), false);
  // backwards: loop restart / reverse scrub → re-seed
  assert.equal(fireJump(900, 1000, 1, tr), true);
  // ordinary playback steps are never jumps (speed-scaled limit)
  assert.equal(fireJump(1001, 1000, 1, tr), false);
  assert.equal(fireJump(1010, 1000, 1, tr), false);
  assert.equal(fireJump(1100, 1000, 8, tr), false); // 8× keeps up with 100
  // a real forward seek (far beyond one playback step) re-seeds
  assert.equal(fireJump(5000, 1000, 1, tr), true);
  assert.equal(fireJump(1300, 1000, 1, tr), true); // > 27.2 ticks at 1×
  // nonsense inputs seed rather than compare
  assert.equal(fireJump(NaN, 1000, 1, tr), true);
  assert.equal(fireJump(1000, NaN, 1, tr), true);
});

test('killEndTick: the death X lives exactly as long as its round', () => {
  const tr = 64;
  const kill = { round: 3, tick: 1000 };
  const ends = [
    { round: 2, tick: 900 }, // an earlier round's end — ignored
    { round: 3, tick: 800 }, // before the kill — ignored
    { round: 3, tick: 5000 }, // THE round end
    { round: 4, tick: 9000 }, // a later round's end — ignored
  ];
  const starts = [
    { round: 2, tick: 950 }, // before the kill — ignored
    { round: 4, tick: 6000 }, // the NEXT round's start
  ];
  // no round_starts handed in → exactly the round_end rule (callers
  // without them, and the pre-fix behavior, are unchanged)
  assert.equal(killEndTick(kill, tr, ends), 5000);
  assert.equal(killEndTick(kill, tr, ends, []), 5000);
  // with round_starts the cutoff is MIN(round_end, next round_start):
  // 5000 < 6000 → the round end still wins…
  assert.equal(killEndTick(kill, tr, ends, starts), 5000);
  // …and a same-round round_end AFTER the next round's start never
  // wins (the only same-round end left here is 7000 > the 6000 start)
  assert.equal(
    killEndTick(kill, tr, [ends[0], ends[1], ends[3], { round: 3, tick: 7000 }], starts),
    6000,
  );
  // only earlier/other-round round_ends → the next round_start (else the
  // deliberately-long no-terminator fallback)
  const fallback = 1000 + 180 * tr;
  assert.equal(killEndTick(kill, tr, [ends[0], ends[1], ends[3]], starts), 6000);
  assert.equal(killEndTick(kill, tr, [ends[0], ends[1], ends[3]], [{ round: 9, tick: 999 }]), fallback);
  assert.equal(killEndTick(kill, tr, [ends[0], ends[1], ends[3]]), fallback);
  assert.equal(killEndTick(kill, tr, [], []), fallback);
  assert.equal(killEndTick(kill, tr, null, null), fallback);
  // invalid row → 0 (draw nothing)
  assert.equal(killEndTick(null, tr, ends, starts), 0);
  assert.equal(killEndTick({ round: 3 }, tr, ends, starts), 0);
});

test("killEndTick: a post-round_end kill (the C4 detonation) dies with the next round_start", () => {
  const tr = 64;
  // The golden demo's verified leak: the C4-detonation kill at tick
  // 14963 is stamped round 2 but happens AFTER round 2's round_end
  // (14930), so no same-round round_end could terminate it and the X
  // survived on the +180 s fallback — visible through round 3.
  const kill = { round: 2, tick: 14963 };
  const ends = [
    { round: 1, tick: 12000 },
    { round: 2, tick: 14930 }, // BEFORE the kill — cannot terminate it
  ];
  const starts = [
    { round: 2, tick: 13000 }, // round 2's own start — before the kill
    { round: 3, tick: 15200 }, // THE next round's start
  ];
  const fallback = 14963 + 180 * tr;
  assert.equal(killEndTick(kill, tr, ends), fallback); // the leak, unpinned
  assert.equal(killEndTick(kill, tr, ends, starts), 15200); // fixed
  // no round_starts loaded either (truncated feed) → still the fallback
  assert.equal(killEndTick(kill, tr, ends, []), fallback);
});

// --- end-to-end draw over a recording 2D context ----------------------------
//
// The world layers are only exercised by actually calling draw(); this
// drives createRenderer headlessly (node has no canvas) with a context
// that RECORDS every op instead of painting, and pins the tick-derived
// behavior the specs ask for: the lingering smoke reaches the renderer
// through the typed bucket, the death X lives exactly as long as its
// round (and comes back on a backwards scrub), the extracted C4 icon
// replaces the 'C4' label (text fallback without icons), the WHITE
// dashed muzzle tracer arms on an attack edge, the damage flash, the
// lighter flash overlay and the under-dot talking bloom are pure
// functions of tick.

// recordingCanvas: { log, getContext, clientWidth/Height } — a stand-in
// canvas whose 2D context records stroke/fill/arc/drawImage/fillText/
// roundRect/moveTo/lineTo/setLineDash ops together with the stroke/fill
// style, lineCap, lineWidth, lineDash, lineDashOffset, globalAlpha, font
// and textAlign in force.
function recordingCanvas(cssW = 800, cssH = 600) {
  const log = [];
  const styles = {
    strokeStyle: '',
    fillStyle: '',
    lineCap: 'butt',
    lineWidth: 1,
    lineDash: [],
    lineDashOffset: 0,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    shadowColor: '',
    shadowBlur: 0,
    imageSmoothingEnabled: true,
  };
  const RECORD = new Set([
    'stroke',
    'fill',
    'arc',
    'drawImage',
    'fillText',
    'roundRect',
    'moveTo',
    'lineTo',
    'setLineDash',
  ]);
  const ctx = new Proxy(styles, {
    get(t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in t) return t[prop];
      return (...args) => {
        if (prop === 'setLineDash') {
          // the dash pattern is STATE: snapshot it (a fresh array — the
          // logged entries must not alias a later setLineDash)
          t.lineDash = Array.isArray(args[0]) ? args[0].slice() : [];
        }
        if (RECORD.has(prop)) {
          log.push({
            op: prop,
            strokeStyle: t.strokeStyle,
            fillStyle: t.fillStyle,
            lineCap: t.lineCap,
            lineWidth: t.lineWidth,
            lineDash: t.lineDash,
            lineDashOffset: t.lineDashOffset,
            alpha: t.globalAlpha,
            font: t.font,
            textAlign: t.textAlign,
            args,
          });
        }
        if (prop === 'measureText') return { width: 40 };
        return undefined;
      };
    },
    set(t, prop, v) {
      t[prop] = v;
      return true;
    },
  });
  return {
    log,
    getContext: () => ctx,
    clientWidth: cssW,
    clientHeight: cssH,
    width: 0,
    height: 0,
  };
}

// iconTints — every offscreen canvas the icon tint cache builds, with
// the color its 'source-in' fill recolored it to (tintedIcon's recolor
// is the ONLY thing that fillRects in this harness). The cache is per
// renderer, so a fresh renderer rebuilds exactly what a test asserts;
// tests scope it with tintsSince(mark).
const iconTints = [];
const tintsSince = (mark = 0) => iconTints.slice(mark);

// headlessGlobals — the browser globals createRenderer touches that node
// has neither: a 1-dpr window, no-op rAF, and a canvas factory for the
// icon tint cache (offscreen canvas → 'source-in' recolor). Idempotent,
// so every end-to-end draw test installs it before driving the renderer.
function headlessGlobals() {
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = {
    createElement: () => {
      const cv = { width: 0, height: 0 };
      cv.getContext = () => ({
        drawImage() {},
        fillRect() {
          iconTints.push({ color: this.fillStyle, w: cv.width, h: cv.height });
        },
        globalCompositeOperation: '',
        fillStyle: '',
      });
      return cv;
    },
  };
}

// synthStore: `frames` one-tick-apart frames (the sidecar samples 1:1
// with demo frames) with both slots alive; slot 0 is CT, slot 1 T
// (per-frame side bits), standing at a fixed spot, yaw east.
function synthStore(frames, slotCount) {
  const ticks = new Int32Array(frames);
  for (let i = 0; i < frames; i++) ticks[i] = i;
  const masks = new Uint8Array(frames).fill((1 << slotCount) - 1);
  const slots = [];
  for (let s = 0; s < slotCount; s++) {
    const pos = new Float32Array(frames * 4);
    const flags = new Uint8Array(frames);
    for (let f = 0; f < frames; f++) {
      pos[f * 4] = 10 + s * 40; // x
      pos[f * 4 + 1] = 10 + s * 40; // y
      pos[f * 4 + 2] = 0; // z
      pos[f * 4 + 3] = 0; // yaw (east)
      flags[f] = s === 0 ? 8 : 4; // side bits: ct / t
    }
    slots.push({ pos, flags });
  }
  return { frames, ticks, masks, slots, bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } };
}

test('world layers follow the tick: smoke/fire, death X, C4 icon, muzzle tracer, hits, voice, blind', () => {
  // the renderer's browser globals (node has neither)
  headlessGlobals();

  const data = synthStore(1300, 2);
  const players = [
    { steamId: '1', name: 'alice', side: 'ct' },
    { steamId: '2', name: 'bob', side: 't' },
  ];
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 64, round: 1, kind: 'grenade_throw', attacker: '1', weapon: 'Smoke Grenade', posX: 10, posY: 10 }),
    mk({ id: 2, seq: 2, tick: 128, round: 1, kind: 'grenade', attacker: '1', weapon: 'Smoke Grenade', posX: 50, posY: 50 }),
    mk({ id: 3, seq: 3, tick: 50, round: 1, kind: 'bomb_drop', attacker: '1', posX: 20, posY: 20 }),
    mk({ id: 4, seq: 4, tick: 192, round: 1, kind: 'kill', attacker: '1', victim: '2', weapon: 'ak47', posX: 50, posY: 50 }),
    mk({ id: 5, seq: 5, tick: 193, round: 1, kind: 'damage', attacker: '1', victim: '2', weapon: 'ak47', dmg: 30, posX: 50, posY: 50 }),
    mk({ id: 6, seq: 6, tick: 400, round: 1, kind: 'round_end' }),
    // The C4-detonation leak in miniature: a kill stamped round 1 that
    // lands AFTER round 1's round_end — it must die with round 2's
    // round_start (450), not on the +180 s fallback.
    mk({ id: 7, seq: 7, tick: 420, round: 1, kind: 'kill', attacker: '1', victim: '2', weapon: 'c4', posX: 50, posY: 50 }),
    mk({ id: 8, seq: 8, tick: 450, round: 2, kind: 'round_start' }),
    // Grenade detonation pins: molotov (RED lingering area + ring),
    // flashbang (0.5 s white pop), HE (1.3 s expanding ring).
    mk({ id: 9, seq: 9, tick: 300, round: 1, kind: 'grenade', attacker: '1', weapon: 'Molotov', posX: 50, posY: 50 }),
    mk({ id: 10, seq: 10, tick: 600, round: 1, kind: 'grenade', attacker: '1', weapon: 'Flashbang', posX: 50, posY: 50 }),
    mk({ id: 11, seq: 11, tick: 700, round: 1, kind: 'grenade', attacker: '1', weapon: 'HE Grenade', posX: 50, posY: 50 }),
  ]);
  const smokeIcon = { width: 32, height: 32, src: 'smoke.svg' };
  // Deliberately NON-square: the C4 art must draw at its own aspect
  // ratio (48×24 → 24×12 at BOMB_ICON_PX = 12), never squashed to 1:1.
  const c4Icon = { width: 48, height: 24, src: 'c4.svg' };
  r.setIcons({ C4: c4Icon, 'Smoke Grenade': smokeIcon });
  r.setVoices({ colors: ['#84C8ED', null], speaking: (slot) => slot === 0 });
  // The flash-white overlay: alice is blinded at tick 100 for 1 s.
  r.setBlinds([{ slot: 0, tick: 100, ms: 1000 }]);
  r.setStateIndex(buildStateIndex([{ frame: 192, slot: 0, mask: 0x40, attack: true }], 2));
  r.resize(); // first draw at tick 0 (nothing of ours is live yet)

  const since = (mark) => canvas.log.slice(mark);
  const strokes = (from = 0) => since(from).filter((e) => e.op === 'stroke');
  const fills = (from = 0) => since(from).filter((e) => e.op === 'fill');
  // pathRadius — the radius of the arc that formed the path a fill
  // painted: beginPath isn't recorded, so the NEAREST arc before the
  // fill IS its path's arc (a fill/stroke in between means that arc
  // belonged to an earlier path).
  const pathRadius = (i) => {
    for (let j = i - 1; j >= 0; j--) {
      const op = canvas.log[j].op;
      if (op === 'arc') return canvas.log[j].args[2];
      if (op === 'fill' || op === 'stroke') return undefined;
    }
    return undefined;
  };
  // whiteDotFills — the dot-sized WHITE overlays (the blind window's
  // peak/fade/self-clear): white fills whose path is the r = 9 dot
  // circle. The talking bloom's core is a far smaller circle, so it can
  // never be mistaken for the overlay.
  const whiteDotFills = (from = 0) => {
    const out = [];
    for (let i = from; i < canvas.log.length; i++) {
      const e = canvas.log[i];
      if (e.op === 'fill' && e.fillStyle === '#ffffff' && pathRadius(i) === 9) out.push(e);
    }
    return out;
  };
  // the death X is the ONLY thing that strokes with lineCap 'round'
  const deathX = (from = 0) =>
    strokes(from).filter((e) => e.lineCap === 'round' && e.strokeStyle === '#e6a35a');
  // the lingering smoke (the thrower '1' is CT → the 50/50 CT tint;
  // see SMOKE_CT in renderer.js)
  const smokeCloud = (from = 0) =>
    fills(from).filter((e) => String(e.fillStyle).startsWith('rgba(135, 180, 218'));

  // --- inside round 1, smoke lingering, bomb on the ground -----------------
  let mark = canvas.log.length;
  engine.seekTick(200);
  r.draw();
  assert.ok(smokeCloud(mark).length > 0, 'the smoke cloud reaches the renderer (typed bucket)');
  assert.ok(
    since(mark).some((e) => e.fillStyle === 'rgba(135, 180, 218, 0.3)'),
    'the lingering smoke is clearly visible (fill 0.3, was 0.18) and CT-tinted by its thrower',
  );
  assert.ok(deathX(mark).length > 0, 'the death X marks where bob died');
  assert.ok(
    since(mark).some(
      // drawImage(image, dx, dy, dw, dh) — args[3]/args[4] are the box
      (e) => e.op === 'drawImage' && e.args[3] === 24 && e.args[4] === 12,
    ),
    'the extracted C4 icon keeps its ORIGINAL aspect ratio (48×24 → 24×12 at BOMB_ICON_PX)',
  );
  // layer order: the death X draws UNDER the dropped C4 — an X must
  // never overlap the bomb icon/rings (draw() draws deaths before bomb)
  {
    const seq = since(mark);
    const xi = seq.findIndex(
      (e) => e.op === 'stroke' && e.lineCap === 'round' && e.strokeStyle === '#e6a35a',
    );
    const bomb = seq.findIndex((e) => e.op === 'drawImage' && e.args[3] === 24 && e.args[4] === 12);
    assert.ok(xi >= 0, 'the death X draws in this frame');
    assert.ok(bomb > xi, 'the dropped C4 renders ABOVE the death X (layer order)');
  }
  // the talking BLOOM: a WHITE ring expanding from the dot's CENTER,
  // radius + alpha a pure function of the tick (voiceBloom) — drawn only
  // for the speaking slot, never tinted by the player color — and
  // painted BENEATH the dot: the ring and its core are recorded BEFORE
  // the dot's fill, so the dot sits on top of its own bloom.
  const bloom = voiceBloom(200, 64, 9);
  assert.ok(bloom, 'the bloom helper resolves at this tick');
  assert.ok(
    bloom.radius <= 9 + 10 + 1e-12,
    `the under-dot halo is tighter than the old r + 14 (${bloom.radius})`,
  );
  const frameSeq = since(mark);
  const bloomRing = frameSeq.findIndex(
    (e) =>
      e.op === 'arc' &&
      e.strokeStyle === '#ffffff' &&
      Math.abs(e.args[2] - bloom.radius) < 1e-9 &&
      Math.abs(e.alpha - bloom.alpha) < 1e-12,
  );
  assert.ok(bloomRing >= 0, 'the talking bloom is a WHITE expanding ring (tick-pure radius/alpha)');
  // anchored at the dot's CENTER — the CT dot's fill arc (r = 9) is the
  // reference point the bloom ring must sit on
  const ctDot = frameSeq.find(
    (e) => e.op === 'arc' && e.fillStyle === '#5aa9e6' && e.args[2] === 9,
  );
  assert.ok(ctDot, 'the CT dot draws at the standing radius r = 9');
  const ctDotIdx = frameSeq.indexOf(ctDot);
  assert.equal(frameSeq[bloomRing].args[0], ctDot.args[0], 'the bloom is anchored at the dot center, not offset from it');
  assert.equal(frameSeq[bloomRing].args[1], ctDot.args[1]);
  const bloomCore = frameSeq.findIndex(
    (e) =>
      e.op === 'arc' &&
      e.fillStyle === '#ffffff' &&
      Math.abs(e.args[2] - (3 * (1 - bloom.k) + 1)) < 1e-9,
  );
  assert.ok(bloomCore >= 0, 'the bloom keeps its small fading white core');
  assert.ok(
    bloomRing < ctDotIdx && bloomCore < ctDotIdx,
    'the bloom draws UNDERNEATH the dot — ring and core before the fill (layer order)',
  );
  assert.ok(
    !frameSeq.some((e) => e.op === 'arc' && e.strokeStyle === '#84C8ED' && e.args[2] === 18),
    'the old fixed-gap talking ring is gone (tinted or not)',
  );
  // the rim: the assigned voice color on alice's dot (radius r = 9) as a
  // MINIMAL 1 px stroke over a thin dark underlay (was a 3 px stroke),
  // and a 1 px white fallback where no color is assigned (bob).
  const rim = since(mark).find((e) => e.op === 'stroke' && e.strokeStyle === '#84C8ED');
  assert.ok(rim, 'the assigned voice color still outlines the dot');
  assert.equal(rim.lineWidth, 1, 'the rim is minimal — a 1 px stroke (was 3 px)');
  assert.ok(
    since(mark).some(
      (e) => e.op === 'stroke' && e.strokeStyle === 'rgba(0,0,0,0.5)' && e.lineWidth === 3,
    ),
    'the rim sits on a thin dark underlay for contrast',
  );
  assert.ok(
    since(mark).some(
      (e) =>
        e.op === 'stroke' && e.strokeStyle === 'rgba(255,255,255,0.85)' && e.lineWidth === 1,
    ),
    'a slot with no voice color falls back to a 1 px white rim',
  );
  // the view chevron: near-opaque, clearly visible, team-colored —
  // SMALLER and THICKER than before (r · 1.8 instead of r · 2.8, a
  // 2.75 px stroke instead of 1.75) — and the old low-alpha FILLED
  // arrow is gone.
  for (const col of ['#5aa9e6', '#e6a35a']) {
    assert.ok(
      since(mark).some(
        (e) => e.op === 'stroke' && e.strokeStyle === col && e.alpha === 0.9 && e.lineWidth === 2.75,
      ),
      `the ${col} chevron draws at alpha 0.9 / 2.75 px`,
    );
  }
  // …and it really is closer to the dot: every drawn chevron point sits
  // just outside the dot edge (r = 9), never far away like the old
  // r · 2.8 sizing (apex at 25.2 px from the center)
  const chevronPts = since(mark).filter(
    (e) => e.op === 'lineTo' && e.strokeStyle === '#5aa9e6' && e.alpha === 0.9,
  );
  assert.equal(chevronPts.length, 2, 'the CT chevron is a 2-arm open ">"');
  for (const p of chevronPts) {
    const d = Math.hypot(p.args[0] - ctDot.args[0], p.args[1] - ctDot.args[1]);
    assert.ok(d > 9 && d < 18, `chevron point ${d} px from the dot center — just outside the dot`);
  }
  assert.ok(
    !since(mark).some((e) => e.op === 'fill' && e.alpha === 0.2),
    'the old low-alpha filled arrow is gone',
  );

  // --- flash overlay (lighter, never solid white) + the chevron's open shape
  mark = canvas.log.length;
  engine.seekTick(100); // inside the PEAK quarter of the 1 s blind window
  r.draw();
  // scoped to the DOT-sized overlay (r = 9): the talking bloom's core is
  // a separate, much smaller white circle and keeps drawing while alice
  // speaks.
  assert.ok(
    whiteDotFills(mark).some((e) => Math.abs(e.alpha - 0.6) < 1e-12),
    'the blinded dot gets LIGHTER — the overlay peaks at 0.6, never solid white',
  );
  assert.ok(
    whiteDotFills(mark).every((e) => e.alpha <= 0.6 + 1e-12),
    'the team color always shows through (no fill above the 0.6 peak)',
  );
  // …and the chevron really is an open ">": exactly two arms per player
  // (the old filled arrow walked 6 lineTo points around its outline).
  // Filtered on the chevron's own alpha — the movement trails share the
  // team colors but draw at ≤ 0.5.
  const chevronArms = (color) =>
    since(mark).filter(
      (e) => e.op === 'lineTo' && e.strokeStyle === color && e.alpha === 0.9,
    );
  assert.equal(chevronArms('#5aa9e6').length, 2, 'the CT chevron is a 2-arm open ">"');
  assert.equal(chevronArms('#e6a35a').length, 2, 'the T chevron is a 2-arm open ">"');

  mark = canvas.log.length;
  engine.seekTick(132); // k = 0.5 → 2/3 of the peak remains
  r.draw();
  const fading = whiteDotFills(mark).find((e) => e.alpha < 0.6);
  assert.ok(fading, 'the white overlay fades as the blind ages');
  assert.ok(Math.abs(fading.alpha - 0.6 * (2 / 3)) < 1e-9, `fade alpha ${fading.alpha}`);

  mark = canvas.log.length;
  engine.seekTick(164); // 1000 ms after the blind — window closed
  r.draw();
  // Scoped to the DOT-sized white fill (r = 9 — pathRadius reads the
  // fill's own arc): the talking bloom's core is a separate, much
  // smaller white circle and keeps drawing while alice speaks.
  assert.equal(
    whiteDotFills(mark).filter((e) => e.alpha > 0).length,
    0,
    'the flash overlay self-clears',
  );

  // --- past round_end: the X is gone, scrubbing back brings it back --------
  mark = canvas.log.length;
  engine.seekTick(500);
  r.draw();
  assert.equal(deathX(mark).length, 0, 'the death X clears at round_end');
  mark = canvas.log.length;
  engine.seekTick(300); // backwards scrub into round 1
  r.draw();
  assert.ok(deathX(mark).length > 0, 'scrubbing back into the round redraws the X');

  // --- the post-round C4 kill dies with the NEXT round's start -------------
  mark = canvas.log.length;
  engine.seekTick(420); // after round 1's round_end (400), round 2 not yet
  r.draw();
  assert.ok(deathX(mark).length > 0, "the kill past round_end still marks bob's spot");
  mark = canvas.log.length;
  engine.seekTick(460); // round 2's round_start (450) has passed
  r.draw();
  assert.equal(
    deathX(mark).length,
    0,
    'the next round_start clears the X (no +180 s leak into the round)',
  );
  // …and the ribbon seek lands EXACTLY on that startTick (the repro:
  // click round 2 then round 3 in the ribbon — the seek lands on round
  // 3's startTick, which IS this post-round kill's cutoff): the marker
  // must be gone AT the boundary, not one tick after it — with the old
  // `tick > end` test the X still drew here and, paused, never cleared
  // (the stuck blue X). This miniature is rounds 1 → 2, same shape.
  mark = canvas.log.length;
  engine.seekTick(450); // EXACTLY round 2's round_start — the cutoff
  r.draw();
  assert.equal(deathX(mark).length, 0, 'zero death-X draws AT the next round_start tick');
  mark = canvas.log.length;
  engine.seekTick(451); // one tick into the new round
  r.draw();
  assert.equal(deathX(mark).length, 0, 'still gone one tick into the new round');

  // --- the smoke lifetime (18 s) ends it, nothing is sticky ----------------
  mark = canvas.log.length;
  engine.seekTick(1299); // age = (1299-128)/64 ≈ 18.3 s
  r.draw();
  assert.equal(smokeCloud(mark).length, 0, 'the smoke cloud fades out after its lifetime');

  // --- firing: the attack edge arms the WHITE dashed TRACER ---------------
  mark = canvas.log.length;
  engine.seekTick(191); // attack bit still false here → re-seed
  r.draw();
  mark = canvas.log.length;
  engine.seekTick(192); // …rising edge on this frame
  r.draw();
  const tracers = (from) =>
    strokes(from).filter(
      (e) => e.strokeStyle === '#ffffff' && e.lineWidth === 2 && e.lineDash.length > 0,
    );
  assert.ok(tracers(mark).length > 0, 'the muzzle tracer draws on the attack edge');
  assert.ok(
    !strokes(mark).some((e) => e.strokeStyle === '#ffd982'),
    'the tracer is WHITE — the old amber muzzle ray is gone',
  );
  assert.equal(
    since(mark).filter((e) => e.op === 'lineTo' && e.strokeStyle === '#ffffff').length,
    1,
    'ONE straight line along the aim direction (not a 5-ray fan)',
  );
  // …and it is TWICE as long as the old r+2 → r+20 ray: the far end sits
  // r+38 = 47 px out from the dot's center (the CT dot fill is the
  // reference).
  {
    const dot = since(mark).find(
      (e) => e.op === 'arc' && e.fillStyle === '#5aa9e6' && e.args[2] === 9,
    );
    const end = since(mark).find((e) => e.op === 'lineTo' && e.strokeStyle === '#ffffff');
    const reach = Math.hypot(end.args[0] - dot.args[0], end.args[1] - dot.args[1]);
    assert.ok(Math.abs(reach - 47) < 1e-9, `the tracer reaches r + 38 = 47 px (got ${reach})`);
  }
  // dashed [6,5] with the phase pinned to the flash tick: at the edge
  // tick itself the dashes have not travelled yet…
  assert.ok(
    tracers(mark).some((e) => e.lineDash.join(',') === '6,5' && e.lineDashOffset === 0),
    'the tracer is dashed [6,5], phase 0 on the flash tick',
  );
  // …and 7 ticks later they have marched outward — a pure function of
  // the tick, so a scrub re-renders the same phase (nothing sticky).
  mark = canvas.log.length;
  engine.seekTick(199);
  r.draw();
  assert.ok(
    tracers(mark).some((e) => Math.abs(e.lineDashOffset - -5.6) < 1e-9),
    'the dash phase advances from the tick — the tracers march outward',
  );
  // …and is gone once its window (0.22 s) has passed
  mark = canvas.log.length;
  engine.seekTick(260);
  r.draw();
  assert.equal(tracers(mark).length, 0, 'the muzzle tracer self-clears');

  // --- damage flash: a red ring inside its 0.35 s window only --------------
  mark = canvas.log.length;
  engine.seekTick(193);
  r.draw();
  assert.ok(
    strokes(mark).some((e) => e.strokeStyle === 'rgba(255,70,70,0.95)'),
    'the victim flashes red on the damage tick',
  );
  mark = canvas.log.length;
  engine.seekTick(400); // 207 ticks ≫ 0.35 s after the hit
  r.draw();
  assert.equal(
    strokes(mark).filter((e) => e.strokeStyle === 'rgba(255,70,70,0.95)').length,
    0,
    'the damage flash self-clears',
  );

  // --- molotov/incendiary: RED lingering area + detonation ------------------
  mark = canvas.log.length;
  engine.seekTick(320); // 0.31 s after the molotov (det 0.6 s window)
  r.draw();
  assert.ok(
    since(mark).some((e) => e.op === 'fill' && e.fillStyle === 'rgba(235, 70, 55, 0.3)'),
    'the lingering fire area reads RED (was orange)',
  );
  assert.ok(
    since(mark).some((e) => e.op === 'stroke' && e.strokeStyle === 'rgba(245, 90, 70, 0.55)'),
    'the lingering fire outline reads RED (was orange)',
  );
  assert.ok(
    since(mark).some((e) => e.op === 'stroke' && String(e.strokeStyle).startsWith('rgba(240, 75, 60')),
    'the fire detonation ring is RED (was orange)',
  );
  assert.ok(
    since(mark).some((e) => e.op === 'fill' && String(e.fillStyle).startsWith('rgba(255, 110, 90')),
    'the fire detonation core is hot-red (was light orange)',
  );
  assert.ok(
    !since(mark).some(
      (e) =>
        String(e.strokeStyle).includes('230, 120, 60') ||
        String(e.strokeStyle).includes('235, 130, 60') ||
        String(e.fillStyle).includes('230, 120, 60') ||
        String(e.fillStyle).includes('255, 200, 130'),
    ),
    'no orange fire color survives anywhere',
  );

  // --- flashbang + HE detonations are slightly faster -----------------------
  mark = canvas.log.length;
  engine.seekTick(600); // the flashbang's own tick
  r.draw();
  assert.ok(
    since(mark).some((e) => e.op === 'stroke' && String(e.strokeStyle).startsWith('rgba(255, 255, 255')),
    'the flashbang pops white on its tick',
  );
  mark = canvas.log.length;
  engine.seekTick(640); // 0.625 s later — past the shortened 0.5 s bang
  r.draw();
  assert.equal(
    since(mark).filter((e) => e.op === 'stroke' && String(e.strokeStyle).startsWith('rgba(255, 255, 255')).length,
    0,
    'the flashbang pop is gone after ~0.5 s (was 0.7 s)',
  );

  mark = canvas.log.length;
  engine.seekTick(777); // age = 1.203 s — still inside the HE ring
  r.draw();
  assert.ok(
    since(mark).some((e) => e.op === 'stroke' && String(e.strokeStyle).startsWith('rgba(224, 91, 91')),
    'the HE ring expands for ~1.2 s',
  );
  mark = canvas.log.length;
  engine.seekTick(790); // age = 1.406 s — past the shortened 1.3 s ring
  r.draw();
  assert.equal(
    since(mark).filter((e) => e.op === 'stroke' && String(e.strokeStyle).startsWith('rgba(224, 91, 91')).length,
    0,
    'the HE ring is gone after ~1.3 s (was 2 s)',
  );

  // --- no icons at all → today's text label, exactly -----------------------
  r.setIcons({});
  mark = canvas.log.length;
  engine.seekTick(200);
  r.draw();
  assert.ok(
    since(mark).some((e) => e.op === 'fillText' && e.args[0] === 'C4'),
    "without icons the 'C4' text label is the fallback",
  );

  r.destroy();
});

test('death X: gone AT the next round_start (the ribbon seek), a kill on the round_end tick still marks', () => {
  // Regression for the stuck-blue-X repro (golden demo): pause, click
  // round 2 in the ribbon, then round 3 → round 3's startTick IS round
  // 2's post-round C4 kill's killEndTick, so the marker must be gone AT
  // that exact tick. The old `tick > end` test drew it there and, paused,
  // it never cleared. The existing tests seek PAST the boundary — hence
  // they passed. Also pins the flip side: a kill stamped ON the
  // round_end tick (golden demo round 1: kill and round_end share tick
  // 7626) still marks its spot for that one tick.
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [
      { steamId: '1', name: 'alice', side: 'ct' },
      { steamId: '2', name: 'bob', side: 't' },
    ],
  });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    // an ordinary in-round kill (live until round 1's round_end at 400)
    mk({ id: 1, seq: 1, tick: 192, round: 1, kind: 'kill', attacker: '1', victim: '2', weapon: 'ak47', posX: 50, posY: 50 }),
    // a kill at the SAME tick as round 1's round_end (both at 400)
    mk({ id: 2, seq: 2, tick: 400, round: 1, kind: 'kill', attacker: '1', victim: '2', weapon: 'ak47', posX: 50, posY: 50 }),
    // the post-round C4 kill: past round 1's round_end (400), terminated
    // by round 2's round_start (450) — its cutoff IS the ribbon seek
    mk({ id: 3, seq: 3, tick: 420, round: 1, kind: 'kill', attacker: '1', victim: '2', weapon: 'c4', posX: 50, posY: 50 }),
    mk({ id: 4, seq: 4, tick: 400, round: 1, kind: 'round_end' }),
    mk({ id: 5, seq: 5, tick: 450, round: 2, kind: 'round_start' }),
  ]);
  r.resize();
  const deathX = (from) =>
    canvas.log
      .slice(from)
      .filter((e) => e.op === 'stroke' && e.lineCap === 'round' && e.strokeStyle === '#e6a35a');

  // the ribbon seek lands EXACTLY on the cutoff tick — zero X's
  let mark = canvas.log.length;
  engine.seekTick(450);
  r.draw();
  assert.equal(deathX(mark).length, 0, 'zero death-X draws AT the next round_start tick');
  mark = canvas.log.length;
  engine.seekTick(451);
  r.draw();
  assert.equal(deathX(mark).length, 0, 'still gone one tick into the new round');
  // …while the tick BEFORE the boundary still marks (live through the round)
  mark = canvas.log.length;
  engine.seekTick(420);
  r.draw();
  assert.ok(deathX(mark).length > 0, 'the post-round kill marks before the boundary');
  // a backwards scrub re-derives the marker (nothing sticky, either way)
  mark = canvas.log.length;
  engine.seekTick(300);
  r.draw();
  assert.ok(deathX(mark).length > 0, 'scrubbing back redraws the in-round X');
  // the kill stamped ON the round_end tick: shown AT the kill moment…
  mark = canvas.log.length;
  engine.seekTick(400);
  r.draw();
  assert.ok(deathX(mark).length > 0, 'a kill on the round_end tick still marks its spot');
  // …and gone the very next tick (the round ended on that tick)
  mark = canvas.log.length;
  engine.seekTick(401);
  r.draw();
  assert.equal(deathX(mark).length, 0, 'the round_end-tick kill is gone after its one tick');
  r.destroy();
});

test('dots keep a constant radius while crouching (duck never shrinks them)', () => {
  // Same browser globals the draw test installs (node has neither).
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {}, fillRect() {}, globalCompositeOperation: '', fillStyle: '' }),
    }),
  };

  const frames = 4;
  const ticks = new Int32Array(frames);
  for (let i = 0; i < frames; i++) ticks[i] = i;
  const masks = new Uint8Array(frames).fill(1); // slot 0 alive on every frame
  const pos = new Float32Array(frames * 4);
  const flags = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    pos[f * 4] = 10;
    pos[f * 4 + 1] = 10;
    flags[f] = 8 | 2; // ct side bits (>>2 = 2) AND the duck bit (0x02)
  }
  const data = {
    frames,
    ticks,
    masks,
    slots: [{ pos, flags }],
    bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
  };
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [{ steamId: '1', name: 'duck', side: 'ct' }],
  });
  r.resize();
  const mark = canvas.log.length;
  engine.seekTick(2); // a frame whose flags carry the duck bit
  r.draw();
  const arcs = canvas.log.slice(mark).filter((e) => e.op === 'arc');
  assert.ok(arcs.some((e) => e.args[2] === 9), 'the dot is drawn at the standing radius');
  assert.ok(
    !arcs.some((e) => e.args[2] === 6.5),
    'a crouching player keeps the same dot size (no 6.5 px duck radius)',
  );
  r.destroy();
});

// --- carried-C4 badge on the player dot -------------------------------------
//
// The carrier comes from the STATE STREAM's per-slot inventory (the same
// slotStateAt series the attack edge reads): 'C4' present → a small white
// C4 at the dot's TOP-RIGHT, anything else → nothing. A dead player has
// no dot at all (drawPlayers skips them) and a dropped/planted bomb
// leaves every inventory, so the badge clears itself — drawBomb owns the
// world bomb separately.

test('C4 badge: inventory-driven carrier, top-right anchor, alive only, text fallback', () => {
  headlessGlobals();
  const data = synthStore(1300, 2); // frames at ticks 0…1299, both slots alive
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [
      { steamId: '1', name: 'alice', side: 'ct' },
      { steamId: '2', name: 'bob', side: 't' },
    ],
  });
  // Deliberately NON-square: the badge keeps the art's aspect (48×24 →
  // 20×10 at DOT_C4_ICON_PX = 10), never squashed to 1:1.
  const c4Icon = { width: 48, height: 24, src: 'c4.svg' };
  r.setIcons({ C4: c4Icon });
  const stateIdx = buildStateIndex(
    [
      { frame: 0, slot: 0, mask: 0x008, inventory: ['C4', 'AK-47'] }, // alice carries
      { frame: 0, slot: 1, mask: 0x008, inventory: ['USP-S'] }, // bob does not
      { frame: 600, slot: 0, mask: 0x008, inventory: [] }, // later: dropped/planted
    ],
    2,
  );
  r.setStateIndex(stateIdx);
  r.resize();
  // the badge BODY: drawImage at the badge's 10 px height / 20 px width
  // (the halo around it is drawn 1 px larger on every side → 22×12)
  const badges = (from) =>
    canvas.log.slice(from).filter((e) => e.op === 'drawImage' && e.args[4] === 10 && e.args[3] === 20);

  // --- the carrier only, anchored at the dot's top-right -------------------
  engine.seekTick(10);
  let mark = canvas.log.length;
  r.draw();
  let seq = canvas.log.slice(mark);
  const dot = seq.find((e) => e.op === 'arc' && e.fillStyle === '#5aa9e6' && e.args[2] === 9);
  assert.ok(dot, "the carrier's dot draws");
  const badge = badges(mark);
  assert.equal(badge.length, 1, "exactly ONE badge — the carrier's, nobody else's");
  // anchored by its TOP-RIGHT at the dot bbox's corner + 1 px, growing
  // left/down: (c.x + r + 1, c.y − r − 1) with r = 9
  assert.ok(
    Math.abs(badge[0].args[1] + badge[0].args[3] - (dot.args[0] + 10)) < 1e-9,
    'anchored at c.x + r + 1',
  );
  assert.ok(Math.abs(badge[0].args[2] - (dot.args[1] - 10)) < 1e-9, 'anchored at c.y − r − 1');
  assert.ok(
    seq.indexOf(badge[0]) > seq.indexOf(dot),
    'the badge draws ABOVE the dot body (and above the under-dot bloom)',
  );
  // both dots draw — the single badge above proves bob (the non-carrier)
  // has none
  assert.ok(
    seq.some((e) => e.op === 'arc' && e.fillStyle === '#e6a35a' && e.args[2] === 9),
    "the non-carrier's dot draws too",
  );

  // --- a dead carrier draws no badge (no dot, no icon) ---------------------
  data.masks[10] = 2; // frame 10: alice (slot 0) dead, bob alive
  mark = canvas.log.length;
  r.draw();
  assert.equal(badges(mark).length, 0, 'a dead player carries no visible badge');
  assert.ok(
    canvas.log.slice(mark).some((e) => e.op === 'arc' && e.fillStyle === '#e6a35a' && e.args[2] === 9),
    "…while the living non-carrier's dot still draws",
  );
  data.masks[10] = 3; // restore both alive

  // --- the inventory stops listing 'C4' → the badge clears -----------------
  engine.seekTick(610); // frame 600 record: inventory without C4
  mark = canvas.log.length;
  r.draw();
  assert.equal(
    badges(mark).length,
    0,
    'a dropped/planted bomb leaves the inventory → no carrier badge',
  );
  // …and scrubbing BACK into the carrying window redraws it (nothing sticky)
  engine.seekTick(10);
  mark = canvas.log.length;
  r.draw();
  assert.equal(badges(mark).length, 1, 'scrubbing back redraws the badge');

  // --- no state stream at all → never a guessed carrier -------------------
  r.setStateIndex(null);
  mark = canvas.log.length;
  r.draw();
  assert.equal(badges(mark).length, 0, 'without a state stream there is no carrier to show');

  // --- no image → the tiny 'C4' label in the same box ----------------------
  r.setStateIndex(stateIdx);
  r.setIcons({}); // no art for 'C4'
  mark = canvas.log.length;
  r.draw();
  seq = canvas.log.slice(mark);
  const label = seq.find((e) => e.op === 'fillText' && e.args[0] === 'C4');
  assert.ok(label, "without icons the tiny 'C4' label is the fallback");
  assert.equal(label.font, 'bold 8px ui-monospace, monospace', 'small enough for the badge box');
  const dot2 = seq.find((e) => e.op === 'arc' && e.fillStyle === '#5aa9e6' && e.args[2] === 9);
  assert.ok(dot2, 'the carrier dot still draws');
  assert.ok(
    Math.abs(label.args[1] - (dot2.args[0] + 10 - 5)) < 1e-9,
    'the label is centered in the same top-right box',
  );
  assert.ok(Math.abs(label.args[2] - (dot2.args[1] - 10 + 8)) < 1e-9, '…and sits inside it vertically');
  r.destroy();
});

// --- utility flight tinted by the throwing team ------------------------------
//
// The throw→detonate line and the icon riding it carry the THROWER's side
// at the throw tick (throwerSideAt: slotOfSteam + sideAtFrame — the SAME
// canonical rule the death X and the kill feed use). An unresolvable
// thrower keeps the neutral orange line and the untinted icon — a side is
// never guessed. Lingering FIRE areas and the fire/HE/decoy detonations
// stay type-colored — the lingering SMOKE area and its bloom now take the
// thrower's team tint too (pinned in the next test).

test('util flight: trail + icon take the thrower team color, neutral when unknown', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [
      { steamId: '1', name: 'alice', side: 'ct' },
      { steamId: '2', name: 'bob', side: 't' },
    ],
  });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setIcons({ 'Smoke Grenade': { width: 32, height: 32, src: 'smoke.svg' } });
  const throwPair = (attacker) => [
    mk({ id: 1, seq: 1, tick: 64, round: 1, kind: 'grenade_throw', attacker, weapon: 'Smoke Grenade', posX: 10, posY: 10 }),
    mk({ id: 2, seq: 2, tick: 128, round: 1, kind: 'grenade', attacker, weapon: 'Smoke Grenade', posX: 50, posY: 50 }),
  ];
  // the in-flight trail is the only [4,4]-dashed stroke in these frames
  const flight = (from) =>
    canvas.log.slice(from).filter((e) => e.op === 'stroke' && e.lineDash.join(',') === '4,4');
  const nadeIcons = (from) =>
    canvas.log.slice(from).filter((e) => e.op === 'drawImage' && e.args[4] === 16);

  // --- unknown thrower → today's neutral line, untinted icon ---------------
  r.setLandmarks(throwPair('999'));
  r.resize();
  engine.seekTick(100); // in flight (64 → 128)
  let tints = iconTints.length;
  let mark = canvas.log.length;
  r.draw();
  let lines = flight(mark);
  assert.equal(lines.length, 1, 'the in-flight trail draws');
  assert.equal(lines[0].strokeStyle, 'rgba(251, 172, 24, 0.4)', 'an unresolvable thrower keeps the neutral orange line');
  assert.equal(lines[0].alpha, 1, 'the neutral line keeps its own baked alpha');
  assert.equal(nadeIcons(mark).length, 1, 'the icon rides the path');
  assert.equal(
    tintsSince(tints).filter((t) => t.color !== 'rgba(8, 10, 14, 0.85)').length,
    0,
    'an unknown thrower tints NOTHING but the icon halo (original art)',
  );

  // --- a CT thrower → CT blue line + CT-tinted icon ------------------------
  r.setLandmarks(throwPair('1'));
  tints = iconTints.length;
  mark = canvas.log.length;
  r.draw(); // same playhead, still in flight
  lines = flight(mark);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].strokeStyle, '#5aa9e6', 'the CT thrower tints the trail CT blue');
  assert.ok(Math.abs(lines[0].alpha - 0.55) < 1e-12, 'the team line keeps the trail subtlety (0.55)');
  assert.equal(nadeIcons(mark).length, 1, 'the icon still rides the path');
  assert.ok(
    tintsSince(tints).some((t) => t.color === '#5aa9e6'),
    'the icon is tinted with the SAME team color (tintedIcon recolor)',
  );

  // --- a T thrower → T orange line + T-tinted icon -------------------------
  r.setLandmarks(throwPair('2'));
  tints = iconTints.length;
  mark = canvas.log.length;
  r.draw();
  lines = flight(mark);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].strokeStyle, '#e6a35a', 'the T thrower tints the trail T orange');
  assert.ok(
    tintsSince(tints).some((t) => t.color === '#e6a35a'),
    'the icon takes the T color too',
  );

  // --- the flight window closes on the detonation tick (unchanged) ---------
  engine.seekTick(129);
  mark = canvas.log.length;
  r.draw();
  assert.equal(flight(mark).length, 0, 'no trail once the grenade has detonated');
  r.destroy();
});

// --- detonated smoke tinted by the throwing team ----------------------------
//
// The lingering smoke area AND its detonation bloom ring carry the
// THROWER's side at the smoke's tick (smokeColorRGB → throwerSideAt — the
// SAME canonical rule as the util flight line): the team color blended
// 50/50 with the neutral smoke gray (SMOKE_CT/SMOKE_T in renderer.js) at
// the UNCHANGED 0.3/0.55 area alphas and the bloom's 0.8·(1−k). An
// unresolvable thrower keeps the old neutral gray VERBATIM — a side is
// never guessed (the no-guessed-fallback rule).

test('smoke tint: lingering area + bloom ring take the thrower team color, neutral when unknown', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [
      { steamId: '1', name: 'alice', side: 'ct' },
      { steamId: '2', name: 'bob', side: 't' },
    ],
  });
  const mk = (ev) => normalizeEvent(ev, {});
  // one lone smoke detonation (no throw pair → no flight line to filter)
  const smokeRow = (attacker) =>
    mk({ id: 1, seq: 1, tick: 128, round: 1, kind: 'grenade', attacker, weapon: 'Smoke Grenade', posX: 50, posY: 50 });
  const AREA_FILL = 'rgba(135, 180, 218, 0.3)'; // the CT 50/50 blend, fill alpha 0.3
  const AREA_STROKE = 'rgba(135, 180, 218, 0.55)'; // …and the outline alpha 0.55
  const T_FILL = 'rgba(205, 177, 148, 0.3)';
  const T_STROKE = 'rgba(205, 177, 148, 0.55)';
  const NEUTRAL_FILL = 'rgba(180, 190, 205, 0.3)'; // the pre-tint gray, verbatim
  const NEUTRAL_STROKE = 'rgba(180, 190, 205, 0.55)';
  // the lingering area at the playhead: fill + stroke with a given color
  const area = (from, fill, stroke) =>
    canvas.log.slice(from).some((e) => e.op === 'fill' && e.fillStyle === fill) &&
    canvas.log.slice(from).some((e) => e.op === 'stroke' && e.strokeStyle === stroke);
  // the bloom ring: a NON-1.5 px stroke (the area outline is always 1.5)
  // in the tint color, within the 0.9 s bloom window
  const bloomRing = (from, prefix) =>
    canvas.log
      .slice(from)
      .some((e) => e.op === 'stroke' && String(e.strokeStyle).startsWith(prefix) && e.lineWidth !== 1.5);
  const BLOOM_DUR = 0.9; // mirrors renderer.js — the smoke bloom window

  // --- a CT thrower (alice, slot 0) → the CT blue-gray tint ---------------
  r.setLandmarks([smokeRow('1')]);
  r.resize();
  engine.seekTick(200); // 1.125 s old: lingering area at full alpha, bloom done
  let mark = canvas.log.length;
  r.draw();
  assert.ok(area(mark, AREA_FILL, AREA_STROKE), 'the CT thrower tints the lingering smoke CT blue-gray at the SAME 0.3/0.55 alphas');
  assert.ok(
    !canvas.log.slice(mark).some((e) => String(e.fillStyle).startsWith('rgba(180, 190, 205')),
    'a KNOWN side never falls back to the neutral gray (non-vacuous pin)',
  );
  // the bloom ring on the same smoke (0.1875 s after detonation, k = t/0.9)
  mark = canvas.log.length;
  engine.seekTick(140);
  r.draw();
  const ctRing = canvas.log
    .slice(mark)
    .find((e) => e.op === 'stroke' && String(e.strokeStyle).startsWith('rgba(135, 180, 218') && e.lineWidth !== 1.5);
  assert.ok(ctRing, 'the smoke detonation bloom ring takes the CT tint too');
  const ringAlpha = Number(String(ctRing.strokeStyle).match(/[\d.]+\)$/)[0].slice(0, -1));
  assert.ok(
    Math.abs(ringAlpha - 0.8 * (1 - ((140 - 128) / 64) / BLOOM_DUR)) < 1e-9,
    'the bloom keeps its 0.8·(1−k) age fade (only the hue changed)',
  );

  // --- a T thrower (bob, slot 1) → the warm gray-orange tint --------------
  r.setLandmarks([smokeRow('2')]);
  mark = canvas.log.length;
  engine.seekTick(200);
  r.draw();
  assert.ok(area(mark, T_FILL, T_STROKE), 'the T thrower tints the lingering smoke warm gray-orange');
  mark = canvas.log.length;
  engine.seekTick(140);
  r.draw();
  assert.ok(bloomRing(mark, 'rgba(205, 177, 148'), 'the bloom ring takes the T tint too');

  // --- an unresolvable thrower → the neutral gray, exactly -----------------
  r.setLandmarks([smokeRow('999')]);
  mark = canvas.log.length;
  engine.seekTick(200);
  r.draw();
  assert.ok(area(mark, NEUTRAL_FILL, NEUTRAL_STROKE), 'an unknown thrower keeps the neutral gray area (no guessed side)');
  mark = canvas.log.length;
  engine.seekTick(140);
  r.draw();
  assert.ok(bloomRing(mark, 'rgba(180, 190, 205'), 'the bloom ring stays neutral gray too');
  r.destroy();
});

// --- HUD + kill feed over the recording context ------------------------------
//
// The HUD boxes and the kill feed live ON the canvas (snapshots and clip
// recordings capture the canvas and nothing else), so they are pinned the
// same way as the world layers: drive draw() and read the recorded ops.
// measureText always reports 40px in this harness, which makes every box
// geometry assertion exact. headlessGlobals() stubs the browser globals;
// document.fonts is stubbed per-test to steer the codicon-clock branch.

const HUD_PAD = 8; // mirrors renderer.js — box padding / stage offset
const KILL_FEED_LH = 18; // mirrors renderer.js — one entry line
const KILL_FEED_R = 4; // mirrors renderer.js — entry corner radius
// .codicon-clock's glyph (codicon.css line 145: content "\ea82") — built
// from the codepoint so this file never carries the raw PUA character.
const CLOCK_GLYPH = String.fromCharCode(0xea82);
const opsSince = (log, op, from = 0) => log.slice(from).filter((e) => e.op === op);
const textsSince = (log, from = 0) => opsSince(log, 'fillText', from).map((e) => e.args[0]);
// The kill feed's box is the ONLY fill of the un-spaced dark surface
// (the HUD boxes use 'rgba(14, 17, 22, 0.78)' — a different string).
const feedBoxesSince = (log, from = 0) =>
  opsSince(log, 'fill', from).filter((e) => e.fillStyle === 'rgba(14,17,22,0.78)');

const HUD_PLAYERS = [
  { steamId: '1', name: 'alice', side: 'ct' },
  { steamId: '2', name: 'bob', side: 't' },
];

// --- HUD pure layout: score anchoring + team-side pairing -------------------
//
// The recording harness's measureText is a flat 40 px, so the UNEQUAL-name
// score layout (the whole point of the fix) and the halftime name swap are
// pinned on the pure helpers with injected widths/sides instead.

test('score line: the score segment is dead-center, the shorter-name side pads', () => {
  // left 90, score 60, right 40 in a box centered at 400.
  const lay = scoreLineLayout(90, 60, 40, 400);
  assert.equal(lay.scoreX, 370, 'the score starts at center − scoreW/2');
  assert.equal(lay.scoreX + 60 / 2, 400, '…so the score midpoint IS the box center');
  assert.equal(lay.leftX, 280, 'the long name sits ADJACENT to the score (no stretch)');
  assert.equal(lay.rightX, 430, 'the short name sits adjacent on the other side');

  // The box grows toward the LONGER side: 2·90 + 60 = 240 content, so the
  // box (240 + 2×8 = 256, x = (800 − 256)/2 = 272) reaches exactly
  // HUD_PAD past the long name — while the short side ends 58 px shy of
  // its edge (8 padding + the 50 px name difference = absorbed slack).
  const w = scoreLineWidth(90, 60, 40);
  assert.equal(w, 240, '2·max(left, right) + score — never the plain sum (190)');
  const x = (800 - (w + 16)) / 2;
  assert.equal(lay.leftX - x, 8, "the longer side defines the box's inset edge");
  assert.equal(x + w + 16 - (lay.rightX + 40), 58, 'the shorter side absorbs the slack');

  // mirrored: the RIGHT name is the long one now — same width, padding
  // flips to the left side.
  const mirrored = scoreLineLayout(40, 60, 90, 400);
  assert.equal(scoreLineWidth(40, 60, 90), w, 'the width does not care which side is long');
  assert.equal(mirrored.rightX + 90 - (x + w + 16), -8, 'now the right side hugs the edge');
  assert.equal(mirrored.leftX - x, 58, '…and the left side holds the slack');

  // equal names: the anchor and the old block centering agree exactly
  // (2·40 + 60 = 140 = the plain sum) — the existing equal-width HUD
  // pins below still hold character-for-character.
  assert.equal(scoreLineWidth(40, 60, 40), 140);
  const eq = scoreLineLayout(40, 60, 40, 400);
  assert.equal(eq.scoreX, 370);
  assert.equal(eq.leftX, 330);
  assert.equal(eq.rightX, 430);
});

test('hudTeamNames: the ct slot holds the team currently on CT at the playhead', () => {
  // getTeamNames is keyed by the teams' FINAL side: left = the team that
  // FINISHED ct (Replay's cardGroups), right = the one that finished t.
  const names = { ct: 'FINISHED-CT', t: 'FINISHED-T' };
  // first half: the stored pairing already matches the current sides
  assert.deepEqual(hudTeamNames(names, 'ct', 't'), { ct: 'FINISHED-CT', t: 'FINISHED-T' });
  // after the halftime switch both columns flipped → the names swap slots
  // so the renderer's per-slot CT/T colors paint the RIGHT team
  assert.deepEqual(hudTeamNames(names, 't', 'ct'), { ct: 'FINISHED-T', t: 'FINISHED-CT' });
  // one column's side is enough to decide (the other carries no payload
  // this frame — dead frames / unassigned teams report 0)
  assert.deepEqual(hudTeamNames(names, 't', ''), { ct: 'FINISHED-T', t: 'FINISHED-CT' });
  assert.deepEqual(hudTeamNames(names, '', 'ct'), { ct: 'FINISHED-T', t: 'FINISHED-CT' });
  // NO side information at all → the stored pairing, never a guessed swap
  assert.deepEqual(hudTeamNames(names, '', ''), { ct: 'FINISHED-CT', t: 'FINISHED-T' });
  // empty names survive the swap as empty (drawHUD falls back to CT / T)
  assert.deepEqual(hudTeamNames({ ct: '', t: '' }, 't', 'ct'), { ct: '', t: '' });
  assert.deepEqual(hudTeamNames(null, 't', 'ct'), { ct: '', t: '' });
});

test('HUD: score-anchored line in colored segments, label-free clock, no tick/frame counter', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const round = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  r.setHud({ score: { ct: 3, t: 2 }, teamNames: { ct: 'NAVY', t: 'FURY' }, round, tickRate: 64 });
  r.resize();

  // The score line is THREE segments laid out around the SCORE segment
  // (scoreAnchor → scoreLineLayout): 3 × 40 (harness measureText) = 120
  // → 2·40 + 40 = 120 content (equal names: the anchor and the old block
  // centering agree) → box 120 + 2×8 = 136 wide → x = (800 − 136) / 2 =
  // 332, the score starts at 332 + 68 − 20 = 340 + 40 and each name hugs
  // it (the unequal-name case is pinned on scoreLineLayout above).
  const seg = (t) =>
    canvas.log.find((e) => e.op === 'fillText' && e.args[0] === t && e.args[2] === HUD_PAD + HUD_PAD);
  const ctName = seg('NAVY');
  assert.ok(ctName, 'the score line names the TEAMS, not the sides');
  // CENTERED CONTENT, not left-inset (the old box drew one left-aligned
  // string at x + HUD_PAD; the old top-left box started at HUD_TOP_X = 52)
  assert.equal(ctName.args[1], 332 + HUD_PAD);
  assert.equal(ctName.args[2], HUD_PAD + HUD_PAD); // box top + first line
  assert.equal(ctName.fillStyle, '#5aa9e6', 'the CT team name draws in the CT side color');
  const scorePart = seg(' 3 – 2 ');
  assert.ok(scorePart, 'the score + its – separator is its own segment');
  assert.equal(scorePart.args[1], 332 + HUD_PAD + 40, 'segments step by their measured widths');
  assert.equal(scorePart.fillStyle, '#ffffff', 'the score (and separator) is white');
  // …and the SCORE segment is dead-center of the box (its midpoint is
  // 380 + 20 = 400 = 332 + 136/2) — with equal names that coincides with
  // the block center; unequal names are the pure-helper test above.
  assert.equal(scorePart.args[1] + 20, 332 + 136 / 2, 'the score midpoint is the box center');
  const tName = seg('FURY');
  assert.ok(tName, 'the T team name follows the score');
  assert.equal(tName.args[1], 332 + HUD_PAD + 80);
  assert.equal(tName.fillStyle, '#e6a35a', 'the T team name draws in the T side color');

  const texts = textsSince(canvas.log);
  const freeze = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'freeze 0:10');
  assert.ok(freeze, 'line 2 is the bare clock (freeze time at tick 0)');
  // …and the NARROW clock line centers inside the wider score box:
  // 332 + (136 − 40) / 2 = 380, on the second line (8 + 8 + 15)
  assert.equal(freeze.args[1], 332 + 48);
  assert.equal(freeze.args[2], HUD_PAD + HUD_PAD + 15);
  assert.equal(freeze.fillStyle, '#8b94a7', 'the clock keeps the gray non-first-line color');
  assert.ok(!texts.some((t) => String(t).includes('·')), 'the round label is gone');
  assert.ok(!texts.some((t) => String(t).startsWith('R1')), 'no round number in the HUD');

  // the bottom box lost its tick/frame counter but keeps the readout
  assert.ok(!texts.some((t) => String(t).startsWith('tick ')), 'the tick counter is gone');
  assert.ok(!texts.some((t) => String(t).includes('frame ')), 'the frame counter is gone');
  assert.ok(texts.includes('1×'), 'speed× stays');
  // the bottom playback box is NOT centered: its widest line starts at
  // the box's own left inset (x = HUD_PAD, content 8px in)
  const speed = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === '1×');
  assert.equal(speed.args[1], HUD_PAD + HUD_PAD, 'the playback readout keeps its left-aligned style');

  // an empty team name falls back to the bare side, in the SAME colors
  r.setHud({ score: { ct: 3, t: 2 }, teamNames: { ct: '', t: '' }, round, tickRate: 64 });
  const fbCT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'CT' && e.fillStyle === '#5aa9e6');
  const fbT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'T' && e.fillStyle === '#e6a35a');
  assert.ok(fbCT && fbT, "'CT' / 'T' fallbacks are side-colored too");

  // after hudFor's halftime re-pairing (hudTeamNames) the payload's ct
  // slot carries the OTHER team: the renderer paints whatever name sits
  // in the slot with that slot's color, so pairing is all it takes
  r.setHud({ score: { ct: 3, t: 2 }, teamNames: { ct: 'FURY', t: 'NAVY' }, round, tickRate: 64 });
  const swapCT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'FURY' && e.fillStyle === '#5aa9e6');
  const swapT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'NAVY' && e.fillStyle === '#e6a35a');
  assert.ok(swapCT && swapT, 'the swapped payload keeps the slot colors trivially correct');

  // a mid-round playhead: the 115 s round clock, still label-free
  engine.seekTick(800); // freeze ended at 640 → 7360 − 160 = 7200 t = 112 s
  r.draw();
  assert.ok(textsSince(canvas.log).includes('1:52'), 'the round clock counts the 115 s round time');
  r.destroy();
});

test('HUD clock: C4 icon line with text fallback, 0:00 after the detonation', () => {
  headlessGlobals();
  const data = synthStore(1600, 2); // frames at ticks 0…1599
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  // Round 1 plants at 1000 and DETONATES at 1400, while the round's
  // recorded endTick (1300) PRECEDES the explosion — the 0:00 has to key
  // off the plant's explode tick, never endTick. Round 2 is a DEFUSE
  // (not a detonation) and must keep today's clock behavior.
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 1000, round: 1, kind: 'bomb_plant' }), // no position → no world marker
    mk({ id: 2, seq: 2, tick: 1400, round: 1, kind: 'bomb_explode' }),
    mk({ id: 3, seq: 3, tick: 1100, round: 2, kind: 'bomb_plant' }),
    mk({ id: 4, seq: 4, tick: 1300, round: 2, kind: 'bomb_defuse' }),
  ]);
  const c4 = { width: 32, height: 32, src: 'c4.svg' };
  r.setIcons({ C4: c4 });
  const round1 = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1300, bombSite: 'A' };
  r.setHud({ score: null, teamNames: { ct: '', t: '' }, round: round1, tickRate: 64 });
  r.resize();

  // --- planted: the countdown line leads with the extracted C4 image -----
  engine.seekTick(1200); // detonation at 1400 → 200 ticks left
  let mark = canvas.log.length;
  r.draw();
  assert.ok(textsSince(canvas.log, mark).includes('0:03'), 'the planted countdown is the clock line');
  assert.ok(
    opsSince(canvas.log, 'drawImage', mark).some((e) => e.args[3] === 12),
    'the C4 image (HUD_ICON_PX) leads the line',
  );
  assert.ok(
    !textsSince(canvas.log, mark).includes('C4 0:03'),
    'no text fallback while the image is available',
  );
  // the icon slot counts toward the measured width: 12 + 4 + 40 + 2×8
  // = 72 → box x = (800 − 72) / 2 = 364, its text 8 + 12 + 4 further in
  const iconLine = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === '0:03');
  assert.equal(iconLine.args[1], 364 + HUD_PAD + 12 + 4);

  // --- no icon at all → the 'C4 0:03' text fallback ----------------------
  r.setIcons({});
  mark = canvas.log.length;
  r.draw();
  assert.ok(
    textsSince(canvas.log, mark).includes('C4 0:03'),
    "without icons the 'C4 …' text is the fallback",
  );

  // --- detonated: 0:00 until the next round starts -----------------------
  r.setIcons({ C4: c4 });
  engine.seekTick(1500); // past the 1400 explosion
  mark = canvas.log.length;
  r.draw();
  const after = textsSince(canvas.log, mark);
  assert.ok(after.includes('0:00'), 'after the detonation the clock reads 0:00');
  assert.ok(!after.includes('1:41'), 'never the 115 s round clock after the blast (6500 t)');
  assert.ok(!after.some((t) => String(t).startsWith('C4 ')), 'not planted anymore → no C4 line');

  // --- a DEFUSED plant keeps the normal clock ----------------------------
  r.setHud({
    score: null,
    teamNames: { ct: '', t: '' },
    round: { number: 2, label: 'R2', startTick: 1000, freezeEndTick: 1600, endTick: 1500, bombSite: 'B' },
    tickRate: 64,
  });
  engine.seekTick(1400); // planted 1100, defused at 1300 — not a detonation
  mark = canvas.log.length;
  r.draw();
  const defused = textsSince(canvas.log, mark);
  assert.ok(
    defused.some((t) => String(t).startsWith('freeze ')),
    'a defused plant falls through to the ordinary round clock',
  );
  assert.ok(!defused.includes('0:00'), 'a defuse is NOT a detonation');
  r.destroy();
});

test('HUD freeze line: codicon clock glyph when the font is loaded, word otherwise', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const round = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };

  // stubbed document.fonts.check → FALSE: exactly today's text line
  const probes = [];
  globalThis.document.fonts = {
    check: (f) => {
      probes.push(f);
      return false;
    },
  };
  r.setHud({ score: null, teamNames: { ct: '', t: '' }, round, tickRate: 64 });
  r.resize(); // first draw (setHud ran before the canvas had a size)
  let mark = canvas.log.length;
  r.draw();
  let texts = textsSince(canvas.log, mark);
  assert.ok(texts.includes('freeze 0:10'), 'check() false → the literal word stays');
  assert.ok(!texts.includes(CLOCK_GLYPH), 'no glyph without the loaded font');
  assert.ok(
    probes.includes('16px codicon'),
    "availability is probed with document.fonts.check('16px codicon')",
  );

  // stubbed document.fonts.check → TRUE: the codicon clock REPLACES the word
  globalThis.document.fonts = {
    check: (f) => f === '16px codicon',
  };
  mark = canvas.log.length;
  r.draw();
  texts = textsSince(canvas.log, mark);
  assert.ok(!texts.includes('freeze 0:10'), 'the word is gone once the glyph can draw');
  const glyph = canvas.log.slice(mark).find((e) => e.op === 'fillText' && e.args[0] === CLOCK_GLYPH);
  assert.ok(glyph, 'the codicon clock glyph (\\uea82) leads the line');
  assert.equal(glyph.font, '12px codicon', 'drawn in the codicon family');
  assert.equal(glyph.fillStyle, '#fbac18', "line 1 keeps the first line's amber styling");
  // Geometry with the harness's 40 px measureText: glyph 40 + gap 4 +
  // time 40 = 84 → box 84 + 2×8 = 100 → x = (800 − 100) / 2 = 350;
  // centered content starts at 350 + 8 and the re-measured time follows
  // the glyph width + gap.
  assert.equal(glyph.args[1], 350 + HUD_PAD);
  const time = canvas.log.slice(mark).find((e) => e.op === 'fillText' && e.args[0] === '0:10');
  assert.ok(time, 'the countdown text follows the glyph');
  assert.equal(time.args[1], 350 + HUD_PAD + 40 + 4);
  assert.equal(
    time.font,
    '12px ui-monospace, SFMono-Regular, Menlo, monospace',
    'the time text keeps the plain HUD font',
  );
  r.destroy();
});

test('kill feed: round-scoped entries, killer-team outline, weapon image/arrow, side names', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  const round1 = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  r.setLandmarks([
    // no positions → the world layers (death X) stay out of the way
    mk({ id: 1, seq: 1, tick: 50, round: 1, kind: 'kill', attacker: '1', attackerName: 'alice', victim: '2', victimName: 'bob', weapon: 'AK-47' }),
    mk({ id: 2, seq: 2, tick: 60, round: 1, kind: 'kill', attacker: '2', attackerName: 'bob', victim: '1', victimName: 'alice', weapon: 'awp' }),
    mk({ id: 3, seq: 3, tick: 700, round: 2, kind: 'kill', attacker: '1', attackerName: 'alice', victim: '2', victimName: 'bob', weapon: 'AK-47' }),
  ]);
  const ak = { width: 32, height: 32, src: 'ak.svg' };
  r.setIcons({ 'AK-47': ak }); // 'awp' deliberately has no image
  r.setHud({ score: { ct: 0, t: 0 }, teamNames: { ct: '', t: '' }, round: round1, tickRate: 64 });
  r.resize();

  engine.seekTick(100);
  let mark = canvas.log.length;
  r.draw();

  // two entries, NEWEST ON TOP (tick 60 above tick 50), right-aligned:
  // measureText is 40 and each name↔mark gap is 12 → the arrow line is
  // 12 + 40 + 12 + 40 + 12 + 40 = 156 wide (x = 800 − 8 − 156 = 636) and
  // the icon line 12 + 40 + 12 + 14 + 12 + 40 = 130 (x = 800 − 8 − 130 =
  // 662); the rows sit on the 22 px PITCH (18 px box + 4 px gap), so the
  // boxes never touch.
  const boxes = feedBoxesSince(canvas.log, mark);
  assert.equal(boxes.length, 2, 'both round-1 kills up to the playhead');
  // ROUNDED corners: each entry is ONE roundRect path (r = 4) shared by
  // its fill and stroke — the HUD boxes' roundRects use r = 6 / other
  // heights, so filtering on height + radius is feed-only.
  const rounded = opsSince(canvas.log, 'roundRect', mark).filter(
    (e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R,
  );
  assert.equal(rounded.length, 2, 'both entry boxes are rounded, one shared path each');
  assert.deepEqual(
    rounded.map((e) => [e.args[0], e.args[1], e.args[2]]),
    [
      [636, 8, 156], // [x, y, w] — the arrow entry, right-aligned at cssW − 8
      [662, 30, 130], // the icon entry, one PITCH (18 + 4) below
    ],
  );
  const top = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'bob' && e.args[2] === 12);
  assert.equal(top.args[1], 636 + 6, 'the newest entry is right-aligned at cssW − 8');
  assert.equal(top.fillStyle, '#e6a35a', "the KILLER's outline/name use the killer's side (T)");
  const lower = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice' && e.args[2] === 34);
  assert.equal(lower.args[1], 662 + 6);
  assert.equal(lower.fillStyle, '#5aa9e6', 'the CT killer is CT-colored');

  // outline = the killer's team color, 1px, full alpha (nothing else in
  // the frame strokes that combination: trails/arrow draw at alpha ≤ 0.5)
  const lines = (color) =>
    opsSince(canvas.log, 'stroke', mark).filter(
      (e) => e.strokeStyle === color && e.lineWidth === 1 && e.alpha === 1,
    );
  assert.equal(lines('#e6a35a').length, 1, 'the T killer’s box is outlined in T');
  assert.equal(lines('#5aa9e6').length, 1, 'the CT killer’s box is outlined in CT');

  // victim names are tinted by the VICTIM's side — RIGHT-aligned, so the
  // wider icon gaps don't move them: 800 − 8 − 6 − 40 = 746 on both rows
  // (the rows themselves moved to y = 12 / 34 on the new pitch)
  const victimT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'bob' && e.args[2] === 34);
  assert.equal(victimT.args[1], 746);
  assert.equal(victimT.fillStyle, '#e6a35a');
  const victimCT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice' && e.args[2] === 12);
  assert.equal(victimCT.args[1], 746);
  assert.equal(victimCT.fillStyle, '#5aa9e6');

  // weapon: the canonical name's image when the manifest has one…
  const weaponImgs = opsSince(canvas.log, 'drawImage', mark).filter((e) => e.args[3] === 14);
  assert.equal(weaponImgs.length, 1, 'one weapon image (KILL_FEED_ICON)');
  // …sitting 12 px right of the killer name (box x + inset + name width),
  // with the victim's 12 px left gap closing the icon's other side
  assert.equal(weaponImgs[0].args[1], 662 + 6 + 40 + 12, 'a 12 px gap on EACH side of the icon');
  // …and a plain arrow when it does not — on the same 12 px footing
  const arrow = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === '→' && e.args[2] === 12);
  assert.ok(arrow, 'a weapon with no image falls back to →');
  assert.equal(arrow.args[1], 636 + 6 + 40 + 12, 'the arrow gets the same 12 px lead-in gap');

  // --- round change clears the feed ---------------------------------------
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 2, label: 'R2', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  engine.seekTick(800); // round-2 kill at 700 is now in scope
  mark = canvas.log.length;
  r.draw();
  assert.equal(feedBoxesSince(canvas.log, mark).length, 1, 'the feed clears to the new round');
  assert.equal(
    opsSince(canvas.log, 'drawImage', mark).filter((e) => e.args[3] === 14).length,
    1,
    'only the round-2 kill remains',
  );
  assert.ok(
    !textsSince(canvas.log, mark).includes('→'),
    "the round-1 'awp' entry is gone with its round",
  );

  // --- a backwards scrub re-derives the old round's feed -------------------
  r.setHud({ score: { ct: 0, t: 0 }, teamNames: { ct: '', t: '' }, round: round1, tickRate: 64 });
  engine.seekTick(100);
  mark = canvas.log.length;
  r.draw();
  assert.equal(feedBoxesSince(canvas.log, mark).length, 2, 'scrubbing back redraws the feed');
  r.destroy();
});

test('kill feed: capped at 6 entries, newest on top', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks(
    Array.from({ length: 8 }, (_, i) =>
      mk({
        id: i + 1,
        seq: i + 1,
        tick: (i + 1) * 10,
        round: 1,
        kind: 'kill',
        attacker: '1',
        attackerName: `p${i + 1}`,
        victim: '2',
        victimName: `v${i + 1}`,
        weapon: 'AK-47',
      }),
    ),
  );
  r.setIcons({ 'AK-47': { width: 32, height: 32, src: 'ak.svg' } });
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();

  engine.seekTick(100); // all 8 kills are in the past
  const mark = canvas.log.length;
  r.draw();
  assert.equal(feedBoxesSince(canvas.log, mark).length, 6, 'the feed shows at most KILL_FEED_MAX');
  assert.equal(
    opsSince(canvas.log, 'drawImage', mark).filter((e) => e.args[3] === 14).length,
    6,
    'one line per surviving entry',
  );
  const texts = textsSince(canvas.log, mark);
  assert.ok(
    canvas.log.some((e) => e.op === 'fillText' && e.args[0] === 'p8' && e.args[2] === 12),
    'the newest kill sits on TOP',
  );
  assert.ok(!texts.includes('p1') && !texts.includes('p2'), 'the two oldest entries are dropped');
  r.destroy();
});
