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
// followSlot. Subscribers (onChange) get the state object on every change,
// including every rAF advance while playing — the renderer redraws from it.
export function createEngine(data, tickRate) {
  const frames = data.frames;
  const ticks = data.ticks;
  const tr = Number(tickRate) > 0 ? Number(tickRate) : 64;

  const state = {
    playing: false,
    speed: 1,
    tick: frames ? ticks[0] : 0,
    frame: 0,
    loopFrom: -1, // frame indices; -1 = unset
    loopTo: -1,
    loopEnabled: false,
    followSlot: null, // player slot to center camera on; null = free camera
  };

  let tickF = state.tick; // fractional tick position (lerp source of truth)
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
    const dt = Math.min(0.25, (now - lastT) / 1000); // clamp tab-switch jumps
    lastT = now;
    tickF += tr * dt * state.speed;
    if (state.loopEnabled && state.loopFrom >= 0 && state.loopTo >= state.loopFrom) {
      const from = ticks[state.loopFrom];
      const to = ticks[state.loopTo];
      if (tickF > to) tickF = from;
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

  // seekTick: exact-frame seek to the first frame at/after t.
  function seekTick(t) {
    if (frames === 0) return;
    const f = frameForTick(Math.max(ticks[0], Math.min(t, ticks[frames - 1])));
    state.frame = f;
    state.tick = ticks[f];
    tickF = ticks[f];
    emit();
  }

  function seekFrame(f) {
    if (frames === 0) return;
    const clamped = Math.max(0, Math.min(frames - 1, Math.round(f)));
    state.frame = clamped;
    state.tick = ticks[clamped];
    tickF = ticks[clamped];
    emit();
  }

  function step(d) {
    seekFrame(state.frame + d);
  }

  // setLoop(a, b): frame-index bounds; either < 0 clears the interval.
  function setLoop(a, b) {
    const fa = a == null || a < 0 ? -1 : Math.min(frames - 1, Math.round(a));
    const fb = b == null || b < 0 ? -1 : Math.min(frames - 1, Math.round(b));
    state.loopFrom = fa;
    state.loopTo = fb;
    if (fa < 0 || fb < 0 || fa > fb) state.loopEnabled = false;
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
    seekFrame,
    step,
    setLoop,
    toggleLoop,
    setFollow,
    onChange,
    destroy,
  };
}
