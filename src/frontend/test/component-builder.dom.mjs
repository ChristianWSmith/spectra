import './compile-worker-node.mjs';
// jsdom driver for the Component builder (views/ComponentBuilder.svelte) —
// the component AUTHORING surface, run against the real view, the real
// save gate (componentruntime/savegate.js → compile.js), the real
// ComponentFrame boundary and the shared service stubs (no Wails backend).
//   A. mount shape: the header and its help target, the three panels;
//   B. the list: the built-in first (chip, read-only), then yours; an empty
//      "Yours" says so; a failed list read shows its error with Try again;
//   C. a built-in is edited in place (owner ruling 43): Save stores an
//      override by its id, a refused edit keeps Save off, Restore to default
//      deletes the override and loads the shipped source;
//   C3. use as my view: one placement per surface, Reset removes it;
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
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installEsmDirHook } from './esm-dir-hook.mjs';
import { reachesSvelte } from './bundle-reach.mjs';

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
// An escaped error is printed at once: the handler would otherwise end the run
// silently with exit 0 (the driver-liveness guard's failure mode).
process.on('uncaughtException', (e) => { escaped.push('uncaught: ' + (e && e.message)); console.log('  FAIL UNCAUGHT ' + String(e && (e.stack || e.message || e))); });
process.on('unhandledRejection', (e) => { escaped.push('rejection: ' + (e && e.message)); console.log('  FAIL UNCAUGHT rejection ' + String(e && (e.stack || e.message || e))); });

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
    if (target.endsWith('.svelte.js')) return `from '${pathToFileURL(bundle(target)).href}'`;
    if (target.endsWith('.svelte')) return `from '${pathToFileURL(bundle(target)).href}'`;
    // A .js module that imports a .svelte file (the builtin panel registry) is
    // bundled too; every other .js stays where it is.
    // A .js that reaches a .svelte through its own imports (resolve.js → builtins/panels.js)
    // is rewritten like its importer; every other .js stays where it is.
    if (target.endsWith('.js') && reachesSvelte(target)) {
      return `from '${pathToFileURL(bundle(target)).href}'`;
    }
    return `from '${pathToFileURL(target).href}'`;
  });
  if (absPath.endsWith('.svelte')) writeFileSync(out, compile(src, { filename: absPath, generate: 'client' }).js.code);
  else if (/\.svelte\.js$/.test(absPath)) writeFileSync(out, compileModule(src, { filename: absPath, generate: 'client' }).js.code);
  else writeFileSync(out, src);
  return out;
}
const viewBundle = bundle(resolve('src/lib/views/ComponentBuilder.svelte'));

const { mount, unmount, flushSync } = await import('svelte');
const bindings = await import('./stubs/bindings.mjs');
const services = await import(pathToFileURL(resolve('src/lib/services.js')).href);
const S = await import(pathToFileURL(resolve('src/lib/strings/index.js')).href);
const { builtinShippedSource } = await import(pathToFileURL(resolve('src/lib/componentbuiltins.js')).href);
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

// Edited builtins and the surfaces' placements (owner ruling 43, C5f).
let OVERRIDES = [];
let PLACEMENTS = {};
const overrideCalls = [];
const overrideDeleteCalls = [];
const setCalls = [];
const resetCalls = [];
const PLACEHOLDER_ID = 'match-overview';
bindings.handlers.ListBuiltinOverrides = () => OVERRIDES.map((o) => ({ ...o }));
bindings.handlers.SaveBuiltinOverride = (id, source) => {
  overrideCalls.push({ id, source });
  OVERRIDES = OVERRIDES.filter((o) => o.id !== id).concat({ id, source });
  return { id, source };
};
bindings.handlers.DeleteBuiltinOverride = (id) => {
  overrideDeleteCalls.push(id);
  OVERRIDES = OVERRIDES.filter((o) => o.id !== id);
  return null;
};
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

