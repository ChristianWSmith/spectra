// jsdom driver for HeatmapLayer: the floor-mismatch overlay gate, the
// region drill (bare click + rubber-band drag) and its selection overlay.
//
// Pins the owner's hybrid-timing rule: the radar image follows the LIVE
// floor selection immediately, while the raster overlay draws only while
// the live floor index equals the one the raster was fetched for
// (`layer === gridLayer`) — a floor switch clears the raster from view
// until Regenerate, other pending filter changes on the same floor keep
// it visible, and the no-pack / single-layer (selector-hidden) fallbacks
// keep drawing exactly as before.
//
// The drill pins both gesture shapes: a bare press (down + up, no move —
// the pre-drag click) emits the CELL under the cursor, while a drag past
// the 4px threshold shows the `.heat-selbox` overlay and emits the world
// box it spans, clipped to the raster (an empty intersection falls back
// to the anchor cell). Pointer events are constructed on dom.window —
// jsdom's PointerEvent is NOT in the driver's global copy list.
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
// heatselect.js is its pointer/selection math — both plain ESM with no
// further app imports beyond heatkinds' own chain (replay/landmarks.js →
// rounds.js), the same verbatim-copy chain the other drivers use.
mkdirSync(join(dir, 'replay'), { recursive: true });
for (const rel of ['heatkinds.js', 'heatselect.js', 'rounds.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);
compileTo(
  // plumbing (Strings Stage 3): the component imports the strings catalog
  // — resolve it from the real tree (the compiled file sits in components/).
  readFileSync('src/lib/components/HeatmapLayer.svelte', 'utf8').replace(
    "from '../strings/index.js'",
    `from '${pathToFileURL('src/lib/strings/index.js').href}'`,
  ),
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

// --- Region clicks and drags ------------------------------------------------
//
// The click path: client px → image space (the stubbed 1024×1024 rect) →
// toWorld (the pack transform: pos_x −50, pos_y 50, scale 1) → the grid
// cell containing the point. One click at client (10, 10) lands at world
// (−40, 40): col = floor((−40 − (−50)) / 25) = 0, row = floor((40 −
// (−50)) / 25) = 3 over the 4×4 fixture spanning [−50, 50]² — the raw cell
// [−50, −25] × [25, 50]. HeatmapLayer emits the CELL; the view pads it by
// grid.pad on the way into the drill (source-pinned in J below).
//
// Pointer events are built on dom.window: jsdom's PointerEvent exists but
// is NOT in the driver's global copy list (:49-56), so `new PointerEvent`
// would throw. Svelte 5 delegates pointer events, so everything bubbles.
const pe = (type, x, y) =>
  new dom.window.PointerEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0, pointerId: 1 });

// A BARE CLICK: pointerdown + pointerup at the same point, no move — the
// gesture the map accepted before the drag existed (and what a user's
// normal click still is). Sub-threshold by construction, so the component
// takes the cell path.
const clickCanvas = (x, y) => {
  const canvas = document.querySelector('canvas.heat-canvas');
  canvas.dispatchEvent(pe('pointerdown', x, y));
  canvas.dispatchEvent(pe('pointerup', x, y));
};

// Gesture primitives — the driver dispatches them directly so a check can
// assert MID-gesture state (the overlay is up, no region yet) before the
// release resolves it. Svelte batches DOM updates, so callers await sleep()
// after a burst before querying the overlay.
const dragStart = (x, y) => document.querySelector('canvas.heat-canvas').dispatchEvent(pe('pointerdown', x, y));
const dragMove = (x, y) => document.querySelector('canvas.heat-canvas').dispatchEvent(pe('pointermove', x, y));
const dragEnd = (x, y) => document.querySelector('canvas.heat-canvas').dispatchEvent(pe('pointerup', x, y));
const cancelGesture = () => document.querySelector('canvas.heat-canvas').dispatchEvent(pe('pointercancel', 0, 0));

// A full DRAG: down at (x0, y0), the intermediate moves, up at (x1, y1) —
// one settled gesture (the caller reads regions/overlay after it resolves).
const dragCanvas = async (x0, y0, x1, y1, moves = []) => {
  dragStart(x0, y0);
  for (const [mx, my] of moves) dragMove(mx, my);
  dragMove(x1, y1);
  dragEnd(x1, y1);
  await sleep();
};

// The selection overlay (only rendered mid-drag).
const selBox = () => document.querySelector('.heat-selbox');
const selBoxRect = (el) => {
  const s = (el && el.getAttribute('style')) || '';
  const n = (k) => Number.parseFloat((new RegExp(`(?:^|;)\\s*${k}:\\s*(-?[\\d.]+)px`).exec(s) || [])[1]);
  return { left: n('left'), top: n('top'), width: n('width'), height: n('height') };
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
check('kills: drill affordance present (title)', /Drag a box/.test(canvasEl.title), canvasEl.title);
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

console.log('O. rubber-band drag: overlay while held, region on release');
// The gesture has two shapes (heatselect.js): a BARE PRESS (down + up with
// under 4px of movement) keeps the old cell drill; a DRAG past the
// threshold draws .heat-selbox and emits the world box it spans, clipped to
// the raster. The overlay's presence therefore means "this release selects
// a region" — a sub-threshold wobble draws nothing. All geometry runs over
// the harness fixture: the 1024×1024 stub rect, transform pos_x −50 /
// pos_y 50 / scale 1, the 4×4 grid over [−50, 50]² (cells i + 1).
reset();
globalThis.__regions.length = 0; // section L's out-of-raster click left one behind
globalThis.__set(0, 0);
globalThis.__setKind('kills');
globalThis.__newGrid();
await sleep();

// A settled drag (10,10) → (510,510): the overlay is up while the button
// is held, and NOTHING is emitted until the release resolves it.
dragStart(10, 10);
dragMove(510, 510);
await sleep();
{
  const box = selBox();
  check('drag: the selection overlay is present while held', !!box, box ? 'found' : 'missing');
  const r = selBoxRect(box);
  check(
    'drag: the overlay carries its CSS-px geometry (left/top/width/height)',
    r.left === 10 && r.top === 10 && r.width === 500 && r.height === 500,
    JSON.stringify(r),
  );
  check(
    'drag: no region is emitted mid-gesture (the release decides)',
    globalThis.__regions.length === 0,
    String(globalThis.__regions.length),
  );
}
dragEnd(510, 510);
await sleep();
{
  const hit = globalThis.__regions[0];
  check(
    'drag: the release emits exactly one region',
    globalThis.__regions.length === 1,
    String(globalThis.__regions.length),
  );
  // Corners (10,10) → world (−40, 40) and (510,510) → (460, −460): the box
  // is clipped to the raster on the sides that overrun — the view pads THAT
  // by grid.pad (pinned in J), never the raw gesture.
  check(
    'drag: the region is the world box clipped to the raster bounds',
    hit &&
      hit.bbox.minX === -40 && hit.bbox.maxX === 50 &&
      hit.bbox.minY === -50 && hit.bbox.maxY === 40,
    JSON.stringify(hit && hit.bbox),
  );
  check(
    'drag: the anchor cell value rides along (the kd sign source)',
    hit && hit.value === 13,
    String(hit && hit.value),
  );
  check('drag: the overlay is gone after release', !selBox(), selBox() ? 'still present' : '');
}

// Under the threshold the gesture is a click: no overlay is ever drawn and
// the release emits the CELL, exactly as the map did before the drag.
globalThis.__regions.length = 0;
dragStart(10, 10);
dragMove(13, 13); // 3px — below DRAG_THRESHOLD_PX (4)
await sleep();
check('sub-threshold: no overlay is drawn for a 3px nudge', !selBox(), selBox() ? 'present' : '');
dragEnd(13, 13);
await sleep();
{
  const hit = globalThis.__regions[0];
  check(
    'sub-threshold: the release emits the single cell (the pre-drag click)',
    globalThis.__regions.length === 1 &&
      hit &&
      hit.bbox.minX === -50 && hit.bbox.maxX === -25 &&
      hit.bbox.minY === 25 && hit.bbox.maxY === 50,
    JSON.stringify(hit && hit.bbox),
  );
}

// The threshold boundary is inclusive: 4px CROSSES it, so the overlay goes
// up and the release takes the region path.
globalThis.__regions.length = 0;
dragStart(10, 10);
dragMove(14, 14);
await sleep();
{
  const r = selBoxRect(selBox());
  check(
    'threshold: a 4px move crosses it — the overlay goes up (4×4 box)',
    r.width === 4 && r.height === 4,
    JSON.stringify(r),
  );
}
dragEnd(14, 14);
await sleep();
{
  const hit = globalThis.__regions[0];
  check(
    'threshold: the release takes the region path (the 4px box, not the cell)',
    globalThis.__regions.length === 1 &&
      hit &&
      hit.bbox.minX === -40 && hit.bbox.maxX === -36 &&
      hit.bbox.minY === 36 && hit.bbox.maxY === 40,
    JSON.stringify(hit && hit.bbox),
  );
}

// The overlay is clamped to the canvas: a gesture running off the map still
// reports a box that never spills past the edge (the wrap clips anyway —
// the clamp keeps the numbers honest).
globalThis.__regions.length = 0;
dragStart(10, 10);
dragMove(4000, 4000);
await sleep();
{
  const r = selBoxRect(selBox());
  check(
    'clamp: the overlay stops at the canvas edge (never spills)',
    r.left === 10 && r.top === 10 && r.width === 1014 && r.height === 1014,
    JSON.stringify(r),
  );
}
// pointercancel (window blur, a stolen pointer) abandons the gesture: the
// overlay clears and nothing is emitted.
cancelGesture();
await sleep();
check('cancel: the overlay clears without emitting', !selBox() && globalThis.__regions.length === 0,
  `${selBox() ? 'overlay' : ''} ${globalThis.__regions.length} region(s)`);

// A bbox-less kind (presence) never even STARTS a gesture — the gate runs at
// pointerdown, so there is no overlay to show and no region to emit.
globalThis.__setKind('presence');
await sleep();
globalThis.__regions.length = 0;
dragStart(10, 10);
dragMove(510, 510);
await sleep();
check('presence: a drag draws no overlay (no drill → no gesture)', !selBox(), selBox() ? 'present' : '');
dragEnd(510, 510);
await sleep();
check(
  'presence: a drag emits NO region (no bbox → no drill)',
  globalThis.__regions.length === 0,
  String(globalThis.__regions.length),
);
globalThis.__setKind('kills');
await sleep();

// EMPTY grid intersection → the ANCHOR CELL fallback: a gesture that never
// reaches the raster drills where it started — the same out-of-raster cell
// a click there emits (value missing, never a fabricated 0), never an
// invented region and never a silent no-op.
globalThis.__regions.length = 0;
dragStart(500, 500); // world (450, −450) — outside the [−50, 50]² raster
dragMove(900, 900);
dragEnd(900, 900);
await sleep();
{
  const hit = globalThis.__regions[0];
  check(
    'empty intersection: the anchor cell is emitted instead (one region)',
    globalThis.__regions.length === 1,
    String(globalThis.__regions.length),
  );
  check(
    'empty intersection: the anchor cell is out-of-raster with a MISSING value',
    hit &&
      hit.bbox.minX === 450 && hit.bbox.maxX === 475 &&
      hit.bbox.minY === -450 && hit.bbox.maxY === -425 &&
      'value' in hit && hit.value === undefined,
    JSON.stringify(hit),
  );
  check('empty intersection: the overlay is gone after the fallback', !selBox(), selBox() ? 'present' : '');
}

// A perfectly straight drag (zero width) still REACHES the raster, so it
// yields the line-shaped box rather than falling back — the view's pad
// expansion turns it into a real region. (Falling back here would ignore a
// 500px gesture and drill one cell.)
globalThis.__regions.length = 0;
dragStart(10, 10);
dragMove(10, 510);
dragEnd(10, 510);
await sleep();
{
  const hit = globalThis.__regions[0];
  check(
    'straight drag: a zero-width box reaches the raster (line, not the cell)',
    globalThis.__regions.length === 1 &&
      hit &&
      hit.bbox.minX === -40 && hit.bbox.maxX === -40 &&
      hit.bbox.minY === -50 && hit.bbox.maxY === 40,
    JSON.stringify(hit && hit.bbox),
  );
}

// The overlay's STYLE is an owner ruling too (row 22: "accent solid —
// never side colors"): a selection is the user's own gesture, not a team,
// so it must not borrow --ct/--t, and a dashed border is already spoken for
// (provenance chips, the halftime separator). CSS-text pin, econ-tables
// precedent — no driver asserts rendered CSS.
const m3a = readFileSync('public/style-m3a.css', 'utf8');
const selRule = /\.heat-selbox\s*\{[^}]*\}/.exec(m3a)?.[0] || '';
check('selbox rule exists (public/style-m3a.css)', selRule.length > 0, selRule);
check(
  'selbox: solid accent outline + low-alpha accent fill, never side colours or dashes',
  /border: 1px solid var\(--accent\)/.test(selRule) &&
    /background: var\(--accent-12\)/.test(selRule) &&
    !/var\(--ct\)|var\(--t\)|dashed/.test(selRule),
  selRule,
);
check(
  'selbox: pointer-events none (the overlay can never eat the gesture it draws)',
  /pointer-events: none/.test(selRule),
  selRule,
);

// --- Heatmaps layout wave (C16 + C18) --------------------------------------
//
// Still SOURCE pins: no driver mounts the Heatmaps VIEW (the precedent of
// H/J/K/N — mounting it would drag in the whole service surface). Pinned
// here is the lead-ruled layout: the floor BUTTON group became one native
// select, the heatmap CONTENT moved into the single card while the
// toolbar stayed outside it (section N's toolbar/progress pins above must
// stay green), and the view's rows center on one axis with a height cap
// on the radar block — CSS text, the econ-tables/replay ruleBody
// precedent, since no driver asserts rendered CSS.
console.log('P. Heatmaps view: floor <select>, content card, centered rows, height cap');

{
  const floorAt = heatSrc.indexOf('id="heat-floor"');
  const floorBlock =
    /<select class="input" id="heat-floor"[\s\S]*?<\/select>/.exec(heatSrc)?.[0] || '';
  const short = (s) => s.replace(/\s+/g, ' ').slice(0, 140);
  check(
    'floor control = ONE native select bound to the live layer index, labelled by for/id',
    floorAt > 0 &&
      /bind:value=\{layer\}/.test(floorBlock) &&
      /<label class="field-label" for="heat-floor">\{S\.heatmaps\.floorLabel\}<\/label>/.test(heatSrc),
    short(floorBlock),
  );
  check(
    'floor options are the pack layers (name, else id) in pack order',
    /\{#each layers as l, i \(i\)\}/.test(floorBlock) && /\{l\.name \|\| l\.id\}/.test(floorBlock),
    short(floorBlock),
  );
  check(
    'the .sett-seg floor BUTTON group is gone (no aria-pressed floor buttons)',
    !heatSrc.includes('sett-seg') && !heatSrc.includes('aria-pressed={layer === i}'),
  );
  const gateAt = heatSrc.indexOf('{#if showLayers}');
  check(
    'the select keeps the showLayers gate — single-floor packs still show no floor field',
    gateAt > 0 &&
      gateAt < floorAt &&
      heatSrc.indexOf('{/if}', floorAt) > 0 &&
      heatSrc.indexOf('{/if}', floorAt) < heatSrc.indexOf('id="heat-player"'),
    `gate@${gateAt} select@${floorAt}`,
  );

  // Card shape (C18): exactly one panel, holding only the content, with
  // the toolbar literal and the block progress BEFORE it — the two pins
  // section N already asserts over the same offsets.
  const toolbarAt = heatSrc.indexOf('<div class="toolbar heat-controls">');
  const chipAt = heatSrc.indexOf('<StatusChip block');
  const panelAt = heatSrc.indexOf('<section class="panel">');
  const panelEnd = heatSrc.indexOf('</section>', panelAt);
  const legendAt = heatSrc.indexOf('class="heat-legend"', panelAt);
  const radarAt = heatSrc.indexOf('<HeatmapLayer', panelAt);
  const hintAt = heatSrc.indexOf('class="heat-hint', panelAt);
  const emptyAt = heatSrc.indexOf('class="heat-empty', panelAt);
  check(
    'toolbar stays OUTSIDE the card: its literal opening tag and the block progress both precede the panel',
    toolbarAt >= 0 && chipAt > toolbarAt && panelAt > chipAt,
    `${toolbarAt} ${chipAt} ${panelAt}`,
  );
  check(
    'exactly one section.panel wraps the content in order — legend, radar, hint/empty',
    (heatSrc.match(/<section class="panel">/g) || []).length === 1 &&
      panelAt > 0 &&
      panelEnd > panelAt &&
      legendAt > panelAt &&
      radarAt > legendAt &&
      hintAt > radarAt &&
      emptyAt > radarAt &&
      panelEnd > Math.max(hintAt, emptyAt),
    `${panelAt} ${legendAt} ${radarAt} ${hintAt} ${emptyAt} ${panelEnd}`,
  );

  // CSS text pins — the cap and the centering rules (no rendered CSS in a
  // jsdom driver).
  const cssMain = readFileSync('public/style.css', 'utf8');
  const cssNorm = cssMain.replace(/\s+/g, ' ');
  const capRule = /\.heat-canvas-wrap \{[^}]*\}/.exec(m3a)?.[0] || '';
  check(
    'height cap: the wrap bounds width by (100vh − ~330px chrome) × --heat-aspect, overflow/box untouched',
    /max-width: min\(860px, calc\(\(100vh - 330px\) \* var\(--heat-aspect, 1\)\)\)/.test(capRule) &&
      /overflow: hidden/.test(capRule) &&
      /width: 100%/.test(capRule) &&
      !/padding|object-fit/.test(capRule),
    short(capRule),
  );
  check(
    'the view SETS --heat-aspect (the pack radar dims ride the heat-view root)',
    heatSrc.includes('style="--heat-aspect: {heatAspect}"'),
  );
  check(
    'centering: the controls row and the legend justify their contents to the middle (scoped .heat-view)',
    /\.heat-view > \.heat-controls, \.heat-view \.heat-legend \{ justify-content: center; \}/.test(
      cssNorm,
    ),
    '',
  );
  check(
    'centering: the hint/empty rows hug their content and take auto margins',
    /\.heat-view \.heat-hint, \.heat-view \.heat-empty \{ width: fit-content; margin-inline: auto; \}/.test(
      cssNorm,
    ),
    '',
  );
  check(
    'centering: the radar block centers on auto margins alone — no width/padding change (box ≡ canvas)',
    /\.heat-view \.heat-canvas-wrap \{ margin-inline: auto; \}/.test(cssNorm),
    '',
  );
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
