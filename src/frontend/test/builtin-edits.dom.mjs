import { warm, compileIdle } from './compile-worker-node.mjs';
await warm();
// jsdom driver for editing builtins in place and "use as my view". Renders the real components (ChildFrame,
// ComponentFrame, SurfaceView, the real resolver and compile path) against
// the shared service stubs (no Wails backend).
//   B. an edited builtin renders its edit wherever it is mounted: at the top
//      of a surface, inside a component (a nested mount), and in a placement;
//      restoring the default (the edit deleted) brings the shipped one back;
//   D. "use as my view": a surface with a placement renders the placed
//      component in place of its default; a surface with no placement renders
//      its default exactly as before (no placed frame, the default present);
//      Reset (no placement) renders the default again;
//   E. a placement that names no component shows its refusal in its slot.
//
//   F. an edit may import a curated helper (ruling 45) and renders.
//
// Run (from frontend/):  node test/builtin-edits.dom.mjs
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installEsmDirHook } from './esm-dir-hook.mjs';
import { reachesSvelte } from './bundle-reach.mjs';

installEsmDirHook();

const stub = (name) => pathToFileURL(join('test', 'stubs', name)).href;
// svelte resolves to its CLIENT build (the browser condition), the same
// instance the runtime compiler loads (component-builder.dom.mjs shape).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return nextResolve(specifier, { ...context, conditions: ['browser', ...(context.conditions || [])] });
    }
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment',
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

const escaped = [];
// An escaped error is printed at once: the handler would otherwise end the run
// silently with exit 0 (the driver-liveness guard's failure mode).
process.on('uncaughtException', (e) => { escaped.push('uncaught: ' + (e && e.message)); console.log('  FAIL UNCAUGHT ' + String(e && (e.stack || e.message || e)) + ' ' + JSON.stringify(e && e.code)); });
process.on('unhandledRejection', (e) => { escaped.push('rejection: ' + (e && e.message)); console.log('  FAIL UNCAUGHT rejection ' + String(e && (e.stack || e.message || e))); });

// --- bundling -----------------------------------------------------------------
// Every .svelte and every app .js the harness reaches is written into the cache
// dir with its relative imports rewritten to those bundles; other .js stays put.
const cacheDir = join('node_modules', '.cache', 'spectra-dom-tests', 'builtin-edits');
mkdirSync(cacheDir, { recursive: true });
const compiled = new Map();
let seq = 0;
function bundle(absPath) {
  if (compiled.has(absPath)) return compiled.get(absPath);
  const out = join(cacheDir, `${String(++seq).padStart(2, '0')}-${absPath.split('/').pop()}.js`);
  compiled.set(absPath, out);
  const src = readFileSync(absPath, 'utf8').replace(/from '(\.{1,2}\/[^']+)'/g, (whole, rel) => {
    const target = resolve(dirname(absPath), rel);
    if (target.endsWith('.svelte')) return `from '${pathToFileURL(bundle(target)).href}'`;
    // A .js that reaches a .svelte through its own imports (resolve.js → builtins/panels.js)
    // is rewritten like its importer; every other .js stays where it is.
    if (target.endsWith('.js') && reachesSvelte(target)) {
      return `from '${pathToFileURL(bundle(target)).href}'`;
    }
    return `from '${pathToFileURL(target).href}'`;
  });
  if (absPath.endsWith('.svelte')) writeFileSync(out, compile(src, { filename: absPath, generate: 'client' }).js.code);
  else writeFileSync(out, src);
  return out;
}
const harnessBundle = bundle(resolve('test/builtin-edits.harness.svelte'));

const { mount, unmount, flushSync } = await import('svelte');
const bindings = await import('./stubs/bindings.mjs');
const Harness = (await import(pathToFileURL(harnessBundle).href)).default;

// --- the scripted backend -----------------------------------------------------
let OVERRIDES = [];
let PLACEMENTS = {};
const setCalls = [];
const resetCalls = [];
bindings.handlers.ListComponents = () => [];
bindings.handlers.ListBuiltinOverrides = () => OVERRIDES.map((o) => ({ ...o }));
bindings.handlers.ListPlacements = (surface) => (PLACEMENTS[surface] || []).map((r) => ({ ...r }));
bindings.handlers.SetPlacements = (surface, rows) => {
  setCalls.push({ surface, rows });
  PLACEMENTS[surface] = rows.map((r) => ({ ...r }));
  return null;
};
bindings.handlers.ResetPlacements = (surface) => {
  resetCalls.push(surface);
  delete PLACEMENTS[surface];
  return null;
};

