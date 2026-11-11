// jsdom driver for Replay: a FRESH replay opens with the landmark feed
// COLLAPSED — its toggle sits on the main column's ONE top line
// (.replay-topbar, first child of .replay-main: back button left, round
// ribbon in the flex-grow middle, rail toggle right, spec 7/13/14) with
// no .replay-side at all until it expands; the view itself is the ROW
// (main column + rail beside it when open, no .replay-cols wrapper), so
// the expanded aside's header shares the top line with that bar. The
// round ribbon rides the top line too (its .rp-ribbon cell), and the
// transport splits into the full-width game-time scrubber line ABOVE the
// centered control-cluster line (round transport, ±15s, play, speed
// popover, the skip-freeze toggle, loop popover, camera Smart/Free/Follow
// popover, the follow-player popover while Follow is armed, the
// drop-layer multi-select popover, the volume popover,
// snapshot/record, and the hints-only codicon LAST — three .toolbar-sep
// rules split those groups: after the loop control, after the volume
// host, before the hints). A fresh replay also AUTOPLAYS (startEngine
// calls engine.play() once the position data is up).
//
// The stage carries the ONE control group (.rp-ctrl-list): a row per
// NON-DEFAULT control state (follow + its dismiss, loop range,
// skip-freeze, a non-Smart camera, the map-pack note). It replaced the
// follow chip, the canvas bottom-left readout and the packNote
// paragraph, so each of those lines has exactly ONE copy.
//
// The view's data source, engine, renderer and input are scripted stubs —
// this driver pins STRUCTURE, not rendering (CSS placement of the
// floating overlays is verified by the human, not jsdom).
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --test test/replay.dom.mjs
// (must be run with frontend/ as the working directory; the same file also
// runs under `node --conditions browser test/replay.dom.mjs` — it pins the
// browser condition itself so `svelte` resolves to the client build)
import { registerHooks } from 'node:module';

// svelte's package exports pick the SERVER build without the `browser`
// condition (mount() then throws "lifecycle_function_unavailable"), so the
// driver adds it for every svelte specifier before anything imports one.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return nextResolve(specifier, {
        ...context,
        conditions: ['browser', ...(context.conditions || [])],
      });
    }
    return nextResolve(specifier, context);
  },
});

const { JSDOM } = await import('jsdom');
const { compile } = await import('svelte/compiler');
const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver',
  'DOMParser',
]) {
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
globalThis.navigator = dom.window.navigator;

// jsdom has no ResizeObserver and Node's fetch cannot resolve the
// sidecar's relative URL — the view only needs both to exist.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.fetch = async () => ({
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(8),
});

const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'replay');
mkdirSync(join(dir, 'replay'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });
mkdirSync(join(dir, 'views'), { recursive: true });

const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Plain-ESM deps copied verbatim with their relative layout intact
// (fmt → rounds, nav → router + replay/landmarks → rounds — the same copy
// the landmark-row / combat drivers do); sideparity/teams/rounds/router
// are RoundStrip's own copy set (its kvstore binding is stubbed below);
// csv.js and payloadTree.js are import-free.
for (const rel of [
  'rounds.js', 'router.js', 'nav.js', 'fmt.js', 'csv.js', 'payloadTree.js',
  'sideparity.js', 'teams.js',
  // players.js is the canonical bot filter — Replay's roster rows and
  // replay/playercard.js's bot check both import it.
  'players.js',
  // keepalive.js is the mini-player dock's resume rule
  // (shouldResumeOnReturn) — Replay imports it next to nav.js.
  'keepalive.js',
]) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
// RoundStrip reads show_knife_warmup_rounds through the kvstore binding
// — a fresh-profile stub (key unset → warmup/knife cells hidden).
writeFileSync(
  join(dir, 'components', 'kvstore.js'),
  'export const KVStoreService = { Get: () => Promise.resolve(undefined) };\n',
);
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);
// Pure (no I/O) replay deps copied verbatim, like landmarks: the card
// formatter set (PlayerCard imports it), the teammate-color mapping and
// the live-stats fold (Replay.svelte imports those two), and the voice
// metadata module (speaking index — deterministic with the stubbed voice
// services above: null lanes → no speaking). sfx.js is the sound-effect
// engine Replay mounts (its manifest fetch resolves to the EMPTY
// manifest under the stubbed fetch → the engine is never constructed);
// it imports audio.js for the shared GST_AUDIO_HINT string, and
// audio.js pulls the pure stretch DSP. bomb.js is the canonical
// planted-C4 lifecycle sfx.js's beep scheduler imports (bombEndTick —
// the ONE termination rule; pure over the landmark rows). bullets.js is
// the shot derivation Replay pushes to BOTH the renderer and the sfx
// engine (deriveBullets fails soft to [] against this harness's null
// state index). decoy.js is the decoy rest/noise plan Replay derives
// once per push site (buildDecoyPlan — pure over the draw rows; no
// state index here → shots: [], icon/explosion rows only). roundcut.js
// is the one round-boundary cleanup rule bomb.js (and the renderer)
// delegate their boundary scans to — without the copy the bomb.js graph
// fails to link above.
for (const rel of [
  'playercard.js', 'playercolor.js', 'livestats.js', 'voiceindex.js',
  // voicewindows.js is the pure sparse-window map module audio.js (the
  // audio-real.js copy below re-exports GST_AUDIO_HINT through) imports —
  // copy it or the audio graph fails to link above.
  'voicewindows.js',
  'sfx.js', 'stretch.js', 'bullets.js', 'decoy.js', 'bomb.js', 'roundcut.js',
  // kits.js is the defuse-kit evidence Replay builds (buildKitEvidence
  // over the draw feed + the buytime_ended read) and pushes through
  // setKitEvidence; it imports drops.js for the position rule — copy
  // both or the kit graph fails to link above.
  'kits.js', 'drops.js',
  // playercard.js now resolves its held-item prefix through
  // replay/loadout.js (the one loadout vocabulary) — copy it too, or the
  // card graph fails to link (its own deps, landmarks.js + bullets.js,
  // are already in this list).
  'loadout.js',
]) {
  writeFileSync(join(dir, 'replay', rel), readFileSync(join('src/lib/replay', rel), 'utf8'));
}

// The player-state loader is fetch-based: stub it so the suite pins the
// VIEW's fail-soft contract deterministically — the mounted replay (id 1)
// mounts against a match with NO state stream (the stub's loadState
// resolves null, the absent-stream path): no note, the cards render
// state-less. stateAt is the bullets.js import (its magAmmo walk);
// slotStateAt the renderer/decoy import — a null index means both never
// reach a real series.
writeFileSync(
  join(dir, 'replay', 'state.js'),
  `export async function fetchStateMeta() {
  return { players: [], weaponNames: [] };
}
export async function fetchState() {
  return null;
}
export async function loadState() {
  return null;
}
export function slotStateAt() {
  return null;
}
export function stateAt() {
  return null;
}
`,
);

// Icon manifest/preload are fetch/DOM-based: a small extracted manifest
// (so no extractIcons retry runs) whose preloaded values are null — the
// cards' text-fallback path stays deterministic either way.
writeFileSync(
  join(dir, 'replay', 'icons.js'),
  `export const loadIconManifest = () =>
  Promise.resolve({
    extracted: true,
    count: 1,
    icons: { 'AK-47': '/api/icons/ak47.svg' },
    note: '',
  });
export const preloadIcons = async (names) =>
  new Map((names || []).map((n) => [n, null]));
export const resetIconManifest = () => {};
export const iconURL = (name, manifest) =>
  (manifest && manifest.icons && manifest.icons[name]) || null;
`,
);

// The view's data source and platform glue are scripted, never a live
// Wails backend or a real render loop: sidecar meta resolves, every feed
// read is empty except the CONNECTION rows (the card-visibility rule),
// and the engine/renderer/input are inert objects.
writeFileSync(
  join(dir, 'services.js'),
  `export const getReplayMeta = () =>
  Promise.resolve({
    hasSidecar: true,
    tickRate: 64,
    frames: 10,
    // Roster for the card columns: 3 finished-ct, 2 finished-t, plus one
    // player with NO final side — grouping must place them left (last-
    // payload fallback finds nothing: the stubbed positions have no mask)
    // without inventing a side for them. Two players carry a teammate
    // COLOR (the raw m_iCompTeammateColor the sidecar carries — 0 blue,
    // 4 purple); the rest carry none, which must render NO ring.
    players: [
      { steamId: '76561198000000001', name: 'Alpha1', side: 'ct', color: 0 },
      { steamId: '76561198000000002', name: 'Alpha2', side: 'ct' },
      { steamId: '76561198000000003', name: 'Alpha3', side: 'ct' },
      { steamId: '76561198000000004', name: 'Bravo1', side: 't', color: 4 },
      { steamId: '76561198000000005', name: 'Bravo2', side: 't' },
      { steamId: '76561198000000006', name: 'Lone', side: '' },
    ],
  });
// Connection rows (player_connect / player_disconnect) for the card
// visibility rule (playercard.js connectedAt): everyone is in the match
// from tick 0; Alpha3 drops out at 192 and is back at 320 (hidden in
// between); Lone is a LATE joiner with NO presence before its 448
// connect (the nuke bot's shape — a roster slot that exists before the
// player does); Bravo1's first event is a disconnect at 1000 (the tail,
// only reachable through the +/-15s transport). Every OTHER read
// (drawRows, the blind join, the feed) stays empty as before.
const CONN_ROWS = [
  { kind: 'player_connect', tick: 0, attacker: '76561198000000001' },
  { kind: 'player_connect', tick: 0, attacker: '76561198000000002' },
  { kind: 'player_connect', tick: 0, attacker: '76561198000000003' },
  { kind: 'player_connect', tick: 0, attacker: '76561198000000004' },
  { kind: 'player_connect', tick: 0, attacker: '76561198000000005' },
  { kind: 'player_disconnect', tick: 192, attacker: '76561198000000003' },
  { kind: 'player_connect', tick: 320, attacker: '76561198000000003' },
  { kind: 'player_connect', tick: 448, attacker: '76561198000000006' },
  { kind: 'player_disconnect', tick: 1000, attacker: '76561198000000004' },
];
// Defuse-kit evidence rows for the card plumbing: ONE kit pickup (a
// GAIN for Alpha1 — a buy at the round's start still counts as
// possession) plus the round's round_start, so hasKitAt can scope the
// gain to a round (kits.js roundContaining). The view joins these with
// its single buytime_ended read below. Every OTHER read (drawRows for
// the other kinds, the blind join, the feed) stays empty as before.
const KIT_ROWS = [
  { id: 900, seq: 900, kind: 'round_start', tick: 0, round: 1 },
  {
    id: 901,
    seq: 901,
    kind: 'weapon_pickup',
    tick: 0,
    round: 1,
    weapon: 'Defuse Kit',
    attacker: '76561198000000001',
    posX: 10,
    posY: 20,
    posZ: 0,
  },
];
export const getEvents = (filter) => {
  const kinds = (filter && filter.kinds) || [];
  if (kinds.includes('player_connect') || kinds.includes('player_disconnect')) {
    return Promise.resolve(CONN_ROWS);
  }
  if (kinds.includes('weapon_pickup')) {
    return Promise.resolve(KIT_ROWS); // the DRAW_KINDS read
  }
  return Promise.resolve([]);
};
export const getEvent = () => Promise.resolve(null);
// Flash-white overlay durations (matched to blind rows by seq) — none
// in the stub: the view's join yields [] and setBlinds receives it.
export const getBlindDurations = () => Promise.resolve([]);
// Death-drop payload projection (cat/mag/reserve by seq) — none in the
// stub: the view's join leaves every weapon_drop row unstamped (the
// fail-soft path drawDrops draws nothing for).
export const getDropDetails = () => Promise.resolve([]);
// Player sounds (sound_events): the fixture has NONE — presence reports
// total 0, so the view's gate fetches NOTHING (the presence-zero path:
// no rows, no cues, no error) and the sound-events read below is never
// reached in this harness.
export const getSoundEventPresence = () => Promise.resolve({ matchId: 1, total: 0, byKind: {} });
export const getSoundEvents = () => Promise.resolve([]);
export const getChat = () => Promise.resolve([]);
// buytime_ended — the ONE generic read the kit evidence needs (the
// view's buy-vs-ground boundary). Round 1's buy window ended at tick 10
// (the fixture's kit pickup at tick 0 is therefore a BUY — a gain, never
// a drop terminator, which is exactly what the card badge pins).
export const getGenericEvents = (id, name) =>
  Promise.resolve(
    name === 'buytime_ended'
      ? [{ rowId: 1, name: 'buytime_ended', tick: 10, round: 1, payloadJson: '{}' }]
      : [],
  );
export const getGenericHistogram = () => Promise.resolve([]);
export const getMatch = () => Promise.resolve({ map: '', sideSwitches: 1 });
export const getRounds = () =>
  Promise.resolve([
    { number: 1, winner: 'ct', reason: 'CTWin', startTick: 0, endTick: 576, freezeEndTick: 64, warmup: false, pregame: false, bombSite: '' },
    { number: 2, winner: 't', reason: 'BombDefused', startTick: 640, endTick: 1216, freezeEndTick: 704, warmup: false, pregame: false, bombSite: 'A' },
  ]);
export const getTeamNames = () => Promise.resolve({ ct: 'Alpha', t: 'Bravo' });
export const getScoreboard = () => Promise.resolve([]);
// Voice: the fixture has NO voice (presence null → the whole voice index
// read below is gated off), but the view links getVoiceIndex like the
// other reads — the stub resolves null, which the view treats as the
// fail-soft "no players / no lanes / no window map" result.
export const getVoicePresence = () => Promise.resolve(null);
export const getVoicePlayers = () => Promise.resolve([]);
export const getVoiceLanes = () => Promise.resolve(null);
export const getVoiceIndex = () => Promise.resolve(null);
export const voiceWavURL = () => '';
export const extractIcons = () => Promise.resolve({ ok: false });
export const listSavedFilters = () => Promise.resolve([]);
export const saveFilter = () => Promise.resolve(null);
export const deleteSavedFilter = () => Promise.resolve(null);
// Pref store: a FRESH profile by default (every key unset — undefined,
// exactly what a fresh kvstore yields), but written through by the view:
// setPref persists into it and getPref both records the KEYS the view
// reads (the mount-time drop_layers read IS the reload path) and serves
// the stored value back. Only the drop-layer test writes here; every
// other pref read (camera_mode, show_knife_warmup_rounds, the volumes)
// still resolves undefined on a fresh profile.
const PREFS = (globalThis.__prefs = globalThis.__prefs || {});
const PREF_READS = (globalThis.__prefReads = globalThis.__prefReads || []);
export const getPref = (key) => {
  PREF_READS.push(key);
  return Promise.resolve(PREFS[key]);
};
export const setPref = (key, value) => {
  PREFS[key] = value;
  return Promise.resolve();
};
export const errText = (e) => (e == null ? 'unknown error' : String((e && e.message) || e));
`,
);

