// Tests for the replay renderer's PURE helpers (lib/replay/renderer.js):
// the trail-continuity rule (trailConnects — the break that keeps player
// movement trails from streaking across a round reset or a
// death→respawn teleport), the smart camera's fit/ease (smartCamTarget,
// easeValue, camConverged), the world-layer geometry (chevronPath,
// crossPath, muzzleRays), the tick-window effects (windowAlpha,
// blindAlpha, voiceBloom), the death-marker lifetime
// (killEndTick) — plus end-to-end draws over a recording 2D context
// (the world layers follow the tick: lingering smoke/fire, the death
// X's round cleanup incl. the post-round C4 kill and the EXACT
// round_start boundary seek, the C4 icon and its aspect-preserving
// draw, the traveling-dash bullet tracer (a 14 px side-colored dash per
// row sliding from the fire position out r+MUZZLE_REACH over its 0.1 s
// travel — miss fades out on the way, mask-guarded + under the dots),
// the hit-shot tracer (the shooter→victim dash over the same travel —
// its skips, pellet dedupe, NO-fade alpha, shooter-side colors and layer
// order), the
// LIGHTER flash overlay (peak 0.6, never solid
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
// C4/0:00 clock, the tick/frame-free playback readout (and the speed×
// line's removal: no speed text, no empty readout box) — plus the
// round-scoped kill feed with its rounded entry boxes, image cells that
// reserve their PAINTED width (a 12 px gap on each side of every cell),
// the append-at-bottom stack (oldest on top) and the 22 px entry pitch,
// the round-scoped bottom-left chat
// (round/round-change/scrub scoping, speaker colors, the 6-cap stack
// newest-at-bottom, message truncation, the readout stacked above it)
// and the ONE entry-box painter both overlays share).
// Run: node --test src/lib/renderer.test.js (from frontend/; the lib test
// glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  trailConnects,
  smartCamTarget,
  easeValue,
  camConverged,
  flightSplits,
  chevronPath,
  crossPath,
  muzzleRays,
  windowAlpha,
  blindAlpha,
  voiceBloom,
  shotBloom,
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

// --- world-layer geometry (view arrow, death X, tracer rays) ----------------

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
  // direction — the PATH the bullet tracer's dash rides (from the fire
  // position, reach r+MUZZLE_REACH; inner 0 in drawBulletTracers — the
  // trace starts AT the origin, not at a dot).
  const line = muzzleRays(10, 20, 0.5, 0, 23, 1, 0);
  assert.equal(line.length, 1);
  const [x1, y1, x2, y2] = line[0];
  assert.ok(Math.abs(Math.hypot(x1 - 10, y1 - 20) - 0) < 1e-9, 'starts at the origin');
  assert.ok(Math.abs(Math.hypot(x2 - 10, y2 - 20) - 23) < 1e-9, 'ends on the outer circle');
  // …and both ends sit exactly on the look axis (straight, not fanned)
  const ux = Math.cos(0.5);
  const uy = Math.sin(0.5);
  assert.ok(Math.abs((x1 - 10) * uy - (y1 - 20) * ux) < 1e-9, 'inner end collinear');
  assert.ok(Math.abs((x2 - 10) * uy - (y2 - 20) * ux) < 1e-9, 'outer end collinear');
});

// --- tick-window effects (damage flash, tracer) -----------------------------

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

// The fireJump test (seek/frame-jump detector for the attack-edge firing
// indicator) was DELETED with that machinery: tracers no longer arm from
// state edges, so there is no edge state to re-seed across a seek —
// bullets.js's rows are seek-correct by construction (a pure function of
// tick over pre-derived rows). Shot derivation (magAmmo steps, gun/freeze
// filtering) is pinned by frontend/src/lib/bullets.test.js.

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
// Travel constants mirrored from renderer.js (TRAVEL_S = 0.1 s — the
// whole lifetime of BOTH tracer kinds): expressed as the SAME expression
// (0.1 * 64) so the progress doubles match the renderer's bit-for-bit.
const TRAVEL_TICKS = 0.1 * 64; // = 6.4 ticks of travel at 64 Hz

// expectedDash — the dash's exact [x1, y1, x2, y2] for a path
// (ax, ay) → (bx, by) at progress p: mirrors strokeTracer's mapping
// (d = min(dash, len); head = d + p·(len − d); tail = head − d ≥ 0), so
// tests pin the traveling-dash geometry without importing renderer
// internals.
function expectedDash(ax, ay, bx, by, p, dash = 14) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  const d = Math.min(dash, len);
  const head = d + p * (len - d);
  const ux = dx / len;
  const uy = dy / len;
  return [ax + ux * (head - d), ay + uy * (head - d), ax + ux * head, ay + uy * head];
}

// segStart — a recorded lineTo carries only its ENDPOINT [x, y]; the
// segment's START is the nearest preceding moveTo/lineTo of the same
// subpath. Returns that [x, y] (or null at the log's edge).
function segStart(seq, i) {
  for (let j = i - 1; j >= 0; j--) {
    const op = seq[j].op;
    if (op === 'moveTo' || op === 'lineTo') return seq[j].args;
  }
  return null;
}

// segLen — the length of the segment that `seq[i]` (a lineTo) closes.
// The static synth fixtures stroke ZERO-length movement-trail segments
// (team-colored, 2 px — indistinguishable from tracer tops by style
// alone), so every tracer filter measures the segment and drops them.
function segLen(seq, i) {
  const s = segStart(seq, i);
  return s ? Math.hypot(seq[i].args[0] - s[0], seq[i].args[1] - s[1]) : 0;
}
//
// The world layers are only exercised by actually calling draw(); this
// drives createRenderer headlessly (node has no canvas) with a context
// that RECORDS every op instead of painting, and pins the tick-derived
// behavior the specs ask for: the lingering smoke reaches the renderer
// through the typed bucket, the death X lives exactly as long as its
// round (and comes back on a backwards scrub), the extracted C4 icon
// replaces the 'C4' label (text fallback without icons), the traveling
// bullet tracer slides a short dash per row (EVERY row — no selection)
// over its 0.1 s travel, the
// damage flash, the lighter flash overlay and the under-dot talking
// bloom are pure functions of tick.

