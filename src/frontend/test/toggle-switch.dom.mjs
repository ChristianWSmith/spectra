import './compile-worker-node.mjs';
// jsdom driver for ToggleSwitch: the parent owns the value, so a click
// reports the requested state and the box returns to the owned value (a refused
// change leaves it where it was), and a locked switch reports nothing.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/toggle-switch.dom.mjs
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'toggle-switch');
mkdirSync(dir, { recursive: true });

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};

// ToggleSwitch has no imports: compile it and the harness into the cache dir.
svelteCompile(
  readFileSync('src/lib/components/ToggleSwitch.svelte', 'utf8'),
  'ToggleSwitch.svelte',
  join(dir, 'toggleswitch-bundle.js'),
);
svelteCompile(
  readFileSync('test/toggle-switch.harness.svelte', 'utf8'),
  'harness.svelte',
  join(dir, 'harness.js'),
);

const { mount, flushSync } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'harness.js')).href);
const target = document.createElement('div');
document.body.appendChild(target);
mount(mod.default, { target });

const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms));
await sleep();

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const box = () => document.querySelector('input[role="switch"]');
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

console.log('A. a click reports the request, and a refused change snaps back');
check('starts on', box().checked === true);
click(box());
await sleep();
check('the request reached onchange as off', JSON.stringify(globalThis.__calls) === '[false]', JSON.stringify(globalThis.__calls));
check('the box snapped back to the owned value (on)', box().checked === true);

console.log('B. a granted change follows the owned value');
globalThis.__set(false);
flushSync();
await sleep();
check('the box shows the new owned value (off)', box().checked === false);
click(box());
await sleep();
check('the request reached onchange as on', JSON.stringify(globalThis.__calls) === '[false,true]', JSON.stringify(globalThis.__calls));
check('a refused switch-on snaps back to off', box().checked === false);

console.log('C. a locked switch reports nothing');
globalThis.__calls.length = 0;
globalThis.__lock(true);
flushSync();
await sleep();
check('the box is disabled', box().disabled === true);
click(box());
await sleep();
check('no request while locked', globalThis.__calls.length === 0, JSON.stringify(globalThis.__calls));

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
