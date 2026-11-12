// Tests for the replay renderer's PURE helpers (lib/replay/renderer.js):
// the trail-continuity rule (trailConnects — the break that keeps player
// movement trails from streaking across a round reset or a
// death→respawn teleport, plus the TRAIL_MIN_SPEED speed gate: segments
// traversed below 135 units/sec draw no trail), the smart camera's fit/ease (smartCamTarget,
// easeValue, camConverged), the world-layer geometry (chevronPath,
// crossPath, muzzleRays), the tick-window effects (windowAlpha,
// blindAlpha, voiceBloom), the death-marker lifetime
// (killEndTick) — plus end-to-end draws over a recording 2D context
// (the world layers follow the tick: lingering smoke/fire, the death
// X's round cleanup incl. the post-round C4 kill and the EXACT
// round_start boundary seek, the unified round-end entity cleanup —
// roundcut.js: smoke/fire areas die AT round_end (lifetime outrun
// included), pops/arcs at the NEXT round_start only, with the
// bomb_explode ring's full 3 s past end_tick as the non-vacuous guard,
// the C4 icon and its aspect-preserving
// draw, the traveling-dash bullet tracer (a 14 px side-colored dash per
// row sliding from the fire position out r+MUZZLE_REACH over its 0.1 s
// travel — miss fades out on the way, mask-guarded + under the dots),
// the hit-shot tracer (the shooter→victim dash over the same travel —
// its skips, pellet dedupe, NO-fade alpha, shooter-side colors and layer
// order), the
// LIGHTER flash overlay (peak 0.6, never solid
// white) and the white talking bloom drawn BENEATH its dot, the
// death-X-under-C4 layer order, the carried-C4 badge on the carrier's
// dot and the plant/defuse progress ring (a tick-pure, round-capped
// partial arc on the ACTOR's dot — red while planting, green while
// defusing), the thrower-side tint of the util flight line + icon, the
// thrower-team tint of the lingering smoke area + its detonation bloom
// ring (neutral gray when the thrower is unknown); a
// crouch-size check; and the
// HUD — the SCORE-ANCHORED team-score box (the '‹ct› – ‹t›' segment
// dead-center of the box, unequal name widths padding the shorter side,
// CT/T names in their side colors, white score), the team-side pairing
// rule (hudTeamNames — the ct slot holds the team on CT at the playhead),
// the codicon freeze clock (document.fonts.check stubbed both ways), the
// C4/0:00 clock, the score↔feed gap clamp (C1: the box lays into
// [control-group budget, feed left − 8] and ellipsizes the longer team
// name to fit — the feed never yields) and the RETIRED playback readout
// (no follow:/loop:/packNote fillText ever, no left-aligned box — those
// rows are DOM now) — plus the
// round-scoped kill feed with its rounded entry boxes, image cells that
// reserve their PAINTED width (a 12 px gap on each side of every cell),
// the append-at-bottom stack (oldest on top) and the 22 px entry pitch,
// the round-scoped bottom-left chat
// (round/round-change/scrub scoping, speaker colors, the 6-cap stack
// newest-at-bottom, message truncation, owning the corner alone)
// and the ONE entry-box painter both overlays share) — plus the
// performance wave's pins: the trail alpha-band batching (same segments,
// one stroke per band, the fade direction kept), the moving-vs-settled
// radar smoothing quality, the cached chat cut, the one-pass HUD
// measure, the precomputed drop window (swept against dropEvidenceAt)
// and the scrub-drag draw coalescing.
// Run: node --test src/lib/renderer.test.js (from frontend/; the lib test
// glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  trailConnects,
  smartCamTarget,
  smartMarginFor,
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
  TRAIL_BANDS,
  trailBandIndex,
  trailBandAlpha,
  joinBounceVerts,
  flightPointAt,
} from './replay/renderer.js';
import { dropEvidenceAt, dropWindow } from './replay/drops.js';
import { buildKitEvidence } from './replay/kits.js';
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
  // 4 units/tick = 256 u/s at 64 Hz — comfortably above TRAIL_MIN_SPEED
  // (135), so every segment of a running player draws.
  const pos = slotPos([
    [0, 0],
    [4, 0],
    [8, 1],
    [12, 2],
  ]);
  assert.equal(trailConnects(ticks, pos, 0, 64), true);
  assert.equal(trailConnects(ticks, pos, 1, 64), true);
  assert.equal(trailConnects(ticks, pos, 2, 64), true);
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
  assert.equal(trailConnects(ticks, pos, 0, 64), true); // inside the old round
  assert.equal(trailConnects(ticks, pos, 1, 64), false); // the reset boundary
  assert.equal(trailConnects(ticks, pos, 2, 64), true); // fresh from spawn
});

test('a stalled tick gap breaks the trail', () => {
  const ticks = [0, 1, 2, 20];
  const pos = slotPos([
    [0, 0],
    [4, 0],
    [8, 0],
    [12, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, 1, 64), true); // gap of 1 tick
  assert.equal(trailConnects(ticks, pos, 2, 64), false); // gap of 18 ticks
});

test('a non-advancing tick never connects', () => {
  const ticks = [0, 0, 1];
  const pos = slotPos([
    [0, 0],
    [4, 0],
    [8, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, 0, 64), false);
});

test('the step threshold is generous to movement, not to teleports', () => {
  const ticks = [0, 1, 2];
  const near = slotPos([
    [0, 0],
    [256, 0],
    [512, 0],
  ]);
  assert.equal(trailConnects(ticks, near, 0, 64), true);
  const far = slotPos([
    [0, 0],
    [257, 0],
    [514, 0],
  ]);
  assert.equal(trailConnects(ticks, far, 0, 64), false);
});

test('the segment off either end of the window does not connect', () => {
  const ticks = [0, 1];
  const pos = slotPos([
    [0, 0],
    [4, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, -1, 64), false);
  assert.equal(trailConnects(ticks, pos, 1, 64), false); // f+1 past the end
});

// --- the speed gate (TRAIL_MIN_SPEED, 135 units/sec) ------------------------
//
// A segment draws only when the player traversed it at ≥ 135 u/s
// (horizontal): slow/walking movement and standing jitter leave no
// trail. All fixtures sit exactly on dyadic tick displacements so the
// boundary comparisons are bit-exact (135/64 = 2.109375 units/tick at
// 64 Hz).

test('a slow segment (< 135 u/s) draws no trail', () => {
  const ticks = [0, 1, 2];
  // ~100 u/s at 64 Hz = 1.5625 units/tick — walking history, gated out;
  // standing jitter (dx = dy = 0) contributes no trail either.
  const pos = slotPos([
    [0, 0],
    [1.5625, 0],
    [3.125, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, 0, 64), false); // 100 u/s
  assert.equal(trailConnects(ticks, pos, 1, 64), false); // still 100 u/s
  const still = slotPos([
    [0, 0],
    [0.01, 0],
    [0.02, 0],
  ]);
  assert.equal(trailConnects(ticks, still, 0, 64), false); // jitter ≈ 0.6 u/s
});

test('a fast segment (≥ 135 u/s) draws', () => {
  const ticks = [0, 1];
  // ~250 u/s at 64 Hz = 3.90625 units/tick — above the gate, well
  // below the 256-unit teleport guard.
  const pos = slotPos([
    [0, 0],
    [3.90625, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, 0, 64), true);
});

test('the speed boundary is ≥ (exactly 135 u/s draws, one hair under does not)', () => {
  const ticks = [0, 1];
  // exactly TRAIL_MIN_SPEED · gap / tickRate = 135/64 units per tick
  const at = slotPos([
    [0, 0],
    [135 / 64, 0],
  ]);
  assert.equal(trailConnects(ticks, at, 0, 64), true); // boundary included
  const under = slotPos([
    [0, 0],
    [135 / 64 - 1e-6, 0],
  ]);
  assert.equal(trailConnects(ticks, under, 0, 64), false); // boundary excluded below
});

test('the same displacement over a larger gap drops below the speed', () => {
  // 4 units over 1 tick = 256 u/s → draws…
  const fast = slotPos([
    [0, 0],
    [4, 0],
    [8, 0],
  ]);
  assert.equal(trailConnects([0, 1, 2], fast, 0, 64), true);
  // …the SAME 4 units spread over 4 ticks = 64 u/s → below the gate
  // (the gap itself, 4 ≤ TRAIL_MAX_TICK_GAP, is fine — speed is not).
  const slow = slotPos([
    [0, 0],
    [4, 0],
  ]);
  assert.equal(trailConnects([0, 4], slow, 0, 64), false);
  // and exactly at the threshold over that larger gap still draws:
  // 135 · 4 / 64 = 8.4375 units over 4 ticks = 135 u/s.
  const at = slotPos([
    [0, 0],
    [8.4375, 0],
  ]);
  assert.equal(trailConnects([0, 4], at, 0, 64), true);
});

test('the speed gate needs a valid tickRate (fail closed, no ungated default)', () => {
  const ticks = [0, 1];
  const pos = slotPos([
    [0, 0],
    [4, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, 0, 64), true);
  // a stale call missing the rate must NOT draw an un-gated trail
  assert.equal(trailConnects(ticks, pos, 0), false);
  assert.equal(trailConnects(ticks, pos, 0, undefined), false);
  assert.equal(trailConnects(ticks, pos, 0, 0), false);
  assert.equal(trailConnects(ticks, pos, 0, -64), false);
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

// The margin is size-aware (smartMarginFor): identical framing at full
// size — the reference-and-above value is EXACTLY the pre-existing 56 px,
// so every large-size pin above passes bit-identical — and meaningfully
// tighter at the mini-player dock's ~320×190, where the fixed 56 px ate
// a proportionally huge slice (78 of 190 px vertically) and left the
// radar needlessly zoomed out. Stateless: derived from the canvas
// dimensions alone, wherever that canvas lives.
test('smartCamTarget margin: identical framing at full size, tighter at the dock', () => {
  // Full size → EXACTLY today's 56 px (the convergence proof): at and
  // above the 480 px short-side reference the formula clamps to the
  // legacy constant, so the fit is bit-identical to the fixed-margin
  // formula the pins above were written against.
  assert.equal(smartMarginFor(800, 600), 56);
  assert.equal(smartMarginFor(480, 1200), 56); // exactly at the reference
  assert.equal(smartMarginFor(6000, 6000), 56);
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  const full = smartCamTarget(box, 800, 600, { maxZoom: 10 });
  assert.equal(full.s, (800 - 2 * 56) / 100); // the old formula's exact value (6.88)
  // Linear below the reference: the midpoint is exactly half.
  assert.equal(smartMarginFor(240, 900), 28); // 56 × 240/480
  // The dock (~320×190): the margin tightens to ≈22 px — less than half
  // — so the SAME box frames strictly larger than the fixed-56 formula
  // allowed ((320 − 112)/100 = 2.08), and the height stops being the
  // starvation side: 190 − 2×22 ≈ 146 px of vertical room vs 78 before.
  assert.ok(smartMarginFor(320, 190) < 56 / 2, String(smartMarginFor(320, 190)));
  const dock = smartCamTarget(box, 320, 190, { maxZoom: 10 });
  assert.ok(dock.s > (320 - 2 * 56) / 100, `dock s=${dock.s}`);
  assert.ok(dock.s <= 320 / 100, 'never wider than the raw canvas');
  assert.ok(190 - 2 * smartMarginFor(320, 190) > 190 - 2 * 56, 'more vertical room than the fixed margin');
  // The floor: tiny canvases keep padding — never a zero/negative slot
  // (availW/H are Math.max(1, …) downstream, but the margin itself
  // never collapses to nothing).
  assert.equal(smartMarginFor(40, 40), 10);
  // Degenerate input keeps the full-size value rather than NaN.
  assert.equal(smartMarginFor(NaN, 600), 56);
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

// --- unified round-end entity cleanup (lib/replay/roundcut.js) ----------------
//
// The SAME strategy the death X and the planted C4 already solved, applied
// to the entities that used to leak past their round: the lingering
// smoke/fire AREA dies AT round_end (min(own lifetime, round cut)), while
// POPS/arcs (detonation pops, bomb explode/defuse pops, grenade flight
// arcs, the decoy rest window) deliberately survive round_end and die only
// at the NEXT round_start — bomb_explode sits exactly ON end_tick, so a
// round_end cut would kill the 3 s explosion ring on its own tick.
// Every gate is the established boundary spelling `tick >= end &&
// tick !== row.tick` (gone AT the cutoff, the row's own tick always draws),
// so a paused ribbon seek clears the entity and a backwards scrub
// re-derives it — nothing sticky.

test('round-end cleanup: the lingering smoke area dies AT round_end (boundary, scrub, lifetime outrun)', () => {
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
    // one smoke at tick 128: its own 18 s lifetime runs to 1280, but
    // round 1 ENDS at 400 — the round cut wins (the leak the evidence
    // found: smoke past the end rode into the next round's freezetime)
    mk({ id: 1, seq: 1, tick: 128, round: 1, kind: 'grenade', attacker: '1', weapon: 'Smoke Grenade', posX: 50, posY: 50 }),
    mk({ id: 2, seq: 2, tick: 400, round: 1, kind: 'round_end' }),
    mk({ id: 3, seq: 3, tick: 450, round: 2, kind: 'round_start' }),
  ]);
  r.resize();
  // alice is CT → the 50/50 CT blend of the neutral smoke gray
  // (smokeColorRGB / SMOKE_CT in renderer.js)
  const AREA_FILL = 'rgba(135, 180, 218, 0.3)';
  const at = (tick) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return canvas.log.slice(mark).some((e) => e.op === 'fill' && e.fillStyle === AREA_FILL);
  };

  assert.equal(at(399), true, 'the smoke is drawn the tick BEFORE its round_end');
  assert.equal(at(400), false, 'gone AT round_end — not one tick after it (the boundary spelling)');
  assert.equal(at(401), false, 'still gone a tick into the next frame');
  assert.equal(at(300), true, 'a backwards scrub re-derives the area (nothing sticky)');
  assert.equal(
    at(500),
    false,
    'the 18 s smoke that outruns its round is cut (non-vacuous: its natural end is 1280)',
  );
  assert.equal(at(1299), false, 'and its own 18 s lifetime still ends it');
  r.destroy();
});

test('round-end cleanup: a smoke/fire detonated AFTER round_end survives to the next round_start', () => {
  // The post-round shape: round 1 already ended at 400 when the smoke (420)
  // and the molotov (425) land — no same-round round_end is left to cut
  // them, so the boundary is the NEXT round's start (450), exactly like
  // the post-round C4 kill's killEndTick.
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
    mk({ id: 1, seq: 1, tick: 420, round: 1, kind: 'grenade', attacker: '1', weapon: 'Smoke Grenade', posX: 50, posY: 50 }),
    mk({ id: 2, seq: 2, tick: 425, round: 1, kind: 'grenade', attacker: '1', weapon: 'Molotov', posX: 60, posY: 60 }),
    mk({ id: 3, seq: 3, tick: 400, round: 1, kind: 'round_end' }),
    mk({ id: 4, seq: 4, tick: 450, round: 2, kind: 'round_start' }),
  ]);
  r.resize();
  const SMOKE_FILL = 'rgba(135, 180, 218, 0.3)';
  const FIRE_FILL = 'rgba(235, 70, 55, 0.3)';
  const at = (tick, fill) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return canvas.log.slice(mark).some((e) => e.op === 'fill' && e.fillStyle === fill);
  };

  assert.equal(at(440, SMOKE_FILL), true, 'the post-round smoke keeps drawing (natural end 1572)');
  assert.equal(at(449, SMOKE_FILL), true, '…right up to the tick before the next round_start');
  assert.equal(at(450, SMOKE_FILL), false, 'gone AT the next round_start');
  assert.equal(at(451, SMOKE_FILL), false, 'and still gone a tick later');
  assert.equal(at(430, SMOKE_FILL), true, 'a backwards scrub re-derives it');
  assert.equal(at(445, FIRE_FILL), true, 'the post-round fire keeps burning (natural end 873)');
  assert.equal(at(449, FIRE_FILL), true, '…up to the boundary');
  assert.equal(at(450, FIRE_FILL), false, 'the fire dies AT the next round_start too');
  r.destroy();
});

test('pops: the bomb_explode ring paints its full 3 s past end_tick (round_end on its own tick)', () => {
  // NON-VACUOUS GUARD for P2: bomb_explode sits exactly ON the round_end
  // tick (400) — a round_end cut (the P1 rule) would kill the 3 s blast
  // ring on its own tick, leaving a one-frame flash. Pops are cut only at
  // the NEXT round_start, so the ring runs its whole window.
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
    mk({ id: 1, seq: 1, tick: 400, round: 1, kind: 'bomb_explode', posX: 50, posY: 50 }),
    mk({ id: 2, seq: 2, tick: 400, round: 1, kind: 'round_end' }),
    // far enough out that the 3 s window (400..592) always finishes first
    mk({ id: 3, seq: 3, tick: 1000, round: 2, kind: 'round_start' }),
  ]);
  r.resize();
  const ring = (tick) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return canvas.log
      .slice(mark)
      .some((e) => e.op === 'stroke' && String(e.strokeStyle).startsWith('rgba(224, 91, 91'));
  };

  assert.equal(ring(400), true, 'the blast ring starts on its own tick (the own-tick exemption)');
  assert.equal(ring(450), true, '50 ticks past end_tick — a round_end cut would have killed it here');
  assert.equal(ring(590), true, '…and it still paints at ~2.98 s: the FULL 3 s window survives');
  assert.equal(ring(600), false, 'its own 3 s window ends it (age > 3 s)');
  assert.equal(ring(700), false, 'still gone later in the freezetime');
  r.destroy();
});

test('pops die at the next round_start: an HE det after round_end pops only until round 2 starts', () => {
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
    mk({ id: 1, seq: 1, tick: 420, round: 1, kind: 'grenade', attacker: '1', weapon: 'HE Grenade', posX: 50, posY: 50 }),
    mk({ id: 2, seq: 2, tick: 400, round: 1, kind: 'round_end' }),
    // inside the HE ring's own 1.3 s window (420 → 503): the boundary is
    // the round, not the duration
    mk({ id: 3, seq: 3, tick: 470, round: 2, kind: 'round_start' }),
  ]);
  r.resize();
  const ring = (tick) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return canvas.log
      .slice(mark)
      .some((e) => e.op === 'stroke' && String(e.strokeStyle).startsWith('rgba(224, 91, 91'));
  };

  assert.equal(ring(440), true, 'the pop ignores the round_end — P2 grace (round 1 already ended at 400)');
  assert.equal(ring(469), true, 'drawn right up to the tick before the boundary');
  assert.equal(ring(470), false, 'gone AT the next round_start');
  assert.equal(ring(471), false, 'and still gone a tick later');
  assert.equal(
    ring(490),
    false,
    'non-vacuous: its own 1.3 s ring would still be drawing here (natural end ~503)',
  );
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
  // frame has the same 0 bits in the real q16 stream).
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

