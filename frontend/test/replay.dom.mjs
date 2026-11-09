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
// popover, loop popover, camera Smart/Free/Follow popover, the volume
// popover, snapshot/record, and
// the hints-only codicon LAST — three .toolbar-sep rules split those
// groups: after the loop control, after the volume host, before the
// hints). A fresh replay also AUTOPLAYS (startEngine
// calls engine.play() once the position data is up).
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
// state index here → shots: [], icon/explosion rows only).
for (const rel of [
  'playercard.js', 'playercolor.js', 'livestats.js', 'voiceindex.js',
  'sfx.js', 'stretch.js', 'bullets.js', 'decoy.js', 'bomb.js',
  // playercard.js now resolves its held-item prefix through
  // replay/loadout.js (the one loadout vocabulary) — copy it too, or the
  // card graph fails to link (its own deps, landmarks.js + bullets.js,
  // are already in this list).
  'loadout.js',
]) {
  writeFileSync(join(dir, 'replay', rel), readFileSync(join('src/lib/replay', rel), 'utf8'));
}

// The player-state loader is fetch-based: stub it so the suite pins the
// VIEW's capability contract deterministically — the mounted replay (id 1)
// mounts against a V1 sidecar (it HAS a stateFormatVersion, not the
// current one) → the one honest reprocess note, no state loaded.
// stateAt is the bullets.js import (its magAmmo walk): the real one
// lives in replay/state.js; null index → deriveBullets never reaches it.
writeFileSync(
  join(dir, 'replay', 'state.js'),
  `export const STATE_FORMAT_VERSION = 2;
export function stateCapable(meta) {
  return !!meta && meta.stateFormatVersion === STATE_FORMAT_VERSION;
}
export async function fetchStateMeta() {
  return { stateFormatVersion: 1, players: [], weaponNames: [] };
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
export const getEvents = (filter) => {
  const kinds = (filter && filter.kinds) || [];
  if (kinds.includes('player_connect') || kinds.includes('player_disconnect')) {
    return Promise.resolve(CONN_ROWS);
  }
  return Promise.resolve([]);
};
export const getEvent = () => Promise.resolve(null);
// Flash-white overlay durations (matched to blind rows by seq) — none
// in the stub: the view's join yields [] and setBlinds receives it.
export const getBlindDurations = () => Promise.resolve([]);
export const getChat = () => Promise.resolve([]);
export const getGenericEvents = () => Promise.resolve([]);
export const getGenericHistogram = () => Promise.resolve([]);
export const getMatch = () => Promise.resolve({ map: '', sideSwitches: 1 });
export const getRounds = () =>
  Promise.resolve([
    { number: 1, winner: 'ct', reason: 'CTWin', startTick: 0, endTick: 576, freezeEndTick: 64, warmup: false, pregame: false, bombSite: '' },
    { number: 2, winner: 't', reason: 'BombDefused', startTick: 640, endTick: 1216, freezeEndTick: 704, warmup: false, pregame: false, bombSite: 'A' },
  ]);
export const getTeamNames = () => Promise.resolve({ ct: 'Alpha', t: 'Bravo' });
export const getScoreboard = () => Promise.resolve([]);
export const getVoicePresence = () => Promise.resolve(null);
export const getVoicePlayers = () => Promise.resolve([]);
export const getVoiceLanes = () => Promise.resolve(null);
export const voiceWavURL = () => '';
export const extractIcons = () => Promise.resolve({ ok: false });
export const listSavedFilters = () => Promise.resolve([]);
export const saveFilter = () => Promise.resolve(null);
export const deleteSavedFilter = () => Promise.resolve(null);
export const getPref = () => Promise.resolve(null);
export const setPref = () => Promise.resolve();
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
    loopFrom: -1,
    loopTo: -1,
    loopEnabled: false,
  };
  let emit = null;
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
      state.tick = t;
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
      emit?.(state);
    },
    play() {
      state.playing = true;
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
    setLoop() {},
    toggleLoop() {},
    // The loop popover resolves typed TIMES through the engine's
    // exact-frame search (Replay's onLoopTime) — same rule as the real
    // engine: the first frame whose tick is >= t, clamped to the stream
    // (the stub's ticks are 0, 64, … 576).
    frameForTick(t) {
      const f = Number.isFinite(t) ? Math.floor(t / 64) : 0;
      return Math.max(0, Math.min(9, f));
    },
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
    setHud() {},
    setIcons() {},
    setVoices() {},
    setStateIndex() {},
    resize() {},
    draw() {},
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
  'bar order: back first, ribbon cell in the middle, rail toggle last',
  topbar && children(topbar)[0] === back && children(topbar)[1]?.classList.contains('rp-ribbon') &&
    children(topbar)[children(topbar).length - 1] === toggle,
  (topbar ? children(topbar).map((el) => el.className || el.tagName).join(' | ') : 'no topbar'),
);
check('no .replay-side while collapsed', !target.querySelector('.replay-side'));
check('toggle aria-expanded=false', toggle?.getAttribute('aria-expanded') === 'false', toggle?.getAttribute('aria-expanded'));
check(
  'toggle title/aria-label carry the event count',
  toggle?.getAttribute('aria-label') === 'Landmarks (0 events)' &&
    toggle?.getAttribute('title') === 'Landmarks (0 events)',
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
  'no native select left for speed/camera (only Follow player still uses one)',
  !controls.querySelector('select#rp-speed') && !controls.querySelector('select#rp-cam') &&
    !controls.querySelector('#rp-speed select') && !controls.querySelector('#rp-cam select'),
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
check('no follow-player select until Follow is chosen', !controls.querySelector('#rp-follow'));
check('no leftover voice bar / lanes', !target.querySelector('.voice-bar') && !target.querySelector('.voice-lanes-wrap'));
// CHARACTERIZATION: these three checks pinned the old mute-all button —
// a direct-child button[aria-label="Mute all"], disabled because this
// fixture has NO voice, with separator 2 immediately behind it. Delta:
// that button is now the VOLUME POPOVER's trigger inside a host span
// (same cluster slot), it is NEVER disabled (voice is one row of four —
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
// above the trigger, exposes the FOUR fader rows, and the VOICE row is
// disabled in this no-voice fixture while guns/utility/C4 stay live
// (they never need the match to have voice).
check('volume popover closed on entry', !controls.querySelector('#rp-vol-voice'));
click(volBtn);
await sleep();
const volRows = [...controls.querySelectorAll('.rp-vol-pop .rp-vol-row')];
check(
  'volume popover has four rows: Voice, Guns, Utility, C4',
  volRows.length === 4 &&
    volRows.map((r) => (r.querySelector('.field-label')?.textContent || '').trim()).join(',') ===
      'Voice,Guns,Utility,C4',
  volRows.map((r) => (r.querySelector('.field-label')?.textContent || '?').trim()).join(','),
);
check(
  'each row has a 0..100 range fader and a mute toggle button',
  volRows.length === 4 &&
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
const voiceSlider = controls.querySelector('#rp-vol-voice');
const voiceMute = controls.querySelector('button[aria-label="Mute voice"]');
check(
  'voice row disabled without voice (slider + mute toggle)',
  !!voiceSlider && voiceSlider.disabled === true && !!voiceMute && voiceMute.disabled === true,
  `slider=${voiceSlider?.disabled} mute=${voiceMute?.disabled}`,
);
check(
  'guns/utility/C4 rows stay ENABLED without voice',
  controls.querySelector('#rp-vol-guns')?.disabled === false &&
    controls.querySelector('button[aria-label="Mute guns"]')?.disabled === false &&
    controls.querySelector('#rp-vol-utility')?.disabled === false &&
    controls.querySelector('button[aria-label="Mute utility"]')?.disabled === false &&
    controls.querySelector('#rp-vol-c4')?.disabled === false &&
    controls.querySelector('button[aria-label="Mute c4"]')?.disabled === false,
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
check('choosing Follow reveals the player dropdown', !!controls.querySelector('#rp-follow'));
check(
  'camera trigger still reads the chosen mode',
  controls.querySelector('#rp-cam button')?.textContent.trim() === 'Follow',
  controls.querySelector('#rp-cam button')?.textContent,
);
// Follow must never rest on the "Follow player…" placeholder: with no
// ?follow= in the route it lands on a real player (slot 0), and a
// detour through Free comes back to the player that was being followed.
check(
  'Follow lands on a real player, never the placeholder',
  controls.querySelector('#rp-follow')?.value === '0',
  controls.querySelector('#rp-follow')?.value,
);
const followSel = controls.querySelector('#rp-follow');
followSel.value = '2';
followSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check('the dropdown drives the follow slot', controls.querySelector('#rp-follow')?.value === '2', controls.querySelector('#rp-follow')?.value);
await chooseCam('Free');
check('switching to Free releases follow (player dropdown gone)', !controls.querySelector('#rp-follow'));
await chooseCam('Follow');
check(
  'switching back to Follow resumes the player that was being followed',
  controls.querySelector('#rp-follow')?.value === '2',
  controls.querySelector('#rp-follow')?.value,
);

console.log('F. player-card columns: grouping, team names, mute wiring, v1 state note');
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
// The v1 sidecar note (handoff B): present exactly once, truthful wording.
const stateNotes = [...target.querySelectorAll('.note-amber')].filter((n) =>
  n.textContent.includes('player state unavailable'),
);
check('v1 sidecar shows the ONE state-unavailable note', stateNotes.length === 1, String(stateNotes.length));
check(
  'note tells the user a reprocess gains the card fields',
  !!stateNotes[0] && /reprocess this match to gain HP\/weapon\/money/.test(stateNotes[0].textContent),
  stateNotes[0]?.textContent,
);

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
// The follow dropdown must not offer a player the camera cannot track.
await chooseCam('Follow');
const followOpts = () =>
  [...controls.querySelectorAll('#rp-follow option')].map((o) => o.value).filter((v) => v !== '');
check(
  'the follow dropdown drops the disconnected (and the not-yet-joined) player',
  followOpts().join(',') === '0,1,3,4',
  followOpts().join(','),
);
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
// 14 = 13 + the grenade_lands category (the decoy ACTIVATION —
// lib/replay/landmarks.js CATEGORIES gained one opt-in entry with the
// decoy lifecycle split; default selection is unchanged).
check('one checkbox per category', catBoxes.length === 14, String(catBoxes.length));
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

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
