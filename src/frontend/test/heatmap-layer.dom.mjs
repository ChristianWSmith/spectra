// jsdom driver for HeatmapLayer: the floor-mismatch overlay gate.
//
// Pins the owner's hybrid-timing rule: the radar image follows the LIVE
// floor selection immediately, while the raster overlay draws only while
// the live floor index equals the one the raster was fetched for
// (`layer === gridLayer`) — a floor switch clears the raster from view
// until Regenerate, other pending filter changes on the same floor keep
// it visible, and the no-pack / single-layer (selector-hidden) fallbacks
// keep drawing exactly as before.
//
// jsdom has no canvas renderer and no image decoder, so the driver
// records what the component paints: getContext returns a recording 2d
// context (drawImage sources distinguish the offscreen overlay canvas
// from the radar image), and a fake Image records every requested radar
// file with an immediately-resolved decode().
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/heatmap-layer.dom.mjs
// (must be run with frontend/ as the working directory)
import { registerHooks } from 'node:module';

// svelte's package exports pick the SERVER build without the `browser`
// condition (mount() then throws "lifecycle_function_unavailable"), so
// the driver adds it for every svelte specifier before anything imports
// one (same hook as replay.dom.mjs).
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

// jsdom has no ResizeObserver (bind:clientWidth) — a no-op stub plus a
// fixed content width so the device-pixel backing store gets a real size
// instead of jsdom's permanent 0.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// jsdom has no layout: getBoundingClientRect is all zeros, which the
// click path refuses (rect.width <= 0). A fixed 1024×1024 rect at the
// origin keeps the click mapping deterministic: client (x, y) → image
// space (x, y), and W = H = 1024 (the harness pack's radar size), so
// toWorld reads (x − 50, 50 − y) for its pos_x/pos_y/scale.
dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 1024, bottom: 1024, width: 1024, height: 1024, x: 0, y: 0 };
};
try {
  Object.defineProperty(dom.window.Element.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 644;
    },
  });
} catch {
  // jsdom's own (0) stays — the assertions below don't depend on size.
}

// Recording 2d context: every drawImage source is pushed (the overlay is
// an offscreen HTMLCanvasElement; the radar is the fake Image), and
// fillRect counts background/plain-grid paints.
const draws = [];
let fills = 0;
globalThis.__draws = draws;
globalThis.__fills = () => fills;
const ctxCache = new WeakMap();
function makeCtx() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    clearRect() {},
    fillRect() {
      fills++;
    },
    drawImage(src) {
      draws.push(src);
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    strokeRect() {},
    save() {},
    restore() {},
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData() {},
  };
}
dom.window.HTMLCanvasElement.prototype.getContext = function () {
  if (!ctxCache.has(this)) ctxCache.set(this, makeCtx());
  return ctxCache.get(this);
};

// Fake Image: records every requested radar file and resolves decode at
// once — pins "the new floor's image loads immediately" without a real
// decoder (jsdom has none).
const imgSrcs = [];
globalThis.__imgSrcs = imgSrcs;
class FakeImage {
  set src(v) {
    this._src = v;
    imgSrcs.push(v);
  }
  get src() {
    return this._src;
  }
  decode() {
    return Promise.resolve(this);
  }
}
globalThis.Image = FakeImage;
dom.window.Image = FakeImage;

const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'heatmap-layer');
mkdirSync(join(dir, 'components'), { recursive: true });
const compileTo = (src, filename, out) =>
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);

