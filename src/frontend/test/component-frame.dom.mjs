import './compile-worker-node.mjs';
import { subscribeCompiles } from '../src/lib/componentruntime/compileclient.js';
// jsdom driver for ComponentFrame + the component runtime
// (lib/componentruntime/): a broken component shows its own dismissible
// frame while the rest of the surface keeps rendering; render, $effect,
// event-handler, guarded async and read-API failures all land in the
// frame; a render failure retries in place; a syntax error shows its line; the compiler is not loaded until
// a user source mounts.
//
// Run (from frontend/):  node test/component-frame.dom.mjs
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// svelte resolves to its SERVER build without the browser condition.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return nextResolve(specifier, { ...context, conditions: ['browser', ...(context.conditions || [])] });
    }
    return nextResolve(specifier, context);
  },
});

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'CustomEvent', 'Event', 'KeyboardEvent',
  'MouseEvent', 'MutationObserver', 'location',
]) {
  if (!(k in dom.window)) continue;
  try {
    globalThis[k] = dom.window[k];
  } catch {
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  }
}

// Anything that escapes a frame is a failure of the frame.
const escaped = [];
// Printed as they happen: a module that fails to load reaches this handler
// (not the test), and a silent handler would end the run with exit 0.
process.on('uncaughtException', (e) => {
  escaped.push('uncaught: ' + (e && e.message));
  console.log('UNCAUGHT ' + (e && e.stack));
});
process.on('unhandledRejection', (e) => {
  escaped.push('rejection: ' + (e && e.message));
  console.log('UNCAUGHT rejection ' + (e && e.message));
});
dom.virtualConsole?.on?.('jsdomError', (e) => escaped.push('jsdom: ' + e.message));

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'component-frame');
for (const sub of ['components', 'componentruntime', 'strings']) mkdirSync(join(dir, sub), { recursive: true });
const copy = (rel) => writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
for (const f of readdirSync('src/lib/strings')) copy(join('strings', f));
for (const rel of ['router.js', 'players.js', 'metricstate.js', 'componentbuiltins.js', 'matchpanels.js', 'econpanels.js', 'utilpanels.js', 'builtinhelpers.js']) copy(rel);
for (const rel of ['readapi.js', 'eventerrors.js', 'frameContext.js', 'resolve.js']) copy(join('componentruntime', rel));
// compile.js is copied, but the compile client it reaches stays the real
// module: the node compile worker seam (test/compile-worker-node.mjs) is
// installed on that instance, so the copy imports it by absolute URL.
const compileClientUrl = pathToFileURL(join(process.cwd(), 'src/lib/componentruntime/compileclient.js')).href;
writeFileSync(
  join(dir, 'componentruntime', 'compile.js'),
  readFileSync('src/lib/componentruntime/compile.js', 'utf8').replace("from './compileclient.js'", `from '${compileClientUrl}'`),
);
// The service layer stays out: errText is the real one-liner, and the
// frame's default reads are a recorder (the driver passes its own).
writeFileSync(
  join(dir, 'services.js'),
  `export function errText(e) { if (e == null) return 'unknown error'; if (typeof e === 'string') return e; return e.message || String(e); }\nexport async function listComponents() { return []; }\nexport async function listBuiltinOverrides() { return []; }\n`,
);
writeFileSync(join(dir, 'componentruntime', 'reads.js'), 'export const serviceReads = {};\n');
// ChildFrame resolves builtin panels through the panel registry. This driver
// has no panels (it tests the source path), so the registry is an empty stub.
mkdirSync(join(dir, 'builtins'), { recursive: true });
writeFileSync(join(dir, 'builtins', 'panels.js'), 'export function builtinPanelById() { return null; }\n');
// componentbuiltins.js reads the build's generated panel sources (text only).
mkdirSync(join(dir, 'builtins', 'generated'), { recursive: true });
copy(join('builtins', 'generated', 'sources.js'));

const svelteCompile = (src, filename, out) =>
  // Runes-only, as the app compiles builtins (svelte.config.js) and user
  // components (componentruntime/compile.js).
  writeFileSync(out, compile(src, { filename, generate: 'client', css: 'injected', runes: true }).js.code);
