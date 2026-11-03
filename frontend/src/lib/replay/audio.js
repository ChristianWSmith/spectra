// M4 voice playback engine — Web Audio locked to the M2 replay clock
//. The replay engine is the single master clock: audio follows
// REPLAY time, never wall time.
//
// Sync contract (the scheduling math):
//   replaySec = engine.state.tick / tickRate
//   anchor = {ctxNow, replaySec, speed} set on every (re)anchor — play
//   start, seek (>50 ms), speed change, pause/stop. A PCM block starting
//   at replaySec B plays at AudioContext time
//     when = anchor.ctxNow + (B − anchor.replaySec) / anchor.speed
//   and its AudioBufferSourceNode runs at playbackRate = speed so a block
//   of N replay-seconds occupies N/speed wall-seconds — blocks land
//   edge-to-edge at any speed. Between anchors, drift is checked every
//   onChange: if |replaySec − (anchor.replaySec + (ctx.currentTime −
//   anchor.ctxNow)·speed)| > 50 ms → cancel every scheduled source and
//   re-anchor from the current tick (seek, loop wrap, clock drift).
//
// HTTP PCM window layout (fixed by the Go writer, little-endian):
//   int32 fromTick | int32 sampleRate (16000) | s16le mono PCM

import { errText } from '../services.js';
import { normTickRate } from '../fmt.js';

const WIN_SEC = 1.0;      // fetch window, replay seconds (≤2 s contract)
const LOOKAHEAD = 1.5;    // schedule this far ahead of the clock
const CACHE_MAX = 40;     // decoded-window cache entries, LRU
const DRIFT_S = 0.05;     // resync threshold
// Shared tail of both AudioContext-failed messages: WebKitGTK's audio
// output needs the GStreamer plugin set (probeAudio + the runtime start
// path used to spell this out twice).
const GST_AUDIO_HINT =
  'On Linux install gst-plugins-good (GStreamer) — WebKitGTK needs it for audio output.';

