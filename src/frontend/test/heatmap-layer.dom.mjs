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

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
