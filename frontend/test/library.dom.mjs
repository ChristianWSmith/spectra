// jsdom driver for the Library view's search controls: the deep-link
// preset (#/library?map=&player=) seeds the facet inputs AND the first
// list fetch, typing re-arms the debounced fetch with the two facets
// ANDed with each other (the free-text box is GONE — its service/binding
// parameter stays and every fetch passes ''), the suggestion dropdowns are
// fed from the library itself (distinct maps / the profile list) with
// click- and keyboard-selection applying the facet, and Clear filters
// resets both (returning the empty state to the plain "No matches yet"
// prompt).
// Section E covers row navigation: a ready row opens /match/:id on click
// and Enter, while a still-parsing row does neither (no click cursor, no
// focus stop) and renders the never-extracted placeholder date — and its
// Reprocess/Delete buttons are disabled with an "available once parsing
// finishes" hint (the ready row's are live). Section D also pins the
// empty state's copy: no import button of its own, the header owns it.
// Backend semantics of the facets live in store.TestListMatches; the
// suggestion source is store.TestListMapNames; this covers the view
// wiring only.
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
// import-dir scans resolve without error slots, plus the two suggestion
// sources the search inputs are fed from.
bindings.LibraryService.ListJobs = () => Promise.resolve([]);
bindings.LibraryService.ListDemoFiles = () => Promise.resolve([]);
bindings.LibraryService.ListMapNames = () =>
  Promise.resolve(['de_ancient', 'de_cache', 'de_mirage']);
bindings.ProfileService.ListPlayers = () =>
  Promise.resolve([
    { steamId: '76561198000000001', name: 'alice', matches: 3, adrAvg: 71.25, lastSeen: '2026-01-02' },
    { steamId: '76561198000000002', name: 'bob', matches: 1, adrAvg: 55.5, lastSeen: '2026-01-01' },
    // A BOT in the source list (the pre-rule shape): the canonical
    // client-side filter (lib/players.js listedPlayers) must drop it —
    // the checks below pin that neither the suggestion list nor a typed
    // bot query ever surfaces it.
    { steamId: '18374686479671623692', name: 'Crew', matches: 1, adrAvg: 40, lastSeen: '2026-01-03' },
  ]);

// Scripted match list: rows only for the `cache` facet (the deep-link
// preset itself must find nothing yet), plus a `parsing` facet that
// returns a still-parsing row — the not-yet-extracted case (NULL
// extracted_at arrives as the Go zero time "0001-01-01T00:00:00Z") the
// view must neither date nor navigate.
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
const parsingRow = {
  id: 2,
  path: '/d/b.dem',
  map: 'de_dust2',
  size: 2097152,
  scoreCT: 0,
  scoreT: 0,
  ctName: 'Gamma',
  tName: 'Delta',
  realRounds: 0,
  durationS: 0,
  extractedAt: '0001-01-01T00:00:00Z', // NULL extracted_at → Go zero time
  status: 'parsing',
  error: '',
};
bindings.handlers.ListMatches = (q, sk, d, f) =>
  f && f.map === 'cache' ? [row] : f && f.map === 'parsing' ? [parsingRow] : [];

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
  ['Popover', 'popover.js'],
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

// SuggestInput (the shared suggestion dropdown) imports Popover and the
// plain-ESM fmt helper → local bundle + absolute module URL.
const siSrc = readFileSync('src/lib/components/SuggestInput.svelte', 'utf8')
  .replace("from './Popover.svelte'", "from './popover.js'")
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`);
svelteCompile(siSrc, 'SuggestInput.svelte', join(dir, 'suggestinput.js'));

// Library → its plain-ESM imports (services/fmt/teams) resolve from the
// real module locations; its components resolve from the local bundles.
const libSrc = readFileSync('src/lib/views/Library.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../teams.js'", `from '${fileURL('src/lib/teams.js')}'`)
  .replace("from '../players.js'", `from '${fileURL('src/lib/players.js')}'`)
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'")
  .replace("from '../components/SortTh.svelte'", "from './sortth.js'")
  .replace("from '../components/ConfirmDialog.svelte'", "from './confirmdialog.js'")
  .replace("from '../components/SuggestInput.svelte'", "from './suggestinput.js'");
svelteCompile(libSrc, 'Library.svelte', join(dir, 'library-bundle.js'));

// Harness: the Library with the profile → library deep-link query. nav
// records every target on globalThis.__nav so the checks below can tell
// "the row navigated" from "the row did nothing".
const harnessSrc = `<script>
  import Library from './library-bundle.js';
  let { query = {} } = $props();