writeFileSync(
  join(dir, 'replay', 'engine.js'),
  `export const SPEEDS = [0.25, 0.5, 1, 2, 4];
export const parsePositions = () => ({
  frames: 10,
  ticks: [0, 64, 128, 192, 256, 320, 384, 448, 512, 576],
});
export function createEngine(data, tickRate) {
  const state = {
    frame: 0,
    tick: 0,
    playing: false,
    speed: 1,
    followSlot: null,
    skipFreeze: false,
    loopFrom: -1,
    loopTo: -1,
    loopEnabled: false,
  };
  let emit = null;
  // Rounds only satisfy the view's startEngine push (setRounds): this
  // stub never pumps loop(), so the freeze skip itself — a PLAYBACK rule
  // — is pinned in src/lib/engine.test.js against the real engine.
  function setRounds() {}
  // skipFreeze state/setters, mirrored from the REAL engine (engine.js)
  // so the toolbar toggle's aria-pressed/warn round trip is observable.
  function setSkipFreeze(on) {
    const next = !!on;
    if (state.skipFreeze === next) return;
    state.skipFreeze = next;
    emit?.(state);
  }
  function toggleSkipFreeze() {
    setSkipFreeze(!state.skipFreeze);
  }
  // Loop state, mirrored from the REAL engine (engine.js) so the
  // view's range-edit rule and the entry ?loop= apply are observable:
  // setLoop writes frame bounds (either < 0 clears, invalid bounds
  // force loopEnabled OFF) and NEVER enables; setLoopEnabled arms/
  // disarms explicitly (arming without a valid range is a no-op);
  // toggleLoop keeps the enable-when-off semantics (and its 10 s
  // default range) the transport's Loop button and the L key drive.
  function setLoop(a, b) {
    const fa = a == null || a < 0 ? -1 : Math.max(0, Math.min(data.frames - 1, Math.round(a)));
    const fb = b == null || b < 0 ? -1 : Math.max(0, Math.min(data.frames - 1, Math.round(b)));
    state.loopFrom = fa;
    state.loopTo = fb;
    if (fa < 0 || fb < 0 || fa > fb) state.loopEnabled = false;
    emit?.(state);
  }
  function setLoopEnabled(on) {
    const next = !!on;
    if (next && (state.loopFrom < 0 || state.loopTo < state.loopFrom)) return;
    if (state.loopEnabled === next) return;
    state.loopEnabled = next;
    emit?.(state);
  }
  function toggleLoop() {
    if (!state.loopEnabled) {
      if (state.loopFrom < 0 || state.loopTo < state.loopFrom) {
        const from = state.frame;
        state.loopFrom = from;
        state.loopTo = Math.min(data.frames - 1, from + Math.round(tickRate * 10));
      }
      state.loopEnabled = true;
    } else {
      state.loopEnabled = false;
    }
    emit?.(state);
  }
  // The loop popover resolves typed TIMES through the engine's
  // exact-frame search (Replay's onLoopTime) — same rule as the real
  // engine: the first frame whose tick is >= t, clamped to the stream
  // (the stub's ticks are 0, 64, … 576).
  function frameForTick(t) {
    const f = Number.isFinite(t) ? Math.floor(t / 64) : 0;
    return Math.max(0, Math.min(9, f));
  }
  // LOOP-EXIT GUARD, mirrored from the REAL engine (engine.js
  // cancelLoopIfOutside): a seek landing outside the armed range drops
  // the flag and RETAINS the bounds (one click re-arms), inclusive at
  // both ends. The stub keeps state.tick RAW (its transport pins read
  // the unclamped tick), so seekTick computes the landing frame exactly
  // as the real one does — frameForTick over the tick — WITHOUT
  // rewriting state.frame.
  function cancelLoopIfOutside(f) {
    if (state.loopEnabled && (f < state.loopFrom || f > state.loopTo)) setLoopEnabled(false);
  }
  return {
    state,
    tickRate,
    onChange(cb) {
      emit = cb;
      return () => {
        emit = null;
      };
    },
    seekTick(t) {
      // Logged so section K can pin the keep-alive seed contract (a
      // distinct seed applies exactly once; identical-value churn and a
      // no-promise rewrite never re-seek). seekFrame (scrubbing) is
      // deliberately NOT a seed path and stays unlogged.
      globalThis.__seeks = (globalThis.__seeks || []).concat(t);
      state.tick = t;
      cancelLoopIfOutside(frameForTick(t));
      emit?.(state);
    },
    seekFrame(f) {
      // The REAL engine derives the tick from the frame it lands on
      // (engine.js seekFrame: state.tick = ticks[clamped]) — the stub
      // mirrors it so a scrub through the UI advances uiTick too (the
      // card-visibility rule reads the playhead).
      const clamped = Math.max(0, Math.min(data.frames - 1, Math.round(f)));
      state.frame = clamped;
      state.tick = data.ticks[clamped];
      cancelLoopIfOutside(clamped);
      emit?.(state);
    },
    play() {
      // Counted so section J can pin the keep-alive play/pause contract
      // (an inactive load never autoplays; activation resumes exactly
      // once; a deliberate pause is never resumed; expand-after-dock-play
      // adds NO new call). The early-return mirrors the REAL engine
      // (engine.js play: "if (state.playing …) return"): a redundant
      // play while already running is a no-op and is NOT counted — the
      // activation effect calls play() unconditionally when wasPlaying is
      // set, so after a dock-play the expand leg's call must not inflate
      // the counter. (pause() deliberately keeps counting every CALL —
      // the "no second pause" pins use the counter as a call-detector
      // for the view's guard.)
      if (state.playing) return;
      globalThis.__plays = (globalThis.__plays || 0) + 1;
      state.playing = true;
      emit?.(state);
    },
    pause() {
      // The real engine API's pause (engine.js L400+) — the keep-alive's
      // deactivate calls it. Mirrored (state + emit) and counted like
      // play; absent from the old stub because nothing could pause a
      // harness instance before the keep-alive existed.
      globalThis.__pauses = (globalThis.__pauses || 0) + 1;
      state.playing = false;
      emit?.(state);
    },
    toggle() {
      state.playing = !state.playing;
      emit?.(state);
    },
    setSpeed(s) {
      state.speed = s;
      emit?.(state);
    },
    setLoop,
    setLoopEnabled,
    toggleLoop,
    frameForTick,
    setRounds,
    setSkipFreeze,
    toggleSkipFreeze,
    setFollow(s) {
      state.followSlot = s;
      emit?.(state);
    },
    destroy() {
      emit = null;
    },
  };
}
`,
);

writeFileSync(
  join(dir, 'replay', 'renderer.js'),
  `export function createRenderer() {
  return {
    setPack() {},
    setLandmarks() {},
    setBlinds() {},
    setChat() {},
    setBullets() {},
    setDecoyPlan() {},
    setKitEvidence(v) {
      // Recorded so the driver can pin the kit-evidence wiring: the
      // view pushes the buildKitEvidence result beside setLandmarks.
      globalThis.__kitEvidence = v || null;
    },
    setDropLayers(v) {
      // Recorded so the driver can pin the toolbar wiring: startEngine
      // pushes the current (default all-off) state, every checkbox
      // toggle pushes the new triple.
      globalThis.__dropLayers = {
        guns: !!(v && v.guns),
        util: !!(v && v.util),
        kits: !!(v && v.kits),
      };
    },
    setHud() {},
    setOverlaysVisible(v) {
      // Recorded so the driver can pin the toolbar wiring: startEngine
      // pushes the current (default shown) state, #rp-ui pushes each
      // flip — one flag, two pushes (the setDropLayers pattern).
      globalThis.__overlays = !!v;
    },
    setIcons() {},
    setVoices() {},
    setStateIndex() {},
    resize() {},
    draw() {},
    // The scrub-drag draw coalescing mark (renderer.requestDraw): a no-op
    // here — this harness's engine/renderer are inert — but the METHOD
    // must exist, or Replay's onScrub would throw on the very first
    // scrubber input event.
    requestDraw() {},
    setCameraMode() {},
    destroy() {},
  };
}
// The canonical side rule the view imports (the real renderer.js exports
// the same function — the bit arithmetic is duplicated here only because
// the harness replaces the whole canvas module).
export function sideFromFlags(flagsByte, finalSide = '') {
  const b = (flagsByte >> 2) & 3;
  return (b === 1 ? 't' : b === 2 ? 'ct' : '') || finalSide || '';
}
// …and the HUD team-name pairing Replay's hudFor calls (same caveat: the
// real implementation lives in renderer.js, unit-tested in
// src/lib/renderer.test.js; this copy exists only so the replaced module
// still exports every name the view links against).
export function hudTeamNames(names, leftSide, rightSide) {
  const left = (names && names.ct) || '';
  const right = (names && names.t) || '';
  const leftOnT = leftSide === 't' || rightSide === 'ct';
  return leftOnT ? { ct: right, t: left } : { ct: left, t: right };
}
`,
);

writeFileSync(
  join(dir, 'replay', 'input.js'),
  `export const attachReplayInput = () => ({ detach() {} });
export const snapshot = () => {};
`,
);

// The voice engine stays INERT (this harness never constructs it — the
// stubbed getVoicePresence resolves null), but replay/sfx.js imports the
// SHARED GST_AUDIO_HINT string from audio.js: re-export it from a
// verbatim copy of the real module (one spelling of the message; the
// copy's own imports resolve against this cache's stubs) while the
// engine itself stays stubbed.
writeFileSync(
  join(dir, 'replay', 'audio-real.js'),
  readFileSync('src/lib/replay/audio.js', 'utf8'),
);
writeFileSync(
  join(dir, 'replay', 'audio.js'),
  `export { GST_AUDIO_HINT } from './audio-real.js';
export const createVoiceEngine = () => null;
export const fetchVoicePCM = async () => new Float32Array(0);
`,
);

writeFileSync(
  join(dir, 'components', 'mapxform.js'),
  `export const loadMapPack = async () => ({ pack: null, transform: null, img: null });
`,
);

writeFileSync(join(dir, 'save.js'), `export const saveExportURL = async () => '';\n`);
writeFileSync(
  join(dir, 'download.js'),
  `export const downloadBlob = async () => '';
export const downloadText = async () => '';
`,
);

// The child components — only their ./X.svelte imports need rewriting
// to the compiled .js (ProfileLink is shared by LandmarkRow; TeamColumn
// imports PlayerCard, so both card components join the list). RoundStrip
// additionally reads the kvstore binding (the knife/warmup pref), whose
// import is rewritten to the components/kvstore.js stub above.
for (const name of [
  'ProfileLink', 'FilterBar', 'EventFlags', 'PayloadTree', 'LandmarkRow', 'Popover', 'RoundStrip',
  'PlayerCard', 'TeamColumn',
]) {
  let src = readFileSync(`src/lib/components/${name}.svelte`, 'utf8').replace(
    /from '\.\/(\w+)\.svelte'/g,
    "from './$1.js'",
  );
  if (name === 'RoundStrip') {
    src = src.replace(
      "from '../../../bindings/github.com/wailsapp/wails/v3/pkg/services/kvstore'",
      "from './kvstore.js'",
    );
  }
  svelteCompile(src, `${name}.svelte`, join(dir, 'components', `${name}.js`));
}

// Replay.svelte → its ../ imports land in dir/ (services.js above, engine/
// renderer/input/audio stubs, replay/landmarks copied); only the
// .svelte component imports need rewriting to their compiled .js.
const replaySrc = readFileSync('src/lib/views/Replay.svelte', 'utf8').replace(
  /from '\.\.\/components\/(\w+)\.svelte'/g,
  "from '../components/$1.js'",
);
svelteCompile(replaySrc, 'Replay.svelte', join(dir, 'views', 'Replay.js'));

const harnessSrc = `<script>
  import Replay from './views/Replay.js';
</script>
<Replay id={1} query={{}} nav={(h) => (globalThis.__nav = (globalThis.__nav || []).concat(h))} />`;
const harnessOut = join(dir, 'harness.js');
svelteCompile(harnessSrc, 'harness.svelte', harnessOut);

const { mount } = await import('svelte');
// A compile/link/mount failure below would otherwise be swallowed by the
// uncaughtException handler above and exit 0 — fail loudly instead.
let target;
try {
  const mod = await import(pathToFileURL(harnessOut).href);
  target = document.createElement('div');
  document.body.appendChild(target);
  mount(mod.default, { target });
} catch (e) {
  console.error('HARNESS LOAD FAILED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
}

const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));
await sleep(); // let load() run its promise chain (meta → sidecar → data)

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const children = (el) => [...el.children];

console.log('A. fresh replay: no header/title; back + ribbon + rail toggle share ONE top line of the main column');
const stage = target.querySelector('.replay-stage');
check('stage rendered', !!stage);
check('no view header and no Replay title', !target.querySelector('.view-header') && !target.querySelector('h1'));
const view = target.querySelector('.replay-view');
const main = view?.querySelector(':scope > .replay-main');
check('main column is a direct child of the view (the view is the row)', !!main, 'missing .replay-main');
check('no .replay-cols wrapper anymore', !view?.querySelector('.replay-cols'));
const topbar = main?.querySelector(':scope > .replay-topbar');
check('top bar is the FIRST child of the main column', !!topbar && children(main)[0] === topbar, 'missing .replay-topbar first');
const back = topbar?.querySelector('.rp-back');
check(
  'back button lives in the top bar, NOT inside the stage',
  !!back && !stage.querySelector('.rp-back'),
  'missing top-bar .rp-back',
);
check(
  'back button is the arrow-left codicon PLUS the Back text (like other views)',
  back?.getAttribute('aria-label') === 'Back' && back?.getAttribute('title') === 'Back' &&
    !!back?.querySelector('.codicon-arrow-left') && back?.textContent.trim() === 'Back',
  back ? JSON.stringify(back.textContent) : 'missing',
);
const toggle = topbar?.querySelector('.side-toggle');
check(
  'collapsed rail toggle lives in the top bar, NOT inside the stage',
  !!toggle && !stage.querySelector('.side-toggle'),
  'missing top-bar .side-toggle',
);
check(
  'bar order: back first, ribbon cell second, rail toggle last',
  topbar && children(topbar)[0] === back && children(topbar)[1]?.classList.contains('rp-ribbon') &&
    children(topbar)[children(topbar).length - 1] === toggle,
  (topbar ? children(topbar).map((el) => el.className || el.tagName).join(' | ') : 'no topbar'),
);
check('no .replay-side while collapsed', !target.querySelector('.replay-side'));
check('toggle aria-expanded=false', toggle?.getAttribute('aria-expanded') === 'false', toggle?.getAttribute('aria-expanded'));
check(
  'toggle title/aria-label carry the event count',
  toggle?.getAttribute('aria-label') === 'Events (0 events)' &&
    toggle?.getAttribute('title') === 'Events (0 events)',
  toggle?.getAttribute('aria-label'),
);
check('collapsed handle shows the chevron-left glyph', !!toggle?.querySelector('.codicon-chevron-left'));
check('feed toolbar absent while collapsed', !target.querySelector('.lm-toolbar'));
check('landmark list absent while collapsed', !target.querySelector('.landmark-list'));

console.log('B. the top-bar handle expands the panel (existing eventsOpen toggle)');
click(toggle);
await sleep();
const aside = target.querySelector('.replay-side');
check('aside expanded', !!aside && !aside.classList.contains('collapsed'));
check('top-bar toggle gone while expanded', !topbar.querySelector('.side-toggle'));
check(
  'expanded aside joins the view row beside the main column',
  view?.querySelector(':scope > .replay-side') === aside,
  'aside not a direct child of .replay-view',
);
const head = aside?.querySelector('.side-toggle');
check('expanded header owns the toggle', !!head);
check('header aria-expanded=true', head?.getAttribute('aria-expanded') === 'true', head?.getAttribute('aria-expanded'));
check('expanded header renders the count', head?.querySelector('.num')?.textContent === '0', head?.querySelector('.num')?.textContent);
check('feed toolbar present', !!aside?.querySelector('.lm-toolbar'));
check('landmark list present (empty state)', !!aside?.querySelector('.landmark-list'));
check('expanded panel keeps its scroll body', !!aside?.querySelector('.lm-scroll'));
click(head);
await sleep();
check('header chevron collapses the rail again', !target.querySelector('.replay-side') && !!topbar.querySelector('.side-toggle'));

console.log('C. round ribbon: rides the top line (the .rp-ribbon cell), centered above the stage');
const ribbon = topbar?.querySelector(':scope > .rp-ribbon > .round-strip-wrap');
check(
  'ribbon mounted in the top bar\'s .rp-ribbon cell (not a loose .replay-main child)',
  !!topbar?.querySelector(':scope > .rp-ribbon') && !!ribbon,
  'missing .rp-ribbon / .round-strip-wrap',
);
const ribbonCells = ribbon ? [...ribbon.querySelectorAll('.round-cell')] : [];
check(
  'ribbon cells render the counted rounds (knife/warmup hidden by default)',
  JSON.stringify(ribbonCells.map((c) => c.textContent.trim())) === '["1","2"]',
  JSON.stringify(ribbonCells.map((c) => c.textContent.trim())),
);
check(
  'team labels ride the ribbon (getTeamNames)',
  ribbon?.querySelector('.round-strip-team.above')?.textContent.trim() === 'Alpha' &&
    ribbon?.querySelector('.round-strip-team.below')?.textContent.trim() === 'Bravo',
);
check('the playhead round is marked current', !!ribbon?.querySelector('.round-cell.current'));
const body = main?.querySelector('.replay-body');
check('the ribbon sits ABOVE the stage in the column', !!body && !!(ribbon.compareDocumentPosition(body) & 4), 'wrong order'); // DOCUMENT_POSITION_FOLLOWING
const navBefore = (globalThis.__nav || []).length;
click(ribbonCells.find((c) => c.textContent.trim() === '2'));
await sleep();
const readout0 = main.querySelector('.replay-readout');
check(
  'ribbon click seeks the replay to that round start tick (no nav)',
  readout0?.getAttribute('title')?.includes('tick 640') && (globalThis.__nav || []).length === navBefore,
  readout0?.getAttribute('title'),
);

