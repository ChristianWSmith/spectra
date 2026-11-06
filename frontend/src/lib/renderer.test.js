// Tests for the replay renderer's PURE helpers (lib/replay/renderer.js):
// the trail-continuity rule (trailConnects — the break that keeps player
// movement trails from streaking across a round reset or a
// death→respawn teleport), the smart camera's fit/ease (smartCamTarget,
// easeValue, camConverged), the world-layer geometry (arrowPath,
// crossPath, muzzleRays), the tick-window effects (windowAlpha,
// fireJump), the death-marker lifetime (killEndTick) — plus end-to-end
// draws over a recording 2D context (the world layers follow the tick:
// lingering smoke, the death X's round cleanup, the C4 icon and its text
// fallback, the muzzle burst; and the HUD — the centered team-score box,
// the C4/0:00 clock, the tick/frame-free playback readout — plus the
// round-scoped kill feed).
// Run: node --test src/lib/renderer.test.js (from frontend/; the lib test
// glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  trailConnects,
  smartCamTarget,
  easeValue,
  camConverged,
  arrowPath,
  crossPath,
  muzzleRays,
  windowAlpha,
  fireJump,
  killEndTick,
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

test('arrowPath: 7 points, tip along the angle, symmetric about the axis', () => {
  const size = 25;
  const p = arrowPath(100, 50, 0, size);
  assert.equal(p.length, 7);
  assert.deepEqual(p[3], [100 + size, 50]); // the TIP points east at angle 0
  // base sits on the dot, head base at 0.55·size, head wider than shaft
  assert.equal(p[0][0], 100);
  assert.ok(Math.abs(p[1][0] - (100 + size * 0.55)) < 1e-9);
  assert.ok(Math.abs(p[2][1] - (50 - size * 0.34)) < 1e-9);
  assert.ok(Math.abs(p[1][1] - (50 - size * 0.16)) < 1e-9);
  // mirror symmetry about the look axis (index i ↔ 6-i)
  for (let i = 0; i < 7; i++) {
    const a = p[i];
    const b = p[6 - i];
    assert.ok(Math.abs(a[0] - b[0]) < 1e-9, `x mirror ${i}`);
    assert.ok(Math.abs(a[1] + b[1] - 100) < 1e-9, `y mirror ${i}`); // 2·cy
  }
  // half a turn points the other way (screen y is down: +90° is south)
  const q = arrowPath(100, 50, Math.PI / 2, size);
  assert.ok(Math.abs(q[3][0] - 100) < 1e-9);
  assert.ok(Math.abs(q[3][1] - (50 + size)) < 1e-9);
  // degenerate size collapses onto the dot (never NaN, never a spike)
  const z = arrowPath(10, 20, 1.1, 0);
  assert.deepEqual(z, Array.from({ length: 7 }, () => [10, 20]));
  assert.deepEqual(arrowPath(10, 20, 0, NaN), z);
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
  assert.equal(killEndTick(kill, tr, ends), 5000);
  // only earlier/other-round terminators → the no-round_end fallback
  const fallback = 1000 + 180 * tr;
  assert.equal(killEndTick(kill, tr, [ends[0], ends[1], ends[3]]), fallback);
  assert.equal(killEndTick(kill, tr, []), fallback);
  assert.equal(killEndTick(kill, tr, null), fallback);
  // invalid row → 0 (draw nothing)
  assert.equal(killEndTick(null, tr, ends), 0);
  assert.equal(killEndTick({ round: 3 }, tr, ends), 0);
});

// --- end-to-end draw over a recording 2D context ----------------------------
//
// The world layers are only exercised by actually calling draw(); this
// drives createRenderer headlessly (node has no canvas) with a context
// that RECORDS every op instead of painting, and pins the tick-derived
// behavior the specs ask for: the lingering smoke reaches the renderer
// through the typed bucket, the death X lives exactly as long as its
// round (and comes back on a backwards scrub), the extracted C4 icon
// replaces the 'C4' label (text fallback without icons), the muzzle
// burst arms on an attack edge, the damage flash and the talking ring
// are pure functions of tick.

