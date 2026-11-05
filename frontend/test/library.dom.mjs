// jsdom driver for the Library view's structured filters: the deep-link
// preset (#/library?map=&player=) seeds the facet inputs AND the first
// list fetch, typing re-arms the debounced fetch with the facets ANDed
// with each other and with the free-text query, and Clear filters resets
// both (returning the empty state to the plain "No matches yet" prompt).
// Backend semantics of the facets live in store.TestListMatches; this
// covers the view wiring only.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --test test/library.dom.mjs
// (must be run with frontend/ as the working directory)
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from './esm-dir-hook.mjs';

installEsmDirHook();

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

const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

// services.js runs against the shared TEST STUBS for its two runtime
// dependencies — same redirection as services-cache.test.js (hooks are
// per-process; this file runs in its own process under node --test).
// 'svelte' is pinned to the CLIENT entry: node's default condition
// resolves the server build (mount is unavailable there), which is why
// the sibling harnesses document `--conditions browser` — the redirect
// makes this file run its checks for real under plain `node --test` too.
const stub = (name) => pathToFileURL(join('test', 'stubs', name)).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte') {
      return { url: pathToFileURL('node_modules/svelte/src/index-client.js').href, shortCircuit: true };
    }
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const bindings = await import('./stubs/bindings.mjs');

// Methods Library calls at mount that the shared stub does not implement
// (it only scripts the cache tests' methods) — plain no-ops so the job /
// import-dir scans resolve without error slots.
bindings.LibraryService.ListJobs = () => Promise.resolve([]);
bindings.LibraryService.ListDemoFiles = () => Promise.resolve([]);

// Scripted match list: rows only for the `cache` facet, so the test can
// tell "the facet reached the backend" apart from "the backend returned
// rows" (the deep-link preset itself must find nothing yet).
const row = {
  id: 1,
  path: '/d/a.dem',
  map: 'de_mirage',
  size: 1048576,
  scoreCT: 13,
  scoreT: 9,
  ctName: 'Alpha',
  tName: 'Beta',
  realRounds: 22,
  durationS: 3600,
  extractedAt: '2026-01-01T00:00:00Z',
  status: 'ready',
  error: '',
};
bindings.handlers.ListMatches = (q, sk, d, f) => (f && f.map === 'cache' ? [row] : []);

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'library');
mkdirSync(dir, { recursive: true });

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};
const fileURL = (p) => pathToFileURL(p).href;

// Leaf components (no imports) → local bundles.
for (const [name, out] of [
  ['StatusChip', 'statuschip.js'],
  ['SortTh', 'sortth.js'],
  ['Dialog', 'dialog.js'],
]) {
  svelteCompile(
    readFileSync(`src/lib/components/${name}.svelte`, 'utf8'),
    `${name}.svelte`,
    join(dir, out),
  );
}

// ConfirmDialog imports Dialog → point at the local bundle.
const cdSrc = readFileSync('src/lib/components/ConfirmDialog.svelte', 'utf8').replace(
  "import Dialog from './Dialog.svelte';",
  "import Dialog from './dialog.js';",
);
svelteCompile(cdSrc, 'ConfirmDialog.svelte', join(dir, 'confirmdialog.js'));