console.log('D. transport: scrubber on its own full-width line above the CENTERED controls');
const transport = target.querySelector('.replay-transport');
check('transport block rendered', !!transport);
const lines = children(transport);
check(
  'two lines: scrub line then control cluster',
  lines.length === 2 && lines[0].classList.contains('replay-scrub') && lines[1].classList.contains('toolbar'),
  lines.map((el) => el.className).join(' | '),
);
const scrub = lines[0];
check('scrubber sits on the scrub line', !!scrub.querySelector('.scrubber-wrap > input.scrubber'));
const readout = scrub.querySelector('.replay-readout');
check('game-time readout rides with the scrubber', !!readout);
check(
  'visible text is overall game time (m:ss / m:ss), never ticks',
  /^\d+:\d\d \/ \d+:\d\d$/.test(readout?.textContent.trim() || ''),
  readout?.textContent,
);
check(
  'frame/tick detail kept in the title tooltip',
  (readout?.getAttribute('title') || '').includes('frame 1/10') &&
    (readout?.getAttribute('title') || '').includes('tick 640'),
  readout?.getAttribute('title'),
);
check(
  'scrub line holds only the scrubber wrap + readout (full-width, no controls)',
  children(scrub).length === 2 && children(scrub)[0].classList.contains('scrubber-wrap') &&
    children(scrub)[1].classList.contains('replay-readout'),
  children(scrub).map((el) => el.className).join(' | '),
);
const controls = lines[1];
// Autoplay (spec: "start playing immediately once ready"): startEngine
// calls engine.play() once the position data is up, so the toggle
// mirrors the PLAYING state and reads Pause.
check('replay autoplays on launch — play button reads Pause', !!controls.querySelector('button[aria-label="Pause"]'));
check(
  'transport cluster order: prev round, −15s, play, +15s, next round, speed…',
  (() => {
    const ids = ['rp-round-prev', 'rp-seek-back', null, 'rp-seek-fwd', 'rp-round-next'];
    const kids = children(controls);
    // the play cell reads Pause (the replay autoplays on launch)
    const idx = (sel) => kids.findIndex((el) => (sel ? el.id === sel : el.getAttribute('aria-label') === 'Pause'));
    const pos = ids.map(idx);
    return pos.every((p) => p >= 0) && pos[0] < pos[1] && pos[1] < pos[2] && pos[2] < pos[3] && pos[3] < pos[4];
  })(),
  children(controls).map((el) => el.id || el.getAttribute('aria-label') || el.className).join(' | '),
);
check(
  '±15s buttons are icon-only with their second-count titles',
  controls.querySelector('#rp-seek-back[title="Seek −15 seconds"] .codicon-arrow-small-left') &&
    controls.querySelector('#rp-seek-fwd[title="Seek +15 seconds"] .codicon-arrow-small-right') &&
    !controls.querySelector('#rp-seek-back').textContent.trim() &&
    !controls.querySelector('#rp-seek-fwd').textContent.trim(),
);
check(
  'round transport buttons are icon-only, disabled at the round we are on (last round → no next)',
  controls.querySelector('#rp-round-prev[title="Previous round"] .codicon-chevron-left') &&
    controls.querySelector('#rp-round-next[title="Next round"] .codicon-chevron-right') &&
    !controls.querySelector('#rp-round-prev').disabled &&
    controls.querySelector('#rp-round-next').disabled === true,
  `prev=${controls.querySelector('#rp-round-prev')?.disabled} next=${controls.querySelector('#rp-round-next')?.disabled}`,
);
// Characterization → new contract: speed and camera WERE native
// <select>s ("PLAIN native dropdown"); they are now POPOVERS — the loop
// control's pattern, a trigger button inside an .rp-pop-host span with
// the options only in the panel (spec: the selects looked disjointed
// from the icon buttons around them). The ids stay on the host SPANS so
// the cluster-order and separator checks below keep addressing the same
// cells.
check(
  'speed + camera popover triggers in the cluster (NO jump-to-round select)',
  !!controls.querySelector('#rp-speed button') && !!controls.querySelector('#rp-cam button') &&
    !controls.querySelector('#rp-round'),
);
check(
  'no native select left in the cluster (speed, camera and follow are all popovers)',
  !controls.querySelector('select#rp-speed') && !controls.querySelector('select#rp-cam') &&
    !controls.querySelector('#rp-speed select') && !controls.querySelector('#rp-cam select') &&
    !controls.querySelector('#rp-follow select') && !controls.querySelector('select#rp-follow'),
);
check(
  'camera trigger reads the ACTIVE mode (Smart) and reports collapsed',
  controls.querySelector('#rp-cam button')?.textContent.trim() === 'Smart' &&
    controls.querySelector('#rp-cam button')?.getAttribute('aria-expanded') === 'false',
  controls.querySelector('#rp-cam button')?.textContent,
);
check(
  'speed trigger reads the current step in the select\'s own "1×" format',
  controls.querySelector('#rp-speed button')?.textContent.trim() === '1×',
  controls.querySelector('#rp-speed button')?.textContent,
);
check(
  'camera trigger keeps the select\'s title, with no icon class/codicon beside it',
  !!controls.querySelector('#rp-cam button[title^="Smart keeps every player"]') &&
    !controls.querySelector('.rp-cam-wrap') &&
    !controls.querySelector('#rp-cam ~ .codicon-device-camera-video') &&
    !controls.querySelector('#rp-cam .codicon'),
);
// The follow selector hosts with the MODE (only while Follow is armed,
// exactly where the old <select> sat) — so a fresh replay has no
// #rp-follow cell at all yet.
check('no follow-player selector until Follow is chosen', !controls.querySelector('#rp-follow'));
check('no leftover voice bar / lanes', !target.querySelector('.voice-bar') && !target.querySelector('.voice-lanes-wrap'));
// CHARACTERIZATION: these three checks pinned the old mute-all button —
// a direct-child button[aria-label="Mute all"], disabled because this
// fixture has NO voice, with separator 2 immediately behind it. Delta:
// that button is now the VOLUME POPOVER's trigger inside a host span
// (same cluster slot), it is NEVER disabled (voice is one row of six —
// only the popover's Voice row disables), and separator 2 still follows
// the host. The new popover coverage sits below the separator checks.
const volHost = controls.querySelector('.rp-pop-host.rp-vol');
const volBtn = controls.querySelector('button[aria-label="Volume"]');
check('volume popover trigger in the cluster (replaces mute-all)', !!volHost && !!volBtn);
check(
  'volume trigger is icon-only and NOT disabled without voice',
  !!volBtn && !!volBtn.querySelector('.codicon-unmute') && !volBtn.textContent.trim() &&
    volBtn.disabled === false,
  String(volBtn?.disabled),
);
check('no leftover mute-all button in the cluster', !controls.querySelector('button[aria-label="Mute all"]'));
const snap = controls.querySelector('button[aria-label="Snapshot"]');
check(
  'snapshot is icon-only in the cluster (no text label)',
  !!snap && !!snap.querySelector('.codicon-device-camera') && !snap.textContent.trim(),
  snap ? JSON.stringify(snap.textContent) : 'missing',
);
const clip = controls.querySelector('.clip-btn');
check(
  'record is icon-only in the cluster (no text label)',
  !!clip && !!clip.querySelector('.codicon-record') && !clip.textContent.trim() &&
    clip.getAttribute('aria-label') === 'Record clip',
  clip ? JSON.stringify(clip.textContent) : 'missing',
);
check(
  'hints: codicon only, the word "hints" is gone, and it is the LAST cell',
  (() => {
    const hints = controls.querySelector('.codicon-keyboard')?.parentElement;
    return !!hints && !controls.textContent.includes('hints') &&
      children(controls)[children(controls).length - 1] === hints;
  })(),
);
// B3 — the shortcuts ride the title ONE PER LINE ('\n' is what stacks
// them; the old ' · ' join rendered as one long line). jsdom can only
// prove the ATTRIBUTE carries the ten lines — that '\n' actually stacks
// them in a rendered tooltip is the one thing left to the human GUI
// smoke (no CSS/DOM rendering of title tooltips here).
check(
  'hints title carries the 10 shortcuts, one per line',
  (() => {
    const want = [
      'Space play/pause', ', . speed', '←/→ step', 'Shift+←/→ ±64 frames (~1s)',
      '[ ] round', 'L loop', 'F follow', '1-9, 0 select', 'X skip freeze', 'S snapshot',
    ];
    const hints = controls.querySelector('.codicon-keyboard')?.parentElement;
    const got = (hints?.getAttribute('title') || '').split('\n');
    return JSON.stringify(got) === JSON.stringify(want);
  })(),
  JSON.stringify(
    (controls.querySelector('.codicon-keyboard')?.parentElement?.getAttribute('title') || '').split('\n'),
  ),
);
// Exactly THREE separators split the cluster into groups — each pinned at
// its exact position: after the loop control, after the volume host
// (where mute-all used to sit), and immediately before the keyboard hints
// (which stay the LAST cell).
const seps = children(controls).filter((el) => el.classList.contains('toolbar-sep'));
check('exactly three separators in the control cluster', seps.length === 3, String(seps.length));
const after = (el) => {
  const k = children(controls).indexOf(el);
  return k >= 0 ? children(controls)[k + 1] : null;
};
check(
  'separator 1 sits directly after the loop control (before the camera control)',
  !!seps[0] && seps[0] === after(controls.querySelector('.rp-loop')) &&
    children(controls).indexOf(seps[0]) < children(controls).indexOf(controls.querySelector('#rp-cam')),
  children(controls).map((el) => el.className || el.id || el.getAttribute('aria-label')).join(' | '),
);
check('separator 2 sits directly after the volume host (ex-mute-all slot)', !!seps[1] && seps[1] === after(volHost));
check(
  'separator 3 sits immediately before the keyboard hints (still LAST)',
  (() => {
    const hints = controls.querySelector('.codicon-keyboard')?.parentElement;
    const kids = children(controls);
    return !!seps[2] && !!hints &&
      kids.indexOf(seps[2]) === kids.indexOf(hints) - 1 &&
      kids[kids.length - 1] === hints;
  })(),
);
check('play controls are NOT on the scrub line', !scrub.querySelector('button'));

// Volume popover (the old mute-all button's slot): it opens in place
// above the trigger, exposes the SIX fader rows, and the VOICE row is
// disabled in this no-voice fixture while guns/utility/C4/announcer/
// footsteps stay live
// (they never need the match to have voice).
check('volume popover closed on entry', !controls.querySelector('#rp-vol-voice'));
click(volBtn);
await sleep();
const volRows = [...controls.querySelectorAll('.rp-vol-pop .rp-vol-row')];
check(
  'volume popover has six rows: Voice, Guns, Utility, C4, Announcer, Footsteps',
  volRows.length === 6 &&
    volRows.map((r) => (r.querySelector('.field-label')?.textContent || '').trim()).join(',') ===
      'Voice,Guns,Utility,C4,Announcer,Footsteps',
  volRows.map((r) => (r.querySelector('.field-label')?.textContent || '?').trim()).join(','),
);
check(
  'each row has a 0..100 range fader and a mute toggle button',
  volRows.length === 6 &&
    volRows.every((r) => {
      const slider = r.querySelector('input[type="range"]');
      return (
        slider &&
        slider.getAttribute('min') === '0' &&
        slider.getAttribute('max') === '100' &&
        r.querySelector('button[aria-label^="Mute "]')
      );
    }),
);
// The FOOTSTEPS fader ships at 100 % (FOOTSTEPS_VOL_DEFAULT — an
// untouched footsteps_volume must bind the 100-slider, never the shared
// 0.8 and never 0) while the bus ships MUTED: the row's mute toggle
// starts pressed + warn, so the user unmutes instead of hunting the
// slider (owner instruction 2026-11-10, A1).
const stepsSlider = controls.querySelector('#rp-vol-footsteps');
const stepsMute = controls.querySelector('button[aria-label="Mute footsteps"]');
check(
  'footsteps fader starts at 100 (its own pref default) with the session mute ON',
  stepsSlider?.value === '100' &&
    globalThis.__prefs['footsteps_volume'] === undefined &&
    !!stepsMute &&
    stepsMute.getAttribute('aria-pressed') === 'true' &&
    stepsMute.classList.contains('warn'),
  `value=${stepsSlider?.value} pref=${JSON.stringify(globalThis.__prefs['footsteps_volume'])} pressed=${stepsMute?.getAttribute('aria-pressed')} warn=${stepsMute?.classList.contains('warn')}`,
);
const voiceSlider = controls.querySelector('#rp-vol-voice');
const voiceMute = controls.querySelector('button[aria-label="Mute voice"]');
check(
  'voice row disabled without voice (slider + mute toggle)',
  !!voiceSlider && voiceSlider.disabled === true && !!voiceMute && voiceMute.disabled === true,
  `slider=${voiceSlider?.disabled} mute=${voiceMute?.disabled}`,
);
check(
  'guns/utility/C4/announcer/footsteps rows stay ENABLED without voice',
  controls.querySelector('#rp-vol-guns')?.disabled === false &&
    controls.querySelector('button[aria-label="Mute guns"]')?.disabled === false &&
    controls.querySelector('#rp-vol-utility')?.disabled === false &&
    controls.querySelector('button[aria-label="Mute utility"]')?.disabled === false &&
    controls.querySelector('#rp-vol-c4')?.disabled === false &&
    controls.querySelector('button[aria-label="Mute c4"]')?.disabled === false &&
    controls.querySelector('#rp-vol-announcer')?.disabled === false &&
    controls.querySelector('button[aria-label="Mute announcer"]')?.disabled === false &&
    controls.querySelector('#rp-vol-footsteps')?.disabled === false &&
    controls.querySelector('button[aria-label="Mute footsteps"]')?.disabled === false,
);
check('trigger reports the popover open (aria-expanded)', volBtn.getAttribute('aria-expanded') === 'true');
click(volBtn); // close again — later checks see the original cluster
await sleep();
check('volume popover closes on a second trigger click', !controls.querySelector('#rp-vol-voice'));

// The transport buttons drive the engine (stubbed): ±15s at the match
// tick rate (64), then the round transport through the round→tick rule.
const readoutTick = () => target.querySelector('.replay-readout')?.getAttribute('title') || '';
click(controls.querySelector('#rp-seek-fwd'));
await sleep();
check('+15s seeks 15 × tickRate ahead (640 → 1600)', readoutTick().includes('tick 1600'), readoutTick());
click(controls.querySelector('#rp-seek-back'));
await sleep();
check('−15s seeks 15 × tickRate back (1600 → 640)', readoutTick().includes('tick 640'), readoutTick());
click(controls.querySelector('#rp-round-prev'));
await sleep();
check('previous round seeks to round 1 start', readoutTick().includes('tick 0'), readoutTick());
check('prev round disabled at the first round', controls.querySelector('#rp-round-prev').disabled === true);
click(controls.querySelector('#rp-round-next'));
await sleep();
check('next round seeks to round 2 start (640)', readoutTick().includes('tick 640'), readoutTick());
check('next round disabled at the last round', controls.querySelector('#rp-round-next').disabled === true);

console.log('E. loop popover (TIMES, not frames) + the speed/camera popovers');
const loopBtn = controls.querySelector('button[aria-label="Loop range"]');
check('loop trigger is an icon-only loop-codicon button', !!loopBtn && !!loopBtn.querySelector('.codicon-sync') && !loopBtn.textContent.trim());
check('loop inputs hidden until the popover opens', !controls.querySelector('#rp-loop-from'));
click(loopBtn);
await sleep();
const loopFrom = controls.querySelector('#rp-loop-from');
const loopTo = controls.querySelector('#rp-loop-to');
check(
  'popover exposes the from/to inputs + the Loop toggle',
  !!loopFrom && !!loopTo && !!controls.querySelector('button[title="Toggle loop (L)"]'),
);
// The bounds are TEXT clocks speaking overall match time ("0:02" = 2 s
// from the stream's first tick — the scrubber's basis), not frame
// numbers; unset bounds render empty over their placeholders.
check(
  'the loop bounds are text clocks, never frame numbers',
  loopFrom?.type === 'text' && loopTo?.type === 'text' &&
    loopFrom?.value === '' && loopTo?.value === '' &&
    loopFrom?.classList.contains('mono') && loopFrom?.classList.contains('loop-input'),
  loopFrom ? `${loopFrom.type} ${JSON.stringify(loopFrom.value)}` : 'missing',
);
check(
  'the loop trigger title says times now',
  !!loopBtn.title.match(/from\/to times/),
  loopBtn.title,
);
// Round trip: type a time → the change handler parses it (fmt.js
// parseClock) to a frame → the derived display re-renders THE SAME
// string (frame → tick → seconds → fmtClock), so re-opening the
// popover never drifts.
loopFrom.value = '0:02';
loopFrom.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'a typed time parses to a frame and re-displays identically',
  controls.querySelector('#rp-loop-from')?.value === '0:02',
  controls.querySelector('#rp-loop-from')?.value,
);
const loopToEl = controls.querySelector('#rp-loop-to');
loopToEl.value = '2'; // the bare-seconds shorthand canonicalises to the clock
loopToEl.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'bare seconds canonicalise ("2" → "0:02")',
  controls.querySelector('#rp-loop-to')?.value === '0:02',
  controls.querySelector('#rp-loop-to')?.value,
);
// Garbage must NOT reach the engine: the field restores what it showed.
loopFrom.value = 'abc';
loopFrom.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'invalid input restores the displayed value (no state change)',
  controls.querySelector('#rp-loop-from')?.value === '0:02',
  controls.querySelector('#rp-loop-from')?.value,
);

// (A) RANGE-EDIT RULE: bound edits never ARM the loop (the edits above
// only wrote bounds) — but once it is ON, an edit that changes a bound
// turns it OFF, so the user starts the NEW range with one click instead
// of stop-then-start.
const loopToggle = controls.querySelector('button[title="Toggle loop (L)"]');
check(
  'the range edits left the loop OFF (setLoop never enables)',
  loopBtn.getAttribute('aria-pressed') === 'false',
  loopBtn.getAttribute('aria-pressed'),
);
click(loopToggle);
await sleep();
check(
  'the Loop toggle arms the edited range (toggleLoop enables when off)',
  loopBtn.getAttribute('aria-pressed') === 'true',
  loopBtn.getAttribute('aria-pressed'),
);
const fromNow = controls.querySelector('#rp-loop-from');
fromNow.value = '0:01';
fromNow.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'editing a bound while looping turns it off',
  loopBtn.getAttribute('aria-pressed') === 'false' && !loopBtn.classList.contains('warn'),
  `${loopBtn.getAttribute('aria-pressed')} warn=${loopBtn.classList.contains('warn')}`,
);
check(
  'the edit itself still landed (from 0:01)',
  controls.querySelector('#rp-loop-from')?.value === '0:01',
  controls.querySelector('#rp-loop-from')?.value,
);