test('C4 badge two-pass: the carrier badge paints AFTER every dot and name label', () => {
  // C2: the badge used to draw INSIDE the slot loop, so it was covered
  // by every dot/label drawn after its own slot (slot 0's badge sat
  // under slot 1's dot). It is now COLLECTED in the loop and painted in
  // a second pass — the ordering pins below are exactly that contract.
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
  r.setIcons({ C4: { width: 48, height: 24, src: 'c4.svg' } });
  // alice (slot 0, drawn FIRST in the loop) carries the bomb.
  r.setStateIndex(
    buildStateIndex([{ frame: 0, slot: 0, mask: 0x008, inventory: ['C4', 'AK-47'] }], 2),
  );
  r.resize();
  engine.seekTick(10);
  const mark = canvas.log.length;
  r.draw();
  const seq = canvas.log.slice(mark);

  const badges = seq.filter((e) => e.op === 'drawImage' && e.args[3] === 20 && e.args[4] === 10);
  assert.equal(badges.length, 1, 'exactly one carrier badge (alice\'s)');
  const badgeAt = seq.indexOf(badges[0]);

  // BOTH dots draw (alice ct-blue, bob t-amber at r=9) — filtered to
  // the BODY fill (arc immediately followed by fill: the rim/halo rings
  // share the fillStyle but stroke instead). The badge must sit above
  // the dot drawn AFTER it in the loop (bob's), which is the case the
  // in-loop draw got wrong.
  const dots = seq.filter(
    (e, i) =>
      e.op === 'arc' &&
      e.args[2] === 9 &&
      (e.fillStyle === '#5aa9e6' || e.fillStyle === '#e6a35a') &&
      seq[i + 1] &&
      seq[i + 1].op === 'fill',
  );
  assert.equal(dots.length, 2, 'both dots draw in one frame');
  for (const d of dots) {
    assert.ok(badgeAt > seq.indexOf(d), 'the badge paints above EVERY dot');
  }

  // …and above every name label (the labels are painted inside the
  // loop, after each dot — the second pass clears them all).
  const names = seq.filter((e) => e.op === 'fillText' && (e.args[0] === 'alice' || e.args[0] === 'bob'));
  assert.equal(names.length, 2, 'both name labels draw');
  for (const n of names) {
    assert.ok(badgeAt > seq.indexOf(n), 'the badge paints above EVERY name label');
  }
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
// hudBoxesSince — hudBox's own boxes (radius 6): the ONE top-center
// score/clock box (the bottom-left readout is gone — its state lives in
// the DOM control group, so a radius-6 box is always the top one).
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
  // …and this renderer never got a map pack: reproject's packNote used
  // to ride the bottom-left readout as a canvas line. That COPY is
  // retired with the readout — the one packNote is Replay's DOM
  // control-group row — so the canvas carries no radar/grid note at all.
  assert.ok(
    !texts.some((t) => String(t).startsWith('No radar image')),
    'the canvas packNote copy is gone (the DOM control-group row owns it)',
  );

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

// --- C1: the score box yields to its two neighbours ---------------------------
//
// Region map (renderer.js): the score box lays into [control-group
// budget, kill-feed left − 8]. Overlap with the feed happened whenever
// cssW ≲ 1024 (the feed is right-anchored, the box was centered), so the
// feed's widest row is measured FIRST and the box is clamped into the
// gap — ellipsizing the longer team name when the line cannot fit it.
// The feed NEVER yields (gameplay record): the invariant is
// box.right ≤ feed.left − 8 at every stage width, short names and long
// names alike.

test('score box right edge ≤ feed left − 8 across cssW ∈ {400,600,800,1200} × short/long names', () => {
  headlessGlobals();
  const round = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  const kill = {
    id: 1,
    seq: 1,
    tick: 50,
    round: 1,
    kind: 'kill',
    attacker: '1',
    attackerName: 'alice',
    victim: '2',
    victimName: 'bob',
    weapon: 'AK-47',
  };
  const namePairs = [
    ['A', 'B'], // short names — the line fits, only the clamp can move it
    ['NORTHWIND GAMING', 'SOUTHERN STORM'], // long names — cut to fit the gap
  ];
  for (const cssW of [400, 600, 800, 1200]) {
    for (const [ct, t] of namePairs) {
      // LENGTH-AWARE measureText (8 px/char): the harness's flat 40 px
      // can never exceed any budget, so the ellipsis path would never run.
      const canvas = recordingCanvas(cssW, 600, (s) => s.length * 8);
      const data = synthStore(1300, 2);
      const engine = createEngine(data, 64);
      const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
      r.setLandmarks([normalizeEvent(kill, {})]);
      r.setHud({ score: { ct: 3, t: 2 }, teamNames: { ct, t }, round, tickRate: 64 });
      r.resize();
      engine.seekTick(100); // the kill is in the past → the feed draws
      const mark = canvas.log.length;
      r.draw();

      const feedBoxes = canvas.log
        .slice(mark)
        .filter((e) => e.op === 'roundRect' && e.args[4] === KILL_FEED_R && e.args[1] < 300);
      assert.ok(feedBoxes.length >= 1, `cssW=${cssW} [${ct}/${t}]: the feed draws`);
      const feedLeft = Math.min(...feedBoxes.map((b) => b.args[0]));
      const scoreBox = canvas.log.slice(mark).find((e) => e.op === 'roundRect' && e.args[4] === 6);
      assert.ok(scoreBox, `cssW=${cssW} [${ct}/${t}]: the score box draws`);
      const right = scoreBox.args[0] + scoreBox.args[2];
      assert.ok(
        right <= feedLeft - 8,
        `cssW=${cssW} [${ct}/${t}]: box right ${right} ≤ feed left ${feedLeft} − 8`,
      );
      // …and the left bound holds too: the box never slides under the
      // stage's top-left DOM slot (0.28 × cssW + its 8 px edge — the
      // theater-exit button's corner now; the share still mirrors
      // .rp-ctrl-list's max-width) while the gap still fits it.
      assert.ok(
        scoreBox.args[0] >= cssW * 0.28 + 8 - 1e-9,
        `cssW=${cssW} [${ct}/${t}]: box left ${scoreBox.args[0]} ≥ control-group budget ${cssW * 0.28 + 8}`,
      );
      r.destroy();
    }
  }
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

test('kill feed: C4 death — C4 weapon icon + victim only, T-orange outline, no attacker-side flags', () => {
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
    // The C4 weapon image IS this row's context icon now (owner fix,
    // 2026-11-12) — the canonical 'C4' key, never 'planted_c4'.
    C4: { width: 32, height: 32, src: 'c4.svg' },
    // The hud blast pip stays REGISTERED on purpose: the srcs pin below
    // proves the row no longer draws it even when it is available.
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

  // [c4(16)][victim(40)] + 1 gap + 2 inset = 80 → x = 712; the glyph
  // starts at the inset (718), the victim one gap past it (746). The
  // C4 cell occupies the same 16 px square the blast pip did (both
  // fixture icons are 32×32), so the box/glyph/victim x come out
  // unchanged — only the SOURCE swapped (recomputed from the painter's
  // recorded ops, not assumed).
  const box = opsSince(canvas.log, 'roundRect', mark).find(
    (e) => e.args[3] === KILL_FEED_LH && e.args[4] === KILL_FEED_R,
  );
  assert.deepEqual([box.args[0], box.args[1], box.args[2]], [712, 8, 80]);
  const c4 = bodyBySrc(canvas.log, mark, 'c4.svg');
  assert.ok(c4, 'the C4 weapon glyph is drawn at the killer cell’s x');
  assert.equal(c4.args[1], 719, '…at the box inset (712 + 6 + 1)');
  const victim = opsSince(canvas.log, 'fillText', mark).find((e) => e.args[0] === 'alice' && e.args[2] === 12);
  assert.equal(victim.args[1], 746, 'the victim is right-aligned as always');
  assert.equal(victim.fillStyle, '#5aa9e6', 'the victim name keeps the VICTIM’s side tint (CT)');

  // Not ONE other glyph paints: no blast pip, no attacker-side flag.
  const srcs = opsSince(canvas.log, 'drawImage', mark)
    .filter((e) => e.args[0] && e.args[0].src)
    .map((e) => e.args[0].src);
  assert.deepEqual(srcs, ['c4.svg'], 'the row is the C4 icon + victim, nothing else');

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

// --- Retired readout + in-game chat (the bottom-left corner) ----------------
//
// The bottom-left corner belongs to the in-game chat (drawChat) ALONE:
// the playback readout (follow/loop/packNote — and before it the speed×
// line) moved to the DOM control group (Replay.svelte .rp-ctrl-list), so
// these pin that the canvas never paints it back AND the chat's
// round/tick scoping, colors, stack order, truncation and corner
// geometry.

test('no playback readout on canvas: follow/loop/packNote never draw (the DOM control group owns them)', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const round = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  // NO setPack: reproject takes the no-pack path, which used to arm the
  // readout's packNote line — and with it a left-aligned box on the
  // corner. Nothing of it may survive.
  r.setHud({ score: { ct: 0, t: 0 }, teamNames: { ct: '', t: '' }, round, tickRate: 64 });
  r.resize();

  // ONE hudBox — the top-center score/clock box — and no left-aligned
  // (x = HUD_PAD) box at all: the readout's box died with its lines.
  const boxes = hudBoxesSince(canvas.log);
  assert.equal(boxes.length, 1, 'only the top-center box — there is no readout to draw empty');
  assert.equal(boxes[0].args[1], HUD_PAD, '…and that one box is the top one');
  assert.ok(
    !boxes.some((b) => b.args[0] === HUD_PAD),
    'no left-aligned box ever (the bottom-left corner is chat-only)',
  );
  const texts = textsSince(canvas.log);
  assert.ok(!texts.some((t) => String(t) === '1×'), 'no speed line');
  assert.ok(
    !texts.some((t) => String(t).startsWith('No radar image')),
    'no packNote line either (the DOM control-group row owns it)',
  );

  // FOLLOW armed — the old readout's first line: no text, no box.
  engine.setFollow(0);
  let mark = canvas.log.length;
  r.draw();
  let since = canvas.log.slice(mark);
  assert.ok(
    !since.some((e) => e.op === 'fillText' && String(e.args[0]).startsWith('follow:')),
    "the follow line is DOM now — the canvas never draws 'follow:'",
  );
  assert.ok(
    !hudBoxesSince(canvas.log, mark).some((b) => b.args[0] === HUD_PAD),
    'follow draws no box on the corner (the DOM row shows it)',
  );

  // LOOP armed — the old second line, in match time (frame 640 at 64
  // tick = 0:10): same silence. The bounds are FRAMES internally
  // (engine.state.loopFrom/loopTo); the DOM row speaks OVERALL MATCH
  // TIME through fmt.js, exactly what the toolbar's inputs show.
  engine.setLoop(0, 640);
  engine.toggleLoop();
  mark = canvas.log.length;
  r.draw();
  const tt = textsSince(canvas.log, mark);
  assert.ok(
    !tt.some((t) => String(t).startsWith('loop:')),
    "the loop range is DOM now — the canvas never draws 'loop:'",
  );
  assert.equal(
    hudBoxesSince(canvas.log, mark).filter((b) => b.args[0] === HUD_PAD).length,
    0,
    'still no left-aligned box with both control states armed',
  );
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

test('chat: the channel tag renders beside the name in the SAME side color', () => {
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
    // alice = CT slot 0: all chat always reads [ALL]…
    { id: 1, tick: 50, round: 1, steamId: '1', name: 'alice', text: 'gg', channel: 'all' },
    // …team chat tags the SPEAKER'S SIDE (alice is CT → [CT])…
    { id: 2, tick: 60, round: 1, steamId: '1', name: 'alice', text: 'b site', channel: 'team' },
    // …and a team message whose side can't be resolved gets NO bracket
    // (mystery has no slot — never a guessed side), neutral like its name.
    { id: 3, tick: 70, round: 1, steamId: '999', name: 'mystery', text: 'hi', channel: 'team' },
  ]);
  r.resize();
  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  const boxes = entryBoxOps(canvas.log, mark);
  assert.equal(boxes.length, 3, 'one entry box per message');
  const headAt = (n, y) =>
    canvas.log.find((e) => e.op === 'fillText' && e.args[0] === n && e.args[1] === 14 && e.args[2] === y + 4);
  assert.ok(headAt('alice [ALL]', boxes[0].y), 'all chat renders name + [ALL]');
  assert.equal(headAt('alice [ALL]', boxes[0].y).fillStyle, '#5aa9e6', 'the [ALL] line keeps the CT color');
  assert.ok(headAt('alice [CT]', boxes[1].y), 'team chat renders name + the speaker SIDE tag');
  assert.equal(headAt('alice [CT]', boxes[1].y).fillStyle, '#5aa9e6', 'a CT speaker’s [CT] reads in CT');
  assert.ok(headAt('mystery', boxes[2].y), 'unresolved side → name only, NO bracket');
  assert.equal(headAt('mystery', boxes[2].y).fillStyle, '#9aa4b5', 'an unresolvable speaker stays neutral');
  assert.equal(boxes[2].stroke, '#9aa4b5', '…and so does its border');

  // the message still follows the measured HEAD (name + tag)
  const body = canvas.log.find(
    (e) => e.op === 'fillText' && e.args[0] === ': gg' && e.args[2] === boxes[0].y + 4,
  );
  assert.ok(body, 'the `: message` part draws after the name+tag');
  assert.equal(body.args[1], 14 + 40, 'immediately after the measured head width');
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

test('chat: the channel tag counts toward the 40% measure and the cut', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  // A LENGTH-AWARE measureText (8 px per character), like the cut test.
  const canvas = recordingCanvas(800, 600, (s) => s.length * 8);
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  r.setHud({
    score: null,
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.setChat([
    // head = 'alice [ALL]' → 11 chars → 88 px: the budget for the body is
    // 320 − 12 − 88 = 220 px → ': ' + 24 chars + '…' = 27 chars × 8 = 216
    // fits, one char more (224) does not.
    { id: 1, tick: 50, round: 1, steamId: '1', name: 'alice', text: 'this chat line is far too long to fit', channel: 'all' },
    { id: 2, tick: 60, round: 1, steamId: '2', name: 'bob', text: 'hi', channel: 'all' },
  ]);
  r.resize();
  engine.seekTick(100);
  const mark = canvas.log.length;
  r.draw();

  const boxes = entryBoxOps(canvas.log, mark);
  assert.equal(boxes[0].w, 12 + 'alice [ALL]'.length * 8 + 27 * 8, 'the tag width counts against CHAT_MAX_W');
  assert.ok(boxes[0].w <= 800 * 0.4, 'never wider than CHAT_MAX_W');
  const cut = canvas.log.find((e) => e.op === 'fillText' && String(e.args[0]).endsWith('…'));
  assert.ok(cut, 'the message is cut with an ellipsis');
  assert.equal(cut.args[0], ': this chat line is far to…', 'the cut leaves room for the name + tag head');
  // the short tagged line is untouched: 12 + 9×8 ('bob [ALL]') + 4×8 (': hi')
  assert.equal(boxes[1].w, 12 + 'bob [ALL]'.length * 8 + ': hi'.length * 8, 'short entry = inset + head + body');
  assert.ok(canvas.log.some((e) => e.op === 'fillText' && e.args[0] === 'bob [ALL]'), 'the short line renders name + tag');
  r.destroy();
});

test('the chat owns the bottom-left corner alone — no readout box stacks above it', () => {
  // RATIONALE (the subject changed with the readout's retirement): this
  // used to pin the readout's `chat.top − HUD_PAD − boxHeight` stacking
  // branch. The readout is a DOM control-group row now, so that branch
  // is dead code and was removed — what stays true is that NOTHING
  // canvas-drawn sits above the chat: the chat's own bottom-anchored
  // stack geometry (the corner, the 22 px pitch) is all the corner
  // carries, at every stack height and with no chat at all.
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const round = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  r.setHud({ score: null, teamNames: { ct: '', t: '' }, round, tickRate: 64 });
  const chatRow = (tick, text) => ({ id: tick, tick, round: 1, steamId: '1', name: 'alice', text });
  const cornerBox = (mark) => hudBoxesSince(canvas.log, mark).filter((b) => b.args[0] === HUD_PAD);

  // ONE chat line: at the corner (600 − 8 − 18 = 574) — and no box
  // above it where the readout used to stack.
  r.setChat([chatRow(50, 'one')]);
  r.resize();
  engine.seekTick(100); // the playhead must have passed the message
  let mark = canvas.log.length;
  r.draw();
  let chat = chatBoxesSince(canvas.log, mark);
  assert.equal(chat.length, 1, 'the chat draws');
  assert.equal(chat[0].args[1], 574, 'the message sits at the bottom-left corner');
  assert.equal(cornerBox(mark).length, 0, 'no readout box above it — the stacking branch is gone');

  // TWO chat lines → the stack grows up; the corner still holds no box.
  r.setChat([chatRow(50, 'one'), chatRow(60, 'two')]);
  mark = canvas.log.length;
  r.draw();
  chat = chatBoxesSince(canvas.log, mark);
  assert.equal(chat[0].args[1], 552, 'the second message pushes the stack up');
  assert.equal(cornerBox(mark).length, 0, 'the readout does not follow it up — it does not exist');

  // NO chat → the stack clears and the corner is simply empty.
  r.setChat([]);
  mark = canvas.log.length;
  r.draw();
  assert.equal(chatBoxesSince(canvas.log, mark).length, 0, 'the stack clears');
  assert.equal(cornerBox(mark).length, 0, 'no box returns to the empty corner');
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

// C5: the layer label never lands in the TOP BAND (the score box / kill
// feed region): its natural spot is just above the panel's top edge, but
// when that edge rides up under LAYER_LABEL_MIN_Y the label drops to the
// panel's VERTICAL CENTRE — still over its own floor — and the final
// floor keeps the invariant for a panel riding entirely above it.
test('layer label: never draws at y < 40 — it drops to the panel centre when its top edge enters the band', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas(); // 800×600
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const upper = { width: 1024, height: 1024, src: 'radar.png' };
  const lower = { width: 1024, height: 1024, src: 'radar_lower.png' };
  r.setPack(layerMeta(), upper, null, [upper, lower]);
  r.resize();

  const radarBox = (from = 0) =>
    opsSince(canvas.log, 'drawImage', from).find((e) => e.args[0] && e.args[0].src === 'radar.png');
  const label = (name, from = 0) =>
    opsSince(canvas.log, 'fillText', from).find((e) => e.args[0] === name);

  // NORMAL placement (unchanged): the panel's top edge is well clear of
  // the band, so the label sits just above it.
  const top0 = radarBox().args[2];
  assert.ok(top0 - 6 >= 40, `fixture must start below the band (panel top ${top0})`);
  assert.equal(label('Upper').args[2], top0 - 6, 'above the panel top edge by default');

  // Pan the camera up until the panel's top edge rides INTO the band —
  // the label must drop to the panel's vertical centre instead.
  const mark = canvas.log.length;
  r.panBy(0, 20 - top0); // panelTop_new = panelTop_old + dy → 20
  r.draw();
  const img = radarBox(mark);
  const movedTop = img.args[2];
  assert.ok(movedTop - 6 < 40, `the top edge is in the band now (${movedTop})`);
  for (const name of ['Upper', 'Lower']) {
    const l = label(name, mark);
    assert.ok(l, `${name} still labels its panel`);
    assert.ok(l.args[2] >= 40, `${name} never draws at y < 40 (got ${l.args[2]})`);
    assert.equal(
      l.args[2],
      movedTop + img.args[4] / 2,
      `${name} dropped to the panel's vertical centre`,
    );
  }
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
  // 'low' (plain bilinear), which aliases the extractor's oversized
  // radar PNG when the webview downscales it at fit zoom. The recording
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
  // NOTE (deliberate, subject unchanged): a bounce-free flight's vertex
  // list is exactly [throw, det], so this pin still exercises ONE hop —
  // the per-hop flightSplits pass introduced with the multi-segment
  // path. The bouncy case is pinned in the next section.
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

// --- grenade flight vertices: throw → bounces → detonation ------------------
//
// The renderer builds ONE vertex list per flight — [throw, bounce₁…bounceₙ,
// det] — joined by the projectile entity extract stamps into detail_json
// (grenade_throw / grenade / grenade_bounce rows share one id), falling
// back to the existing round+weapon pairing when an id is missing on
// either side. drawGrenades then walks the list HOP by HOP: each hop is
// its own constant-speed interpolation (arrival EXACTLY at the recorded
// bounce tick, so the bounce sound and the icon land together) and its
// own flightSplits pass (floor crossings resolve per hop).

const bounceRow = (over) => ({
  kind: 'grenade_bounce',
  bucket: 'bounce',
  weapon: 'HE Grenade',
  round: 1,
  tick: 100,
  x: 10,
  y: 10,
  z: 0,
  ...over,
});

test('joinBounceVerts: the projectile entity is the join key — a mismatched bounce never joins', () => {
  const from = { kind: 'grenade_throw', bucket: 'throw', weapon: 'HE Grenade', round: 1, tick: 0, entity: 512 };
  const to = { kind: 'grenade', bucket: 'he', weapon: 'HE Grenade', round: 1, tick: 200, entity: 512 };
  const verts = joinBounceVerts(from, to, [
    bounceRow({ tick: 60, entity: 512 }),
    bounceRow({ tick: 120, entity: 513 }), // a DIFFERENT projectile → never joins
    bounceRow({ tick: 150, entity: 512 }),
    bounceRow({ tick: 999, entity: 512 }), // outside the flight window → no
    bounceRow({ tick: 170, round: 2, entity: 512 }), // another round → no
    null, // hostile input never throws
  ]);
  assert.deepEqual(verts.map((v) => v.tick), [0, 60, 150, 200]);
  // The list is the throw → bounces → det SHAPE (the det is the endpoint).
  assert.equal(verts[0], from);
  assert.equal(verts[verts.length - 1], to);
});

test('joinBounceVerts: fallback with no ids — same round + weapon inside the window (the old pairing)', () => {
  const from = { kind: 'grenade_throw', bucket: 'throw', weapon: 'Molotov', round: 3, tick: 100 };
  const to = { kind: 'grenade', bucket: 'fire', weapon: 'Incendiary Grenade', round: 3, tick: 300 };
  const verts = joinBounceVerts(from, to, [
    bounceRow({ round: 3, tick: 140, weapon: 'Molotov' }), // same round + weapon → joins
    bounceRow({ round: 3, tick: 160, weapon: 'Incendiary Grenade' }), // Molotov ≡ Incendiary → joins
    bounceRow({ round: 3, tick: 180, weapon: 'Flashbang' }), // wrong weapon → no
    bounceRow({ round: 4, tick: 200, weapon: 'Molotov' }), // wrong round → no
    bounceRow({ round: 3, tick: 400, weapon: 'Molotov' }), // past the detonation → no
  ]);
  // Ticks come back in ORDER — the draw side walks them hop by hop.
  assert.deepEqual(verts.map((v) => v.tick), [100, 140, 160, 300]);
});

test('joinBounceVerts: an unpaired throw keeps no det vertex; hostile input never throws', () => {
  const from = { kind: 'grenade_throw', bucket: 'throw', weapon: 'HE Grenade', round: 1, tick: 10 };
  assert.deepEqual(joinBounceVerts(from, null, []).map((v) => v.tick), [10]);
  assert.deepEqual(
    joinBounceVerts(from, null, [bounceRow({ tick: 20, entity: 1 })]).map((v) => v.tick),
    [10, 20],
  );
  assert.deepEqual(joinBounceVerts(null, null, []), []);
  assert.deepEqual(joinBounceVerts({ tick: NaN }, null, []), []);
  assert.deepEqual(joinBounceVerts(from, null, [null]).map((v) => v.tick), [10]);
});

test('flightPointAt: per-segment constant speed, then hold at rest past the last bounce', () => {
  const verts = [
    { tick: 0, x: 0, y: 0, z: 0 },
    { tick: 100, x: 100, y: 0, z: 0 },
    { tick: 150, x: 100, y: 50, z: 10 },
    // The detonation sits ON the last bounce's position (the game's
    // final bounce == detonation position) — the final hop is ≈0 long.
    { tick: 400, x: 100, y: 50, z: 10 },
  ];
  // Hop 1 at ITS OWN constant speed: half the hop in half the ticks …
  assert.deepEqual(flightPointAt(verts, 50), { x: 50, y: 0, z: 0 });
  // … and EXACTLY on the bounce when its tick is reached (the bounce
  // sound and the icon land together — the ratified sync).
  assert.deepEqual(flightPointAt(verts, 100), { x: 100, y: 0, z: 0 });
  // Hop 2 runs at its own (different) speed: 25 of its 50 ticks → half.
  assert.deepEqual(flightPointAt(verts, 125), { x: 100, y: 25, z: 5 });
  // Past the last bounce: the icon HOLDS at rest until the detonation.
  assert.deepEqual(flightPointAt(verts, 200), { x: 100, y: 50, z: 10 });
  assert.deepEqual(flightPointAt(verts, 399), { x: 100, y: 50, z: 10 });
  assert.deepEqual(flightPointAt(verts, 400), { x: 100, y: 50, z: 10 });
  // Before the throw it clamps to the throw vertex (the draw side gates
  // this anyway) — never a projection past the ends.
  assert.deepEqual(flightPointAt(verts, -10), { x: 0, y: 0, z: 0 });
  // Hostile input → null: the caller falls back to the origin dot.
  assert.equal(flightPointAt(null, 10), null);
  assert.equal(flightPointAt([], 10), null);
  assert.equal(flightPointAt(verts, NaN), null);
  assert.equal(flightPointAt([{ tick: 0 }], 5), null); // no position → no point
  // A zero-tick hop (two bounces stamped on one tick) snaps to its END
  // vertex — a division by zero never happens.
  assert.deepEqual(
    flightPointAt(
      [
        { tick: 0, x: 0, y: 0, z: 0 },
        { tick: 10, x: 10, y: 0, z: 0 },
        { tick: 10, x: 20, y: 0, z: 0 },
        { tick: 20, x: 30, y: 0, z: 0 },
      ],
      10,
    ),
    { x: 20, y: 0, z: 0 },
  );
});

test('multi-segment nade flight: the icon lands on each bounce, then holds at rest until the det', () => {
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
  // throw (10,10) → bounce₁ (60,10) → bounce₂ (60,60) → det ON bounce₂'s
  // position (the game's final bounce == detonation). The `entity` field
  // is what the Replay hydrates from detail_json onto each row.
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 64, round: 1, kind: 'grenade_throw', attacker: '1', weapon: 'Smoke Grenade', posX: 10, posY: 10, posZ: 0, entity: 7 }),
    mk({ id: 2, seq: 2, tick: 160, round: 1, kind: 'grenade_bounce', weapon: 'Smoke Grenade', posX: 60, posY: 10, posZ: 0, entity: 7 }),
    mk({ id: 3, seq: 3, tick: 256, round: 1, kind: 'grenade_bounce', weapon: 'Smoke Grenade', posX: 60, posY: 60, posZ: 0, entity: 7 }),
    mk({ id: 4, seq: 4, tick: 320, round: 1, kind: 'grenade', attacker: '1', weapon: 'Smoke Grenade', posX: 60, posY: 60, posZ: 0, entity: 7 }),
  ]);
  r.resize();
  // The nade icon is the only drawImage carrying NADE_ICON_PX (16) —
  // its centre is the recorded top-left plus half the painted size.
  const iconAt = (from) => {
    const e = canvas.log.slice(from).find((x) => x.op === 'drawImage' && x.args[4] === 16);
    if (!e) return null;
    return { x: e.args[1] + e.args[3] / 2, y: e.args[2] + e.args[4] / 2 };
  };
  const seekDraw = (tick) => {
    engine.seekTick(tick);
    const mark = canvas.log.length;
    r.draw();
    return mark;
  };
  const expectIcon = (tick, wx, wy, wz, why) => {
    const mark = seekDraw(tick);
    const got = iconAt(mark);
    const want = r.worldToScreen(wx, wy, wz);
    assert.ok(got, `${why}: no icon at tick ${tick}`);
    assert.ok(Math.abs(got.x - want.x) < 1e-6, `${why}: x ${got.x} vs ${want.x}`);
    assert.ok(Math.abs(got.y - want.y) < 1e-6, `${why}: y ${got.y} vs ${want.y}`);
  };

  // Mid-hop 1: half the hop in half the ticks (per-segment speed — the
  // old ONE-segment lerp would still be here, but hop 2 is what pins it).
  expectIcon(112, 35, 10, 0, 'hop 1 midpoint');
  // EXACTLY on bounce₁ — arrival is tick-exact (the bounce cue fires on
  // the same tick, so sound and icon cannot drift).
  expectIcon(160, 60, 10, 0, 'bounce 1 arrival');
  // Mid-hop 2 at ITS own speed (different distance over different ticks).
  expectIcon(208, 60, 35, 0, 'hop 2 midpoint');
  expectIcon(256, 60, 60, 0, 'bounce 2 arrival');
  // After the last bounce: HOLD at rest (the det sits on the same spot)
  // until the detonation pops at its own tick.
  expectIcon(300, 60, 60, 0, 'hold at rest before the det');
  expectIcon(320, 60, 60, 0, 'the det tick itself');

  // The PATH: THREE hops (throw→b₁, b₁→b₂, b₂→det) × one same-floor
  // span each = SIX dashed moveTo/lineTo ops whose ends are the VERTEX
  // positions (the line is the whole path, exactly as the old single
  // segment was). The LAST hop is ≈0 long — the det sits on the final
  // bounce's position, which is the line-geometry half of the
  // hold-at-rest rule.
  const mark = seekDraw(200);
  const dashed = canvas.log
    .slice(mark)
    .filter(
      (e) =>
        (e.op === 'moveTo' || e.op === 'lineTo') &&
        e.lineDash[0] === 4 &&
        e.lineDash[1] === 4 &&
        e.lineWidth === 1.5,
    );
  assert.equal(dashed.length, 6, `three hops × one span each, got ${dashed.length}`);
  const v = [
    r.worldToScreen(10, 10, 0),
    r.worldToScreen(60, 10, 0),
    r.worldToScreen(60, 60, 0),
  ];
  assert.ok(Math.abs(dashed[0].args[0] - v[0].x) < 1e-6 && Math.abs(dashed[0].args[1] - v[0].y) < 1e-6, 'hop 1 starts at the throw');
  assert.ok(Math.abs(dashed[1].args[0] - v[1].x) < 1e-6 && Math.abs(dashed[1].args[1] - v[1].y) < 1e-6, 'hop 1 ends at bounce 1');
  assert.ok(Math.abs(dashed[2].args[0] - v[1].x) < 1e-6 && Math.abs(dashed[2].args[1] - v[1].y) < 1e-6, 'hop 2 starts at bounce 1');
  assert.ok(Math.abs(dashed[3].args[0] - v[2].x) < 1e-6 && Math.abs(dashed[3].args[1] - v[2].y) < 1e-6, 'hop 2 ends at bounce 2');
  // The final hop starts AND ends on the same screen point (≈0 length).
  assert.ok(Math.abs(dashed[4].args[0] - v[2].x) < 1e-6 && Math.abs(dashed[4].args[1] - v[2].y) < 1e-6, 'hop 3 starts at bounce 2');
  assert.ok(Math.abs(dashed[5].args[0] - dashed[4].args[0]) < 1e-6 && Math.abs(dashed[5].args[1] - dashed[4].args[1]) < 1e-6, 'hop 3 is the ≈0-length det hop');

  // The flight window still closes at the detonation (unchanged).
  const after = seekDraw(321);
  assert.equal(iconAt(after), null, 'no icon past the detonation');
  r.destroy();
});

// Per-SEGMENT flightSplits: each hop resolves ITS OWN floor crossing,
// so a flat hop stays one span while the hop that climbs floors splits —
// one panel-to-panel line would lie about where the nade is on the
// floor it left (Nuke's bottom ramp → top ramp, the case flightSplits
// was built for; this pin proves the split is per hop, not per flight).
test('multi-segment nade flight: flightSplits runs PER HOP (flat hop = 1 span, crossing hop = 2)', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const upper = { width: 1024, height: 1024, src: 'radar.png' };
  const lower = { width: 1024, height: 1024, src: 'radar_lower.png' };
  r.setPack(layerMeta(), upper, null, [upper, lower]);
  const mk = (ev) => normalizeEvent(ev, {});
  r.setIcons({ 'Smoke Grenade': { width: 32, height: 32, src: 'smoke.svg' } });
  // Hop 1 stays on the LOWER floor (z −600 → −600), hop 2 climbs across
  // the −495 band edge (−600 → +50), hop 3 is the ≈0 det hop on the
  // upper floor.
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 50, round: 1, kind: 'grenade_throw', attacker: '1', weapon: 'Smoke Grenade', posX: 70, posY: 70, posZ: -600, entity: 512 }),
    mk({ id: 2, seq: 2, tick: 100, round: 1, kind: 'grenade_bounce', weapon: 'Smoke Grenade', posX: 75, posY: 70, posZ: -600, entity: 512 }),
    mk({ id: 3, seq: 3, tick: 200, round: 1, kind: 'grenade_bounce', weapon: 'Smoke Grenade', posX: 90, posY: 90, posZ: 50, entity: 512 }),
    mk({ id: 4, seq: 4, tick: 250, round: 1, kind: 'grenade', attacker: '1', weapon: 'Smoke Grenade', posX: 90, posY: 90, posZ: 50, entity: 512 }),
  ]);
  r.resize();
  engine.seekTick(150); // inside hop 2 (100 → 200)
  const mark = canvas.log.length;
  r.draw();
  const dashed = canvas.log
    .slice(mark)
    .filter(
      (e) =>
        (e.op === 'moveTo' || e.op === 'lineTo') &&
        e.lineDash[0] === 4 &&
        e.lineDash[1] === 4 &&
        e.lineWidth === 1.5,
    );
  // 1 span (flat hop 1) + 2 spans (climbing hop 2) + 1 span (flat hop 3)
  // → four spans → eight moveTo/lineTo ops.
  assert.equal(dashed.length, 8, `1 + 2 + 1 spans, got ${dashed.length / 2}`);
  const throwLo = r.worldToScreen(70, 70, -600);
  const b1Lo = r.worldToScreen(75, 70, -600);
  const b2Up = r.worldToScreen(90, 90, 50);
  // Hop 1: ONE span on the lower panel (its both ends share z — no edge
  // inside the hop).
  assert.ok(Math.abs(dashed[0].args[0] - throwLo.x) < 1e-6 && Math.abs(dashed[0].args[1] - throwLo.y) < 1e-6, 'hop 1 starts at the throw (lower panel)');
  assert.ok(Math.abs(dashed[1].args[0] - b1Lo.x) < 1e-6 && Math.abs(dashed[1].args[1] - b1Lo.y) < 1e-6, 'hop 1 ends at bounce 1 (lower panel)');
  // Hop 2: starts at bounce 1 on the LOWER panel, crosses the band edge,
  // and continues from the SAME world XY on the UPPER panel — the two
  // copies differ by exactly one panel pitch (never a line through the
  // gutter), and it ENDS on the upper panel.
  assert.ok(Math.abs(dashed[2].args[0] - b1Lo.x) < 1e-6 && Math.abs(dashed[2].args[1] - b1Lo.y) < 1e-6, 'hop 2 starts at bounce 1 (lower panel)');
  const radarDraw = opsSince(canvas.log, 'drawImage').find(
    (e) => e.args[0] && e.args[0].src === 'radar.png',
  );
  const s = radarDraw.args[3] / 1024; // fit scale
  const pitch = (1024 + 32) * s;
  assert.ok(
    Math.abs(dashed[3].args[0] - dashed[4].args[0] - pitch) < 1e-6,
    `the crossing repeats one pitch apart (off by ${dashed[3].args[0] - dashed[4].args[0]}, pitch ${pitch})`,
  );
  assert.equal(dashed[3].args[1], dashed[4].args[1], 'shared transform → identical y at the crossing');
  assert.ok(Math.abs(dashed[5].args[0] - b2Up.x) < 1e-6 && Math.abs(dashed[5].args[1] - b2Up.y) < 1e-6, 'hop 2 ends at bounce 2 (upper panel)');
  // Hop 3 (the ≈0 det hop) draws on the upper panel, zero length.
  assert.ok(Math.abs(dashed[6].args[0] - b2Up.x) < 1e-6 && Math.abs(dashed[6].args[1] - b2Up.y) < 1e-6, 'hop 3 starts at bounce 2 (upper panel)');
  assert.equal(dashed[7].args[0], dashed[6].args[0], 'hop 3 is zero length');
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

// --- plant/defuse progress rings on the player dot ---------------------------
//
// The intervals come from bomb.js actionIntervals (begin → completion |
// abort | round end — grouped by the ACTOR's slot in setLandmarks) and
// the arc from actionProgressAt, so it is a pure function of tick: a
// scrub replays the same phase and nothing is sticky. RED while
// planting, GREEN while defusing — the color names the ACTION, never
// the player's side. Radius r+4 = 13 (inside the follow ring's r+5),
// round-capped, sweeping clockwise from 12 o'clock.

test('plant/defuse progress ring: red arc on the planter, growing, seek-safe', () => {
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
  r.resize();
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 100, round: 1, kind: 'bomb_plant_begin', attacker: '1' }),
    mk({ id: 2, seq: 2, tick: 300, round: 1, kind: 'bomb_plant', attacker: '1' }),
    mk({ id: 3, seq: 3, tick: 600, round: 1, kind: 'bomb_defuse_start', attacker: '2' }),
    mk({ id: 4, seq: 4, tick: 920, round: 1, kind: 'bomb_defuse', attacker: '2' }),
  ]);
  const at = (tick) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return canvas.log.slice(mark);
  };
  const rings = (seq, color) =>
    seq.filter((e) => e.op === 'arc' && e.strokeStyle === color && e.args[2] === 13);

  // --- outside the window: nothing at all ---------------------------------
  assert.equal(rings(at(50), '#ff4d4d').length, 0, 'no ring before the begin');
  assert.equal(rings(at(100), '#ff4d4d').length, 0, 'the begin tick draws nothing (progress 0)');
  assert.equal(rings(at(300), '#ff4d4d').length, 0, 'gone AT the completion');
  assert.equal(rings(at(1000), '#ff4d4d').length, 0, 'no ring long after');

  // --- inside: ONE red arc on the planter's dot ---------------------------
  const half = rings(at(200), '#ff4d4d');
  assert.equal(half.length, 1, 'one red ring — the planter’s, and only hers');
  assert.equal(half[0].lineCap, 'round');
  assert.equal(half[0].lineWidth, 3);
  assert.equal(half[0].args[3], -Math.PI / 2, 'the sweep starts at 12 o’clock');
  // 100 → 300: at 200 the attempt is exactly halfway → half a turn
  assert.ok(Math.abs(half[0].args[4] - Math.PI / 2) < 1e-9, 'halfway = half a turn clockwise');
  // …and the arc sits on HER dot (slot 0 draws at (10,10), slot 1 at
  // (50,50) in synthStore — the ring center must match the dot's).
  const dot = at(200).find((e) => e.op === 'arc' && e.fillStyle === '#5aa9e6' && e.args[2] === 9);
  assert.ok(dot, "the planter's dot draws");
  assert.equal(half[0].args[0], dot.args[0], 'ring centered on the planter’s dot X');
  assert.equal(half[0].args[1], dot.args[1], 'ring centered on the planter’s dot Y');

  // --- progress grows with the tick ----------------------------------------
  const quarter = rings(at(150), '#ff4d4d');
  assert.ok(Math.abs(quarter[0].args[4] - 0) < 1e-9, 'a quarter in = a quarter turn');
  const threeQ = rings(at(250), '#ff4d4d');
  assert.ok(Math.abs(threeQ[0].args[4] - Math.PI) < 1e-9, 'three quarters in = three quarters of a turn');
  assert.ok(
    quarter[0].args[4] < half[0].args[4] && half[0].args[4] < threeQ[0].args[4],
    'the arc grows monotonically',
  );

  // --- seek-safe: the same tick always draws the same arc ------------------
  assert.deepEqual(rings(at(200), '#ff4d4d')[0].args, half[0].args, 'a redraw at the same tick is identical');
  assert.deepEqual(rings(at(150), '#ff4d4d')[0].args, quarter[0].args, 'scrubbing back replays the same phase');

  // --- the defuse is GREEN, on the DEFUSER's dot ---------------------------
  const green = rings(at(760), '#4caf7d');
  assert.equal(green.length, 1, "one green ring — the defuser's");
  // 600 → 920 is a 5 s (kit) SPAN, but this fixture pushes NO kit
  // evidence → hasKitAt absent → the conservative 10 s (640-tick)
  // denominator (bomb.js actionDurationTicks). So at 760 only
  // (760−600)/640 = 0.25 of a turn has elapsed — a QUARTER turn (end
  // angle −π/2 + π/2 = 0), where the old observed-span formula read
  // this midpoint as exactly half a turn. The WITH-KIT half-turn pins
  // live in the kit-vs-no-kit test below; the fixture's 320-tick span
  // is what a kit defuse really takes, so kit evidence restores it.
  assert.ok(Math.abs(green[0].args[4] - 0) < 1e-9, 'no kit evidence → 10 s denominator → a quarter turn at 760');
  assert.notEqual(green[0].args[0], half[0].args[0], "on bob's dot, not alice's");
  assert.equal(rings(at(760), '#ff4d4d').length, 0, 'alice’s plant ring is long over');
  assert.equal(rings(at(60), '#4caf7d').length, 0, 'no green ring before the defuse starts');
  assert.equal(rings(at(920), '#4caf7d').length, 0, 'gone AT the defuse completion');
  r.destroy();
});