// recordingCanvas: { log, getContext, clientWidth/Height } — a stand-in
// canvas whose 2D context records stroke/fill/arc/drawImage/fillText/
// roundRect/moveTo/lineTo/setLineDash ops together with the stroke/fill
// style, lineCap, lineWidth, lineDash, lineDashOffset, globalAlpha, font
// and textAlign in force. measureText reports the FLAT 40 px by default
// (every box-geometry assertion stays exact); pass `measure` to make it
// length-aware — only the chat's truncation test needs real widths
// (a flat width can never exceed any budget, so nothing would ever cut).
function recordingCanvas(cssW = 800, cssH = 600, measure = () => 40) {
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
        if (prop === 'measureText') return { width: measure(String(args[0] ?? '')) };
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

test('world layers follow the tick: smoke/fire, death X, C4 icon, bullet tracer, hits, voice, blind', () => {
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
  // The tracer rows: pre-derived exactly as Replay.svelte pushes them
  // (lib/replay/bullets.js is the ONE filter — gun/freeze filtering is
  // its tests' job, src/lib/bullets.test.js; the renderer only travels
  // and paints). One shot at alice's frame 192 — EVERY row animates
  // (no `draw` field exists anymore).
  r.setBullets([{ tick: 192, frame: 192, slot: 0, weapon: 'AK-47' }]);
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
  // The tracer paint recipe (strokeTracer): a side-colored 2 px lineTo
  // over a dark 4 px underlay, NO marching dash (the travel is GEOMETRY
  // — the head moves because progress moves, never because a pattern
  // marches) — shared by the bullet tracer and the hit-shot tracer, so
  // these filters see BOTH whenever their travels overlap. Tops match
  // the side colors (+ the unknown-side white) and a NONZERO segment:
  // the static fixture's movement trails stroke zero-length team-colored
  // lineTos, which must never count as tracers (segLen). `bulletDash`
  // picks the bullet line out by its geometry (it rides the EAST axis
  // from alice's fire position — the hit line rides the diagonal to the
  // victim).
  const tracerTops = (from = 0) => {
    const seq = since(from);
    const out = [];
    for (let i = 0; i < seq.length; i++) {
      const e = seq[i];
      if (e.op !== 'lineTo' || e.lineWidth !== 2) continue;
      if (e.strokeStyle !== '#5aa9e6' && e.strokeStyle !== '#e6a35a' && e.strokeStyle !== '#ffffff') continue;
      if (segLen(seq, i) <= 0) continue; // zero-length trail segments
      out.push(e);
    }
    return out;
  };
  const tracerDarks = (from = 0) =>
    since(from).filter(
      (e) => e.op === 'lineTo' && e.strokeStyle === 'rgba(0,0,0,0.45)' && e.lineWidth === 4,
    );
  const ORIGIN = r.worldToScreen(10, 10); // alice's fire position (free camera — stable)
  const bulletDash = (from = 0) => {
    const seq = since(from);
    for (let i = 0; i < seq.length; i++) {
      const e = seq[i];
      if (e.op !== 'lineTo' || e.lineWidth !== 2) continue;
      if (e.strokeStyle !== '#5aa9e6' && e.strokeStyle !== '#e6a35a' && e.strokeStyle !== '#ffffff') continue;
      if (Math.abs(segLen(seq, i) - 14) > 1e-9) continue; // exactly one dash long
      const s = segStart(seq, i);
      if (!s) continue;
      // on the east axis (yaw 0) from the origin, heading forward —
      // which excludes the hit tracer's diagonal (different geometry)
      if (Math.abs(s[1] - ORIGIN.y) > 1e-9 || Math.abs(e.args[1] - ORIGIN.y) > 1e-9) continue;
      if (s[0] < ORIGIN.x - 1e-9 || e.args[0] < s[0] - 1e-9) continue;
      return e;
    }
    return undefined;
  };

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

  // --- bullet tracers: a traveling dash per row over its 0.1 s travel ------
  // (EVERY row animates — the `draw` selection was retired by spec;
  // rows pushed via setBullets exactly as Replay.svelte derives them —
  // gun/freeze filtering is bullets.js's contract, tested in
  // src/lib/bullets.test.js; the renderer only travels and paints.)
  // The fixture's damage row (tick 193) also carries a LIVE hit tracer
  // over 193..199, so bullet assertions filter by geometry (bulletDash).
  mark = canvas.log.length;
  engine.seekTick(191); // one tick BEFORE the row's tick
  r.draw();
  assert.equal(tracerTops(mark).length, 0, 'nothing draws before the shot tick');
  mark = canvas.log.length;
  engine.seekTick(192); // the shot's own tick — progress 0
  r.draw();
  const atShot = bulletDash(mark);
  assert.ok(atShot, 'ONE side-colored dash for the bullet row (not a fan, not a full line)');
  assert.equal(tracerDarks(mark).length, 1, '…over its dark 4 px underlay');
  assert.ok(
    !strokes(mark).some((e) => e.strokeStyle === '#ffd982'),
    'the tracer is side-colored — the old amber muzzle ray is gone',
  );
  // …and the side color: alice (the shooter) is CT, so the stroke is
  // the CT color, not the old neutral white (color spec of the rework).
  assert.equal(atShot.strokeStyle, '#5aa9e6', "the dash carries the SHOOTER's side color (alice is CT)");
  // NO MARCHING DASH: both of the tracer's passes record an EMPTY dash
  // and zero offset in their lineTo snapshot (the travel is GEOMETRY —
  // the head moves because progress moves, never because a pattern
  // marches), and strokeTracer sets no dash between the two passes. The
  // frame's one non-empty setLineDash belongs to the dropped-C4 ring — a
  // different effect that resets after itself.
  {
    const seq = since(mark);
    const dark0 = seq.findIndex(
      (e) => e.op === 'lineTo' && e.strokeStyle === 'rgba(0,0,0,0.45)' && e.lineWidth === 4,
    );
    const top0 = seq.indexOf(atShot);
    assert.ok(dark0 >= 0 && top0 > dark0, 'the dark underlay precedes the colored pass');
    let move0 = dark0;
    while (move0 >= 0 && seq[move0].op !== 'moveTo') move0--;
    assert.equal(
      seq.slice(move0, top0).filter((e) => e.op === 'setLineDash').length,
      0,
      'strokeTracer never sets a dash while painting (the travel is geometry)',
    );
    assert.ok(
      [seq[dark0], seq[top0]].every((e) => e.lineDash.length === 0 && e.lineDashOffset === 0),
      'both tracer passes record an empty dash, offset 0 (no marching pattern)',
    );
  }
  // Geometry at the shot tick (progress 0): the DASH sits fully at the
  // FIRE POSITION at row.frame (alice stands at (10,10) there — yaw 0 =
  // east): a 14 px segment FROM the ORIGIN toward the path's end at
  // r + MUZZLE_REACH = 9 + 76 = 85 px out — a short dash, NOT the old
  // full-length solid line (the traveling-dash contract).
  {
    const end = atShot;
    const start = since(mark)
      .slice(0, since(mark).indexOf(end))
      .reverse()
      .find((e) => e.op === 'moveTo');
    assert.ok(start, 'the segment starts with a moveTo');
    assert.ok(
      Math.abs(start.args[0] - ORIGIN.x) < 1e-9 && Math.abs(start.args[1] - ORIGIN.y) < 1e-9,
      `starts at the fire position (got ${start.args})`,
    );
    assert.ok(
      Math.abs(end.args[0] - (ORIGIN.x + 14)) < 1e-9 && Math.abs(end.args[1] - ORIGIN.y) < 1e-9,
      `the head sits 14 px out the origin at progress 0 (got ${end.args})`,
    );
    // Layer order: the tracer strokes UNDER the player dots — the dots
    // paint on top of its endpoints (draw() calls drawBulletTracers
    // before drawPlayers).
    const dotIdx = since(mark).findIndex(
      (e) => e.op === 'arc' && e.fillStyle === '#5aa9e6' && e.args[2] === 9,
    );
    assert.ok(dotIdx >= 0, 'the CT dot draws in this frame');
    assert.ok(
      since(mark).indexOf(end) < dotIdx,
      'the bullet tracer draws BEFORE the player dots (layer order)',
    );
  }
  assert.equal(atShot.alpha, 1, 'full alpha on the shot tick');
  // …the dash TRAVELS and a MISS FADES with progress: 3/6.4 ticks in
  // (tick 195) the head has slid ~halfway along the path and the alpha
  // is exactly 1 − progress (linear — the "fade out on the way to the
  // end point" curve), frozen-while-paused because it is pure tick math.
  mark = canvas.log.length;
  engine.seekTick(195);
  r.draw();
  const mid = bulletDash(mark);
  assert.ok(mid, 'still drawn mid-travel');
  {
    const p = 3 / TRAVEL_TICKS;
    const want = expectedDash(ORIGIN.x, ORIGIN.y, ORIGIN.x + 85, ORIGIN.y, p);
    assert.ok(
      Math.abs(mid.args[0] - want[2]) < 1e-9 && Math.abs(mid.args[1] - want[3]) < 1e-9,
      `the head sits at progress on the path (got ${mid.args}, want [${want[2]}, ${want[3]}])`,
    );
    // mid-path: it left the origin, has not arrived, and its center is
    // within half a dash of the path midpoint (the playhead is
    // tick-quantized — 6.4 ticks per travel — so p ≈ 0.47, not 0.5)
    const seqM = since(mark);
    const sMid = segStart(seqM, seqM.indexOf(mid));
    const tailX = sMid[0];
    const headX = mid.args[0];
    const center = (tailX + headX) / 2;
    assert.ok(tailX > ORIGIN.x, 'the tail left the origin');
    assert.ok(headX < ORIGIN.x + 85, 'the head has not arrived at the end point');
    assert.ok(Math.abs(center - (ORIGIN.x + 42.5)) < 7, `center near the path midpoint (got ${center})`);
    assert.ok(
      Math.abs(mid.alpha - (1 - p)) < 1e-9,
      `the miss alpha decays linearly with progress (got ${mid.alpha}, want ${1 - p})`,
    );
  }
  // …and it is gone exactly when the travel ends (0.1 s = 6.4 ticks —
  // alpha 0 at the end point), while the HIT tracer from tick 193 is
  // still travelling (contrast pinned in the hit-tracer test):
  mark = canvas.log.length;
  engine.seekTick(199); // 7 ticks after the shot > 6.4 — miss arrived
  r.draw();
  assert.equal(bulletDash(mark), undefined, 'the miss dash self-clears at travel end');
  mark = canvas.log.length;
  engine.seekTick(260);
  r.draw();
  assert.equal(tracerTops(mark).length, 0, 'every tracer is gone after its travel');
  // frozen while paused: a redraw at the SAME tick records identical ops
  mark = canvas.log.length;
  engine.seekTick(195);
  r.draw();
  const frozenA = bulletDash(mark);
  mark = canvas.log.length;
  engine.seekTick(195);
  r.draw();
  const frozenB = bulletDash(mark);
  assert.ok(frozenA, 'still live at 195 on the redraw');
  assert.deepEqual(frozenB, frozenA, 'a paused redraw is byte-identical (frozen)');

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

test('planted C4: drawn before its cutoff, gone AT round_end / bomb_explode / the next round_start', () => {
  // The planted-marker mirror of the death-X regression above (drawDeaths
  // got both fixes first: the round_start terminator, commit 5b21c4f, and
  // the gone-AT-the-boundary test, commit 5dc0f93). The old drawBomb
  // `tick > endTick` drew the marker AT its cutoff, so a paused seek to
  // the boundary tick never cleared it, and a plant past its own
  // round_end rode the 40 s fallback into the next round. Every plant
  // here carries a POSITION — the HUD-clock fixture's plant deliberately
  // has none and never draws a world marker.
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
    // round 1: planted at 192, terminated by round 1's round_end (400)
    mk({ id: 1, seq: 1, tick: 192, round: 1, kind: 'bomb_plant', posX: 50, posY: 50 }),
    mk({ id: 2, seq: 2, tick: 400, round: 1, kind: 'round_end' }),
    mk({ id: 3, seq: 3, tick: 450, round: 2, kind: 'round_start' }),
    // round 2: planted at 500, terminated by its own bomb_explode (600)
    mk({ id: 4, seq: 4, tick: 500, round: 2, kind: 'bomb_plant', posX: 60, posY: 60 }),
    mk({ id: 5, seq: 5, tick: 600, round: 2, kind: 'bomb_explode' }),
    mk({ id: 6, seq: 6, tick: 650, round: 3, kind: 'round_start' }),
    // round 3: planted at 700 with NO round_end loaded — the next
    // round's round_start (800) is its only cutoff (the leak case)
    mk({ id: 7, seq: 7, tick: 700, round: 3, kind: 'bomb_plant', posX: 70, posY: 70 }),
    mk({ id: 8, seq: 8, tick: 800, round: 4, kind: 'round_start' }),
  ]);
  r.resize();
  // The planted marker's SOLID orange pulse ring (the dropped C4's ring
  // is the 0.9-alpha DASHED one — no bomb_drop in this fixture).
  const plantedRing = (from) =>
    canvas.log
      .slice(from)
      .filter((e) => e.op === 'stroke' && e.strokeStyle === 'rgba(251, 172, 24, 0.95)');
  const at = (tick) => {
    const m = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return plantedRing(m).length;
  };

  // --- the round_end cutoff ---------------------------------------------
  assert.ok(at(200) > 0, 'drawn after the plant, before the round_end');
  assert.ok(at(399) > 0, 'still drawn the tick before the round_end');
  assert.equal(at(400), 0, 'gone AT round_end — not one tick after it');
  assert.equal(at(401), 0, 'and still gone a tick into the next frame');
  // --- the bomb_explode cutoff ------------------------------------------
  assert.ok(at(550) > 0, "round 2's plant draws before its explosion");
  assert.equal(at(600), 0, 'gone AT the bomb_explode tick');
  // --- the next round_start cutoff (no round_end loaded) -----------------
  assert.ok(at(750) > 0, 'the no-round_end plant draws (the leak case)');
  assert.equal(at(800), 0, 'gone AT the next round_start — never the 40 s fallback');
  // scrubbing back re-derives it (nothing sticky, like the death X)
  assert.ok(at(760) > 0, 'a backwards scrub redraws the marker');
  r.destroy();
});

test('hit shots: a shooter→victim traveling dash over the hit travel (no-fade, deduped, side-colored)', () => {
  // Spec: "if the shot is a hit, it should draw that shot's tracer from
  // the shooter to the opponent" — IN ADDITION to the bullet tracer, as
  // the SAME traveling dash over the same TRAVEL_S travel (pure tick
  // math, so seek-correct and frozen while paused) painted by the shared
  // strokeTracer (dark 4 px underlay + side-colored 2 px top; no
  // marching dashes — the travel is geometry). A HIT NEVER FADES: full
  // alpha until the head arrives, then the dash is gone (contrast: a
  // MISS fades with progress — pinned in the bullet-tracer block). The
  // victim's hit position rides the row (extract stamps PlayerHurt's
  // victim position); the SHOOTER has no stored apos on damage rows
  // (events.apos_* is kill-only), so its position comes from the
  // position stream at the hit's tick. Stroke = the ATTACKER's side at
  // the hit's tick (alice is CT → #5aa9e6 — see the color test for T /
  // unknown).
  headlessGlobals();
  const data = synthStore(1300, 3); // slots 0/1/2 stand at (10,10)/(50,50)/(90,90)
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [
      { steamId: '1', name: 'alice', side: 'ct' },
      { steamId: '2', name: 'bob', side: 't' },
      { steamId: '3', name: 'carol', side: 'ct' },
    ],
  });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    // THE basic hit: alice (slot 0) → bob, the hit position stored on the row
    mk({ id: 1, seq: 1, tick: 192, round: 1, kind: 'damage', attacker: '1', victim: '2', weapon: 'ak47', dmg: 30, posX: 50, posY: 50 }),
    // world/fall damage: extract's keyStr(0) → NO attacker → no shooter
    mk({ id: 2, seq: 2, tick: 400, round: 1, kind: 'damage', attacker: '', victim: '2', weapon: '', dmg: 10, posX: 40, posY: 40 }),
    // no stored hit position → no line (never a guessed one)
    mk({ id: 3, seq: 3, tick: 600, round: 1, kind: 'damage', attacker: '1', victim: '2', weapon: 'ak47', dmg: 10, posX: null, posY: null }),
    // shooter outside the roster → no stream sample → no line
    mk({ id: 4, seq: 4, tick: 800, round: 1, kind: 'damage', attacker: '999', victim: '2', weapon: 'ak47', dmg: 10, posX: 50, posY: 50 }),
    // pellet rows: two IDENTICAL rows (same tick/attacker/victim) are ONE
    // line; a second victim at the same tick gets her own line
    mk({ id: 5, seq: 5, tick: 1100, round: 2, kind: 'damage', attacker: '1', victim: '2', weapon: 'xm1014', dmg: 6, posX: 50, posY: 50 }),
    mk({ id: 6, seq: 6, tick: 1100, round: 2, kind: 'damage', attacker: '1', victim: '2', weapon: 'xm1014', dmg: 6, posX: 50, posY: 50 }),
    mk({ id: 7, seq: 7, tick: 1100, round: 2, kind: 'damage', attacker: '1', victim: '3', weapon: 'xm1014', dmg: 6, posX: 90, posY: 90 }),
    // the shooter has NO sample in the store at the hit's frame (the
    // stream only samples alive slots) → no line
    mk({ id: 8, seq: 8, tick: 1250, round: 2, kind: 'damage', attacker: '1', victim: '2', weapon: 'ak47', dmg: 30, posX: 50, posY: 50 }),
  ]);
  r.resize();
  // FREE camera: the smart camera eases once per draw, which would move
  // the screen coords out from under an assertion — free freezes the
  // transform so worldToScreen below is stable across every draw.
  r.setCameraMode('free');

  // The tracer's two passes: the side-colored 2 px line over its dark
  // 4 px underlay, both with an EMPTY dash (the travel is GEOMETRY, not
  // a marching pattern; no bullet rows in this fixture — setBullets was
  // never called, so only the hit tracers draw). segLen keeps the static
  // fixture's zero-length team-colored trail lineTos out of the counts.
  const segs = (seq, strokeStyle, lineWidth) => {
    const out = [];
    for (let i = 0; i < seq.length; i++) {
      const e = seq[i];
      if (
        e.op === 'lineTo' &&
        e.strokeStyle === strokeStyle &&
        e.lineWidth === lineWidth &&
        e.lineDash.length === 0 &&
        segLen(seq, i) > 0
      ) {
        out.push(e);
      }
    }
    return out;
  };
  const at = (tick) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return { mark, seq: canvas.log.slice(mark) };
  };
  const aliceIn = (shot) => segs(shot.seq, '#5aa9e6', 2); // alice = CT → her side-colored tops
  const darkIn = (shot) => segs(shot.seq, 'rgba(0,0,0,0.45)', 4);

  // --- the dash: shooter → victim, shared recipe --------------------------
  const hit = at(192);
  const tops = aliceIn(hit);
  const dark = darkIn(hit);
  assert.equal(tops.length, 1, 'ONE side-colored segment on the hit tick');
  assert.equal(dark.length, 1, '…over its dark 4 px underlay (the shared recipe)');
  const from = r.worldToScreen(10, 10); // alice's sampled position (slot 0)
  const to = r.worldToScreen(50, 50); // the row's stored victim position
  assert.ok(
    Math.hypot(to.x - from.x, to.y - from.y) > 14,
    'fixture sanity: the path is longer than one dash',
  );
  const wIdx = hit.seq.indexOf(tops[0]);
  const start = hit.seq.slice(0, wIdx).reverse().find((e) => e.op === 'moveTo');
  assert.ok(start, 'the segment starts with a moveTo');
  assert.ok(
    Math.abs(start.args[0] - from.x) < 1e-9 && Math.abs(start.args[1] - from.y) < 1e-9,
    `starts at the shooter's screen position (got ${start.args})`,
  );
  // Geometry at the hit tick (progress 0): a 14 px dash AT the shooter,
  // head pointing toward the victim — NOT a full shooter→victim line
  // (the traveling-dash contract): the head keeps sliding and lands on
  // the victim by travel end (asserted in the timing block below).
  {
    const want = expectedDash(from.x, from.y, to.x, to.y, 0);
    assert.ok(
      Math.abs(tops[0].args[0] - want[2]) < 1e-9 && Math.abs(tops[0].args[1] - want[3]) < 1e-9,
      `the dash head sits at the origin end of the path (got ${tops[0].args}, want [${want[2]}, ${want[3]}])`,
    );
  }
  assert.equal(tops[0].strokeStyle, '#5aa9e6', "the stroke is the ATTACKER's side color (alice is CT)");
  assert.equal(tops[0].alpha, 1, 'full alpha at the hit tick');
  assert.equal(tops[0].lineDash.length, 0, 'no marching dash pattern — travel is geometry');
  assert.equal(tops[0].lineDashOffset, 0, 'no dash phase to advance');
  // Layer order: the tracer paints UNDER the player dots (draw() calls
  // drawHitTracers before drawPlayers) so it reads as emerging from the
  // shooter's dot and can never cover a dot or a name label.
  {
    const dotIdx = hit.seq.findIndex(
      (e) => e.op === 'arc' && e.fillStyle === '#5aa9e6' && e.args[2] === 9,
    );
    assert.ok(dotIdx >= 0, 'the CT dot draws in this frame');
    assert.ok(wIdx < dotIdx, 'the hit tracer draws BEFORE the player dots');
  }

  // --- timing: the travel window, tick-derived -----------------------------
  assert.equal(aliceIn(at(191)).length, 0, 'nothing before the hit tick');
  const midShot = at(192 + 3); // 3/6.4 ticks into the 0.1 s travel
  const midTop = aliceIn(midShot)[0];
  assert.ok(midTop, 'still travelling mid-window');
  assert.equal(midTop.alpha, 1, 'a HIT never fades — full alpha mid-travel (the miss would be 1 − p here)');
  {
    // …and the head has slid along the path toward the victim
    const want = expectedDash(from.x, from.y, to.x, to.y, 3 / TRAVEL_TICKS);
    assert.ok(
      Math.abs(midTop.args[0] - want[2]) < 1e-9 && Math.abs(midTop.args[1] - want[3]) < 1e-9,
      `mid-travel head sits at progress on the path (got ${midTop.args}, want [${want[2]}, ${want[3]}])`,
    );
  }
  const arrival = at(192 + 6); // 6/6.4 — the tick before the head arrives
  const arrTop = aliceIn(arrival)[0];
  assert.ok(arrTop, 'still drawn a tick before the head arrives');
  assert.equal(arrTop.alpha, 1, 'still full alpha right up to arrival — NO fade on a hit');
  {
    // the head is nearly at the victim (only 0.4/6.4 of the path left)
    const want = expectedDash(from.x, from.y, to.x, to.y, 6 / TRAVEL_TICKS);
    assert.ok(
      Math.abs(arrTop.args[0] - want[2]) < 1e-9 && Math.abs(arrTop.args[1] - want[3]) < 1e-9,
      `arrival-edge head (got ${arrTop.args}, want [${want[2]}, ${want[3]}])`,
    );
  }
  assert.equal(
    aliceIn(at(192 + 7)).length,
    0,
    'gone at travel end — the dash arrived and stops drawing (no linger)',
  );
  // Paused redraws are frozen: the same tick re-renders the same ops.
  const p1 = aliceIn(at(196));
  const p2 = aliceIn(at(196));
  assert.equal(p1.length, 1, 'still live mid-travel');
  assert.deepEqual(p2[0], p1[0], 'a paused redraw is byte-identical (frozen)');

  // --- rows that must never draw (no guessed fallback) -------------------
  assert.equal(aliceIn(at(400)).length, 0, 'world/fall damage (no attacker) draws no line');
  assert.equal(aliceIn(at(600)).length, 0, 'a hit with no stored position draws no line');
  assert.equal(aliceIn(at(800)).length, 0, 'a shooter outside the roster draws no line');
  data.masks[1250] &= ~1; // alice has no sample at that frame (dead slot)
  assert.equal(aliceIn(at(1250)).length, 0, 'a shooter with no sampled position draws no line');

  // --- dedupe: pellet rows to one victim = one dash -----------------------
  const pellets = aliceIn(at(1100));
  assert.equal(pellets.length, 2, 'two identical rows → ONE dash; the second victim gets her own');
  // At the hit tick (progress 0) both dashes start at alice's position
  // and head 14 px toward THEIR OWN victim — the direction separates
  // them (the endpoints differ even though both share the origin).
  const carolTo = r.worldToScreen(90, 90);
  const wantBob = expectedDash(from.x, from.y, to.x, to.y, 0);
  const wantCarol = expectedDash(from.x, from.y, carolTo.x, carolTo.y, 0);
  assert.ok(
    Math.abs(pellets[0].args[0] - wantBob[2]) < 1e-9 && Math.abs(pellets[0].args[1] - wantBob[3]) < 1e-9,
    'the first dash heads toward bob',
  );
  assert.ok(
    Math.abs(pellets[1].args[0] - wantCarol[2]) < 1e-9 && Math.abs(pellets[1].args[1] - wantCarol[3]) < 1e-9,
    'the second dash heads toward carol',
  );
  r.destroy();
});

test('tracers stroke in the shooter’s side color; an unresolvable side is white', () => {
  // Spec: "Tracers should also be color-coded by attacker's side."
  // CT → #5aa9e6, T → #e6a35a through the ONE teamColor rule (both
  // tracer kinds — the bullet dash colors by its SHOOTER slot's side at
  // row.frame, the hit dash by its attacker steamId → slot → side at
  // the hit's tick). A side that cannot be resolved is NEVER guessed:
  // the stroke falls back to the old neutral WHITE.
  headlessGlobals();
  const data = synthStore(1300, 4); // slots 0..3, side bits ct/t/t/t
  // Slot 3 carries NO side payload for the whole recording AND no final
  // side in the roster — the unresolvable-side case (a dead player's
  // frame has the same 0 bits in the real q16-v2 stream).
  data.slots[3].flags.fill(0);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [
      { steamId: '1', name: 'alice', side: 'ct' }, // slot 0 → CT bits
      { steamId: '2', name: 'bob', side: 't' }, // slot 1 → T bits
      { steamId: '3', name: 'carol', side: 'ct' }, // slot 2 → T bits win (per-frame)
      { steamId: '4', name: 'dave', side: '' }, // slot 3 → no bits, no final side
    ],
  });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setBullets([
    // spaced beyond the 6.4-tick travel so exactly ONE dash is live per tick
    { tick: 100, frame: 100, slot: 0, weapon: 'AK-47' }, // shooter CT
    { tick: 110, frame: 110, slot: 1, weapon: 'AK-47' }, // shooter T
    { tick: 120, frame: 120, slot: 3, weapon: 'AK-47' }, // side unresolvable
  ]);
  r.setLandmarks([
    // T attacker (bob) → alice: the hit dash must stroke amber
    mk({ id: 1, seq: 1, tick: 200, round: 1, kind: 'damage', attacker: '2', victim: '1', weapon: 'ak47', dmg: 30, posX: 10, posY: 10 }),
    // unresolvable-side attacker (dave) → bob: white, never a guess
    mk({ id: 2, seq: 2, tick: 210, round: 1, kind: 'damage', attacker: '4', victim: '2', weapon: 'ak47', dmg: 30, posX: 50, posY: 50 }),
  ]);
  r.resize();
  r.setCameraMode('free');
  const at = (tick) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return canvas.log.slice(mark);
  };
  // every tracer's TOP pass: 2 px nonzero lineTo in one of the three
  // legal tracer strokes (the underlay is dark-4 px; the zero-length
  // team-colored trail lineTos are excluded by segLen)
  const tops = (tick) => {
    const seq = at(tick);
    const out = [];
    for (let i = 0; i < seq.length; i++) {
      const e = seq[i];
      if (e.op !== 'lineTo' || e.lineWidth !== 2) continue;
      if (e.strokeStyle !== '#5aa9e6' && e.strokeStyle !== '#e6a35a' && e.strokeStyle !== '#ffffff') continue;
      if (segLen(seq, i) <= 0) continue;
      out.push(e);
    }
    return out;
  };
  const oneTop = (tick, color, why) => {
    const got = tops(tick);
    assert.equal(got.length, 1, `exactly one dash at ${tick}`);
    assert.equal(got[0].strokeStyle, color, why);
  };
  oneTop(100, '#5aa9e6', 'a CT shooter strokes the CT color');
  oneTop(110, '#e6a35a', 'a T shooter strokes the T color');
  oneTop(120, '#ffffff', 'an unresolvable shooter side is white — never guessed');
  oneTop(200, '#e6a35a', 'a hit dash strokes the ATTACKER’s side (bob is T)');
  oneTop(210, '#ffffff', 'a hit with an unresolvable attacker side is white');
  r.destroy();
});