// --- Skip-freeze toggle + the loop seek-exit guard (features A / B) --------
// The toggle mirrors the loop trigger's markup minus the popover and
// sits IMMEDIATELY LEFT of .rp-loop; its state is view-owned
// (uiSkipFreeze), read from the frontend-owned skip_freeze pref in
// load() and written back on every click.
const skipBtn = controls.querySelector('#rp-skip-freeze');
check(
  'skip-freeze toggle sits immediately LEFT of the loop control',
  !!skipBtn && skipBtn.nextElementSibling === controls.querySelector('.rp-loop'),
  skipBtn
    ? `next = ${skipBtn.nextElementSibling?.className || skipBtn.nextElementSibling?.tagName}`
    : 'missing #rp-skip-freeze',
);
check(
  'skip toggle is icon-only (codicon-skip — the shipped font has no fast-forward)',
  !!skipBtn?.querySelector('.codicon-skip') && !skipBtn.textContent.trim(),
  skipBtn ? JSON.stringify(skipBtn.textContent) : 'missing',
);
check(
  'skip-freeze starts OFF on a fresh profile (aria-pressed=false, no warn)',
  skipBtn?.getAttribute('aria-pressed') === 'false' && !skipBtn.classList.contains('warn'),
  skipBtn?.getAttribute('aria-pressed'),
);
check(
  'the view READ skip_freeze on load (the same store a reload reads back)',
  (globalThis.__prefReads || []).includes('skip_freeze'),
  JSON.stringify(globalThis.__prefReads),
);
click(skipBtn);
await sleep();
check(
  'clicking arms it (aria-pressed + warn) and persists the skip_freeze pref',
  skipBtn.getAttribute('aria-pressed') === 'true' &&
    skipBtn.classList.contains('warn') &&
    globalThis.__prefs['skip_freeze'] === true,
  `${skipBtn.getAttribute('aria-pressed')} warn=${skipBtn.classList.contains('warn')} pref=${JSON.stringify(globalThis.__prefs['skip_freeze'])}`,
);
click(skipBtn); // back OFF — the sections below must never skip a freeze
await sleep();
check('second click disarms it', skipBtn.getAttribute('aria-pressed') === 'false');

// (B) LOOP AUTO-CANCEL: arm the edited range (frames 1–2), then seek
// PAST it with +15s — the engine's seek guard drops the flag, the
// bounds RETAIN (one click re-arms) and the trigger un-warns.
click(loopToggle);
await sleep();
check(
  'the edited range re-arms for the seek-exit check',
  loopBtn.getAttribute('aria-pressed') === 'true',
  loopBtn.getAttribute('aria-pressed'),
);
click(controls.querySelector('#rp-seek-fwd')); // 640 → 1600, landing frame 9 > loopTo 2
await sleep();
check(
  'a +15s seek landing past loopTo cancels the loop (trigger un-warns)',
  loopBtn.getAttribute('aria-pressed') === 'false' && !loopBtn.classList.contains('warn'),
  `${loopBtn.getAttribute('aria-pressed')} warn=${loopBtn.classList.contains('warn')}`,
);
// Bounds RETAIN: the guard only flips the flag, so reopening the
// popover shows the same times (only a bound EDIT rewrites them). The
// seek above was an outside click — reopen if it closed the panel.
if (!controls.querySelector('#rp-loop-from')) {
  click(loopBtn);
  await sleep();
}
check(
  'the bounds retain for a one-click re-arm (0:01–0:02 survive the cancel)',
  controls.querySelector('#rp-loop-from')?.value === '0:01' &&
    controls.querySelector('#rp-loop-to')?.value === '0:02',
  `${controls.querySelector('#rp-loop-from')?.value}–${controls.querySelector('#rp-loop-to')?.value}`,
);
click(loopBtn); // close the popover — later sections count toolbar chrome
await sleep();
click(controls.querySelector('#rp-seek-back')); // restore the round-2 playhead
await sleep();
check(
  'the playhead is restored for the sections below (+15s/−15s → tick 640)',
  readoutTick().includes('tick 640'),
  readoutTick(),
);

// Speed: the ladder as a popover (same pattern) — the option button
// drives the SAME onSpeed handler the select used and closes the panel.
const speedBtn = controls.querySelector('#rp-speed button');
click(speedBtn);
await sleep();
const speedOpts = [...controls.querySelectorAll('#rp-speed .rp-speed-pop button')].map(
  (b) => b.textContent.trim(),
);
// The harness's stub engine ships SPEEDS without 8× — the assertion is
// about the POPOVER contract (one option per ladder step, in order).
check(
  'speed popover offers the ladder in the select\'s label format',
  JSON.stringify(speedOpts) === '["0.25×","0.5×","1×","2×","4×"]',
  JSON.stringify(speedOpts),
);
check(
  'the current step is highlighted (.btn.primary)',
  controls.querySelector('#rp-speed .rp-speed-pop button.primary')?.textContent.trim() === '1×',
);
const speed2 = [...controls.querySelectorAll('#rp-speed .rp-speed-pop button')].find(
  (b) => b.textContent.trim() === '2×',
);
click(speed2);
await sleep();
check(
  'choosing a step sets the speed and closes the popover',
  controls.querySelector('#rp-speed button')?.textContent.trim() === '2×' &&
    !controls.querySelector('#rp-speed .rp-speed-pop'),
  controls.querySelector('#rp-speed button')?.textContent,
);

// Camera: drive the SAME onCamMode handler through the popover's option
// buttons (the old select's .value + change dispatch has no equivalent
// on a panel that only mounts when open).
const camBtn = controls.querySelector('#rp-cam button');
const camOpt = (label) =>
  [...controls.querySelectorAll('#rp-cam .rp-cam-pop button')].find(
    (b) => b.textContent.trim() === label,
  );
const chooseCam = async (label) => {
  click(controls.querySelector('#rp-cam button'));
  await sleep();
  click(camOpt(label));
  await sleep();
};
click(camBtn);
await sleep();
const camOpts = [...controls.querySelectorAll('#rp-cam .rp-cam-pop button')].map((b) =>
  b.textContent.trim(),
);
check('camera popover offers Smart/Free/Follow', JSON.stringify(camOpts) === '["Smart","Free","Follow"]', JSON.stringify(camOpts));
check(
  'the active mode is highlighted (.btn.primary)',
  controls.querySelector('#rp-cam .rp-cam-pop button.primary')?.textContent.trim() === 'Smart',
);
click(camOpt('Follow'));
await sleep();
check('the camera popover closes after choosing', !controls.querySelector('#rp-cam .rp-cam-pop'));
// The follow selector is a POPOVER now (the old native <select> read as
// a foreign object among the icon buttons): a trigger showing the
// followed player in the select's own option format, the player list
// inside the panel, the SAME onFollowPlayer handler behind it (the
// option button carries `value`).
check(
  'choosing Follow reveals the follow selector (a popover host, no select)',
  !!controls.querySelector('#rp-follow button') && !controls.querySelector('#rp-follow select'),
);
check(
  'camera trigger still reads the chosen mode',
  controls.querySelector('#rp-cam button')?.textContent.trim() === 'Follow',
  controls.querySelector('#rp-cam button')?.textContent,
);
// Follow must never rest on the "Follow player…" placeholder: with no
// ?follow= in the route it lands on a real player (slot 0), and a
// detour through Free comes back to the player that was being followed.
const followBtn = () => controls.querySelector('#rp-follow button');
check(
  'Follow lands on a real player — the trigger shows it, never the placeholder',
  followBtn()?.textContent.trim() === '1. Alpha1',
  followBtn()?.textContent,
);
click(followBtn());
await sleep();
const followPanelOpts = () => [...controls.querySelectorAll('#rp-follow .rp-follow-pop button')];
const followPanelLabels = () => followPanelOpts().map((b) => b.textContent.trim());
check(
  "the popover lists every player IN the match at the playhead (the select's options)",
  JSON.stringify(followPanelLabels()) ===
    JSON.stringify(['1. Alpha1', '2. Alpha2', '3. Alpha3', '4. Bravo1', '5. Bravo2', '6. Lone']),
  JSON.stringify(followPanelLabels()),
);
check(
  'the followed player is the highlighted option (.btn.primary)',
  followPanelOpts().find((b) => b.classList.contains('primary'))?.textContent.trim() === '1. Alpha1',
  JSON.stringify(followPanelLabels()),
);
check(
  'the trigger carries the keyboard hints (1-9, 0 pick · F toggle)',
  /1-9, 0 picks one/.test(followBtn()?.title || '') && /F toggles follow/.test(followBtn()?.title || ''),
  followBtn()?.title,
);
click(followPanelOpts()[2]); // 3. Alpha3 → slot 2
await sleep();
check(
  'picking a player drives the follow slot and closes the panel',
  followBtn()?.textContent.trim() === '3. Alpha3' &&
    !controls.querySelector('#rp-follow .rp-follow-pop'),
  followBtn()?.textContent,
);
await chooseCam('Free');
check('switching to Free releases follow (the selector goes with Follow mode)', !controls.querySelector('#rp-follow'));
await chooseCam('Follow');
check(
  'switching back to Follow resumes the player that was being followed',
  followBtn()?.textContent.trim() === '3. Alpha3',
  followBtn()?.textContent,
);

// --- The stage's control group (.rp-ctrl-list) -------------------------------
// State entering this section: Follow armed on slot 2 (above), the loop
// cancelled by the earlier +15s seek, skip-freeze back OFF — so the
// group holds exactly those two control rows plus the fixture's
// ever-present packNote (the stubbed match has no map name).
console.log('E1. stage control group: one row per non-default control state, the ONE copy of each line');
const ctrlList = () => stage.querySelector('.rp-ctrl-list');
const ctrlRowEls = () => [...(ctrlList()?.querySelectorAll('.rp-ctrl-row') || [])];
const ctrlTexts = () => ctrlRowEls().map((r) => r.textContent.trim());
check(
  'follow + camera + packNote rows render in the stage top-left group',
  !!ctrlList() &&
    JSON.stringify(ctrlTexts()) ===
      JSON.stringify([
        'Following Alpha3',
        'camera: Follow',
        'Map name unknown — showing a plain grid',
      ]),
  JSON.stringify(ctrlTexts()),
);
check(
  "the packNote is the group's amber row — the ONE copy (no paragraph above the stage)",
  ctrlRowEls()[2]?.classList.contains('rp-ctrl-warn') &&
    ![...target.querySelectorAll('.note-amber')].some((n) =>
      n.textContent.includes('Map name unknown'),
    ),
  JSON.stringify(ctrlTexts()),
);
check('no .follow-chip anywhere (the chip was replaced, not synonymed)', !target.querySelector('.follow-chip'));

// The follow row keeps a REAL dismiss button (the canvas readout could
// never offer one) — the retired chip's button, the same handler.
const dismiss = ctrlList()?.querySelector('button[aria-label^="Stop following"]');
check(
  'the follow row carries the dismiss button (its title still says F)',
  !!dismiss && dismiss.getAttribute('title') === 'Release the follow camera (F)',
  dismiss ? dismiss.getAttribute('title') : 'missing',
);
click(dismiss);
await sleep();
check(
  'dismissing releases follow — and the camera row with it (camMode reconciles to Smart)',
  JSON.stringify(ctrlTexts()) === JSON.stringify(['Map name unknown — showing a plain grid']),
  JSON.stringify(ctrlTexts()),
);

// The loop row is the retired canvas `loop:` line — same text, in match
// time (the popover inputs' own basis).
click(loopBtn);
await sleep();
click(controls.querySelector('button[title="Toggle loop (L)"]'));
await sleep();
check(
  'arming the loop adds its row, in match time',
  ctrlTexts().includes('loop: 0:01–0:02'),
  JSON.stringify(ctrlTexts()),
);
click(controls.querySelector('button[title="Toggle loop (L)"]'));
await sleep();
click(loopBtn); // close the panel — later sections count toolbar chrome
await sleep();
check('disarming drops the loop row', !ctrlTexts().some((t) => t.startsWith('loop:')), JSON.stringify(ctrlTexts()));

// Skip-freeze in the toolbar's wording, and a non-Smart camera.
click(skipBtn);
await sleep();
check(
  "arming skip-freeze adds its row (the toolbar's wording)",
  ctrlTexts().includes('skip freeze: on'),
  JSON.stringify(ctrlTexts()),
);
click(skipBtn);
await sleep();
check('disarming drops the skip-freeze row', !ctrlTexts().includes('skip freeze: on'), JSON.stringify(ctrlTexts()));
await chooseCam('Free');
check('a non-Smart camera adds its row (Smart stays silent)', ctrlTexts().includes('camera: Free'), JSON.stringify(ctrlTexts()));
await chooseCam('Smart');
check(
  'back to Smart drops the camera row — only non-default states render',
  !ctrlTexts().some((t) => t.startsWith('camera:')),
  JSON.stringify(ctrlTexts()),
);

console.log('E1b. loop popover: the ±10 s quick range (clamped at the stream edges, arms the loop)');
// State entering this section: the popover closed by E1's last step,
// bounds 0:01–0:02 (the range-edit rule), loop OFF, playhead at the
// round-2 start (tick 640 over the stub's ticks 0…576 / 10 frames).
click(loopBtn);
await sleep();
const loopPanel10 = controls.querySelector('.rp-loop-pop');
// The sr-only labels are accessibility text, not controls — the VISIBLE
// order is start input, the – separator, stop input, Loop, ±10 s.
const panelKids = children(loopPanel10).filter(
  (el) => !(el.tagName === 'LABEL' && el.classList.contains('sr-only')),
);
check(
  'popover child order: start, stop, Loop, ±10 s',
  panelKids.length === 5 &&
    panelKids[0].id === 'rp-loop-from' &&
    panelKids[1].textContent.trim() === '–' &&
    panelKids[2].id === 'rp-loop-to' &&
    panelKids[3].textContent.trim() === 'Loop' &&
    panelKids[4].textContent.trim() === '±10 s',
  panelKids.map((el) => el.id || el.textContent.trim() || el.tagName).join(' | '),
);
check(
  'the bounds speak start/stop (placeholders + sr-only labels)',
  controls.querySelector('#rp-loop-from')?.placeholder === 'start' &&
    controls.querySelector('#rp-loop-to')?.placeholder === 'stop' &&
    loopPanel10.querySelector('label[for="rp-loop-from"]')?.textContent === 'Loop start time' &&
    loopPanel10.querySelector('label[for="rp-loop-to"]')?.textContent === 'Loop stop time',
  `${controls.querySelector('#rp-loop-from')?.placeholder}/${controls.querySelector('#rp-loop-to')?.placeholder}`,
);
const loop10Btn = panelKids[4];
const navBase10 = (globalThis.__nav || []).length;
click(loop10Btn);
await sleep();
check(
  '±10 s around the playhead (tick 640): 0:00 — 0:09, the `to` clamped to the last frame',
  controls.querySelector('#rp-loop-from')?.value === '0:00' &&
    controls.querySelector('#rp-loop-to')?.value === '0:09',
  `${controls.querySelector('#rp-loop-from')?.value}–${controls.querySelector('#rp-loop-to')?.value}`,
);
check(
  'it ARMS the loop (bounds-then-arm — never the bound-edit rule that disables)',
  loopBtn.getAttribute('aria-pressed') === 'true' && loopBtn.classList.contains('warn'),
  `${loopBtn.getAttribute('aria-pressed')} warn=${loopBtn.classList.contains('warn')}`,
);
check(
  '±10 s writes no navigation (the harness query carries no loop= promise)',
  (globalThis.__nav || []).length === navBase10,
  String((globalThis.__nav || []).length - navBase10),
);
// Near-start clamp: at the stream's first frame the window SHRINKS to
// what exists — `from` floors at 0, it never wraps to the tail.
const scrub0 = scrub.querySelector('input.scrubber');
scrub0.value = '0';
scrub0.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep();
check('the scrub landed on frame 0 (tick 0)', readoutTick().includes('tick 0'), readoutTick());
click(loop10Btn);
await sleep();
check(
  '±10 s at tick 0 clamps BOTH edges to the stream (0:00–0:09, no wrap)',
  controls.querySelector('#rp-loop-from')?.value === '0:00' &&
    controls.querySelector('#rp-loop-to')?.value === '0:09',
  `${controls.querySelector('#rp-loop-from')?.value}–${controls.querySelector('#rp-loop-to')?.value}`,
);
check('the clamp leaves the loop armed', loopBtn.getAttribute('aria-pressed') === 'true', loopBtn.getAttribute('aria-pressed'));
// Disarm through the popover's own Loop button, then restore the
// round-2 playhead for the sections below (the transport cluster is
// re-addressed by the NEXT section's own queries anyway).
click(controls.querySelector('button[title="Toggle loop (L)"]'));
await sleep();
check('the Loop toggle disarms it again', loopBtn.getAttribute('aria-pressed') === 'false', loopBtn.getAttribute('aria-pressed'));
if (controls.querySelector('#rp-loop-from')) {
  click(loopBtn);
  await sleep();
}
click(controls.querySelector('#rp-round-next'));
await sleep();
check(
  'the playhead is back at tick 640 for the sections below',
  readoutTick().includes('tick 640'),
  readoutTick(),
);
check('disarming dropped the loop row again', !ctrlTexts().some((t) => t.startsWith('loop:')), JSON.stringify(ctrlTexts()));