test('an aborted attempt’s ring stops at the abort tick (no completion)', () => {
  headlessGlobals();
  const data = synthStore(400, 1);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [{ steamId: '1', name: 'alice', side: 'ct' }],
  });
  r.resize();
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks([
    mk({ id: 1, seq: 1, tick: 100, round: 1, kind: 'bomb_plant_begin', attacker: '1' }),
    mk({ id: 2, seq: 2, tick: 150, round: 1, kind: 'bomb_plant_abort', attacker: '1' }),
  ]);
  const at = (tick) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return canvas.log
      .slice(mark)
      .filter((e) => e.op === 'arc' && e.strokeStyle === '#ff4d4d' && e.args[2] === 13);
  };
  const last = at(149);
  assert.equal(last.length, 1, 'the ring grows until the cancel');
  // …but only as far as GAME TIME says: 49 ticks of the 3.125 s
  // (200-tick) plant duration is 0.245 of a turn — end angle still
  // BELOW 12 o'clock, where the old observed-span formula read 49/50 ≈
  // 0.98 of a turn (a cancelled plant looked nearly done).
  assert.ok(last[0].args[4] < 0, 'a cancelled plant never reads as nearly-done');
  assert.equal(at(150).length, 0, 'gone AT the abort — a cancelled plant never reads as complete');
  assert.equal(at(250).length, 0, 'and it never comes back');
  r.destroy();
});

