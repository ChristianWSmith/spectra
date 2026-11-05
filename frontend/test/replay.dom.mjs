// jsdom driver for Replay: a FRESH replay opens with the landmark feed
// COLLAPSED behind the floating handle (toggle present with the event
// count, feed toolbar/list absent until it expands — the existing
// eventsOpen toggle still flips it), and the transport splits into the
// full-width scrubber line ABOVE the control-cluster line.
//
// The view's data source, engine, renderer and input are scripted stubs —
// this driver pins STRUCTURE, not rendering (CSS placement of the
// floating handle is verified by the human, not jsdom).
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
// the landmark-row / combat drivers do); csv.js and payloadTree.js are
// import-free.
for (const rel of ['rounds.js', 'router.js', 'nav.js', 'fmt.js', 'csv.js', 'payloadTree.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
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
export const getMatch = () => Promise.resolve({ map: '' });
export const getRounds = () => Promise.resolve([]);
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

// The six child components — only their ./X.svelte imports need rewriting
// to the compiled .js (ProfileLink is shared by LandmarkRow/VoiceLanes).
for (const name of ['ProfileLink', 'FilterBar', 'EventFlags', 'PayloadTree', 'LandmarkRow', 'VoiceLanes']) {
  const src = readFileSync(`src/lib/components/${name}.svelte`, 'utf8').replace(
    /from '\.\/(\w+)\.svelte'/g,
    "from './$1.js'",
  );
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

console.log('A. fresh replay: the landmark feed starts COLLAPSED');
const aside = target.querySelector('.replay-side');
check('rail rendered', !!aside);
check('aside is collapsed by default', aside?.classList.contains('collapsed'));
const toggle = aside?.querySelector('.side-toggle');
check('toggle present', !!toggle);
check('toggle aria-expanded=false', toggle?.getAttribute('aria-expanded') === 'false', toggle?.getAttribute('aria-expanded'));
check(
  'toggle title/aria-label carry the event count',
  toggle?.getAttribute('aria-label') === 'Landmarks (0 events)' &&
    toggle?.getAttribute('title') === 'Landmarks (0 events)',
  toggle?.getAttribute('aria-label'),
);
check('collapsed handle shows the chevron-left glyph', !!toggle?.querySelector('.codicon-chevron-left'));
check('feed toolbar absent while collapsed', !aside?.querySelector('.lm-toolbar'));
check('landmark list absent while collapsed', !aside?.querySelector('.landmark-list'));

console.log('B. the handle expands the panel (existing eventsOpen toggle)');
click(toggle);
await sleep();
check('aside expanded', !aside.classList.contains('collapsed'));
check('toggle aria-expanded=true', toggle.getAttribute('aria-expanded') === 'true', toggle.getAttribute('aria-expanded'));
check('expanded header renders the count', aside.querySelector('.side-toggle .num')?.textContent === '0', aside.querySelector('.side-toggle .num')?.textContent);
check('feed toolbar present', !!aside.querySelector('.lm-toolbar'));
check('landmark list present (empty state)', !!aside.querySelector('.landmark-list'));
check('expanded panel keeps its scroll body', !!aside.querySelector('.lm-scroll'));

console.log('C. transport: scrubber on its own full-width line above the controls');
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
check('frame/tick readout rides with the scrubber', !!scrub.querySelector('.replay-readout'));
check(
  'scrub line holds only the scrubber wrap + readout (full-width, no controls)',
  children(scrub).length === 2 && children(scrub)[0].classList.contains('scrubber-wrap') &&
    children(scrub)[1].classList.contains('replay-readout'),
  children(scrub).map((el) => el.className).join(' | '),
);
const controls = lines[1];
check('play button in the control cluster', !!controls.querySelector('button[aria-label="Play"]'));
check(
  'speed/round/camera/follow selects in the cluster',
  !!controls.querySelector('#rp-speed') && !!controls.querySelector('#rp-round') &&
    !!controls.querySelector('#rp-cam') && !!controls.querySelector('#rp-follow'),
);
check(
  'loop inputs + Loop button in the cluster',
  !!controls.querySelector('#rp-loop-from') && !!controls.querySelector('#rp-loop-to') &&
    !!controls.querySelector('button[title="Toggle loop (L)"]'),
);
check('hints stay in the cluster', controls.textContent.includes('hints'));
check('play controls are NOT on the scrub line', !scrub.querySelector('button[aria-label="Play"]'));

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
