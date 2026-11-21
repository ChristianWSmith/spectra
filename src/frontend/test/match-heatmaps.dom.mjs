// jsdom driver for the Heatmaps tab's card (src/lib/builtins/match/
// HeatmapsPanel.svelte; PLAN C5-Heat-Combat), mounted with a FIXED context
// { matchId: 7 } the way the Heatmaps builtin mounts it. The services are
// scripted (no Wails backend): the match, the roster, the rounds and the
// heatmap binding. Checks: the card reads the context's match (every read
// carries 7), the controls render from the roster and rounds, Generate fires
// one heatmap read with the chosen kind, the legend shows the stored grid's
// samples, size and maximum, and a control change marks the raster stale.
//
// Run: node test/match-heatmaps.dom.mjs   (from frontend/)
import { registerHooks } from 'node:module';

const { JSDOM } = await import('jsdom');
const { compile, compileModule } = await import('svelte/compiler');
const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');

// The bindings import is the test stub (every service namespace exported).
const BINDINGS_STUB = pathToFileURL(join('test', 'stubs', 'bindings.mjs')).href;
const STRINGS = pathToFileURL(join('src', 'lib', 'strings', 'index.js')).href;
// svelte's package exports pick the SERVER build without the `browser`
// condition (mount() then throws "lifecycle_function_unavailable"), so the
// driver adds it for every svelte specifier.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.includes('bindings/github.com')) return { url: BINDINGS_STUB, shortCircuit: true };
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return next(specifier, { ...context, conditions: ['browser', ...(context.conditions || [])] });
    }
    return next(specifier, context);
  },
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLButtonElement', 'HTMLCanvasElement', 'HTMLMediaElement', 'HTMLVideoElement',
  'HTMLAnchorElement', 'SVGElement', 'Element', 'Node', 'Text', 'Comment',
  'DocumentFragment', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'localStorage',
]) {
  if (!(k in dom.window)) continue;
  try {
    globalThis[k] = dom.window[k];
  } catch {
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

// The canvas is not drawn here: a recording no-op 2d context keeps the layer's
// draw path running without a raster backend.
const noopCtx = new Proxy(function () {}, {
  get: (_t, p) => (p === 'canvas' ? null : noopCtx),
  apply: () => noopCtx,
  set: () => true,
});
dom.window.HTMLCanvasElement.prototype.getContext = () => noopCtx;
dom.window.HTMLCanvasElement.prototype.toDataURL = () => '';
// jsdom has no layout observers: the layer binds its element size through one.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'match-heatmaps');
mkdirSync(join(dir, 'builtins', 'match'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });
mkdirSync(join(dir, 'replay'), { recursive: true });

const compileTo = (src, filename, out) => writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
const strip = (src) => src.replace(/from '(?:\.\.\/)+strings\/index\.js'/g, `from '${STRINGS}'`);

// Plain-ESM deps copied verbatim, at the layout the panel's ../../ imports expect.
for (const rel of [
  'heatramp.js', 'heatkinds.js', 'heatselect.js', 'rounds.js', 'teams.js', 'sideparity.js',
  'definitions.js', 'fmt.js', 'nav.js', 'router.js', 'players.js', 'viewstate.svelte.js',
  'download.js', 'save.js', 'workstate.svelte.js', 'replay/landmarks.js', 'components/mapxform.js',
]) {
  const src = readFileSync(join('src', 'lib', rel), 'utf8');
  const out = join(dir, rel);
  if (rel === 'workstate.svelte.js') {
    // workstate is a runes module (lib/workstate.svelte.js): compile it as one.
    writeFileSync(out, compileModule(src, { filename: rel, generate: 'client' }).js.code);
  } else {
    writeFileSync(out, src.replace(/from '(\.\.\/)*strings\/index\.js'/g, `from '${STRINGS}'`));
  }
}

// The rest of the layer and the chips: compiled, with their strings path set.
for (const name of ['HeatmapLayer', 'StatusChip']) {
  compileTo(strip(readFileSync(join('src', 'lib', 'components', `${name}.svelte`), 'utf8')), `${name}.svelte`, join(dir, 'components', `${name}.js`));
}

// The services the panel and its helpers read: scripted by the driver.
// globalThis.__heat holds the roster, rounds, match and grid; every heatmap
// and match read is recorded in globalThis.__calls.
writeFileSync(
  join(dir, 'services.js'),
  `const d = () => globalThis.__heat || {};
globalThis.__calls = globalThis.__calls || [];
const rec = (name, args) => globalThis.__calls.push({ name, args });
export const getMatch = (id) => { rec('getMatch', [id]); return Promise.resolve(d().match || null); };
export const getScoreboard = (id) => { rec('getScoreboard', [id]); return Promise.resolve(d().scoreboard || []); };
export const getRounds = (id) => { rec('getRounds', [id]); return Promise.resolve(d().rounds || []); };
export const getHeatmap = (id, kind, filter) => { rec('getHeatmap', [id, kind, filter]); return Promise.resolve(d().grid); };
export const errText = (e) => (e == null ? 'unknown error' : String((e && e.message) || e));
export const onEvent = () => () => {};
export const subscribeJobProgress = () => () => {};
export const subscribeMetricProgress = () => () => {};
export const saveFile = async () => '';
export const writeFile = async () => {};
export const saveExport = async () => '';
`,
);

// The panel itself, compiled from the real source with its imports rewritten.
const panelSrc = readFileSync(join('src', 'lib', 'builtins', 'match', 'HeatmapsPanel.svelte'), 'utf8')
  .replace(/from '\.\.\/\.\.\/components\/(\w+)\.svelte'/g, "from '../../components/$1.js'")
  .replace(/from '\.\.\/\.\.\/\.\.\/\.\.\/bindings\/github\.com\/ChristianWSmith\/spectra'/, `from '${BINDINGS_STUB}'`);
compileTo(strip(panelSrc), 'HeatmapsPanel.svelte', join(dir, 'builtins', 'match', 'HeatmapsPanel.js'));

// The harness mounts the card with a fixed context, as the Heatmaps builtin does.
const harnessSrc = `<script>
  import HeatmapsPanel from './builtins/match/HeatmapsPanel.js';
  let { spectra, context } = $props();
</script>
<HeatmapsPanel {spectra} {context} />`;
compileTo(harnessSrc, 'harness.svelte', join(dir, 'harness.js'));

const { mount, flushSync } = await import('svelte');
const { default: Harness } = await import(pathToFileURL(join(dir, 'harness.js')).href);
const viewstate = await import(pathToFileURL(join(dir, 'viewstate.svelte.js')).href);

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

// The fixture: two human players and one bot (filtered out of the picker), two
// counted rounds, and a 4×4 presence raster with a maximum of 5 over 100 samples.
const GRID = {
  kind: 'presence',
  w: 4,
  h: 4,
  max: 5,
  samples: 100,
  pad: 450,
  minX: -50,
  maxX: 50,
  minY: -50,
  maxY: 50,
  cells: Array.from({ length: 16 }, (_, i) => (i === 5 ? 5 : 0)),
};
globalThis.__heat = {
  match: { id: 7, map: '', sideSwitches: 0, tickRate: 64 },
  scoreboard: [
    { steamId: '76561198000000001', name: 'Alpha', side: 'ct', isBot: false },
    { steamId: '76561198000000002', name: 'Bravo', side: 't', isBot: false },
    { steamId: 'BOT-1', name: 'Bot', side: 't', isBot: true },
  ],
  rounds: [
    { number: 1, winner: 'ct', ctScore: 1, tScore: 0 },
    { number: 2, winner: 't', ctScore: 1, tScore: 1 },
  ],
  grid: GRID,
};

const target = document.createElement('div');
document.body.appendChild(target);
const navs = [];
const spectra = Object.freeze({ navigate: (h) => navs.push(h) });
viewstate.resetViewState();
mount(Harness, { target, props: { spectra, context: { matchId: 7, steamId: null, round: null } } });
for (let i = 0; i < 10; i++) {
  await sleep(10);
  flushSync();
}

console.log('A. the card mounts with the fixed context (matchId 7)');
{
  const calls = globalThis.__calls.filter((c) => c.name === 'getMatch' || c.name === 'getScoreboard' || c.name === 'getRounds');
  check('the match, roster and rounds are read for the context match only', calls.length >= 3 && calls.every((c) => c.args[0] === 7), JSON.stringify(calls.map((c) => c.args)));
  const kind = target.querySelector('#heat-kind');
  check('the kind selector defaults to presence', !!kind && kind.value === 'presence', kind ? kind.value : 'no #heat-kind');
  const players = target.querySelector('#heat-player');
  const names = players ? [...players.options].map((o) => o.textContent.trim()) : [];
  check('the player picker lists the humans only (the bot is filtered)', names.join('|') === '|Alpha|Bravo' || (names.includes('Alpha') && names.includes('Bravo') && !names.includes('Bot')), names.join('|'));
  const from = target.querySelector('#heat-from');
  check('the round range starts at All rounds and lists the counted rounds', !!from && from.value === '-1' && from.options.length === 3, from ? String(from.options.length) : 'none');
  const note = text(target.querySelector('[role="status"].note-amber'));
  check('no map name: the pack note says the overlay is unavailable', note.includes('map name unknown'), note);
  const gen = target.querySelector('.heat-generate');
  check('Generate is offered before any raster', !!gen && text(gen) === 'Generate', gen ? text(gen) : 'none');
  check('no legend before a raster exists', !target.querySelector('.heat-legend'));
}

console.log('B. Generate fires one heatmap read for the context match and draws its legend');
{
  globalThis.__calls.length = 0;
  click(target.querySelector('.heat-generate'));
  for (let i = 0; i < 10; i++) {
    await sleep(10);
    flushSync();
  }
  const reads = globalThis.__calls.filter((c) => c.name === 'getHeatmap');
  check('exactly one heatmap read, for match 7 and the presence kind', reads.length === 1 && reads[0].args[0] === 7 && reads[0].args[1] === 'presence', JSON.stringify(reads.map((c) => c.args.slice(0, 2))));
  const legend = text(target.querySelector('.heat-legend'));
  check('the legend shows the stored sample count and the 4×4 grid', legend.includes('100') && legend.includes('4×4'), legend);
  check('the legend maximum is the stored maximum, one decimal for presence', legend.includes('5.0'), legend);
  const gen = target.querySelector('.heat-generate');
  check('Generate becomes Regenerate once a raster exists', !!gen && text(gen) === 'Regenerate', gen ? text(gen) : 'none');
  check('the raster is current: no stale banner yet', !target.querySelector('.heat-stale'));
}

console.log('C. a control change marks the raster stale; no read fires until Regenerate');
{
  globalThis.__calls.length = 0;
  const kind = target.querySelector('#heat-kind');
  kind.value = 'kills';
  kind.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  for (let i = 0; i < 6; i++) {
    await sleep(10);
    flushSync();
  }
  check('the stale banner shows after a control change', !!target.querySelector('.heat-stale'));
  check('a control change alone reads no heatmap', globalThis.__calls.filter((c) => c.name === 'getHeatmap').length === 0);
}

console.log('D. the panel navigates through the read API only');
check('no navigation happened on mount or generate', navs.length === 0, String(navs.length));

viewstate.resetViewState();
check('no uncaught error or rejection', errors.length === 0, errors.map(String).join(' | '));
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