test('defuse ring denominator: kit evidence at the attempt start (5 s vs 10 s)', () => {
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
  r.resize();
  const mk = (ev) => normalizeEvent(ev, {});
  const rows = [
    mk({ id: 1, seq: 1, tick: 0, round: 1, kind: 'round_start' }),
    // bob grabs a kit at 500 — BEFORE the attempt begins at 600, so
    // hasKitAt('2', 600) answers true (the rule reads at the START tick).
    mk({ id: 2, seq: 2, tick: 500, round: 1, kind: 'weapon_pickup', attacker: '2', weapon: 'Defuse Kit' }),
    mk({ id: 3, seq: 3, tick: 600, round: 1, kind: 'bomb_defuse_start', attacker: '2' }),
    mk({ id: 4, seq: 4, tick: 920, round: 1, kind: 'bomb_defuse', attacker: '2' }),
  ];
  const at = (tick) => {
    const mark = canvas.log.length;
    engine.seekTick(tick);
    r.draw();
    return canvas.log
      .slice(mark)
      .filter((e) => e.op === 'arc' && e.strokeStyle === '#4caf7d' && e.args[2] === 13)[0];
  };

  // BEFORE setKitEvidence: no hasKitAt → conservative 10 s (640 ticks)
  // → at 760, (760−600)/640 = 0.25 → a quarter turn (end angle 0).
  r.setLandmarks(rows);
  const noKit = at(760);
  assert.ok(noKit, 'the defuse rings before any kit evidence arrives');
  assert.ok(Math.abs(noKit.args[4] - 0) < 1e-9, 'no kit evidence → 10 s denominator → a quarter turn');

  // AFTER setKitEvidence — pushed AFTER setLandmarks on purpose: the
  // two setters are independent (the duration stamps lazily at draw, see
  // setKitEvidence's ordering note). hasKitAt('2', 600) === true → the
  // 5 s (320-tick) denominator → at 760, (760−600)/320 = 0.5 → half a
  // turn (end angle π/2) — the SAME attempt, the SAME tick.
  r.setKitEvidence(buildKitEvidence(rows, new Map(), 64));
  const withKit = at(760);
  assert.ok(withKit, 'the defuse still rings with kit evidence');
  assert.ok(Math.abs(withKit.args[4] - Math.PI / 2) < 1e-9, 'kit at the attempt start → 5 s denominator → half a turn');
  assert.ok(noKit.args[4] < withKit.args[4], 'kit evidence strictly grows the sweep at the same tick');
  r.destroy();
});

