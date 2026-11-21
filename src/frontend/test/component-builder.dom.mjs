// jsdom driver for the Component builder (views/ComponentBuilder.svelte) —
// the component AUTHORING surface, run against the real view, the real
// save gate (componentruntime/savegate.js → compile.js), the real
// ComponentFrame boundary and the shared service stubs (no Wails backend).
//   A. mount shape: the header and its help target, the three panels;
//   B. the list: the built-in first (chip, read-only), then yours; an empty
//      "Yours" says so; a failed list read shows its error with Try again;
//   C. a built-in loads read-only: fields readonly, Save disabled, no
//      delete control; Duplicate saves a copy of it as yours and opens it;
//   D. save gating: a refused source shows its line and keeps Save off;
//      the save path refuses the same source before any write happens;
//      a checked source saves, and the saved name is loaded;
//   E. error display: a refused source's line; a preview that fails while
//      it runs shows its failure inside the preview's own frame;
//   F. delete: a refused delete shows its reason in the page's error slot
//      (dismissible); a delete that succeeds clears the editor;
//   G. viewstate round-trip: the open component survives a remount.
//
// Run (from frontend/):  node test/component-builder.dom.mjs
// jsdom is a declared devDependency (a plain `npm ci` provides it).
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installEsmDirHook } from './esm-dir-hook.mjs';

installEsmDirHook();

const stub = (name) => pathToFileURL(join('test', 'stubs', name)).href;
// svelte resolves to its CLIENT build (the browser condition), the same
// instance the runtime compiler loads (component-frame.dom.mjs shape).
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
process.on('uncaughtException', (e) => escaped.push('uncaught: ' + (e && e.message)));
process.on('unhandledRejection', (e) => escaped.push('rejection: ' + (e && e.message)));

// --- bundling -----------------------------------------------------------------
// Every .svelte the view reaches is compiled into the cache dir; every .js
// stays where it is (imported by absolute URL), so the plain modules
// (services, the save gate, the registries) are the real ones.
const cacheDir = join('node_modules', '.cache', 'spectra-dom-tests', 'component-builder');
mkdirSync(cacheDir, { recursive: true });
const compiled = new Map(); // absolute .svelte path -> bundle path
let seq = 0;
function bundle(absPath) {
  if (compiled.has(absPath)) return compiled.get(absPath);
  const out = join(cacheDir, `${String(++seq).padStart(2, '0')}-${absPath.split('/').pop()}.js`);
  compiled.set(absPath, out);
  const src = readFileSync(absPath, 'utf8').replace(/from '(\.{1,2}\/[^']+)'/g, (whole, rel) => {
    const target = resolve(dirname(absPath), rel);
    if (target.endsWith('.svelte')) return `from '${pathToFileURL(bundle(target)).href}'`;
    return `from '${pathToFileURL(target).href}'`;
  });
  writeFileSync(out, compile(src, { filename: absPath, generate: 'client' }).js.code);
  return out;
}
const viewBundle = bundle(resolve('src/lib/views/ComponentBuilder.svelte'));

const { mount, unmount, flushSync } = await import('svelte');
const bindings = await import('./stubs/bindings.mjs');
const services = await import(pathToFileURL(resolve('src/lib/services.js')).href);
const S = await import(pathToFileURL(resolve('src/lib/strings/index.js')).href);
const View = (await import(pathToFileURL(viewBundle).href)).default;

// --- the scripted backend -----------------------------------------------------
let COMPONENTS = [];
const saveCalls = [];
const deleteCalls = [];
bindings.handlers.ListComponents = () => COMPONENTS.map((c) => ({ ...c }));
bindings.handlers.ListMatches = () => [];
bindings.handlers.ListPlayers = () => [];
bindings.handlers.SaveComponent = (original, name, source) => {
  saveCalls.push({ original, name, source });
  const saved = { name, source };
  COMPONENTS = COMPONENTS.filter((c) => c.name !== original && c.name !== name).concat(saved);
  return { ...saved };
};
bindings.handlers.DeleteComponent = (name) => {
  deleteCalls.push(name);
  return null;
};

const OK_SOURCE = `<script>
  let { spectra } = $props();
</script>
<p class="mine-ok">ok</p>`;
const BROKEN_SOURCE = `<script>
  let x = ;
</script>`;
const RENDER_BOOM_SOURCE = `<script>
  if (globalThis.__cbBoom) throw new Error('preview boom');
</script>
<p class="mine-ok">fine</p>`;