// bulletTops — the bullet tracer's TOP pass in the mask/direction test:
// the side-colored 2 px nonzero lineTo (alice is CT there — '#5aa9e6';
// the dark underlay and the zero-length team-colored trail lineTos are
// filtered out). No hit tracers exist in that fixture (setLandmarks is
// never called), so every such segment IS the bullet dash.
function bulletTops(seq) {
  const out = [];
  for (let i = 0; i < seq.length; i++) {
    const e = seq[i];
    if (e.op !== 'lineTo' || e.strokeStyle !== '#5aa9e6' || e.lineWidth !== 2) continue;
    if (segLen(seq, i) <= 0) continue; // zero-length trail segments
    out.push(e);
  }
  return out;
}

test('bullet tracers: every row draws — a mask-cleared frame draws nothing', () => {
  // The `draw` flag is GONE from bullets.js's rows (the every-3rd-auto
  // selection was retired by spec — "animate all tracers"), so there is
  // no draw:false row to skip anymore: that half of this test was
  // deleted WITH the flag (the renderer had nothing to re-check — it
  // never re-derived selection). What stays is the renderer's own gate:
  // a frame with no position sample for the slot (store.masks — the
  // store only samples ALIVE slots) draws NOTHING, same no-guess rule as
  // drawHitTracers.
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
  r.setBullets([{ tick: 192, frame: 192, slot: 0, weapon: 'AK-47' }]);
  r.resize();
  r.setCameraMode('free');
  const origin = r.worldToScreen(10, 10);
  const at = (tick) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return canvas.log.slice(mark);
  };

  // the row paints a dash at its shot tick — at the origin end of its
  // path (progress 0: a full 14 px dash sitting on the fire position)…
  assert.equal(bulletTops(at(192)).length, 1, 'the row paints a dash at its shot tick');
  {
    const seq = at(192);
    const top = bulletTops(seq)[0];
    const s = segStart(seq, seq.indexOf(top));
    const want = expectedDash(origin.x, origin.y, origin.x + 85, origin.y, 0);
    assert.ok(
      Math.abs(s[0] - want[0]) < 1e-9 &&
        Math.abs(s[1] - want[1]) < 1e-9 &&
        Math.abs(top.args[0] - want[2]) < 1e-9 &&
        Math.abs(top.args[1] - want[3]) < 1e-9,
      `dash at the origin (start ${s}, end ${top.args}; want ${want})`,
    );
  }

  // mask guard: clear alice's sample bit at HER frame → no line, even
  // though the row is inside its travel.
  data.masks[192] &= ~1;
  assert.equal(bulletTops(at(192)).length, 0, 'mask-cleared frame draws nothing');
  data.masks[192] |= 1; // restore — the row draws again (nothing sticky)
  assert.equal(
    bulletTops(at(192)).length,
    1,
    'the sample returns and the tracer draws again',
  );

  // Direction comes from the frame's yaw (the −yaw canvas convention,
  // same as drawPlayers' chevron): turn alice's head NORTH at her fire
  // frame and the dash follows — 14 px UP the screen from the origin.
  data.slots[0].pos[192 * 4 + 3] = 90; // yaw 90 → screen angle −90°
  const north = at(192);
  const northTops = bulletTops(north);
  assert.equal(northTops.length, 1, 'still ONE side-colored dash');
  assert.ok(
    Math.abs(northTops[0].args[0] - origin.x) < 1e-9 &&
      Math.abs(northTops[0].args[1] - (origin.y - 14)) < 1e-9,
    `the dash points along the frame's yaw — head 14 px north (got ${northTops[0].args}, want [${origin.x}, ${origin.y - 14}])`,
  );
  {
    // …while an east dash would sit on origin.y — its head moved UP
    // the screen, proving the yaw drove the direction
    const nStart = segStart(north, north.indexOf(northTops[0]));
    assert.ok(
      Math.abs(nStart[0] - origin.x) < 1e-9 && Math.abs(nStart[1] - origin.y) < 1e-9,
      `still starts at the fire position (got ${nStart})`,
    );
  }
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

// --- HUD, kill feed and chat over the recording context -----------------------
//
// The HUD boxes, the kill feed and the in-game chat live ON the canvas
// (snapshots and clip recordings capture the canvas and nothing else),
// so they are pinned the same way as the world layers: drive draw() and
// read the recorded ops. measureText reports a FLAT 40px by default,
// which makes every box geometry assertion exact; the chat's
// truncation test passes a length-aware measure instead (a flat width
// can never exceed a budget, so nothing would ever be cut).
// headlessGlobals() stubs the browser globals; document.fonts is
// stubbed per-test to steer the codicon-clock branch.

const HUD_PAD = 8; // mirrors renderer.js — box padding / stage offset
const KILL_FEED_LH = 18; // mirrors renderer.js — one entry line
const KILL_FEED_R = 4; // mirrors renderer.js — entry corner radius
const KILL_FEED_GAP = 12; // mirrors renderer.js — the gap between EVERY pair
//                        of cells on a feed row (an image cell reserves
//                        its painted width so both of its gaps are this)
// .codicon-clock's glyph (codicon.css line 145: content "\ea82") — built
// from the codepoint so this file never carries the raw PUA character.
const CLOCK_GLYPH = String.fromCharCode(0xea82);
const opsSince = (log, op, from = 0) => log.slice(from).filter((e) => e.op === op);
const textsSince = (log, from = 0) => opsSince(log, 'fillText', from).map((e) => e.args[0]);
// elevMarks — the canvas-drawn T/⊥ indicators in `log` (from `from`),
// each as { x, y, barY, dir, barW }: the tinted body stroke paints its
// STEM as the pair moveTo(entity centre) → lineTo(bar centre line) with
// the monoline weight, then the flat BAR as a second pair spanning
// barW = ELEV_IND_BAR_W. `dir` is which side the bar landed on
// ('above' → ⊥ below the marker, 'below' → T above it). Mirrors
// renderer.js ELEV_IND_TINT / ELEV_IND_BAR_T.
const ELEV_TINT = '#d0d6e0';
const ELEV_W = 2; // mirrors renderer.js ELEV_IND_BAR_T (the monoline weight)
const elevMarks = (log, from = 0) => {
  const ops = log.slice(from);
  const out = [];
  for (let i = 0; i < ops.length - 3; i++) {
    const [stem0, stem1, bar0, bar1] = ops.slice(i, i + 4);
    const body = (e) => e.strokeStyle === ELEV_TINT && e.lineWidth === ELEV_W;
    if (
      stem0.op !== 'moveTo' || stem1.op !== 'lineTo' || bar0.op !== 'moveTo' || bar1.op !== 'lineTo' ||
      !body(stem0) || !body(stem1) || !body(bar0) || !body(bar1)
    )
      continue;
    if (Math.abs(stem1.args[0] - stem0.args[0]) > 1e-6) continue; // stem is vertical
    if (Math.abs(bar0.args[1] - stem1.args[1]) > 1e-6) continue; // bar sits at the stem's end
    out.push({
      x: stem0.args[0],
      y: stem0.args[1],
      barY: stem1.args[1],
      dir: stem1.args[1] > stem0.args[1] ? 'above' : 'below',
      barW: bar1.args[0] - bar0.args[0],
    });
  }
  return out;
};
// The kill feed's and the chat's boxes fill the ONE un-spaced dark
// surface (entryBox — they share the painter by design); the HUD boxes
// use 'rgba(14, 17, 22, 0.78)' — a different string — and hudBox's
// radius 6 separates them from the entry overlays' radius 4.
const feedBoxesSince = (log, from = 0) =>
  opsSince(log, 'fill', from).filter((e) => e.fillStyle === 'rgba(14,17,22,0.78)');
// hudBoxesSince — hudBox's own boxes (radius 6): the top-center score/
// clock box and the bottom-left readout.
const hudBoxesSince = (log, from = 0) =>
  opsSince(log, 'roundRect', from).filter((e) => e.args[4] === 6);
// chatBoxesSince — the chat's entry boxes among the shared radius-4
// boxes: the chat anchors at the BOTTOM-left, so its roundRects sit in
// the stage's lower half (the kill feed's sit at the top).
const chatBoxesSince = (log, from = 0) =>
  opsSince(log, 'roundRect', from).filter((e) => e.args[4] === KILL_FEED_R && e.args[1] >= 300);

// entryBoxOps — the shared painter's signature, one record per radius-4
// entry box (kill feed AND chat): the [x, y, w] of its roundRect plus
// the fill and stroke that follow it (entryBox runs roundRect → fill →
// stroke on ONE path). Comparing the feed's and the chat's records is
// how the "one canonical entry-box helper" is pinned: identical fill,
// radius and 1 px border stroke, only the border color differs.
function entryBoxOps(log, from = 0) {
  const out = [];
  for (let i = from; i < log.length; i++) {
    const e = log[i];
    if (e.op !== 'roundRect' || e.args[4] !== KILL_FEED_R) continue;
    const fill = log.slice(i + 1).find((o) => o.op === 'fill');
    const stroke = log.slice(i + 1).find((o) => o.op === 'stroke');
    out.push({
      x: e.args[0],
      y: e.args[1],
      w: e.args[2],
      fill: fill && fill.fillStyle,
      stroke: stroke && stroke.strokeStyle,
      lineWidth: stroke && stroke.lineWidth,
    });
  }
  return out;
}

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

test('HUD: score-anchored line in colored segments, label-free clock, no tick/frame counter, no speed line', () => {
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

  // the bottom box lost its tick/frame counter AND the speed× line — the
  // toolbar select owns speed, the canvas readout never shows it
  assert.ok(!texts.some((t) => String(t).startsWith('tick ')), 'the tick counter is gone');
  assert.ok(!texts.some((t) => String(t).includes('frame ')), 'the frame counter is gone');
  assert.ok(!texts.some((t) => String(t) === '1×'), 'the speed× line is gone');
  assert.ok(
    !texts.some((t) => /^\d+(?:\.\d+)?×$/.test(String(t))),
    'no speed readout at ANY speed (not just 1×)',
  );
  // …but the readout box itself survives on its conditional lines: this
  // renderer never got a map pack, so reproject() set packNote — the box
  // is NOT centered, its line starts at the box's own left inset
  // (x = HUD_PAD, content 8px in)
  const note = canvas.log.find(
    (e) => e.op === 'fillText' && String(e.args[0]).startsWith('map pack missing'),
  );
  assert.ok(note, 'the readout keeps its conditional lines (packNote)');
  assert.equal(note.args[1], HUD_PAD + HUD_PAD, 'the playback readout keeps its left-aligned style');

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

// The freeze-clock repro, verbatim from the nuke golden demo (dev DB
// match 3): round 2 start 7983 / freeze end 11307 / end 16892; the plant
// at 14268; bomb_explode AND round_end both at 16892; round 3 starts
// 17340 (freeze end 18620). The recorded plant → blast interval is
// 2624 ticks = 41 s — one second PAST the 40 s C4 fallback in
// lib/replay/bomb.js. Pre-fix that cap truncated detonatedAt's `end` to
// 16828: the countdown died early, detonatedAt's `e.tick === end` gate
// never matched (16892 ≠ 16828) and the 115 s round clock resurrected
// in the round-over tail — 0:28 one tick after the cap, still ticking at
// the detonation tick (pinned by the characterization commit before the
// fix). Post-fix the countdown runs to the real blast and the tail reads
// 0:00 until round 3's freeze starts.
test('HUD clock: nuke round-2 detonation tail reads 0:00, freeze only from round 3', () => {
  headlessGlobals();
  const data = synthStore(17600, 2); // frames at ticks 0…17599
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 7983, round: 2, kind: 'round_start' }),
    mk({ id: 2, seq: 2, tick: 14268, round: 2, kind: 'bomb_plant', site: 'B' }),
    mk({ id: 3, seq: 3, tick: 16892, round: 2, kind: 'bomb_explode', site: 'B' }),
    mk({ id: 4, seq: 4, tick: 16892, round: 2, kind: 'round_end', winner: 't' }),
    mk({ id: 5, seq: 5, tick: 17340, round: 3, kind: 'round_start' }),
  ]);
  const round2 = { number: 2, label: 'R2', startTick: 7983, freezeEndTick: 11307, endTick: 16892, bombSite: 'B' };
  const round3 = { number: 3, label: 'R3', startTick: 17340, freezeEndTick: 18620, endTick: 24704, bombSite: 'B' };
  r.setHud({ score: null, teamNames: { ct: '', t: '' }, round: round2, tickRate: 64 });
  r.resize();
  const at = (tick) => {
    engine.seekTick(tick);
    const mark = canvas.log.length;
    r.draw();
    return textsSince(canvas.log, mark);
  };

  // --- the C4 countdown runs to the REAL blast (plant + 41 s = 16892) ----
  const c4 = at(16500); // 392 t left → 0:06 (pre-fix the 40 s cap said 0:05)
  assert.ok(c4.includes('C4 0:06'), 'the countdown covers the full recorded plant→blast interval');
  // At plant + 40 s the cap used to END the countdown ('C4 0:00' as its
  // last tick); the real bomb is still ticking there — one second left.
  assert.ok(at(16828).includes('C4 0:01'), 'one tick-second before the blast the countdown still runs');
  const blast = at(16892);
  assert.ok(blast.includes('C4 0:00'), 'the countdown reads 0:00 AT the detonation tick');

  // --- the round-over tail reads 0:00 — the clock never resurrects -------
  // Pre-fix these ticks showed the 115 s round clock (0:28 at 16829, 0:27
  // AT the blast, ticking to 0:20 at round 3's start).
  for (const tick of [16893, 17000, 17339]) {
    const line = at(tick);
    assert.ok(line.includes('0:00'), `tick ${tick}: the tail reads 0:00`);
    assert.ok(
      !line.some((t) => String(t).startsWith('C4 ')),
      `tick ${tick}: not planted anymore → no C4 line`,
    );
    assert.ok(
      !line.some((t) => String(t).startsWith('freeze ')),
      `tick ${tick}: never the freeze countdown while round 2's play tail runs`,
    );
    assert.ok(!line.includes('0:28') && !line.includes('0:27'), `tick ${tick}: never the resurrected round clock`);
  }
  assert.ok(!at(17339).includes('0:20'), 'and still 0:00 on the last tail tick (pre-fix: 0:20)');

  // --- the freeze countdown starts only WITH round 3 ---------------------
  r.setHud({ score: null, teamNames: { ct: '', t: '' }, round: round3, tickRate: 64 });
  const freeze = at(17340); // 18620 − 17340 = 1280 t = 20 s
  assert.ok(freeze.includes('freeze 0:20'), 'the freeze countdown begins at round 3’s start');
  assert.ok(!freeze.includes('C4 '), 'no C4 line in round 3 (its plant comes later)');
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

  // two entries, OLDEST ON TOP (tick 50 above tick 60 — a new kill
  // APPENDS at the bottom of the stack and never moves the rows already
  // shown), right-aligned: measureText is 40, every gap is 12, and an
  // image cell reserves its PAINTED width (KILL_FEED_ICON · iconAspect +
  // 2 = 14 · 1 + 2 = 16 for the square test icon, was a fixed 14) → the
  // icon line is 12 + 40 + 16 + 40 + 12 + 12 = 132 wide (x = 800 − 8 −
  // 132 = 660, grew by the 2 halo px) and the arrow line
  // 12 + 40 + 40 + 40 + 12 + 12 = 156 (x = 636, unchanged); the rows sit
  // on the 22 px PITCH (18 px box + 4 px gap), so the boxes never touch.
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
      [660, 8, 132], // [x, y, w] — the icon entry, OLDEST on top (was [662, 30, 130]: the fixed 14 px slot became the 16 px painted width, and the ordering flipped with append-at-bottom)
      [636, 30, 156], // the arrow entry BELOW it (was [636, 8, 156]: newest-on-top used to push it up)
    ],
  );
  // the OLDEST row on top: alice (CT) killing bob at tick 50
  const topKiller = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice' && e.args[2] === 12);
  assert.equal(topKiller.args[1], 660 + 6, 'the top entry is right-aligned at cssW − 8 (its own box)');
  assert.equal(topKiller.fillStyle, '#5aa9e6', "the KILLER's outline/name use the killer's side (CT)");
  const lowerKiller = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'bob' && e.args[2] === 34);
  assert.equal(lowerKiller.args[1], 636 + 6);
  assert.equal(lowerKiller.fillStyle, '#e6a35a', 'the T killer is T-colored');

  // outline = the killer's team color, 1px, full alpha (nothing else in
  // the frame strokes that combination: trails/arrow draw at alpha ≤ 0.5)
  const lines = (color) =>
    opsSince(canvas.log, 'stroke', mark).filter(
      (e) => e.strokeStyle === color && e.lineWidth === 1 && e.alpha === 1,
    );
  assert.equal(lines('#e6a35a').length, 1, 'the T killer’s box is outlined in T');
  assert.equal(lines('#5aa9e6').length, 1, 'the CT killer’s box is outlined in CT');

  // victim names are tinted by the VICTIM's side — the rows flipped with
  // the ordering: bob (T) is the OLDER row's victim at y = 12, alice
  // (CT) the newer row's victim at y = 34; both right-aligned at
  // 800 − 8 − 6 − 40 = 746 (the box is anchored by its RIGHT edge, so
  // the wider icon slot never moves them).
  const victimT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'bob' && e.args[2] === 12);
  assert.equal(victimT.args[1], 746);
  assert.equal(victimT.fillStyle, '#e6a35a');
  const victimCT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice' && e.args[2] === 34);
  assert.equal(victimCT.args[1], 746);
  assert.equal(victimCT.fillStyle, '#5aa9e6');

  // weapon: the canonical name's image when the manifest has one… — the
  // cell reserves the PAINTED width (14 · aspect + 2 halo px = 16), so
  // the HALO (the outermost paint: body + 1 px each side) starts exactly
  // one gap past the killer's name (666 + 40 = 706 → 718) and ends one
  // gap before the victim (718 + 16 = 734 → 746).
  const weaponImgs = opsSince(canvas.log, 'drawImage', mark).filter((e) => e.args[3] === 14);
  assert.equal(weaponImgs.length, 1, 'one weapon image (KILL_FEED_ICON body)');
  const halos = opsSince(canvas.log, 'drawImage', mark).filter(
    (e) => e.args[3] === 16 && e.args[4] === 16, // the halo draws 1 px larger on every side
  );
  assert.equal(halos.length, 1, 'the icon draws over its dark halo');
  assert.equal(halos[0].args[1], 660 + 6 + 40 + 12, 'a 12 px gap on EACH side of the icon');
  assert.equal(halos[0].args[1] + 16 + KILL_FEED_GAP, 746, '…and the victim starts one gap past the halo');
  // …and a plain arrow when it does not — on the same 12 px footing
  // (the arrow row is the NEWER one now, so its text line is y = 34)
  const arrow = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === '→' && e.args[2] === 34);
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