// --- the drop layer (drawDrops / setDropLayers) ------------------------------
// The optional dropped-gun/util markers (weapon_drop / weapon_pickup):
// gated per category (setDropLayers — BOTH OFF by default), neutral
// white icons with NO ring/pulse/dash (the dropped-C4 look minus the
// throbber), the STORED cat (joined by the view as dropCat — never
// re-derived) deciding the gate, the joined mag/reserve ammo label, and
// pickup / round-end cleanup. Rows arrive exactly like Replay.svelte
// builds them: normalizeEvent over a DRAW_KINDS row already joined with
// getDropDetails (dropCat / dropAmmo ride the row).

// dropHarness — a store + renderer with gun/util drop rows, one
// same-name pickup and the round's end loaded. `layers` is passed to
// setDropLayers (absent = never called = the default OFF state).
function dropHarness({ layers } = {}) {
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
    mk({
      id: 1, seq: 1, tick: 100, round: 1, kind: 'weapon_drop', attacker: '2',
      weapon: 'AK-47', posX: 80, posY: 80,
      dropCat: 'gun', dropAmmo: { mag: 30, reserve: 90 },
    }),
    mk({
      id: 2, seq: 2, tick: 120, round: 1, kind: 'weapon_drop', attacker: '2',
      weapon: 'HE Grenade', posX: 20, posY: 20, dropCat: 'util',
    }),
    // Someone takes the AK at tick 300 (same name, same round).
    mk({ id: 3, seq: 3, tick: 300, round: 1, kind: 'weapon_pickup', attacker: '1', weapon: 'AK-47', posX: 80, posY: 80 }),
    mk({ id: 4, seq: 4, tick: 500, round: 1, kind: 'round_end' }),
    mk({ id: 5, seq: 5, tick: 550, round: 2, kind: 'round_start' }),
  ]);
  r.setIcons({
    // Deliberately NON-square gun art: 48×24 → 28×14 at
    // DROP_GUN_ICON_PX = 14 (aspect preserved, never squashed).
    'AK-47': { width: 48, height: 24, src: 'ak.svg' },
    'HE Grenade': { width: 32, height: 32, src: 'he.svg' },
  });
  if (layers) r.setDropLayers(layers);
  r.resize();
  return { engine, canvas, r };
}

// dropSeek seeks and redraws, returning the ops of that draw.
function dropSeek(h, tick) {
  const mark = h.canvas.log.length;
  h.engine.seekTick(tick);
  h.r.draw();
  return h.canvas.log.slice(mark);
}
const gunBody = (seq) => seq.filter((e) => e.op === 'drawImage' && e.args[3] === 28 && e.args[4] === 14);
const utilBody = (seq) => seq.filter((e) => e.op === 'drawImage' && e.args[3] === 16 && e.args[4] === 16);

test('drop layer: both categories OFF by default; ON draws neutral icons with the ammo label and NO ring', () => {
  // Default state (setDropLayers never called — the unset pref): rows
  // are loaded, but nothing draws.
  const off = dropHarness();
  let seq = dropSeek(off, 200);
  assert.equal(gunBody(seq).length, 0, 'no gun marker with the layer off');
  assert.equal(utilBody(seq).length, 0, 'no util marker with the layer off');
  assert.equal(
    seq.some((e) => e.op === 'fillText' && e.args[0] === '30/90'),
    false,
    'no ammo label either',
  );
  off.r.destroy();

  const tintMark = iconTints.length;
  const h = dropHarness({ layers: { guns: true, util: true } });
  const MARK = h.r.worldToScreen(80, 80); // the AK's marker (free camera — stable)
  seq = dropSeek(h, 200);
  assert.ok(gunBody(seq).length > 0, 'the gun marker draws with {guns} on');
  assert.ok(utilBody(seq).length > 0, 'the util marker draws with {util} on');
  assert.ok(
    seq.some((e) => e.op === 'fillText' && e.args[0] === '30/90'),
    'the gun labels its mag/reserve at death (joined detail_json)',
  );
  // Neutral, never side-tinted: every icon tint built for these markers
  // is the dark halo or PURE WHITE — no CT blue / T amber ever recolors
  // them (the dropped-C4 white convention).
  const tints = tintsSince(tintMark).map((e) => e.color);
  assert.ok(tints.includes('#ffffff'), 'the body is tinted white');
  for (const c of tints) {
    assert.ok(
      c === '#ffffff' || c === 'rgba(8, 10, 14, 0.85)',
      `neutral-only icon tints, saw ${c}`,
    );
  }
  // NO ring / pulse / dashed circle around the marker — the drop layer
  // is static (the dropped C4's throbber is deliberately absent): no
  // arc is EVER centered on the marker, and no dash pattern is set.
  assert.equal(
    seq.filter((e) => e.op === 'arc' && e.args[0] === MARK.x && e.args[1] === MARK.y).length,
    0,
    'no ring/pulse arc centered on the drop marker',
  );
  assert.equal(
    seq.filter((e) => e.op === 'setLineDash' && Array.isArray(e.args[0]) && e.args[0].length > 0).length,
    0,
    'no dashed ring anywhere in the draw',
  );
  h.r.destroy();
});

test('drop layer: guns and util gate independently; pickup and round end clean up (scrub-safe)', () => {
  // {guns} only — the util row stays hidden.
  const g = dropHarness({ layers: { guns: true } });
  let seq = dropSeek(g, 200);
  assert.ok(gunBody(seq).length > 0, 'gun marker with {guns}');
  assert.equal(utilBody(seq).length, 0, 'util marker gated OUT by {guns}');
  g.r.destroy();
  // {util} only — the mirror image.
  const u = dropHarness({ layers: { util: true } });
  seq = dropSeek(u, 200);
  assert.equal(gunBody(seq).length, 0, 'gun marker gated OUT by {util}');
  assert.ok(utilBody(seq).length > 0, 'util marker with {util}');
  u.r.destroy();

  const h = dropHarness({ layers: { guns: true, util: true } });
  // After the pickup (300): the AK is gone, the untouched util stays.
  seq = dropSeek(h, 350);
  assert.equal(gunBody(seq).length, 0, 'the picked-up gun is gone');
  assert.ok(utilBody(seq).length > 0, 'the util was not picked up — still on the ground');
  // The round ends (500): both clean up, like death markers / dropped C4.
  seq = dropSeek(h, 500);
  assert.equal(gunBody(seq).length, 0, 'gone AT the round_end tick');
  assert.equal(utilBody(seq).length, 0, 'util gone AT the round_end tick');
  seq = dropSeek(h, 560);
  assert.equal(gunBody(seq).length + utilBody(seq).length, 0, 'nothing bleeds into round 2');
  // Backward scrub re-derives — nothing sticky (the util's round is over
  // too, so only the pre-pickup window resurrects the gun).
  seq = dropSeek(h, 200);
  assert.ok(gunBody(seq).length > 0, 'a backwards scrub re-draws the pre-pickup gun');
  assert.ok(utilBody(seq).length > 0, '…and the util at its position');
  seq = dropSeek(h, 99);
  assert.equal(gunBody(seq).length, 0, 'before the death: nothing dropped yet');
  assert.equal(utilBody(seq).length, 0, '…for either item');
  h.r.destroy();
});

// --- the defuse-kit layer (drawDrops' cat "kit" + setKitEvidence) ----------
//
// The kit marker is the drop layer's THIRD category: the SAME draw call
// as a gun/util drop (white icon + the elevation indicator behind it,
// NO ring / NO pulse / NO dash — the dashed-pulse throbber stays the
// dropped C4's alone) but its OWN evidence: the view pushes
// lib/replay/kits.js buildKitEvidence through setKitEvidence, so the
// window is the NEAREST-DEATH back-propagation + buytime rule — never
// drops.js's best-evidence window, which ANY later same-name pickup
// closes (a mid-round kit BUY would erase a dropped kit).
// Rows arrive exactly like Replay.svelte builds them: normalizeEvent
// over DRAW_KINDS rows joined with getDropDetails (dropCat 'kit').

// kitHarness — a store + renderer with `rows` normalized, the kit
// evidence built from those SAME rows (the real seam: the view builds
// from drawNorm too) and the kit icon loaded. `layers` → setDropLayers,
// `buyEnds` → buildKitEvidence's buy boundary, `pack` → setPack (the
// elevation case).
function kitHarness(rows, { layers, buyEnds = new Map(), pack } = {}) {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: LAYER_PLAYERS });
  const norm = rows.map((ev, i) => normalizeEvent({ id: i + 1, seq: i + 1, ...ev }, {}));
  r.setLandmarks(norm);
  r.setKitEvidence(buildKitEvidence(norm, buyEnds, 64));
  r.setIcons({ 'Defuse Kit': { width: 32, height: 32, src: 'kit.svg' } });
  if (layers) r.setDropLayers(layers);
  if (pack) r.setPack(pack, { width: 1024, height: 1024, src: 'radar.png' });
  r.resize();
  return { engine, canvas, r };
}

// The kit body: drawImage at DROP_KIT_ICON_PX = 14 square (the 32×32
// art keeps its aspect; the halo rides 2 px larger at 16×16).
const kitBody = (seq) => seq.filter((e) => e.op === 'drawImage' && e.args[3] === 14 && e.args[4] === 14);

const kitDrop = (tick, x, y, over = {}) => ({
  kind: 'weapon_drop', tick, round: 1, attacker: '2', weapon: 'Defuse Kit',
  posX: x, posY: y, posZ: 0, dropCat: 'kit', ...over,
});
const kitPick = (tick, x, y, over = {}) => ({
  kind: 'weapon_pickup', tick, round: 1, attacker: '1', weapon: 'Defuse Kit',
  posX: x, posY: y, posZ: 0, ...over,
});
const kRs = (tick, round = 1) => ({ kind: 'round_start', tick, round });
const kRe = (tick, round = 1) => ({ kind: 'round_end', tick, round });

test('kit marker: gated by {kits} alone — white icon, NO ring/pulse/dash', () => {
  const rows = [kRs(0), kitDrop(200, 100, 100), kRe(1000)];

  // Default state (setDropLayers never called): rows loaded, nothing draws.
  const off = kitHarness(rows);
  assert.equal(kitBody(dropSeek(off, 300)).length, 0, 'no kit marker with the layer off');
  off.r.destroy();

  // guns + util ON, kits still OFF → the kit is gated out (independent).
  const others = kitHarness(rows, { layers: { guns: true, util: true } });
  assert.equal(kitBody(dropSeek(others, 300)).length, 0, 'kits gate independently of guns/util');
  others.r.destroy();

  const h = kitHarness(rows, { layers: { kits: true } });
  const MARK = h.r.worldToScreen(100, 100, 0);
  const seq = dropSeek(h, 300);
  const body = kitBody(seq);
  assert.equal(body.length, 1, 'one white kit icon with {kits} on');
  assert.ok(
    Math.abs(body[0].args[1] + body[0].args[3] / 2 - MARK.x) < 1e-6 &&
      Math.abs(body[0].args[2] + body[0].args[4] / 2 - MARK.y) < 1e-6,
    'centered on the stored drop position',
  );
  // NO ring, NO pulse, NO dash — the owner's kit rule (the dashed
  // pulse stays C4's): no arc is EVER centered on the marker and no
  // dash pattern is set anywhere in the draw.
  assert.equal(
    seq.filter((e) => e.op === 'arc' && Math.abs(e.args[0] - MARK.x) < 1e-6 && Math.abs(e.args[1] - MARK.y) < 1e-6).length,
    0,
    'no ring/pulse arc centered on the kit marker',
  );
  assert.equal(
    seq.filter((e) => e.op === 'setLineDash' && Array.isArray(e.args[0]) && e.args[0].length > 0).length,
    0,
    'no dashed ring anywhere in the draw',
  );
  // Neutral WHITE body (14×14 is this marker's own footprint in the
  // tint cache — no side color is ever built for it).
  assert.ok(
    iconTints.some((t) => t.color === '#ffffff' && t.w === 14 && t.h === 14),
    'the kit body is tinted neutral white',
  );
  h.r.destroy();
});

