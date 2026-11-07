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
// audio.js — there is NO gesture-pending UX: the context starts by itself
// wherever the platform allows it, and while it stays suspended a
// persistent document pointerdown/keydown capture listener (registered
// for as long as the context is not running, removed on running/destroy)
// retries SILENTLY — being suspended is never an error. A resume() that
// REJECTS is a device failure and surfaces through onError with the
// GStreamer hint.
//
// Contract with the clock (engine.onChange):
//   - cues fire ONLY while st.playing and the context is running;
//   - gun cues are the bullets.js rows pushed through setBullets, in
//     (prevTick, curTick] — ONE row per shot, guns-only and
//     freeze-filtered by bullets.js' own contract (a grenade equip or
//     throw and a knife swing are never bullets, so they never make a
//     gun sound here); the rows' `draw` flag is TRACER selection only —
//     sfx plays EVERY row (the real fire cadence, see bullets.js);
//   - utility/bomb cues are the landmark rows' detonations and knife
//     cues their damage rows, both in (prevTick, curTick] and both
//     freeze-gated at cue-build time (rounds.js inFreezeTime — the game
//     forbids firing/utility during freeze);
//   - a seek / loop wrap / paused scrub advances the compare point
//     WITHOUT playing (cueGapJump — the renderer's fireJump idea), so
//     scrubbing never machine-guns the cues it crossed.
//
// Pure cue-selection math is exported and unit-tested by
// frontend/src/lib/sfx.test.js.

import { errText } from '../services.js';
import { inFreezeTime } from '../rounds.js';
import { DETONATION_BUCKETS } from './landmarks.js';
import { GST_AUDIO_HINT } from './audio.js';

// Default fader level for all three categories — the kvstore prefs
// voice_volume/guns_volume/utility_volume (prefs.go) override it; the
// Settings tab imports this so both surfaces share one default.
export const AUDIO_VOL_DEFAULT = 0.8;