test('kill feed: capped at 6 entries — the NEWEST 6 kept, oldest dropped, newest at the bottom', () => {
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
  // oldest at the TOP: the cap keeps the NEWEST 6 (p3…p8), so p3 — not
  // p1 — heads the stack (row 0 → box y = 8, text line y = 12)…
  assert.ok(
    canvas.log.some((e) => e.op === 'fillText' && e.args[0] === 'p3' && e.args[2] === 12),
    'the oldest SURVIVOR sits on top',
  );
  // …and the newest kill (p8) sits at the BOTTOM row (row 5 → box
  // y = 8 + 5 · 22 = 118, text line 122): kills APPEND, never push down
  assert.ok(
    canvas.log.some((e) => e.op === 'fillText' && e.args[0] === 'p8' && e.args[2] === 122),
    'the newest kill sits at the BOTTOM',
  );
  assert.ok(!texts.includes('p1') && !texts.includes('p2'), 'the two oldest entries are dropped');
  r.destroy();
});

// --- kill-feed row composition (indicators, margins, append) ------------------
//
// The feed's row contract: (blind) killer (+ assister) weapon (headshot)
// victim, every ADJACENT pair separated by exactly KILL_FEED_GAP (an
// image cell reserves its painted width — KILL_FEED_ICON · iconAspect +
// 2 — so wide sprites get the same margin on both sides), rows appending
// at the bottom, and a glyph missing from the manifest reserving NO
// space (degradation must not move what's on screen).

test('kill feed: an image cell reserves its PAINTED width — equal 12 px gaps around a wide sprite', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 50, round: 1, kind: 'kill', attacker: '1', attackerName: 'alice', victim: '2', victimName: 'bob', weapon: 'AWP' }),
  ]);
  // aspect 3: the body paints 14 · 3 = 42 px and the halo adds 1 px per
  // side → 44 px reserved. The OLD fixed 14 px slot let this sprite
  // punch ~30 px through both gaps into the names (the research case:
  // AWP overflows −6 px, AK −1.35 px, a P250 leaves ~10 px).
  r.setIcons({ AWP: { width: 96, height: 32, src: 'awp.svg' } });
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();

  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  // w = 12 (inset·2) + 40 + 44 + 40 + 2 · 12 = 160 → x = 800 − 8 − 160
  const box = opsSince(canvas.log, 'roundRect', mark).find(
    (e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R,
  );
  assert.ok(box, 'the feed draws its entry box');
  assert.deepEqual([box.args[0], box.args[1], box.args[2]], [632, 8, 160]);

  const killer = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice' && e.args[2] === 12);
  const victim = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'bob' && e.args[2] === 12);
  const halo = opsSince(canvas.log, 'drawImage', mark).find((e) => e.args[3] === 44);
  assert.ok(halo, 'the halo is the outermost paint (14 · 3 + 2)');
  assert.equal(halo.args[1] - (killer.args[1] + 40), KILL_FEED_GAP, 'icon left edge − killer name end = 12');
  assert.equal(victim.args[1] - (halo.args[1] + halo.args[3]), KILL_FEED_GAP, 'victim x − icon right edge = 12');
  // centered in the reserved slot: the body (42 px) sits 1 px inside the
  // halo on each side, i.e. the cell's paint fills [tx, tx + 44] exactly
  const body = opsSince(canvas.log, 'drawImage', mark).find((e) => e.args[3] === 42);
  assert.ok(body, 'the body paints at the icon’s own aspect (no 1:1 squash)');
  assert.equal(body.args[1], halo.args[1] + 1, 'the body is centered in the halo, not left-anchored');
  r.destroy();
});

test('kill feed: a new kill APPENDS at the bottom (the rows already shown never move)', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  const kill = (id, tick, who) =>
    mk({ id, seq: id, tick, round: 1, kind: 'kill', attacker: '1', attackerName: who, victim: '2', victimName: 'bob', weapon: 'AK-47' });
  r.setIcons({ 'AK-47': { width: 32, height: 32, src: 'ak.svg' } });
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();
  const boxRows = (from) =>
    opsSince(canvas.log, 'roundRect', from)
      .filter((e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R)
      .map((e) => [e.args[0], e.args[1], e.args[2]]);

  r.setLandmarks([kill(1, 50, 'p1'), kill(2, 60, 'p2'), kill(3, 70, 'p3')]);
  engine.seekTick(100);
  let mark = canvas.log.length;
  r.draw();
  // identical names → identical widths → every box is [660, y, 132];
  // the OLDEST heads the stack (the old newest-first order pushed the
  // whole stack down from the top on every kill)
  assert.deepEqual(
    boxRows(mark),
    [
      [660, 8, 132], // p1 (tick 50) — top
      [660, 30, 132], // p2 — one PITCH down
      [660, 52, 132], // p3 — the current bottom
    ],
    'oldest at the top, newest at the bottom',
  );
  const before = boxRows(mark);

  // a FOURTH kill: the first three boxes stay byte-identical and the new
  // row lands one PITCH below the previous bottom — nothing shifts up
  r.setLandmarks([kill(1, 50, 'p1'), kill(2, 60, 'p2'), kill(3, 70, 'p3'), kill(4, 80, 'p4')]);
  mark = canvas.log.length;
  r.draw();
  const after = boxRows(mark);
  assert.deepEqual(after.slice(0, 3), before, 'the existing rows do not move');
  assert.deepEqual(after[3], [660, 74, 132], 'the new kill appends one PITCH below the stack');
  r.destroy();
});

test('kill feed: (blind) killer + assister weapon (headshot) victim — glyph slots and degradation', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  const kill = (id, tick, flags) =>
    mk({
      id,
      seq: id,
      tick,
      round: 1,
      kind: 'kill',
      attacker: '1',
      attackerName: 'alice',
      victim: '2',
      victimName: 'bob',
      weapon: 'AK-47',
      ...flags,
    });
  r.setLandmarks([
    kill(1, 50, {}), // plain
    kill(2, 60, { attackerBlind: true }), // the kill-row flag from EventRow.attackerBlind
    kill(3, 70, { headshot: true, assisterName: 'carol' }),
  ]);
  // distinct aspects so each glyph's slot is unambiguous: the square
  // weapon/blind paint 16 px (14 · 1 + 2), the wide headshot 30 px
  // (14 · 2 + 2)
  r.setIcons({
    'AK-47': { width: 32, height: 32, src: 'ak.svg' },
    blind_kill: { width: 32, height: 32, src: 'blind.svg' },
    headshot: { width: 64, height: 32, src: 'hs.svg' },
  });
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();

  engine.seekTick(100);
  let mark = canvas.log.length;
  r.draw();
  const boxRows = (from) =>
    opsSince(canvas.log, 'roundRect', from)
      .filter((e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R)
      .map((e) => [e.args[0], e.args[1], e.args[2]]);

  // Right-aligned boxes, so the victim always lands at 800 − 8 − 6 − 40
  // = 746; each extra cell adds its width + ONE gap (cells − 1 gaps):
  // plain 132 → x 660; blind 160 → x 632; headshot 174 → x 618
  assert.deepEqual(
    boxRows(mark),
    [
      [660, 8, 132], // plain row — the baseline layout
      [632, 30, 160], // + the 16 px blind cell before the killer
      [618, 52, 174], // + the 30 px headshot cell after the weapon
    ],
  );

  const imgs = opsSince(canvas.log, 'drawImage', mark);
  const killerRow2 = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice' && e.args[2] === 34);
  const killerRow3 = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice + carol' && e.args[2] === 56);

  // (d) blind BEFORE the killer's name: the glyph occupies [638, 654]
  // (box x + inset), the killer follows one gap later at 666
  const blind = imgs.find((e) => e.args[1] === 638 && e.args[2] === 31 && e.args[3] === 16);
  assert.ok(blind, 'the blind image is drawn in the row that asked for it');
  assert.ok(blind.args[1] < killerRow2.args[1], 'the blind image comes BEFORE the killer name x');
  assert.equal(killerRow2.args[1] - (blind.args[1] + blind.args[3]), KILL_FEED_GAP, 'gap after the blind glyph');
  assert.equal(blind.args[1], 632 + 6, 'the first cell starts at the box inset (no gap before it)');

  // (e) headshot AFTER the weapon icon: weapon halo [676, 692], glyph
  // [704, 734], victim at 746 — one gap around the glyph either way
  const weaponRow3 = imgs.find((e) => e.args[1] === 676 && e.args[2] === 53 && e.args[3] === 16);
  const hs = imgs.find((e) => e.args[1] === 704 && e.args[2] === 53 && e.args[3] === 30);
  assert.ok(weaponRow3, 'the weapon icon still leads the weapon cell');
  assert.ok(hs, 'the headshot image is drawn between weapon and victim');
  assert.equal(hs.args[1] - (weaponRow3.args[1] + weaponRow3.args[3]), KILL_FEED_GAP, 'gap after the weapon icon');
  assert.equal(746 - (hs.args[1] + hs.args[3]), KILL_FEED_GAP, 'gap before the victim');

  // (g) the assister rides the KILLER's cell as ONE fillText, in the
  // killer's side color (alice is CT here); no standalone 'carol' text
  assert.ok(killerRow3, 'killer + assister renders as one text run');
  assert.equal(killerRow3.args[1], 624, 'the combined cell starts at the box inset');
  assert.equal(killerRow3.fillStyle, '#5aa9e6', "the cell keeps the KILLER's side color");
  assert.ok(!textsSince(canvas.log, mark).includes('carol'), 'no separate assister run');

  // (f) the SAME rows with the glyphs absent from the manifest: the
  // blind/headshot cells vanish WITH their gap — rows 2/3 collapse onto
  // the plain row's geometry (only y differs), so a pre-re-extraction
  // install renders without shifting anything
  r.setIcons({ 'AK-47': { width: 32, height: 32, src: 'ak.svg' } });
  mark = canvas.log.length;
  r.draw();
  assert.deepEqual(
    boxRows(mark),
    [
      [660, 8, 132],
      [660, 30, 132], // blind row: no glyph → no reserved cell
      [660, 52, 132], // headshot row: same
    ],
    'missing indicator images reserve NO space',
  );
  const plainKiller = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice' && e.args[2] === 12);
  const degradedBlind = opsSince(canvas.log, 'fillText', mark).find(
    (e) => e.args[0] === 'alice' && e.args[2] === 34,
  );
  const degradedHs = opsSince(canvas.log, 'fillText', mark).find(
    (e) => e.args[0] === 'alice + carol' && e.args[2] === 56,
  );
  assert.equal(degradedBlind.args[1], plainKiller.args[1], 'the blind row collapses onto the plain row’s layout');
  assert.equal(degradedHs.args[1], plainKiller.args[1], '…and so does the headshot row');
  assert.ok(
    !opsSince(canvas.log, 'drawImage', mark).some((e) => e.args[1] === 638 || e.args[1] === 704),
    'no glyph pixels are drawn',
  );
  r.destroy();
});

// bodyBySrc — one feed glyph's BODY paint (the halo is a derived canvas
// with no src; the body carries the manifest image object, so src is the
// only reliable way to tell eight square 14 px glyphs apart).
const bodyBySrc = (log, from, src) =>
  opsSince(log, 'drawImage', from).find((e) => e.args[0] && e.args[0].src === src);