// --- helpers -------------------------------------------------------------------
const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) {
    await sleep(30);
    flushSync();
  }
};
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const setText = async (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  flushSync();
  await sleep(320); // the live check's debounce (CHECK_DEBOUNCE_MS = 250)
  flushSync();
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
const opened = [];
let root = null;
const mounted = async () => {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(View, { target, props: { openDocs: (id) => opened.push(id) } });
  root = target;
  await settle();
};
const unmounted = () => {
  if (instance) unmount(instance);
  instance = null;
  if (target) target.remove();
  target = null;
};

const q = (sel) => root.querySelector(sel);
const qa = (sel) => [...root.querySelectorAll(sel)];
const rowNamed = (label, group) => qa(`${group} .cb-row-main`).find((b) => b.textContent.includes(label));
const buttonByText = (text) => qa('button').find((b) => b.textContent.trim().includes(text));
const alertIn = (sel) => {
  const el = q(sel);
  const a = el && (el.matches('[role="alert"]') ? el : el.querySelector('[role="alert"]'));
  if (!a) return '';
  const copy = a.cloneNode(true);
  for (const b of copy.querySelectorAll('button')) b.remove();
  return copy.textContent.trim();
};

// --- A. mount shape ------------------------------------------------------------
console.log('A. mount shape');
await mounted();
check('the page heading is the Component builder title', q('h1')?.textContent.trim() === S.componentbuilder.heading);
// The header's ? opens the component-builder guide section (HelpButton →
// openDocs(section)); the probe records what the view asked for.
const help = q('.view-header button[aria-label]');
check('the header carries the help target', !!help, help && help.outerHTML);
click(help);
check('the help target opens the component-builder guide section', opened.join() === 'component-builder', opened.join());
check('three panels: list, editor, preview', !!q('.cb-list') && !!q('.cb-editor') && !!q('.cb-preview'));
check('no error alert on a clean mount', !q('.view-header + p.error') && !q('[role="alert"]'));

// --- B. the list ---------------------------------------------------------------
console.log('B. the list');
const builtinRow = rowNamed(S.componentbuilder.placeholderName, '.cb-builtins');
check('the built-in example is listed in the Built-in group', !!builtinRow);
check(
  'the built-in row carries the built-in and example chips',
  builtinRow && builtinRow.textContent.includes(S.componentbuilder.builtinChip) &&
    builtinRow.textContent.includes(S.componentbuilder.placeholderChip),
);
check('an empty Yours list says so', q('.cb-list')?.textContent.includes(S.componentbuilder.noUserComponents));
check('no delete control on a built-in row', !builtinRow.parentElement.querySelector('.cb-row-acts'));
unmounted();

// --- C. built-in read-only, duplicate ---------------------------------------
console.log('C. built-in read-only; duplicate');
COMPONENTS = [];
await mounted();
click(rowNamed(S.componentbuilder.placeholderName, '.cb-builtins'));
await settle();
check('the built-in name field is read-only', q('#cb-name')?.readOnly === true);
check('the built-in source is read-only', q('#cb-source')?.readOnly === true);
check('Save is disabled for a built-in', q('.cb-save')?.disabled === true);
check('a built-in shows no Delete control', !q('.cb-delete'));
check('the built-in source is in the editor', q('#cb-source')?.value.includes('spectra.query'));
await settle(10);
check('Duplicate is enabled once the built-in passes the check', q('.cb-duplicate')?.disabled === false);
const beforeDup = saveCalls.length;
click(q('.cb-duplicate'));
await settle(10);
check('Duplicate saves exactly one copy as yours', saveCalls.length === beforeDup + 1);
const dupCall = saveCalls[saveCalls.length - 1];
check(
  'the copy is named after the built-in and keeps its source',
  dupCall &&
    dupCall.original === '' &&
    dupCall.name === S.fill(S.componentbuilder.copyName, { name: S.componentbuilder.placeholderName }) &&
    dupCall.source.includes('spectra.query'),
  JSON.stringify(dupCall && { o: dupCall.original, n: dupCall.name }),
);
check('the copy opens as an editable component', q('#cb-name')?.value === dupCall.name && q('#cb-name')?.readOnly === false);
check('an open copy of yours offers Delete', !!q('.cb-delete'));
unmounted();

// --- D. save gating -------------------------------------------------------------
console.log('D. save gating');
COMPONENTS = [];
saveCalls.length = 0;
await mounted();
check('Save is disabled with nothing typed', q('.cb-save')?.disabled === true);
click(buttonByText(S.componentbuilder.newLabel));
await settle();
await setText(q('#cb-name'), 'Mine');
await setText(q('#cb-source'), BROKEN_SOURCE);
check('a refused source names its line', alertIn('.cb-check').startsWith('Line 2:'), alertIn('.cb-check'));
check('Save stays disabled while the source is refused', q('.cb-save')?.disabled === true);
check('the refused Save title says why', q('.cb-save')?.title === S.componentbuilder.saveBlockedTitle, q('.cb-save')?.title);
check('Duplicate stays disabled while the source is refused', q('.cb-duplicate')?.disabled === true);
// The save path refuses the same source before any write.
let refused = null;
try {
  await services.saveComponent('', 'Mine', BROKEN_SOURCE);
} catch (e) {
  refused = e;
}
check('the save path refuses a refused source', refused instanceof Error && refused.message.startsWith('Line 2:'), refused && refused.message);
check('the refused source reaches no write', saveCalls.length === 0, JSON.stringify(saveCalls));
await setText(q('#cb-source'), OK_SOURCE);
check('a sound source reads Ready to save', q('.cb-check')?.textContent.includes(S.componentbuilder.checkOk));
check('Save is enabled once the source passes and a name is set', q('.cb-save')?.disabled === false);
click(q('.cb-save'));
await settle(10);
check('Save writes once, under the typed name', saveCalls.length === 1 && saveCalls[0].name === 'Mine' && saveCalls[0].original === '', JSON.stringify(saveCalls));
check('the saved name is now the open component', q('#cb-name')?.value === 'Mine');
check('the saved button reads Saved', q('.cb-save')?.textContent.trim() === S.componentbuilder.saved, q('.cb-save')?.textContent.trim());
check('the new component appears under Yours', !!rowNamed('Mine', '.cb-yours'));

// --- E. preview error display ----------------------------------------------------
console.log('E. preview error display');
globalThis.__cbBoom = true;
await setText(q('#cb-source'), RENDER_BOOM_SOURCE);
await settle(10);
check('the preview shows its failure inside its own frame', alertIn('.cb-stage').includes('preview boom'), alertIn('.cb-stage'));
check('the editor stays usable under a failing preview', !!q('#cb-source') && q('#cb-source').readOnly === false);
globalThis.__cbBoom = false;
unmounted();

// --- F. delete -----------------------------------------------------------------
console.log('F. delete');
COMPONENTS = [{ name: 'Mine', source: OK_SOURCE }];
bindings.handlers.DeleteComponent = (name) => {
  deleteCalls.push(name);
  return Promise.reject(new Error('can\'t delete "Mine" while it is placed on the Match view'));
};
await mounted();
click(rowNamed('Mine', '.cb-yours'));
await settle(10);
click(q('.cb-delete'));
await settle(10);
check('a refused delete names the placement', alertIn('.cb-action-error').includes('placed on the Match view'), alertIn('.cb-action-error'));
check('the refused component stays open', q('#cb-name')?.value === 'Mine');
click(q('.cb-action-error button'));
flushSync();
check('the refusal dismisses in place', !q('.cb-action-error'));
bindings.handlers.DeleteComponent = (name) => {
  deleteCalls.push(name);
  COMPONENTS = COMPONENTS.filter((c) => c.name !== name);
  return null;
};
click(q('.cb-delete'));
await settle(10);
check('a delete that succeeds sends the name', deleteCalls.at(-1) === 'Mine', JSON.stringify(deleteCalls));
check('the editor clears after a delete', q('#cb-name')?.value === '');
check('the deleted component leaves the list', !rowNamed('Mine', '.cb-yours'));
unmounted();

// --- G. viewstate round-trip -------------------------------------------------------
console.log('G. viewstate round-trip');
COMPONENTS = [{ name: 'Mine', source: OK_SOURCE }];
bindings.handlers.DeleteComponent = () => null;
await mounted();
click(rowNamed('Mine', '.cb-yours'));
await settle(10);
unmounted();
await mounted();
await settle(10);
check('the open component is restored after a remount', q('#cb-name')?.value === 'Mine', q('#cb-name')?.value);
unmounted();

// --- H. a failed list read --------------------------------------------------------
console.log('H. a failed list read');
bindings.handlers.ListComponents = () => Promise.reject(new Error('couldn\'t load your components'));
await mounted();
check('a failed list read shows its message', (q('.error')?.textContent || '').includes("couldn't load your components"), q('.error')?.textContent);
check('the failed list offers Try again', !!buttonByText(S.componentbuilder.retry));
bindings.handlers.ListComponents = () => COMPONENTS.map((c) => ({ ...c }));
click(buttonByText(S.componentbuilder.retry));
await settle(10);
check('Try again reloads the list and clears the error', !q('.error'));
unmounted();

// --- I. the preview's context ----------------------------------------------------
console.log('I. the preview context');
const CONTEXT_SOURCE = `<script>
  let { context } = $props();
</script>
<p class="ctx-match">{context.matchId ?? 'none'}</p>`;
// The match list is read through the services cache, which holds the empty
// list the earlier mounts read: clear it so this mount sees the match.
services.invalidate();
bindings.handlers.ListMatches = () => [{ id: 42, map: 'de_ctx', scoreCT: 1, scoreT: 0, realRounds: 1, status: 'ready' }];
COMPONENTS = [];
await mounted();
await setText(q('#cb-source'), CONTEXT_SOURCE);
await settle(10);
check('with no match chosen the preview context carries no matchId', q('.cb-stage .ctx-match')?.textContent.trim() === 'none', q('.cb-stage')?.textContent);
click(q('#cb-match'));
await settle(4);
check('the match picker lists the ready match', !!q('#mp-opt-42'), qa('[id^="mp-opt-"]').map((e) => e.id).join(','));
if (q('#mp-opt-42')) click(q('#mp-opt-42'));
await settle(10);
check('a chosen match is the preview context (context.matchId)', q('.cb-stage .ctx-match')?.textContent.trim() === '42', q('.cb-stage .ctx-match')?.textContent);
unmounted();

check('nothing escaped the view', escaped.length === 0, escaped.join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