// Already in the form the save writes (the save formats it: a blank line after </script>, a final newline).
const OK_EDIT_SOURCE = `<script>
  let { spectra } = $props();
</script>

<p class="edit-ok">EDITED BUILTIN</p>
`;
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
  // The check compiles in the worker, which loads the compiler on its first
  // use: wait for the check to leave its pending state.
  for (let i = 0; i < 1000; i++) {
    flushSync();
    if (!q('.cb-check')?.textContent.includes(S.componentbuilder.checking)) break;
    await sleep(10);
  }
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
// The Preview control sits on the editor card; activating it opens the results full screen.
const pvBtn = () => qa('.cb-editor button').find((b) => b.textContent.trim().includes(S.componentbuilder.previewHeading));
const openPreview = async () => {
  click(pvBtn());
  await settle(4);
};
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
check('two panels: the list and the editor card (the preview is no longer a card)', !!q('.cb-list') && !!q('.cb-editor') && !q('.cb-preview'));
// The Preview control on the editor card opens the results full screen; the X and Escape close them.
{
  check('no overlay until Preview is activated', !q('.preview-overlay'));
  check('Preview is disabled until a source passes the check', !!pvBtn() && pvBtn().disabled === true);
}

check('no error alert on a clean mount', !q('.view-header + p.error') && !q('[role="alert"]'));

// --- B. the list ---------------------------------------------------------------
console.log('B. the list');
const builtinRow = rowNamed(PLACEHOLDER_ID, '.cb-builtins');
check('the sample built-in is listed in the Built-in group', !!builtinRow);
check('the built-in row carries the built-in chip', builtinRow && builtinRow.textContent.includes(S.common.chipBuiltin));
check('an empty Yours list says so', q('.cb-list')?.textContent.includes(S.componentbuilder.noUserComponents));
check('no delete control on a built-in row', !builtinRow.parentElement.querySelector('.cb-row-acts'));
// The Profile view and its six panels are listed (the registry, builtins/panels.js).
const PROFILE_BUILTINS = [
  'profile',
  'profile-career',
  'profile-trend',
  'profile-sides',
  'profile-maps',
  'profile-weapons',
  'profile-history',
];
for (const id of PROFILE_BUILTINS) {
  const label = id;
  check(`the Profile list shows ${label} in the Built-in group`, !!rowNamed(label, '.cb-builtins'));
}
unmounted();

// --- C. a built-in edited in place (owner ruling 43) ---------------------------
console.log('C. built-in edited in place; restore to default');
COMPONENTS = [];
OVERRIDES = [];
await mounted();
check(
  'a built-in with no override shows no Edited chip in the list',
  !!rowNamed(PLACEHOLDER_ID, '.cb-builtins') &&
    !rowNamed(PLACEHOLDER_ID, '.cb-builtins').textContent.includes(S.common.chipEdited),
);
click(rowNamed(PLACEHOLDER_ID, '.cb-builtins'));
await settle();
check('the built-in name field is read-only', q('#cb-name')?.readOnly === true);
check('the built-in source is editable', q('#cb-source')?.readOnly === false);
check('Save is disabled until the built-in is edited', q('.cb-save')?.disabled === true);
check('a built-in shows no Delete control', !q('.cb-delete'));
check('a built-in offers no copy action (edit in place instead)', !q('.cb-duplicate') && !buttonByText('Duplicate'));
check('Restore to default is disabled with no edit', q('.cb-restore')?.disabled === true);
check('the built-in source is in the editor', q('#cb-source')?.value.includes('<script>'));
await setText(q('#cb-source'), OK_EDIT_SOURCE);
await settle(10);
check('an edit that checks out enables Save', q('.cb-save')?.disabled === false, q('.cb-check')?.textContent);
const beforeOv = overrideCalls.length;
click(q('.cb-save'));
await settle(10);
check('Save stores one override of the built-in, by its id', overrideCalls.length === beforeOv + 1);
const ovCall = overrideCalls[overrideCalls.length - 1];
check(
  'the override names the built-in and carries the edited source',
  ovCall && ovCall.id === PLACEHOLDER_ID && ovCall.source === OK_EDIT_SOURCE,
  JSON.stringify(ovCall),
);
check('the built-in row shows the edited chip', rowNamed(PLACEHOLDER_ID, '.cb-builtins')?.textContent.includes(S.common.chipEdited));
check('Restore to default is enabled once edited', q('.cb-restore')?.disabled === false);
check('no user component was written by an edit', saveCalls.length === 0);
click(q('.cb-restore'));
await settle(10);
check('Restore to default deletes the override', overrideDeleteCalls.length === 1 && overrideDeleteCalls[0] === PLACEHOLDER_ID);
check('Restore to default brings back the shipped source', q('#cb-source')?.value.includes('<script>') && !q('#cb-source')?.value.includes('EDITED BUILTIN'));
check(
  'after restore the built-in row is still listed and carries no Edited chip',
  !!rowNamed(PLACEHOLDER_ID, '.cb-builtins') &&
    !rowNamed(PLACEHOLDER_ID, '.cb-builtins').textContent.includes(S.common.chipEdited),
);
unmounted();