// recordingCanvas: { log, getContext, clientWidth/Height } — a stand-in
// canvas whose 2D context records stroke/fill/arc/drawImage/fillText
// ops together with the stroke/fill style, lineWidth and lineCap in
// force.
function recordingCanvas(cssW = 800, cssH = 600) {
  const log = [];
  const styles = {
    strokeStyle: '',
    fillStyle: '',
    lineCap: 'butt',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    shadowColor: '',
    shadowBlur: 0,
    imageSmoothingEnabled: true,
  };
  const RECORD = new Set(['stroke', 'fill', 'arc', 'drawImage', 'fillText']);
  const ctx = new Proxy(styles, {
    get(t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in t) return t[prop];
      return (...args) => {
        if (RECORD.has(prop)) {
          log.push({
            op: prop,
            strokeStyle: t.strokeStyle,
            fillStyle: t.fillStyle,
            lineCap: t.lineCap,
            lineWidth: t.lineWidth,
            alpha: t.globalAlpha,
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

// headlessGlobals — the browser globals createRenderer touches that node
// has neither: a 1-dpr window, no-op rAF, and a canvas factory for the
// icon tint cache (offscreen canvas → 'source-in' recolor). Idempotent,
// so every end-to-end draw test installs it before driving the renderer.
function headlessGlobals() {
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage() {},
        fillRect() {},
        globalCompositeOperation: '',
        fillStyle: '',
      }),
    }),
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

test('world layers follow the tick: smoke, death X, C4 icon, muzzle, hits, voice', () => {
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
  ]);
  const smokeIcon = { width: 32, height: 32, src: 'smoke.svg' };
  const c4Icon = { width: 32, height: 32, src: 'c4.svg' };
  r.setIcons({ C4: c4Icon, 'Smoke Grenade': smokeIcon });
  r.setVoices({ colors: ['#84C8ED', null], speaking: (slot) => slot === 0 });
  r.setStateIndex(buildStateIndex([{ frame: 192, slot: 0, mask: 0x40, attack: true }], 2));
  r.resize(); // first draw at tick 0 (nothing of ours is live yet)

  const since = (mark) => canvas.log.slice(mark);
  const strokes = (from = 0) => since(from).filter((e) => e.op === 'stroke');
  const fills = (from = 0) => since(from).filter((e) => e.op === 'fill');
  // the death X is the ONLY thing that strokes with lineCap 'round'
  const deathX = (from = 0) =>
    strokes(from).filter((e) => e.lineCap === 'round' && e.strokeStyle === '#e6a35a');
  const smokeCloud = (from = 0) =>
    fills(from).filter((e) => String(e.fillStyle).startsWith('rgba(180, 190, 205'));

  // --- inside round 1, smoke lingering, bomb on the ground -----------------
  let mark = canvas.log.length;
  engine.seekTick(200);
  r.draw();
  assert.ok(smokeCloud(mark).length > 0, 'the smoke cloud reaches the renderer (typed bucket)');
  assert.ok(deathX(mark).length > 0, 'the death X marks where bob died');
  assert.ok(
    since(mark).some((e) => e.op === 'drawImage' && e.args[3] === 12),
    'the extracted C4 icon is drawn for the dropped bomb (BOMB_ICON_PX)',
  );
  // the talking ring: the assigned voice color at r+9 (r=9 standing →
  // an 8 px gap: it must not touch the dot, nor the amber follow ring)
  assert.ok(
    since(mark).some(
      (e) => e.op === 'arc' && e.strokeStyle === '#84C8ED' && e.args[2] === 18,
    ),
    'the talking ring is drawn in the voice color with a gap',
  );
  // the voice-colored rim on bob-less alice's dot (radius r = 9)
  assert.ok(
    since(mark).some(
      (e) => e.op === 'arc' && e.strokeStyle === '#84C8ED' && e.args[2] === 9,
    ),
    'the assigned voice color outlines the dot',
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

  // --- the smoke lifetime (18 s) ends it, nothing is sticky ----------------
  mark = canvas.log.length;
  engine.seekTick(1299); // age = (1299-128)/64 ≈ 18.3 s
  r.draw();
  assert.equal(smokeCloud(mark).length, 0, 'the smoke cloud fades out after its lifetime');

  // --- firing: the attack edge arms the muzzle burst -----------------------
  mark = canvas.log.length;
  engine.seekTick(191); // attack bit still false here → re-seed
  r.draw();
  mark = canvas.log.length;
  engine.seekTick(192); // …rising edge on this frame
  r.draw();
  assert.ok(
    strokes(mark).some((e) => e.strokeStyle === '#ffd982'),
    'the muzzle burst draws on the attack edge',
  );
  // …and is gone once its window (0.22 s) has passed
  mark = canvas.log.length;
  engine.seekTick(260);
  r.draw();
  assert.equal(
    strokes(mark).filter((e) => e.strokeStyle === '#ffd982').length,
    0,
    'the muzzle burst self-clears',
  );

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

// --- HUD + kill feed over the recording context ------------------------------
//
// The HUD boxes and the kill feed live ON the canvas (snapshots and clip
// recordings capture the canvas and nothing else), so they are pinned the
// same way as the world layers: drive draw() and read the recorded ops.
// measureText always reports 40px in this harness, which makes every box
// geometry assertion exact.

const HUD_PAD = 8; // mirrors renderer.js — box padding / stage offset
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

test('HUD: centered team score line, label-free clock, no tick/frame counter', () => {
  headlessGlobals();
  const data = synthStore(1300, 2);
  const engine = createEngine(data, 64);
  const canvas = recordingCanvas();
  const r = createRenderer(canvas, { engine, data, players: HUD_PLAYERS });
  const round = { number: 1, label: 'R1', startTick: 0, freezeEndTick: 640, endTick: 1200, bombSite: '' };
  r.setHud({ score: { ct: 3, t: 2 }, teamNames: { ct: 'NAVY', t: 'FURY' }, round, tickRate: 64 });
  r.resize();

  const score = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'NAVY 3 – 2 FURY');
  assert.ok(score, 'the score line names the TEAMS, not the sides');
  // CENTERED, not top-left: both lines measure 40px, so the box is
  // 40 + 2×8 = 56 wide → x = (800 − 56) / 2 = 372, its text 8px in.
  // (The old top-left box started at HUD_TOP_X = 52.)
  assert.equal(score.args[1], 372 + HUD_PAD);
  assert.equal(score.args[2], HUD_PAD + HUD_PAD); // box top + first line

  const texts = textsSince(canvas.log);
  assert.ok(texts.includes('freeze 0:10'), 'line 2 is the bare clock (freeze time at tick 0)');
  assert.ok(!texts.some((t) => String(t).includes('·')), 'the round label is gone');
  assert.ok(!texts.some((t) => String(t).startsWith('R1')), 'no round number in the HUD');

  // the bottom box lost its tick/frame counter but keeps the readout
  assert.ok(!texts.some((t) => String(t).startsWith('tick ')), 'the tick counter is gone');
  assert.ok(!texts.some((t) => String(t).includes('frame ')), 'the frame counter is gone');
  assert.ok(texts.includes('1×'), 'speed× stays');

  // an empty team name falls back to the bare side
  r.setHud({ score: { ct: 3, t: 2 }, teamNames: { ct: '', t: '' }, round, tickRate: 64 });
  assert.ok(textsSince(canvas.log).includes('CT 3 – 2 T'));

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
  // measureText is 40 → the arrow line is 12 + 40 + 4 + 40 + 4 + 40 =
  // 140 wide (x = 800 − 8 − 140 = 652) and the icon line 114 (x = 678).
  const boxes = feedBoxesSince(canvas.log, mark);
  assert.equal(boxes.length, 2, 'both round-1 kills up to the playhead');
  const top = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'bob' && e.args[2] === 12);
  assert.equal(top.args[1], 652 + 6, 'the newest entry is right-aligned at cssW − 8');
  assert.equal(top.fillStyle, '#e6a35a', "the KILLER's outline/name use the killer's side (T)");
  const lower = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice' && e.args[2] === 30);
  assert.equal(lower.args[1], 678 + 6);
  assert.equal(lower.fillStyle, '#5aa9e6', 'the CT killer is CT-colored');

  // outline = the killer's team color, 1px, full alpha (nothing else in
  // the frame strokes that combination: trails/arrow draw at alpha ≤ 0.5)
  const lines = (color) =>
    opsSince(canvas.log, 'stroke', mark).filter(
      (e) => e.strokeStyle === color && e.lineWidth === 1 && e.alpha === 1,
    );
  assert.equal(lines('#e6a35a').length, 1, 'the T killer’s box is outlined in T');
  assert.equal(lines('#5aa9e6').length, 1, 'the CT killer’s box is outlined in CT');

  // victim names are tinted by the VICTIM's side (both at x = 746)
  const victimT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'bob' && e.args[2] === 30);
  assert.equal(victimT.args[1], 746);
  assert.equal(victimT.fillStyle, '#e6a35a');
  const victimCT = canvas.log.find((e) => e.op === 'fillText' && e.args[0] === 'alice' && e.args[2] === 12);
  assert.equal(victimCT.args[1], 746);
  assert.equal(victimCT.fillStyle, '#5aa9e6');

  // weapon: the canonical name's image when the manifest has one…
  assert.equal(opsSince(canvas.log, 'drawImage', mark).filter((e) => e.args[3] === 14).length, 1, 'one weapon image (KILL_FEED_ICON)');
  // …and a plain arrow when it does not
  assert.ok(
    canvas.log.some((e) => e.op === 'fillText' && e.args[0] === '→' && e.args[2] === 12),
    'a weapon with no image falls back to →',
  );

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
