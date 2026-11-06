// jsdom driver for Replay: a FRESH replay opens with the landmark feed
// COLLAPSED — its toggle now floats INSIDE the render stage (top-right,
// spec 14) next to the floating back button, with no .replay-side at all
// until it expands — the round ribbon sits on its own centered line
// above the stage, and the transport splits into the full-width
// game-time scrubber line ABOVE the centered control-cluster line
// (loop popover, camera Smart/Free/Follow, mute-all, hints-only
// codicon, snapshot/record).
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
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
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

// The view's data source and platform glue are scripted, never a live
// Wails backend or a real render loop: sidecar meta resolves, every feed
// read is empty, and the engine/renderer/input are inert objects.
writeFileSync(
  join(dir, 'services.js'),
  `export const getReplayMeta = () =>
  Promise.resolve({ hasSidecar: true, tickRate: 64, frames: 10, players: [] });
export const getEvents = () => Promise.resolve([]);
export const getEvent = () => Promise.resolve(null);
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
      state.frame = f;
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
    setHud() {},
    resize() {},
    draw() {},
    setCameraMode() {},
    destroy() {},
  };
}
`,
);

writeFileSync(
  join(dir, 'replay', 'input.js'),
  `export const attachReplayInput = () => ({ detach() {} });
export const snapshot = () => {};
`,
);

writeFileSync(
  join(dir, 'replay', 'audio.js'),
  `export const createVoiceEngine = () => null;
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
// to the compiled .js (ProfileLink is shared by LandmarkRow). RoundStrip
// additionally reads the kvstore binding (the knife/warmup pref), whose
// import is rewritten to the components/kvstore.js stub above.
for (const name of ['ProfileLink', 'FilterBar', 'EventFlags', 'PayloadTree', 'LandmarkRow', 'Popover', 'RoundStrip']) {
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

console.log('A. fresh replay: no header/title; back + the collapsed rail toggle float INSIDE the stage');
const stage = target.querySelector('.replay-stage');
check('stage rendered', !!stage);
check('no view header and no Replay title', !target.querySelector('.view-header') && !target.querySelector('h1'));
const back = stage?.querySelector('.rp-back');
check('floating back button inside the stage', !!back, 'missing .rp-back');
check(
  'back button is icon-only with the Back label',
  back?.getAttribute('aria-label') === 'Back' && back?.getAttribute('title') === 'Back' &&
    !!back?.querySelector('.codicon-arrow-left') && !back.textContent.trim(),
);
const toggle = stage?.querySelector('.side-toggle');
check('collapsed rail toggle inside the stage', !!toggle, 'missing stage .side-toggle');
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

console.log('B. the stage handle expands the panel (existing eventsOpen toggle)');
click(toggle);
await sleep();
const aside = target.querySelector('.replay-side');
check('aside expanded', !!aside && !aside.classList.contains('collapsed'));
check('stage toggle gone while expanded', !stage.querySelector('.side-toggle'));
const head = aside?.querySelector('.side-toggle');
check('expanded header owns the toggle', !!head);
check('header aria-expanded=true', head?.getAttribute('aria-expanded') === 'true', head?.getAttribute('aria-expanded'));
check('expanded header renders the count', head?.querySelector('.num')?.textContent === '0', head?.querySelector('.num')?.textContent);
check('feed toolbar present', !!aside?.querySelector('.lm-toolbar'));
check('landmark list present (empty state)', !!aside?.querySelector('.landmark-list'));
check('expanded panel keeps its scroll body', !!aside?.querySelector('.lm-scroll'));
click(head);
await sleep();
check('header chevron collapses the rail again', !target.querySelector('.replay-side') && !!stage.querySelector('.side-toggle'));

console.log('C. round ribbon: its own centered line above the stage');
const main = target.querySelector('.replay-main');
const ribbon = main?.querySelector(':scope > .round-strip-wrap');
check('ribbon mounted as a direct child of .replay-main', !!ribbon, 'missing .round-strip-wrap');
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
check('play button in the control cluster', !!controls.querySelector('button[aria-label="Play"]'));
check(
  'speed + camera selects in the cluster (NO jump-to-round)',
  !!controls.querySelector('#rp-speed') && !!controls.querySelector('#rp-cam') &&
    !controls.querySelector('#rp-round'),
);
const camOpts = [...(controls.querySelector('#rp-cam')?.options || [])].map((o) => o.value);
check('camera select offers Smart/Free/Follow', JSON.stringify(camOpts) === '["smart","free","follow"]', JSON.stringify(camOpts));
check('no follow-player select until Follow is chosen', !controls.querySelector('#rp-follow'));
check('no leftover voice bar / lanes', !target.querySelector('.voice-bar') && !target.querySelector('.voice-lanes-wrap'));
const muteAll = controls.querySelector('button[aria-label="Mute all"]');
check('mute-all button in the cluster', !!muteAll);
check('mute-all disabled when the match has no voice', muteAll?.disabled === true, String(muteAll?.disabled));
check(
  'hints: codicon only, the word "hints" is gone',
  !!controls.querySelector('.codicon-keyboard') && !controls.textContent.includes('hints'),
);
check(
  'snapshot + record/clip moved into the cluster',
  controls.textContent.includes('Snapshot') && !!controls.querySelector('.clip-btn'),
);
check('play controls are NOT on the scrub line', !scrub.querySelector('button[aria-label="Play"]'));

console.log('E. loop popover + the Follow player dropdown');
const loopBtn = controls.querySelector('button[aria-label="Loop range"]');
check('loop trigger is an icon-only loop-codicon button', !!loopBtn && !!loopBtn.querySelector('.codicon-sync') && !loopBtn.textContent.trim());
check('loop inputs hidden until the popover opens', !controls.querySelector('#rp-loop-from'));
click(loopBtn);
await sleep();
check(
  'popover exposes the from/to inputs + the Loop toggle',
  !!controls.querySelector('#rp-loop-from') && !!controls.querySelector('#rp-loop-to') &&
    !!controls.querySelector('button[title="Toggle loop (L)"]'),
);
const cam = controls.querySelector('#rp-cam');
cam.value = 'follow';
cam.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check('choosing Follow reveals the player dropdown', !!controls.querySelector('#rp-follow'));
check('camera select still reads follow', cam.value === 'follow', cam.value);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
