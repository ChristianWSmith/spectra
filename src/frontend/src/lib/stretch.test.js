// Tests for lib/replay/stretch.js — the pitch-preserving time-stretch
// behind voice playback at non-1× speeds (audio.js pre-stretches each
// window to 1/speed and plays it at playbackRate = 1).
// Run: node --test src/lib/stretch.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stretchPCM,
  STRETCH_MIN_RATIO,
  STRETCH_MAX_RATIO,
} from './replay/stretch.js';

const SR = 16000; // sidecar PCM rate

function sine(freq, seconds, amp = 0.9) {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

// dominantFreq is a plain DFT magnitude scan (Goertzel-style over an
// integer-Hz grid) — enough to pin the carrier of a sine.
function dominantFreq(samples, start, len) {
  let best = 0;
  let bestHz = 0;
  for (let hz = 200; hz <= 900; hz++) {
    const w = (2 * Math.PI * hz) / SR;
    let re = 0;
    let im = 0;
    for (let i = 0; i < len; i++) {
      const v = samples[start + i];
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    const mag = re * re + im * im;
    if (mag > best) {
      best = mag;
      bestHz = hz;
    }
  }
  return bestHz;
}

// The whole replay SPEEDS ladder as stretch ratios (= 1/speed).
const SPEED_RATIOS = [0.125, 0.25, 0.5, 1, 2, 4, 8];

test('length ratio: output is round(n·ratio) for every SPEEDS ratio', () => {
  const n = 16000; // 1 s window
  for (const ratio of SPEED_RATIOS) {
    const out = stretchPCM(sine(440, 1), SR, ratio);
    assert.equal(out.length, Math.round(n * ratio), `ratio ${ratio}`);
    assert.ok(Math.abs(out.length / n - ratio) < 1e-9, `ratio ${ratio} duration`);
  }
});

test('ratio 1 returns an exact copy (no stretch work at speed 1)', () => {
  const input = sine(440, 0.1);
  const out = stretchPCM(input, SR, 1);
  assert.equal(out.length, input.length);
  for (let i = 0; i < input.length; i++) assert.equal(out[i], input[i]);
  // Non-finite input is sanitized on every path.
  const dirty = new Float32Array([0.5, NaN, Infinity, -Infinity]);
  const clean = stretchPCM(dirty, SR, 1);
  assert.deepEqual([...clean], [0.5, 0, 0, 0]);
});

test('pitch preservation: a 440 Hz sine stays 440 Hz after stretching', () => {
  // The failure mode without correction (playbackRate) is an octave off
  // (220/880 Hz) — far outside every tolerance used here. Tolerances
  // widen as the output shrinks (DFT resolution = SR / segment).
  for (const ratio of [0.125, 0.25, 0.5, 2, 4, 8]) {
    const out = stretchPCM(sine(440, 0.5), SR, ratio);
    const start = Math.floor(out.length * 0.25);
    const len = Math.min(4096, out.length - start);
    assert.ok(len > 100, `ratio ${ratio}: output too short to analyze`);
    const hz = dominantFreq(out, start, len);
    const tol = Math.max(8, Math.ceil((2 * SR) / len));
    assert.ok(
      Math.abs(hz - 440) <= tol,
      `ratio ${ratio}: dominant ${hz} Hz, expected 440 ± ${tol}`,
    );
  }
});

test('no NaN and no clipping: output stays finite and within the input bound', () => {
  for (const ratio of [0.25, 2, 4, 8]) {
    const input = sine(440, 0.5, 0.95);
    const out = stretchPCM(input, SR, ratio);
    let maxAbs = 0;
    for (const v of out) {
      assert.ok(Number.isFinite(v), `ratio ${ratio}: non-finite sample`);
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    // Every output sample is a convex combination of input samples.
    assert.ok(maxAbs <= 0.95 + 1e-3, `ratio ${ratio}: clipped to ${maxAbs}`);
  }
  // Dirty input cannot propagate NaN/Infinity through the stretch.
  const dirty = new Float32Array(4000);
  for (let i = 0; i < dirty.length; i++) dirty[i] = i % 7 === 0 ? NaN : 0.4;
  for (const v of stretchPCM(dirty, SR, 2)) assert.ok(Number.isFinite(v));
});

test('silence stays silent at every ratio', () => {
  for (const ratio of SPEED_RATIOS) {
    const out = stretchPCM(new Float32Array(16000), SR, ratio);
    assert.equal(out.length, Math.round(16000 * ratio), `ratio ${ratio}`);
    for (const v of out) assert.equal(v, 0, `ratio ${ratio}: silent input must stay 0`);
  }
});

test('a constant signal stays constant (edge sample 0 excepted)', () => {
  const out = stretchPCM(new Float32Array(16000).fill(0.5), SR, 4);
  // Sample 0 sits under the very start of the first Hann window (weight
  // 0 → documented zero); everything else is the weight-normalized mean.
  assert.equal(out[0], 0);
  for (let i = 1; i < out.length; i++) {
    assert.ok(Math.abs(out[i] - 0.5) < 1e-6, `sample ${i} = ${out[i]}`);
  }
});

test('edge ratios 0.25 and 8 (SPEEDS 4× and 0.125×) are stable', () => {
  const n = 8000;
  for (const ratio of [0.25, 8]) {
    const out = stretchPCM(sine(440, 0.5), SR, ratio);
    assert.equal(out.length, Math.round(n * ratio), `ratio ${ratio}`);
    let energy = 0;
    for (const v of out) {
      assert.ok(Number.isFinite(v), `ratio ${ratio}`);
      energy += v * v;
    }
    assert.ok(energy > 0, `ratio ${ratio}: output must not be empty`);
    const start = Math.floor(out.length * 0.25);
    const len = Math.min(4096, out.length - start);
    const hz = dominantFreq(out, start, len);
    const tol = Math.max(8, Math.ceil((2 * SR) / len));
    assert.ok(Math.abs(hz - 440) <= tol, `ratio ${ratio}: ${hz} Hz, expected 440 ± ${tol}`);
  }
});

test('short input (shorter than one frame) still works', () => {
  const input = new Float32Array(100).fill(0.3);
  for (const ratio of [0.125, 4, 8]) {
    const out = stretchPCM(input, SR, ratio);
    assert.equal(out.length, Math.max(1, Math.round(100 * ratio)));
    for (const v of out) assert.ok(Number.isFinite(v));
  }
});

test('empty input returns empty output; bad ratio throws RangeError', () => {
  assert.equal(stretchPCM(new Float32Array(0), SR, 2).length, 0);
  assert.equal(stretchPCM(null, SR, 2).length, 0);
  for (const bad of [0, -1, NaN, Infinity, 'x']) {
    assert.throws(() => stretchPCM(sine(440, 0.1), SR, bad), RangeError, String(bad));
  }
});

test('extreme ratios clamp to the documented [1/8, 8] range', () => {
  const n = 16000;
  assert.equal(stretchPCM(sine(440, 1), SR, 100).length, Math.round(n * STRETCH_MAX_RATIO));
  assert.equal(stretchPCM(sine(440, 1), SR, 0.0001).length, Math.round(n * STRETCH_MIN_RATIO));
});

test('invalid sampleRate falls back to 16000', () => {
  const input = sine(440, 0.25);
  for (const sr of [0, -1, NaN, undefined]) {
    const out = stretchPCM(input, sr, 2);
    assert.equal(out.length, input.length * 2);
  }
});