</script>
<Library nav={(p) => (globalThis.__nav = [...(globalThis.__nav || []), p])} {query} />
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
// The Clear-filters button only — the suggestion rows are <button>s too
// (they live in .sg-opt inside the SuggestInput widget).
const clearBtn = () => $('.lib-filters .btn');
const sgRows = (listId) => $(`#${listId} .sg-opt`);
const listCalls = () => bindings.calls.filter((c) => c.method === 'ListMatches');
const lastCall = () => listCalls()[listCalls().length - 1];
const navCalls = () => globalThis.__nav || [];
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const focus = (el) => el.dispatchEvent(new dom.window.FocusEvent('focus', { bubbles: false }));
const enter = (el) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const key = (el, k) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};

console.log('A. deep-link preset seeds the facets and the first fetch');
check('map input preset', mapInput().value === 'de_mirage', mapInput().value);
check('player input preset', playerInput().value === '76561198000000001', playerInput().value);
check('map facet marked active', mapInput().classList.contains('active'));
check('player facet marked active', playerInput().classList.contains('active'));
check('clear button present', clearBtn().length === 1, String(clearBtn().length));
// Placement: the two facets are the Library's ONLY search and they live
// where the free-text box used to be — in the header row, next to
// Import… — with the old facet row under the header gone.
{
  const header = document.querySelector('.view-header');
  check(
    'MAP/PLAYER inputs sit in the header row',
    !!header &&
      header.contains(mapInput()) &&
      header.contains(playerInput()) &&
      header.contains(clearBtn()[0]),
  );
  check(
    'no search controls outside the header (old facet row gone)',
    !document.querySelector('.view > .lib-filters') &&
      $('.view input[type="search"]').length === 2,
    String($('.view input[type="search"]').length),
  );
  check(
    'free-text search input removed',
    !document.querySelector('[aria-label="Search matches"]'),
  );
}
check('exactly one fetch on entry', listCalls().length === 1, String(listCalls().length));
{
  const first = listCalls()[0];
  const f = first && first.args[3];
  check(
    'first fetch carries the preset facets',
    f && f.map === 'de_mirage' && f.player === '76561198000000001',
    JSON.stringify(first && first.args),
  );
  // The free-text parameter stays in the binding/API — the view just
  // never has anything to put in it anymore.
  check('free-text query stays empty', first && first.args[0] === '');
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
  // An extracted (ready) row stays the openable kind: pointer cursor +
  // focus stop + navigation on click AND on Enter.
  {
    const tr = $('tbody tr')[0];
    check(
      'ready row is openable (clickable + focus stop)',
      tr.classList.contains('clickable') && tr.getAttribute('tabindex') === '0',
      tr.outerHTML.slice(0, 120),
    );
    const before = navCalls().length;
    click(tr);
    check(
      'ready row click navigates to its match view',
      navCalls().length === before + 1 && navCalls().at(-1) === '/match/1',
      JSON.stringify(navCalls()),
    );
    enter(tr);
    check(
      'ready row Enter navigates',
      navCalls().length === before + 2 && navCalls().at(-1) === '/match/1',
      JSON.stringify(navCalls()),
    );
    // Enter pressed on a row BUTTON bubbles its keydown up to the <tr> —
    // it must not navigate the row out from under the button.
    const beforeBtn = navCalls().length;
    enter(tr.querySelector('.row-actions button'));
    check(
      'Enter on a row button does not navigate the row',
      navCalls().length === beforeBtn,
      JSON.stringify(navCalls()),
    );
    // A ready row's Reprocess/Delete are live (they only lock while the
    // row is parsing/queued — see the isOpenable comment).
    const readyBtns = [...tr.querySelectorAll('.row-actions button')];
    check(
      'ready row action buttons enabled with their own titles',
      readyBtns.length === 2 &&
        readyBtns.every((b) => !b.disabled) &&
        readyBtns.some((b) => b.title.includes('Re-parse')) &&
        readyBtns.some((b) => b.title.includes('Delete extracted')),
      JSON.stringify(readyBtns.map((b) => [b.textContent.trim(), b.disabled, b.title])),
    );
  }
}
{
  // The free-text box is gone: there is nothing left to type a query
  // into, every fetch keeps sending '' and the facets ride along.
  check(
    'no free-text input to type into',
    !$('[aria-label="Search matches"]').length,
    String($('[aria-label="Search matches"]').length),
  );
  const c = lastCall();
  const f = c && c.args[3];
  check('free-text query stays empty', c && c.args[0] === '', JSON.stringify(c && c.args));
  check(
    'both facets ride along',
    f && f.map === 'cache' && f.player === '76561198000000001',
    JSON.stringify(f),
  );
}

