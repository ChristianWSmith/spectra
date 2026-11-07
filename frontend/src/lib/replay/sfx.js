// Replay sound-effect engine (lib/replay/sfx.js) — gun fire and utility
// detonation audio locked to the M2 replay clock, the sound half of the
// voice engine's contract (lib/replay/audio.js).
//
// Sources: Go extracts the game's firing/detonation sounds from the
// user's own CS2 install (internal/mappack/sounds.go — Valve IP never
// ships) and serves them at /api/sounds/… described by
// /api/sounds/manifest.json; keys are the CANONICAL equipment names the
// replay state stream and the landmark rows already carry ("AK-47",
// "HE Grenade", "C4"), so a cue is one exact-match lookup. A logical item
// with several variants keeps ALL of them and picks one at RANDOM per
// play, so a spray doesn't loop one sample.
//
// This engine owns its OWN AudioContext: it must work for matches without
// voice (the voice engine may not exist at all). Autoplay policy mirrors
// audio.js — if the context is still suspended after an immediate
// resume(), a one-time document pointerdown/keydown capture listener
// resumes it on the first interaction and removes itself.
//
// Contract with the clock (engine.onChange):
//   - cues fire ONLY while st.playing and the context is running;
//   - gun cues are RISING edges of the state stream's attack bit,
//     iterating every frame in (prevFrame, curFrame] — at 8× many frames
//     pass between rAFs and the user wants sounds at ALL speeds;
//   - utility cues are the landmark rows' detonations in
//     (prevTick, curTick];
//   - a seek / loop wrap / paused scrub advances both compare points
//     WITHOUT playing (cueGapJump — the renderer's fireJump idea), so
//     scrubbing never machine-guns the cues it crossed.
//
// Pure cue-selection math is exported and unit-tested by
// frontend/src/lib/sfx.test.js.

import { errText } from '../services.js';
import { DETONATION_BUCKETS } from './landmarks.js';
import { slotStateAt } from './state.js';
import { GST_AUDIO_HINT } from './audio.js';

// Default fader level for all three categories — the kvstore prefs
// voice_volume/guns_volume/utility_volume (prefs.go) override it; the
// Settings tab imports this so both surfaces share one default.
export const AUDIO_VOL_DEFAULT = 0.8;

// Live-source cap: a new AudioBufferSourceNode per play IS the Web Audio
// contract for unlimited simultaneous instances of one buffer, but a
// pathological burst (8× through a full magazine) still gets a ceiling —
// when over the cap the OLDEST still-playing source is stopped rather
// than refusing the newest cue.
const LIVE_CAP = 32;
// Bounded fetch/decode pool for the preload pass.
const PRELOAD_POOL = 6;
// A browser without a user gesture may keep ctx.resume()'s promise
// pending forever; race it against this timeout before concluding the
// context is gesture-blocked (same window as audio.js RESUME_MS).
const RESUME_MS = 750;

// SOUND_DETONATION_BUCKETS — the drawable grenade buckets that MAKE a
// sound: everything landmarks.js DETONATION_BUCKETS can produce except
// 'decoy' (CS2 ships no decoy detonation sound — see mappack soundTable).
export const SOUND_DETONATION_BUCKETS = DETONATION_BUCKETS.filter((b) => b !== 'decoy');

// prefVolume coerces a kvstore read into a 0..1 fader level: the store
// round-trips JSON (an unset key arrives as null), so anything missing,
// non-numeric or out of range falls back to the default — a corrupt pref
// must never bind a 0-fader slider. Shared by Replay's volume popover and
// Settings' Audio & voice section (one coercion, both surfaces).
export function prefVolume(v, def = AUDIO_VOL_DEFAULT) {
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : def;
}

