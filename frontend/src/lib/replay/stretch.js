// stretch.js — pitch-preserving time-stretch for replay voice playback.
//
// The Web Audio clock contract (replay/audio.js header) wants a block of
// N replay-seconds to occupy N/speed wall-seconds. An
// AudioBufferSourceNode's playbackRate does that arithmetically but
// drags pitch along with it (2× → an octave high, 0.25× → an octave
// low), and Web Audio exposes no pitch-preserve flag. So each fetched
// PCM window is pre-stretched HERE to 1/speed its original duration and
// played back at playbackRate = 1 — the same wall-clock scheduling math,
// at the original pitch.
//
// Algorithm: WSOLA (synchronized overlap-add), a granular OLA variant.
// Synthesis walks the output in hops of frame/2, summing each input
// frame through a Hann window; the analysis frame for hop k is taken
// from the nominal position (frame/2)/ratio·k, corrected by a ±frame/4
// normalized cross-correlation search (taps decimated 4×) against the
// OUTPUT-OVERLAP region of the previously chosen grain (its second half
// vs the candidate's first half) so consecutive grains stay
// phase-aligned. That alignment is what preserves pitch: grains are
// verbatim copies of the input (never resampled), and phase-continuous
// grains reassemble into the original frequency — unaligned OLA would
// smear it into sidebands, and resampling would shift it exactly like
// playbackRate.
//
// Two Hann windows at a 50% synthesis hop sum to exactly 1, so the
// output is the weight-normalized sum of the grains: every sample is a
// convex combination of input samples, which means (a) grain joins —
// including the partial first/last frame at each window edge — never
// dip in amplitude and (b) the result cannot clip (|out| ≤ max|in|) and
// cannot produce NaN (a zero-weight sample, only the single i=0 sample
// of the first Hann window, stays 0 — no division by zero).
//
// Accepted ratio range: [1/8, 8] — the whole replay SPEEDS ladder
// (speeds 0.25×–8× → ratios 4 … 0.125); ratios outside are clamped as
// a safety net (the engine only ever passes 1/speed for a SPEEDS
// value). Quality is best across 0.5–4 (speed 0.5×–4×); at the
// extremes WSOLA stays stable (correct length, finite, pitch intact)
// while speech gets granular — expected when 8×-fast-forwarding comms.
// Pure and synchronous: one 1 s @ 16 kHz window at ratio 4 is ~10 M
// multiply-adds worst case (tens of ms of main thread), and windows are
// fetched LOOKAHEAD seconds ahead of the clock, off the critical path.

// STRETCH_MIN_RATIO / STRETCH_MAX_RATIO bound the accepted ratio
// (output duration / input duration) — see the header comment.
export const STRETCH_MIN_RATIO = 1 / 8;
export const STRETCH_MAX_RATIO = 8;

const FRAME_SEC = 0.04; // 40 ms analysis/synthesis frame
const MIN_FRAME = 64; // never smaller (keeps hops/correlation sane)
const SEARCH_DIV = 4; // correlation search window = frame/4 per side
const CORR_STRIDE = 4; // correlation taps: every 4th sample (cost ÷4)