// --- C1. a Profile panel edited in place, then restored (owner ruling 43) ------
console.log('C1. a profile panel edited in place; restore to default');
COMPONENTS = [];
OVERRIDES = [];
overrideCalls.length = 0;
overrideDeleteCalls.length = 0;
const CAREER_ID = 'profile-career';
const careerLabel = CAREER_ID;
await mounted();
click(rowNamed(careerLabel, '.cb-builtins'));
await settle();
const careerShipped = builtinShippedSource(CAREER_ID);
check('the Career panel opens at its shipped source', q('#cb-source')?.value === careerShipped);
await setText(q('#cb-source'), OK_EDIT_SOURCE);
await settle(10);
check('an edit of the Career panel that checks out enables Save', q('.cb-save')?.disabled === false, q('.cb-check')?.textContent);
click(q('.cb-save'));
await settle(10);
const careerOv = overrideCalls[overrideCalls.length - 1];
check(
  'Save stores an override of the Career panel by its id',
  overrideCalls.length === 1 && careerOv && careerOv.id === CAREER_ID && careerOv.source === OK_EDIT_SOURCE,
  JSON.stringify(careerOv),
);
check('the Career row shows the edited chip', rowNamed(careerLabel, '.cb-builtins')?.textContent.includes(S.common.chipEdited));
click(q('.cb-restore'));
await settle(10);
check('Restore to default deletes the Career override', overrideDeleteCalls.length === 1 && overrideDeleteCalls[0] === CAREER_ID);
check('Restore to default brings the Career shipped source back', q('#cb-source')?.value === careerShipped);
check('the Career row carries no edited chip after restore', !rowNamed(careerLabel, '.cb-builtins')?.textContent.includes(S.common.chipEdited));
unmounted();

// --- C2. a refused edit of a built-in ------------------------------------------
console.log('C2. a refused edit of a built-in');
COMPONENTS = [];
OVERRIDES = [];
overrideCalls.length = 0;
await mounted();
click(rowNamed(PLACEHOLDER_ID, '.cb-builtins'));
await settle();
await setText(q('#cb-source'), BROKEN_SOURCE);
check('a refused edit names its line', alertIn('.cb-check').startsWith('Line 2:'), alertIn('.cb-check'));
check('Save stays disabled for a refused edit', q('.cb-save')?.disabled === true);
check('no override is written for a refused edit', overrideCalls.length === 0);
unmounted();

