// M2 replay engine: typed-array position store + rAF-driven clock.
//
// Data comes from the sidecar HTTP route as one binary stream, layout fixed
// by the Go writer (little-endian), per frame:
//   int32  tick
//   uint16 mask          (bit i = player slot i alive that frame)
//   then, for each set bit in slot order:
//     int16 x, int16 y, int16 z   (world units, 1.0 grid, Z-up)
//     uint8 yaw                   (decode: degrees = byte/256*360 - 180)
//     uint8 flags                 (bit0 = air, bit1 = duck,
//                                  bits2-3 = side: 0 unknown, 1 t, 2 ct)
// Slot order == meta.players[]. Everything is decoded once into flat typed
// arrays — no per-frame objects — so scrub/seek/lerp are O(1)/O(log n).

import { normTickRate } from '../fmt.js';
import { freezeWindowAt, seekTargetTick } from '../rounds.js';
// The additive frame-time probe (frameprobe.js — what it measures and
// how to dump it is documented at the top of that module). The cadence
// sample lives in loop(); playback semantics are untouched.
import { frameProbe } from './frameprobe.js';

// popcount for a 16-bit alive mask.
function popcount16(m) {
  m = m - ((m >> 1) & 0x5555);
  m = (m & 0x3333) + ((m >> 2) & 0x3333);
  m = (m + (m >> 4)) & 0x0f0f;
  return (m + (m >> 8)) & 0x1f;
}