test('kill feed: a fully-flagged row orders blind < killer < airborne < weapon < ns < smoke < wb < hs < victim', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    mk({
      id: 1,
      seq: 1,
      tick: 50,
      round: 1,
      kind: 'kill',
      attacker: '1',
      attackerName: 'alice',
      assisterName: 'carol',
      victim: '2',
      victimName: 'bob',
      // a SNIPER: the noscope indicator is gated to NOSCOPE_WEAPONS, so
      // the fully-flagged row has to be one of the four
      weapon: 'AWP',
      attackerBlind: true,
      attackerInAir: true,
      noscope: true,
      throughSmoke: true,
      wallbang: true,
      headshot: true,
    }),
  ]);
  // Every glyph present, all square (aspect 1 → 14 px body / 16 px cell)
  // so the x-position order is the ONLY thing identifying each cell.
  r.setIcons({
    AWP: { width: 32, height: 32, src: 'awp.svg' },
    blind_kill: { width: 32, height: 32, src: 'blind.svg' },
    airborne: { width: 32, height: 32, src: 'air.svg' },
    noscope: { width: 32, height: 32, src: 'ns.svg' },
    throughsmoke: { width: 32, height: 32, src: 'smk.svg' },
    wallbang: { width: 32, height: 32, src: 'wb.svg' },
    headshot: { width: 32, height: 32, src: 'hs.svg' },
  });
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();

  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  // spec order verbatim, one cell per flag: blind(16) killer(40)
  // airborne(16) weapon(16) ns(16) smoke(16) wb(16) hs(16) victim(40) =
  // 192 px of cells + 8 · 12 gaps + 2 · 6 inset = 300 → x = 800 − 8 − 300
  const box = opsSince(canvas.log, 'roundRect', mark).find(
    (e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R,
  );
  assert.deepEqual([box.args[0], box.args[1], box.args[2]], [492, 8, 300]);

  // x of every cell (bodies sit 1 px inside their 16 px cell; text starts
  // at the cell's left edge) — the ordering contract, asserted as data.
  // Text is scoped to the feed line's y (box y 8 + 4): the world layers
  // print player names too.
  const atFeedLine = (txt) =>
    opsSince(canvas.log, 'fillText', mark).find((e) => e.args[0] === txt && e.args[2] === 12);
  const killer = atFeedLine('alice + carol');
  const victim = atFeedLine('bob');
  const xs = [
    ['blind', bodyBySrc(canvas.log, mark, 'blind.svg').args[1]],
    ['killer', killer.args[1]],
    ['airborne', bodyBySrc(canvas.log, mark, 'air.svg').args[1]],
    ['weapon', bodyBySrc(canvas.log, mark, 'awp.svg').args[1]],
    ['noscope', bodyBySrc(canvas.log, mark, 'ns.svg').args[1]],
    ['smoke', bodyBySrc(canvas.log, mark, 'smk.svg').args[1]],
    ['wallbang', bodyBySrc(canvas.log, mark, 'wb.svg').args[1]],
    ['headshot', bodyBySrc(canvas.log, mark, 'hs.svg').args[1]],
    ['victim', victim.args[1]],
  ];
  for (let i = 1; i < xs.length; i++) {
    assert.ok(
      xs[i][1] > xs[i - 1][1],
      `${xs[i][0]} (${xs[i][1]}) must sit right of ${xs[i - 1][0]} (${xs[i - 1][1]})`,
    );
  }
  // every ADJACENT pair is exactly one KILL_FEED_GAP apart (the halo
  // fills each image cell's [tx, tx+16] exactly, text cells are the flat
  // 40 px measure): first cell at the inset, victim last at 746.
  assert.equal(xs[0][1], 492 + 6 + 1, 'the first cell starts at the box inset (+1 for the halo)');
  assert.equal(killer.args[1], 492 + 6 + 16 + KILL_FEED_GAP, 'the killer follows the blind glyph by one gap');
  assert.equal(victim.args[1], 746, 'the victim lands at the right-aligned 746');
  assert.equal(746 - (xs[7][1] - 1 + 16), KILL_FEED_GAP, 'the headshot glyph ends one gap before the victim');
  // the assister rides the KILLER's cell (no standalone 'carol' run), and
  // the airborne glyph sits BETWEEN that cell and the weapon: compare the
  // cell's LEFT edge (the halo), i.e. the body minus its 1 px inset.
  assert.ok(!textsSince(canvas.log, mark).includes('carol'), 'no separate assister run');
  assert.equal(xs[2][1] - 1 - (killer.args[1] + 40), KILL_FEED_GAP, 'airborne follows the killer cell');
  r.destroy();
});

test('kill feed: noscope is gated to the four scoped snipers', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  const kill = (id, tick, weapon) =>
    mk({
      id,
      seq: id,
      tick,
      round: 1,
      kind: 'kill',
      attacker: '1',
      attackerName: 'alice',
      victim: '2',
      victimName: 'bob',
      weapon,
      noscope: true,
    });
  r.setLandmarks([kill(1, 50, 'AWP'), kill(2, 60, 'AK-47')]);
  r.setIcons({
    AWP: { width: 32, height: 32, src: 'awp.svg' },
    'AK-47': { width: 32, height: 32, src: 'ak.svg' },
    noscope: { width: 32, height: 32, src: 'ns.svg' },
  });
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();

  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  // The sniper row carries the glyph; the AK row with the SAME flag does
  // not — and without the cell its geometry is the plain row's (132 px,
  // x = 660): no cell, no gap. The noscope glyph is drawn once, in the
  // AWP row (y = 8 → body y = 10).
  const ns = opsSince(canvas.log, 'drawImage', mark).filter((e) => e.args[0] && e.args[0].src === 'ns.svg');
  assert.equal(ns.length, 1, 'exactly one noscope glyph — only the sniper row');
  assert.equal(ns[0].args[2], 10, '…in the top (AWP) row');
  const boxes = opsSince(canvas.log, 'roundRect', mark).filter(
    (e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R,
  );
  assert.deepEqual(
    boxes.map((e) => [e.args[0], e.args[1], e.args[2]]),
    [
      [632, 8, 160], // AWP: killer + weapon + noscope + victim
      [660, 30, 132], // AK-47: plain-row geometry (flag ignored)
    ],
    'the gated flag reserves no cell on a non-sniper weapon',
  );
  r.destroy();
});

test('kill feed: C4 death — explosion glyph + victim only, T-orange outline, no attacker-side flags', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    // Sides chosen so ONLY the rule can produce the outline: the killer
    // is T (killer-side outline would be orange) and the victim is CT
    // (victim-side outline would be blue) — yet a bomb death must stroke
    // T orange. Attacker set (and named) on purpose: the row must also
    // suppress the killer name/assister. Real C4 rows carry an empty
    // attacker — the same code path.
    mk({
      id: 1,
      seq: 1,
      tick: 50,
      round: 1,
      kind: 'kill',
      attacker: '2',
      attackerName: 'bob',
      assisterName: 'carol',
      victim: '1',
      victimName: 'alice',
      weapon: 'C4',
      // every flag that must NOT paint on this row
      attackerBlind: true,
      attackerInAir: true,
      noscope: true,
      throughSmoke: true,
      wallbang: true,
      headshot: true,
    }),
  ]);
  r.setIcons({
    C4: { width: 32, height: 32, src: 'c4.svg' }, // the weapon glyph must stay out
    explosion: { width: 32, height: 32, src: 'blast.svg' },
    blind_kill: { width: 32, height: 32, src: 'blind.svg' },
    airborne: { width: 32, height: 32, src: 'air.svg' },
    noscope: { width: 32, height: 32, src: 'ns.svg' },
    throughsmoke: { width: 32, height: 32, src: 'smk.svg' },
    wallbang: { width: 32, height: 32, src: 'wb.svg' },
    headshot: { width: 32, height: 32, src: 'hs.svg' },
  });
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();

  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  // Text is scoped to the feed line (box y 8 + 4): the world layers
  // print player names too, and 'carol' would only ever come from the
  // feed.
  const feedText = (txt, y) =>
    opsSince(canvas.log, 'fillText', mark).some((e) => e.args[0] === txt && e.args[2] === y);
  assert.ok(!feedText('bob', 12), 'no killer name on a bomb death');
  assert.ok(!feedText('carol', 12), 'no assister either');
  assert.ok(feedText('alice', 12), 'the victim cell survives');

  // [explosion(16)][victim(40)] + 1 gap + 2 inset = 80 → x = 712; the
  // glyph starts at the inset (718), the victim one gap past it (746).
  const box = opsSince(canvas.log, 'roundRect', mark).find(
    (e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R,
  );
  assert.deepEqual([box.args[0], box.args[1], box.args[2]], [712, 8, 80]);
  const boom = bodyBySrc(canvas.log, mark, 'blast.svg');
  assert.ok(boom, 'the explosion glyph is drawn at the killer cell’s x');
  assert.equal(boom.args[1], 719, '…at the box inset (712 + 6 + 1)');
  const victim = opsSince(canvas.log, 'fillText', mark).find((e) => e.args[0] === 'alice' && e.args[2] === 12);
  assert.equal(victim.args[1], 746, 'the victim is right-aligned as always');
  assert.equal(victim.fillStyle, '#5aa9e6', 'the victim name keeps the VICTIM’s side tint (CT)');

  // Not ONE other glyph paints: no weapon image, no attacker-side flag.
  const srcs = opsSince(canvas.log, 'drawImage', mark)
    .filter((e) => e.args[0] && e.args[0].src)
    .map((e) => e.args[0].src);
  assert.deepEqual(srcs, ['blast.svg'], 'the row is explosion + victim, nothing else');

  // Outline in T orange — the bomb belongs to the T side, NOT to either
  // player: the killer is T (a killer-side outline would be orange) and
  // the victim is CT (a victim-side outline would be blue), so only the
  // rule can stroke orange here.
  const strokes = (color) =>
    opsSince(canvas.log, 'stroke', mark).filter(
      (e) => e.strokeStyle === color && e.lineWidth === 1 && e.alpha === 1,
    );
  assert.equal(strokes('#e6a35a').length, 1, 'the C4 row is outlined in T orange');
  assert.equal(
    strokes('#5aa9e6').length,
    0,
    'neither player’s side (killer T, victim CT) reaches the outline',
  );
  r.destroy();
});

test('kill feed: suicide rows — self-kill and empty attacker drop the killer for the suicide glyph', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    // self-kill: attacker === victim (own knife/own utility)
    mk({
      id: 1,
      seq: 1,
      tick: 50,
      round: 1,
      kind: 'kill',
      attacker: '1',
      attackerName: 'alice',
      victim: '1',
      victimName: 'alice',
      weapon: 'Knife',
      headshot: true,
    }),
    // empty attacker: world/fall death (weapon 'World')
    mk({
      id: 2,
      seq: 2,
      tick: 60,
      round: 1,
      kind: 'kill',
      attacker: '',
      victim: '2',
      victimName: 'bob',
      weapon: 'World',
      attackerInAir: true,
    }),
  ]);
  r.setIcons({
    Knife: { width: 32, height: 32, src: 'knife.svg' }, // weapon glyph stays out
    World: { width: 32, height: 32, src: 'world.svg' },
    suicide: { width: 32, height: 32, src: 'suicide.svg' },
    airborne: { width: 32, height: 32, src: 'air.svg' },
    headshot: { width: 32, height: 32, src: 'hs.svg' },
  });
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();

  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  // Both rows: [suicide(16)][victim(40)] = 80 px at x = 712, one glyph
  // each, no weapon/flag cells (the flags on row 2 are attacker-side and
  // a self/world death has no attacker to hang them on).
  const boxes = opsSince(canvas.log, 'roundRect', mark).filter(
    (e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R,
  );
  assert.deepEqual(
    boxes.map((e) => [e.args[0], e.args[1], e.args[2]]),
    [
      [712, 8, 80],
      [712, 30, 80],
    ],
  );
  const srcs = opsSince(canvas.log, 'drawImage', mark)
    .filter((e) => e.args[0] && e.args[0].src)
    .map((e) => e.args[0].src);
  assert.deepEqual(srcs, ['suicide.svg', 'suicide.svg'], 'only the suicide glyph paints, once per row');

  // No killer name: row 1's 'alice' appears exactly ONCE on its feed line
  // (box y 8 + 4 — the world layers print player names too): the
  // self-kill does not print the name twice.
  const aliceRuns = opsSince(canvas.log, 'fillText', mark).filter(
    (e) => e.args[0] === 'alice' && e.args[2] === 12,
  );
  assert.equal(aliceRuns.length, 1, 'the self-kill shows the name only as the victim');
  assert.ok(
    opsSince(canvas.log, 'fillText', mark).some((e) => e.args[0] === 'bob' && e.args[2] === 34),
    'the world-death victim renders on line 2',
  );

  // Outlines take the VICTIM's side (the killer IS the victim / there is
  // none): row 1 victim = alice (CT) → CT blue; row 2 victim = bob (T) →
  // T orange. entryBoxOps reads the stroke that follows each radius-4
  // roundRect — the shared painter's own fill/stroke pair.
  assert.deepEqual(
    entryBoxOps(canvas.log, mark).map((b) => b.stroke),
    ['#5aa9e6', '#e6a35a'],
    'victim-side outlines: CT self-kill, T world death',
  );
  r.destroy();
});

test('kill feed: missing round-4 indicator images reserve NO cell (no gap either)', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    mk({
      id: 1,
      seq: 1,
      tick: 50,
      round: 1,
      kind: 'kill',
      attacker: '1',
      attackerName: 'alice',
      victim: '2',
      victimName: 'bob',
      weapon: 'AWP',
      attackerInAir: true,
      noscope: true,
      throughSmoke: true,
      wallbang: true,
    }),
  ]);
  // Manifest WITHOUT any of the four glyphs (a pre-re-extraction install):
  // only the weapon image exists.
  r.setIcons({ AWP: { width: 32, height: 32, src: 'awp.svg' } });
  r.setHud({
    score: { ct: 0, t: 0 },
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();

  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  // Plain-row geometry (killer + weapon + victim = 132 px, x = 660): the
  // four missing glyphs contribute neither cell nor gap, exactly like the
  // round-1 blind/headshot degradation.
  const box = opsSince(canvas.log, 'roundRect', mark).find(
    (e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R,
  );
  assert.deepEqual([box.args[0], box.args[1], box.args[2]], [660, 8, 132]);
  const killer = opsSince(canvas.log, 'fillText', mark).find((e) => e.args[0] === 'alice' && e.args[2] === 12);
  const victim = opsSince(canvas.log, 'fillText', mark).find((e) => e.args[0] === 'bob' && e.args[2] === 12);
  const awp = bodyBySrc(canvas.log, mark, 'awp.svg');
  assert.ok(awp, 'the weapon image still draws');
  assert.equal(killer.args[1], 666, 'the killer sits at the box inset');
  // bodies sit 1 px inside their cell (the halo fills [tx, tx+16])
  assert.equal(awp.args[1], killer.args[1] + 40 + KILL_FEED_GAP + 1, '…the weapon one gap later');
  assert.equal(victim.args[1], awp.args[1] - 1 + 16 + KILL_FEED_GAP, '…the victim one gap after it');
  const srcs = opsSince(canvas.log, 'drawImage', mark)
    .filter((e) => e.args[0] && e.args[0].src)
    .map((e) => e.args[0].src);
  assert.deepEqual(srcs, ['awp.svg'], 'no indicator glyph pixels are drawn');
  r.destroy();
});

// --- Readout box (speed line removed) + in-game chat -------------------------
//
// The bottom-left corner: the playback readout (follow/loop/packNote —
// NO speed× line any more) and the in-game chat (drawChat) share it, so
// these pin both the readout's draw-only-when-it-has-lines rule and the
// chat's round/tick scoping, colors, stack order, truncation and its
// geometry relative to the readout.

test('readout box: drawn only when it has a follow/loop/packNote line (no speed line)', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const round = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  // A pack WITH its radar image: reproject's happy path clears packNote,
  // so with no follow and no loop the readout has NOTHING to say — and
  // the speed line is gone, so there is no line to hide the emptiness.
  r.setPack({ transform: { pos_x: 0, pos_y: 0, scale: 1 } }, { width: 64, height: 64 });
  r.setHud({ score: { ct: 0, t: 0 }, teamNames: { ct: '', t: '' }, round, tickRate: 64 });
  r.resize();

  const texts = textsSince(canvas.log);
  assert.ok(!texts.some((t) => String(t) === '1×'), 'no speed line');
  assert.equal(
    hudBoxesSince(canvas.log).length,
    1,
    'only the top-center box — an empty readout draws NO box',
  );
  assert.equal(hudBoxesSince(canvas.log)[0].args[1], HUD_PAD, '…and that one box is the top one');

  // a follow line brings the readout back — at the corner (no chat)
  engine.setFollow(0);
  let mark = canvas.log.length;
  r.draw();
  let hb = hudBoxesSince(canvas.log, mark); // the top box + the readout
  assert.equal(
    hb.filter((b) => b.args[0] === HUD_PAD).length,
    1,
    'exactly ONE left-aligned readout box (the top box is centered)',
  );
  const readout = hb.find((b) => b.args[0] === HUD_PAD);
  assert.equal(readout.args[1], 600 - 8 - 28, '8 px off the bottom (one line = 28 px tall)');
  assert.equal(readout.args[3], 28, 'the box is exactly one line tall');
  const follow = canvas.log
    .slice(mark)
    .find((e) => e.op === 'fillText' && String(e.args[0]).startsWith('follow:'));
  assert.ok(follow, 'the follow line draws');
  assert.equal(follow.args[1], HUD_PAD + HUD_PAD, "the readout's left-inset content");

  // the loop line joins it → one box, two lines tall
  // The bounds are FRAMES internally (0 → 640) but the readout speaks
  // OVERALL MATCH TIME (fmt.js fmtClock over tickSeconds from the
  // stream's first tick — the same basis as the scrubber), so frame 640
  // at 64 tick reads 0:10, not "f640".
  engine.setLoop(0, 640);
  engine.toggleLoop();
  mark = canvas.log.length;
  r.draw();
  hb = hudBoxesSince(canvas.log, mark).filter((b) => b.args[0] === HUD_PAD);
  assert.equal(hb.length, 1, 'still ONE readout box');
  assert.equal(hb[0].args[1], 600 - 8 - 43, '43 px tall (2 lines), still 8 px off the bottom');
  assert.equal(hb[0].args[3], 43, 'two lines now');
  const tt = textsSince(canvas.log, mark);
  assert.ok(tt.some((t) => String(t) === 'loop: 0:00–0:10'), 'the loop line joins the readout, in match time');
  r.destroy();
});