// --- C3. use as my view -------------------------------------------------------
console.log('C3. use as my view');
COMPONENTS = [];
OVERRIDES = [];
PLACEMENTS = {};
await mounted();
click(rowNamed(PLACEHOLDER_ID, '.cb-builtins'));
await settle();
const useAsBtn = () => q('.cb-use-view');
const menuItems = () => qa('.cb-use-pop [role="menuitem"]');
const itemFor = (label) => menuItems().find((b) => b.textContent.trim().startsWith(label));
check('the open built-in offers one Use as my... button', !!useAsBtn() && useAsBtn().textContent.trim() === S.componentbuilder.useAsView);
check('the popover is closed until the button opens it', !q('.cb-use-pop'));
click(useAsBtn());
await settle(10);
check('the popover offers Match View and Profile View', menuItems().length === 2 && !!itemFor(S.componentbuilder.surfaceMatch) && !!itemFor(S.componentbuilder.surfaceProfile));
const beforeSet = setCalls.length;
click(itemFor(S.componentbuilder.surfaceMatch));
await settle(10);
check('choosing Match View writes exactly one placement for the match surface', setCalls.length === beforeSet + 1);
const setCall = setCalls[setCalls.length - 1];
check(
  'the placement points at the open component',
  setCall && setCall.surface === 'match-view' && setCall.rows.length === 1 && setCall.rows[0].component === PLACEHOLDER_ID,
  JSON.stringify(setCall),
);
check('the open component carries a Match View chip', !!q('.cb-editor .chip') && q('.cb-editor').textContent.includes(S.common.chipViewMatch));
check('the list row carries the same chip', rowNamed(PLACEHOLDER_ID, '.cb-builtins').textContent.includes(S.common.chipViewMatch));
click(useAsBtn());
await settle(10);
check('a placed view is marked in the popover', (itemFor(S.componentbuilder.surfaceMatch)?.textContent || '').includes('✓'));
click(itemFor(S.componentbuilder.surfaceMatch));
await settle(10);
check('choosing the placed view again gives it back to the default', resetCalls.length === 1 && resetCalls[0] === 'match-view');
check('the chip goes with it', !q('.cb-editor') || !q('.cb-editor').textContent.includes(S.common.chipViewMatch));
unmounted();

// An unsaved user component has no view to place yet.
COMPONENTS = [];
await mounted();
click(buttonByText(S.componentbuilder.newLabel));
await settle();
check('an unsaved component offers no Use as my... button', !q('.cb-use-view'));
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
await openPreview();
check('Preview opens the results full screen over the view', !!q('.preview-overlay') && !!q('.preview-overlay .cb-stage'));
check('the preview shows its failure inside its own frame', alertIn('.cb-stage').includes('preview boom'), alertIn('.cb-stage'));
check('the editor stays usable under a failing preview', !!q('#cb-source') && q('#cb-source').readOnly === false);
check('the X in the overlay header closes the preview', !!q('.preview-overlay .preview-close'));
click(q('.preview-overlay .preview-close'));
await settle(2);
check('the X dismisses the overlay', !q('.preview-overlay'));
await openPreview();
dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await settle(2);
check('Escape dismisses the overlay too', !q('.preview-overlay'));
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
await openPreview();
check('with no match chosen the preview context carries no matchId', q('.cb-stage .ctx-match')?.textContent.trim() === 'none', q('.cb-stage')?.textContent);
click(q('#cb-match'));
await settle(4);
check('the match picker lists the ready match', !!q('#mp-opt-42'), qa('[id^="mp-opt-"]').map((e) => e.id).join(','));
if (q('#mp-opt-42')) click(q('#mp-opt-42'));
await settle(10);
check('a chosen match is the preview context (context.matchId)', q('.cb-stage .ctx-match')?.textContent.trim() === '42', q('.cb-stage .ctx-match')?.textContent);
unmounted();

check('nothing escaped the view', escaped.length === 0, escaped.join(' | '));
// --- K. the compile worker, the floater and Cancel (owner ruling 47) ------------
console.log('K. compile worker, floater, Cancel');
const workstate = await import(pathToFileURL(bundle(resolve('src/lib/workstate.svelte.js'))).href); // the view's copy: one instance, so one compile tracker
const seam = await import(pathToFileURL(resolve('test/compile-worker-node.mjs')).href);
// A large generated component: the compile must take long enough to observe.
const bigSource = (n) => {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(`<p class="r${i % 7}">{n + ${i}}</p>`);
  return `<script>\n  let n = $state(0);\n</script>\n${rows.join('\n')}`;
};
// Poll (flushing Svelte) until cond holds or ms elapses.
const until = async (cond, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    flushSync();
    if (cond()) return true;
    await sleep(10);
  }
  flushSync();
  return cond();
};
const cancelBtn = () => buttonByText(S.componentbuilder.cancelCompile);
const works = [];
const unwork = workstate.subscribeWork((s) => works.push(s));
const lastWork = () => works[works.length - 1];
const actionErrorText = () => alertIn('.cb-action-error');