console.log('C. suggestions come from the library and apply the facet');

// Map facet: opening the panel (here on focus) offers the distinct maps
// in the library, narrowed by whatever is already in the box.
focus(mapInput());
await sleep(20);
{
  check('map panel opens on focus', !!document.getElementById('lib-filter-map-list'));
  const rows = sgRows('lib-filter-map-list');
  check(
    'map suggestions are the library maps matching the box',
    rows.length === 1 && rows[0].textContent.includes('de_cache'),
    JSON.stringify(rows.map((r) => r.textContent.trim())),
  );
}

// Empty box → every library map the backend reported (capped at 10).
type(mapInput(), '');
await sleep(350); // past the 250 ms debounce — the map facet is off again
{
  const rows = sgRows('lib-filter-map-list');
  check(
    'empty box lists the library maps',
    rows.length === 3 &&
      rows.map((r) => r.textContent.trim()).join(',') === 'de_ancient,de_cache,de_mirage',
    JSON.stringify(rows.map((r) => r.textContent.trim())),
  );
}

// Picking a row applies it as the facet (the exact name) and closes the
// panel — an unmatched value would simply stay a substring filter. The
// pick targets a map the list has never been fetched for (the preset's
// de_mirage is already in the read cache), so the refetch below is a
// real call, not a cache hit.
{
  const rows = sgRows('lib-filter-map-list');
  const ancient = rows.find((r) => r.textContent.includes('de_ancient'));
  click(ancient);
  await sleep(350);
  check('picked map applies the facet', mapInput().value === 'de_ancient', mapInput().value);
  check(
    'map panel dismissed after the pick',
    !document.getElementById('lib-filter-map-list'),
  );
  const c = lastCall();
  const f = c && c.args[3];
  check(
    'refetch carries the picked map',
    f && f.map === 'de_ancient' && f.player === '76561198000000001',
    JSON.stringify(c && c.args),
  );
}

// Player facet: the same widget, fed by the profile list — the SAME
// library-wide read (listPlayers('')) the Profiles view and the profile
// finder use.
type(playerInput(), 'bob');
await sleep(20);
{
  const rows = sgRows('lib-filter-player-list');
  check(
    'player suggestion shows the matching player',
    rows.length === 1 && rows[0].textContent.includes('bob'),
    JSON.stringify(rows.map((r) => r.textContent.trim())),
  );
  check(
    'player row carries the profile summary (matches + ADR)',
    rows[0].textContent.includes('1 match') && rows[0].textContent.includes('ADR 55.5'),
    rows[0].textContent.trim(),
  );
}

// The bot row in the source list never reaches the widget: neither the
// full list nor a query that matches only the bot may show it.
type(playerInput(), 'Crew');
await sleep(20);
{
  const rows = sgRows('lib-filter-player-list');
  check(
    'a bot is never a library player suggestion',
    rows.length === 0,
    JSON.stringify(rows.map((r) => r.textContent.trim())),
  );
}