// parsePositions decodes the whole ArrayBuffer in a single linear walk.
// Two passes: count frames (sizes the typed arrays), then fill. Returns
// { frames, ticks, masks, slots, bounds } where slots[s] = { pos, flags },
// pos is Float32Array(frames*4) interleaved [x, y, z, yawDeg] per frame,
// flags is Uint8Array(frames), and bounds is the world extent of all
// samples (the fallback camera fit when a map pack has no transform).
export function parsePositions(buffer, slotCount) {
  const dv = new DataView(buffer);
  const end = dv.byteLength;

  // Pass 1 — frame count via the fixed 6-byte header + popcount payloads.
  let off = 0;
  let frames = 0;
  while (off + 6 <= end) {
    const mask = dv.getUint16(off + 4, true);
    off += 6 + popcount16(mask) * 8;
    if (off > end) break; // truncated tail — drop the partial frame
    frames++;
  }
  if (frames === 0) {
    return {
      frames: 0,
      ticks: new Int32Array(0),
      masks: new Uint16Array(0),
      slots: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    };
  }

  // Pass 2 — fill.
  const ticks = new Int32Array(frames);
  const masks = new Uint16Array(frames);
  const slots = [];
  for (let s = 0; s < slotCount; s++) {
    slots.push({ pos: new Float32Array(frames * 4), flags: new Uint8Array(frames) });
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  off = 0;
  for (let f = 0; f < frames; f++) {
    ticks[f] = dv.getInt32(off, true);
    const mask = dv.getUint16(off + 4, true);
    masks[f] = mask;
    off += 6;
    for (let s = 0; s < slotCount; s++) {
      if (!(mask & (1 << s))) continue;
      const x = dv.getInt16(off, true);
      const y = dv.getInt16(off + 2, true);
      const z = dv.getInt16(off + 4, true);
      const yawByte = dv.getUint8(off + 6);
      const flags = dv.getUint8(off + 7);
      off += 8;
      const b = f * 4;
      const p = slots[s].pos;
      p[b] = x;
      p[b + 1] = y;
      p[b + 2] = z;
      p[b + 3] = yawByte / 256 * 360 - 180;
      slots[s].flags[f] = flags;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minY = maxY = 0;
  }
  return { frames, ticks, masks, slots, bounds: { minX, maxX, minY, maxY } };
}

// SPEEDS is the discrete transport ladder (0.25×–8×).
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

// createEngine builds the playback clock over a parsed position store.
// state fields: playing, speed, tick, frame, loopFrom, loopTo, loopEnabled,
// skipFreeze, followSlot. Subscribers (onChange) get the state object on
// every change, including every rAF advance while playing — the renderer
// redraws from it.
export function createEngine(data, tickRate) {
  const frames = data.frames;
  const ticks = data.ticks;
  const tr = normTickRate(tickRate);

  const state = {
    playing: false,
    speed: 1,
    tick: frames ? ticks[0] : 0,
    frame: 0,
    loopFrom: -1, // frame indices; -1 = unset
    loopTo: -1,
    loopEnabled: false,
    skipFreeze: false, // auto-jump the pre-round freeze while playing
    followSlot: null, // player slot to center camera on; null = free camera
  };

  let tickF = state.tick; // fractional tick position (lerp source of truth)
  // The round freeze windows the auto-skip consults — pushed by the view
  // (setRounds, the sfx.setRounds precedent) before playback starts; []
  // until then, so an engine built without rounds never skips.
  let rounds = [];
  const subs = new Set();

  function emit() {
    for (const fn of subs) fn(state);
  }

  // frameForTick: exact-frame binary search — index of the first frame whose
  // tick is >= t, clamped to [0, frames-1].
  function frameForTick(t) {
    let lo = 0;
    let hi = frames - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  let raf = 0;
  let lastT = 0;

  function loop(now) {
    if (!state.playing) return;
    const gapMs = now - lastT;
    const dt = Math.min(0.25, gapMs / 1000); // clamp tab-switch jumps
    // frameprobe — ONE cadence sample per playback frame: the raw rAF
    // gap. The probe drops resume gaps beyond its 250 ms bound (the same
    // tab-switch threshold dt clamps above) as non-frames; disabled it
    // no-ops here. Playback semantics below are untouched.
    frameProbe.recordFrame(gapMs);
    lastT = now;
    tickF += tr * dt * state.speed;
    if (state.loopEnabled && state.loopFrom >= 0 && state.loopTo >= state.loopFrom) {
      const from = ticks[state.loopFrom];
      const to = ticks[state.loopTo];
      if (tickF > to) tickF = from;
    }
    // AUTO-SKIP FREEZE (skipFreeze — the ONE playback hook; paused
    // scrubbing/stepping inspects a freeze freely). Entering a round's
    // freeze window jumps the playhead to freezeEndTick — the exact tick
    // the game lets you act — landing on the FIRST frame at/after it.
    // ONE check per frame, never a while: the target always sits ahead
    // of the entry point, so no second window can be found and an
    // oscillation is structurally impossible. It YIELDS TO AN ARMED
    // LOOP: when the skip would carry the playhead past loopTo the loop
    // could never wrap (a wrap↔skip ping-pong pins the playhead), so
    // that freeze plays out and the wrap wins — while a round-span loop
    // (start → end, fe < loopTo) skips every cycle. The end-of-stream
    // clamp below still runs after this, so a skip that lands on the
    // stream's last tick stops playback there. Knife-round freezes are
    // skipped like any other (they carry a real window); a warmup row
    // ships fe = 0 → no window → never skipped (data-driven). The
    // round-over gap (endTick → next startTick) is NOT a window and is
    // never skipped.
    if (state.skipFreeze) {
      const w = freezeWindowAt(rounds, tickF);
      if (w) {
        const end = Math.min(w.end, ticks[frames - 1]); // clamp to the stream
        const yields =
          state.loopEnabled &&
          state.loopFrom >= 0 &&
          state.loopTo >= state.loopFrom &&
          frameForTick(end) > state.loopTo;
        if (!yields) tickF = end;
      }
    }
    if (tickF >= ticks[frames - 1]) {
      tickF = ticks[frames - 1];
      state.playing = false;
      state.frame = frames - 1;
      state.tick = ticks[frames - 1];
      emit();
      return;
    }
    const f = frameForTick(tickF);
    state.frame = f;
    state.tick = ticks[f];
    emit();
    raf = requestAnimationFrame(loop);
  }

  function play() {
    if (state.playing || frames === 0) return;
    // At the end, restart from the beginning (or loop start).
    if (state.frame >= frames - 1) {
      tickF =
        state.loopEnabled && state.loopFrom >= 0 ? ticks[state.loopFrom] : ticks[0];
      state.frame = frameForTick(tickF);
      state.tick = ticks[state.frame];
    }
    state.playing = true;
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
    emit();
  }

  function pause() {
    if (!state.playing) return;
    state.playing = false;
    cancelAnimationFrame(raf);
    emit();
  }

  function toggle() {
    if (state.playing) pause();
    else play();
  }

  function setSpeed(s) {
    const v = Number(s);
    if (!Number.isFinite(v) || v === state.speed) return;
    state.speed = v;
    emit();
  }

  // stepSpeed moves one notch along SPEEDS (keyboard ,/.).
  function stepSpeed(dir) {
    const i = SPEEDS.indexOf(state.speed);
    const ni = Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir));
    setSpeed(SPEEDS[ni]);
  }

  // LOOP-EXIT GUARD — the ONE choke point both seeks run: a seek that
  // lands OUTSIDE the armed range cancels the loop, in FRAME space with
  // INCLUSIVE boundaries (landing exactly on from/to keeps it — the
  // wrap's own test is `tickF > to`). Cancellation is exactly
  // setLoopEnabled(false): the flag drops, the BOUNDS RETAIN (the
  // popover still shows the times — one click re-arms), the emit
  // un-warns the trigger; playback continues linearly from the landing
  // position and the URL keeps its ?loop= (only bound edits strip it).
  // Exempt by construction, so they carry no flag: the wrap, the
  // end-of-stream clamp and the armed play() restart write tickF
  // directly inside loop()/play(), the entry seeks run BEFORE ?loop=
  // arms, startClip lands on loopFrom, and the freeze skip's direct
  // write already yields to a skip past loopTo.
  function cancelLoopIfOutside(f) {
    if (state.loopEnabled && (f < state.loopFrom || f > state.loopTo)) setLoopEnabled(false);
  }

  // seekTick: exact-frame seek to the first frame at/after t.
  function seekTick(t) {
    if (frames === 0) return;
    const f = frameForTick(Math.max(ticks[0], Math.min(t, ticks[frames - 1])));
    state.frame = f;
    state.tick = ticks[f];
    tickF = ticks[f];
    cancelLoopIfOutside(f);
    emit();
  }

  // seekRelative(delta): the ±fixed-step transport seek (the ±15 s
  // buttons) — the ONE caller of rounds.seekTargetTick. With
  // skip-freeze armed the freeze-zero arithmetic applies: freeze
  // windows are 0-length for the budget, so the landing is never
  // inside one and loop()'s playback snap can never fire right after
  // the seek (with the skip off this is exactly seekTick(from +
  // delta)). Delegating to seekTick keeps the clamp, the loop-exit
  // guard and the emit on the one shared path — seekTick/seekFrame/
  // step semantics are untouched.
  //
  // Frame-rounding nudge (skip-freeze only): frameForTick rounds UP
  // to the first frame at/after t, and that frame can sit just INSIDE
  // a window whose start falls between two frames — from a t the
  // helper proved outside. Landing there would snap on the next
  // playback frame, so step back one frame instead: ticks[f-1] < t,
  // and a window containing ticks[f-1] would contain t too — so it is
  // provably outside every window. (f === 0 — the stream itself
  // begins inside a freeze — cannot step back; it lands as-is.)
  function seekRelative(delta) {
    if (frames === 0) return;
    const from = state.tick;
    const t = state.skipFreeze ? seekTargetTick(rounds, from, delta) : from + delta;
    if (state.skipFreeze) {
      const f = frameForTick(t);
      if (f > 0 && freezeWindowAt(rounds, ticks[f])) {
        seekTick(ticks[f - 1]);
        return;
      }
    }
    seekTick(t);
  }

  function seekFrame(f) {
    if (frames === 0) return;
    const clamped = Math.max(0, Math.min(frames - 1, Math.round(f)));
    state.frame = clamped;
    state.tick = ticks[clamped];
    tickF = ticks[clamped];
    cancelLoopIfOutside(clamped);
    emit();
  }

  function step(d) {
    seekFrame(state.frame + d);
  }

  // setLoop(a, b): frame-index bounds; either < 0 clears the interval.
  // Never ENABLES: arming stays toggleLoop's job (pinned by
  // renderer.test.js), so a bounds write can never start a loop.
  function setLoop(a, b) {
    const fa = a == null || a < 0 ? -1 : Math.min(frames - 1, Math.round(a));
    const fb = b == null || b < 0 ? -1 : Math.min(frames - 1, Math.round(b));
    state.loopFrom = fa;
    state.loopTo = fb;
    if (fa < 0 || fb < 0 || fa > fb) state.loopEnabled = false;
    emit();
  }

  // setLoopEnabled(on): the explicit arm/disarm — the one way code
  // CHANGES the loop state without toggle's ambiguity (toggleLoop while
  // off would ENABLE, so callers that mean "turn it off" must not
  // toggle). Used by Replay's range-edit rule (editing a bound turns
  // the loop off) and by the entry ?loop= apply (bounds first via
  // setLoop, then arm here). Enabling without a valid interval is a
  // no-op — the same invalid-bounds rule setLoop applies, so an armed
  // loop always has from ≤ to and the renderer's loop line can never
  // show a range that cannot wrap.
  function setLoopEnabled(on) {
    const next = !!on;
    if (next && (state.loopFrom < 0 || state.loopTo < state.loopFrom)) return;
    if (state.loopEnabled === next) return;
    state.loopEnabled = next;
    emit();
  }

  function toggleLoop() {
    if (!state.loopEnabled) {
      // No interval yet: default to 10 s from the current frame.
      if (state.loopFrom < 0 || state.loopTo < state.loopFrom) {
        const from = state.frame;
        const to = Math.min(frames - 1, from + Math.round(tr * 10));
        state.loopFrom = from;
        state.loopTo = to;
      }
      state.loopEnabled = true;
    } else {
      state.loopEnabled = false;
    }
    emit();
  }

  function setFollow(slot) {
    state.followSlot = slot == null ? null : slot;
    emit();
  }

  // setRounds(rows): the freeze windows the auto-skip consults (the
  // sfx.setRounds precedent — the view pushes them once, where the
  // rounds load, before playback starts). Deliberately NOT state and
  // silent: nothing renders from it, only loop() reads it, and an engine
  // pushed no rounds simply never skips ([] → no window).
  function setRounds(rows) {
    rounds = rows || [];
  }

  // setSkipFreeze / toggleSkipFreeze — the freeze auto-skip's explicit
  // arm/disarm (the setLoopEnabled / toggleLoop precedent: a plain
  // setter for "set it to this", a toggle for the toolbar button, so a
  // caller that means "turn it on" can never flip it off). The view
  // persists the choice in the frontend-owned `skip_freeze` pref and
  // re-applies it on every startEngine.
  function setSkipFreeze(on) {
    const next = !!on;
    if (state.skipFreeze === next) return;
    state.skipFreeze = next;
    emit();
  }

  function toggleSkipFreeze() {
    setSkipFreeze(!state.skipFreeze);
  }

  function onChange(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  function destroy() {
    state.playing = false;
    cancelAnimationFrame(raf);
    subs.clear();
  }

  // lerpAt fills out {x, y, z, yaw, alive} for a slot at the current
  // fractional tick (positions interpolate between adjacent frames).
  function lerpAt(slot, out) {
    out = out || {};
    const f = state.frame;
    const base = f * 4;
    const p = data.slots[slot].pos;
    const mask = data.masks[f];
    out.alive = !!(mask & (1 << slot));
    if (!out.alive) return out;
    let a = 0;
    const next = f + 1 < frames ? f + 1 : f;
    if (next !== f) {
      const span = ticks[next] - ticks[f];
      if (span > 0) a = Math.max(0, Math.min(1, (tickF - ticks[f]) / span));
    }
    const nb = next * 4;
    out.x = p[base] + (p[nb] - p[base]) * a;
    out.y = p[base + 1] + (p[nb + 1] - p[base + 1]) * a;
    out.z = p[base + 2] + (p[nb + 2] - p[base + 2]) * a;
    out.yaw = p[base + 3] + (((p[nb + 3] - p[base + 3] + 540) % 360) - 180) * a;
    out.duck = !!(data.slots[slot].flags[f] & 2);
    return out;
  }

  return {
    state,
    frames,
    tickRate: tr,
    firstTick: frames ? ticks[0] : 0,
    lastTick: frames ? ticks[frames - 1] : 0,
    frameForTick,
    lerpAt,
    play,
    pause,
    toggle,
    setSpeed,
    stepSpeed,
    seekTick,
    seekRelative,
    seekFrame,
    step,
    setLoop,
    setLoopEnabled,
    toggleLoop,
    setRounds,
    setSkipFreeze,
    toggleSkipFreeze,
    setFollow,
    onChange,
    destroy,
  };
}