// The frame and its child frame import each other: each .svelte's import of
// the other is pointed at its compiled output in the cache dir.
// The frames show their loading state with StatusChip (the centered spinner).
svelteCompile(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  join(dir, 'components', 'StatusChip.js'),
);
svelteCompile(
  readFileSync('src/lib/components/ComponentFrame.svelte', 'utf8')
    .replace("from './ChildFrame.svelte'", "from './ChildFrame.js'")
    .replace("from './StatusChip.svelte'", "from './StatusChip.js'"),
  'ComponentFrame.svelte',
  join(dir, 'components', 'ComponentFrame.js'),
);
svelteCompile(
  readFileSync('src/lib/components/ChildFrame.svelte', 'utf8')
    .replace("from './ComponentFrame.svelte'", "from './ComponentFrame.js'")
    .replace("from './StatusChip.svelte'", "from './StatusChip.js'"),
  'ChildFrame.svelte',
  join(dir, 'components', 'ChildFrame.js'),
);
svelteCompile(readFileSync('test/component-frame.harness.svelte', 'utf8'), 'harness.svelte', join(dir, 'harness.js'));
// A builtin: app source the bundler compiles (here: the driver), reading
// a metric through the read API it receives.
svelteCompile(
  `<script>
    let { spectra, label } = $props();
  </script>
  <p class="builtin-ok">{label}</p>
  {#await spectra.metric('adr', { match_id: 1, steam_id: 'a' }) then r}
    <span class="builtin-state">{r.state} {r.value}</span>
  {/await}`,
  'Builtin.svelte',
  join(dir, 'Builtin.js'),
);

const S = await import(pathToFileURL(join(dir, 'strings', 'index.js')).href);
const runtime = await import(pathToFileURL(join(dir, 'componentruntime', 'compile.js')).href);
const { mount, flushSync } = await import('svelte');
const Harness = (await import(pathToFileURL(join(dir, 'harness.js')).href)).default;
const Builtin = (await import(pathToFileURL(join(dir, 'Builtin.js')).href)).default;

const reads = {
  listMetrics: async () => [{ id: 1, name: 'adr' }],
  getMetricValuesForMatch: async () => [{ metricId: 1, subjectKey: 'a', dim: '', value: 81.5, valueKey: '', n: 20 }],
  getMetricValuesForPlayer: async () => [],
  getMetricComputeState: async () => [{ metricId: 1, state: 'fresh' }],
  getMetricStates: async () => [{ metricId: 1, state: 'fresh' }],
  componentQuery: async (sql) => (sql.includes('bad') ? { err: 'no such table: nope' } : { columns: ['x'], rows: [[1]] }),
};

const SOURCES = {
  ok: `<script>
    let n = $state(0);
  </script>
  <style>p { color: rgb(1, 2, 3); }</style>
  <p class="ok-count">{n}</p>
  <button class="ok-inc" onclick={() => n++}>+</button>`,
  render: `<script>
    if (globalThis.__renderBoom) throw new Error('render boom');
  </script>
  <p class="render-ok">recovered</p>`,
  effect: `<script>
    $effect(() => { throw new Error('effect boom'); });
  </script>
  <p>eff</p>`,
  handler: `<p class="handler-alive">alive</p>
  <button class="handler-btn" onclick={() => { throw new Error('handler boom'); }}>x</button>`,
  async: `<script>
    let { spectra } = $props();
  </script>
  <button class="async-btn" onclick={spectra.guard(async () => { await Promise.resolve(); throw new Error('async boom'); })}>x</button>`,
  read: `<script>
    let { spectra } = $props();
  </script>
  <button class="read-btn" onclick={spectra.guard(() => spectra.query('select * from bad'))}>x</button>`,
  syntax: `<script>
    let x = ;
  </script>`,
  legacy: `<script>
    export let x = 1;
  </script>
  <p>{x}</p>`,
};

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// A user component compiles in the worker (ruling 47): settle waits until no
// compile is pending, then lets the mounted component render.
let compilePending = false;
subscribeCompiles((on) => {
  compilePending = on;
});
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await sleep(30);
    flushSync();
  }
  for (let i = 0; i < 3000 && compilePending; i++) {
    await sleep(10);
    flushSync();
  }
  for (let i = 0; i < 3; i++) {
    await sleep(30);
    flushSync();
  }
};
const slot = (name) => document.querySelector(`[data-slot="${name}"]`);
const alertText = (name) => {
  const a = slot(name) && slot(name).querySelector('[role="alert"]');
  if (!a) return '';
  const copy = a.cloneNode(true); // the message only, never the buttons' labels
  for (const b of copy.querySelectorAll('button')) b.remove();
  return copy.textContent.trim();
};
const failedCopy = (err) => S.fill(S.components.frameFailed, { err });
const dismiss = (name) => slot(name).querySelector(`[role="alert"] button[aria-label="${S.components.frameDismiss}"]`);
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