test('kit windows come from the nearest-death evidence (not drops.js)', () => {
  // Two CTs died with kits; one later pickup stands ON the NEARER
  // body. drops.js's best-evidence rule would hide BOTH at the pickup
  // (any later same-name pickup closes the drop) — the kit layer must
  // keep the far one on the ground to the round end.
  const near = kitDrop(200, 100, 100, { attacker: '1' });
  const far = kitDrop(250, 600, 600, { attacker: '2' });
  const pickup = kitPick(500, 100, 100); // 400 ticks after buytime (400)
  const h = kitHarness([kRs(0), near, far, pickup, kRe(1000)], {
    layers: { kits: true },
    buyEnds: new Map([[1, 400]]),
  });

  let seq = dropSeek(h, 300);
  assert.equal(kitBody(seq).length, 2, 'both kits on the ground before the pickup');

  seq = dropSeek(h, 500);
  const left = kitBody(seq);
  assert.equal(left.length, 1, 'the NEAREST drop ends at the pickup; the far one stays (drops.js would leave 0)');
  const FAR = h.r.worldToScreen(600, 600, 0);
  assert.ok(
    left.every((b) => Math.abs(b.args[1] + b.args[3] / 2 - FAR.x) < 1e-6),
    'the survivor is the FAR drop',
  );

  // Round-end cleanup, then a backward scrub re-derives (nothing sticky).
  assert.equal(kitBody(dropSeek(h, 999)).length, 1, 'the far drop holds to the round end');
  assert.equal(kitBody(dropSeek(h, 1000)).length, 0, 'gone AT the round_end tick');
  assert.equal(kitBody(dropSeek(h, 300)).length, 2, 'a backwards scrub re-derives both');
  h.r.destroy();
});

test('a kit BUY inside buytime never terminates a drop', () => {
  // Same position, same round — but the pickup lands INSIDE the round's
  // buytime (ended 600), so it is a purchase and must leave the drop.
  const rows = [kRs(0), kitDrop(200, 100, 100), kitPick(500, 100, 100), kRe(1000)];
  const h = kitHarness(rows, { layers: { kits: true }, buyEnds: new Map([[1, 600]]) });
  assert.equal(kitBody(dropSeek(h, 500)).length, 1, 'still on the ground at the buy');
  assert.equal(kitBody(dropSeek(h, 999)).length, 1, '…all the way to the round end');
  assert.equal(kitBody(dropSeek(h, 1000)).length, 0, 'gone AT round_end');
  h.r.destroy();
});

test('KIT_MATCH_MAX: a far pickup never claims a drop', () => {
  // 5000 wu away — past the 4096 hard filter, so the drop stays even
  // though the pickup is the only candidate and well after buytime.
  const rows = [kRs(0), kitDrop(200, 100, 100), kitPick(500, 5100, 100), kRe(1000)];
  const h = kitHarness(rows, { layers: { kits: true }, buyEnds: new Map([[1, 400]]) });
  assert.equal(kitBody(dropSeek(h, 500)).length, 1, 'unmatched → the drop stays to round end');
  assert.equal(kitBody(dropSeek(h, 1000)).length, 0, '…and still cleans up at round_end');
  h.r.destroy();
});

test('kit marker: the elevation indicator paints BEHIND the icon (region boxes only)', () => {
  // The region claims the KIT's XY (700,700) and NOT the two player
  // dots at (10,10)/(50,50) — so the only mark in this draw is the
  // kit's, and it must sit under the icon (the behind-the-entity rule).
  const rows = [kRs(0), kitDrop(200, 700, 700), kRe(1000)];
  const h = kitHarness(rows, {
    layers: { kits: true },
    pack: {
      radar: { file: 'radar.png', width: 1024, height: 1024 },
      transform: { pos_x: 0, pos_y: 0, scale: 1 },
      elevation_regions: [{ x: 600, y: 600, w: 200, h: 200, reference_z: -1, above: 0, below: 0 }],
    },
  });
  const seq = dropSeek(h, 300);
  const marks = elevMarks(seq);
  assert.equal(marks.length, 1, 'exactly one region-box indicator — the kit\'s');
  const MARK = h.r.worldToScreen(700, 700, 0);
  assert.ok(Math.abs(marks[0].x - MARK.x) < 1e-6, 'at the kit\'s screen position');
  const body = kitBody(seq);
  assert.equal(body.length, 1, 'the icon still draws');
  const stroke = seq.findIndex(
    (e) => e.op === 'moveTo' && e.strokeStyle === ELEV_TINT && e.lineWidth === ELEV_W,
  );
  assert.ok(stroke >= 0 && stroke < seq.indexOf(body[0]), 'the mark paints BEFORE (behind) the icon');
  h.r.destroy();
});

// --- replay performance wave: the approved tradeoffs + hot-path pins --------
//
// The wave reworked hot paths WITHOUT changing what the canvas paints,
// except the two owner-approved visual changes (trail alpha banding, the
// moving-camera smoothing quality). The pins below hold those two
// contracts plus the "same output, less work" ones: the chat cut cache,
// the one-pass HUD measure, the precomputed drop window and the
// scrub-drag draw coalescing.

// movingStore — synthStore with every slot RUNNING east at 4 units/tick
// (256 u/s at 64 Hz — comfortably over TRAIL_MIN_SPEED), so the movement
// trail actually draws (synthStore's standing slots never connect: a
// zero step fails the speed gate).
function movingStore(frames, slotCount) {
  const store = synthStore(frames, slotCount);
  for (const s of store.slots) {
    for (let f = 0; f < frames; f++) s.pos[f * 4] = 10 + f * 4;
  }
  return store;
}

test('trails: alpha-band batching — one stroke per band, same segments, same fade direction', () => {
  headlessGlobals();
  const data = movingStore(400, 2);
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
  r.resize();
  r.setCameraMode('free');
  engine.seekTick(300); // the whole 192-frame trail window sits behind us
  const mark = canvas.log.length;
  r.draw();
  const seq = canvas.log.slice(mark);
  const isSide = (e) => e.strokeStyle === '#5aa9e6' || e.strokeStyle === '#e6a35a';
  const trailLine = (e) => e.lineWidth === 2 && isSide(e) && e.alpha <= 0.5;
  // The band alphas the helper produces — every recorded trail alpha is
  // one of them (and never above 0.5, which the kill-feed filters lean
  // on: "trails/arrow draw at alpha ≤ 0.5").
  const bandAlphas = new Set(
    Array.from({ length: TRAIL_BANDS }, (_, b) => trailBandAlpha(b)),
  );
  for (const [color, why] of [['#5aa9e6', 'CT'], ['#e6a35a', 'T']]) {
    const segs = seq.filter((e) => e.op === 'lineTo' && trailLine(e) && e.strokeStyle === color);
    const strokes = seq.filter((e) => e.op === 'stroke' && trailLine(e) && e.strokeStyle === color);
    // EQUIVALENCE: batching merges STROKES, never segments — the window
    // still contributes one lineTo per connected frame pair (192 of
    // them), and each segment's subpath start (the moveTo before it) is
    // intact, so segLen/segStart keep working.
    assert.equal(segs.length, 192, `${why}: every window segment still draws`);
    assert.equal(
      strokes.length,
      TRAIL_BANDS,
      `${why}: one stroke per alpha band instead of one per segment (was 192)`,
    );
    const alphas = strokes.map((e) => e.alpha);
    for (const a of alphas) {
      assert.ok(a <= 0.5, `${why}: a band alpha never exceeds 0.5 (${a})`);
      assert.ok(bandAlphas.has(a), `${why}: ${a} is a band center, not a raw age fade`);
    }
    // The walk is NEWEST → OLDEST, so the fade direction is unchanged:
    // the recorded alphas never increase along it, and the newest end is
    // clearly brighter than the oldest.
    for (let i = 1; i < alphas.length; i++) {
      assert.ok(alphas[i] <= alphas[i - 1], `${why}: the fade never brightens with age`);
    }
    assert.ok(
      alphas[0] > alphas[alphas.length - 1],
      `${why}: the newest segment is the brightest (oldest → newest fade kept)`,
    );
    // batchIndex sanity: the helper's band for an age maps to the alphas
    // actually recorded (band7 = newest, band0 = oldest).
    assert.equal(trailBandIndex(0), TRAIL_BANDS - 1, 'age 0 is the newest band');
    assert.equal(trailBandIndex(1), 0, 'age 1 is the oldest band');
  }
  r.destroy();
});

test('radar smoothing: HIGH while the camera is settled, MEDIUM while it moves', () => {
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
  const ctx = canvas.getContext();
  r.resize();
  // The FIRST radar draw records the camera without reacting — it paints
  // at 'high' exactly as the pre-wave build did (one-frame-stale init).
  assert.equal(ctx.imageSmoothingQuality, 'high', 'the first draw keeps today’s quality');
  r.draw();
  assert.equal(ctx.imageSmoothingQuality, 'high', 'a settled frame stays high');
  r.panBy(40, 0);
  r.draw();
  assert.equal(ctx.imageSmoothingQuality, 'medium', 'a pan resamples the radar at medium');
  r.draw();
  assert.equal(ctx.imageSmoothingQuality, 'high', 'the camera settles → high again');
  r.zoomAt(1.6, 400, 300);
  r.draw();
  assert.equal(ctx.imageSmoothingQuality, 'medium', 'a zoom is camera motion too');
  r.draw();
  assert.equal(ctx.imageSmoothingQuality, 'high', 'paused and settled: high, never medium');
  r.destroy();
});