// Library → its plain-ESM imports (services/fmt/teams) resolve from the
// real module locations; its components resolve from the local bundles.
const libSrc = readFileSync('src/lib/views/Library.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../teams.js'", `from '${fileURL('src/lib/teams.js')}'`)
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'")
  .replace("from '../components/SortTh.svelte'", "from './sortth.js'")
  .replace("from '../components/ConfirmDialog.svelte'", "from './confirmdialog.js'");
svelteCompile(libSrc, 'Library.svelte', join(dir, 'library-bundle.js'));

// Harness: the Library with the profile → library deep-link query.
const harnessSrc = `<script>
  import Library from './library-bundle.js';
  let { query = {} } = $props();
</script>
<Library nav={() => {}} {query} />
`;
writeFileSync(join(dir, 'harness.svelte'), harnessSrc);
svelteCompile(harnessSrc, 'harness.svelte', join(dir, 'harness.js'));

const { mount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'harness.js')).href);
const target = document.createElement('div');
document.body.appendChild(target);
const DEEP_LINK = { map: 'de_mirage', player: '76561198000000001' };
mount(mod.default, { target, props: { query: DEEP_LINK } });

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
await sleep(100); // mount + the immediate first list fetch

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const $ = (sel) => [...document.querySelectorAll(sel)];
const mapInput = () => document.getElementById('lib-filter-map');
const playerInput = () => document.getElementById('lib-filter-player');
const facetButtons = () => $('.lib-filters button');
const listCalls = () => bindings.calls.filter((c) => c.method === 'ListMatches');
const lastCall = () => listCalls()[listCalls().length - 1];
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};

console.log('A. deep-link preset seeds the facets and the first fetch');
check('map input preset', mapInput().value === 'de_mirage', mapInput().value);
check('player input preset', playerInput().value === '76561198000000001', playerInput().value);
check('map facet marked active', mapInput().classList.contains('active'));
check('player facet marked active', playerInput().classList.contains('active'));
check('clear button present', facetButtons().length === 1, String(facetButtons().length));
check('exactly one fetch on entry', listCalls().length === 1, String(listCalls().length));
{
  const first = listCalls()[0];
  const f = first && first.args[3];
  check(
    'first fetch carries the preset facets',
    f && f.map === 'de_mirage' && f.player === '76561198000000001',
    JSON.stringify(first && first.args),
  );
  check('free-text query untouched on entry', first && first.args[0] === '');
}
check(
  'filtered-empty message, not the import prompt',
  document.body.textContent.includes('No matches match') &&
    !document.body.textContent.includes('No matches yet'),
);
check(
  'message names both facets',
  document.body.textContent.includes('map “de_mirage”') &&
    document.body.textContent.includes('player “76561198000000001”'),
  document.querySelector('.dropzone .empty')?.textContent ?? '',
);

console.log('B. typing re-arms the debounced fetch (facets AND each other)');
type(mapInput(), 'cache');
await sleep(350); // past the 250 ms debounce
{
  const c = lastCall();
  const f = c && c.args[3];
  check('fetch fired with the new map facet', f && f.map === 'cache', JSON.stringify(c && c.args));
  check('player facet preserved', f && f.player === '76561198000000001');
  check('scripted rows render', $('tbody tr').length === 1, String($('tbody tr').length));
}
{
  const search = $('[aria-label="Search matches"]')[0];
  type(search, 'alpha');
  await sleep(350);
  const c = lastCall();
  const f = c && c.args[3];
  check('free-text query rides along', c && c.args[0] === 'alpha', JSON.stringify(c && c.args));
  check('facets preserved beside the query', f && f.map === 'cache' && f.player === '76561198000000001');
}

console.log('C. Clear filters resets both facets');
click(facetButtons()[0]);
await sleep(350);
check('map input cleared', mapInput().value === '');
check('player input cleared', playerInput().value === '');
check('clear button gone', facetButtons().length === 0, String(facetButtons().length));
{
  const c = lastCall();
  const f = c && c.args[3];
  check(
    'refetch with both facets off (query still active)',
    c && c.args[0] === 'alpha' && f && f.map === '' && f.player === '',
    JSON.stringify(c && c.args),
  );
}
{
  const search = $('[aria-label="Search matches"]')[0];
  type(search, '');
  await sleep(350);
  const c = lastCall();
  const f = c && c.args[3];
  check(
    'last fetch fully unconstrained',
    c && c.args[0] === '' && f && f.map === '' && f.player === '',
    JSON.stringify(c && c.args),
  );
  check('back to the plain import prompt', document.body.textContent.includes('No matches yet'));
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