// Plain-ESM deps copied verbatim so the component's relative imports
// keep resolving at the new location: heatramp.js (the field→pixels
// raster pass) and components/mapxform.js (makeTransform — the harness
// builds its pack fixtures through the same reader the app uses).
writeFileSync(join(dir, 'heatramp.js'), readFileSync('src/lib/heatramp.js', 'utf8'));
writeFileSync(
  join(dir, 'components', 'mapxform.js'),
  readFileSync('src/lib/components/mapxform.js', 'utf8'),
);
// heatkinds.js is HeatmapLayer's drill predicate (heatRegionTakesBBox);
// it pulls replay/landmarks.js (sideVal) → rounds.js — the same
// verbatim-copy chain the other drivers use for landmarks.
mkdirSync(join(dir, 'replay'), { recursive: true });
for (const rel of ['heatkinds.js', 'rounds.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);
compileTo(
  readFileSync('src/lib/components/HeatmapLayer.svelte', 'utf8'),
  'HeatmapLayer.svelte',
  join(dir, 'components', 'HeatmapLayer.js'),
);
compileTo(
  readFileSync('test/heatmap-layer.harness.svelte', 'utf8'),
  'heatmap-layer.harness.svelte',
  join(dir, 'harness.js'),
);

const { mount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'harness.js')).href);
const target = document.createElement('div');
document.body.appendChild(target);
mount(mod.default, { target });

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
await sleep();

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const isOverlay = (src) => src instanceof dom.window.HTMLCanvasElement;
const overlayDraws = () => draws.filter(isOverlay).length;
const lastSrc = () => imgSrcs[imgSrcs.length - 1] || '';
const reset = () => {
  draws.length = 0;
  imgSrcs.length = 0;
  fills = 0;
};

console.log('A. matched floors: raster drawn over the live floor image');
check('overlay raster is drawn', overlayDraws() > 0, String(overlayDraws()));
check(
  'radar image is the live (upper) floor file',
  lastSrc().includes('upper.png'),
  lastSrc(),
);
check('background was painted', fills >= 1, String(fills));

console.log('B. floor switch (layer=1, gridLayer=0): image flips, raster clears');
reset();
globalThis.__set(1, 0);
await sleep();
check('no raster overlay while the floors mismatch', overlayDraws() === 0, String(overlayDraws()));
check(
  "the new floor's image loads immediately",
  lastSrc().includes('lower.png'),
  lastSrc(),
);
check('the view still repaints (image/background)', draws.length > 0, String(draws.length));

console.log('C. Regenerate on the new floor (gridLayer := layer): raster returns');
reset();
globalThis.__set(1, 1);
await sleep();
check('overlay raster is drawn again', overlayDraws() > 0, String(overlayDraws()));
check('regenerate does not reload the image', imgSrcs.length === 0, String(imgSrcs.length));

console.log('D. same-floor pending raster (kind/spacing change) stays visible');
reset();
globalThis.__newGrid(); // a fresh raster object on the same floor
await sleep();
check('overlay still drawn (gate is floor-only)', overlayDraws() > 0, String(overlayDraws()));

console.log('E. no-pack fallback (plain grid) unaffected by the gate');
reset();
globalThis.__setPack(null);
await sleep();
check('overlay drawn on the no-pack fallback', overlayDraws() > 0, String(overlayDraws()));
check('plain-grid background painted', fills >= 1, String(fills));

console.log('F. single-layer pack (selector hidden) unaffected by the gate');
reset();
globalThis.__setPack(globalThis.__singlePack);
await sleep();
check('overlay drawn on the single-layer pack', overlayDraws() > 0, String(overlayDraws()));

console.log('G. before first Generate: no grid, no raster (whatever the floor)');
reset();
globalThis.__setGrid(null);
await sleep();
check('no overlay without a fetched grid', overlayDraws() === 0, String(overlayDraws()));
check('image still drawn', draws.length > 0, String(draws.length));
reset();
globalThis.__set(1, 0); // floor clicked before any Generate
await sleep();
check('still no overlay (floor mismatch + no grid)', overlayDraws() === 0, String(overlayDraws()));

console.log('H. Heatmaps view: the round-range <option> labels spell RD (source pin)');
// The two round selects (Rounds from / Rounds to) are Heatmaps' only
// compact round labels; the owner's "standardize round spelling
// everywhere as RD" applies (R{n} → RD{n}). No driver mounts the Heatmaps
// view (heatmap-layer.dom.mjs drives components/HeatmapLayer.js), so this
// is a source pin over the view — mounting it would drag in the whole
// service surface for two <option> strings.
const heatSrc = readFileSync('src/lib/views/Heatmaps.svelte', 'utf8');
const rdOptionLabels = (heatSrc.match(/RD\{r\.number\}/g) || []).length;
check('both round-range options read RD{r.number}', rdOptionLabels === 2, String(rdOptionLabels));
check('no bare R{r.number} option label survives', !/>R\{r\.number\}</.test(heatSrc), '');