test('chat: round-scoped to the playhead, cleared on a round change, re-derived on a backwards scrub', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const round1 = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  const round2 = { number: 2, label: 'R2', startTick: 1200, freezeEndTick: 1840, endTick: 2400, bombSite: '' };
  r.setHud({ score: null, teamNames: { ct: '', t: '' }, round: round1, tickRate: 64 });
  r.resize();

  // mid-round-1: only round-1 lines at/before the playhead — and the
  // setter itself redraws (no explicit r.draw() here)
  engine.seekTick(100);
  let mark = canvas.log.length;
  r.setChat([
    { id: 1, tick: 50, round: 1, steamId: '1', name: 'alice', text: 'one' },
    { id: 2, tick: 60, round: 1, steamId: '2', name: 'bob', text: 'two' },
    { id: 3, tick: 500, round: 1, steamId: '1', name: 'alice', text: 'later' },
    { id: 4, tick: 700, round: 2, steamId: '2', name: 'bob', text: 'other round' },
  ]);
  let boxes = chatBoxesSince(canvas.log, mark);
  assert.equal(boxes.length, 2, 'round 1, tick ≤ playhead — setChat redraws on set');
  let tt = textsSince(canvas.log, mark);
  assert.ok(tt.includes(': one') && tt.includes(': two'), 'both past round-1 lines draw');
  assert.ok(!tt.includes(': later'), "a line past the playhead is not shown yet");
  assert.ok(!tt.includes(': other round'), 'another round never leaks in');
  // chronological stack: the older line is ABOVE, the newer at the bottom
  assert.equal(boxes[0].args[1], 552, 'the older message sits higher');
  assert.equal(boxes[1].args[1], 574, 'the newer message is at the bottom-left corner');

  // the playhead passes the third line → it appears (pure tick math)
  engine.seekTick(600);
  mark = canvas.log.length;
  r.draw();
  assert.equal(chatBoxesSince(canvas.log, mark).length, 3, 'scrubbing forward adds the new line');
  assert.ok(textsSince(canvas.log, mark).includes(': later'), '…and it draws');

  // a round change CLEARS the stack (the "clear between rounds" rule)
  r.setHud({ score: null, teamNames: { ct: '', t: '' }, round: round2, tickRate: 64 });
  engine.seekTick(800);
  mark = canvas.log.length;
  r.draw();
  boxes = chatBoxesSince(canvas.log, mark);
  assert.equal(boxes.length, 1, 'only the new round’s chat remains');
  tt = textsSince(canvas.log, mark);
  assert.ok(tt.includes(': other round'), 'the round-2 line is in scope');
  assert.ok(!tt.includes(': one') && !tt.includes(': later'), 'round 1’s lines are gone');

  // a backwards scrub re-derives round 1's chat (nothing sticky)
  r.setHud({ score: null, teamNames: { ct: '', t: '' }, round: round1, tickRate: 64 });
  engine.seekTick(100);
  mark = canvas.log.length;
  r.draw();
  assert.equal(chatBoxesSince(canvas.log, mark).length, 2, 'scrubbing back restores the old round');
  assert.ok(!textsSince(canvas.log, mark).includes(': other round'), '…and drops round 2 again');
  r.destroy();
});

test('chat: speaker colors name and border at the message tick, neutral when unknown', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  r.setHud({
    score: null,
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.setChat([
    { id: 1, tick: 50, round: 1, steamId: '1', name: 'alice', text: 'gg' }, // alice = CT slot 0
    { id: 2, tick: 60, round: 1, steamId: '2', name: 'bob', text: 'wp' }, // bob = T slot 1
    { id: 3, tick: 70, round: 1, steamId: '999', name: 'mystery', text: 'hi' }, // no slot at all
  ]);
  r.resize();
  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  const boxes = entryBoxOps(canvas.log, mark);
  assert.equal(boxes.length, 3, 'one entry box per message');
  assert.equal(boxes[0].stroke, '#5aa9e6', 'the CT speaker’s border is CT');
  assert.equal(boxes[1].stroke, '#e6a35a', 'the T speaker’s border is T');
  assert.equal(boxes[2].stroke, '#9aa4b5', 'an unresolvable speaker gets the NEUTRAL border');
  assert.equal(boxes[2].lineWidth, 1, 'the hairline border is 1 px');
  assert.ok(
    boxes.every((b) => b.fill === 'rgba(14,17,22,0.78)'),
    'every entry sits on the shared dark surface',
  );

  // names are drawn in the SAME side colors, at the box's left inset
  const nameAt = (n, y) =>
    canvas.log.find((e) => e.op === 'fillText' && e.args[0] === n && e.args[1] === 14 && e.args[2] === y + 4);
  assert.equal(nameAt('alice', boxes[0].y).fillStyle, '#5aa9e6', 'CT name in CT');
  assert.equal(nameAt('bob', boxes[1].y).fillStyle, '#e6a35a', 'T name in T');
  assert.equal(nameAt('mystery', boxes[2].y).fillStyle, '#9aa4b5', 'unknown name neutral — never guessed');

  // the message text is the HUD's secondary tone, right after the name
  const body = canvas.log.find(
    (e) => e.op === 'fillText' && e.args[0] === ': gg' && e.args[2] === boxes[0].y + 4,
  );
  assert.ok(body, 'the `: message` part draws after the name');
  assert.equal(body.args[1], 14 + 40, 'immediately after the measured name width');
  assert.equal(body.fillStyle, '#8b94a7', 'message text = the HUD secondary-text tone');
  r.destroy();
});

test('chat: newest at the BOTTOM, capped at 6 with the oldest dropped above', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  r.setHud({
    score: null,
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.setChat(
    Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      tick: (i + 1) * 10, // m1 oldest … m8 newest
      round: 1,
      steamId: '1',
      name: 'alice',
      text: `m${i + 1}`,
    })),
  );
  r.resize();
  engine.seekTick(100); // all 8 messages are in the past
  const mark = canvas.log.length;
  r.draw();

  const boxes = chatBoxesSince(canvas.log, mark);
  assert.equal(boxes.length, 6, 'the stack shows at most CHAT_MAX messages');
  // 600 − 8 − 18 − 5·22 = 464 at the top, 574 (the corner) at the bottom
  assert.deepEqual(
    boxes.map((b) => b.args[1]),
    [464, 486, 508, 530, 552, 574],
    'entries sit on the feed’s 22 px pitch, growing up from the corner',
  );
  const at = (n) => textsSince(canvas.log, mark).includes(`: m${n}`);
  const textAtY = (y) =>
    canvas.log.find((e) => e.op === 'fillText' && e.args[2] === y + 4 && String(e.args[0]).startsWith(': '));
  assert.equal(textAtY(574).args[0], ': m8', 'the NEWEST message is at the bottom edge');
  assert.equal(textAtY(464).args[0], ': m3', 'the 6th-newest is on top — m1/m2 dropped');
  assert.ok(!at(1) && !at(2), 'the two oldest messages are gone');
  assert.ok(at(4) && at(5) && at(6) && at(7), 'the rest of the window stays');
  r.destroy();
});

test('chat: a long message is cut to 40% of the stage with an ellipsis', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  // A LENGTH-AWARE measureText (8 px per character): the harness's flat
  // 40 px can never exceed any budget, so nothing would ever be cut.
  const canvas = recordingCanvas(800, 600, (s) => s.length * 8);
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  r.setHud({
    score: null,
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.setChat([
    { id: 1, tick: 50, round: 1, steamId: '1', name: 'alice', text: 'this chat line is far too long to fit' }, // 37 chars
    { id: 2, tick: 60, round: 1, steamId: '2', name: 'bob', text: 'hi' },
  ]);
  r.resize();
  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  const boxes = entryBoxOps(canvas.log, mark);
  // budget: 0.4 × 800 = 320 px − 2×6 inset − the 40 px name ('alice' =
  // 5 chars) = 268 px for the body → ': ' + 30 chars + '…' = 33 chars ×
  // 8 = 264 fits, one character more (272) does not
  assert.equal(boxes[0].w, 12 + 40 + 33 * 8, 'the long entry is cut to ≤ 40% of cssW');
  assert.ok(boxes[0].w <= 800 * 0.4, 'never wider than CHAT_MAX_W');
  const cut = canvas.log.find((e) => e.op === 'fillText' && String(e.args[0]).endsWith('…'));
  assert.ok(cut, 'the message is cut with an ellipsis');
  assert.equal(
    cut.args[0],
    ': this chat line is far too long…',
    'cut at the last char that fits, the ellipsis appended',
  );
  assert.equal(cut.fillStyle, '#8b94a7', 'the cut message keeps the neutral tone');
  // the short message is untouched: inset 12 + 'bob' 24 + ': hi' 32 = 68
  assert.equal(boxes[1].w, 12 + 24 + ': hi'.length * 8, 'a short entry is inset + name + body');
  assert.ok(
    canvas.log.some((e) => e.op === 'fillText' && e.args[0] === ': hi'),
    'no ellipsis where nothing was cut',
  );
  r.destroy();
});

test('readout stacks 8 px above the chat; alone at the corner without chat', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const round = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  // no setPack → packNote gives the readout one line (28 px tall)
  r.setHud({ score: null, teamNames: { ct: '', t: '' }, round, tickRate: 64 });
  const chatRow = (tick, text) => ({ id: tick, tick, round: 1, steamId: '1', name: 'alice', text });

  // ONE chat line: stack top = 600 − 8 − 18 = 574 → readout bottom 566
  r.setChat([chatRow(50, 'one')]);
  r.resize();
  engine.seekTick(100); // the playhead must have passed the message
  let mark = canvas.log.length;
  r.draw();
  let readout = hudBoxesSince(canvas.log, mark).find((b) => b.args[0] === HUD_PAD);
  let chat = chatBoxesSince(canvas.log, mark);
  assert.equal(chat.length, 1, 'the chat draws');
  assert.equal(chat[0].args[1], 574, 'the message sits at the bottom-left corner');
  assert.ok(readout, 'the readout has a line (packNote) so it draws');
  assert.equal(
    readout.args[1] + 28,
    chat[0].args[1] - 8,
    "the readout's bottom edge is 8 px above the chat's top edge",
  );

  // TWO chat lines → the stack grows up, the readout follows it
  r.setChat([chatRow(50, 'one'), chatRow(60, 'two')]);
  mark = canvas.log.length;
  r.draw();
  chat = chatBoxesSince(canvas.log, mark);
  assert.equal(chat[0].args[1], 552, 'the second message pushes the stack up');
  readout = hudBoxesSince(canvas.log, mark).find((b) => b.args[0] === HUD_PAD);
  assert.equal(readout.args[1], 552 - 8 - 28, 'the readout moves up with the chat top');

  // NO chat → the readout returns to the corner (its old position)
  r.setChat([]);
  mark = canvas.log.length;
  r.draw();
  assert.equal(chatBoxesSince(canvas.log, mark).length, 0, 'the stack clears');
  readout = hudBoxesSince(canvas.log, mark).find((b) => b.args[0] === HUD_PAD);
  assert.equal(readout.args[1], 600 - 8 - 28, 'the readout sits at the corner again');

  // NO readout lines (a pack with its radar clears packNote) → the chat
  // alone owns the corner
  r.setPack({ transform: { pos_x: 0, pos_y: 0, scale: 1 } }, { width: 64, height: 64 });
  r.setChat([chatRow(50, 'one')]);
  mark = canvas.log.length;
  r.draw();
  assert.equal(
    hudBoxesSince(canvas.log, mark).filter((b) => b.args[0] === HUD_PAD).length,
    0,
    'no readout lines → no readout box, not even an empty one',
  );
  chat = chatBoxesSince(canvas.log, mark);
  assert.equal(chat.length, 1, 'the chat draws alone');
  assert.equal(chat[0].args[1], 574, '…right at the corner');
  r.destroy();
});

test('kill feed and chat: ONE shared entry-box painter (fill, radius, 1 px border)', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    // no positions → the world layers (death X) stay out of the way
    mk({ id: 1, seq: 1, tick: 50, round: 1, kind: 'kill', attacker: '1', attackerName: 'alice', victim: '2', victimName: 'bob', weapon: 'AK-47' }),
  ]);
  r.setHud({
    score: null,
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.setChat([
    { id: 1, tick: 40, round: 1, steamId: '1', name: 'alice', text: 'gg' },
    { id: 2, tick: 60, round: 1, steamId: '2', name: 'bob', text: 'wp' },
  ]);
  r.resize();
  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  const boxes = entryBoxOps(canvas.log, mark);
  assert.equal(boxes.length, 3, 'one record per entry box: 1 kill + 2 chat');
  for (const b of boxes) {
    assert.equal(b.fill, 'rgba(14,17,22,0.78)', 'both overlays fill the SAME dark surface');
    assert.equal(b.lineWidth, 1, 'both stroke the same 1 px hairline');
  }
  // same painter, different anchors: the feed top-right, the chat bottom-left
  assert.equal(boxes[0].x, 800 - 8 - 156, 'the kill feed entry is right-aligned (no icon → 156 wide)');
  assert.ok(boxes[0].y < 100, '…at the top edge');
  assert.deepEqual(
    boxes.slice(1).map((b) => b.x),
    [8, 8],
    'the chat entries are left-anchored at the stage edge',
  );
  // borders carry the speaker/killer side on both overlays (CT kill, CT+T chat)
  assert.deepEqual(
    boxes.map((b) => b.stroke),
    ['#5aa9e6', '#5aa9e6', '#e6a35a'],
    'the feed’s killer border and the chat’s speaker borders come from the same teamColor rule',
  );
  r.destroy();
});

// --- decoy rest icon + noise pulses (setDecoyPlan) ---------------------------
//
// The plan rows (lib/replay/decoy.js buildDecoyPlan) carry the REST
// position, the explosion tick, the thrower's side and the scheduled
// fake gunshots: the icon shows for [landTick, detTick), ONE white
// mic-talk bloom per shot (shotBloom — the event-anchored voiceBloom
// recipe), and at the blast the UNPAIRED detonation row draws the HE
// ring (a decoy explosion renders as HE — BaseGrenade.Explode).

test('shotBloom: event-anchored, single-cycle twin of voiceBloom', () => {
  const tr = 64;
  // The SAME recipe as voiceBloom: at age 0 the bloom starts at
  // VOICE_BLOOM_MIN_R with VOICE_BLOOM_MAX_A, growing toward
  // anchorR + VOICE_BLOOM_MAX_R over VOICE_BLOOM_PERIOD_S.
  const b0 = shotBloom(1000, 1000, tr, 8);
  assert.ok(b0, 'the bloom resolves exactly at the shot');
  assert.equal(b0.k, 0);
  assert.ok(Math.abs(b0.radius - 3) < 1e-12, 'starts at VOICE_BLOOM_MIN_R');
  assert.ok(Math.abs(b0.alpha - 0.9) < 1e-12, 'starts at VOICE_BLOOM_MAX_A');
  const late = shotBloom(1000 + 54, 1000, tr, 8); // 0.84375 s < 0.85 s
  assert.ok(late.k > 0.99 && late.radius > 17.5, 'approaches anchorR + 10');
  assert.ok(late.alpha < 0.05, 'fades toward 0');
  // SINGLE-CYCLE (the relationship to voiceBloom: same constants, but
  // the phase is event-anchored and never loops): null before the shot
  // and after one period — voiceBloom by contrast wraps back to phase 0
  // (tick 1088 = 17 s = exactly 20 × 0.85 s periods).
  assert.equal(shotBloom(999, 1000, tr, 8), null, 'nothing before the sound');
  assert.equal(shotBloom(1055, 1000, tr, 8), null, 'one cycle is all a shot gets');
  assert.ok(Math.abs(voiceBloom(1088, tr, 9).k) < 1e-12, 'voiceBloom wraps back to phase 0 (it loops)');
  assert.ok(voiceBloom(1087, tr, 9).k > 0.98, '…just before, it is at the end of the previous cycle');
  // Tick-pure: a scrub into the window re-renders the same phase, and
  // the phase advances only with the tick (frozen while paused).
  assert.deepEqual(shotBloom(1032, 1000, tr, 8), shotBloom(1032, 1000, tr, 8));
  assert.ok(shotBloom(1032, 1000, tr, 8).k < shotBloom(1048, 1000, tr, 8).k);
  // Broken clock / anchor → null (never a stuck bloom).
  assert.equal(shotBloom(NaN, 1000, tr, 8), null);
  assert.equal(shotBloom(1000, NaN, tr, 8), null);
  assert.equal(shotBloom(1000, 1000, 0, 8), null);
  assert.equal(shotBloom(1000, 1000, tr, NaN), null);
  assert.equal(shotBloom(1000, 1000, tr, 0), null);
});

