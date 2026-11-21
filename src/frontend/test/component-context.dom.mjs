// jsdom driver for the component context and the nested mount
// (dogfood/04-COMPONENTS.md §3, §3.5; owner rulings 34 and 36), run against
// the real ComponentFrame, ChildFrame, read API and component compiler, with
// the real services.js over the scripted Wails stub:
//   A. a parent mounts a child by name, and the child reads context.matchId
//      from its parent and shows it;
//   B. a child that throws in render shows its own frame (dismissible), and
//      the parent keeps rendering;
//   C. a component that ignores the context mounts and renders as before;
//   D. a name that resolves to nothing, and a component that mounts itself,
//      show a refusal in their own slot (the depth limit holds).
//
// Run (from frontend/):  node test/component-context.dom.mjs
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
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
// instance the runtime compiler loads.
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
  'HTMLTextAreaElement', 'HTMLButtonElement', 'SVGElement', 'Element', 'Node', 'Text', 'Comment',
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
process.on('uncaughtException', (e) => {
  escaped.push('uncaught: ' + (e && e.message));
  console.log('UNCAUGHT ' + (e && e.message));
});
process.on('unhandledRejection', (e) => {
  escaped.push('rejection: ' + (e && e.message));
  console.log('UNCAUGHT rejection ' + (e && e.message));
});

// --- bundling -----------------------------------------------------------------
// Every .svelte the harness reaches is compiled into the cache dir (the frame
// and the child frame import each other, which the bundler allows: a bundle
// is named before its imports are compiled); every .js stays where it is.
const cacheDir = join('node_modules', '.cache', 'spectra-dom-tests', 'component-context');
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
    // A .js module that imports a .svelte file (the builtin panel registry)
    // is bundled too; every other .js stays where it is.
    if (target.endsWith('.js') && /from '[^']*\.svelte'/.test(readFileSync(target, 'utf8'))) {
      return `from '${pathToFileURL(bundle(target)).href}'`;
    }
    return `from '${pathToFileURL(target).href}'`;
  });
  if (absPath.endsWith('.svelte')) writeFileSync(out, compile(src, { filename: absPath, generate: 'client' }).js.code);
  else writeFileSync(out, src);
  return out;
}
const harnessBundle = bundle(resolve('test/component-context.harness.svelte'));

const { mount, unmount, flushSync } = await import('svelte');
const bindings = await import('./stubs/bindings.mjs');
const services = await import(pathToFileURL(resolve('src/lib/services.js')).href);
const S = await import(pathToFileURL(resolve('src/lib/strings/index.js')).href);
const { MAX_NEST_DEPTH } = await import(pathToFileURL(resolve('src/lib/componentruntime/frameContext.js')).href);
const Harness = (await import(pathToFileURL(harnessBundle).href)).default;

// --- the scripted backend: the user components the nested mount can name ------
const PARENT = `<script>
  let { spectra, context } = $props();
</script>
<p class="parent-ok">parent</p>
<spectra.Child name="kid" props={{ label: 'k' }} />
<spectra.Child name="boom" />`;

const KID = `<script>
  let { context } = $props();
</script>
<p class="kid-match">{context.matchId}</p>`;

const BOOM = `<script>
  throw new Error('child boom');
</script>
<p class="boom-ok">never</p>`;

const PLAIN = `<script>
  let { label = 'plain' } = $props();
</script>
<p class="plain-ok">{label}</p>`;

const SELF = `<script>
  let { spectra } = $props();
</script>
<p class="self-ok">self</p>
<spectra.Child name="self" />`;

const KIDS = [
  { name: 'kid', source: KID },
  { name: 'boom', source: BOOM },
  { name: 'plain', source: PLAIN },
  { name: 'self', source: SELF },
];
bindings.handlers.ListComponents = () => KIDS.map((c) => ({ ...c }));

// --- helpers -------------------------------------------------------------------
const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) {
    await sleep(30);
    flushSync();
  }
};
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

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
let root = null;
const mountSurface = async ({ source, context = null }) => {
  unmountSurface();
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(Harness, { target, props: { source, context } });
  root = target;
  await settle();
};
const unmountSurface = () => {
  if (instance) unmount(instance);
  instance = null;
  if (target) target.remove();
  target = null;
};