console.log('E2. drop-layer popover: multi-select between the camera selector and the volume, off by default, pref-persisted');
const dropHost = controls.querySelector('#rp-drops');
const camHost2 = controls.querySelector('#rp-cam');
const volHost2 = controls.querySelector('.rp-vol');
const ctlKids = [...controls.children];
check(
  'the drop popover sits between the camera selector and the volume',
  !!dropHost &&
    ctlKids.indexOf(dropHost) > ctlKids.indexOf(camHost2) &&
    ctlKids.indexOf(dropHost) < ctlKids.indexOf(volHost2),
  ctlKids.map((el) => el.id || el.className || el.tagName).join(' | '),
);
const dropBtn2 = dropHost?.querySelector('button');
check(
  'trigger: the Drops label + chevron with the live on-count',
  !!dropBtn2 &&
    dropBtn2.textContent.includes('Drops') &&
    !!dropBtn2.querySelector('.codicon-chevron-down') &&
    !!dropBtn2.querySelector('.rp-drops-count'),
);
check(
  'fresh profile: the drop_layers pref is unset',
  globalThis.__prefs['drop_layers'] === undefined,
  JSON.stringify(globalThis.__prefs['drop_layers']),
);
check(
  'the view READ drop_layers on mount — the same store a reload would read back',
  (globalThis.__prefReads || []).includes('drop_layers'),
  JSON.stringify(globalThis.__prefReads),
);
check(
  'all three layers off: the trigger count starts at 0',
  dropBtn2?.querySelector('.rp-drops-count')?.textContent.trim() === '0',
  dropBtn2?.querySelector('.rp-drops-count')?.textContent,
);
check(
  'startEngine pushed the default (all off) to renderer.setDropLayers',
  !!globalThis.__dropLayers &&
    !globalThis.__dropLayers.guns &&
    !globalThis.__dropLayers.util &&
    !globalThis.__dropLayers.kits,
  JSON.stringify(globalThis.__dropLayers),
);
check(
  'the kit evidence was pushed beside the landmarks (built, not null)',
  !!globalThis.__kitEvidence,
  String(globalThis.__kitEvidence),
);
check('no panel until the popover opens', !controls.querySelector('.rp-drops-pop'));

click(dropBtn2);
await sleep();
const dropPop = controls.querySelector('.rp-drops-pop');
check('popover opens a checkbox list (multi-select)', !!dropPop);
const dropBoxes = dropPop ? [...dropPop.querySelectorAll('input[type="checkbox"]')] : [];
const dropLabel = (cb) => (cb.closest('label')?.textContent || '').trim();
check(
  'exactly Guns, Utility and Kits, in that order',
  JSON.stringify(dropBoxes.map(dropLabel)) === '["Guns","Utility","Kits"]',
  JSON.stringify(dropBoxes.map(dropLabel)),
);
check(
  'all three options unchecked by default (the kit filter is OFF)',
  dropBoxes.filter((cb) => cb.checked).length === 0,
  JSON.stringify(dropBoxes.map((cb) => cb.checked)),
);
const setDropBox = async (label) => {
  const cb = dropBoxes.find((c) => dropLabel(c) === label);
  cb?.click();
  await sleep();
};
// Unlike the camera pop's single choice, a multi-select STAYS open.
await setDropBox('Guns');
check(
  'toggling Guns checks it and the panel STAYS open (multi-select)',
  !!controls.querySelector('.rp-drops-pop') && dropBoxes[0].checked === true,
  String(dropBoxes[0].checked),
);
check(
  'the drop_layers pref persisted as the comma list',
  globalThis.__prefs['drop_layers'] === 'guns',
  JSON.stringify(globalThis.__prefs['drop_layers']),
);
check(
  'renderer.setDropLayers received {guns:true, util:false, kits:false}',
  globalThis.__dropLayers?.guns === true &&
    globalThis.__dropLayers?.util === false &&
    globalThis.__dropLayers?.kits === false,
  JSON.stringify(globalThis.__dropLayers),
);
check(
  'the trigger count follows',
  dropBtn2?.querySelector('.rp-drops-count')?.textContent.trim() === '1',
  dropBtn2?.querySelector('.rp-drops-count')?.textContent,
);
await setDropBox('Utility');
check(
  'both on: pref = "guns,util" and the renderer got both',
  globalThis.__prefs['drop_layers'] === 'guns,util' && globalThis.__dropLayers?.guns && globalThis.__dropLayers?.util,
  `${JSON.stringify(globalThis.__prefs['drop_layers'])} / ${JSON.stringify(globalThis.__dropLayers)}`,
);
check(
  'the trigger count reads 2',
  dropBtn2?.querySelector('.rp-drops-count')?.textContent.trim() === '2',
  dropBtn2?.querySelector('.rp-drops-count')?.textContent,
);
await setDropBox('Guns');
check(
  'the two layers are independent: unchecking Guns leaves Utility on',
  globalThis.__prefs['drop_layers'] === 'util' &&
    dropBoxes[0].checked === false &&
    dropBoxes[1].checked === true,
  `${JSON.stringify(globalThis.__prefs['drop_layers'])} / ${JSON.stringify(dropBoxes.map((cb) => cb.checked))}`,
);
check(
  'the pref survives for a reload — the mount effect reads the SAME store back',
  globalThis.__prefs['drop_layers'] === 'util' &&
    (globalThis.__prefReads || []).includes('drop_layers'),
  JSON.stringify(globalThis.__prefs['drop_layers']),
);
// The THIRD layer: Kits toggles independently of Guns/Utility and lands
// in the same durable comma list (the default-OFF contract is the
// "unchecked above" pin; this is the wiring).
await setDropBox('Kits');
check(
  'kits toggles independently: pref = "util,kits", renderer got kits:true',
  globalThis.__prefs['drop_layers'] === 'util,kits' &&
    globalThis.__dropLayers?.kits === true &&
    globalThis.__dropLayers?.util === true &&
    globalThis.__dropLayers?.guns === false,
  `${JSON.stringify(globalThis.__prefs['drop_layers'])} / ${JSON.stringify(globalThis.__dropLayers)}`,
);
check(
  'the trigger count follows the third layer (2)',
  dropBtn2?.querySelector('.rp-drops-count')?.textContent.trim() === '2',
  dropBtn2?.querySelector('.rp-drops-count')?.textContent,
);
await setDropBox('Kits'); // back off — later sections count layers as off
check(
  'unchecking Kits leaves Utility on (three independent flags)',
  globalThis.__prefs['drop_layers'] === 'util' &&
    dropBoxes[2].checked === false &&
    dropBoxes[1].checked === true,
  `${JSON.stringify(globalThis.__prefs['drop_layers'])} / ${JSON.stringify(dropBoxes.map((cb) => cb.checked))}`,
);
click(dropBtn2); // close — later sections count toolbar chrome
await sleep();
check('the popover closes on its trigger', !controls.querySelector('.rp-drops-pop'));

console.log('E3. UI overlay toggle: the ONE coarse chat/feed/score + control-group on-off, no pref');
const uiBtn = controls.querySelector('#rp-ui');
check(
  'the toggle sits immediately before the drops selector',
  !!uiBtn && uiBtn.nextElementSibling === dropHost,
  uiBtn ? `next = ${uiBtn.nextElementSibling?.id || uiBtn.nextElementSibling?.className}` : 'missing #rp-ui',
);
check(
  'icon-only, the open-eye glyph while the overlays show',
  !!uiBtn?.querySelector('.codicon-eye') && !uiBtn.textContent.trim(),
  uiBtn ? JSON.stringify(uiBtn.textContent) : 'missing',
);
check(
  'startEngine pushed the default (shown) to renderer.setOverlaysVisible',
  globalThis.__overlays === true,
  String(globalThis.__overlays),
);
check(
  'the control group is on screen to hide (the ever-present packNote row)',
  !!ctrlList(),
  ctrlTexts().join(' | '),
);
const prefKeys = () => JSON.stringify(Object.keys(globalThis.__prefs).sort());
const prefsBefore = prefKeys();
click(uiBtn);
await sleep();
check(
  'toggling OFF: the renderer got false AND the .rp-ctrl-list is gone',
  globalThis.__overlays === false && !stage.querySelector('.rp-ctrl-list'),
  `overlays=${globalThis.__overlays} ctrl=${!!stage.querySelector('.rp-ctrl-list')}`,
);
check(
  'the armed pattern (#rp-skip-freeze\'s shape): pressed + warn + eye-closed while hidden',
  uiBtn.getAttribute('aria-pressed') === 'true' &&
    uiBtn.classList.contains('warn') &&
    !!uiBtn.querySelector('.codicon-eye-closed'),
  `${uiBtn.getAttribute('aria-pressed')} warn=${uiBtn.classList.contains('warn')}`,
);
check(
  'the toggle writes NO pref (session-only, like theater)',
  prefKeys() === prefsBefore,
  `${prefsBefore} → ${prefKeys()}`,
);
click(uiBtn);
await sleep();
check(
  'toggling back ON: the renderer got true and the control group returns',
  globalThis.__overlays === true && !!stage.querySelector('.rp-ctrl-list'),
  `overlays=${globalThis.__overlays} ctrl=${!!stage.querySelector('.rp-ctrl-list')}`,
);
check('the open-eye glyph returns', !!uiBtn.querySelector('.codicon-eye'));

console.log('F. player-card columns: grouping, team names, mute wiring, absent-stream silence');
const rbody = main.querySelector('.replay-body');
const kids = children(rbody);
check(
  'two TeamColumns flank the stage as siblings (left, stage, right)',
  kids.length === 3 && kids[0].classList.contains('tc-col') &&
    kids[1].classList.contains('replay-stage') && kids[2].classList.contains('tc-col'),
  kids.map((el) => el.className).join(' | '),
);
const leftCol = kids[0];
const rightCol = kids[2];
check(
  'team names ride the columns (getTeamNames: finished-ct left, finished-t right)',
  leftCol.querySelector('.tc-name')?.textContent === 'Alpha' &&
    rightCol.querySelector('.tc-name')?.textContent === 'Bravo',
  leftCol.querySelector('.tc-name')?.textContent + ' / ' + rightCol.querySelector('.tc-name')?.textContent,
);
check(
  'team names tinted by the side at the playhead (final-side fallback: the stub store carries no frame bits)',
  leftCol.querySelector('.tc-name')?.classList.contains('side-ct') &&
    rightCol.querySelector('.tc-name')?.classList.contains('side-t'),
);
check(
  'per-team mute button beside each team name',
  !!leftCol.querySelector('.tc-mute') && !!rightCol.querySelector('.tc-mute'),
);
const leftCards = [...leftCol.querySelectorAll('.pc-card')];
const rightCards = [...rightCol.querySelectorAll('.pc-card')];
check(
  'grouping: finished-ct team + the side-unknown player LEFT, finished-t RIGHT',
  leftCards.length === 4 && rightCards.length === 2,
  `left=${leftCards.length} right=${rightCards.length}`,
);
check(
  'cards keep roster order',
  leftCards.map((c) => c.querySelector('.pc-name').textContent).join(',') === 'Alpha1,Alpha2,Alpha3,Lone' &&
    rightCards.map((c) => c.querySelector('.pc-name').textContent).join(',') === 'Bravo1,Bravo2',
  leftCards.map((c) => c.querySelector('.pc-name').textContent).join(','),
);
check(
  'every card takes its column side tint and the honest no-state marker (v1 → no index)',
  leftCards.every((c) => c.classList.contains('pc-ct')) &&
    rightCards.every((c) => c.classList.contains('pc-t')) &&
    leftCards.every((c) => !!c.querySelector('.pc-nostate')),
);
// Card props: the teammate color rides meta.players → the card ring, and
// the live K/D/A + ADR fold reaches every card (no events in this stub,
// counted round 1 started at the playhead → a real 0 ADR, never "—").
check(
  'teammate color from meta.players rings the card (raw 0 → blue)',
  leftCards[0].classList.contains('pc-color') &&
    leftCards[0].style.getPropertyValue('--pc-color') === '#84C8ED',
  leftCards[0].getAttribute('style'),
);
check(
  'the color follows its player across columns (Bravo1, raw 4 → purple)',
  rightCards[0].classList.contains('pc-color') &&
    rightCards[0].style.getPropertyValue('--pc-color') === '#A56FB2',
  rightCards[0].getAttribute('style'),
);
check(
  'a player without a color gets NO ring (never a guessed one)',
  !leftCards[1].classList.contains('pc-color') &&
    !leftCards[3].classList.contains('pc-color') &&
    !rightCards[1].classList.contains('pc-color'),
);
check(
  'every card renders the live stats row from the fold',
  [...leftCards, ...rightCards].every(
    (c) => c.querySelector('.pc-stats')?.textContent === 'K/D/A 0/0/0 · ADR 0.0',
  ),
  [...leftCards, ...rightCards].map((c) => c.querySelector('.pc-stats')?.textContent).join(' | '),
);
// Defuse-kit badge (the card plumbing): the stubbed draw feed carries a
// kit GAIN for Alpha1 (plus the round's round_start so hasKitAt can
// scope it), the buytime_ended read supplies the boundary → cardColumns'
// tri-state `kit` prop → PlayerCard's .pc-kit. No icon in this harness's
// manifest → the mandatory "Kit" text fallback.
const kitBadge = (c) => c.querySelector('.pc-kit');
check(
  'the kit badge renders on the card whose player holds a kit (Alpha1)',
  !!kitBadge(leftCards[0]) &&
    kitBadge(leftCards[0]).getAttribute('title') === 'Defuse kit' &&
    kitBadge(leftCards[0]).textContent.trim() === 'Kit',
  `${kitBadge(leftCards[0])?.getAttribute('title')} / ${kitBadge(leftCards[0])?.textContent}`,
);
check(
  'no kit badge on any other card (known NOT to hold one — never a guess)',
  [...leftCards.slice(1), ...rightCards].every((c) => !kitBadge(c)),
  [...leftCards.slice(1), ...rightCards].map((c) => (kitBadge(c) ? 'BADGE' : '-')).join(','),
);
// Per-player mute (spec 22): the card button flips exactly that player.
const cardMute = () => leftCards[0].querySelector('.pc-mute');
check('card mute starts unmuted', cardMute()?.getAttribute('aria-pressed') === 'false');
click(cardMute());
await sleep();
check(
  'per-player mute wires to that card only',
  cardMute()?.getAttribute('aria-pressed') === 'true' &&
    leftCards[1].querySelector('.pc-mute')?.getAttribute('aria-pressed') === 'false' &&
    rightCards[0].querySelector('.pc-mute')?.getAttribute('aria-pressed') === 'false',
);
click(cardMute());
await sleep();
check('per-player unmute restores', cardMute()?.getAttribute('aria-pressed') === 'false');
// Per-team mute (spec 22): the column button mutes every card in it.
const teamBtn = () => leftCol.querySelector('.tc-mute');
check('team mute starts unpressed', teamBtn()?.getAttribute('aria-pressed') === 'false');
click(teamBtn());
await sleep();
check(
  'team mute presses the team button + every left card, right column untouched',
  teamBtn()?.getAttribute('aria-pressed') === 'true' &&
    leftCol.querySelectorAll('.pc-mute[aria-pressed="true"]').length === 4 &&
    rightCol.querySelectorAll('.pc-mute[aria-pressed="true"]').length === 0,
  String(leftCol.querySelectorAll('.pc-mute[aria-pressed="true"]').length),
);
click(teamBtn());
await sleep();
check(
  'team unmute restores every card',
  teamBtn()?.getAttribute('aria-pressed') === 'false' &&
    target.querySelectorAll('.pc-mute[aria-pressed="true"]').length === 0,
);
// An absent state stream (the stub's fail-soft loadState) must render
// silently: no reprocess note — the cards show their state-less
// placeholders, exactly like a match that never had a stream.
const stateNotes = [...target.querySelectorAll('.note-amber')].filter((n) =>
  n.textContent.includes('player state unavailable'),
);
check('absent state stream shows NO state note', stateNotes.length === 0, String(stateNotes.length));

console.log('F2. connection: a disconnect hides the card, a reconnect unhides it');
// The stubbed getEvents hands the view connect/disconnect rows for every
// roster slot (services stub): all in the match from tick 0, Alpha3 out
// in [192, 320), Lone a late joiner with NO presence before 448, Bravo1
// gone from 1000 (the tail — only reachable with +15s, the frame scrub
// tops out at the stub's last tick 576). The columns must follow the
// PLAYHEAD in BOTH directions: scrubbing back re-shows a card, scrubbing
// forward hides it again (never a sticky state).
const leftNames = () =>
  [...leftCol.querySelectorAll('.pc-card')]
    .map((c) => c.querySelector('.pc-name').textContent)
    .join(',');
const rightNames = () =>
  [...rightCol.querySelectorAll('.pc-card')]
    .map((c) => c.querySelector('.pc-name').textContent)
    .join(',');
