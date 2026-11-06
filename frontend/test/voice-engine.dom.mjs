// jsdom driver for the M4 voice ENGINE (replay/audio.js) — pins the
// behaviors the replay UI builds on:
//   • default-on enable (line 11): setEnabled(true) at load with
//     autoplay blocked parks a ONE-TIME document gesture listener,
//     reports state.pending (no error), and the first gesture resumes
//     the context and removes the listener; destroy() cleans up,
//   • a gesture that fails to start the device surfaces the
//     GStreamer hint through onError/state,
//   • mute-all (line 18) overrides solo: while mutedAll, NO player
//     schedules new windows (soloed or not); un-muting restores each
//     player's own mute/solo state,
//   • the scheduling contract: every window is fetched for audible
//     players only, and sources start at playbackRate 1 over buffers
//     pre-stretched by stretchPCM for the epoch's speed.
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
// parks it in 'blocked' (pending promise) or 'broken' (stays suspended).
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
    if (resumeMode === 'broken') return Promise.resolve(); // stays suspended
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

test('default-on: blocked autoplay parks a one-time gesture listener, no error', async () => {
  resumeMode = 'blocked';
  const engine = makeEngine();
  const { ve, errors } = makeVoice(engine);
  await ve.setEnabled(true);

  assert.equal(ve.state.pending, true, 'pending is surfaced for the UI hint');
  assert.equal(ve.state.enabled, false);
  assert.equal(ve.state.error, '', 'nothing has failed yet');
  assert.equal(errors.length, 0);

  // Nothing is scheduled while pending.
  engine.state.playing = true;
  engine.state.tick = 640;
  engine.emit();
  await flush();

  // The first gesture resumes and removes BOTH listeners.
  resumeMode = 'running';
  document.dispatchEvent(new window.Event('pointerdown'));
  await flush();
  assert.equal(ve.state.enabled, true);
  assert.equal(ve.state.pending, false);
  assert.equal(ve.state.error, '');

  // One-time: a second gesture must not throw or re-park.
  document.dispatchEvent(new window.Event('keydown'));
  await flush();
  assert.equal(ve.state.enabled, true);
  assert.equal(ve.state.pending, false);

  ve.destroy();
});

test('destroy() removes the parked gesture listeners (no leaks)', async () => {
  resumeMode = 'blocked';
  const engine = makeEngine();
  const { ve } = makeVoice(engine);
  await ve.setEnabled(true);
  assert.equal(ve.state.pending, true);
  ve.destroy();
  assert.equal(ve.state.pending, false);

  // A gesture after destroy must be a no-op (listener gone, no throw).
  resumeMode = 'running';
  document.dispatchEvent(new window.Event('pointerdown'));
  await flush();
  assert.equal(ve.state.enabled, false);
});

test('a gesture that fails to start the device surfaces the GStreamer hint', async () => {
  resumeMode = 'blocked';
  const engine = makeEngine();
  const { ve, errors } = makeVoice(engine);
  await ve.setEnabled(true);
  assert.equal(ve.state.pending, true);

  resumeMode = 'broken'; // a real gesture, but the device never starts
  document.dispatchEvent(new window.Event('pointerdown'));
  await flush();
  assert.equal(ve.state.pending, false);
  assert.equal(ve.state.enabled, false);
  assert.match(ve.state.error, /gst-plugins-good|GStreamer/);
  assert.equal(errors.length, 1);
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