// The edit a test stores for the Match overview panel: a marker the shipped
// panel does not contain, so the rendered marker says which one mounted.
const EDIT_SOURCE = `<script>
  let { spectra } = $props();
</script>
<p class="edit-marker">EDITED OVERVIEW</p>`;

// --- helpers -------------------------------------------------------------------
const sleep = async (ms = 30) => {
  await new Promise((r) => setTimeout(r, ms));
  await compileIdle();
};
const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) {
    await sleep(30);
    flushSync();
  }
};

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

let target = null;
let instance = null;
const mountHarness = async (props) => {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(Harness, { target, props });
  await settle();
  return target;
};
const unmounted = () => {
  if (instance) unmount(instance);
  instance = null;
  if (target) target.remove();
  target = null;
};

// --- B. an edit renders wherever the builtin is mounted -----------------------
console.log('B. an edited builtin renders wherever it is mounted');
const OVERVIEW = 'match-overview';

OVERRIDES = [{ id: OVERVIEW, source: EDIT_SOURCE }];
let root = await mountHarness({ mode: 'child', name: OVERVIEW });
check('the edit renders at the top of a surface', !!root.querySelector('.edit-marker'), root.innerHTML.slice(0, 200));
unmounted();

root = await mountHarness({ mode: 'nested', name: OVERVIEW });
check('the edit renders inside a component (a nested mount)', !!root.querySelector('.edit-marker'));
unmounted();

// Restore to default: the override is deleted, the shipped source mounts.
OVERRIDES = [];
root = await mountHarness({ mode: 'child', name: OVERVIEW });
check('restoring the default removes the edit', !root.querySelector('.edit-marker'));
check('the shipped source is mounted again', !!root.querySelector('.cframe'), root.innerHTML.slice(0, 200));
unmounted();

// --- D. use as my view ----------------------------------------------------------
console.log('D. use as my view');
PLACEMENTS = {};
root = await mountHarness({ mode: 'surface', surface: 'match-view' });
check('a surface with no placement renders its default', !!root.querySelector('.default-marker'));
check('a surface with no placement mounts no placed frame', !root.querySelector('.cframe'));
unmounted();

// One placement pointing at a leaf panel: the panel renders in place of the
// default (the default is gone), and the panel's edit (if any) shows.
PLACEMENTS = { 'match-view': [{ component: OVERVIEW, props: '{}', hidden: false }] };
OVERRIDES = [{ id: OVERVIEW, source: EDIT_SOURCE }];
root = await mountHarness({ mode: 'surface', surface: 'match-view' });
check('a placement renders its component in place of the default', !root.querySelector('.default-marker'));
check('the placed component is the edited one', !!root.querySelector('.edit-marker'));
unmounted();

// Reset: the placement is removed, so the default renders again.
PLACEMENTS = {};
OVERRIDES = [];
root = await mountHarness({ mode: 'surface', surface: 'match-view' });
check('reset removes the placement and the default renders again', !!root.querySelector('.default-marker'));
unmounted();

// A hidden row is stored but not mounted: the default stays.
PLACEMENTS = { 'profile-view': [{ component: OVERVIEW, props: '{}', hidden: true }] };
root = await mountHarness({ mode: 'surface', surface: 'profile-view' });
check('a hidden placement is not mounted', !!root.querySelector('.default-marker'));
unmounted();

// --- E. a placement naming nothing ----------------------------------------------
console.log('E. a placement with a missing component');
PLACEMENTS = { 'match-view': [{ component: 'user-gone', props: '{}', hidden: false }] };
root = await mountHarness({ mode: 'surface', surface: 'match-view' });
check('a missing component shows its refusal in its slot', !!root.querySelector('[role="alert"]'));
check('the surface does not crash on a missing component', !root.querySelector('.default-marker'));
unmounted();
PLACEMENTS = {};

// --- F. an edit that imports a curated helper (ruling 45) --------------------
console.log('F. an edit that imports a helper');
const HELPER_EDIT = `<script>
  import { fmt1 } from '../../fmt.js';
  let { spectra } = $props();
</script>
<p class="helper-marker">{fmt1(2.5)}</p>`;
OVERRIDES = [{ id: OVERVIEW, source: HELPER_EDIT }];
root = await mountHarness({ mode: 'child', name: OVERVIEW });
check('an edit may import a listed helper and it renders', root.querySelector('.helper-marker')?.textContent.trim() === '2.5', root.innerHTML.slice(0, 200));
unmounted();
OVERRIDES = [];

check('no write happened from the render path', setCalls.length === 0 && resetCalls.length === 0);
check('nothing escaped the drivers', escaped.length === 0, escaped.join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
