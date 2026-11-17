// jsdom driver for the replay SOUND-EFFECT ENGINE (replay/sfx.js) —
// pins the audio-liveness contract the FIRST replay load depends on:
//   • a context born SUSPENDED (the first load's normal case: the
//     AudioContext is created outside any user gesture) starts SILENTLY
//     on the first document interaction — no pending field, no error,
//     no hint,
//   • destroy() removes every retry listener (no leaks),
//   • a resume() that REJECTS is a device failure: exactly ONE
//     GStreamer-hint report, and the retry never re-arms after it,
//   • cues NEVER spawn while the context is suspended (every play path
//     gates on running) — silence, never a queued backlog,
//   • the bounded gesture-free backoff (audioresume.js): with NO
//     document event at all, the timer ladder alone brings a suspended
//     context to running — the first-AudioContext device-init race
//     recovers with no user action.
//
// jsdom is a declared devDependency; from frontend/ run:
//   node --test test/sfx-engine.dom.mjs
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

// Scripted AudioContext (the voice harness's modes): resume() flips to
// 'running' unless the test parks it in 'blocked' (pending promise —
// autoplay policy) or 'broken' (REJECTS — a dead audio device). Every
// resume() call is COUNTED — the backoff's observable when no document
// event ever fires.
let resumeMode = 'running';
class FakeAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = {};
    this.sources = [];
    this.resumes = 0;
    FakeAudioContext.last = this;
  }
  resume() {
    this.resumes++;
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
  createBufferSource() {
    const ctx = this;
    const src = {
      buffer: null,
      onended: null,
      started: null,
      connect() {},
      disconnect() {},
      start(when) {
        src.started = when === undefined ? ctx.currentTime : when;
      },
      stop() {},
    };
    this.sources.push(src);
    return src;
  }
  decodeAudioData(raw) {
    return Promise.resolve({ url: raw && raw.url });
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}
window.AudioContext = FakeAudioContext;

// The manifest is a SINGLE cue-able group (the C4 beep — the same
// scheduler path src/lib/sfx.test.js drives); the sound URLs resolve
// through the fetch stub below so state.ready is reachable.
const MANIFEST = { sounds: { 'C4 beep A': ['/api/sounds/c4_beep2.wav'] } };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('manifest.json')) return { ok: true, json: async () => MANIFEST };
  return { ok: true, arrayBuffer: async () => ({ url: u }) };
};

const { createSfxEngine, resetSoundManifest } = await import('../src/lib/replay/sfx.js');
resetSoundManifest();

const flush = () => new Promise((r) => setTimeout(r, 10));
// Drain promise callbacks WITHOUT touching a mocked clock (setImmediate
// is deliberately not in the mock-timer api list).
const drain = () => new Promise((r) => setImmediate(r));

// A replay-engine stub: a registered onChange handler the test fires
// with a scripted transport state.
function fakeEngine() {
  let cb = null;
  return {
    tickRate: 64,
    onChange(fn) {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    emit(st) {
      if (cb) cb(st);
    },
  };
}

// makeSfx — one engine with its preload drained (state.ready) and the
// fake AudioContext it was built on. Uses setImmediate so it works both
// with real timers and under the mocked clock (section E).
async function makeSfx() {
  const engine = fakeEngine();
  const errors = [];
  const sfx = createSfxEngine({ engine, matchId: 1, onError: (m) => errors.push(m) });
  for (let i = 0; i < 500 && !sfx.state.ready; i++) await drain();
  assert.ok(sfx.state.ready, JSON.stringify(sfx.state));
  assert.equal(errors.length, 0, errors.join('; '));
  return { sfx, engine, errors, ctx: FakeAudioContext.last };
}

// The fixture bomb (the C4 beep scheduler's inputs): planted at tick
// 1000, detonating 41 s later — the same rows src/lib/sfx.test.js uses.
const C4_TR = 64;
const C4_PLANT = 1000;
const C4_EXPLODE = C4_PLANT + 41 * C4_TR;
const c4Rows = (site) => [
  { kind: 'bomb_plant', bucket: 'plant', tick: C4_PLANT, round: 5, site },
  { kind: 'bomb_explode', bucket: 'explode', tick: C4_EXPLODE, round: 5, weapon: 'C4' },
];

test('a suspended-at-construction context starts SILENTLY on the first interaction', async () => {
  resumeMode = 'blocked';
  const { sfx, engine, errors, ctx } = await makeSfx();
  assert.equal(ctx.state, 'suspended', 'a blocked first attempt leaves the context suspended');

  // While suspended: playing emits spawn nothing and report nothing —
  // the play paths all gate on running.
  sfx.setLandmarks(c4Rows('A'));
  engine.emit({ playing: true, speed: 8, tick: C4_PLANT });
  assert.equal(ctx.sources.length, 0, 'no cue while suspended');
  assert.equal(errors.length, 0, 'mere suspension is never an error');

  // The FIRST document interaction starts it — silently.
  resumeMode = 'running';
  document.dispatchEvent(new window.Event('pointerdown'));
  await flush();
  assert.equal(ctx.state, 'running');
  assert.equal(errors.length, 0, 'the gesture path reports nothing');

  // …and cues flow from the next engine change on.
  engine.emit({ playing: true, speed: 8, tick: C4_PLANT + 64 });
  assert.ok(ctx.sources.length > 0, 'cues started by themselves after the gesture');
  sfx.destroy();
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
    const { sfx, ctx } = await makeSfx();
    assert.ok(live.size > 0, 'retry listeners are armed while suspended');
    sfx.destroy();
    assert.equal(live.size, 0, 'every retry listener removed on destroy');

    // A gesture after destroy is a no-op: no resume is attempted (the
    // listeners are gone), the closed context stays closed, nothing
    // throws and nothing resurrects.
    resumeMode = 'running';
    const resumesBefore = ctx.resumes;
    document.dispatchEvent(new window.Event('pointerdown'));
    await flush();
    assert.equal(ctx.resumes, resumesBefore, 'no resume attempt after destroy');
    assert.equal(ctx.state, 'closed');
  } finally {
    document.addEventListener = origAdd;
    document.removeEventListener = origRemove;
  }
});