console.log('A. a surface with only builtin and missing frames never loads the compiler');
const first = document.createElement('div');
document.body.appendChild(first);
mount(Harness, { target: first, props: { builtin: Builtin, reads } });
await settle();
// Registered after the first frame mounted, so it runs after the frames'
// own window listener: an error the frames routed is defaultPrevented.
dom.window.addEventListener('error', (e) => {
  if (!e.defaultPrevented) escaped.push('window: ' + (e.error && e.error.message));
});
check('compiler not requested', runtime.compilerRequested() === false);
check('builtin renders with its props', slot('builtin').querySelector('.builtin-ok')?.textContent === 'built');
check(
  'builtin reads a metric through the read API',
  slot('builtin').querySelector('.builtin-state')?.textContent.trim() === 'fresh 81.5',
  slot('builtin').textContent,
);
check(
  'a missing component shows its frame',
  alertText('missing').startsWith(S.fill(S.components.frameMissing, { name: 'My overview' })),
  alertText('missing'),
);
click(dismiss('missing'));
flushSync();
check('the missing frame dismisses in place', alertText('missing') === '');
first.remove();

console.log('B. user sources: each failure stays in its own frame');
const target = document.createElement('div');
document.body.appendChild(target);
globalThis.__renderBoom = true;
mount(Harness, { target, props: { withUser: true, sources: SOURCES, builtin: Builtin, reads } });
await settle();
check('compiler requested once a user source mounts', runtime.compilerRequested() === true);
check('probe outside the frames still renders', document.querySelector('#probe')?.textContent === 'surface still renders');
check('the healthy user component renders', slot('ok').querySelector('.ok-count')?.textContent === '0');
click(slot('ok').querySelector('.ok-inc'));
flushSync();
check('it reacts on the app runtime', slot('ok').querySelector('.ok-count')?.textContent === '1');
const okP = slot('ok').querySelector('.ok-count');
check('its scoped style applies', dom.window.getComputedStyle(okP).color === 'rgb(1, 2, 3)', dom.window.getComputedStyle(okP).color);
check('render error → frame', alertText('render') === failedCopy('render boom'), alertText('render'));
check('$effect error → frame', alertText('effect') === failedCopy('effect boom'), alertText('effect'));
check('builtin beside them still renders', slot('builtin').querySelector('.builtin-ok')?.textContent === 'built');
const syntax = alertText('syntax');
check('syntax error → frame with its line', syntax.startsWith(failedCopy(S.fill(S.components.sourceAtLine, { line: 2, err: '' }))), syntax);
const legacy = alertText('legacy');
check(
  'legacy syntax (export let) → frame with its line',
  legacy.startsWith(failedCopy(S.fill(S.components.sourceAtLine, { line: 2, err: '' }))) &&
    legacy.includes(S.fill(S.components.legacyRefused, { err: '' })),
  legacy,
);

console.log('C. event-handler and async errors are routed into the frame');
check('handler slot starts clean', alertText('handler') === '');
click(slot('handler').querySelector('.handler-btn'));
await settle();
check('unguarded handler error → frame banner', alertText('handler') === failedCopy('handler boom'), alertText('handler'));
check('the component keeps running under the banner', !!slot('handler').querySelector('.handler-alive'));
click(dismiss('handler'));
flushSync();
check('the banner dismisses, the component stays', alertText('handler') === '' && !!slot('handler').querySelector('.handler-btn'));
click(slot('async').querySelector('.async-btn'));
await settle();
check('guarded async error → frame banner', alertText('async') === failedCopy('async boom'), alertText('async'));
click(slot('read').querySelector('.read-btn'));
await settle();
check('a refused query → frame banner', alertText('read') === failedCopy('no such table: nope'), alertText('read'));
check('other frames untouched by these errors', alertText('ok') === '' && alertText('builtin') === '');

console.log('D. a render failure retries in place');
const retry = slot('render').querySelector(`[role="alert"] button:not([aria-label])`);
check('render frame offers Try again', retry?.textContent.trim() === S.components.frameRetry, retry?.textContent);
click(retry);
await settle();
check('Try again while still failing shows the frame again', alertText('render') === failedCopy('render boom'), alertText('render'));
globalThis.__renderBoom = false;
click(slot('render').querySelector(`[role="alert"] button:not([aria-label])`));
await settle();
check('Try again after the cause clears re-renders the component', alertText('render') === '' && !!slot('render').querySelector('.render-ok'), slot('render').innerHTML);

console.log('E. every frame dismisses in place');
for (const name of ['effect', 'syntax', 'legacy', 'async', 'read']) {
  click(dismiss(name));
  flushSync();
  check(`${name} frame dismissed`, alertText(name) === '');
}
check('the surface still renders after all of it', document.querySelector('#probe') && slot('ok').querySelector('.ok-count')?.textContent === '1');

check('nothing escaped a frame', escaped.length === 0, escaped.join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
