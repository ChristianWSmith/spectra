// jsdom driver for the SQL console's header help button (help-buttons
// wave, 2026-11-15). The console is the ONE view header with no other
// driver of its own — it never holds a loading window (its loading
// lines are source-pinned in progress-presentation.dom.mjs) and its
// query engine is pinned in Go (session_test.go / query_store_test.go)
// — so the shared HelpButton's mount coverage lives here: the `?` is
// the header's LAST element, right of the .spacer (and the running chip
// while a query is in flight), and clicking it hands App's openDocs the
// `sql-console` section id — the guide section docslockstep.test.js
// pins for this view.
//
// The console's three mount-time reads (schema, history, saved queries)
// are scripted so the header renders clean; no query is ever run here.
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it (never `npm i --no-save`, which makes the next
// `npm ci` prune it). From frontend/ run:
//   node --test test/sqlconsole.dom.mjs
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
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLMediaElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver',
  'DOMParser', 'localStorage', 'location',
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

// services.js links the generated bindings (its imports are the app's,
// so the same redirections every view driver uses apply here) and 'svelte'
// must resolve to the CLIENT entry — node's default condition picks the
// server build, where mount() is unavailable.
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
// The console's three mount-time reads, scripted so the mount renders
// clean (an unscripted QueryService method is a TypeError the view would
// surface as an error banner — honest, but noise for these pins).
bindings.QueryService.GetSchema = () =>
  Promise.resolve([{ name: 'matches', note: 'one row per imported demo', columns: [{ name: 'id' }] }]);
bindings.QueryService.ListHistory = () => Promise.resolve([]);
bindings.QueryService.ListSavedQueriesPage = () => Promise.resolve({ rows: [], hasNext: false });

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'sqlconsole');
mkdirSync(dir, { recursive: true });
const fileURL = (p) => pathToFileURL(p).href;
const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// StatusChip is a leaf → local bundle.
svelteCompile(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  join(dir, 'statuschip.js'),
);
// HelpButton — the shared header `?` (the one canonical idiom): its
// strings catalog resolves from the real tree like every other ../ module.
svelteCompile(
  readFileSync('src/lib/components/HelpButton.svelte', 'utf8').replace(
    "from '../strings/index.js'",
    `from '${fileURL('src/lib/strings/index.js')}'`,
  ),
  'HelpButton.svelte',
  join(dir, 'helpbutton.js'),
);

// The view: plain-ESM imports resolve from their real module locations,
// the component imports from the local bundles.
let sqlSrc = readFileSync('src/lib/views/SqlConsole.svelte', 'utf8');
for (const rel of ['services.js', 'download.js', 'csv.js', 'viewstate.svelte.js', 'strings/index.js']) {
  sqlSrc = sqlSrc.split(`from '../${rel}'`).join(`from '${fileURL(`src/lib/${rel}`)}'`);
}
sqlSrc = sqlSrc.split("from '../components/StatusChip.svelte'").join("from './statuschip.js'");
sqlSrc = sqlSrc.split("from '../components/HelpButton.svelte'").join("from './helpbutton.js'");
svelteCompile(sqlSrc, 'SqlConsole.svelte', join(dir, 'sqlconsole-bundle.js'));

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'sqlconsole-bundle.js')).href);
const target = document.createElement('div');
document.body.appendChild(target);
const inst = mount(mod.default, {
  target,
  props: { openDocs: (s) => (globalThis.__docs = [...(globalThis.__docs || []), s]) },
});

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
await sleep(120); // mount + the schema/history/saved reads

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

console.log('A. the header `?` renders as the header’s last element (help-buttons)');
const hdr = document.querySelector('.view-header');
const help = hdr?.querySelector(':scope > button[aria-label="Help for this view"]');
check(
  'the ? is the header’s LAST element, right of the .spacer, with the shared labels + question glyph',
  !!help && !!hdr && hdr.lastElementChild === help &&
    !!hdr.querySelector(':scope > .spacer') &&
    help.getAttribute('title') === 'Help for this view' &&
    help.classList.contains('btn') && !!help.querySelector('.codicon-question'),
  hdr ? [...hdr.children].map((c) => c.className || c.tagName).join(' | ') : 'no header',
);
check(
  'the header keeps its own notes (defaults · read-only) and the view stays mounted',
  !!document.querySelector('.view.sql-view') &&
    /rows cap/.test(document.querySelector('.sql-head-note')?.textContent || ''),
  document.querySelector('.sql-head-note')?.textContent || 'no head note',
);

console.log('B. clicking it hands openDocs the sql-console section (no navigation)');
const docs0 = (globalThis.__docs || []).length;
const hash0 = location.hash;
click(help);
await sleep();
check(
  'openDocs fired exactly once with the sql-console section id',
  (globalThis.__docs || []).length === docs0 + 1 && (globalThis.__docs || []).at(-1) === 'sql-console',
  JSON.stringify((globalThis.__docs || []).slice(docs0)),
);
check('the route did not move (the console stays put behind the sheet)', location.hash === hash0, location.hash);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