// fetchVoicePCM pulls one aligned PCM window over HTTP and parses the
// 8-byte header. Rejections (route 404 while the Go side is pending) are
// handled by the engine — surfaced once via onError, never thrown out.
export async function fetchVoicePCM(matchId, steamId, fromTick, toTick) {
  const url =
    `/api/sidecar/${matchId}/voice/pcm?steamId=${encodeURIComponent(steamId)}` +
    `&fromTick=${fromTick}&toTick=${toTick}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`voice PCM unavailable (HTTP ${res.status})`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength < 8) return { fromTick, sampleRate: 16000, samples: new Int16Array(0) };
  const dv = new DataView(ab);
  const hdrFrom = dv.getInt32(0, true);
  const rate = dv.getInt32(4, true);
  const samples = new Int16Array(ab, 8, (ab.byteLength - 8) >> 1);
  return { fromTick: hdrFrom, sampleRate: rate || 16000, samples };
}

// probeAudio is the Settings self-test: fresh AudioContext,
// resume(), report running-state + sample rate or the exact failure.
export async function probeAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const c = new Ctx();
    try {
      await c.resume();
    } catch {
      /* state check below reports the failure */
    }
    const ok = c.state === 'running';
    const out = ok
      ? { ok: true, state: c.state, sampleRate: c.sampleRate, error: '' }
      : {
          ok: false,
          state: c.state,
          sampleRate: c.sampleRate,
          error:
            `Failed to start the audio device (AudioContext state "${c.state}"). ` +
            GST_AUDIO_HINT,
        };
    try {
      await c.close();
    } catch {
      /* already closed */
    }
    return out;
  } catch (e) {
    return { ok: false, state: 'none', sampleRate: 0, error: errText(e) };
  }
}

// createVoiceEngine wires the voice mixer to the replay engine. The audio
// context is created lazily on the first setEnabled(true) (user gesture);
// if it is not running after resume() the error string is reported through
// onError and state so the UI can show its Enable-voice fallback chip.
export function createVoiceEngine({ engine, matchId, fetchPCM, onError, onStateChange }) {
  const tr = normTickRate(engine.tickRate);
  const windowTicks = Math.max(1, Math.round(WIN_SEC * tr));

  let ctx = null;
  let master = null;
  let enabled = false;
  let error = '';
  let wasPlaying = false;
  let volume = 0.8;
  // Anchor of the current schedule epoch (see header contract).
  let anchor = { ctxNow: 0, replaySec: 0, speed: 1 };
  let gen = 0; // bumped on every cancel — in-flight window callbacks check it
  let lastReplay = 0;

  let players = []; // VoicePlayer rows: {steamId, firstTick, lastTick, …}
  const muted = new Set();
  const solo = new Set();
  const gains = new Map(); // steamId → GainNode (per-player mute/solo)
  const schedEnd = new Map(); // steamId → replay-tick cursor of scheduled audio
  const cache = new Map(); // `${steamId}:${fromTick}` → {promise, buffer} LRU
  const active = new Set(); // live AudioBufferSourceNodes

  function emit() {
    if (onStateChange) onStateChange(currentState());
  }

  function currentState() {
    return { enabled, ctxState: ctx ? ctx.state : 'none', error };
  }

  // Solo overrides mutes: while any solo is active only soloed players are
  // audible; otherwise mutes decide.
  function audible(sid) {
    if (solo.size) return solo.has(sid);
    return !muted.has(sid);
  }

  function gainFor(sid) {
    if (!ctx) return null;
    let g = gains.get(sid);
    if (!g) {
      g = ctx.createGain();
      g.gain.value = audible(sid) ? 1 : 0;
      g.connect(master);
      gains.set(sid, g);
    }
    return g;
  }

  function setGain(sid) {
    const g = gains.get(sid);
    if (g) g.gain.value = audible(sid) ? 1 : 0;
  }

  function cancelAll() {
    gen++;
    for (const src of active) {
      try {
        src.stop();
      } catch {
        /* already ended */
      }
    }
    active.clear();
  }

  function resetTo(replaySec, speed) {
    cancelAll();
    anchor = { ctxNow: ctx.currentTime, replaySec, speed };
    for (const p of players) schedEnd.set(p.steamId, replaySec * tr);
  }

  function scheduleAhead(replaySec, speed) {
    const horizon = (replaySec + LOOKAHEAD) * tr;
    for (const p of players) {
      if (!audible(p.steamId) || !p.lastTick) continue;
      let end = schedEnd.get(p.steamId);
      if (end == null) {
        end = replaySec * tr;
        schedEnd.set(p.steamId, end);
      }
      const first = p.firstTick || 0;
      const last = p.lastTick;
      while (end < horizon && end < last) {
        // Floor, not ceil: schedule the window CONTAINING the cursor (the
        // late-offset logic in startSource skips its elapsed head), else
        // (cursor, next-aligned-tick) audio would never be scheduled.
        const from = Math.floor(end / windowTicks) * windowTicks;
        const to = from + windowTicks;
        if (to <= end) break; // safety: cursor must always advance
        if (to < first) {
          // pre-voice emptiness: advance the cursor without fetching
          end = to;
          continue;
        }
        fetchWindow(p.steamId, from);
        end = to;
      }
      schedEnd.set(p.steamId, end);
    }
  }

  function fetchWindow(sid, from) {
    const key = sid + ':' + from;
    // Capture the schedule epoch per call — a cache hit from an older epoch
    // must still be droppable if a seek lands while it is in flight.
    const myGen = gen;
    let entry = cache.get(key);
    if (entry) {
      cache.delete(key); // LRU touch
      cache.set(key, entry);
    } else {
      entry = {};
      cache.set(key, entry);
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      entry.promise = Promise.resolve(fetchPCM(sid, from, from + windowTicks)).then(
        (res) => {
          const n = (res && res.samples && res.samples.length) || 0;
          if (n === 0 || !ctx) return null;
          // A successful window clears a previous transient fetch error —
          // device errors only ever come from setEnabled and live until
          // the next successful enable (no fetch runs while disabled).
          if (error) {
            error = '';
            emit();
          }
          const f32 = new Float32Array(n);
          for (let i = 0; i < n; i++) f32[i] = res.samples[i] / 32768;
          const buf = ctx.createBuffer(1, f32.length, res.sampleRate || 16000);
          buf.copyToChannel(f32, 0);
          entry.buffer = buf;
          return buf;
        },
        (e) => {
          // Drop the poisoned entry so the next seek/play retries the fetch
          // instead of serving a cached null forever.
          if (cache.get(key) === entry) cache.delete(key);
          error = errText(e);
          if (onError) onError(error);
          emit();
          return null;
        },
      );
    }
    entry.promise.then((buf) => {
      // A cancel (seek/speed/pause) happened while fetching — the new
      // epoch schedules its own copy from cache; drop this callback.
      if (!buf || !enabled || myGen !== gen || !ctx) return;
      startSource(sid, from, buf);
    });
  }

  function startSource(sid, fromTick, buf) {
    const blockReplay = fromTick / tr;
    const when =
      anchor.ctxNow + (blockReplay - anchor.replaySec) / anchor.speed;
    const g = gainFor(sid);
    if (!g) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = anchor.speed;
    src.connect(g);
    let startAt = when;
    let offset = 0;
    if (when < ctx.currentTime) {
      // Late fetch: start now, skip the elapsed part of the window.
      offset = (ctx.currentTime - when) * anchor.speed;
      if (offset >= buf.duration) return;
      startAt = ctx.currentTime;
    }
    src.onended = () => active.delete(src);
    active.add(src);
    try {
      src.start(startAt, offset);
    } catch (e) {
      active.delete(src);
      error = errText(e);
      if (onError) onError(error);
      emit();
    }
  }

  function onEngineChange(st) {
    const replaySec = st.tick / tr;
    lastReplay = replaySec;
    if (!enabled || !ctx || ctx.state !== 'running') {
      wasPlaying = false;
      return;
    }
    if (!st.playing) {
      // Pause/stop → silence; a seek while paused schedules nothing.
      if (wasPlaying) cancelAll();
      wasPlaying = false;
      return;
    }
    let resync = !wasPlaying || st.speed !== anchor.speed;
    if (!resync) {
      const expected =
        anchor.replaySec + (ctx.currentTime - anchor.ctxNow) * anchor.speed;
      if (Math.abs(replaySec - expected) > DRIFT_S) resync = true;
    }
    if (resync) resetTo(replaySec, st.speed);
    wasPlaying = true;
    scheduleAhead(replaySec, st.speed);
  }

  const offChange = engine.onChange(onEngineChange);

  // A player becoming audible mid-play refills only from the current tick
  // (never from their old cursor — that would double-schedule blocks that
  // are already queued). Becoming inaudible just zeroes the gain: queued
  // audio goes silent instantly.
  function applyAudible(sid) {
    setGain(sid);
    if (!enabled || !ctx || !wasPlaying) return;
    const nowT = lastReplay * tr;
    if (audible(sid)) {
      const cur = schedEnd.get(sid);
      if (cur == null || cur < nowT) schedEnd.set(sid, nowT);
      scheduleAhead(lastReplay, anchor.speed);
    }
  }

  async function setEnabled(on) {
    if (on) {
      if (!ctx) {
        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          ctx = new Ctx();
        } catch (e) {
          error = errText(e);
          if (onError) onError(error);
          emit();
          return;
        }
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
        gains.clear(); // stale nodes from a previous context
      }
      try {
        await ctx.resume();
      } catch {
        /* state check below reports it */
      }
      if (ctx.state !== 'running') {
        enabled = false;
        error =
          `Failed to start the audio device (AudioContext state "${ctx.state}"). ` +
          GST_AUDIO_HINT;
        if (onError) onError(error);
        emit();
        return;
      }
      error = '';
      enabled = true;
      wasPlaying = false; // next onChange re-anchors and schedules
      if (engine.state.playing) onEngineChange(engine.state);
    } else {
      enabled = false;
      cancelAll();
    }
    emit();
  }

  return {
    get state() {
      return currentState();
    },
    // Mixed-clip tap: the live AudioContext + master gain (post
    // mute/solo/volume) so the clip recorder can attach a
    // MediaStreamDestination without reaching engine internals.
    getStreamTap() {
      if (!ctx || !master || !enabled) return null;
      return { ctx, master };
    },
    setEnabled,
    setPlayers(list) {
      players = list || [];
      for (const p of players) gainFor(p.steamId);
      emit();
    },
    setMasterVolume(v) {
      volume = Math.max(0, Math.min(1, Number(v) || 0));
      if (master) master.gain.value = volume;
    },
    setMuted(sid, m) {
      if (m) muted.add(sid);
      else muted.delete(sid);
      applyAudible(sid);
      emit();
    },
    setSolo(sid, s) {
      if (s) solo.add(sid);
      else solo.delete(sid);
      for (const p of players) applyAudible(p.steamId);
      emit();
    },
    destroy() {
      enabled = false;
      offChange();
      cancelAll();
      const c = ctx;
      ctx = null;
      if (c) {
        try {
          c.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