// The Heatmaps VIEW's load-failure alert is dismissible in place too
// (PRODUCT.md "Every error indication is dismissible") — a source pin
// again, for the same reason as H: no driver mounts Heatmaps.svelte, so
// building a mount harness for one ✕ would drag in the whole service
// surface. The shape pinned is the canonical idiom: the ✕ lives INSIDE
// p.error[role="alert"] and clears the `error` state variable (the
// generate-path retry already cleared it — this covers the mount-time
// failure path).
const errBlock = /\{#if error\}([\s\S]*?)\{\/if\}/.exec(heatSrc)?.[1] || '';
check(
  'Heatmaps error alert carries the ✕ that clears `error` in place',
  /p class="error" role="alert"/.test(errBlock) &&
    /onclick=\{\(\) => \(error = ''\)\}/.test(errBlock) &&
    /codicon codicon-close/.test(errBlock),
  errBlock.replace(/\s+/g, ' ').slice(0, 160),
);

// --- Region clicks -----------------------------------------------------------
//
// The click path: client px → image space (the stubbed 1024×1024 rect) →
// toWorld (the pack transform: pos_x −50, pos_y 50, scale 1) → the grid
// cell containing the point. One click at client (10, 10) lands at world
// (−40, 40): col = floor((−40 − (−50)) / 25) = 0, row = floor((40 −
// (−50)) / 25) = 3 over the 4×4 fixture spanning [−50, 50]² — the raw cell
// [−50, −25] × [25, 50]. HeatmapLayer emits the CELL; the view pads it by
// grid.pad on the way into the drill (source-pinned in J below).
const clickCanvas = (x, y) => {
  const canvas = document.querySelector('canvas.heat-canvas');
  canvas.dispatchEvent(
    new dom.window.MouseEvent('click', { clientX: x, clientY: y, bubbles: true }),
  );
};

console.log('I. region click: emits the cell; a bbox-less kind drills nowhere');
reset();
globalThis.__set(0, 0);
globalThis.__setGrid(null);
await sleep();
globalThis.__regions.length = 0;
clickCanvas(10, 10);
check(
  'no region before any Generate (no grid → no drill)',
  globalThis.__regions.length === 0,
  String(globalThis.__regions.length),
);
globalThis.__newGrid();
await sleep();

globalThis.__setKind('kills');
await sleep();
globalThis.__regions.length = 0;
clickCanvas(10, 10);
const hit = globalThis.__regions[0];
check(
  'kills: the click emits exactly one region',
  globalThis.__regions.length === 1,
  String(globalThis.__regions.length),
);
check(
  'kills: the raw cell under the cursor (the view pads it — J)',
  hit &&
    hit.bbox.minX === -50 && hit.bbox.maxX === -25 &&
    hit.bbox.minY === 25 && hit.bbox.maxY === 50,
  JSON.stringify(hit && hit.bbox),
);
const canvasEl = document.querySelector('canvas.heat-canvas');
check('kills: drill affordance present (title)', /Click a region/.test(canvasEl.title), canvasEl.title);
check(
  'kills: no inline cursor override (the stylesheet crosshair stands)',
  canvasEl.style.cursor === '',
  canvasEl.style.cursor,
);

// heatRegionTakesBBox(kind) === false → the click must not navigate.
// HeatmapLayer hides the affordance AND drops the callback; Heatmaps'
// onRegion carries the same gate (the nav backstop) — pinned in J.
globalThis.__regions.length = 0;
globalThis.__setKind('presence');
await sleep();
clickCanvas(10, 10);
check(
  'presence: the click emits NO region (no bbox → no drill)',
  globalThis.__regions.length === 0,
  String(globalThis.__regions.length),
);
check('presence: title states the drill is off', /No region drill/.test(canvasEl.title), canvasEl.title);
check(
  'presence: cursor affordance removed (inline default)',
  canvasEl.style.cursor === 'default',
  canvasEl.style.cursor,
);
globalThis.__setKind('kills');
await sleep();

console.log('J. Heatmaps.onRegion source pins: pad expansion + the no-bbox no-nav gate');
// No driver mounts the Heatmaps VIEW (mounting it would drag in the whole
// service surface), so its region composition is source-pinned here — the
// same precedent as section H.
const onRegionSrc = /function onRegion\([^)]*\)\s*\{([\s\S]*?)\n  \}/.exec(heatSrc)?.[1] || '';
check('onRegion body located in Heatmaps.svelte', onRegionSrc.length > 200, String(onRegionSrc.length));
check(
  'the gate reads heatRegionTakesBBox(src.kind) — generic, never a kind name',
  /heatRegionTakesBBox\(src\.kind\)/.test(onRegionSrc),
);
check(
  'bbox-less kinds return BEFORE replayHash (no navigation)',
  onRegionSrc.includes('!carries') &&
    onRegionSrc.indexOf('return;') >= 0 &&
    onRegionSrc.indexOf('return;') < onRegionSrc.indexOf('replayHash('),
  `return@${onRegionSrc.indexOf('return;')} replayHash@${onRegionSrc.indexOf('replayHash(')}`,
);
check(
  'the drill bbox expands the cell by grid.pad on all four sides',
  /bbox\.minX - pad/.test(onRegionSrc) &&
    /bbox\.minY - pad/.test(onRegionSrc) &&
    /bbox\.maxX \+ pad/.test(onRegionSrc) &&
    /bbox\.maxY \+ pad/.test(onRegionSrc),
);
check(
  'regionNote states the APPLIED (padded) rect — never the raw cell',
  /regionNote = `bbox \(\$\{Math\.round\(applied\.minX\)\}/.test(onRegionSrc) &&
    !/regionNote = `bbox \(\$\{Math\.round\(bbox\.minX\)\}/.test(onRegionSrc),
);

console.log('K. stale raster: the arrival reads the generating settings (source pin)');
// Owner ruling — "query what's displayed": while the dirty banner is up
// (live controls changed, raster not regenerated), the drill must still
// open the population the RASTER on screen depicts. The generating
// settings are captured with the fetch (generate → gen), stored with the
// raster in the viewstate record, and read through the `src` derived —
// no harness mounts the view, so these are source pins (same precedent
// as H/J).
const norm = heatSrc.replace(/\s+/g, ' ');
check(
  'src falls back to the live controls ONLY when no generating settings exist',
  /const src = \$derived\(gen \|\| \{ kind, player, team, roundFrom, roundTo \}\)/.test(norm),
);
check(
  'onRegion composes every arrival key from src (never the live controls)',
  /heatRegionFilter\(src\.kind, \{ player: src\.player, side: src\.team, roundFrom: src\.roundFrom, roundTo: src\.roundTo,? \}\)/.test(
    onRegionSrc.replace(/\s+/g, ' '),
  ) && !/heatRegionFilter\(kind,/.test(onRegionSrc),
);
check(
  'the generating settings are captured with the fetch and stored with the raster',
  /const genSel = \{ kind, player, team, roundFrom, roundTo \}/.test(norm) &&
    norm.includes('gen = genSel;') &&
    norm.includes('gen = null;') &&
    /remember\(k, \{[^}]*gen \}\)/.test(norm) &&
    /gen: null,/.test(norm),
);

console.log('L. signed kd cell: the emitted value carries the sign');
// A kd grid is SIGNED (heatmap.go combineSignedHeatmaps: kills − deaths);
// the harness paints whatever fixture it is handed, so the driver swaps in
// a signed raster with the value under test at cell (col 0, row 3) — the
// cell the standard click lands in. The value is the POST-SMEAR cell the
// overlay draws (row 0 at grid.minY — the same indexing the click math
// uses), so what the view reads is what the user sees.
const mkSigned = (v) => ({
  kind: 'kd',
  w: 4,
  h: 4,
  max: 5,
  samples: 100,
  pad: 450,
  minX: -50,
  maxX: 50,
  minY: -50,
  maxY: 50,
  cells: Array.from({ length: 16 }, (_, i) => (i === 12 ? v : 0)),
});
globalThis.__setKind('kd');
await sleep();
for (const v of [5, -5, 0]) {
  globalThis.__setGrid(mkSigned(v));
  await sleep();
  globalThis.__regions.length = 0;
  clickCanvas(10, 10);
  const r = globalThis.__regions[0];
  const label =
    v > 0 ? 'positive (killers stood here)' : v < 0 ? 'negative (victims fell here)' : 'zero (no signal)';
  check(`kd cell value ${label} is emitted as-is`, r && r.value === v, String(r && r.value));
  check(
    `kd bbox stays the raw cell for ${label} (the view pads it)`,
    r &&
      r.bbox.minX === -50 && r.bbox.maxX === -25 &&
      r.bbox.minY === 25 && r.bbox.maxY === 50,
    JSON.stringify(r && r.bbox),
  );
}
// A click OUTSIDE the raster's own cells: no cell exists there, so the
// value is MISSING (undefined) — never a fabricated 0 (the kd sign rule
// reads missing as "no signal" → either endpoint).
globalThis.__setGrid(mkSigned(5));
await sleep();
globalThis.__regions.length = 0;
clickCanvas(500, 500);
const out = globalThis.__regions[0];
check(
  'outside the raster the value is missing (undefined), not 0',
  out && 'value' in out && out.value === undefined,
  JSON.stringify(out),
);

console.log('M. kd sign → cats mapping (source pin over Heatmaps.onRegion)');
// The override lives at the click site (Heatmaps.onRegion) — heatRegionCats
// keeps its pinned ['kills'] default for kd (heatkinds.test.js untouched).
const onRegionNorm = onRegionSrc.replace(/\s+/g, ' ');
check('onRegion receives the cell value', /function onRegion\(\w+, value\)/.test(heatSrc));
check(
  'kd maps value > 0 → cats kills, value < 0 → cats deaths',
  /src\.kind === 'kd'/.test(onRegionNorm) &&
    /v > 0 \? \['kills'\] : \['deaths'\]/.test(onRegionNorm),
);
check(
  'a 0 / missing cell → cats kills+deaths (either endpoint, killRoleFor → any)',
  /Number\.isFinite\(v\) && v !== 0 \? \(v > 0 \? \['kills'\] : \['deaths'\]\) : \['kills', 'deaths'\]/.test(
    onRegionNorm,
  ),
);

console.log('N. progress presentation outside a cell (owner ruling, source pin)');
// No driver mounts the Heatmaps VIEW (mounting it would drag in the
// whole service surface), so the progress display's PLACEMENT is
// source-pinned here — the same precedent as H/J/K. The rule
// (PRODUCT.md "### Defaults"): outside a table cell a progress display
// is a centered ring/spinner with its details text underneath, and a
// horizontal control row cannot be "centered" — so the display lives in
// its own row AFTER the toolbar closes, never inside it.
const toolbarAt = heatSrc.indexOf('<div class="toolbar heat-controls">');
const progressAt = heatSrc.indexOf('<StatusChip block');
check('toolbar + block-mode progress both present', toolbarAt >= 0 && progressAt > toolbarAt, `${toolbarAt} ${progressAt}`);
{
  const between = heatSrc.slice(toolbarAt, progressAt);
  const opens = (between.match(/<div\b/g) || []).length;
  const closes = (between.match(/<\/div>/g) || []).length;
  check(
    'the toolbar CLOSES before the progress display starts (own row, centered)',
    opens > 0 && opens === closes,
    `opens=${opens} closes=${closes}`,
  );
}
check(
  'progress display is the block-mode StatusChip with its stage + fraction',
  /<StatusChip block progress=\{heatPct\} stage=\{heatStage\} \/>/.test(heatSrc),
  '',
);
// The busy-button exemption: the Generate button keeps its plain
// "Generating…" label — no spinner or ring is ever rendered INSIDE it.
check(
  'Generate button keeps its plain busy label (busy-button exemption)',
  /\{loading \? 'Generating\…' : grid \? 'Regenerate' : 'Generate'\}/.test(heatSrc) &&
    !/<button[^>]*>[\s\S]{0,120}?chip-(spin|ring)/.test(heatSrc),
  '',
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