// Keyboard: ↑↓ move the highlight, Enter picks the highlighted row.
type(playerInput(), '');
await sleep(20);
{
  const rows = sgRows('lib-filter-player-list');
  check(
    'empty box lists the library players',
    rows.length === 2,
    JSON.stringify(rows.map((r) => r.textContent.trim())),
  );
  key(playerInput(), 'ArrowDown');
  await sleep(20); // let the derived aria state flush to the DOM
  check(
    'ArrowDown highlights the second row',
    playerInput().getAttribute('aria-activedescendant') === 'lib-filter-player-list-opt-1',
    String(playerInput().getAttribute('aria-activedescendant')),
  );
  enter(playerInput());
  await sleep(350);
  check(
    'Enter applies the highlighted player',
    playerInput().value === '76561198000000002',
    playerInput().value,
  );
  check(
    'player panel dismissed after Enter',
    !document.getElementById('lib-filter-player-list'),
  );
  const c = lastCall();
  const f = c && c.args[3];
  check(
    'refetch carries the picked player',
    f && f.player === '76561198000000002',
    JSON.stringify(c && c.args),
  );
}

// Escape dismisses the panel without touching what was typed.
type(playerInput(), 'ali');
await sleep(20);
check('panel open before Escape', !!document.getElementById('lib-filter-player-list'));
key(playerInput(), 'Escape');
await sleep(20);
check('Escape dismisses the panel', !document.getElementById('lib-filter-player-list'));
check('Escape leaves the typed facet alone', playerInput().value === 'ali', playerInput().value);

console.log('D. Clear filters resets both facets');
click(clearBtn()[0]);
await sleep(350);
check('map input cleared', mapInput().value === '');
check('player input cleared', playerInput().value === '');
check('clear button gone', clearBtn().length === 0, String(clearBtn().length));
{
  const c = lastCall();
  const f = c && c.args[3];
  check(
    'refetch with both facets off (free-text still empty)',
    c && c.args[0] === '' && f && f.map === '' && f.player === '',
    JSON.stringify(c && c.args),
  );
  check('back to the plain import prompt', document.body.textContent.includes('No matches yet'));
  // The empty state carries NO import button of its own — the header
  // (top-left) owns the view's single Import… action and the copy points
  // at it ("with the button above").
  check(
    'empty state has no import button (header owns it)',
    $('.dropzone .empty .btn').length === 0,
    ($('.dropzone .empty')[0]?.innerHTML || 'no .empty').slice(0, 200),
  );
  check(
    'header Import… still present',
    [...document.querySelectorAll('.view-header .btn')].some(
      (b) => b.textContent.trim() === 'Import…',
    ),
  );
}

console.log('E. a parsing row: honest placeholder date, no navigation');
type(mapInput(), 'parsing');
await sleep(350); // past the 250 ms debounce
{
  const rows = $('tbody tr');
  check('one parsing row renders', rows.length === 1, String(rows.length));
  const tr = rows[0];
  const cells = [...tr.children].map((td) => td.textContent.trim());
  check(
    'EXTRACTED cell shows the placeholder, not a year-0001 date',
    cells[6] === '—',
    JSON.stringify(cells[6]),
  );
  check('row carries no pointer affordance', !tr.classList.contains('clickable'));
  check(
    'row is not a keyboard focus stop',
    !tr.hasAttribute('tabindex'),
    String(tr.getAttribute('tabindex')),
  );
  const before = navCalls().length;
  click(tr);
  check('parsing row click does not navigate', navCalls().length === before, JSON.stringify(navCalls()));
  enter(tr);
  check('parsing row Enter does not navigate', navCalls().length === before, JSON.stringify(navCalls()));
  const chip = tr.querySelector('.chip.status');
  check(
    'status chip still renders on the row',
    !!chip && chip.textContent.includes('parsing'),
    chip ? chip.textContent.trim() : 'missing',
  );
  check(
    'row action buttons still present',
    tr.querySelectorAll('.row-actions button').length === 2,
    String(tr.querySelectorAll('.row-actions button').length),
  );
  // …but disabled while the row is parsing/queued, with a title hint that
  // says when they come back.
  const actBtns = [...tr.querySelectorAll('.row-actions button')];
  check(
    'parsing row action buttons disabled with the hint title',
    actBtns.length === 2 &&
      actBtns.every((b) => b.disabled) &&
      actBtns.every((b) => b.title === 'Available once parsing finishes'),
    JSON.stringify(actBtns.map((b) => [b.textContent.trim(), b.disabled, b.title])),
  );
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
