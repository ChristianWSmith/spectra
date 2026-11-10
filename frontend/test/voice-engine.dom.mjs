// jsdom driver for the M4 voice ENGINE (replay/audio.js) — pins the
// behaviors the replay UI builds on:
//   • default-on enable (line 11): setEnabled(true) at load flips
//     `enabled` immediately (want-on) and, while autoplay keeps the
//     context suspended, arms SILENT document retry listeners — the
//     first interaction starts the engine with NO pending field and no
//     error; destroy() removes the listeners (no leaks),
//   • a resume() that REJECTS is a device failure and surfaces the
//     GStreamer hint through onError/state,
//   • mute-all (line 18) overrides solo: while mutedAll, NO player
//     schedules new windows (soloed or not); un-muting restores each
//     player's own mute/solo state,
//   • the scheduling contract: every window is fetched for audible
//     players only, and sources start at playbackRate 1 over buffers
//     pre-stretched by stretchPCM for the epoch's speed,
//   • the server-exact sparse-window map (voicewindows.js): windows the
//     map proves chunk-less are NEVER fetched, unknown players and
//     mismatched windowTicks fail OPEN to fetching, and a 0-sample
//     window starts no source at all (the Go route's empty-window shape).
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --test test/voice-engine.dom.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// services.js is the Wails glue (a bindings directory import plus
// browser globals at module load); the engine only needs errText.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('services.js')) {
      const stub =
        'data:text/javascript,' +
        encodeURIComponent(
          "export function errText(e) {\n" +
            "  if (e == null) return 'unknown error';\n" +
            "  if (typeof e === 'string') return e;\n" +
            '  return e.message || String(e);\n' +
            '}\n',
        );
      return { url: stub, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of ['window', 'document', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent']) {
  if (!(k in dom.window)) continue;
  try {
    globalThis[k] = dom.window[k];
  } catch {
    Object.defineProperty(globalThis, k, {
      value: dom.window[k],
      configurable: true,
      writable: true,
    });
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// Scripted AudioContext: resume() flips to 'running' unless the test
// parks it in 'blocked' (pending promise — autoplay policy) or
// 'broken' (REJECTS — a dead audio device).
let resumeMode = 'running';
class FakeAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = {};
  }
  resume() {
    if (resumeMode === 'running') {
      this.state = 'running';
      return Promise.resolve();
    }
    if (resumeMode === 'broken') return Promise.reject(new Error('audio device failed'));
    return new Promise(() => {}); // blocked: pending forever
  }
  createGain() {
    return { gain: { value: 0 }, connect() {} };
  }
  createBuffer(ch, len, rate) {
    return { duration: len / rate, copyToChannel() {} };
  }
  createBufferSource() {
    return { playbackRate: { value: 1 }, connect() {}, start() {}, stop() {} };
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}
window.AudioContext = FakeAudioContext;

const { createVoiceEngine } = await import('../src/lib/replay/audio.js');

const flush = () => new Promise((r) => setTimeout(r, 10));

// A replay-engine stub: a registered onChange handler the test fires
// with a scripted transport state.
function makeEngine() {
  const state = { playing: false, speed: 1, tick: 0, frame: 0 };
  let handler = null;
  return {
    tickRate: 64,
    state,
    onChange(fn) {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    emit() {
      if (handler) handler(state);
    },
  };
}

const PLAYERS = [
  { steamId: 'A', firstTick: 0, lastTick: 64000 },
  { steamId: 'B', firstTick: 0, lastTick: 64000 },
];

// A voice engine wired to a fetch recorder; window fetches are the
// observable of "this player is audible right now".
function makeVoice(engine) {
  const fetched = { A: 0, B: 0, other: 0 };
  const errors = [];
  const ve = createVoiceEngine({
    engine,
    matchId: 1,
    fetchPCM: async (steamId) => {
      if (steamId in fetched) fetched[steamId]++;
      else fetched.other++;
      // 1 s of sidecar PCM (16 kHz), whatever the window's tick span is.
      return { fromTick: 0, sampleRate: 16000, samples: new Int16Array(16000) };
    },
    onError: (e) => errors.push(e),
    onStateChange: () => {},
  });
  ve.setPlayers(PLAYERS);
  return { ve, fetched, errors };
}

test('default-on: a blocked resume starts the engine SILENTLY on the first interaction', async () => {
  resumeMode = 'blocked';
  const engine = makeEngine();
  const { ve, fetched, errors } = makeVoice(engine);
  await ve.setEnabled(true);

  // Want-on flips immediately: `enabled` is the USER's request, not the
  // context's state — and there is no pending field anymore (the
  // gesture UX is gone). Merely suspended is never an error.
  assert.ok(!('pending' in ve.state), 'state carries no pending flag');
  assert.equal(ve.state.enabled, true, 'enabled is want-on, not running-state');
  assert.equal(ve.state.ctxState, 'suspended');
  assert.equal(ve.state.error, '', 'autoplay-blocked is not a failure');
  assert.equal(errors.length, 0);

  // Nothing is scheduled while suspended (the ctx gate holds).
  engine.state.playing = true;
  engine.state.tick = 640;
  engine.emit();
  await flush();
  assert.equal(ve.state.ctxState, 'suspended');
  assert.equal(fetched.A + fetched.B, 0, 'no windows fetched while suspended');

  // The FIRST interaction starts it — silently: no error, no hint, no
  // state beyond the context itself flipping to running.
  resumeMode = 'running';
  document.dispatchEvent(new window.Event('pointerdown'));
  await flush();
  assert.equal(ve.state.ctxState, 'running');
  assert.equal(ve.state.enabled, true);
  assert.equal(ve.state.error, '');
  assert.equal(errors.length, 0);

  // …and voice actually flows from the next engine change on.
  engine.state.tick += 64;
  engine.emit();
  await flush();
  assert.ok(fetched.A > 0 && fetched.B > 0, 'voice started by itself');
  ve.destroy();
});

test('destroy() removes the retry listeners (no leaks)', async () => {
  resumeMode = 'blocked';
  // Count the capture listeners the engine registers so the leak check
  // is direct (not inferred from state the engine could simply stop
  // reporting).
  const live = new Set();
  const origAdd = document.addEventListener;
  const origRemove = document.removeEventListener;
  document.addEventListener = function (type, fn, opts) {
    if (type === 'pointerdown' || type === 'keydown') live.add(fn);
    return origAdd.call(this, type, fn, opts);
  };
  document.removeEventListener = function (type, fn, opts) {
    live.delete(fn);
    return origRemove.call(this, type, fn, opts);
  };
  try {
    const engine = makeEngine();
    const { ve } = makeVoice(engine);
    await ve.setEnabled(true);
    assert.ok(live.size > 0, 'retry listeners are armed while suspended');
    ve.destroy();
    assert.equal(live.size, 0, 'every retry listener removed on destroy');

    // A gesture after destroy must be a no-op (listener gone, no throw,
    // nothing resurrected).
    resumeMode = 'running';
    document.dispatchEvent(new window.Event('pointerdown'));
    await flush();
    assert.equal(ve.state.enabled, false);
    assert.equal(ve.state.ctxState, 'none');
  } finally {
    document.addEventListener = origAdd;
    document.removeEventListener = origRemove;
  }
});

test('a REJECTED resume surfaces the GStreamer hint (device failure still reported)', async () => {
  resumeMode = 'blocked';
  const engine = makeEngine();
  const { ve, errors } = makeVoice(engine);
  await ve.setEnabled(true);
  assert.equal(ve.state.error, '', 'blocked-but-working: nothing has failed yet');

  resumeMode = 'broken'; // a real interaction, but the device rejects resume()
  document.dispatchEvent(new window.Event('pointerdown'));
  await flush();
  assert.match(ve.state.error, /gst-plugins-good|GStreamer/);
  assert.equal(ve.state.enabled, false, 'a device failure disables voice');
  assert.equal(errors.length, 1);
  // The failure is terminal for THIS enable request: a stale attempt or
  // another interaction must not re-arm the retry listeners.
  resumeMode = 'running';
  document.dispatchEvent(new window.Event('pointerdown'));
  await flush();
  assert.equal(errors.length, 1, 'no second report, no silent resurrection');
  ve.destroy();
});

test('mute-all overrides solo; un-muting restores each player\u2019s state', async () => {
  resumeMode = 'running';
  const engine = makeEngine();
  const { ve, fetched } = makeVoice(engine);
  await ve.setEnabled(true);
  assert.equal(ve.state.enabled, true);

  engine.state.playing = true;
  engine.state.tick = 64;
  engine.emit(); // anchor + schedule: both players audible
  await flush();
  assert.ok(fetched.A > 0 && fetched.B > 0, 'baseline: both fetch');

  // Solo A → only A schedules new windows.
  ve.setSolo('A', true);
  engine.state.tick += 64;
  engine.emit();
  await flush();
  const afterSolo = { A: fetched.A, B: fetched.B };
  engine.state.tick += 64;
  engine.emit();
  await flush();
  assert.ok(fetched.A > afterSolo.A, 'soloed A keeps fetching');
  assert.equal(fetched.B, afterSolo.B, 'B is silent under solo');

  // Mute-all beats the solo: even A goes quiet.
  ve.setMutedAll(true);
  assert.equal(ve.state.mutedAll, true);
  engine.state.tick += 64;
  engine.emit();
  await flush();
  const afterAll = { A: fetched.A, B: fetched.B };
  engine.state.tick += 64;
  engine.emit();
  await flush();
  assert.equal(fetched.A, afterAll.A, 'mute-all silences even the soloed player');
  assert.equal(fetched.B, afterAll.B, 'mute-all silences everyone');

  // Un-mute restores each player's OWN state: solo A → A back, B still off.
  ve.setMutedAll(false);
  assert.equal(ve.state.mutedAll, false);
  engine.state.tick += 64;
  engine.emit();
  await flush();
  const afterUnmute = { A: fetched.A, B: fetched.B };
  engine.state.tick += 64;
  engine.emit();
  await flush();
  assert.ok(fetched.A > afterUnmute.A, 'solo restored for A');
  assert.equal(fetched.B, afterUnmute.B, 'B stays muted-by-solo');

  // Dropping the solo restores everyone; setMutedMany is a batch path.
  ve.setSolo('A', false);
  ve.setMutedMany(['A', 'B'], true);
  engine.state.tick += 64;
  engine.emit();
  await flush();
  const afterMany = { A: fetched.A, B: fetched.B };
  engine.state.tick += 64;
  engine.emit();
  await flush();
  assert.equal(fetched.A, afterMany.A, 'setMutedMany silences A');
  assert.equal(fetched.B, afterMany.B, 'setMutedMany silences B');
  ve.setMutedMany(['A', 'B'], false);
  engine.state.tick += 64;
  engine.emit();
  await flush();
  assert.ok(fetched.A > afterMany.A && fetched.B > afterMany.B, 'un-muting many restores both');
  ve.destroy();
});

test('sources play at playbackRate 1 over pre-stretched buffers at speed ≠ 1', async () => {
  resumeMode = 'running';
  const engine = makeEngine();
  const { ve } = makeVoice(engine);
  await ve.setEnabled(true);

  // Record what the engine hands to the audio graph.
  const started = [];
  const origCreate = FakeAudioContext.prototype.createBufferSource;
  FakeAudioContext.prototype.createBufferSource = function () {
    const src = origCreate.call(this);
    const origStart = src.start.bind(src);
    src.start = (when, offset) => started.push({ rate: src.playbackRate.value, buffer: src.buffer, when, offset });
    return src;
  };
  try {
    engine.state.playing = true;
    engine.state.speed = 2;
    engine.state.tick = 64;
    engine.emit(); // anchor at 2×
    await flush();
    engine.state.tick += 64;
    engine.emit();
    await flush();
  } finally {
    FakeAudioContext.prototype.createBufferSource = origCreate;
  }
  assert.ok(started.length > 0, 'windows were scheduled');
  for (const s of started) {
    assert.equal(s.rate, 1, 'playbackRate stays 1 — the buffer carries the speed');
    // A 1 s window at 2× must be 0.5 wall-seconds long.
    assert.ok(Math.abs(s.buffer.duration - 0.5) < 1e-6, `stretched duration ${s.buffer.duration}`);
    assert.ok(Number.isFinite(s.when) && s.when >= 0, 'anchor math produces a valid start time');
    assert.ok(s.offset >= 0, 'late-offset is non-negative');
  }
  ve.destroy();
});

test('server-exact window map: proven-silent windows are never fetched; unknowns fail open', async () => {
  resumeMode = 'running';
  const engine = makeEngine();
  const { ve, fetched } = makeVoice(engine);
  await ve.setEnabled(true);
  // Windows are 64 ticks (1 s @ 64 tick). Each emit resyncs (the fake
  // context's clock never advances), so every phase schedules from the
  // current tick: [512,640), then [640,704), then [768,896).

  // A speaks only in the first two windows; B has NO map row.
  ve.setWindows({ windowTicks: 64, players: [{ steamId: 'A', starts: [0, 64] }] });
  engine.state.playing = true;
  engine.state.tick = 512;
  engine.emit();
  await flush();
  assert.equal(fetched.A, 0, 'server-proven silent windows are not fetched at all');
  assert.equal(fetched.B, 2, 'a player absent from the map fail-opens to fetching');

  // A map that DOES mark speech in the next window fetches exactly that.
  ve.setWindows({ windowTicks: 64, players: [{ steamId: 'A', starts: [640] }] });
  engine.state.tick = 640;
  engine.emit();
  await flush();
  assert.equal(fetched.A, 1, 'the marked window is fetched, its silent sibling skipped');
  assert.equal(fetched.B, 4, 'the unknown player keeps fetching every window');

  // A map computed for ANOTHER window size is unusable (its starts are
  // not this engine's aligned windows): the engine discards it and
  // fail-opens — real speech must never be skipped on a mismatched map.
  ve.setWindows({ windowTicks: 128, players: [{ steamId: 'A', starts: [768] }] });
  engine.state.tick = 768;
  engine.emit();
  await flush();
  assert.equal(fetched.A, 3, 'windowTicks mismatch → fetch, never skip');
  assert.equal(fetched.B, 6, 'the unknown player is unaffected');
  ve.destroy();
});

test('an empty (0-sample) window builds no buffer and starts no source', async () => {
  resumeMode = 'running';
  const engine = makeEngine();
  const errors = [];
  // Record the audio graph: a 0-sample result must never reach
  // createBuffer/createBufferSource (the Go route's empty-window shape —
  // header only) and must never report an error.
  const buffers = [];
  const started = [];
  const origCreate = FakeAudioContext.prototype.createBuffer;
  const origSource = FakeAudioContext.prototype.createBufferSource;
  FakeAudioContext.prototype.createBuffer = function (ch, len, rate) {
    const buf = { duration: len / rate, copyToChannel() {} };
    buffers.push(buf);
    return buf;
  };
  FakeAudioContext.prototype.createBufferSource = function () {
    const src = origSource.call(this);
    const origStart = src.start.bind(src);
    src.start = (when, offset) => started.push({ when, offset });
    return src;
  };
  try {
    const ve = createVoiceEngine({
      engine,
      matchId: 1,
      fetchPCM: async () => ({ fromTick: 0, sampleRate: 16000, samples: new Int16Array(0) }),
      onError: (e) => errors.push(e),
      onStateChange: () => {},
    });
    ve.setPlayers(PLAYERS);
    await ve.setEnabled(true);
    engine.state.playing = true;
    engine.state.tick = 0;
    engine.emit();
    await flush();
    engine.state.tick += 64;
    engine.emit();
    await flush();
    assert.equal(buffers.length, 0, 'a 0-sample window never becomes an AudioBuffer');
    assert.equal(started.length, 0, 'and starts no AudioBufferSourceNode');
    assert.equal(errors.length, 0, 'silence is not an error');
    ve.destroy();
  } finally {
    FakeAudioContext.prototype.createBuffer = origCreate;
    FakeAudioContext.prototype.createBufferSource = origSource;
  }
});