test('a REJECTED resume reports the GStreamer hint exactly once and never re-arms', async () => {
  resumeMode = 'blocked';
  const { sfx, errors, ctx } = await makeSfx();
  assert.equal(errors.length, 0, 'blocked-but-working: nothing has failed yet');

  resumeMode = 'broken'; // a real interaction, but the device rejects resume()
  document.dispatchEvent(new window.Event('pointerdown'));
  await flush();
  assert.equal(errors.length, 1, 'the device failure is reported once');
  assert.match(sfx.state.error, /gst-plugins-good|GStreamer/);

  // The failure is terminal for this engine: another interaction must
  // neither re-report nor re-arm the retry (the listeners came down
  // with the failure).
  resumeMode = 'running';
  const resumesBefore = ctx.resumes;
  document.dispatchEvent(new window.Event('pointerdown'));
  await flush();
  assert.equal(errors.length, 1, 'no second report');
  assert.equal(ctx.resumes, resumesBefore, 'no re-arm — the listeners are gone');
  sfx.destroy();
});

test('cues NEVER spawn while the context is suspended (silence, never a backlog)', async () => {
  resumeMode = 'blocked';
  const { sfx, engine, errors, ctx } = await makeSfx();
  sfx.setLandmarks(c4Rows('A'));
  // Several playing changes across the fuse — every path (beeps, the
  // immediate-cue lists, the cue-window block) gates on running.
  for (const tick of [C4_PLANT, C4_PLANT + 64, C4_PLANT + 256, C4_EXPLODE - 64]) {
    engine.emit({ playing: true, speed: 8, tick });
    await flush();
  }
  assert.equal(ctx.sources.length, 0, 'no cue source while suspended');
  assert.equal(errors.length, 0, 'and no error — suspension is silence');
  sfx.destroy();
});

test('the bounded gesture-free backoff reaches running with NO DOM event at all', async (t) => {
  // The H4 fix, pinned mechanically: fake timers drive the whole ladder
  // — no pointerdown, no keydown, nothing a user could do.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resumeMode = 'blocked';
  const { sfx, engine, errors, ctx } = await makeSfx();
  assert.equal(ctx.state, 'suspended');
  assert.equal(ctx.resumes, 1, 'exactly the construction attempt so far');

  // The construction attempt's RESUME_MS race concludes (still
  // suspended — the policy is blocking), the backoff schedules its
  // first rung, and it fires — all with no document event.
  t.mock.timers.tick(750);
  await drain();
  t.mock.timers.tick(250);
  await drain();
  assert.ok(ctx.resumes > 1, 'the backoff retried with no DOM event');
  assert.equal(ctx.state, 'suspended', 'still blocked — and still silent');
  assert.equal(errors.length, 0, 'a blocked retry is never an error');

  // The device warms up (the first-context init race resolves): the
  // NEXT rung brings the context to running — still without a gesture.
  resumeMode = 'running';
  t.mock.timers.tick(500);
  await drain();
  assert.equal(ctx.state, 'running', 'running after timer retries alone');
  assert.equal(errors.length, 0);

  // …and cues play.
  sfx.setLandmarks(c4Rows('A'));
  engine.emit({ playing: true, speed: 8, tick: C4_PLANT });
  assert.ok(ctx.sources.length > 0, 'cues play with no interaction ever');
  sfx.destroy();
});