// stretchPCM returns a Float32Array of round(len·ratio) samples whose
// duration is ratio × the input's, at the input's pitch.
//   samples    mono, already-normalized float PCM (±1). Non-finite
//              values are treated as silence; Int16 input is NOT
//              normalized here (normalize before calling).
//   sampleRate picks the 40 ms frame size; non-positive/non-finite
//              falls back to 16000 (the sidecar PCM rate).
//   ratio      output/input duration (> 0, else RangeError), clamped to
//              [STRETCH_MIN_RATIO, STRETCH_MAX_RATIO].
// Empty input returns an empty buffer; ratio 1 returns an exact
// sanitized copy (the engine skips the call at speed 1 anyway).
export function stretchPCM(samples, sampleRate, ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new RangeError(`stretchPCM: ratio must be a finite number > 0 (got ${ratio})`);
  }
  const n = samples && Number.isFinite(samples.length) ? samples.length : 0;
  if (n === 0) return new Float32Array(0);
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16000;
  const r = Math.min(STRETCH_MAX_RATIO, Math.max(STRETCH_MIN_RATIO, ratio));
  const outLen = Math.max(1, Math.round(n * r));
  const input = sanitize(samples, n);
  if (r === 1) return input;

  let frame = Math.max(MIN_FRAME, Math.round(sr * FRAME_SEC));
  if (frame % 2) frame++; // even → frame/2 hop, the Hann sum-to-1 case
  // Short input (n < frame): pad so every read is in bounds; the output
  // length still derives from the ORIGINAL n.
  const src = input.length >= frame ? input : pad(input, frame);
  const srcMax = src.length - frame;
  const win = hann(frame);
  const hopSyn = frame >> 1;
  const hopAna = hopSyn / r; // fractional — rounded at each use
  const search = Math.max(1, Math.floor(frame / SEARCH_DIV));

  const out = new Float32Array(outLen + frame);
  const weight = new Float32Array(outLen + frame);
  let tOut = 0;
  let tIn = 0;
  let prev = null;
  while (tOut < outLen) {
    const nom = Math.min(srcMax, Math.max(0, Math.round(tIn)));
    const pos = pickFrame(src, frame, prev, nom, search);
    for (let i = 0; i < frame; i++) {
      const w = win[i];
      out[tOut + i] += w * src[pos + i];
      weight[tOut + i] += w;
    }
    prev = src.subarray(pos, pos + frame);
    tOut += hopSyn;
    tIn += hopAna;
  }

  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const w = weight[i];
    // Convex mean of the covering grains (w > 0 → the division cannot
    // amplify: out is w·x, so out/w is x, bounded by the inputs).
    res[i] = w > 0 ? out[i] / w : 0;
  }
  return res;
}

// pickFrame chooses the input offset for the next grain: the nominal
// hop position, nudged (±search) to whichever candidate correlates best
// with the previously synthesized grain — WSOLA's synchronization.
//
// The correlation compares the candidate's FIRST half against the
// previous grain's SECOND half: those are the two regions that overlap
// in the OUTPUT, so aligning them is exactly what keeps the output
// phase continuous. (Correlating whole frames head-to-head instead
// locks grains to the same input phase while the output clock advances,
// which measurably beats the carrier off-frequency — off by sr/(2π·Hs)
// × the phase step, ~10 Hz at 16 kHz / 320-sample hops.)
//
// Candidates are scanned outward from the nominal hop with a 1e-9
// score tie-band, so among (near-)equal alignments the one closest to
// the nominal hop wins — deterministic, and it keeps content timing on
// the nominal ramp for aperiodic (speech) material, where only the
// true-continuity candidate scores that high anyway.
function pickFrame(src, frame, prev, nom, search) {
  if (!prev) return nom; // first grain: no phase reference yet
  const hop = frame >> 1; // overlap = one synthesis hop
  let prevE = 0;
  for (let i = 0; i < hop; i += CORR_STRIDE) {
    const v = prev[hop + i];
    prevE += v * v;
  }
  if (!(prevE > 0)) return nom; // silent reference: no alignment info
  const max = src.length - frame;
  const lo = Math.max(0, nom - search);
  const hi = Math.min(max, nom + search);
  let best = -Infinity;
  let bestPos = nom;
  for (let d = 0; d <= search; d++) {
    const cands = d === 0 ? [nom] : [nom - d, nom + d];
    for (const p of cands) {
      if (p < lo || p > hi) continue;
      let c = 0;
      let e = 0;
      for (let i = 0; i < hop; i += CORR_STRIDE) {
        const v = src[p + i];
        const pv = prev[hop + i];
        c += pv * v;
        e += v * v;
      }
      const score = e > 0 ? c / Math.sqrt(e * prevE) : -Infinity;
      if (score > best + 1e-9) {
        best = score;
        bestPos = p;
      }
    }
  }
  return bestPos;
}

function sanitize(samples, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Number(samples[i]);
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

function pad(input, frame) {
  const out = new Float32Array(frame);
  out.set(input);
  return out;
}

// hann is the PERIODIC Hann window (denominator frame, not frame-1):
// only the periodic form satisfies w[i] + w[i + frame/2] = 1, which is
// what makes the interior weight sum exactly 1 at the 50% hop.
function hann(frame) {
  const w = new Float32Array(frame);
  for (let i = 0; i < frame; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  return w;
}