test('decoy plan: rest icon land→det with side tint, one white pulse per shot, hidden after', () => {
  headlessGlobals();
  const data = synthStore(4000, 2);
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
  r.setIcons({ 'Decoy Grenade': { width: 32, height: 32, src: 'decoy.svg' } });
  r.setDecoyPlan([
    {
      landTick: 1000,
      detTick: 3000,
      x: 50,
      y: 60,
      side: 'ct',
      weapon: 'AK-47',
      shots: [{ tick: 1100 }, { tick: 2500 }],
    },
  ]);
  r.resize();
  // the decoy body icon (NADE_ICON_PX = 16 — the halo is 18)
  const icon = (from) => canvas.log.slice(from).filter((e) => e.op === 'drawImage' && e.args[4] === 16);
  const whiteRing = (from) =>
    canvas.log.slice(from).find((e) => e.op === 'arc' && e.strokeStyle === '#ffffff' && e.lineWidth > 1);

  // --- BEFORE the rest: nothing ----------------------------------------------
  engine.seekTick(900);
  let mark = canvas.log.length;
  r.draw();
  assert.equal(icon(mark).length, 0, 'no icon before the decoy comes to rest');

  // --- inside [landTick, detTick): the icon, CT-tinted (the flight        ---
  // --- line's tint rule — teamColor for a resolvable side)                 ---
  engine.seekTick(1200);
  let tints = iconTints.length;
  mark = canvas.log.length;
  r.draw();
  const icons = icon(mark);
  assert.equal(icons.length, 1, 'the rest icon draws while the decoy is noisy');
  assert.ok(
    tintsSince(tints).some((t) => t.color === '#5aa9e6'),
    'the icon takes the thrower side tint (CT blue, same path as the flight line)',
  );
  assert.equal(icons[0].args[4], 16, 'NADE_ICON_PX sizing');

  // --- the noise pulse: ONE white mic-talk bloom per scheduled shot,   ---
  // --- event-anchored (shotBloom at the shot's tick), nothing in between ---
  engine.seekTick(1120); // 20 ticks (0.3125 s) after shot@1100 — inside its cycle
  mark = canvas.log.length;
  r.draw();
  const expected = shotBloom(1120, 1100, 64, 8);
  const ring = whiteRing(mark);
  assert.ok(ring, 'the fake gunshot blooms a WHITE ring');
  assert.ok(Math.abs(ring.args[2] - expected.radius) < 1e-9, 'radius is the event-anchored phase');
  assert.ok(Math.abs(ring.alpha - expected.alpha) < 1e-12, 'alpha fades with the same phase');
  // the bloom is anchored at the decoy's REST position (the icon's center)
  const body = icons[0];
  assert.ok(Math.abs(ring.args[0] - (body.args[1] + 8)) < 1e-9, 'anchored at the rest x');
  assert.ok(Math.abs(ring.args[1] - (body.args[2] + 8)) < 1e-9, 'anchored at the rest y');
  // paused at the SAME tick → the identical phase (nothing sticky, the
  // ring is a pure function of the tick)
  mark = canvas.log.length;
  r.draw();
  const again = whiteRing(mark);
  assert.ok(again && Math.abs(again.args[2] - ring.args[2]) < 1e-9, 'paused redraw re-renders the same bloom');

  // between shots (and past the first shot's single cycle): no pulse
  engine.seekTick(1400); // 4.7 s after shot@1100, 1.1 s before shot@2500
  mark = canvas.log.length;
  r.draw();
  assert.equal(whiteRing(mark), undefined, 'no bloom between scheduled shots');
  assert.equal(icon(mark).length, 1, '…but the icon keeps showing');

  // --- at/after the explosion: the icon is GONE and the HE ring plays   ---
  engine.seekTick(3000);
  r.setLandmarks([
    normalizeEvent(
      { id: 9, seq: 9, tick: 3000, round: 1, kind: 'grenade', attacker: '1', weapon: 'Decoy Grenade', posX: 50, posY: 60 },
      {},
    ),
  ]);
  mark = canvas.log.length;
  r.draw();
  assert.equal(icon(mark).length, 0, 'the icon hides at detTick (the window is [land, det))');
  const heRing = canvas.log
    .slice(mark)
    .find((e) => e.op === 'arc' && String(e.strokeStyle).startsWith('rgba(224, 91, 91'));
  assert.ok(heRing, 'the decoy explosion renders through the SHARED HE block (BaseGrenade.Explode)');
  assert.ok(Math.abs(heRing.args[2] - 4) < 1e-9, 'the HE ring at age 0 (its classic start radius)');
  engine.seekTick(3600); // past the 1.3 s HE window
  mark = canvas.log.length;
  r.draw();
  assert.equal(icon(mark).length, 0, 'still hidden after the blast');
  assert.equal(
    canvas.log.slice(mark).find((e) => e.op === 'arc' && String(e.strokeStyle).startsWith('rgba(224, 91, 91')),
    undefined,
    'the HE ring runs its ~1.3 s and stops',
  );
  r.destroy();
});

test('decoy plan: an unresolvable side falls back to the amber tint (never guessed)', () => {
  headlessGlobals();
  const data = synthStore(2000, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [{ steamId: '1', name: 'alice', side: 'ct' }],
  });
  r.setIcons({ 'Decoy Grenade': { width: 32, height: 32, src: 'decoy.svg' } });
  r.setDecoyPlan([
    { landTick: 500, detTick: 1500, x: 40, y: 40, side: '', weapon: null, shots: [] },
  ]);
  r.resize();
  engine.seekTick(800);
  const tints = iconTints.length;
  const mark = canvas.log.length;
  r.draw();
  assert.equal(
    canvas.log.slice(mark).filter((e) => e.op === 'drawImage' && e.args[4] === 16).length,
    1,
    'the icon shows even when no weapon resolved (icon + explosion still work)',
  );
  const colors = tintsSince(tints).map((t) => t.color);
  assert.ok(colors.includes('rgba(251, 172, 24, 0.85)'), 'amber fallback tint for an unknown side');
  assert.equal(colors.includes('#5aa9e6'), false, 'no side is ever guessed into CT blue');
  r.destroy();
});

test('decoy throw arc ends at the REST position; the blast animates from the unpaired detonation row', () => {
  headlessGlobals();
  const data = synthStore(4000, 2);
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
  const throwRow = mk({
    id: 1, seq: 1, tick: 64, round: 1, kind: 'grenade_throw',
    attacker: '1', weapon: 'Decoy Grenade', posX: 10, posY: 10,
  });
  const landRow = mk({
    id: 2, seq: 2, tick: 200, round: 1, kind: 'grenade_land',
    attacker: '1', weapon: 'Decoy Grenade', posX: 50, posY: 50,
  });
  const detRow = mk({
    id: 3, seq: 3, tick: 1500, round: 1, kind: 'grenade',
    attacker: '1', weapon: 'Decoy Grenade', posX: 50, posY: 50,
  });
  r.setLandmarks([throwRow, landRow, detRow]);
  r.setIcons({ 'Decoy Grenade': { width: 32, height: 32, src: 'decoy.svg' } });
  r.resize();
  const flight = (from) =>
    canvas.log.slice(from).filter((e) => e.op === 'stroke' && e.lineDash.join(',') === '4,4');

  // In the air: the arc draws (throw → paired target).
  engine.seekTick(100);
  let mark = canvas.log.length;
  r.draw();
  assert.equal(flight(mark).length, 1, 'the decoy flight draws');

  // PAST THE REST (200) but long before the blast (1500): the arc is
  // gone — non-vacuous: pairing with the DETONATION row would still be
  // drawing here.
  engine.seekTick(250);
  mark = canvas.log.length;
  r.draw();
  assert.equal(flight(mark).length, 0, 'the arc ENDED at the rest position, not at the explosion');

  // The explosion still animates from its own (unpaired) detonation row:
  // the HE-style ring inside its ~1.3 s window.
  engine.seekTick(1520);
  mark = canvas.log.length;
  r.draw();
  const heRing = canvas.log
    .slice(mark)
    .find((e) => e.op === 'arc' && String(e.strokeStyle).startsWith('rgba(224, 91, 91'));
  assert.ok(heRing, 'the decoy blast still plays the HE animation (the pairing never consumed it)');
  r.destroy();
});

// --- Radar layers (side-by-side panels) + elevation indicators ---------------
//
// Multi-floor packs (meta.layers) lay their layer images side by side in
// this one canvas; every world-positioned element must project through
// ITS OWN layer's panel, the layer labels only appear on multi-panel
// packs, and the CS2 T/⊥ elevation marks (orientation SETTLED 2026-11-08:
// above → ⊥ BELOW the marker, below → T ABOVE it) draw behind the entity
// ONLY when an elevation_regions box claims its XY (region-only — there
// is no per-floor threshold anymore). The single-layer path keeps
// its exact pre-layers geometry.

// layerMeta — a nuke-shaped two-layer pack (real bands: default
// [-495, 10000) upper, lower [-10000, -495); shared transform).
function layerMeta() {
  return {
    radar: { file: 'radar.png', width: 1024, height: 1024 },
    transform: { pos_x: 0, pos_y: 0, scale: 1 },
    layers: [
      {
        id: 'default',
        name: 'Upper',
        file: 'radar.png',
        width: 1024,
        height: 1024,
        z_min: -495,
        z_max: 10000,
      },
      {
        id: 'lower',
        name: 'Lower',
        file: 'radar_lower.png',
        width: 1024,
        height: 1024,
        z_min: -10000,
        z_max: -495,
      },
    ],
  };
}

const LAYER_PLAYERS = [
  { steamId: '1', name: 'alice', side: 'ct' },
  { steamId: '2', name: 'bob', side: 't' },
];

test('multi-layer pack: side-by-side panels, layer labels, per-layer projection', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  // slot0 walks the LOWER floor (z = -600 ∈ [-10000, -495)); slot1 stays
  // on the upper floor (z = 0).
  for (let f = 0; f < data.frames; f++) data.slots[0].pos[f * 4 + 2] = -600;
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas(); // 800×600
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const upper = { width: 1024, height: 1024, src: 'radar.png' };
  const lower = { width: 1024, height: 1024, src: 'radar_lower.png' };
  r.setPack(layerMeta(), upper, null, [upper, lower]);
  r.resize();

  // BOTH panels drawn, default (upper) first, lower to its right.
  const radars = opsSince(canvas.log, 'drawImage').filter(
    (e) => e.args[0] && (e.args[0].src === 'radar.png' || e.args[0].src === 'radar_lower.png'),
  );
  assert.equal(radars.length, 2, 'both layer images draw');
  assert.equal(radars[0].args[0].src, 'radar.png', 'default layer first');
  assert.equal(radars[1].args[0].src, 'radar_lower.png', 'then the lower layer');
  const s = radars[0].args[3] / 1024; // drawn px per image px (fit scale)
  const gapX = radars[1].args[1] - radars[0].args[1];
  assert.ok(
    Math.abs(gapX - (1024 + 32) * s) < 1e-6,
    `panel offset = (width + LAYER_GAP)·s, got ${gapX} vs ${(1024 + 32) * s}`,
  );
  assert.equal(radars[0].args[2], radars[1].args[2], 'panels share the top edge');

  // Layer labels — only on the multi-panel pack.
  const texts = textsSince(canvas.log);
  assert.ok(texts.includes('Upper'), 'the default layer is labelled');
  assert.ok(texts.includes('Lower'), 'the lower layer is labelled');

  // Per-layer projection: the SAME world point lands on its own panel —
  // z on the lower band shifts by exactly one panel pitch, unknown z
  // falls back to the default panel, and the shared transform keeps y
  // identical across panels.
  const up = r.worldToScreen(10, 10);
  const lo = r.worldToScreen(10, 10, -600);
  assert.ok(Math.abs(lo.x - up.x - gapX) < 1e-6, 'lower-band z shifts by the panel pitch');
  assert.equal(lo.y, up.y, 'shared transform → same y on both panels');
  assert.equal(r.worldToScreen(10, 10, null).x, up.x, 'unknown z → the default panel');
  assert.equal(r.worldToScreen(10, 10, -495).x, up.x, 'the shared bound -495 → default (its zMin)');
  assert.notEqual(r.worldToScreen(10, 10, -495.0001).x, up.x, 'one ulp below → the lower panel');

  // The DRAWN dots land on those projections: slot0 (z=-600) on the
  // lower panel, slot1 (z=0) on the default one. (Each dot paints three
  // r=9 arcs — haloRing's dark underlay + color ring and the fill — so
  // compare DISTINCT centers.)
  const dots = opsSince(canvas.log, 'arc').filter((e) => e.args[2] === 9);
  const xs = [...new Set(dots.map((d) => d.args[0]))];
  const slot1 = r.worldToScreen(50, 50); // bob's world spot on the default panel
  assert.equal(xs.length, 2, 'both player dots draw (distinct centers)');
  assert.ok(xs.some((x) => Math.abs(x - lo.x) < 1e-6), 'slot0 draws on the lower panel');
  assert.ok(xs.some((x) => Math.abs(x - slot1.x) < 1e-6), 'slot1 draws on the default panel');
  r.destroy();
});

test('elevation indicators: ⊥ below the marker when above, T above when below — region boxes only', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const img = { width: 1024, height: 1024, src: 'radar.png' };
  const c = () => r.worldToScreen(10, 10); // alice's dot center (10,10)
  // alice's NAME LABEL as recorded by drawPlayers (fillText at her dot
  // centre — no HUD / kill feed / chat is set in this test, so an
  // 'alice' fillText on screen IS the label). args[2] is the baseline.
  const nameLabel = (from) =>
    opsSince(canvas.log, 'fillText', from).find(
      (e) => e.args[0] === 'alice' && Math.abs(e.args[1] - c().x) < 1e-6,
    );

  // Configured 'above': a region box over alice's spot, reference_z −1
  // (strict bounds — the exact-threshold case is layers.test.js's). The
  // mark is ⊥ drawn BELOW the marker, clearing the name label below the
  // dot.
  r.setPack(
    {
      radar: { file: 'radar.png', width: 1024, height: 1024 },
      transform: { pos_x: 0, pos_y: 0, scale: 1 },
      elevation_regions: [
        { x: 0, y: 0, w: 100, h: 100, reference_z: -1, above: 0, below: 0 },
      ],
    },
    img,
  );
  r.resize();
  let mark = canvas.log.length;
  r.draw();
  let marks = elevMarks(canvas.log, mark);
  const above = marks.find((m) => Math.abs(m.x - c().x) < 1e-6);
  assert.ok(above, 'an entity above the level draws ⊥');
  assert.equal(above.dir, 'above', 'above → the flat bar lands BELOW the marker (⊥)');
  assert.equal(above.y, c().y, 'the stem ORIGINATES at the entity centre — never a detached mark');
  // Vertical extent HALVED 2026-11-08: the stem was 27 px (⊥ bar at
  // centre+27, past the name baseline), now 13.5 px.
  assert.equal(above.barY, c().y + 13.5, '⊥ bar centred at centre+13.5 (halved stem: was centre+27)');
  assert.equal(above.barW, 13, 'the flat bar is 13 px wide — half the first iteration (unchanged by the halving)');
  // Retargeted with the halving: the bar no longer reaches past the
  // name baseline (cy+22) — it stops inside the name-label band — but
  // must stay ATTACHED: clear of the dot's edge (cy+9), not floating.
  assert.ok(
    above.barY + ELEV_W / 2 > c().y + 9,
    `⊥ bar bottom stays past the dot's edge (attached): ${above.barY + ELEV_W / 2 - c().y} below centre`,
  );
  assert.ok(
    above.barY - ELEV_W / 2 < c().y + 22,
    `⊥ bar stops short of the name baseline (halved stem): ${above.barY - ELEV_W / 2 - c().y} below centre`,
  );
  // Name-label NUDGE (only when an indicator is present): the ⊥ bar's
  // body bottom (barY + ELEV_W/2 = cy+14.5) sits inside the plain label
  // band, so the label drops ELEV_NAME_DROP (5) — baseline cy+22 →
  // cy+27 → the 11 px text's top (≈ baseline−11 ≈ cy+16) clears the bar
  // by ~1.5 px instead of crossing it.
  const nAbove = nameLabel(mark);
  assert.ok(nAbove, "the ⊥ entity's name label still draws");
  assert.equal(nAbove.args[2], c().y + 27, '⊥ → the name baseline drops to centre+27 (cy+22 + ELEV_NAME_DROP 5)');
  assert.ok(
    nAbove.args[2] - 11 > above.barY + ELEV_W / 2,
    'the dropped label’s text top clears the ⊥ bar’s bottom (≥1.5 px of air)',
  );

  // Configured 'below': the same box with reference_z 1 → z=0 is below
  // it → T ABOVE the marker (bar on top), clear of the dot's edge.
  r.setPack(
    {
      radar: { file: 'radar.png', width: 1024, height: 1024 },
      transform: { pos_x: 0, pos_y: 0, scale: 1 },
      elevation_regions: [
        { x: 0, y: 0, w: 100, h: 100, reference_z: 1, above: 0, below: 0 },
      ],
    },
    img,
  );
  mark = canvas.log.length;
  r.draw();
  marks = elevMarks(canvas.log, mark);
  const below = marks.find((m) => Math.abs(m.x - c().x) < 1e-6);
  assert.ok(below, 'an entity below the level draws T');
  assert.equal(below.dir, 'below', 'below → the flat bar lands ABOVE the marker (T)');
  assert.equal(below.y, c().y, 'the T stem also originates at the entity centre');
  assert.equal(below.barY, c().y - 13.5, 'T bar centred at centre−13.5 (halved stem: was centre−27)');
  assert.equal(below.barW, 13, 'same flat bar, mirrored above the dot (unchanged by the halving)');
  assert.ok(
    below.barY - ELEV_W / 2 < c().y - 9,
    `T bar clear above the dot's edge: ${c().y - below.barY + ELEV_W / 2} above centre`,
  );
  // The rule is "a mark is present" — EITHER direction — so T drops the
  // label too (one simple condition, never re-derived per direction),
  // even though the T bar itself never reaches the label band.
  const nBelow = nameLabel(mark);
  assert.ok(nBelow, "the T entity's name label still draws");
  assert.equal(nBelow.args[2], c().y + 27, 'T → same drop: baseline centre+27 (the condition is "mark present")');

  // NOT configured → no marks at all (region-only: no box, no indicator
  // — also the single-layer default).
  r.setPack(
    {
      radar: { file: 'radar.png', width: 1024, height: 1024 },
      transform: { pos_x: 0, pos_y: 0, scale: 1 },
    },
    img,
  );
  mark = canvas.log.length;
  r.draw();
  assert.equal(elevMarks(canvas.log, mark).length, 0, 'no region boxes → no indicators');
  // No mark → NO nudge: the label keeps the plain baseline cy+r+13
  // (DOT_R 9 → cy+22), exactly where it sat before the name nudge.
  const nNone = nameLabel(mark);
  assert.ok(nNone, 'the name label still draws without an indicator');
  assert.equal(nNone.args[2], c().y + 22, 'no indicator → the baseline stays centre+22 (unchanged)');

  // A STALE top-level `elevation` key (dropped from the contract) is
  // ignored — it must never resurrect per-floor thresholds.
  r.setPack(
    {
      radar: { file: 'radar.png', width: 1024, height: 1024 },
      transform: { pos_x: 0, pos_y: 0, scale: 1 },
      elevation: { reference_z: -1, above: 0, below: 0 },
    },
    img,
  );
  mark = canvas.log.length;
  r.draw();
  assert.equal(elevMarks(canvas.log, mark).length, 0, 'a stale elevation key draws nothing (region-only contract)');
  r.destroy();
});