// grenadeCues — landmark rows → the tick-sorted utility cue list
// [{tick, name}]. Accepts the Replay's drawNorm rows (pre-bucketed by
// landmarks.js normalizeEvent — no second classification here):
//   kind 'grenade'      → the detonation bucket decides; 'decoy' (and
//                         any non-detonation bucket) is skipped;
//   kind 'bomb_explode' → the C4 explosion — the ONE explosive
//                         detonation the replay renders; row.weapon is
//                         the canonical key ("C4").
// DEDUPE by (tick, weapon): CS2.md documents that demoinfocs v6 dispatches
// events.FlashExplode TWICE (the game event AND the projectile's
// entity on-destroy) — 182 grenade rows at 91 distinct ticks in the
// golden demo — so without the dedupe every flashbang plays twice.
// Pure — unit-tested by src/lib/sfx.test.js.
export function grenadeCues(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    const kind = String(row.kind || '');
    if (kind === 'grenade') {
      if (!SOUND_DETONATION_BUCKETS.includes(String(row.bucket || ''))) continue;
    } else if (kind !== 'bomb_explode') {
      continue; // throws, plants, kills, … make no detonation sound
    }
    // The canonical key the manifest uses: the grenade's weapon for a
    // detonation, the C4 row's own weapon ("C4") for the explosion —
    // whatever the row carries, never an invented name.
    const name = row.weapon == null || row.weapon === '' ? null : String(row.weapon);
    if (!name) continue;
    const key = `${row.tick}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tick: row.tick, name });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// utilCuesInRange — the cues in (fromTick, toTick]: open at the left (the
// previous compare point already played its tick), closed at the right
// (the current tick is reached this draw). Binary search — the list is
// tick-sorted, so a full-match sweep stays O(log n) per draw.
// Pure — unit-tested by src/lib/sfx.test.js.
export function utilCuesInRange(cues, fromTick, toTick) {
  if (!cues || !cues.length || !Number.isFinite(fromTick) || !Number.isFinite(toTick)) return [];
  let lo = 0;
  let hi = cues.length - 1;
  let first = cues.length; // first index with tick > fromTick
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].tick > fromTick) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const out = [];
  for (let i = first; i < cues.length && cues[i].tick <= toTick; i++) out.push(cues[i]);
  return out;
}

// cueGapJump — the seek/frame-jump detector for the sound cues (the
// renderer's fireJump idea, renderer.js): true when the playhead moved
// somewhere the previous compare point cannot be compared across, so the
// cursors re-SEED instead of playing every cue they crossed.
//   - first draw (prevTick not finite) → seed;
//   - backwards (loop restart, reverse scrub) → seed;
//   - the same tick (paused redraw) → NOT a jump;
//   - forward by more than one normal playback step (with slack for the
//     engine's 0.25 s dt clamp at `speed`×) → seed.
// Pure — unit-tested by src/lib/sfx.test.js.
export function cueGapJump(tick, prevTick, speed, tickRate) {
  if (!Number.isFinite(tick) || !Number.isFinite(prevTick)) return true;
  const gap = tick - prevTick;
  if (gap < 0) return true;
  if (gap === 0) return false;
  const tr = Number.isFinite(tickRate) && tickRate > 0 ? tickRate : 64;
  const sp = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return gap > sp * tr * 0.3;
}

// pickVariant — one random variant of a logical item's buffers (the
// "extract ALL variants, pick one at random each play" rule). rand is
// injectable for tests; an empty list returns null (the caller skips).
// Pure — unit-tested by src/lib/sfx.test.js.
export function pickVariant(buffers, rand = Math.random) {
  if (!buffers || buffers.length === 0) return null;
  const i = Math.floor(rand() * buffers.length);
  return buffers[Math.min(Math.max(i, 0), buffers.length - 1)];
}

// weaponNameOf — resolve the state stream's weapon field to a canonical
// name. state.js parseState interns meta.weaponNames, so the field is
// ALREADY the name string ("AK-47") in every stream the app loads; the
// numeric branch keeps the `names[weapon]` contract for a loader that
// hands back raw indices. null/unknown → null (the cue is skipped).
// Pure — unit-tested by src/lib/sfx.test.js.
export function weaponNameOf(stateWeapon, names) {
  if (typeof stateWeapon === 'number') {
    return names && names[stateWeapon] != null ? names[stateWeapon] : null;
  }
  if (typeof stateWeapon === 'string' && stateWeapon !== '') return stateWeapon;
  return null;
}

// gunCues — one slot's RISING attack edges in (fromFrame, toFrame],
// resolved to {frame, name} cues. The seed comes from the PREVIOUS
// frame's attack bit: a trigger already held at fromFrame must not read
// as a fresh edge on the first frame of the range (and a paused redraw —
// toFrame === fromFrame — yields nothing). Every intermediate frame is
// visited: at 8× several frames pass between rAFs and each held-then-
// released-then-held trigger must still fire. Pure — unit-tested by
// src/lib/sfx.test.js.
export function gunCues(index, names, slot, fromFrame, toFrame) {
  const out = [];
  if (!index || !index.slots || !index.slots[slot]) return out;
  if (!Number.isFinite(fromFrame) || !Number.isFinite(toFrame) || toFrame <= fromFrame) return out;
  let prev = !!slotStateAt(index, slot, fromFrame).attack;
  for (let f = fromFrame + 1; f <= toFrame; f++) {
    const st = slotStateAt(index, slot, f);
    const attack = !!st.attack;
    if (attack && !prev) {
      const name = weaponNameOf(st.weapon, names);
      if (name) out.push({ frame: f, name });
    }
    prev = attack;
  }
  return out;
}

// createSfxEngine wires the sound-effect mixer to the replay engine.
// The manifest is read through loadSoundManifest() (memoized — the
// Replay checks it first and skips construction entirely when nothing
// has been extracted: no context, no gesture listener, silent replay).
// setEnabled-style setup never throws: per-file preload failures are
// swallowed (the FIRST one is reported through onError), and a cue whose
// buffer is not decoded yet is silently skipped — a sound must never
// break playback.
export function createSfxEngine({ engine, matchId, onError }) {
  // matchId mirrors createVoiceEngine's signature (kept for parity —
  // every sound is a shared static file, so nothing is keyed per match).
  void matchId;
  const tr = engine.tickRate;

  let ctx = null;
  let gunGain = null;
  let utilGain = null;
  let destroyed = false;
  let error = '';
  let gesturePending = false;
  let gestureOff = null; // tears down the parked one-time listeners
  let reported = false; // onError fires at most once (first failure)
  let gunVol = AUDIO_VOL_DEFAULT;
  let utilVol = AUDIO_VOL_DEFAULT;
  let gunMuted = false;
  let utilMuted = false;

  const buffers = new Map(); // name → AudioBuffer[] (manifest order)
  let total = 0;
  let loaded = 0;
  const live = []; // live sources, OLDEST first (the cap drops the head)

  // Cue inputs (pushed by the Replay at the renderer's push sites).
  let utilCues = []; // grenadeCues(drawNorm) — tick-sorted
  let stateIndex = null;
  let weaponNames = [];
  // Compare points of the last engine change (see the header contract).
  let prevTick = null;
  let prevFrame = null;

  const offChange = engine.onChange(onEngineChange);

  function fail(msg) {
    if (reported || destroyed) return;
    reported = true;
    error = msg;
    if (onError) onError(msg);
  }

  function applyGains() {
    if (gunGain) gunGain.gain.value = gunMuted ? 0 : gunVol;
    if (utilGain) utilGain.gain.value = utilMuted ? 0 : utilVol;
  }

  // tryResume calls ctx.resume() SYNCHRONOUSLY (callers must invoke it
  // directly inside a user gesture) and resolves to whether the context
  // ended up running — resume()'s promise may stay pending forever when
  // autoplay is blocked, so it is raced against RESUME_MS (the pattern
  // audio.js's tryResume uses).
  function tryResume() {
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'running') return Promise.resolve(true);
    let p;
    try {
      p = Promise.resolve(ctx.resume());
    } catch {
      return Promise.resolve(false);
    }
    const timeout = new Promise((r) => setTimeout(() => r(undefined), RESUME_MS));
    return Promise.race([p, timeout]).then(
      () => !!ctx && ctx.state === 'running',
      () => !!ctx && ctx.state === 'running',
    );
  }

  function clearGesture() {
    if (gestureOff) {
      gestureOff();
      gestureOff = null;
    }
  }

  // installGesture parks a ONE-TIME document-level pointerdown/keydown
  // listener (capture) that resumes the context and removes itself —
  // the browser's autoplay policy needs the interaction inside a real
  // gesture (copied from audio.js's installGesture).
  function installGesture() {
    if (gestureOff || typeof document === 'undefined' || !document.addEventListener) return;
    const handler = () => {
      clearGesture(); // one interaction, one attempt
      tryResume().then((ok) => {
        if (destroyed) return;
        if (ok) {
          gesturePending = false;
        } else {
          // A real gesture still didn't start it: that IS the device
          // failure (broken GStreamer etc.) — report it now.
          gesturePending = false;
          fail(
            `Failed to start the audio device (AudioContext state "${ctx ? ctx.state : 'none'}"). ` +
              GST_AUDIO_HINT,
          );
        }
      });
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
    gestureOff = () => {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }

  // Own context: created only when the engine is (i.e. sounds EXIST —
  // matches without extracted audio never get here), independent of the
  // voice engine so gun/utility audio works with no voice at all.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    gunGain = ctx.createGain();
    utilGain = ctx.createGain();
    gunGain.connect(ctx.destination);
    utilGain.connect(ctx.destination);
    applyGains();
  } catch (e) {
    fail(errText(e));
  }

  if (ctx) {
    tryResume().then((ok) => {
      if (destroyed) return;
      if (!ok && ctx.state !== 'closed') {
        // Autoplay-blocked (or a device that needs one): park the
        // one-shot gesture listener — pending, NOT an error.
        gesturePending = true;
        installGesture();
      }
    });
  }

  // --- preload -------------------------------------------------------------
  // Fetch + decode every manifest URL through a bounded pool; each name
  // keeps ALL of its variants (manifest order — the slot is assigned up
  // front so the parallel pool cannot reshuffle it). Per-file failures are
  // swallowed after the ONE onError report; the rest keep loading.
  async function preload() {
    const manifest = await loadSoundManifest().catch(() => null);
    if (destroyed || !ctx || !manifest || !manifest.sounds) return;
    const tasks = [];
    for (const [name, urls] of Object.entries(manifest.sounds)) {
      if (!Array.isArray(urls)) continue;
      const slots = new Array(urls.length).fill(null);
      buffers.set(name, slots);
      urls.forEach((url, i) => tasks.push({ name, url, slots, i }));
    }
    total = tasks.length;
    if (total === 0) return;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const idx = next++;
        if (idx >= tasks.length || destroyed) return;
        const t = tasks[idx];
        try {
          const res = await fetch(t.url, { cache: 'force-cache' });
          if (!res.ok) throw new Error(`sound unavailable (HTTP ${res.status})`);
          const raw = await res.arrayBuffer();
          const audio = await ctx.decodeAudioData(raw);
          if (destroyed) return;
          t.slots[t.i] = audio;
        } catch (e) {
          fail(errText(e)); // first failure only — the rest stay silent
        }
        loaded++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PRELOAD_POOL, tasks.length) }, worker));
  }
  preload();

  // --- playback ------------------------------------------------------------
  // A NEW AudioBufferSourceNode per play: that is the Web Audio contract
  // for unlimited simultaneous instances of the same buffer (sources are
  // one-shot by design) — no pooling, no voice-stealing between cues.
  function playGroup(name, bucket) {
    if (destroyed || !ctx || ctx.state !== 'running') return false;
    const variants = buffers.get(name);
    // Only READY variants are candidates: a file still decoding (or one
    // that failed) is skipped silently — a sound must never break play.
    const ready = variants ? variants.filter(Boolean) : null;
    const buf = pickVariant(ready);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(bucket === 'guns' ? gunGain : utilGain);
    // Cap the fan-out: drop the OLDEST still-playing source so the
    // newest cue always gets through.
    while (live.length >= LIVE_CAP) {
      const oldest = live.shift();
      try {
        oldest.stop();
      } catch {
        /* already ended */
      }
      try {
        oldest.disconnect();
      } catch {
        /* already detached */
      }
    }
    src.onended = () => {
      const at = live.indexOf(src);
      if (at >= 0) live.splice(at, 1);
      try {
        src.disconnect();
      } catch {
        /* already detached */
      }
    };
    live.push(src);
    try {
      src.start();
    } catch (e) {
      fail(errText(e));
      const at = live.indexOf(src);
      if (at >= 0) live.splice(at, 1);
      return false;
    }
    return true;
  }

  // --- clock cues ----------------------------------------------------------
  function playUtilInRange(fromTick, toTick) {
    if (!utilCues.length) return;
    for (const cue of utilCuesInRange(utilCues, fromTick, toTick)) {
      playGroup(cue.name, 'utility');
    }
  }

  function playGunEdges(fromFrame, toFrame) {
    if (!stateIndex || !Number.isFinite(fromFrame) || !Number.isFinite(toFrame)) return;
    const slots = stateIndex.slots || [];
    for (let slot = 0; slot < slots.length; slot++) {
      for (const cue of gunCues(stateIndex, weaponNames, slot, fromFrame, toFrame)) {
        playGroup(cue.name, 'guns');
      }
    }
  }

  function onEngineChange(st) {
    if (destroyed) return;
    const jump = cueGapJump(st.tick, prevTick, st.speed, tr);
    const running = !!ctx && ctx.state === 'running';
    if (st.playing && running && !jump) {
      playUtilInRange(prevTick, st.tick);
      playGunEdges(prevFrame, st.frame);
    }
    // EVERY path advances the compare points: a seek, a loop wrap or a
    // paused scrub must not machine-gun the cues it crossed when
    // playback (or the context) comes back.
    prevTick = st.tick;
    prevFrame = st.frame;
  }

  return {
    get state() {
      return {
        ready: total > 0 && loaded >= total && buffers.size > 0,
        total,
        error,
        pendingGesture: gesturePending,
      };
    },
    // setLandmarks pushes the Replay's drawNorm rows (pre-bucketed by
    // landmarks.js); repeats are tolerated — the cue list is rebuilt
    // from scratch each call.
    setLandmarks(rows) {
      utilCues = grenadeCues(rows);
    },
    setStateIndex(index) {
      stateIndex = index || null;
    },
    // setWeaponNames hands over the sidecar's weapon vocabulary
    // (meta.weaponNames) — the resolver's index branch (state.js already
    // interns names into the stream itself, see weaponNameOf).
    setWeaponNames(names) {
      weaponNames = names || [];
    },
    // playGroup is exported on the engine for one-off cues (and tests).
    playGroup,
    setVolume(v) {
      gunVol = Math.max(0, Math.min(1, Number(v) || 0));
      applyGains();
    },
    setUtilityVolume(v) {
      utilVol = Math.max(0, Math.min(1, Number(v) || 0));
      applyGains();
    },
    // setMuted(bucket, m) — 'guns' | 'utility'; session-only (the
    // popover's two toggles are not persisted, unlike the faders).
    setMuted(bucket, m) {
      if (bucket === 'guns') gunMuted = !!m;
      else if (bucket === 'utility') utilMuted = !!m;
      applyGains();
    },
    destroy() {
      destroyed = true;
      clearGesture(); // never leak the parked gesture listeners
      offChange();
      for (const src of live.splice(0)) {
        try {
          src.stop();
        } catch {
          /* already ended */
        }
        try {
          src.disconnect();
        } catch {
          /* already detached */
        }
      }
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

// The fail-soft empty manifest — frozen so callers can share it safely.
const EMPTY_MANIFEST = Object.freeze({
  extracted: false,
  count: 0,
  sounds: Object.freeze({}),
  note: '',
});

// Session memo: one fetch per page load; resetSoundManifest() drops it
// (the services.extractSounds wrapper does this after a successful
// extraction). Mirrors icons.js's loadIconManifest.
let manifestPromise = null;

// normalizeManifest is the fail-soft boundary: any input (null, a 404
// body, a malformed payload) becomes a well-formed manifest with the same
// three keys, so callers never shape-check. Only string→string[] entries
// survive; count is recomputed so count === sounds size.
export function normalizeSoundManifest(raw) {
  if (raw == null || typeof raw !== 'object') return EMPTY_MANIFEST;
  const sounds = {};
  if (raw.sounds != null && typeof raw.sounds === 'object') {
    for (const [name, urls] of Object.entries(raw.sounds)) {
      if (typeof name !== 'string' || !Array.isArray(urls)) continue;
      const list = urls.filter((u) => typeof u === 'string' && u !== '');
      if (list.length > 0) sounds[name] = list;
    }
  }
  if (Object.keys(sounds).length === 0) return EMPTY_MANIFEST;
  return Object.freeze({
    extracted: raw.extracted !== false,
    count: Object.keys(sounds).length,
    sounds: Object.freeze(sounds),
    note: typeof raw.note === 'string' ? raw.note : '',
  });
}

// loadSoundManifest fetches /api/sounds/manifest.json once per session.
// Resolves to a normalized manifest on every path: 404/network failure →
// the empty manifest (extracted:false) — the caller then skips sound
// playback entirely. Failures are NOT memoized (the next call retries);
// a successful body stays memoized until resetSoundManifest().
export function loadSoundManifest() {
  if (!manifestPromise) {
    const p = fetch('/api/sounds/manifest.json', { cache: 'no-store' })
      .then((res) =>
        res && res.ok
          ? res.json().then(normalizeSoundManifest)
          : Promise.reject(new Error('sound manifest unavailable')),
      )
      .catch(() => {
        // Fail-soft for THIS caller (resolves to the empty manifest) but
        // re-arm the memo so the next call refetches — re-arm only if
        // the memo still points at us (resetSoundManifest may have won).
        if (manifestPromise === p) manifestPromise = null;
        return EMPTY_MANIFEST;
      });
    manifestPromise = p;
  }
  return manifestPromise;
}

// resetSoundManifest drops the session memo so the next
// loadSoundManifest refetches — call it after SoundService.ExtractSounds
// (services.js's extractSounds() wrapper already does).
export function resetSoundManifest() {
  manifestPromise = null;
}
