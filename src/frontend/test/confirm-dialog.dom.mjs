// jsdom driver for ConfirmDialog: the window.confirm() replacement —
// promise resolution for confirm / cancel / dismissal, supersession by a
// second prompt, and the rendered title/message/buttons.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/confirm-dialog.dom.mjs
// (must be run with frontend/ as the working directory)
// (the hook below makes the browser condition stick under a plain
// `node --test test/*.mjs` too — without it svelte resolves to the
// SERVER build and mount() throws, which the runner reports as a bare
// "pass 1" with zero checks executed).
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// svelte's package exports pick the SERVER build without the `browser`
// condition (mount() then throws "lifecycle_function_unavailable"), so
// the driver adds it for every svelte specifier before anything imports
// one (the same hook combat.dom.mjs installs).
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

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement',
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

const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'confirm-dialog');
mkdirSync(dir, { recursive: true });

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};

// Dialog (no imports) → local bundle; ConfirmDialog's ./Dialog.svelte
// import rewritten to it; harness → local bundle.
svelteCompile(
  readFileSync('src/lib/components/Dialog.svelte', 'utf8'),
  'Dialog.svelte',
  join(dir, 'dialog.js'),
);
const cdSrc = readFileSync('src/lib/components/ConfirmDialog.svelte', 'utf8').replace(
  "import Dialog from './Dialog.svelte';",
  "import Dialog from './dialog.js';",
);
svelteCompile(cdSrc, 'ConfirmDialog.svelte', join(dir, 'confirmdialog-bundle.js'));
svelteCompile(
  readFileSync('test/confirm-dialog.harness.svelte', 'utf8'),
  'harness.svelte',
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
const $ = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const key = (el, k) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const panel = () => $('.dlg-panel')[0];
const backdrop = () => $('.dlg-back')[0];
const buttons = () => $('.cf-body button');
const closed = () => $('.dlg-back').length === 0;

console.log('A. ask() renders the prompt');
let p = globalThis.__ask({
  title: 'Delete from disk?',
  message: 'Permanently deletes demo.dem from /demos. This cannot be undone.',
  confirmLabel: 'Delete from disk',
});
await sleep();
check('backdrop open', !!backdrop());
check('panel labelled with the title', panel()?.getAttribute('aria-label') === 'Delete from disk?', panel()?.getAttribute('aria-label'));
check('title rendered', $('.cf-title')[0]?.textContent === 'Delete from disk?', $('.cf-title')[0]?.textContent);
check('message rendered', $('.cf-msg')[0]?.textContent.includes('demo.dem'));
const labels = buttons().map((b) => b.textContent.trim());
check('Cancel + confirm buttons', JSON.stringify(labels) === JSON.stringify(['Cancel', 'Delete from disk']), JSON.stringify(labels));

console.log('B. the confirm button resolves true and closes');
click(buttons()[1]);
check('resolves true', (await p) === true);
await sleep();
check('closed', closed());

console.log('C. Cancel resolves false');
p = globalThis.__ask({ title: 'Delete?', message: 'x', confirmLabel: 'Delete' });
await sleep();
click(buttons()[0]);
check('resolves false', (await p) === false);
await sleep();
check('closed', closed());

console.log('D. Escape on the backdrop resolves false');
p = globalThis.__ask({ title: 'Delete?', message: 'x' });
await sleep();
key(backdrop(), 'Escape');
check('resolves false', (await p) === false);
await sleep();
check('closed', closed());

console.log('E. a backdrop click (outside the panel) resolves false');
p = globalThis.__ask({ title: 'Delete?', message: 'x' });
await sleep();
click(backdrop());
check('resolves false', (await p) === false);
await sleep();
check('closed', closed());

console.log('F. Enter on the panel resolves true');
p = globalThis.__ask({ title: 'Delete?', message: 'x', confirmLabel: 'Delete' });
await sleep();
key(panel(), 'Enter');
check('resolves true', (await p) === true);
await sleep();
check('closed', closed());

console.log('G. Enter on a button is left to the browser (never double-fires)');
p = globalThis.__ask({ title: 'Delete?', message: 'x', confirmLabel: 'Delete' });
let settled = false;
p.then(() => (settled = true));
await sleep();
key(buttons()[1], 'Enter');
await sleep();
check('still pending', settled === false);
click(buttons()[1]); // resolve it so the next prompt is not stacked on top
await sleep();

console.log('H. a second ask supersedes the first');
const first = globalThis.__ask({ title: 'First?', message: 'x' });
await sleep();
const second = globalThis.__ask({ title: 'Second?', message: 'y', confirmLabel: 'Go' });
await sleep();
check('first resolves false', (await first) === false);
check('prompt shows the second title', panel()?.getAttribute('aria-label') === 'Second?', panel()?.getAttribute('aria-label'));
click(buttons()[1]);
check('second resolves true', (await second) === true);
await sleep();
check('closed', closed());

if (errors.length) failures += errors.length;
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