test('elevation indicators: elevation_regions flow through the pack config as the only threshold source', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const img = { width: 1024, height: 1024, src: 'radar.png' };
  // NO layer/top-level elevation exists anymore — only a region box
  // covering alice's spot (10,10): the region alone must produce the
  // mark, proving the meta.elevation_regions → makeTransform → panels →
  // draw path.
  r.setPack(
    {
      radar: { file: 'radar.png', width: 1024, height: 1024 },
      transform: { pos_x: 0, pos_y: 0, scale: 1 },
      elevation_regions: [
        { x: 0, y: 0, w: 100, h: 100, reference_z: -1, above: 0, below: 0 },
      ],
    },
    img,
  );
  r.resize();
  const mark = canvas.log.length;
  r.draw();
  const c = r.worldToScreen(10, 10);
  const marks = elevMarks(canvas.log, mark);
  const inBox = marks.find((m) => Math.abs(m.x - c.x) < 1e-6);
  assert.ok(inBox, 'a region box with thresholds produces the mark');
  assert.equal(inBox.dir, 'above', "the region's reference_z decides the direction");
  // bob at (50,50) is ALSO inside the box (0..100) → also marked; the
  // box's thresholds, the only thresholds there are.
  const c2 = r.worldToScreen(50, 50);
  assert.ok(marks.some((m) => Math.abs(m.x - c2.x) < 1e-6), 'every entity in the box is marked');
  r.destroy();
});

test('single-layer pack: one panel at the legacy geometry, no labels, no indicator noise', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const img = { width: 1024, height: 1024, src: 'radar.png' };
  r.setPack(
    {
      radar: { file: 'radar.png', width: 1024, height: 1024 },
      transform: { pos_x: 0, pos_y: 0, scale: 1 },
    },
    img,
  );
  r.resize();

  // Exactly ONE radar drawImage at the pre-layers position/size:
  // fit = min(800,600)/1024 = 0.5859375 → x = 400 − 512·fit = 100,
  // y = 300 − 512·fit = 0, w = h = 600. (Exact binary values — the
  // assertion pins the LEGACY geometry to the pixel.)
  const radars = opsSince(canvas.log, 'drawImage').filter((e) => e.args[0] && e.args[0].src === 'radar.png');
  assert.equal(radars.length, 1, 'a single-layer pack draws ONE panel');
  assert.deepEqual(
    radars[0].args.slice(1),
    [100, 0, 600, 600],
    'the exact pre-layers drawImage box (no offsets, no gutters)',
  );
  // drawRadar pins the smoothing QUALITY too: the context default is
  // 'low' (plain bilinear), which aliases the extractor's 3× radar
  // PNG when the webview downscales it at fit zoom. The recording
  // ctx's set trap stores property writes, so this is observable.
  assert.equal(
    canvas.getContext().imageSmoothingQuality,
    'high',
    'drawRadar asks for high-quality image smoothing before blitting the radar',
  );

  const mark = canvas.log.length;
  r.draw();
  const texts = textsSince(canvas.log, mark);
  assert.ok(!texts.includes('Upper') && !texts.includes('Lower'), 'no layer labels without layers');
  assert.ok(
    !texts.includes('⊥') && !texts.includes('T') && elevMarks(canvas.log, mark).length === 0, // unconfigured → no marks
    'no elevation config → no indicators on a single-layer pack',
  );
  r.destroy();
});

test('elevation indicators: drawn as canvas strokes — extracted glyphs and text are never used', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const img = { width: 1024, height: 1024, src: 'radar.png' };
  r.setPack(
    {
      radar: { file: 'radar.png', width: 1024, height: 1024 },
      transform: { pos_x: 0, pos_y: 0, scale: 1 },
      elevation_regions: [
        { x: 0, y: 0, w: 100, h: 100, reference_z: -1, above: 0, below: 0 },
      ],
    },
    img,
  );
  // A pack extracted when mappack still had elevIconTable ships these
  // two glyphs in its icon manifest — the renderer must ignore them:
  // the mark is drawn from canvas paths (user decision 2026-11-08, the
  // extracted glyphs rendered poorly).
  r.setIcons({
    elev_above: { width: 13, height: 7, src: 'map_bomb_above.svg' },
    elev_below: { width: 13, height: 7, src: 'map_bomb_below.svg' },
  });
  r.resize(); // the first draw builds the tint cache for the real icons
  const mark = canvas.log.length;
  r.draw();
  const c = r.worldToScreen(10, 10);
  const marks = elevMarks(canvas.log, mark);
  assert.ok(
    marks.some((m) => Math.abs(m.x - c.x) < 1e-6 && Math.abs(m.y - c.y) < 1e-6),
    'the mark is canvas-drawn, stem anchored at the dot centre',
  );
  // the two passes: the dark halo (the monoline weight +2, +1px past
  // each bar end) under the tinted body — one stroke each.
  assert.ok(
    opsSince(canvas.log, 'stroke', mark).some(
      (e) => e.strokeStyle === 'rgba(8, 10, 14, 0.85)' && e.lineWidth === ELEV_W + 2,
    ),
    'the dark halo pass paints the glyph 1px larger all round',
  );
  assert.ok(
    opsSince(canvas.log, 'stroke', mark).some((e) => e.strokeStyle === ELEV_TINT && e.lineWidth === ELEV_W),
    'the tinted body pass paints it (neutral wash, never a team color)',
  );
  const imgs = opsSince(canvas.log, 'drawImage', mark).map((e) => e.args[0] && e.args[0].src);
  assert.ok(
    !imgs.includes('map_bomb_above.svg') && !imgs.includes('map_bomb_below.svg'),
    'the extracted glyph is never drawn',
  );
  const texts = opsSince(canvas.log, 'fillText', mark).map((e) => e.args[0]);
  assert.ok(!texts.includes('⊥') && !texts.includes('T'), 'no text glyph either');
  r.destroy();
});

test('flightSplits: per-layer spans for a floor-crossing nade flight (and the degenerate cases)', () => {
  // Nuke's real bands (CS2.md "verticalsections"): default [-495, 10000),
  // lower [-10000, -495). Plain band objects — layerIndexForZ and
  // flightSplits only read zMin/zMax.
  const bands = [
    { zMin: -495, zMax: 10000 },
    { zMin: -10000, zMax: -495 },
  ];
  // Same floor → ONE span, i.e. exactly the old single-segment line.
  assert.deepEqual(flightSplits(-600, -700, bands), [{ t0: 0, t1: 1, layer: 1 }]);
  assert.deepEqual(flightSplits(10, 20, bands), [{ t0: 0, t1: 1, layer: 0 }]);
  // bottom ramp (-600, lower) → top ramp (+50, upper): split exactly at
  // the shared band edge z = -495 → t = 105/650 (integer math — exact).
  const up = flightSplits(-600, 50, bands);
  assert.equal(up.length, 2, 'one span per floor');
  assert.deepEqual(up.map((s) => s.layer), [1, 0], 'lower first, then upper');
  assert.equal(up[0].t0, 0);
  assert.equal(up[0].t1, 105 / 650, 'the crossing lands on the band edge');
  assert.equal(up[1].t0, up[0].t1, 'spans tile without a gap');
  assert.equal(up[1].t1, 1);
  // Descending the other way splits at the same edge (t = 545/650).
  const down = flightSplits(50, -600, bands);
  assert.equal(down.length, 2);
  assert.deepEqual(down.map((s) => s.layer), [0, 1]);
  assert.equal(down[0].t1, 545 / 650);
  // Unknown z on either end → ONE span on the KNOWN end's layer (the
  // same rule the flight icon rides); both unknown → default layer.
  assert.deepEqual(flightSplits(null, 50, bands), [{ t0: 0, t1: 1, layer: 0 }]);
  assert.deepEqual(flightSplits(-600, undefined, bands), [{ t0: 0, t1: 1, layer: 1 }]);
  assert.deepEqual(flightSplits(NaN, NaN, bands), [{ t0: 0, t1: 1, layer: 0 }]);
  // Equal z (or no panels at all) → one span, no crash.
  assert.deepEqual(flightSplits(-600, -600, bands), [{ t0: 0, t1: 1, layer: 1 }]);
  assert.deepEqual(flightSplits(10, 20, null), [{ t0: 0, t1: 1, layer: 0 }]);
});

test('cross-layer nade flight: the line splits at the band edge instead of crossing the gutter', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const upper = { width: 1024, height: 1024, src: 'radar.png' };
  const lower = { width: 1024, height: 1024, src: 'radar_lower.png' };
  r.setPack(layerMeta(), upper, null, [upper, lower]);
  const mk = (ev) => normalizeEvent(ev, {});
  // bottom ramp (lower floor, z=-600) → top ramp (upper floor, z=+50):
  // the throw crosses the -495 band edge mid-flight — the case a
  // panel-to-panel line would lie about.
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 50, round: 1, kind: 'grenade_throw', attacker: '1', weapon: 'Smoke Grenade', posX: 70, posY: 70, posZ: -600 }),
    mk({ id: 2, seq: 2, tick: 200, round: 1, kind: 'grenade', attacker: '1', weapon: 'Smoke Grenade', posX: 90, posY: 90, posZ: 50 }),
  ]);
  r.resize();
  engine.seekTick(100); // mid-flight (throw 50 ≤ 100 ≤ detonation 200)
  const mark = canvas.log.length;
  r.draw();

  // The flight path: moveTo/lineTo pairs carrying the flight's dash
  // (lineDash [4,4], lineWidth 1.5) — TWO segments for a crossing
  // flight (a same-floor flight draws one — see flightSplits' unit
  // test; a single panel-to-panel line would be ONE segment).
  const dashed = canvas.log
    .slice(mark)
    .filter(
      (e) =>
        (e.op === 'moveTo' || e.op === 'lineTo') &&
        e.lineDash[0] === 4 &&
        e.lineDash[1] === 4 &&
        e.lineWidth === 1.5,
    );
  assert.equal(dashed.length, 4, `two moveTo/lineTo segments, got ${dashed.length}`);

  // Segment 1 starts at the throw point on the LOWER panel (its own
  // floor — the same projection worldToScreen gives the origin dot).
  const lo = r.worldToScreen(70, 70, -600);
  assert.ok(Math.abs(dashed[0].args[0] - lo.x) < 1e-6, 'segment 1 starts at the throw point');
  assert.ok(Math.abs(dashed[0].args[1] - lo.y) < 1e-6, '…on the lower panel');

  // The crossing point repeats on the OTHER panel: identical world XY,
  // projected through the other panel, shifts by exactly the panel
  // pitch — never a line drawn THROUGH the gutter.
  const radarDraw = opsSince(canvas.log, 'drawImage').find(
    (e) => e.args[0] && e.args[0].src === 'radar.png',
  );
  const s = radarDraw.args[3] / 1024; // fit scale
  const pitch = (1024 + 32) * s;
  const seg0End = dashed[1]; // lineTo — end of the lower span
  const seg1Start = dashed[2]; // moveTo — same point, upper span
  // The LOWER panel is the second layer (offset right by one pitch), so
  // the upper-panel copy of the crossing sits exactly one pitch LEFT of
  // it — same world XY, other panel, never a line through the gutter.
  assert.ok(
    Math.abs(seg0End.args[0] - seg1Start.args[0] - pitch) < 1e-6,
    `the spans meet at the same XY on the two panels (off by ${seg0End.args[0] - seg1Start.args[0]}, pitch ${pitch})`,
  );
  assert.equal(seg1Start.args[1], seg0End.args[1], 'shared transform → identical y');

  // …and the flight ENDS on the upper panel at the detonation point.
  const hi = r.worldToScreen(90, 90, 50);
  assert.ok(Math.abs(dashed[3].args[0] - hi.x) < 1e-6, 'segment 2 ends at the detonation');
  assert.ok(Math.abs(dashed[3].args[1] - hi.y) < 1e-6, '…on the upper panel');
  r.destroy();
});

test('util elevation marks: only the LANDED decoy is marked — never the in-flight nade', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const img = { width: 1024, height: 1024, src: 'radar.png' };
  // A region box covering ONLY the decoy's corner ((70,70)→(90,90) ⊂
  // 60..120): the players at (10,10)/(50,50) stay outside it, so any
  // ⊥/T in the log belongs to the util and nothing else.
  r.setPack(
    {
      radar: { file: 'radar.png', width: 1024, height: 1024 },
      transform: { pos_x: 0, pos_y: 0, scale: 1 },
      elevation_regions: [{ x: 60, y: 60, w: 60, h: 60, reference_z: -1, above: 0, below: 0 }],
    },
    img,
  );
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 50, round: 1, kind: 'grenade_throw', attacker: '1', weapon: 'Decoy Grenade', posX: 70, posY: 70, posZ: 0 }),
    mk({ id: 2, seq: 2, tick: 100, round: 1, kind: 'grenade_land', attacker: '1', weapon: 'Decoy Grenade', posX: 70, posY: 70, posZ: 0 }),
  ]);
  r.setDecoyPlan([
    { landTick: 100, detTick: 500, x: 70, y: 70, z: 0, side: 'ct', weapon: 'Decoy Grenade', shots: [] },
  ]);
  r.resize();

  const marks = (from) => elevMarks(canvas.log, from);

  // IN FLIGHT (throw 50 → rest 100): the arc draws, but util in the air
  // is never marked — a nade's altitude mid-arc means nothing.
  engine.seekTick(75);
  let mark = canvas.log.length;
  r.draw();
  assert.equal(marks(mark).length, 0, 'the in-flight nade draws NO indicator');

  // LANDED (rest window [100, 500)): the rest icon is marked — ⊥ below
  // it (z=0 is strictly above the region's reference −1).
  engine.seekTick(200);
  mark = canvas.log.length;
  r.draw();
  const landed = marks(mark);
  assert.equal(landed.length, 1, 'exactly the landed decoy is marked');
  const c = r.worldToScreen(70, 70);
  assert.equal(landed[0].dir, 'above', '⊥ — the flat bar below the marker (entity above the level)');
  assert.ok(Math.abs(landed[0].x - c.x) < 1e-6, 'anchored to the decoy');
  assert.ok(landed[0].barY > c.y, '⊥ below the marker (entity above the level)');
  r.destroy();
});