const scrubTo = async (frame) => {
  const s = scrub.querySelector('input.scrubber');
  s.value = String(frame);
  s.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep();
};
check(
  'baseline at the round-2 playhead: every roster slot is in the match (4 left / 2 right)',
  leftNames() === 'Alpha1,Alpha2,Alpha3,Lone' && rightNames() === 'Bravo1,Bravo2',
  leftNames() + ' | ' + rightNames(),
);
await scrubTo(3); // tick 192 — inside Alpha3's gap, before Lone's join
check(
  "at tick 192 only the two OUT players have no card (Alpha3's gap + Lone pre-join)",
  leftNames() === 'Alpha1,Alpha2' && rightNames() === 'Bravo1,Bravo2',
  leftNames() + ' | ' + rightNames(),
);
// The follow popover must not offer a player the camera cannot track
// (the same playerConnected filter the old select applied — the panel
// only mounts while open).
await chooseCam('Follow');
click(followBtn());
await sleep();
const liveFollowOpts = () =>
  [...controls.querySelectorAll('#rp-follow .rp-follow-pop button')]
    .map((b) => b.value)
    .filter((v) => v !== '');
check(
  'the follow popover drops the disconnected (and the not-yet-joined) player',
  liveFollowOpts().join(',') === '0,1,3,4',
  liveFollowOpts().join(','),
);
click(followBtn()); // close — later sections count toolbar chrome
await sleep();
await chooseCam('Free');
// A team mute is a durable voice setting over the WHOLE team (the view
// mutes the unfiltered roster), so the card that comes back on a
// reconnect must read muted — the voice engine and the card never
// disagree about a player who was out while the toggle flipped.
click(teamBtn());
await sleep();
await scrubTo(5); // tick 320 — Alpha3 reconnected (Lone joins at 448)
check(
  'the reconnect at 320 unhides Alpha3 (roster order kept)',
  leftNames() === 'Alpha1,Alpha2,Alpha3',
  leftNames(),
);
const cardByName = (col, name) =>
  [...col.querySelectorAll('.pc-card')].find((c) => c.querySelector('.pc-name').textContent === name);
check(
  'the team mute missed while out still applies to the returning card',
  leftCol.querySelectorAll('.pc-mute[aria-pressed="true"]').length === 3 &&
    cardByName(leftCol, 'Alpha3')?.querySelector('.pc-mute')?.getAttribute('aria-pressed') === 'true',
  String(leftCol.querySelectorAll('.pc-mute[aria-pressed="true"]').length),
);
click(teamBtn());
await sleep();
await scrubTo(0); // tick 0 — before Lone's 448 connect
check(
  'a late joiner has NO card before its connect (the nuke bot phantom)',
  leftNames() === 'Alpha1,Alpha2,Alpha3',
  leftNames(),
);
await scrubTo(7); // tick 448 — Lone connects
check('Lone appears at the very tick it connects', leftNames() === 'Alpha1,Alpha2,Alpha3,Lone', leftNames());
await scrubTo(3);
check(
  "scrubbing back into Alpha3's gap hides it again (Lone is still pre-join there)",
  leftNames() === 'Alpha1,Alpha2',
  leftNames(),
);
// Back to the round-2 playhead, then the TAIL disconnect through the
// +15s transport (1000 is past the scrubber's last frame).
click(controls.querySelector('#rp-round-next'));
await sleep();
check('round transport restores the round-2 playhead', readoutTick().includes('tick 640'), readoutTick());
click(controls.querySelector('#rp-seek-fwd'));
await sleep();
check(
  'the tail disconnect hides Bravo1 (+15s → tick 1600 > 1000)',
  readoutTick().includes('tick 1600') && rightNames() === 'Bravo2',
  readoutTick() + ' | ' + rightNames(),
);
click(controls.querySelector('#rp-seek-back'));
await sleep();
check(
  'scrubbing back to 640 brings Bravo1 back — every card visible again',
  leftNames() === 'Alpha1,Alpha2,Alpha3,Lone' && rightNames() === 'Bravo1,Bravo2',
  leftNames() + ' | ' + rightNames(),
);

console.log('G. filter surface: the category multi-select dropdown + the FilterBar rows');
// Section B collapsed the rail again — re-expand it, then open the ONE
// Filters toggle that governs the whole filter surface.
click(topbar.querySelector('.side-toggle'));
await sleep();
const rail = target.querySelector('.replay-side');
check('rail re-expanded for the filter surface', !!rail);
const filtersBtn = rail?.querySelector('.lm-toolbar button[aria-expanded]');
check('Filters toggle present', !!filtersBtn);
click(filtersBtn);
await sleep();
const panel = rail?.querySelector('.lm-filter-panel');
check('filter panel opens', !!panel);
check(
  'no category pill buttons — .lm-cats is ONE dropdown now',
  !!panel && !panel.querySelector('.lm-cat-chip') && !panel.querySelector('button.lm-cat-chip'),
);
const catsWrap = panel?.querySelector('.lm-cats');
const catsBtn = catsWrap?.querySelector('button');
check('category dropdown trigger with its enabled count', !!catsBtn &&
  catsBtn.getAttribute('aria-expanded') === 'false' &&
  catsBtn.querySelector('.lm-filter-count')?.textContent.trim() === '1',
  catsBtn ? catsBtn.textContent.trim() : 'missing trigger');
check('no checkbox list until the dropdown opens', !panel?.querySelector('.lm-cat-menu'));
click(catsBtn);
await sleep();
const catMenu = panel?.querySelector('.lm-cat-menu');
check('dropdown opens a checkbox list (multi-select)', !!catMenu);
const catBoxes = catMenu ? [...catMenu.querySelectorAll('input[type="checkbox"]')] : [];
// 16 = 15 + the drops category (the death-drop evidence rows —
// lib/replay/landmarks.js CATEGORIES gained one opt-in entry so
// normalizeEvent can claim weapon_drop/weapon_pickup for the draw set;
// default selection is unchanged) + the Bounce category (grenade_bounce
// rows — same shape: an opt-in, default-OFF entry so the kind has a
// claim; the checked-list pin below stays 'Round starts' only).
check('one checkbox per category', catBoxes.length === 16, String(catBoxes.length));
const catLabel = (cb) => (cb.closest('label')?.textContent || '').trim();
check(
  'default selection: round starts ON, kills and round wins OFF',
  catBoxes.filter((cb) => cb.checked).map(catLabel).join(',') === 'Round starts',
  catBoxes.filter((cb) => cb.checked).map(catLabel).join(','),
);
// Checking another category navigates with the new set — the route query
// IS the filter (toggleCat → navigateFilter → serializeLandmarkFilter).
const navBeforeCats = (globalThis.__nav || []).length;
const killsBox = catBoxes.find((cb) => catLabel(cb) === 'Kills');
killsBox?.click();
await sleep();
const navCats = globalThis.__nav || [];
check(
  'toggling a category writes the new cat= list',
  navCats.length > navBeforeCats && navCats[navCats.length - 1].includes('cat=round_starts,kills'),
  navCats[navCats.length - 1] || 'no navigation',
);

const bar = panel?.querySelector('.filt-bar');
check('FilterBar present in the panel', !!bar);
check('the exact-round select is gone', !!bar && !bar.querySelector('#filt-round'));
check(
  'round from/to number inputs (step 1, negatives allowed)',
  !!bar?.querySelector('#filt-round-from[type="number"]') &&
    !!bar?.querySelector('#filt-round-to[type="number"]') &&
    !bar.querySelector('#filt-round-from').hasAttribute('min'),
);
check(
  'dist min/max inputs replace the single max field',
  !!bar?.querySelector('#filt-dist-min') && !!bar?.querySelector('#filt-dist-max'),
);
check(
  'no tick window and no damage range',
  !!bar &&
    !bar.querySelector('[aria-label="From tick"]') &&
    !bar.querySelector('[aria-label="To tick"]') &&
    !bar.querySelector('[aria-label="Minimum damage"]') &&
    !bar.querySelector('[aria-label="Maximum damage"]') &&
    !bar.querySelector('#filt-dist'),
);
const playerGrp = bar?.querySelector('#filt-player')?.closest('.filt-grp');
const weaponGrp = bar?.querySelector('#filt-weapon')?.closest('.filt-grp');
check(
  'player and weapon selects each own their own row (.filt-line)',
  !!playerGrp && !!weaponGrp && playerGrp !== weaponGrp &&
    playerGrp.classList.contains('filt-line') && weaponGrp.classList.contains('filt-line'),
  `${playerGrp?.className} | ${weaponGrp?.className}`,
);
const weaponOpts = [...(bar?.querySelector('#filt-weapon')?.options || [])].map((o) => o.value);
check(
  'weapon options list each weapon ONCE, by display name (events.weapon spelling)',
  weaponOpts.includes('Desert Eagle') && weaponOpts.includes('AK-47') &&
    !weaponOpts.includes('deagle') && !weaponOpts.includes('ak47'),
  weaponOpts.slice(0, 8).join(','),
);
check(
  'weapon option values are unique (no double counting)',
  new Set(weaponOpts).size === weaponOpts.length,
  `${new Set(weaponOpts).size} vs ${weaponOpts.length}`,
);
check('headshot toggle kept', !!bar?.querySelector('.filt-check'));

console.log('I. theater mode: the chrome hides, the stage keeps its exit button, popovers reset');
const theaterBtn = controls.querySelector('#rp-theater');
check(
  'the theater cell sits immediately left of the camera selector',
  !!theaterBtn && theaterBtn.nextElementSibling === controls.querySelector('#rp-cam'),
  theaterBtn
    ? `next = ${theaterBtn.nextElementSibling?.id || theaterBtn.nextElementSibling?.className}`
    : 'missing #rp-theater',
);
check(
  'separator 1 still sits directly after the loop control (the theater cell splits nothing)',
  !!seps[0] && seps[0] === after(controls.querySelector('.rp-loop')),
  children(controls).map((el) => el.className || el.id || el.getAttribute('aria-label')).join(' | '),
);
check(
  'the theater cell is icon-only',
  !!theaterBtn?.querySelector('.codicon-screen-full') && !theaterBtn.textContent.trim(),
  theaterBtn ? JSON.stringify(theaterBtn.textContent) : 'missing',
);
// Open the loop popover FIRST: its panel lives inside the transport, so
// entering must RESET it — otherwise it would remount OPEN on exit with
// no toolbar around it.
click(loopBtn);
await sleep();
check('the loop panel is open before entering', !!controls.querySelector('#rp-loop-from'));
check('the feed aside is up (rail expanded) before entering', !!target.querySelector('.replay-side'));
const navBaseT = (globalThis.__nav || []).length;
click(theaterBtn);
await sleep();
check('entering hides the top bar', !target.querySelector('.replay-topbar'));
check('entering hides the transport (scrubber + control cluster)', !target.querySelector('.replay-transport'));
check('entering hides the feed aside (the rail stays expanded)', !target.querySelector('.replay-side'));
check(
  'the stage keeps its exit button',
  !!stage.querySelector('.rp-theater-exit') &&
    stage.querySelector('.rp-theater-exit')?.getAttribute('aria-label') === 'Exit theater mode',
  stage.querySelector('.rp-theater-exit')?.getAttribute('aria-label') || 'missing',
);
check(
  'the exit button is OUTSIDE the control group (never gated with it)',
  !stage.querySelector('.rp-ctrl-list .rp-theater-exit'),
);
check(
  'the team columns stay (spec scope: theater hides chrome, not the cards)',
  !!main.querySelector('.replay-body > .tc-col'),
);
check('entering writes no navigation', (globalThis.__nav || []).length === navBaseT, String((globalThis.__nav || []).length - navBaseT));
click(stage.querySelector('.rp-theater-exit'));
await sleep();
check(
  'exiting restores the top bar, the transport and the feed aside',
  !!target.querySelector('.replay-topbar') &&
    !!target.querySelector('.replay-transport') &&
    !!target.querySelector('.replay-side'),
);
check(
  'a popover open at enter time does NOT remount open (it was reset on enter)',
  !target.querySelector('#rp-loop-from'),
  String(!!target.querySelector('#rp-loop-from')),
);

// --- SOFTLOCK PIN (B4 × B2): overlays off must never hide the exit path --
// The transport and the control group are gone in theater mode; the
// toggle's flag survives the round trip, so the exit button has to stay
// renderable with overlays OFF — and the toggle has to work again after.
const transportAfter = target.querySelector('.replay-transport');
const controlsAfter = transportAfter?.children[1];
const uiBtnAfter = controlsAfter?.querySelector('#rp-ui');
click(uiBtnAfter);
await sleep();
check(
  'overlays off: the control group is gone again',
  globalThis.__overlays === false && !stage.querySelector('.rp-ctrl-list'),
  `overlays=${globalThis.__overlays} ctrl=${!!stage.querySelector('.rp-ctrl-list')}`,
);
click(controlsAfter.querySelector('#rp-theater'));
await sleep();
check('overlays off still renders the theater exit (never gated)', !!stage.querySelector('.rp-theater-exit'));
click(stage.querySelector('.rp-theater-exit'));
await sleep();
const transportBack = target.querySelector('.replay-transport');
check(
  'exit returns the transport with overlays STILL off (no softlock, no state loss)',
  !!transportBack && globalThis.__overlays === false && !stage.querySelector('.rp-ctrl-list'),
  `transport=${!!transportBack} overlays=${globalThis.__overlays} ctrl=${!!stage.querySelector('.rp-ctrl-list')}`,
);
click(transportBack?.children[1]?.querySelector('#rp-ui'));
await sleep();
check(
  'and the toggle round-trips again after the theater hop',
  globalThis.__overlays === true && !!stage.querySelector('.rp-ctrl-list'),
  `overlays=${globalThis.__overlays} ctrl=${!!stage.querySelector('.rp-ctrl-list')}`,
);

// --- (A) + (B): the range-edit rule and the entry ?loop= promise ----------
// A SECOND Replay instance mounts against the ENTRY query the link sites
// stamp (?loop=<from>,<to> — nav.entryLoopRange resolves it once in
// startEngine). Its nav prop records into __nav2, so the first
// instance's history (and its later __nav baselines) stay untouched;
// query is a plain prop, so navigateFilter reads the same loop= a real
// hashchange would deliver.
console.log('H. entry ?loop= applies ONCE on mount (bounds + armed); editing a bound turns it off and strips the promise');
const target2 = document.createElement('div');
document.body.appendChild(target2);
const harness2Src = `<script>
  import Replay from './views/Replay.js';
</script>
<Replay id={1} query={{ loop: '0,320' }} nav={(h) => (globalThis.__nav2 = (globalThis.__nav2 || []).concat(h))} />`;
const harness2Out = join(dir, 'harness2.js');
svelteCompile(harness2Src, 'harness2.svelte', harness2Out);
const mod2 = await import(pathToFileURL(harness2Out).href);
mount(mod2.default, { target: target2 });
await sleep();
await sleep(); // load() → startEngine: seek, then the loop apply
const transport2 = target2.querySelector('.replay-transport');
const controls2 = transport2?.children[1];
const loopBtn2 = controls2?.querySelector('button[aria-label="Loop range"]');
check('entry loop: the instance rendered its transport', !!controls2 && !!loopBtn2);
check(
  'mounting with ?loop=… arms the loop on entry',
  loopBtn2?.getAttribute('aria-pressed') === 'true',
  loopBtn2?.getAttribute('aria-pressed'),
);
click(loopBtn2);
await sleep();
check(
  'mounting with ?loop=0,320 sets the bounds (frames 0–5 → 0:00–0:05 at 64 tick)',
  controls2.querySelector('#rp-loop-from')?.value === '0:00' &&
    controls2.querySelector('#rp-loop-to')?.value === '0:05',
  `${controls2.querySelector('#rp-loop-from')?.value}–${controls2.querySelector('#rp-loop-to')?.value}`,
);
// Filter churn PRESERVES the entry loop (exactly like tick/back —
// navigateFilter re-pins query.loop): the rail's category dropdown is
// the cheapest filter navigation.
const top2 = target2.querySelector('.replay-topbar');
click(top2?.querySelector('.side-toggle'));
await sleep();
const rail2 = target2.querySelector('.replay-side');
const filters2 = rail2?.querySelector('.lm-toolbar button[aria-expanded]');
click(filters2);
await sleep();
const panel2 = rail2?.querySelector('.lm-filter-panel');
click(panel2?.querySelector('.lm-cats button'));
await sleep();
const kills2 = [...(panel2?.querySelectorAll('.lm-cat-menu input[type="checkbox"]') || [])].find(
  (cb) => (cb.closest('label')?.textContent || '').trim() === 'Kills',
);
const nav2Base = (globalThis.__nav2 || []).length;
kills2?.click();
await sleep();
const nav2 = globalThis.__nav2 || [];
check(
  'a filter change keeps loop= in the URL (like tick/back)',
  nav2.length > nav2Base &&
    (nav2[nav2.length - 1] || '').includes('cat=round_starts,kills') &&
    (nav2[nav2.length - 1] || '').includes('loop=0,320'),
  nav2[nav2.length - 1] || 'no navigation',
);
// (A) on an ENTRY loop: editing a bound turns the loop off AND strips
// the promise from the URL — a refresh after the edit must not
// resurrect the pre-edit range.
const editBase = nav2.length;
const from2 = controls2.querySelector('#rp-loop-from');
from2.value = '0:01';
from2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'editing the entry bound while looping turns it off',
  loopBtn2.getAttribute('aria-pressed') === 'false',
  loopBtn2.getAttribute('aria-pressed'),
);
check(
  'the edited bound still applies (from 0:01)',
  controls2.querySelector('#rp-loop-from')?.value === '0:01',
  controls2.querySelector('#rp-loop-from')?.value,
);
// The harness's nav prop concats into a FRESH array per navigation, so
// re-read the global after the edit instead of reusing nav2 above.
// (The harness query is static — it never feeds the toggled cats back
// — so this navigation serializes the entry filter as-is; what it pins
// is that the EDIT navigation exists and carries no loop= anymore.)
const nav2After = globalThis.__nav2 || [];
const lastNav2 = nav2After[nav2After.length - 1];
check(
  'the edit strips loop= from the URL (a replay navigation, no resurrected range)',
  nav2After.length > editBase &&
    !!lastNav2 &&
    lastNav2.startsWith('/replay/1') &&
    !lastNav2.includes('loop='),
  lastNav2 || 'no navigation',
);