// Internal mix calibration — GUNS_GAIN_SCALE / UTILITY_GAIN_SCALE are
// applied to the fader level in applyGains(), so a user-facing 80% still
// READS 80% (AUDIO_VOL_DEFAULT, the sliders, prefs.go and Settings are
// all untouched): the reduction lives inside the mixer, invisible to the
// fader. BOTH numbers exist because this is a relative-mix decision, not
// a default change: the raw extracted samples play far hotter than the
// voice/announcer bus, so the gun bus runs at a third of its fader level
// (a 2/3 cut) and utility at two thirds (a 1/3 cut) — retune the balance
// here, never by moving the pref default. Voice is deliberately NOT
// scaled: its master gain stays exactly the fader value, so this pair is
// the whole gun/utility-vs-voice calibration.
export const GUNS_GAIN_SCALE = 1 / 3;
export const UTILITY_GAIN_SCALE = 2 / 3;

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
// context is still suspended (same window as audio.js RESUME_MS).
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
// Throws, equips and plants make NO cue (only detonations do), and a
// cue whose tick sits in a round's FREEZE time is dropped (rounds.js
// inFreezeTime — the freeze gate; `rounds` is the GetRounds rows, absent
// → nothing is gated).
// DEDUPE by (tick, weapon): CS2.md documents that demoinfocs v6 dispatches
// events.FlashExplode TWICE (the game event AND the projectile's
// entity on-destroy) — 182 grenade rows at 91 distinct ticks in the
// golden demo — so without the dedupe every flashbang plays twice.
// Pure — unit-tested by src/lib/sfx.test.js.
export function grenadeCues(rows, rounds) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    const kind = String(row.kind || '');
    if (kind === 'grenade') {
      if (!SOUND_DETONATION_BUCKETS.includes(String(row.bucket || ''))) continue;
    } else if (kind !== 'bomb_explode') {
      continue; // throws, equips, plants, kills, … make no detonation sound
    }
    // The canonical key the manifest uses: the grenade's weapon for a
    // detonation, the C4 row's own weapon ("C4") for the explosion —
    // whatever the row carries, never an invented name.
    const name = row.weapon == null || row.weapon === '' ? null : String(row.weapon);
    if (!name) continue;
    if (inFreezeTime(rounds, row.tick)) continue;
    const key = `${row.tick}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tick: row.tick, name });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// knifeCues — the knife's ONLY sound source: DAMAGE rows (kind
// 'damage', weapon 'Knife') → [{tick, name:'Knife'}] in tick order.
// Swings and wall hits make no cue (they are not damage), and neither
// does a kill row on its own — the flesh-hit sound accompanies the
// DAMAGE the demo records for the hit (a backstab records damage too).
// The manifest's "Knife" group is the game's networked
// Weapon_Knife.Hit.*.Flesh set (internal/mappack/sounds.go), so a hit
// on an enemy plays the real hit sound and a swing plays nothing.
// Freeze-gated with the same rule as grenadeCues (rounds.js).
// Pure — unit-tested by src/lib/sfx.test.js.
export function knifeCues(rows, rounds) {
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    if (String(row.kind || '') !== 'damage') continue;
    if (String(row.weapon || '') !== 'Knife') continue;
    if (inFreezeTime(rounds, row.tick)) continue;
    out.push({ tick: row.tick, name: 'Knife' });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// tickRange — the ONE (from, to] selector over ANY tick-sorted list:
// open at the left (the previous compare point already played its tick),
// closed at the right (the current tick is reached this draw). Binary
// search — the lists are tick-sorted, so a full-match sweep stays
// O(log n) per draw. Shared by the utility and the bullet cue lists (the
// two exported wrappers below pin the names their callers use).
function tickRange(list, fromTick, toTick) {
  if (!list || !list.length || !Number.isFinite(fromTick) || !Number.isFinite(toTick)) return [];
  let lo = 0;
  let hi = list.length - 1;
  let first = list.length; // first index with tick > fromTick
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].tick > fromTick) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const out = [];
  for (let i = first; i < list.length && list[i].tick <= toTick; i++) out.push(list[i]);
  return out;
}

// utilCuesInRange — the detonation/knife cues in (fromTick, toTick].
// Pure — unit-tested by src/lib/sfx.test.js.
export function utilCuesInRange(cues, fromTick, toTick) {
  return tickRange(cues, fromTick, toTick);
}

// bulletCuesInRange — the bullets.js rows in (fromTick, toTick] whose
// gun sounds play this draw: EVERY row in range (the `draw` flag is the
// tracer selection — sounds are the full fire cadence, see bullets.js).
// Rows are globally tick-sorted by deriveBullets' contract; the engine
// only calls this while cueGapJump says the movement was ordinary
// playback (a seek re-seeds instead of playing the crossed rows).
// Pure — unit-tested by src/lib/sfx.test.js.
export function bulletCuesInRange(rows, fromTick, toTick) {
  return tickRange(rows, fromTick, toTick);
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

// createSfxEngine wires the sound-effect mixer to the replay engine.
// The manifest is read through loadSoundManifest() (memoized — the
// Replay checks it first and skips construction entirely when nothing
// has been extracted: no context, no retry listener, silent replay).
// Setup never throws: per-file preload failures are swallowed (the
// FIRST one is reported through onError), and a cue whose buffer is not
// decoded yet is silently skipped — a sound must never break playback.
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
  let retryOff = null; // tears down the parked retry listeners
  let reported = false; // onError fires at most once (first failure)
  let gunVol = AUDIO_VOL_DEFAULT;
  let utilVol = AUDIO_VOL_DEFAULT;
  let gunMuted = false;
  let utilMuted = false;

  const buffers = new Map(); // name → AudioBuffer[] (manifest order)
  let total = 0;
  let loaded = 0;
  const live = []; // live sources, OLDEST first (the cap drops the head)

  // Cue inputs (pushed by the Replay at its load/engine push sites).
  let landmarkRows = []; // drawNorm — the ONE source of util + knife cues
  let rounds = null; // GetRounds rows — the freeze gate (rounds.js)
  let utilCues = []; // grenadeCues(landmarkRows, rounds) — tick-sorted
  let knifeHits = []; // knifeCues(landmarkRows, rounds) — tick-sorted
  let bullets = []; // setBullets — bullets.js rows, tick-sorted
  // Compare point of the last engine change (see the header contract).
  let prevTick = null;
  let lastPlaying = false; // play-START edge → one silent resume retry

  const offChange = engine.onChange(onEngineChange);

  function fail(msg) {
    if (reported || destroyed) return;
    reported = true;
    error = msg;
    if (onError) onError(msg);
  }

  function applyGains() {
    // Internal mix calibration (see GUNS_GAIN_SCALE): the fader keeps
    // its user-facing 0..1 meaning, the bus gain carries the reduction.
    if (gunGain) gunGain.gain.value = gunMuted ? 0 : gunVol * GUNS_GAIN_SCALE;
    if (utilGain) utilGain.gain.value = utilMuted ? 0 : utilVol * UTILITY_GAIN_SCALE;
  }

  // tryResume calls ctx.resume() SYNCHRONOUSLY (a listener must invoke
  // it inside the user gesture) and resolves to whether the context
  // ended up running — resume()'s promise may stay pending forever when
  // autoplay is blocked, so it is raced against RESUME_MS (the pattern
  // audio.js's tryResume uses). A resume() that REJECTS propagates: a
  // rejecting resume IS the device failure, and attemptResume reports it
  // with the GStreamer hint. A lost race resolves to the running check —
  // "still suspended", which is NOT an error.
  function tryResume() {
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'running') return Promise.resolve(true);
    let p;
    try {
      p = Promise.resolve(ctx.resume());
    } catch (e) {
      return Promise.reject(e);
    }
    const timeout = new Promise((r) => setTimeout(() => r(undefined), RESUME_MS));
    return Promise.race([p, timeout]).then(() => !!ctx && ctx.state === 'running');
  }

  function clearRetry() {
    if (retryOff) {
      retryOff();
      retryOff = null;
    }
  }

  // installRetry parks document-level pointerdown/keydown capture
  // listeners that retry the resume on EVERY interaction while the
  // context is suspended — persistent, not one-time: they stay until the
  // context runs or the engine fails/destroys. No pending flag, no UI
  // and no error while merely suspended — the autoplay policy is not a
  // failure, the sounds simply start on the first interaction (or by
  // themselves where the platform allows it).
  function installRetry() {
    if (retryOff || typeof document === 'undefined' || !document.addEventListener) return;
    const handler = () => attemptResume();
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
    retryOff = () => {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }

  // attemptResume — ONE silent resume attempt: running → the retry
  // listeners come down; still suspended → keep them and stay SILENT;
  // a REJECTED resume() → the device is broken, report it once with the
  // GStreamer hint (the only error this engine ever surfaces for audio).
  function attemptResume() {
    if (destroyed || !ctx) return;
    if (ctx.state === 'running') {
      clearRetry();
      return;
    }
    tryResume().then(
      (ok) => {
        if (destroyed || !ctx) return;
        if (ok) {
          clearRetry();
          return;
        }
        if (ctx.state === 'closed') {
          clearRetry(); // destroy closed it mid-flight
          return;
        }
        // Merely suspended — retry stays armed, unless a device failure
        // already surfaced (`reported`): a stale attempt must never
        // re-arm the listeners after the engine reported a broken device.
        if (!reported) installRetry();
      },
      () => {
        if (destroyed || !ctx) return;
        clearRetry();
        fail(
          `Failed to start the audio device (AudioContext state "${ctx ? ctx.state : 'none'}"). ` +
            GST_AUDIO_HINT,
        );
      },
    );
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

  // First attempt starts the context wherever the platform allows it;
  // the retry listeners are armed from the start so an interaction
  // during the attempt window is never missed (cleared on success).
  if (ctx) {
    installRetry();
    attemptResume();
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
    for (const cue of utilCuesInRange(utilCues, fromTick, toTick)) {
      playGroup(cue.name, 'utility');
    }
  }

  function playKnifeInRange(fromTick, toTick) {
    for (const cue of utilCuesInRange(knifeHits, fromTick, toTick)) {
      // The guns bucket: a knife hit shares the gun fader/mute, and the
      // manifest's "Knife" group is the networked flesh-hit set.
      playGroup(cue.name, 'guns');
    }
  }

  // playBulletsInRange — ONE gun sound per bullets.js row in range.
  // EVERY row plays: `draw` is the renderer's tracer selection, not a
  // sound filter (bullets.js contract — the real fire cadence). The rows
  // themselves are already guns-only and freeze-filtered there, so this
  // engine never re-checks either rule.
  function playBulletsInRange(fromTick, toTick) {
    for (const row of bulletCuesInRange(bullets, fromTick, toTick)) {
      playGroup(row.weapon, 'guns');
    }
  }

  function onEngineChange(st) {
    if (destroyed) return;
    // Silent resume retry when playback (re)starts: the platform may
    // grant the context by now — never a hint, never an error (a
    // rejected resume surfaces through attemptResume).
    if (st.playing && !lastPlaying) attemptResume();
    lastPlaying = st.playing;
    const jump = cueGapJump(st.tick, prevTick, st.speed, tr);
    const running = !!ctx && ctx.state === 'running';
    if (st.playing && running && !jump) {
      playUtilInRange(prevTick, st.tick);
      playKnifeInRange(prevTick, st.tick);
      playBulletsInRange(prevTick, st.tick);
    }
    // EVERY path advances the compare point: a seek, a loop wrap or a
    // paused scrub must not machine-gun the cues it crossed when
    // playback (or the context) comes back.
    prevTick = st.tick;
  }

  // rebuildCues re-derives BOTH landmark cue lists from the rows last
  // pushed — called by setLandmarks and setRounds (either input may
  // arrive second; the freeze gate needs both).
  function rebuildCues() {
    utilCues = grenadeCues(landmarkRows, rounds);
    knifeHits = knifeCues(landmarkRows, rounds);
  }

  return {
    get state() {
      return {
        ready: total > 0 && loaded >= total && buffers.size > 0,
        total,
        error,
      };
    },
    // setLandmarks pushes the Replay's drawNorm rows (pre-bucketed by
    // landmarks.js); repeats are tolerated — the cue list is rebuilt
    // from scratch each call.
    setLandmarks(rows) {
      landmarkRows = rows || [];
      rebuildCues();
    },
    // setRounds hands over GetRounds' rows — the freeze gate the util
    // and knife cue lists are built under (rounds.js inFreezeTime;
    // bullets are freeze-filtered upstream in bullets.js).
    setRounds(rs) {
      rounds = rs || null;
      rebuildCues();
    },
    // setBullets pushes the bullets.js rows (deriveBullets — globally
    // tick-sorted, guns-only, freeze-filtered; see bullets.js). Tolerates
    // a repeat push; compare points are engine-side and unaffected.
    setBullets(rows) {
      bullets = rows || [];
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
      clearRetry(); // never leak the parked retry listeners
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