test('chat: the cut is cached per row + width — the measure loop runs once', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  // Count ONLY the truncation loop's measurements (its argument always
  // starts with ': this chat line'); the flat 40 px measure keeps every
  // box-geometry assertion exact.
  let cutMeasures = 0;
  const canvas = recordingCanvas(800, 600, (s) => {
    if (String(s).startsWith(': this chat line')) cutMeasures++;
    return String(s).length * 8;
  });
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  r.setHud({
    score: null,
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize(); // no chat rows yet — nothing to cut
  engine.seekTick(100);
  cutMeasures = 0;
  r.setChat([
    { id: 1, tick: 50, round: 1, steamId: '1', name: 'alice', text: 'this chat line is far too long to fit' },
    { id: 2, tick: 60, round: 1, steamId: '2', name: 'bob', text: 'hi' },
  ]); // the setter's own draw: a cache MISS — the loop walks the cut
  const firstPass = cutMeasures;
  assert.ok(firstPass >= 3, `the first draw walks the cut loop (${firstPass} measures)`);
  const firstCut = canvas.log.find((e) => e.op === 'fillText' && String(e.args[0]).endsWith('…'));
  assert.ok(firstCut, 'the long line is cut on the first draw');
  const mark = canvas.log.length;
  cutMeasures = 0;
  r.draw(); // same rows, same width, same head → cache HIT
  const secondCut = canvas.log.slice(mark).find((e) => e.op === 'fillText' && String(e.args[0]).endsWith('…'));
  assert.equal(cutMeasures, 0, 'the cached draw measures nothing to cut');
  assert.equal(secondCut.args[0], firstCut.args[0], 'the cached cut is byte-identical');
  assert.equal(secondCut.args[1], firstCut.args[1], '…at the same x');
  r.destroy();
});

test('chat: a row with NO id cuts correctly every draw (it never joins the cache)', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  let cutMeasures = 0;
  const canvas = recordingCanvas(800, 600, (s) => {
    if (String(s).startsWith(': this chat line')) cutMeasures++;
    return String(s).length * 8;
  });
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  r.setHud({
    score: null,
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();
  engine.seekTick(100);
  const rows = [{ tick: 50, round: 1, steamId: '1', name: 'alice', text: 'this chat line is far too long to fit' }];
  cutMeasures = 0;
  r.setChat(rows);
  const first = cutMeasures;
  assert.ok(first >= 3, `the id-less row still cuts (${first} measures)`);
  const firstCut = canvas.log.find((e) => e.op === 'fillText' && String(e.args[0]).endsWith('…'));
  cutMeasures = 0;
  const mark = canvas.log.length;
  r.draw();
  assert.ok(cutMeasures >= first, 'an id-less row re-cuts every draw — no shared key');
  const again = canvas.log.slice(mark).find((e) => e.op === 'fillText' && String(e.args[0]).endsWith('…'));
  assert.ok(again, 'the second draw cuts too');
  assert.equal(again.args[0], firstCut.args[0], '…and still cuts to the same text');
  r.destroy();
});

test('HUD: the score line is measured ONCE per draw (box width + centering share one pass)', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  let nameMeasures = 0;
  const canvas = recordingCanvas(800, 600, (s) => {
    if (s === 'Alpha' || s === 'Beta') nameMeasures++;
    return 40; // the harness's flat measure — box geometry stays exact
  });
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  r.setHud({
    score: { ct: 3, t: 2 },
    teamNames: { ct: 'Alpha', t: 'Beta' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  });
  r.resize();
  nameMeasures = 0;
  r.draw();
  assert.equal(
    nameMeasures,
    2,
    'each team name is measured exactly once — the box width and the centered layout share the pass (was 3 passes = 6)',
  );
  r.destroy();
});

test('drops: the precomputed window answers exactly what dropEvidenceAt answers', () => {
  // The renderer builds dropWindow rows ONCE in setLandmarks and then
  // tests them per frame; dropEvidenceAt stays THE rule. This sweep pins
  // the equivalence the renderer relies on, over every gate the rule has.
  const ev = {
    drops: [
      { kind: 'weapon_drop', round: 1, tick: 100, weapon: 'AK-47', x: 10, y: 10, z: 0 },
      { kind: 'weapon_drop', round: 1, tick: 120, weapon: 'Smoke Grenade', x: 20, y: 20 },
      { kind: 'weapon_drop', round: 1, tick: 140, weapon: 'M4A1-S' }, // no position → never visible
      { kind: 'weapon_drop', round: 2, tick: 700, weapon: 'AWP', x: 30, y: 30 },
      { kind: 'weapon_drop', round: 3, tick: 900, weapon: 'Glock-18', x: 40, y: 40 }, // no terminators
    ],
    pickups: [
      { kind: 'weapon_pickup', round: 1, tick: 50, weapon: 'AK-47' }, // BEFORE the drop — no effect
      { kind: 'weapon_pickup', round: 1, tick: 300, weapon: 'AK-47' }, // hides the AK
      { kind: 'weapon_pickup', round: 1, tick: 500, weapon: 'Molotov' }, // wrong name — never hides
      { kind: 'weapon_pickup', round: 2, tick: 650, weapon: 'AWP' }, // wrong round — never hides
      { kind: 'weapon_pickup', round: 1, tick: 950, weapon: 'Glock-18' }, // wrong round — never hides
    ],
    roundEnds: [
      { kind: 'round_end', round: 1, tick: 600 },
      { kind: 'round_end', round: 1, tick: 640 }, // a second one — the EARLIER wins
      { kind: 'round_end', round: 2, tick: 800 },
      // round 3 has no round_end: the tail drop lives to the demo's end
    ],
  };
  for (const d of ev.drops) {
    const win = dropWindow(d, ev);
    for (let t = -50; t <= 1200; t++) {
      const got = dropEvidenceAt(
        { drops: [d], pickups: ev.pickups, roundEnds: ev.roundEnds },
        t,
      );
      const want = !!win && t >= win.from && t < win.to;
      assert.equal(!!got, want, `drop @${d.tick} visible at ${t}`);
      if (got) {
        assert.equal(got.row, d, 'the window answers THE row');
        assert.equal(got.x, d.x);
        assert.equal(got.y, d.y);
      }
    }
  }
  // The cases the sweep is made of, spelled out:
  assert.deepEqual(dropWindow(ev.drops[0], ev), { from: 100, to: 300 }, 'pickup-terminated');
  assert.deepEqual(dropWindow(ev.drops[1], ev), { from: 120, to: 600 }, 'round-end-terminated (the earlier end)');
  assert.equal(dropWindow(ev.drops[2], ev), null, 'no position → never visible');
  assert.deepEqual(dropWindow(ev.drops[3], ev), { from: 700, to: 800 }, 'a wrong-round pickup never hides');
  assert.deepEqual(dropWindow(ev.drops[4], ev), { from: 900, to: Infinity }, 'no terminator → lives on');
});

test('scrub coalescing: requestDraw defers setHud draws to ONE rAF (latest tick wins)', () => {
  headlessGlobals();
  // A CONTROLLABLE rAF — the harness's default one never fires, so the
  // queue lets the test flush exactly like a display frame would.
  const queue = [];
  let rafId = 0;
  globalThis.requestAnimationFrame = (fn) => {
    queue.push({ id: ++rafId, fn });
    return rafId;
  };
  globalThis.cancelAnimationFrame = (id) => {
    const i = queue.findIndex((q) => q.id === id);
    if (i >= 0) queue.splice(i, 1);
  };
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const payload = {
    score: null,
    teamNames: { ct: '', t: '' },
    round: { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' },
    tickRate: 64,
  };
  r.setHud(payload);
  r.resize();
  // reference: one synchronous (not coalesced) draw's op count
  const refMark = canvas.log.length;
  r.setHud(payload);
  const singleDraw = canvas.log.length - refMark;
  assert.ok(singleDraw > 0, 'an undirty setHud still draws synchronously (playing cadence)');

  // the burst: requestDraw BEFORE the seek, exactly like Replay's onScrub
  const before = canvas.log.length;
  for (let i = 0; i < 5; i++) {
    r.requestDraw();
    engine.seekFrame(i);
    r.setHud(payload);
  }
  assert.equal(canvas.log.length, before, 'no synchronous draw inside the burst');
  assert.equal(queue.length, 1, 'ONE rAF is pending for the whole burst');
  assert.equal(engine.state.frame, 4, 'the engine state still advanced per event (seek untouched)');
  queue.shift().fn(); // the display frame flushes
  assert.equal(
    canvas.log.length - before,
    singleDraw,
    'exactly ONE draw at the flush — the latest state of the burst',
  );
  assert.equal(queue.length, 0, 'the flush consumed the frame');
  // …and back to synchronous draws the moment the burst is over.
  const afterFlush = canvas.log.length;
  r.setHud(payload);
  assert.equal(canvas.log.length - afterFlush, singleDraw, 'post-burst setHud draws immediately again');
  // destroy cancels a pending flush instead of painting a dead canvas.
  r.requestDraw();
  assert.equal(queue.length, 1, 'a flush is pending');
  r.destroy();
  assert.equal(queue.length, 0, 'destroy() cancels it');
});

// --- UI overlay toggle (setOverlaysVisible) ----------------------------------
// The ONE coarse overlay gate (Replay's toggleHud pushes it): while
// hidden, draw() skips the WHOLE group — HUD box, kill feed, chat — the
// gameplay layers keep painting, the payloads keep flowing (setHud's
// additive semantics) and re-enabling repaints the CURRENT state without
// a re-push. The DOM control-group rows go with the group view-side
// (Replay's {#if !uiHudOff}); this file owns the canvas half. The
// CTRL_GROUP_BUDGET reservation is untouched either way — the score
// box's x-position never moves when the group comes back.

test('overlays: setOverlaysVisible(false) gates HUD/feed/chat — gameplay keeps painting, re-enable repaints', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const mk = (ev) => normalizeEvent(ev, {});
  const round1 = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  r.setLandmarks([
    // no positions → the world layers stay out of the way (the feed
    // itself needs none)
    mk({ id: 1, seq: 1, tick: 50, round: 1, kind: 'kill', attacker: '1', attackerName: 'alice', victim: '2', victimName: 'bob', weapon: 'AK-47' }),
  ]);
  r.setChat([{ id: 1, tick: 50, round: 1, steamId: '1', name: 'alice', text: 'one' }]);
  r.setHud({ score: { ct: 1, t: 0 }, teamNames: { ct: 'NAVY', t: 'FURY' }, round: round1, tickRate: 64 });
  r.resize();
  engine.seekTick(100); // round 1, past the kill + the chat line

  // The shared entry-box surface (radius 4) belongs to BOTH the feed
  // (top) and the chat (bottom) — split by the stage's mid-line, the
  // same y-convention chatBoxesSince uses.
  const feedRows = (from = 0) =>
    opsSince(canvas.log, 'roundRect', from).filter((e) => e.args[4] === KILL_FEED_R && e.args[1] < 300);
  const chatRows = (from = 0) =>
    opsSince(canvas.log, 'roundRect', from).filter((e) => e.args[4] === KILL_FEED_R && e.args[1] >= 300);

  // (1) default: the whole group paints
  let mark = canvas.log.length;
  r.draw();
  assert.ok(hudBoxesSince(canvas.log, mark).length >= 1, 'the score box paints by default');
  assert.equal(feedRows(mark).length, 1, 'the kill feed paints by default');
  assert.equal(chatRows(mark).length, 1, 'the chat paints by default');
  assert.ok(textsSince(canvas.log, mark).includes('NAVY'), 'the score line names the teams');

  // (2) hidden: NONE of the three — the gameplay layers keep painting
  r.setOverlaysVisible(false);
  mark = canvas.log.length;
  r.draw();
  assert.equal(hudBoxesSince(canvas.log, mark).length, 0, 'no score box while hidden');
  assert.equal(feedRows(mark).length, 0, 'no kill-feed row while hidden');
  assert.equal(chatRows(mark).length, 0, 'no chat row while hidden');
  const tt = textsSince(canvas.log, mark);
  assert.ok(tt.includes('alice') && tt.includes('bob'), 'the gameplay name labels still paint');
  assert.ok(!tt.includes('NAVY') && !tt.includes('FURY'), 'no score line while hidden');
  assert.ok(!tt.includes(': one'), 'no chat text while hidden');
  assert.ok(!tt.some((t) => String(t).startsWith('freeze')), 'no round clock while hidden');

  // (3) setHud while hidden: the payload is STORED, nothing paints
  const before = canvas.log.length;
  r.setHud({ score: { ct: 2, t: 0 }, teamNames: { ct: 'NAVY', t: 'FURY' }, round: round1, tickRate: 64 });
  const stored = canvas.log.slice(before);
  assert.equal(hudBoxesSince(stored).length, 0, 'setHud stores its payload but paints no box while hidden');
  assert.ok(!textsSince(stored).includes('NAVY'), '…and no score text either');

  // (4) re-enable: the CURRENT state repaints with NO re-push of the
  // chat / feed / HUD payloads (the additive-setter contract)
  const re = canvas.log.length;
  r.setOverlaysVisible(true);
  assert.ok(hudBoxesSince(canvas.log, re).length >= 1, 're-enable repaints the score box');
  assert.ok(
    textsSince(canvas.log, re).some((t) => String(t).includes('2 – 0')),
    '…from the payload stored while hidden (no setHud re-push)',
  );
  assert.equal(feedRows(re).length, 1, 'the kill feed comes back');
  assert.equal(chatRows(re).length, 1, 'the chat comes back');
  r.destroy();
});

// --- follow camera: the last-ALIVE hold while the followed player is dead ----
//
// renderer.js draw()'s follow block: lerpAt reports a DEAD frame without
// touching x/y and `tmp` is shared with drawPlayers — without the hold
// the camera would jump to whichever slot drew last (the followed
// player's death yanking the view onto a neighbour). This is exactly
// what a DEAD card's click-to-follow relies on: following a dead player
// frames their LAST ALIVE position until respawn. Characterization pin
// — nothing pinned this before.
test('follow camera holds the last alive position while the followed player is dead, then tracks them again', () => {
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
  r.resize();
  // The OTHER player's dot is the camera probe: panelToScreen reads
  // cam.cx/cy directly, so where bob's dot lands IS where the camera
  // is (alice's own dot cannot probe her hold — she is the one dying).
  const bobDot = (from) =>
    canvas.log
      .slice(from)
      .find((e) => e.op === 'arc' && e.fillStyle === '#e6a35a' && e.args[2] === 9);
  const aliceDots = (from) =>
    canvas.log
      .slice(from)
      .filter((e) => e.op === 'arc' && e.fillStyle === '#5aa9e6' && e.args[2] === 9);

  engine.setFollow(0); // camera follows alice (slot 0)
  engine.seekTick(100);
  let mark = canvas.log.length;
  r.draw();
  const bobAlive = bobDot(mark);
  assert.ok(bobAlive, "bob's dot draws while alice is alive");
  assert.ok(aliceDots(mark).length >= 1, "alice's dot draws too");

  // alice dies at this frame — lerpAt returns with alive:false and x/y
  // untouched (still bob's, from the shared tmp).
  data.masks[100] &= ~1;
  mark = canvas.log.length;
  r.draw();
  assert.equal(aliceDots(mark).length, 0, 'the dead followed player draws no dot');
  const bobHeld = bobDot(mark);
  assert.ok(bobHeld, "bob's dot still draws while alice is dead");
  assert.deepEqual(
    [bobHeld.args[0], bobHeld.args[1]],
    [bobAlive.args[0], bobAlive.args[1]],
    "the camera HELD alice's last alive position — bob's dot did not jump (the shared-tmp leak the hold prevents)",
  );

  // alice respawns AND has moved (the position stream advances): the
  // hold releases and the camera tracks her new position again.
  data.slots[0].pos[100 * 4] = 90;
  data.slots[0].pos[100 * 4 + 1] = 90;
  data.masks[100] |= 1;
  mark = canvas.log.length;
  r.draw();
  const bobRespawn = bobDot(mark);
  assert.ok(aliceDots(mark).length >= 1, 'the respawned player draws again');
  assert.ok(bobRespawn, "bob's dot draws after the respawn");
  assert.notDeepEqual(
    [bobRespawn.args[0], bobRespawn.args[1]],
    [bobHeld.args[0], bobHeld.args[1]],
    'the camera tracks the respawned player again (the hold is only while dead)',
  );
  r.destroy();
});

// --- smart camera composition: WHAT the frame frames (smartTarget) ------------
//
// smartTarget (renderer.js) unions the points the smart camera must keep
// on screen: ALIVE players + the ACTIVE bomb — planted inside
// bombEndTick's window (INCLUSIVE of the cutoff tick, deliberately: at
// the cutoff the blast is still what the viewer needs to see, while the
// MARKER is already gone there — see the planted-C4 boundary test
// above) or dropped (bomb.js bombEvidenceAt's 'dropped' branch). A
// carried bomb needs NO point of its own — its carrier is an alive
// player — and a DEAD player contributes nothing (their last spot would
// pin the view to a ghost).
//
// Nothing else pins that composition: the pure pins above cover
// smartCamTarget's fit/clamp math and the world-layer tests cover
// drawBomb's MARKER, but smartTarget is reachable ONLY through the real
// path — createRenderer → setLandmarks → setCameraMode('smart') →
// draw() → getCam() — which is what these tests drive.
//
// Two harness rules keep the pins honest:
//   · RELATIVE assertions only — with-bomb vs without-bomb on the SAME
//     fixture and the same 800×600 canvas (the size-aware
//     smartMarginFor makes absolute scales a function of the stage),
//     plus the bomb point's OWN screen position (r.worldToScreen — the
//     renderer's projection, no duplicated image math);
//   · a VIRTUAL clock (the engine.test.js precedent): stepSmart eases
//     off performance.now(), so a real clock would make the number of
//     eased steps depend on how long the test process happens to take.
//     `at()` advances it 33 ms per draw — the SMART_DT_CLAMP — so every
//     settle is the same deterministic ramp: 100 draws = 3.3 s ≈ 18 τ
//     on the center ease, a residual <1e-5 of the target distance.

// The virtual clock + the renderers the current test built. One
// smartClock() per test; the teardown it returns (t.after) destroys the
// harness renderers and puts performance.now back on its prototype.
let smartNowMs = 0;
let smartRenders = [];
function smartClock() {
  smartNowMs = 0;
  Object.defineProperty(performance, 'now', {
    value: () => smartNowMs,
    configurable: true,
    writable: true,
  });
  return () => {
    for (const r of smartRenders) r.destroy();
    smartRenders = [];
    delete performance.now;
  };
}

// smartHarness — the composition fixture, wired the way the view wires
// it: synthStore's standing players (alice (10,10), bob (50,50) on the
// 0…100 grid), a recording 800×600 canvas, then setLandmarks →
// setStateIndex? → resize → setCameraMode('smart'). `at(tick, probes,
// draws)` seeks, pumps `draws` eased frames, then snapshots the camera
// — cx/cy in image space, s = fit × zoom (the SCREEN scale
// smartCamTarget's target.s IS) — AND projects each named probe point
// [wx, wy] under the SETTLED camera as { x, y, inFrame } (inFrame =
// inside the stage — THE framing claim, independent of margin policy).
// Probes are evaluated INSIDE at(): a later at() re-eases the camera,
// so a lazy closure would answer for the WRONG frame — the snapshot
// must carry everything it claims.
function smartHarness({ landmarks = [], stateIndex = null } = {}) {
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
  smartRenders.push(r);
  const mk = (ev) => normalizeEvent(ev, {});
  r.setLandmarks(landmarks.map(mk));
  if (stateIndex) r.setStateIndex(stateIndex);
  r.resize();
  r.setCameraMode('smart'); // the view's default mode (Replay.svelte)
  const at = (tick, probes = {}, draws = 100) => {
    engine.seekTick(tick);
    for (let i = 0; i < draws; i++) {
      smartNowMs += 33;
      r.draw();
    }
    const cam = r.getCam();
    const shot = { cx: cam.cx, cy: cam.cy, s: cam.fit * cam.zoom };
    for (const [name, [wx, wy]] of Object.entries(probes)) {
      const p = r.worldToScreen(wx, wy);
      shot[name] = {
        x: p.x,
        y: p.y,
        inFrame: p.x >= 0 && p.x <= canvas.clientWidth && p.y >= 0 && p.y <= canvas.clientHeight,
      };
    }
    return shot;
  };
  return { r, engine, data, canvas, at };
}

// assertSameFrame — two settled cameras framed the SAME box: equal
// within the settle residual (100 eased draws leave <1e-5 of the target
// distance — the tolerances below are float dust; a real composition
// difference is tens of image px).
function assertSameFrame(a, b, msg) {
  assert.ok(Math.abs(a.cx - b.cx) < 0.01, `${msg}: cx ${a.cx} vs ${b.cx}`);
  assert.ok(Math.abs(a.cy - b.cy) < 0.01, `${msg}: cy ${a.cy} vs ${b.cy}`);
  assert.ok(Math.abs(a.s - b.s) < 0.001 * b.s, `${msg}: s ${a.s} vs ${b.s}`);
}

test('smart camera frames the planted C4: a bomb far outside the player box PULLS the frame', (t) => {
  const teardown = smartClock();
  t.after(teardown);
  headlessGlobals();
  // The plant sits at (90,90) — FAR outside the players' box
  // ((10,10)…(50,50)), the map's top-right corner (world y flips into
  // image y, so it reads as up-and-right of them) — and carries a full
  // world position like the marker fixtures above. The control is the
  // SAME fixture without the bomb row: any framing difference is the
  // row's contribution alone.
  const plantRow = { id: 1, seq: 1, tick: 192, round: 1, kind: 'bomb_plant', posX: 90, posY: 90, posZ: 0 };

  const baseH = smartHarness();
  const base = baseH.at(300, { bomb: [90, 90] });
  const bombH = smartHarness({ landmarks: [plantRow] });
  const withBomb = bombH.at(300, { bomb: [90, 90], alice: [10, 10] });

  assert.equal(base.bomb.inFrame, false, 'fixture sanity: without the plant row the bomb corner sits off screen');
  assert.ok(withBomb.bomb.inFrame, 'with the plant row the bomb IS framed — the target box grew to include it');
  assert.ok(withBomb.alice.inFrame, '…and the players stay framed: the bomb ADDS to the union, it never replaces it');
  // The wider box loosens the fit (smaller screen scale) and the center
  // moves toward the bomb's image point: image x grows with world x
  // (cx ↑), image y shrinks with world y (cy ↓).
  assert.ok(withBomb.s < base.s, `the zoom loosens to fit the bomb (${withBomb.s} < ${base.s})`);
  assert.ok(withBomb.cx > base.cx && withBomb.cy < base.cy, 'the center is pulled toward the bomb');
});

test('the planted bomb frames only inside bombEndTick: framed in-window and AT the cutoff, gone one tick later', (t) => {
  const teardown = smartClock();
  t.after(teardown);
  headlessGlobals();
  // Plant at 192; round 1's round_end at 400 is its ONLY terminator
  // (no bomb_explode / bomb_defuse / round_start rows → bombEndTick =
  // 400), so the window is [192, 400] INCLUSIVE — the deliberate
  // `tick <= end` at smartTarget, whose comment contrasts it with
  // drawBomb's `>=` rule (the MARKER is already gone AT 400 — pinned by
  // the planted-C4 boundary test above; this is the CAMERA keeping the
  // blast framed for that last tick).
  const rows = [
    { id: 1, seq: 1, tick: 192, round: 1, kind: 'bomb_plant', posX: 90, posY: 90, posZ: 0 },
    { id: 2, seq: 2, tick: 400, round: 1, kind: 'round_end' },
  ];
  const baseH = smartHarness(); // control: the same players, no rows
  const base = baseH.at(401, { bomb: [90, 90] });
  const h = smartHarness({ landmarks: rows });
  const inWindow = h.at(399, { bomb: [90, 90] });
  const atCutoff = h.at(400, { bomb: [90, 90] }); // tick === bombEndTick — the inclusive boundary
  const pastCutoff = h.at(401, { bomb: [90, 90] });

  assert.ok(inWindow.bomb.inFrame, 'inside the window the bomb is framed');
  assert.ok(
    atCutoff.bomb.inFrame,
    'AT the cutoff tick the bomb is STILL framed — the inclusive boundary the smartTarget comment pins',
  );
  assert.equal(pastCutoff.bomb.inFrame, false, 'one tick past the cutoff the bomb contributes nothing');
  assert.ok(inWindow.cx > base.cx && inWindow.s < base.s, 'in-window the frame is the pulled one');
  assertSameFrame(pastCutoff, base, 'past the cutoff the frame is the bomb-less one again');
});

test('the dropped C4 frames while bombEvidenceAt says dropped; a pickup closes the evidence and the frame snaps back', (t) => {
  const teardown = smartClock();
  t.after(teardown);
  headlessGlobals();
  // A bomb_drop at (90,90) — far from the players — with no plant and
  // no round_end before the playhead: bombEvidenceAt's 'dropped'
  // branch (the round is still live — round_end sits at 800). The
  // pickup at 400 lands at a DIFFERENT far corner (10,90): if the
  // 'picked-up' evidence ever leaked its position into smartTarget,
  // this frame would be pulled toward that corner instead of snapping
  // back to the players-only box.
  const rows = [
    { id: 1, seq: 1, tick: 100, round: 1, kind: 'bomb_drop', attacker: '1', posX: 90, posY: 90, posZ: 0 },
    { id: 2, seq: 2, tick: 400, round: 1, kind: 'bomb_pickup', attacker: '2', posX: 10, posY: 90, posZ: 0 },
    { id: 3, seq: 3, tick: 800, round: 1, kind: 'round_end' },
  ];
  const baseH = smartHarness(); // control: the same players, no rows
  const base = baseH.at(500, { drop: [90, 90] });
  const h = smartHarness({ landmarks: rows });
  const dropped = h.at(300, { drop: [90, 90] }); // after the drop, before the pickup
  const pickedUp = h.at(500, { drop: [90, 90], pickup: [10, 90] }); // the pickup closed the evidence

  assert.ok(dropped.drop.inFrame, 'while the bomb is on the ground its position is framed');
  assert.ok(dropped.cx > base.cx && dropped.s < base.s, '…and it pulls the frame away from the players-only box');
  assert.equal(pickedUp.drop.inFrame, false, 'a pickup closes the evidence: the DROP position stops contributing');
  assert.equal(
    pickedUp.pickup.inFrame,
    false,
    'the PICKUP position never contributes either — the bomb rides its carrier (an alive player)',
  );
  assertSameFrame(pickedUp, base, 'after the pickup the frame is the players-only one');
});

test('a carried C4 adds NO point: the frame is exactly the players-only one (the carrier rides its own dot)', (t) => {
  const teardown = smartClock();
  t.after(teardown);
  headlessGlobals();
  // The carried-C4 badge fixture shape (the inventory pins above): the
  // C4 sits in alice's inventory from frame 0, and the bomb's evidence
  // — dropped at (90,90), picked up by alice at (10,90), BOTH far
  // corners the players never visit — resolves to 'picked-up' at the
  // playhead (bombEvidenceAt branch 1: a pickup after the drop closes
  // it). smartTarget has no inventory/pickup branch for a carried bomb
  // ON PURPOSE (its comment: "A carried bomb needs no point of its own
  // — its carrier is an alive player"): the union box is idempotent
  // over the carrier's OWN point, so what this pins is that no EXTRA
  // point (a stale evidence position) leaks in.
  const rows = [
    { id: 1, seq: 1, tick: 50, round: 1, kind: 'bomb_drop', attacker: '2', posX: 90, posY: 90, posZ: 0 },
    { id: 2, seq: 2, tick: 100, round: 1, kind: 'bomb_pickup', attacker: '1', posX: 10, posY: 90, posZ: 0 },
  ];
  const stateIndex = buildStateIndex(
    [
      { frame: 0, slot: 0, mask: 0x008, inventory: ['C4', 'AK-47'] }, // alice carries
      { frame: 0, slot: 1, mask: 0x008, inventory: ['USP-S'] }, // bob does not
    ],
    2,
  );
  const baseH = smartHarness(); // control: the same players, no rows
  const base = baseH.at(300, { drop: [90, 90], pickup: [10, 90] });
  const h = smartHarness({ landmarks: rows, stateIndex });
  // the badge (the inventory pins' own drawImage signature — the 48×24
  // art at 20×10) proves the fixture is genuinely CARRIED
  h.r.setIcons({ C4: { width: 48, height: 24, src: 'c4.svg' } });
  const carried = h.at(300, { drop: [90, 90], pickup: [10, 90] });

  assert.ok(
    h.canvas.log.some((e) => e.op === 'drawImage' && e.args[4] === 10 && e.args[3] === 20),
    'fixture sanity: the carrier badge paints — the bomb really is in an inventory',
  );
  assert.equal(carried.drop.inFrame, false, 'the stale DROP position never becomes a camera point');
  assert.equal(carried.pickup.inFrame, false, '…nor the PICKUP position: the bomb rides its carrier (an alive player)');
  assertSameFrame(carried, base, 'the carried bomb adds NO point: the frame is the players-only one');
});

test('a dead player never pulls the frame: bob’s far last spot frames only while he is alive', (t) => {
  const teardown = smartClock();
  t.after(teardown);
  headlessGlobals();
  // bob's position stream stands at (90,90) — a corner far from alice
  // at (10,10) — for the WHOLE fixture: wherever he dies, his last
  // alive spot is out there. smartTarget's player loop gates on
  // tmp.alive (the store only samples alive slots), so a dead frame's
  // stale position must never enter the box.
  const bobFar = (h) => {
    for (let f = 0; f < h.data.frames; f++) {
      h.data.slots[1].pos[f * 4] = 90;
      h.data.slots[1].pos[f * 4 + 1] = 90;
    }
  };

  const aliveH = smartHarness();
  bobFar(aliveH);
  const alive = aliveH.at(300, { bob: [90, 90] }); // bob alive at the playhead

  const deadH = smartHarness();
  bobFar(deadH);
  deadH.data.masks[300] &= ~2; // bob dies at frame 300 — his last spot stays (90,90)
  const dead = deadH.at(300, { bob: [90, 90], alice: [10, 10] });

  const aloneH = smartHarness(); // the control: bob out of the round entirely
  bobFar(aloneH);
  for (let f = 0; f < aloneH.data.frames; f++) aloneH.data.masks[f] &= ~2;
  const alone = aloneH.at(300, { bob: [90, 90] });

  assert.ok(alive.bob.inFrame, 'fixture sanity: the ALIVE far player IS framed');
  assert.equal(dead.bob.inFrame, false, 'the DEAD player’s last spot does not pull the frame');
  assert.ok(
    Math.abs(dead.alice.x - 400) < 1 && Math.abs(dead.alice.y - 300) < 1,
    'the frame is alice alone — one point fits at the band’s max zoom and centres on it (margin-independent)',
  );
  assertSameFrame(dead, alone, 'and it is exactly the frame the fixture has without bob');
  assert.ok(
    alive.cx > dead.cx && alive.s < dead.s,
    'the SAME far spot widens the frame while bob is alive — the gate is the aliveness alone',
  );

  // …and with NOBODY alive smartTarget returns null → the view HOLDS
  // (its documented "hold the current view"): the camera must not move
  // an inch toward the stale far position sitting in the shared tmp
  // from the previous draw — anything less than the full alive+finite
  // gate would ease the camera onto that ghost instead of holding.
  aliveH.data.masks[400] &= ~3; // alice AND bob dead at frame 400
  const held = aliveH.at(400, { bob: [90, 90] });
  assertSameFrame(held, alive, 'nobody alive → the view holds the framing it had — no ghost eases in');
});

test("setCameraMode('smart') re-arms the ease — never snaps — and stepSmart converges onto smartCamTarget of the framed box", (t) => {
  const teardown = smartClock();
  t.after(teardown);
  headlessGlobals();
  // The VIEW's default is Smart (Replay.svelte's camMode $state('smart'),
  // pinned view-side by replay.dom.mjs's "the active mode is
  // highlighted … Smart"); the renderer itself starts 'free' and the
  // view arms smart on attach. What nothing pinned until now is the
  // mechanism that default relies on: switching to smart RE-ARMING the
  // ease from wherever the camera is ("the target is computed on the
  // next draw, never snapped to") and stepSmart carrying the view onto
  // it.
  const h = smartHarness(); // players only, no landmark rows
  const armed = h.at(300, {}, 0); // seek only — the single eased step setCameraMode already took
  const settled = h.at(300);

  // The framed box in image space: synthStore's 0…100 bounds through
  // reproject's no-pack grid fallback (scale = span/900 = 1/9 with the
  // ±5 % inset → image = 9·(x+5), 9·(105−y); extent = 1.1·span/scale
  // = 990): alice (10,10) → (135,855), bob (50,50) → (495,495).
  // The margin stays smartCamTarget's default — the size-aware
  // smartMarginFor for this canvas, the same call smartTarget makes.
  const expected = smartCamTarget(
    { minX: 135, minY: 495, maxX: 495, maxY: 855 },
    800,
    600,
    { extW: 990, extH: 990 },
  );

  assert.equal(
    camConverged(armed, expected),
    false,
    'right after the switch the view is NOT yet at the target — the mode re-arms the ease instead of snapping',
  );
  assert.ok(
    camConverged(settled, expected),
    'and the settle eases onto smartCamTarget of smartTarget’s box — stepSmart ran on every draw',
  );
  assert.ok(settled.cx < armed.cx - 50, 'the ease actually travelled toward the target (the center moved)');
  assert.ok(settled.s > armed.s * 1.5, '…and so did the zoom');
});

// --- resize while PAUSED (the mini→cover dock transition) -------------------
// The owner's dock report (2026-11-11): expanding the mini player while
// paused must repaint the frozen frame at the NEW size — with the engine
// paused there is no per-frame draw to heal a stale viewport, so
// resize() itself has to re-read the canvas box, reset the backing
// store and draw the current state in one pass. A "one-time redraw"
// that read STALE state would not help; this pin asserts the repaint
// uses the new cssW/cssH end to end: the backing store, the background
// pass it clears, and the world→screen projection every entity dot
// rides. (The smart ease settling while paused is pinned separately by
// smartHarness's convergence tests above — every `at()` there draws on
// a paused engine.)
test('resize() while paused repaints the current state at the NEW canvas size (mini → cover)', () => {
  headlessGlobals();
  const data = synthStore(8, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas(320, 190); // the dock's mini frame
  const r = createRenderer(canvas, {
    engine,
    data,
    players: [
      { steamId: '1', name: 'alice', side: 'ct' },
      { steamId: '2', name: 'bob', side: 't' },
    ],
  });
  r.resize(); // the mini frame — drawn while the engine is PAUSED
  assert.equal(engine.state.playing, false, 'the whole pin runs paused');
  assert.equal(canvas.width, 320, 'mini backing store');
  assert.equal(canvas.height, 190);
  const fitMini = r.getCam().fit;
  const probeMini = r.worldToScreen(10, 10);

  // The dock expands: the same canvas element now lays out at cover size.
  canvas.clientWidth = 1600;
  canvas.clientHeight = 900;
  const mark = canvas.log.length;
  r.resize();

  assert.equal(canvas.width, 1600, 'the backing store follows the new box');
  assert.equal(canvas.height, 900);
  const ops = canvas.log.slice(mark);
  assert.ok(ops.length > 0, 'a draw ran while paused (nothing else would repaint)');
  // The grid pass draws THROUGH the new viewport: its vertical lines
  // end at y = cssH (900) and its horizontal lines at x = cssW (1600) —
  // geometry that is impossible to emit from the stale 320×190 box.
  const spansNewViewport = ops.some(
    (e) => e.op === 'lineTo' && (e.args[0] === 1600 || e.args[1] === 900),
  );
  assert.ok(spansNewViewport, 'the repaint drew across the NEW viewport (1600×900), not the stale mini box');
  // The camera re-fit for the new box and the entity projection moved
  // with it — a dot's screen position is only valid inside the NEW
  // viewport (the stale mini probe sat at ≤320×190 by construction).
  const cam = r.getCam();
  assert.ok(cam.fit > fitMini, `fit re-derived for the larger box (${fitMini} → ${cam.fit})`);
  const probe = r.worldToScreen(10, 10);
  assert.ok(probe.x >= 0 && probe.x <= 1600 && probe.y >= 0 && probe.y <= 900, `entity probe inside the new viewport: ${probe.x},${probe.y}`);
  assert.ok(
    Math.abs(probe.x - probeMini.x) > 10 || Math.abs(probe.y - probeMini.y) > 10,
    'the projection actually moved with the resize (not the stale mini geometry)',
  );
});