// --- (J): keep-alive — the collapsed dock + the activation contract -------
// A THIRD instance mounts INACTIVE (App passes active=false while the
// kept-alive replay sits over a match view): the load chain must run to
// completion WITHOUT autoplaying (audio over the match view is a bug),
// the chrome unmounts down to frame + caption (stage/canvas stay — the
// renderer holds the element), wasPlaying carries the resume intent
// through both activation orders, and the render area stays WORLD ONLY:
// collapse pushes renderer.setOverlaysVisible(false) (the E3 toggle's
// renderer half), expand re-pushes the SESSION flag — a user's OFF
// preference survives the round trip exactly like theater does. The
// caption's REAL play/pause control replaces the old passive ▶ marker
// (button pins + the dock-toggle flow in J2 below), and Replay mounts
// INSIDE a .dock-probe wrapper whose Svelte handlers mirror App's
// expand target (the isolation pins need something to not-reach). The
// engine stub counts play()/pause() (globalThis.__plays / __pauses —
// play() idempotent like the real engine, pause() counts every call)
// and the renderer stub records the last setOverlaysVisible into
// globalThis.__overlays — snapshots are taken around each step, so the
// earlier sections' play traffic cannot leak into these deltas.
console.log('J. keep-alive: inactive never autoplays; collapse pauses + world-only frame, expand resumes once, a deliberate pause stays paused');
const playsBase = globalThis.__plays || 0;
const pausesBase = globalThis.__pauses || 0;
const target3 = document.createElement('div');
document.body.appendChild(target3);
const harness3Src = `<script>
  import Replay from './views/Replay.js';
  let active = $state(false);
  globalThis.__setActive = (v) => (active = v);
</script>
<div
  class="dock-probe"
  onclick={() => (globalThis.__wrapperClicks = (globalThis.__wrapperClicks || 0) + 1)}
  onkeydown={() => (globalThis.__wrapperKeys = (globalThis.__wrapperKeys || 0) + 1)}
>
  <Replay id={1} query={{}} nav={(h) => (globalThis.__nav3 = (globalThis.__nav3 || []).concat(h))} {active} />
</div>`;
const harness3Out = join(dir, 'harness3.js');
svelteCompile(harness3Src, 'harness3.svelte', harness3Out);
const mod3 = await import(pathToFileURL(harness3Out).href);
mount(mod3.default, { target: target3 });
await sleep();
await sleep(); // load() → startEngine while INACTIVE
check(
  'an inactive load never autoplays (startEngine gates on active)',
  (globalThis.__plays || 0) === playsBase,
  `+${(globalThis.__plays || 0) - playsBase} play calls`,
);
const miniBar3 = target3.querySelector('.rp-mini-bar');
const miniBtn3 = () => target3.querySelector('.rp-mini-bar .rp-mini-toggle');
const miniGlyph3 = () => {
  const g = miniBtn3()?.querySelector('.codicon');
  return g?.classList.contains('codicon-debug-pause') ? 'pause' : g?.classList.contains('codicon-play') ? 'play' : 'none';
};
check(
  'collapsed: the dock caption renders (playhead time + expand hint)',
  !!miniBar3 && miniBar3.textContent.includes('Click to expand'),
  miniBar3 ? miniBar3.textContent : 'no .rp-mini-bar',
);
check(
  'the caption is a child of the main column — the column whose 10px flex gap was the dead space (app-dock E pins the zeroing rule)',
  miniBar3?.parentElement?.classList.contains('replay-main'),
  miniBar3?.parentElement?.className,
);
check(
  'collapsed: the caption carries a REAL play/pause control (inactive load → engine paused → Play glyph), the passive ▶ marker is gone',
  !!miniBtn3() && miniGlyph3() === 'play' && !miniBar3?.querySelector('.rp-mini-resume'),
  miniBtn3() ? miniBtn3().outerHTML : 'no .rp-mini-toggle',
);
check(
  'collapsed: NO chrome (top bar, transport, rail, player cards)',
  !target3.querySelector('.replay-topbar') &&
    !target3.querySelector('.replay-transport') &&
    !target3.querySelector('.replay-side') &&
    !target3.querySelector('.tc-col'),
);
check(
  'collapsed: the stage + canvas stay MOUNTED (the renderer holds them)',
  !!target3.querySelector('.replay-stage') && !!target3.querySelector('.replay-stage canvas'),
);
check(
  'collapsed: the render area is WORLD ONLY (the inactive load pushed overlays OFF)',
  globalThis.__overlays === false,
  `overlays=${globalThis.__overlays}`,
);

// Activate → the pending resume fires EXACTLY once (load finished inactive).
globalThis.__setActive(true);
await sleep();
check(
  'activating applies the pending resume once (play +1, no chrome flicker)',
  (globalThis.__plays || 0) === playsBase + 1 &&
    !target3.querySelector('.rp-mini-bar') &&
    !!target3.querySelector('.replay-topbar'),
  `+${(globalThis.__plays || 0) - playsBase} play calls`,
);
check(
  'expanding re-pushes the session overlay flag (ON by default)',
  globalThis.__overlays === true,
  `overlays=${globalThis.__overlays}`,
);
check('expanded: the player cards are back', !!target3.querySelector('.tc-col'));

// Collapse while PLAYING → pause +1; the caption then offers Play (the
// engine is paused — the resume intent lives in wasPlaying, applied on
// expand, not displayed as a marker anymore).
globalThis.__setActive(false);
await sleep();
check(
  'collapsing a playing replay pauses it (pause +1)',
  (globalThis.__pauses || 0) === pausesBase + 1,
  `+${(globalThis.__pauses || 0) - pausesBase} pause calls`,
);
check(
  'collapsing pushes the canvas overlays OFF (world-only dock)',
  globalThis.__overlays === false,
  `overlays=${globalThis.__overlays}`,
);
check(
  'collapsed after leaving a playing replay: the caption offers Play (engine paused; the intent lives in wasPlaying)',
  miniGlyph3() === 'play',
  miniGlyph3(),
);

// Expand resumes, then a DELIBERATE pause: collapse must not double-pause,
// expand must NOT resume — never resume a user's pause.
globalThis.__setActive(true);
await sleep();
check(
  'expanding resumes the replay (play +2 total)',
  (globalThis.__plays || 0) === playsBase + 2,
  `+${(globalThis.__plays || 0) - playsBase} play calls`,
);
check(
  'expand restores the overlays (the session flag ON re-pushed)',
  globalThis.__overlays === true,
  `overlays=${globalThis.__overlays}`,
);
// The user's overlay preference rides the round trip too (the same
// session-state-survives rule as theater): flip the E3 toggle OFF while
// expanded — the collapse/expand legs below must keep it OFF (never
// snap back to the default ON).
const uiBtn3 = target3.querySelector('#rp-ui');
check('the E3 overlay toggle is reachable while expanded', !!uiBtn3, 'missing #rp-ui');
click(uiBtn3);
await sleep();
check(
  'the E3 toggle drives the renderer flag (overlays OFF)',
  globalThis.__overlays === false,
  `overlays=${globalThis.__overlays}`,
);
const playBtn3 = target3.querySelector('.replay-transport button[aria-label="Pause"]');
check('the transport offers the Pause cell while playing', !!playBtn3, 'missing aria-label=Pause');
click(playBtn3);
await sleep();
const pausesAfterUser = globalThis.__pauses || 0;
const playsAfterUser = globalThis.__plays || 0;
globalThis.__setActive(false);
await sleep();
check(
  'collapsing a USER-paused replay issues no second pause',
  (globalThis.__pauses || 0) === pausesAfterUser,
  `+${(globalThis.__pauses || 0) - pausesAfterUser} pause calls`,
);
check(
  'collapsed after a user pause: the caption still offers Play (state, not intent — no passive ▶ marker; the expand pins below prove the remembered intent)',
  miniGlyph3() === 'play' && !target3.querySelector('.rp-mini-bar')?.querySelector('.rp-mini-resume'),
  miniGlyph3(),
);
globalThis.__setActive(true);
await sleep();
check(
  're-expanding a user-paused replay stays paused (no play call)',
  (globalThis.__plays || 0) === playsAfterUser,
  `+${(globalThis.__plays || 0) - playsAfterUser} play calls`,
);
check(
  "the user's OFF overlay preference survives the round trip (expand re-pushes OFF)",
  globalThis.__overlays === false,
  `overlays=${globalThis.__overlays}`,
);
check('expanded: chrome fully restored', !!target3.querySelector('.replay-transport') && !!target3.querySelector('.tc-col'));

// --- (J2): the caption's REAL play/pause control (the retired ▶ marker) ---
// Entering state: expanded, USER-paused, canvas overlays OFF (the E3
// preference set above). The button toggles the ENGINE while collapsed
// (real playback in the mini frame), OWNS wasPlaying so expand
// continues from exactly the state the dock was left in, keeps the
// world-only rule through a dock-play, and is event-isolated from the
// panel's expand handlers — the .dock-probe wrapper mirrors App's
// wrapper (Svelte handlers on the div, Replay inside), so the isolation
// pins prove the stopPropagation pair actually blocks the same walk the
// real wrapper uses; the positive controls at the end prove those
// handlers are alive (so "nothing happened" above is real isolation).
console.log('J2. caption control: dock play/pause toggles the engine, owns resume intent, isolates the expand wrapper');
const probe3 = target3.querySelector('.dock-probe');
check('the harness wraps Replay in an expand-target probe (the App wrapper shape)', !!probe3, 'no .dock-probe');
const wrapC0 = globalThis.__wrapperClicks || 0;
const wrapK0 = globalThis.__wrapperKeys || 0;
const j2P0 = globalThis.__plays || 0;
const j2Q0 = globalThis.__pauses || 0;

// Collapse the already-paused replay: the guard issues no pause call,
// and the caption offers Play (engine state, not a resume promise).
globalThis.__setActive(false);
await sleep();
check(
  'collapsing the already-paused replay issues no pause call (the view guard holds)',
  (globalThis.__pauses || 0) === j2Q0,
  `+${(globalThis.__pauses || 0) - j2Q0} pause calls`,
);
check('the caption offers Play (engine paused)', miniGlyph3() === 'play', miniGlyph3());

// KEYDOWN isolation: Enter on the button must not reach the wrapper's
// handler, must NOT be preventDefault-ed (a real browser's native
// button activation then performs the toggle — jsdom never synthesizes
// it), and changes no engine state by itself.
const keyEv = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
miniBtn3().dispatchEvent(keyEv);
check(
  "Enter on the caption button never reaches the wrapper's expand handler",
  (globalThis.__wrapperKeys || 0) === wrapK0,
  `wrapper keys +${(globalThis.__wrapperKeys || 0) - wrapK0}`,
);
check(
  '...and the keydown is NOT preventDefault-ed (the native button click still toggles)',
  keyEv.defaultPrevented === false,
  String(keyEv.defaultPrevented),
);
check(
  'the isolated keydown changed no engine state',
  (globalThis.__plays || 0) === j2P0 && (globalThis.__pauses || 0) === j2Q0,
  `plays +${(globalThis.__plays || 0) - j2P0} pauses +${(globalThis.__pauses || 0) - j2Q0}`,
);

// CLICK isolation + DOCK PLAY: the click plays the engine (play +1),
// flips the glyph to Pause, never reaches the wrapper, and leaves the
// render area WORLD ONLY (dock-play must not re-enable the overlays).
click(miniBtn3());
await sleep();
check(
  'clicking the caption button PLAYS in the dock (play +1, glyph → Pause)',
  (globalThis.__plays || 0) === j2P0 + 1 && miniGlyph3() === 'pause',
  `plays +${(globalThis.__plays || 0) - j2P0} glyph=${miniGlyph3()}`,
);
check(
  'the caption click never reaches the wrapper (isolation)',
  (globalThis.__wrapperClicks || 0) === wrapC0,
  `wrapper clicks +${(globalThis.__wrapperClicks || 0) - wrapC0}`,
);
check(
  'dock-play keeps the render area WORLD ONLY (overlays still OFF)',
  globalThis.__overlays === false,
  `overlays=${globalThis.__overlays}`,
);

// DOCK PAUSE → the intent flips to "stay paused".
click(miniBtn3());
await sleep();
check(
  'clicking again PAUSES in the dock (pause +1, glyph → Play)',
  (globalThis.__pauses || 0) === j2Q0 + 1 && miniGlyph3() === 'play',
  `pauses +${(globalThis.__pauses || 0) - j2Q0} glyph=${miniGlyph3()}`,
);
check(
  'the pause click never reaches the wrapper either',
  (globalThis.__wrapperClicks || 0) === wrapC0,
  `wrapper clicks +${(globalThis.__wrapperClicks || 0) - wrapC0}`,
);

// Leave it RUNNING for the expand leg (dock play → expand keeps playing).
click(miniBtn3());
await sleep();
const playsDockRunning = globalThis.__plays || 0;
check(
  'dock play again (play +2 total, glyph → Pause)',
  playsDockRunning === j2P0 + 2 && miniGlyph3() === 'pause',
  `plays +${playsDockRunning - j2P0} glyph=${miniGlyph3()}`,
);

// EXPAND-after-dock-play: KEEPS playing — the activation's resume play
// is a no-op in the real engine (already running; the stub mirrors that
// idempotence, so NO new call lands), and the transport reads Pause.
globalThis.__setActive(true);
await sleep();
check(
  'expand-after-dock-play KEEPS playing, with no new play call (the engine never stopped)',
  (globalThis.__plays || 0) === playsDockRunning &&
    !!target3.querySelector('.replay-transport button[aria-label="Pause"]'),
  `plays +${(globalThis.__plays || 0) - playsDockRunning}`,
);
check(
  'the OFF overlay preference still holds after the dock round trip',
  globalThis.__overlays === false,
  `overlays=${globalThis.__overlays}`,
);

// The other direction: collapse the DOCK-PLAYING replay, dock-pause it
// (the toggle owns the intent), and expand — it must STAY paused.
const j2Leave = { plays: globalThis.__plays || 0, pauses: globalThis.__pauses || 0 };
globalThis.__setActive(false);
await sleep();
check(
  'collapsing the dock-playing replay pauses it (pause +1)',
  (globalThis.__pauses || 0) === j2Leave.pauses + 1,
  `+${(globalThis.__pauses || 0) - j2Leave.pauses} pause calls`,
);
check('the caption offers Play again (engine paused by the leave)', miniGlyph3() === 'play', miniGlyph3());
click(miniBtn3()); // dock play — the engine must be running to dock-pause it
await sleep();
check(
  'dock play (play +1, glyph → Pause)',
  (globalThis.__plays || 0) === j2Leave.plays + 1 && miniGlyph3() === 'pause',
  `plays +${(globalThis.__plays || 0) - j2Leave.plays} glyph=${miniGlyph3()}`,
);
click(miniBtn3()); // DOCK PAUSE → wasPlaying = false
await sleep();
check(
  'DOCK PAUSE (pause +1, glyph → Play)',
  (globalThis.__pauses || 0) === j2Leave.pauses + 2 && miniGlyph3() === 'play',
  `pauses +${(globalThis.__pauses || 0) - j2Leave.pauses} glyph=${miniGlyph3()}`,
);
const playsBeforeDockPauseExpand = globalThis.__plays || 0;
globalThis.__setActive(true);
await sleep();
check(
  'expand-after-dock-pause STAYS paused (no resume call)',
  (globalThis.__plays || 0) === playsBeforeDockPauseExpand &&
    !!target3.querySelector('.replay-transport button[aria-label="Play"]'),
  `plays +${(globalThis.__plays || 0) - playsBeforeDockPauseExpand}`,
);

// "Collapse after a dock pause records no resume": the deactivation
// re-records the intent from the ENGINE (paused → false), so the next
// expand still stays paused — the dock-pause intent survives its own
// round trip.
const j2Leave2 = { plays: globalThis.__plays || 0, pauses: globalThis.__pauses || 0 };
globalThis.__setActive(false);
await sleep();
check(
  're-collapsing the dock-paused replay issues no pause call (already paused)',
  (globalThis.__pauses || 0) === j2Leave2.pauses,
  `+${(globalThis.__pauses || 0) - j2Leave2.pauses} pause calls`,
);
check('the caption offers Play', miniGlyph3() === 'play', miniGlyph3());
globalThis.__setActive(true);
await sleep();
check(
  'the next expand still stays paused (collapse-after-dock-pause recorded no resume)',
  (globalThis.__plays || 0) === j2Leave2.plays &&
    !!target3.querySelector('.replay-transport button[aria-label="Play"]'),
  `plays +${(globalThis.__plays || 0) - j2Leave2.plays}`,
);

