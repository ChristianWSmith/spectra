// Tests for lib/replay/input.js — the replay keyboard OWNER: the guard
// ladder (modifier → defaultPrevented → text entry → key-repeat →
// focused-control Space → range arrows), the 1-9/0 slot digits, the
// F-resume mirror over engine.onChange, detach, and the two view-owned
// callbacks ([ ] round navigation, X skip-freeze — asserted as the
// CALLBACK, never as a pref/engine write). Plus the WHEEL path driven
// through a REAL renderer: while follow is engaged the wheel changes
// only the scale (follow survives, onUserCamera never fires, the view
// stays centered on the followed player), free mode keeps its
// cursor-anchored zoom and a non-following smart camera still takes
// over to free.
// Run: node --test src/lib/input.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

// input.js → download.js → save.js → services.js → the generated
// bindings, which node imports as a directory (see esm-dir-hook.mjs).
installEsmDirHook();
const { attachReplayInput } = await import('./replay/input.js');
const { createRenderer } = await import('./replay/renderer.js');
const { createEngine, parsePositions } = await import('./replay/engine.js');

// --- keyboard harness -------------------------------------------------------

// emitter — the window/canvas event surface attachReplayInput touches.
function emitter() {
  const map = new Map();
  return {
    addEventListener(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn);
    },
    dispatch(type, e) {
      for (const fn of [...(map.get(type) || [])]) fn(e);
    },
    count(type) {
      return map.get(type)?.size || 0;
    },
  };
}

// fakeEl — a one-node focusable stand-in: the fields isTyping/isControl
// read, plus a single-node closest() answering the selectors input.js
// asks for.
function fakeEl(tagName, opts = {}) {
  const el = {
    tagName,
    type: opts.type,
    role: opts.role || null,
    isContentEditable: !!opts.contentEditable,
    getAttribute(n) {
      return n === 'role' ? el.role : null;
    },
    closest(sel) {
      for (const raw of String(sel).split(',')) {
        const s = raw.trim();
        if (s === 'button' && tagName === 'BUTTON') return el;
        if (s === 'a' && tagName === 'A') return el;
        if (s === '[role=button]' && el.role === 'button') return el;
      }
      return null;
    },
  };
  return el;
}

// key — a KeyboardEvent-ish record. preventDefault flips defaultPrevented
// exactly like the browser, so a handler that calls it can be observed.
function key(k, opts = {}) {
  const e = Object.assign(
    {
      key: k,
      repeat: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      target: fakeEl('BODY'),
    },
    opts,
  );
  e.preventDefault = () => {
    e.defaultPrevented = true;
  };
  return e;
}

// fakeEngine — records every call; setFollow mirrors the real engine's
// emit-on-change contract so the F-resume mirror can be driven.
function fakeEngine() {
  const subs = new Set();
  const calls = [];
  const state = { followSlot: null, tick: 4242, playing: false };
  const eng = {
    state,
    calls,
    toggle: () => calls.push('toggle'),
    stepSpeed: (d) => calls.push(`stepSpeed:${d}`),
    step: (d) => calls.push(`step:${d}`),
    toggleLoop: () => calls.push('toggleLoop'),
    setFollow: (s) => {
      state.followSlot = s == null ? null : s;
      calls.push(`setFollow:${s}`);
      eng.emit();
    },
    onChange: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    emit(patch) {
      if (patch) Object.assign(state, patch);
      for (const fn of [...subs]) fn(state);
    },
    subCount: () => subs.size,
  };
  return eng;
}

// A canvas serving BOTH roles: the input module's listener surface and
// the renderer's drawing surface (getContext hands out one no-op 2D
// context — the wheel tests never assert paint ops).
const ctxProxy = new Proxy(
  {},
  {
    get(t, p) {
      if (typeof p !== 'string') return undefined;
      if (p === 'measureText') return () => ({ width: 40 });
      if (!(p in t)) t[p] = () => undefined;
      return t[p];
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  },
);

function fakeCanvas() {
  return Object.assign(emitter(), {
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600 };
    },
    getContext: () => ctxProxy,
  });
}

function harness(opts = {}) {
  const win = emitter();
  win.devicePixelRatio = 1; // renderer.resize reads it off the window
  globalThis.window = win;
  const canvas = fakeCanvas();
  const engine = fakeEngine();
  const h = {
    win,
    canvas,
    engine,
    rounds: [],
    skips: [],
    renderer: { draw() {}, panBy() {}, zoomAt() {} },
    press(k, o) {
      win.dispatch('keydown', key(k, o));
    },
    attach(extra = {}) {
      return attachReplayInput({
        canvas,
        engine,
        renderer: h.renderer,
        matchId: 'm1',
        slotCount: opts.slotCount ?? 10,
        onRound: (d) => h.rounds.push(d),
        onSkipFreeze: () => h.skips.push(1),
        ...extra,
      });
    },
  };
  return h;
}