COMPONENTS = [];
await mounted();
click(buttonByText(S.componentbuilder.newLabel));
await settle();
await setText(q('#cb-name'), 'Big');
check('(c) no Cancel while nothing compiles', !cancelBtn());

// (a) a valid component compiles through the worker and mounts in the preview.
await setText(q('#cb-source'), OK_SOURCE);
check('(a) a valid component passes the check through the worker', q('.cb-check')?.textContent.includes(S.componentbuilder.checkOk), alertIn('.cb-check'));
await openPreview();
check('(a) the valid component mounts in the preview', await until(() => !!q('.cb-stage .mine-ok')));

// (b) a syntax error comes back from the worker with its line; nothing is written.
const writesBeforeBroken = saveCalls.length;
await setText(q('#cb-source'), BROKEN_SOURCE);
check('(b) a syntax error is reported with its line from the worker', alertIn('.cb-check').startsWith('Line 2:'), alertIn('.cb-check'));
let brokenSave = null;
try {
  await services.saveComponent('', 'Big', BROKEN_SOURCE);
} catch (e) {
  brokenSave = e;
}
check('(b) the save path refuses it at its line and writes nothing', !!brokenSave && brokenSave.message.startsWith('Line 2:') && saveCalls.length === writesBeforeBroken);

// (c) + (f): a large check compiles in the worker. While it runs, Cancel shows
// and the floater carries it; the main thread keeps ticking throughout.
const ticks = { n: 0 };
const ticker = setInterval(() => ticks.n++, 5);
const bigEl = q('#cb-source');
bigEl.value = bigSource(4000);
bigEl.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
flushSync();
const cancelShown = await until(() => !!cancelBtn(), 5000);
check('(c) Cancel shows while the check compiles', cancelShown);
check('(c) the compile shows in the floater through runWork', !!lastWork() && lastWork().visible === true && lastWork().status === 'running', JSON.stringify(lastWork()));
const bigDone = await until(() => !cancelBtn(), 60000);
clearInterval(ticker);
check('(c) Cancel is gone once the compile finishes', bigDone);
check('(c) the big source passes the check', q('.cb-check')?.textContent.includes(S.componentbuilder.checkOk), alertIn('.cb-check'));
check('(f) the event loop kept ticking during the 4000-block compile', ticks.n >= 5, `ticks=${ticks.n}`);

// (d) Cancel during a save: the worker is terminated, the save reports the
// cancel through the error path, and nothing is written.
check('(d) Save is enabled for the checked big source', q('.cb-save')?.disabled === false);
const writesBeforeCancel = saveCalls.length;
const componentsBeforeCancel = JSON.stringify(COMPONENTS);
click(q('.cb-save'));
const midSave = await until(() => !!cancelBtn(), 5000);
check('(d) Cancel shows while the save compiles', midSave);
click(cancelBtn());
const reported = await until(() => actionErrorText() === S.components.compileCancelled, 5000);
check('(d) the save reports the cancel through the error path', reported, actionErrorText());
check('(d) the database is unchanged: no write reached the service', saveCalls.length === writesBeforeCancel && JSON.stringify(COMPONENTS) === componentsBeforeCancel);
check('(d) Cancel is gone once the cancel lands', !cancelBtn());

// (e) the compile after a cancel starts a fresh worker and succeeds.
const createdBeforeNext = seam.created.count;
click(q('.cb-save'));
const saved = await until(() => saveCalls.length === writesBeforeCancel + 1, 60000);
check('(e) the next save starts a fresh worker and succeeds', saved && seam.created.count === createdBeforeNext + 1, `created +${seam.created.count - createdBeforeNext}`);

unwork();
unmounted();

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