const q = (sel) => root.querySelector(sel);
const qa = (sel) => [...root.querySelectorAll(sel)];
// The text of a frame's failure, without its buttons.
const alertText = (el) => {
  const a = el && (el.matches('[role="alert"]') ? el : el.querySelector('[role="alert"]'));
  if (!a) return '';
  const copy = a.cloneNode(true);
  for (const b of copy.querySelectorAll('button')) b.remove();
  return copy.textContent.trim();
};

// --- A. the parent mounts a child, and the child reads its context --------------
console.log('A. nested mount and the inherited context');
await mountSurface({ source: PARENT, context: { matchId: 42 } });
check('the parent renders its own content', !!q('.parent-ok'));
check('the child reads context.matchId from its parent', q('.kid-match')?.textContent.trim() === '42', q('.kid-match')?.textContent);
check('the child mounts in a frame of its own inside the parent frame', !!q('[data-slot=top] .cframe .cframe .kid-match'));
check('the surface probe still renders', !!q('#probe'));

// --- B. a child that throws shows its own frame; the parent keeps rendering -----
console.log('B. a failing child is contained');
const bootFrame = [...root.querySelectorAll('[data-slot=top] .cframe .cframe')].find((f) => f.textContent.includes('child boom') || f.querySelector('[role="alert"]'));
check('the child failure shows in the child frame', !!bootFrame && alertText(bootFrame).includes('child boom'), alertText(bootFrame));
check('the parent keeps rendering next to the failed child', !!q('.parent-ok') && !!q('.kid-match'));
check('the parent frame shows no error of its own', qa('[data-slot=top] > .cframe > .error').length === 0);
check('the failed child’s content is not shown', !q('.boom-ok'));
const bootDismiss = bootFrame && bootFrame.querySelector(`button[aria-label="${S.components.frameDismiss}"]`);
check('the child error is dismissible in place', !!bootDismiss);
if (bootDismiss) {
  click(bootDismiss);
  flushSync();
  check('dismissing the child error leaves the parent rendered', !alertText(root.querySelector('[data-slot=top]')) && !!q('.parent-ok'));
}

// --- C. a component that ignores the context is unaffected ---------------------
console.log('C. a component that ignores the context');
await mountSurface({ source: PLAIN, context: { matchId: 42, steamId: '765', round: 3 } });
check('it renders with a context it never reads', q('.plain-ok')?.textContent.trim() === 'plain');
check('no error is shown for it', !alertText(root.querySelector('[data-slot=top]')));

// --- D. refusals stay in their own slot ----------------------------------------
console.log('D. refusals stay in their own slot');
const UNKNOWN = `<script>
  let { spectra } = $props();
</script>
<p class="u-ok">u</p>
<spectra.Child name="nope" />`;
await mountSurface({ source: UNKNOWN, context: { matchId: 1 } });
check('a child name with no component shows a refusal in its slot', alertText(q('[data-slot=top]')).includes(S.fill(S.components.childNotFound, { name: 'nope' })), alertText(q('[data-slot=top]')));
check('the parent around an unknown child still renders', !!q('.u-ok'));

await mountSurface({ source: SELF, context: { matchId: 1 } });
const depthMsg = S.fill(S.components.childDepth, { depth: MAX_NEST_DEPTH });
check('a component that mounts itself stops at the depth limit', qa('.error').some((e) => alertText(e).includes(depthMsg)), qa('.error').length + ' errors');
check('the self-mounting parent keeps rendering', !!q('.self-ok'));

unmountSurface();
console.log('');
console.log(`${failures === 0 && escaped.length === 0 ? 'PASS' : 'FAIL'}: ${failures} failed, ${escaped.length} escaped`);
for (const e of escaped) console.log('UNCAUGHT ' + e);
process.exit(failures === 0 && escaped.length === 0 ? 0 : 1);