// --- guards -----------------------------------------------------------------

test('modifier guard: ctrl/meta/alt chords never reach the transport', () => {
  const h = harness();
  h.attach();
  h.press(' ', { ctrlKey: true });
  h.press('f', { metaKey: true });
  h.press('l', { altKey: true });
  h.press('3', { ctrlKey: true });
  h.press('[', { altKey: true });
  assert.deepEqual(h.engine.calls, []);
  assert.deepEqual(h.rounds, []);
  // Shift is NOT a modifier here (Shift+←/→ is a binding).
  h.press('ArrowLeft', { shiftKey: true });
  assert.deepEqual(h.engine.calls, ['step:-64']);
});

test('isActive gate: inert while collapsed to the mini dock, live again on expand', () => {
  // The keep-alive hands attachReplayInput a getter over Replay's active
  // prop: while the instance sits in the mini-player dock its window keys
  // and canvas pointer/wheel must do NOTHING over the match view — and
  // everything must come back WITHOUT a re-attach (the instance survives
  // the dock round trip).
  const h = harness();
  let on = false;
  const det = h.attach({ isActive: () => on });

  // Inactive: keys never reach the engine or the view callbacks.
  h.press(' ');
  h.press('l');
  h.press('3');
  h.press('[');
  h.press('ArrowLeft');
  h.press('s');
  assert.deepEqual(h.engine.calls, []);
  assert.deepEqual(h.rounds, []);
  assert.deepEqual(h.skips, []);

  // Inactive: the pointer never starts a pan (renderer untouched) and
  // the wheel does not preventDefault (wheeling over the dock scrolls
  // whatever is behind it).
  const pans = [];
  h.renderer.panBy = (...a) => pans.push(a);
  h.canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  h.canvas.dispatch('pointermove', { pointerId: 1, clientX: 40, clientY: 0 });
  assert.deepEqual(pans, []);
  let prevented = false;
  h.canvas.dispatch('wheel', {
    deltaY: -100,
    clientX: 10,
    clientY: 10,
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, false);

  // Reactive gate (no re-attach): flipping active restores every path.
  on = true;
  h.press(' ');
  h.press('[');
  assert.deepEqual(h.engine.calls, ['toggle']);
  assert.deepEqual(h.rounds, [-1]);
  h.engine.state.followSlot = 5; // following: a drag must release it again
  h.canvas.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  assert.ok(h.engine.calls.includes('setFollow:null'), 'pan release fires while active');
  h.canvas.dispatch('pointermove', { pointerId: 2, clientX: 40, clientY: 0 });
  assert.deepEqual(pans, [[40, 0]]);
  h.canvas.dispatch('wheel', {
    deltaY: -100,
    clientX: 10,
    clientY: 10,
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, true, 'wheel preventDefault returns while active');
  det.detach();
});

test('defaultPrevented: a component that already handled the key wins', () => {
  const h = harness();
  h.attach();
  // A focused LandmarkRow role=button preventDefaults its own Space —
  // the replay hotkey must not fire a second time behind it.
  h.press(' ', { defaultPrevented: true });
  h.press('f', { defaultPrevented: true });
  h.press('[', { defaultPrevented: true });
  assert.deepEqual(h.engine.calls, []);
  assert.deepEqual(h.rounds, []);
  // An un-handled Space still acts.
  h.press(' ');
  assert.deepEqual(h.engine.calls, ['toggle']);
});

test('auto-repeat: a held toggle strobes never; arrows/speed keep repeating', () => {
  const h = harness();
  h.attach();
  h.press(' ', { repeat: true });
  h.press('s', { repeat: true });
  h.press('l', { repeat: true });
  h.press('f', { repeat: true });
  h.press('x', { repeat: true });
  h.press('[', { repeat: true });
  assert.deepEqual(h.engine.calls, [], 'no held key toggles anything');
  assert.deepEqual(h.rounds, []);
  assert.deepEqual(h.skips, []);
  // The repeatable set: frame stepping and the speed ladder.
  h.press('ArrowRight', { repeat: true });
  h.press('ArrowLeft', { repeat: true });
  h.press('.', { repeat: true });
  h.press(',', { repeat: true });
  assert.deepEqual(h.engine.calls, ['step:1', 'step:-1', 'stepSpeed:1', 'stepSpeed:-1']);
});

test('a focused slider owns only the arrows; Space/letters/digits still act', () => {
  const h = harness();
  h.attach();
  const slider = fakeEl('INPUT', { type: 'range' }); // the scrubber / a volume fader
  h.press('ArrowLeft', { target: slider });
  h.press('ArrowRight', { target: slider, shiftKey: true });
  assert.deepEqual(h.engine.calls, [], 'arrows stay native on a range input');
  // …everything else still drives the transport ("click the timeline,
  // Space is dead" was exactly this rule gone wrong).
  h.press(' ', { target: slider });
  h.press('.', { target: slider });
  h.press('1', { target: slider });
  assert.deepEqual(h.engine.calls, ['toggle', 'stepSpeed:1', 'setFollow:0']);
});

test('a text entry suppresses EVERY key (Space, letters, digits, arrows)', () => {
  const h = harness();
  h.attach();
  const field = fakeEl('INPUT'); // text field — type defaults to text
  const number = fakeEl('INPUT', { type: 'number' });
  const ta = fakeEl('TEXTAREA');
  const sel = fakeEl('SELECT');
  const ce = fakeEl('DIV', { contentEditable: true });
  for (const target of [field, number, ta, sel, ce]) {
    h.press(' ', { target });
    h.press('f', { target });
    h.press('1', { target });
    h.press('ArrowLeft', { target });
    h.press('[', { target });
  }
  assert.deepEqual(h.engine.calls, []);
  assert.deepEqual(h.rounds, []);
});

// --- slot digits ------------------------------------------------------------

test('digits 1-9 and 0 select slots (0 = slot 10 only in a 10-slot match)', () => {
  const h = harness({ slotCount: 10 });
  h.attach();
  h.press('1');
  h.press('9');
  h.press('0');
  assert.deepEqual(h.engine.calls, ['setFollow:0', 'setFollow:8', 'setFollow:9']);
  // Out-of-range digits select nothing.
  const h9 = harness({ slotCount: 9 });
  h9.attach();
  h9.press('0');
  h9.press('5');
  assert.deepEqual(h9.engine.calls, ['setFollow:4'], '0 is inert without a tenth slot');
});

// --- F resume ---------------------------------------------------------------

test('F resumes the player the engine last reported following (onChange mirror)', () => {
  const h = harness();
  h.attach();
  assert.equal(h.engine.subCount(), 1, 'attach subscribes to engine.onChange');
  h.press('3'); // pick via the keys
  // The VIEW follows another player (dropdown / 1-9 on its side): the
  // mirror must track the engine, not the key that was last pressed.
  h.engine.state.followSlot = 7;
  h.engine.emit();
  // Released to Free/Smart — the mirror keeps the resume target.
  h.engine.state.followSlot = null;
  h.engine.emit();
  h.press('f');
  assert.deepEqual(h.engine.calls, ['setFollow:2', 'setFollow:7']);
  // F again releases, a third F resumes slot 7 once more.
  h.press('f');
  h.press('f');
  assert.deepEqual(
    h.engine.calls.slice(-2),
    ['setFollow:null', 'setFollow:7'],
    'F toggles between release and the mirrored resume target',
  );
});

test('detach removes the keydown listener and the onChange mirror', () => {
  const h = harness();
  const input = h.attach();
  assert.equal(h.win.count('keydown'), 1);
  assert.equal(h.canvas.count('wheel'), 1);
  assert.equal(h.engine.subCount(), 1);
  input.detach();
  assert.equal(h.win.count('keydown'), 0, 'the key listener is gone');
  assert.equal(h.canvas.count('wheel'), 0, 'the wheel listener is gone');
  assert.equal(h.engine.subCount(), 0, 'the mirror unsubscribed');
  h.press(' ');
  h.press('3');
  h.press('[');
  assert.deepEqual(h.engine.calls, []);
  assert.deepEqual(h.rounds, []);
});

// --- the two new bindings ---------------------------------------------------

test('[ / ] call onRound(−1/1) and X calls the view-owned skip callback', () => {
  const h = harness();
  h.attach();
  h.press('[');
  h.press(']');
  h.press('x');
  h.press('X');
  assert.deepEqual(h.rounds, [-1, 1], 'round direction reaches the view');
  assert.deepEqual(h.skips, [1, 1], 'skip-freeze fires the CALLBACK');
  // The callback is the VIEW's (it owns the `skip_freeze` pref): the
  // engine itself must never be driven from the key.
  assert.deepEqual(h.engine.calls, []);
  // Without the callbacks wired the keys are inert, not a crash.
  const bare = harness();
  bare.attach({ onRound: undefined, onSkipFreeze: undefined });
  bare.press('[');
  bare.press('X');
  assert.deepEqual(bare.engine.calls, []);
});

test('Space still preventDefaults when it acts — and never on a focused control', () => {
  const h = harness();
  h.attach();
  const body = fakeEl('BODY');
  const acting = key(' ', { target: body });
  h.win.dispatch('keydown', acting);
  assert.equal(acting.defaultPrevented, true, 'an acting Space is consumed');
  assert.deepEqual(h.engine.calls, ['toggle']);
  // A focused BUTTON / A / role=button: native activation wins (the
  // toolbar blur-on-pointerup keeps a mouse click from hijacking Space).
  for (const target of [
    fakeEl('BUTTON'),
    fakeEl('A'),
    fakeEl('DIV', { role: 'button' }),
  ]) {
    const e = key(' ', { target });
    h.win.dispatch('keydown', e);
    assert.equal(e.defaultPrevented, false, 'the control keeps its own Space');
    assert.equal(h.engine.calls.length, 1, 'no replay toggle behind it');
  }
});

// --- wheel zoom (real renderer) --------------------------------------------

// store — one alive slot (mask bit 0) standing at (100, 200), built
// through the engine's OWN parser so the shape is the sidecar's.
function store(frames = 8) {
  const buf = new ArrayBuffer(frames * 14); // 6-byte header + 8-byte payload
  const dv = new DataView(buf);
  for (let i = 0; i < frames; i++) {
    const o = i * 14;
    dv.setInt32(o, i * 64, true); // tick
    dv.setUint16(o + 4, 1, true); // slot 0 alive
    dv.setInt16(o + 6, 100, true); // x
    dv.setInt16(o + 8, 200, true); // y
    dv.setInt16(o + 10, 0, true); // z
    dv.setUint8(o + 12, 0); // yaw
    dv.setUint8(o + 13, 8); // flags: side ct
  }
  return parsePositions(buf, 1);
}

// wheelHarness — a REAL renderer over the fake canvas, plus input.js
// attached on top (the wheel path as the app runs it).
function wheelHarness() {
  const h = harness();
  const data = store();
  const players = [{ steamId: '1', name: 'alice', side: 'ct' }];
  const engine = createEngine(data, 64);
  const takeovers = [];
  const renderer = createRenderer(h.canvas, {
    engine,
    data,
    players,
    onUserCamera: () => takeovers.push(1),
  });
  h.engine = engine;
  h.renderer = renderer;
  h.takeovers = takeovers;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  renderer.resize(); // sets cssW/cssH (800×600 at dpr 1) and draws once
  h.attach({ canvas: h.canvas, engine, renderer });
  h.wheel = (deltaY, sx = 400, sy = 300) =>
    h.canvas.dispatch('wheel', { deltaY, clientX: sx, clientY: sy, preventDefault() {} });
  return h;
}

test('wheel zoom while FOLLOWING keeps follow and scales around the player', () => {
  const h = wheelHarness();
  const cam = h.renderer.getCam();
  h.engine.setFollow(0);
  h.renderer.setCameraMode('smart'); // the view's follow wiring (follow rides smart)
  h.renderer.draw(); // centers the camera on the followed player
  const cx0 = cam.cx;
  const cy0 = cam.cy;
  const z0 = cam.zoom;
  h.wheel(-100); // wheel in
  assert.equal(h.engine.state.followSlot, 0, 'the wheel never releases follow');
  assert.deepEqual(h.takeovers, [], 'onUserCamera never fires → no Free takeover');
  assert.ok(cam.zoom > z0, 'the zoom changed the scale');
  assert.equal(cam.cx, cx0, 'the view stays centered on the followed player');
  assert.equal(cam.cy, cy0, 'the anchor is the PLAYER, never the cursor');
  const zIn = cam.zoom;
  h.wheel(100); // wheel out keeps the same contract
  assert.ok(cam.zoom < zIn, 'and it zooms back out');
  assert.equal(cam.cx, cx0);
  assert.equal(h.engine.state.followSlot, 0);
});

test('wheel zoom in FREE mode keeps its cursor anchor (unchanged behavior)', () => {
  const h = wheelHarness();
  const cam = h.renderer.getCam();
  const sx = 400;
  const sy = 300;
  const imgPt = () => {
    const s = cam.fit * cam.zoom;
    // cssW/cssH = the canvas client size at dpr 1 (the harness's 800×600)
    return [cam.cx + (sx - 400) / s, cam.cy + (sy - 300) / s];
  };
  const [ix0, iy0] = imgPt();
  const z0 = cam.zoom;
  h.wheel(-100, sx, sy);
  const [ix1, iy1] = imgPt();
  assert.ok(cam.zoom > z0, 'the zoom changed the scale');
  assert.ok(Math.abs(ix1 - ix0) < 1e-9, 'the image point under the cursor is pinned (x)');
  assert.ok(Math.abs(iy1 - iy0) < 1e-9, 'the image point under the cursor is pinned (y)');
});

test('wheel zoom on a non-following SMART camera still takes over to Free', () => {
  const h = wheelHarness();
  h.renderer.setCameraMode('smart');
  h.wheel(-100);
  assert.deepEqual(h.takeovers, [1], 'the manual-zoom takeover is unchanged');
});