// Positive controls: the wrapper's OWN handlers fire — so every
// "never reaches the wrapper" pin above proves reachability-blocking,
// not dead handlers.
click(probe3);
await sleep();
check(
  'positive control: a click on the wrapper reaches its expand handler',
  (globalThis.__wrapperClicks || 0) === wrapC0 + 1,
  `wrapper clicks +${(globalThis.__wrapperClicks || 0) - wrapC0}`,
);
probe3.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await sleep();
check(
  'positive control: Enter on the wrapper reaches its keydown handler',
  (globalThis.__wrapperKeys || 0) === wrapK0 + 1,
  `wrapper keys +${(globalThis.__wrapperKeys || 0) - wrapK0}`,
);

// --- (K): keep-alive entry seed — distinct applies ONCE, identical/null never
// A FOURTH instance mounts with a ?tick= seed and a SETTABLE query
// (globalThis.__setQuery replaces the whole query object — exactly what
// App's replayQuery re-derives on every same-id replay navigation), so
// the driver drives in-session route churn against ONE live instance:
// the mount path applies its seed exactly once (startEngine seeds the
// record, and the watcher's pre-engine runs defer to it), every DISTINCT
// resolution applies once, identical-value churn and a no-promise rewrite
// never move the playhead — and under parameter separation a
// round-scope-only rewrite NEVER seeks (the scope is feed filter; only a
// stamped ?tick= is a position), while expandReplayHash's dropped ?tick=
// resets the baseline so the SAME watch link re-seeks. No application
// ever touches play/pause.
// The engine stub logs every seed-path seekTick into globalThis.__seeks
// (seekFrame — scrubbing — is not a seed path and stays unlogged).
console.log('K. keep-alive entry seed: mount once, distinct applies once, scope never seeks, identical/null never, seek never touches play/pause');
const seeksBase = [...(globalThis.__seeks || [])];
const playsK0 = globalThis.__plays || 0;
const pausesK0 = globalThis.__pauses || 0;
const seeksNow = () => [...(globalThis.__seeks || [])];
const seeksDelta = () => seeksNow().length - seeksBase.length;
const target4 = document.createElement('div');
document.body.appendChild(target4);
const harness4Src = `<script>
  import Replay from './views/Replay.js';
  let query = $state({ tick: '192' });
  let active = $state(true);
  globalThis.__setQuery = (q) => (query = q);
  globalThis.__setActive4 = (v) => (active = v);
</script>
<Replay id={1} {query} {active} nav={(h) => (globalThis.__nav4 = (globalThis.__nav4 || []).concat(h))} />`;
const harness4Out = join(dir, 'harness4.js');
svelteCompile(harness4Src, 'harness4.svelte', harness4Out);
const mod4 = await import(pathToFileURL(harness4Out).href);
mount(mod4.default, { target: target4 });
await sleep();
await sleep(); // load() → startEngine: the mount seed applies ONCE
check(
  'mount applies its ?tick= seed exactly once (the fresh-mount path owns the pre-engine runs)',
  seeksDelta() === 1 && seeksNow().at(-1) === 192,
  JSON.stringify(seeksNow().slice(seeksBase.length)),
);
// Identical-value churn: a NEW query object with the SAME resolved seed
// (a filter edit that keeps ?tick=, an expandReplayHash round trip).
globalThis.__setQuery({ tick: '192', back: 'match/1' });
await sleep();
check(
  'an identical-value query rewrite never re-seeks (entry-once per distinct seed)',
  seeksDelta() === 1,
  JSON.stringify(seeksNow().slice(seeksBase.length)),
);
// A NEW distinct ?tick= (a RoundDetail/Combat link while alive) applies once.
globalThis.__setQuery({ tick: '256' });
await sleep();
const readout4 = () => target4.querySelector('.replay-readout')?.getAttribute('title') || '';
check(
  'a NEW distinct ?tick= seed applies (one seek → tick 256)',
  seeksDelta() === 2 && seeksNow().at(-1) === 256,
  JSON.stringify(seeksNow().slice(seeksBase.length)),
);
check('the playhead reads the applied seed (readout → tick 256)', readout4().endsWith('tick 256'), readout4());
// A no-promise rewrite (the palette's plain same-id jump): never seeks.
globalThis.__setQuery({});
await sleep();
check(
  'a no-promise rewrite (no ?tick=) never seeks',
  seeksDelta() === 2,
  JSON.stringify(seeksNow().slice(seeksBase.length)),
);
check('and the playhead stays put (still tick 256)', readout4().endsWith('tick 256'), readout4());
// A round-scope-ONLY rewrite (the palette's saved-filter jump, an
// "events" drill with no stamped tick): the scope is FEED FILTER state —
// it never moves the playhead, mid-session or at mount.
globalThis.__setQuery({ roundFrom: '2', roundTo: '2' });
await sleep();
check(
  'a round-scope-only rewrite NEVER seeks (the scope is filter state)',
  seeksDelta() === 2 && readout4().endsWith('tick 256'),
  `${JSON.stringify(seeksNow().slice(seeksBase.length))} | ${readout4()}`,
);
// The stamped watch link (what every in-app round drill now carries):
// ?tick= BESIDE the scope lands on the round's start (round 2 → 640).
globalThis.__setQuery({ roundFrom: '2', roundTo: '2', tick: '640' });
await sleep();
check(
  'a STAMPED ?tick= beside the scope applies (round 2 start → tick 640)',
  seeksDelta() === 3 && seeksNow().at(-1) === 640 && readout4().endsWith('tick 640'),
  `${JSON.stringify(seeksNow().slice(seeksBase.length))} | ${readout4()}`,
);
// The SAME stamped seed with a ?back= rewrite around it: no re-apply.
globalThis.__setQuery({ roundFrom: '2', roundTo: '2', tick: '640', back: 'match/1/round/2' });
await sleep();
check(
  'the same stamped seed again (back rewrite) never re-seeks',
  seeksDelta() === 3,
  JSON.stringify(seeksNow().slice(seeksBase.length)),
);
// THE EXPAND: expandReplayHash drops the consumed ?tick= (the running
// engine owns the playhead) — the rewrite itself never moves the
// playhead, and the baseline goes back to "no tick".
const { expandReplayHash } = await import('../src/lib/nav.js');
const expanded4 = expandReplayHash(
  '#/replay/1?roundFrom=2&roundTo=2&tick=640&back=match/1/round/2',
  'match/1',
);
// App's replayQuery is parseHash's query — the same URLSearchParams
// construction, so this is byte-for-byte what the watcher would see.
globalThis.__setQuery(Object.fromEntries(new URLSearchParams(expanded4.split('?')[1] || '')));
await sleep();
check(
  'the expand drops the consumed ?tick= and never seeks (playhead kept)',
  !expanded4.includes('tick=') && seeksDelta() === 3 && readout4().endsWith('tick 640'),
  `${expanded4} | seeks=+${seeksDelta()} | ${readout4()}`,
);
// The repeat-click wart is fixed: with the stale tick gone from the
// baseline, re-clicking the SAME watch link re-seeks.
globalThis.__setQuery({ roundFrom: '2', roundTo: '2', tick: '640' });
await sleep();
check(
  're-clicking the SAME watch link re-seeks (the expand cleared the baseline)',
  seeksDelta() === 4 && seeksNow().at(-1) === 640,
  JSON.stringify(seeksNow().slice(seeksBase.length)),
);
// The loop promise: a distinct ?loop= arms (bounds + enable) WITHOUT a
// seek — this seed carries no tick.
const transport4 = target4.querySelector('.replay-transport');
const controls4 = transport4?.children[1];
const loopBtn4 = controls4?.querySelector('button[aria-label="Loop range"]');
check('the instance rendered its transport loop control', !!loopBtn4, String(!!loopBtn4));
globalThis.__setQuery({ loop: '0,320' });
await sleep();
check(
  'a distinct ?loop= arms the loop (and seeks nothing — no tick promise)',
  loopBtn4?.getAttribute('aria-pressed') === 'true' && seeksDelta() === 4,
  `pressed=${loopBtn4?.getAttribute('aria-pressed')} seeks=+${seeksDelta()}`,
);
// Same-value churn must not re-arm: turn the loop OFF (the popover's
// Loop button — engine state only, the URL keeps ?loop=), then churn the
// query with the SAME range. A re-apply would flip it back on.
click(loopBtn4);
await sleep();
const loopOff4 = controls4?.querySelector('.rp-loop-pop button[title="Toggle loop (L)"]');
check('the popover offers the Loop toggle while armed', !!loopOff4, String(!!loopOff4));
click(loopOff4);
await sleep();
check(
  'the toggle turns the entry loop off',
  loopBtn4.getAttribute('aria-pressed') === 'false',
  loopBtn4.getAttribute('aria-pressed'),
);
click(loopBtn4); // close the popover (section H's pattern)
await sleep();
globalThis.__setQuery({ loop: '0,320', cat: 'kills' });
await sleep();
check(
  'identical ?loop= churn never re-arms (the toggle-off survives)',
  loopBtn4.getAttribute('aria-pressed') === 'false',
  loopBtn4.getAttribute('aria-pressed'),
);
// A NEW distinct range re-arms it.
globalThis.__setQuery({ loop: '64,576' });
await sleep();
check(
  'a NEW distinct ?loop= range re-arms the loop (and still seeks nothing)',
  loopBtn4.getAttribute('aria-pressed') === 'true' && seeksDelta() === 4,
  `pressed=${loopBtn4?.getAttribute('aria-pressed')} seeks=+${seeksDelta()}`,
);
// The full promise (Combat's ▶ shape: ?tick= + ?loop=): BOTH apply —
// seek first, then arm, so the arm lands behind the seek's
// cancelLoopIfOutside instead of being cancelled by it.
globalThis.__setQuery({ tick: '384', loop: '320,576' });
await sleep();
check(
  'a fresh tick+loop link applies BOTH (seek → 384, range armed)',
  seeksDelta() === 5 && seeksNow().at(-1) === 384 &&
    loopBtn4.getAttribute('aria-pressed') === 'true' && readout4().endsWith('tick 384'),
  `seeks=${JSON.stringify(seeksNow().slice(seeksBase.length))} pressed=${loopBtn4?.getAttribute('aria-pressed')} | ${readout4()}`,
);
check(
  'seeking never touched play/pause (the mount autoplay is the only play)',
  (globalThis.__plays || 0) === playsK0 + 1 && (globalThis.__pauses || 0) === pausesK0,
  `plays +${(globalThis.__plays || 0) - playsK0}, pauses +${(globalThis.__pauses || 0) - pausesK0}`,
);
// The dock leg: collapsing pauses (the resume intent is recorded), and a
// distinct seed landing while collapsed seeks WITHOUT resuming the
// user's pause — seeking is a position change only.
globalThis.__setActive4(false);
await sleep();
const playsAfterCollapse = globalThis.__plays || 0;
const pausesAfterCollapse = globalThis.__pauses || 0;
check(
  'collapsing pauses the instance (the dock records its resume intent)',
  pausesAfterCollapse === pausesK0 + 1,
  `pauses +${pausesAfterCollapse - pausesK0}`,
);
globalThis.__setQuery({ tick: '64' });
await sleep();
check(
  'a distinct seed over the collapsed dock seeks without resuming the pause',
  seeksDelta() === 6 && seeksNow().at(-1) === 64 &&
    (globalThis.__plays || 0) === playsAfterCollapse &&
    (globalThis.__pauses || 0) === pausesAfterCollapse,
  `seeks=${JSON.stringify(seeksNow().slice(seeksBase.length))} plays +${(globalThis.__plays || 0) - playsAfterCollapse} pauses +${(globalThis.__pauses || 0) - pausesAfterCollapse}`,
);
globalThis.__setActive4(true);
await sleep();
check(
  'expanding resumes exactly once (the seek changed nothing)',
  (globalThis.__plays || 0) === playsAfterCollapse + 1,
  `plays +${(globalThis.__plays || 0) - playsAfterCollapse}`,
);

// --- (K2): a scope-only MOUNT never seeks; the loop half still resolves
// against the rounds that arrive. A FIFTH instance mounts with a round
// scope and an entry ?loop=: under parameter separation the scope is no
// seek promise AT ALL — even though the rounds list loads AFTER the
// route is set (the old resolver turned exactly this shape into a
// round-start seek), so the mount issues ZERO seed seeks and the
// playhead sits at the pref default (tick 0 here — the first counted
// round's start, which equals the engine's native start, so there is
// not even a default seek to make). The loop promise still applies
// ONCE, after the rounds are in (the span gate has its list), and
// identical-value churn applies nothing.
console.log('K2. a scope-only mount never seeks (the old round-start seek is gone); its ?loop= applies once');
const seeksBase5 = [...(globalThis.__seeks || [])];
const target5 = document.createElement('div');
document.body.appendChild(target5);
const harness5Src = `<script>
  import Replay from './views/Replay.js';
  let query = $state({ roundFrom: '2', roundTo: '2', loop: '0,320' });
  globalThis.__setQuery5 = (q) => (query = q);
</script>
<Replay id={1} {query} nav={(h) => (globalThis.__nav5 = (globalThis.__nav5 || []).concat(h))} />`;
const harness5Out = join(dir, 'harness5.js');
svelteCompile(harness5Src, 'harness5.svelte', harness5Out);
const mod5 = await import(pathToFileURL(harness5Out).href);
mount(mod5.default, { target: target5 });
await sleep();
await sleep(); // load() → startEngine with the rounds in
const seeks5 = () => seeksNow().slice(seeksBase5.length);
check(
  'a scope-only mount NEVER seeks (the scope is filter state — never round 2 → 640)',
  seeks5().length === 0 && !seeks5().includes(640),
  JSON.stringify(seeks5()),
);
const readout5 = () => target5.querySelector('.replay-readout')?.getAttribute('title') || '';
check(
  'the playhead sits at the pref default (tick 0), never at the scope',
  readout5().endsWith('tick 0') && !readout5().endsWith('tick 640'),
  readout5(),
);
const loopBtn5 = target5.querySelector('.replay-transport button[aria-label="Loop range"]');
check(
  'the entry ?loop= applies once against the rounds that arrived (armed)',
  loopBtn5?.getAttribute('aria-pressed') === 'true',
  loopBtn5?.getAttribute('aria-pressed'),
);
// Identical-value churn (rounds loaded now): nothing re-applies.
globalThis.__setQuery5({ roundFrom: '2', roundTo: '2', loop: '0,320', back: 'match/1' });
await sleep();
check(
  'the same scope+loop once the rounds are loaded never re-seeks',
  seeks5().length === 0,
  JSON.stringify(seeks5()),
);

// ============================================================================
// APPENDED SECTION (feed-reveal work) — kept apart from the sections above on
// purpose: replay.dom.mjs is edited by a parallel worker, so this block is a
// single self-contained tail. Do not renumber what precedes it.
// ============================================================================

// --- (M): feed reveal on FILTER ARRIVAL (landmarks.shouldRevealFeed wiring) --
// The pure decision lives in src/lib/landmarks.test.js (unit-pinned); this
// only pins Replay.svelte's WIRING: a non-default filter arriving at MOUNT
// opens the feed rail (harness5 mounts scoped), an in-session filter edit on
// an ACTIVE instance never force-opens a closed rail, a keep-alive ACTIVATION
// with a DIFFERENT non-default filter reveals it, and the SAME filter arriving
// again after the user closed it (the dock expand carries the instance's own
// captured query) stays closed.
console.log('M. feed reveal on filter arrival (mount + activation, never same-filter churn)');
const railOf = (t) => !!t?.querySelector('.replay-side');
const filtersBtnOf = (t) =>
  t?.querySelector('.lm-toolbar button[title^="Show/hide"]');
check('MOUNT: a non-default filter reveals the feed rail (harness5 is scoped)', railOf(target5), '');
check(
  'MOUNT: the filter panel rode along with the reveal',
  filtersBtnOf(target5)?.getAttribute('aria-expanded') === 'true',
  filtersBtnOf(target5)?.getAttribute('aria-expanded'),
);
check('target4 rail starts closed (its mount filter was the default)', !railOf(target4), '');
globalThis.__setQuery({ roundFrom: '2', roundTo: '2' });
await sleep();
check(
  'IN-SESSION: a scoped filter edit on an ACTIVE instance never reveals',
  !railOf(target4),
  '',
);
globalThis.__setActive4(false);
await sleep();
globalThis.__setQuery({ roundFrom: '5', roundTo: '5' });
await sleep();
globalThis.__setActive4(true);
await sleep();
check(
  'ACTIVATION: a DIFFERENT non-default filter reveals the rail (heatmap drill on a live instance)',
  railOf(target4),
  '',
);
const close4 = target4.querySelector('.replay-side .side-toggle');
check('the revealed rail offers its close toggle', !!close4);
click(close4);
await sleep();
check('the user can close the revealed rail', !railOf(target4), '');
globalThis.__setActive4(false);
await sleep();
globalThis.__setActive4(true);
await sleep();
check(
  'ACTIVATION with the SAME filter never re-opens a user-closed rail',
  !railOf(target4),
  '',
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
