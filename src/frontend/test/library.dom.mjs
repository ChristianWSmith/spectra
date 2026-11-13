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
// focus stop) and presents like the synthetic queued row — the
// never-extracted gate (fmt.js neverExtracted, i.e. the extracted_at
// stamp): the demo's file name in Matchup on the lib-demo-name cap, "—"
// for the W/L score, rounds and duration cells (Size keeps its real
// value), the placeholder date, and — with no job in the jobs snapshot —
// ZERO action buttons (the disabled Re-parse/Delete pair is gone; the
// ready row's pair stays live). Section D also pins the empty state's
// copy: no import button of its own, the header owns it.
// Section F covers the queue's visible half: synthetic import rows for
// jobs with no match row yet (chip + determinate bar + Remove), a match
// row owned by a queued reprocess (queued chip + Remove — one control;
// this fixture is never-extracted) and by a running parse (Cancel only +
// "reading demo 42%" determinate bar), the never-extracted FAILED row
// (— cells, Re-parse/Delete live again — the cancel-then-retry
// presentation), a REPROCESS mid-parse (old values kept + the 3-button
// set — the anti-regression pin for the extracted_at gate), the
// import-dir row flipping to the live job with Import swapped for
// Remove, and the multi-path ImportDialog hand-off (N paths → ONE
// ImportPaths call).
// Section G mounts StatusChip directly: progress 0 is indeterminate
// (moving bar, never "0%"), 0.42 renders "reading demo 42%".
// Section H covers the keyset "Load more" pagination: the first window
// renders (PAGE_SIZE rows), the Load-more footer only shows while the
// backend reports a next window, clicking appends the next window with
// the last row's id as the cursor (and drops the button when the list is
// exhausted), and the matchup fallback for nameless rows arrives on the
// page's `rosters` — the list load never fans out into per-row
// GetScoreboard calls (the N+1 this pagination replaces).
// Section I covers the demo-copy actions: a row whose fs-derived
// copyState says "copied" renders the third "Free copy" action (behind
// the one ConfirmDialog), a copy-less row keeps exactly the two controls
// (the same render gate that keeps the parsing/queued action-count pins
// valid), and the delete flow's "Also delete the demo file?" second
// confirm is asked ONLY when a managed copy exists. Backend semantics of
// copyState live in internal/library.CopyState +
// LibraryService.ListMatchesPage/EvictDemoCopy — this covers the wiring.
// Section J pins the reserved-width columns (the parse-jitter fix): every
// volatile column carries its reservation class in the markup (status in
// both library tables, the synthetic job row's demo name) and
// public/style.css carries the matching min-width declarations. jsdom has
// no layout, so the RULE'S APPLICATION is what is pinned — never pixel
// widths (those are sized in the style.css comments).
// Section K pins the view-state registry (lib/viewstate.svelte.js): a
// mutated sort RESTORES across an unmount → remount, the URL-owned
// facet input does NOT (the registry never carries route-query state —
// URL wins), and resetViewState() returns the next mount to defaults.
// This suite shares ONE registry instance across sections (the jsdom
// cross-talk rule in the module header), so K resets in setup.
//
// Backend semantics of the facets live in store.TestListMatches (the
// keyset itself in store.TestListMatchesPage*); the
// suggestion source is store.TestListMapNames; the pipeline behind the
// chips lives in internal/library's queue tests — this covers the view
// wiring only.
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it (never `npm i --no-save`, which makes the next
// `npm ci` prune it). From frontend/ run:
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

// pageOf mimics the store's keyset window over a scripted row array:
// start AFTER the cursor row (afterID), take one window, report whether
// anything follows. (The real cursor resolves the last row's stored sort
// value — store.ListMatchesPage — the stub only has to reproduce the
// slicing/hasNext contract the view consumes.)
const pageOf = (rows, afterID, limit) => {
  const start = afterID ? rows.findIndex((r) => r.id === afterID) + 1 : 0;
  const win = rows.slice(start, start + (limit || 200));
  const rosters = {};
  for (const r of win) {
    if (!r.ctName || !r.tName) {
      // A row whose extract recorded no clan name: the page carries the
      // roster the Matchup cell synthesizes team_<player> names from.
      rosters[r.id] = [
        { steamId: '76561198000000011', name: 'alice', side: 'ct', isBot: false },
        { steamId: '76561198000000022', name: 'bob', side: 't', isBot: false },
      ];
    }
  }
  return { rows: win, hasNext: start + win.length < rows.length, rosters };
};

// Scripted match list: rows only for the `cache` facet (the deep-link
// preset itself must find nothing yet), plus a `parsing` facet that
// returns a still-parsing row — the not-yet-extracted case (NULL
// extracted_at arrives as the Go zero time "0001-01-01T00:00:00Z") the
// view must neither date nor navigate — and, per the owner's queued-row
// ruling, must present like the synthetic queued row (file name in
// Matchup, "—" cells, no buttons while no job owns it).
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
  // Clan names a REAL fresh row never has (CreateMatchRow stores only
  // path/sha/size/status) — they never reach the cell: the
  // never-extracted gate shows the file name instead.
  ctName: 'Gamma',
  tName: 'Delta',
  realRounds: 0,
  durationS: 0,
  extractedAt: '0001-01-01T00:00:00Z', // NULL extracted_at → Go zero time
  status: 'parsing',
  error: '',
};
// rowsForFacet is the scripted list per facet; Section H swaps it for a
// 201-row library (two rows without recorded team names).
let rowsForFacet = (f) =>
  f && f.map === 'cache' ? [row] : f && f.map === 'parsing' ? [parsingRow] : [];
bindings.handlers.ListMatchesPage = (q, sk, d, after, limit, f) =>
  pageOf(rowsForFacet(f), after, limit);

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
// viewstate.svelte.js is rewritten to the SAME absolute URL the pins
// below import, so the view and the test share one registry instance
// (the jsdom cross-talk rule in that module's header).
const libSrc = readFileSync('src/lib/views/Library.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../teams.js'", `from '${fileURL('src/lib/teams.js')}'`)
  .replace("from '../players.js'", `from '${fileURL('src/lib/players.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
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

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'harness.js')).href);
// The registry the view imports (same URL → same instance — section K
// drives it directly; its header documents the per-suite cross-talk rule).
const viewstate = await import(pathToFileURL('src/lib/viewstate.svelte.js').href);
// The same services module the view links (cache flushing — see K).
const services = await import(pathToFileURL('src/lib/services.js').href);
const target = document.createElement('div');
document.body.appendChild(target);
const DEEP_LINK = { map: 'de_mirage', player: '76561198000000001' };
let libInst = mount(mod.default, { target, props: { query: DEEP_LINK } });

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
const pageCalls = () => bindings.calls.filter((c) => c.method === 'ListMatchesPage');
const lastCall = () => pageCalls()[pageCalls().length - 1];
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
// The standard player-search hint (owner ruling): the player facet wears
// the SAME byte string as Profiles' box — mounted here, in
// profiles.dom.mjs A for the directory search, by source in
// player-search-hint.dom.mjs for the PlayerProfile finder (no harness
// mounts that view). The map facet keeps its own non-player hint.
check(
  'player facet wears the standard hint (Search players...)',
  playerInput().placeholder === 'Search players...',
  playerInput().placeholder,
);
check('map facet keeps its own hint', mapInput().placeholder === 'e.g. de_mirage', mapInput().placeholder);
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
check('exactly one fetch on entry', pageCalls().length === 1, String(pageCalls().length));
{
  const first = pageCalls()[0];
  const f = first && first.args[5];
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
  const f = c && c.args[5];
  check('fetch fired with the new map facet', f && f.map === 'cache', JSON.stringify(c && c.args));
  check('player facet preserved', f && f.player === '76561198000000001');
  check('scripted rows render', $('tbody tr').length === 1, String($('tbody tr').length));
  // RE-PIN (owner ruling — a composite "13–9" scoreline has no
  // meaningful single sort order): the one Score column is TWO columns,
  // W Score = max(scoreCT, scoreT), L Score = min(), each with its own
  // store sort key (winner_score / loser_score). Header old → new:
  // "Score" → "W Score" + "L Score". Cell old → new: "13–9" (CT-blue 13,
  // T-orange 9) → "13" in the WINNER's side colour (CT took this match —
  // colour = the side at match end, which is what the final score is) +
  // a neutral "9" (the loser's side colour says nothing new here).
  {
    const heads = [...document.querySelectorAll('.dropzone .data-table thead th')].map(
      (th) => th.textContent.trim(),
    );
    check(
      'RE-PIN: Score header split into W Score + L Score (exact "Score" gone)',
      heads.includes('W Score') && heads.includes('L Score') && !heads.includes('Score'),
      JSON.stringify(heads),
    );
    const scoreTr = $('tbody tr')[0];
    const scoreCells = [...scoreTr.children].map((td) => td.textContent.trim());
    const wSpan = scoreTr.children[2].querySelector('span');
    check(
      'RE-PIN: cell 13–9 → W 13 (winner side colour) + L 9 (neutral)',
      scoreCells[2] === '13' &&
        scoreCells[3] === '9' &&
        !!wSpan &&
        wSpan.classList.contains('ct') &&
        !wSpan.classList.contains('t') &&
        !scoreTr.children[3].querySelector('.ct, .t'),
      `${JSON.stringify(scoreCells)} / w=${wSpan && wSpan.className} / l=${scoreTr.children[3].innerHTML}`,
    );
  }
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
        readyBtns.some((b) => b.title.includes('Delete this match')),
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
  const f = c && c.args[5];
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
  const f = c && c.args[5];
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
  const f = c && c.args[5];
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
  const f = c && c.args[5];
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

console.log('E. a parsing row: never-extracted presentation, honest date, no navigation');
type(mapInput(), 'parsing');
await sleep(350); // past the 250 ms debounce
{
  const rows = $('tbody tr');
  check('one parsing row renders', rows.length === 1, String(rows.length));
  const tr = rows[0];
  const cells = [...tr.children].map((td) => td.textContent.trim());
  check(
    'EXTRACTED cell shows the placeholder, not a year-0001 date',
    cells[7] === '—',
    JSON.stringify(cells[7]),
  );
  // The owner's queued-row look, gated on the extracted_at stamp (never
  // the status): the demo's file name takes the Matchup cell and the
  // W/L score, rounds and duration cells read "—" instead of 0–0/0/0s
  // (the split score column shows "—" in BOTH halves). Size KEEPS its
  // real value — it is known, and hiding real data to mirror the
  // synthetic row's "—" would be a downgrade ("basically the same").
  check(
    'never-extracted cells: file name in Matchup, — W score/L score/rounds/duration, size kept',
    cells[1] === 'b.dem' &&
      cells[2] === '—' &&
      cells[3] === '—' &&
      cells[4] === '—' &&
      cells[5] === '—' &&
      cells[6] === '2.0 MB',
    JSON.stringify(cells),
  );
  const nameEl = tr.children[1].querySelector('span');
  check(
    'match-row demo name rides the lib-demo-name cap with the full-path title',
    !!nameEl &&
      nameEl.classList.contains('lib-demo-name') &&
      nameEl.getAttribute('title') === '/d/b.dem' &&
      nameEl.textContent.trim() === 'b.dem',
    tr.children[1].innerHTML.slice(0, 160),
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
  // RE-PIN (deliberate behavior change, owner ruling): a never-extracted
  // parsing row with NO job in the jobs snapshot renders ZERO action
  // buttons — the disabled Re-parse/Delete pair it used to show is gone
  // (their disablement was the complaint), and a row no job owns is not
  // actionable, so no fallback control is invented. The live pair stays
  // on ready rows (section B) and failed rows (section F).
  check(
    'no job known → ZERO action buttons (RE-PIN: was 2 disabled)',
    tr.querySelectorAll('.row-actions button').length === 0,
    [...tr.querySelectorAll('.row-actions button')]
      .map((b) => b.textContent.trim())
      .join(',') || 'none',
  );
}

// ---------------------------------------------------------------------------
// Section F: the queue made visible. The handlers below replace the
// mount-time stubs; spectra:library-changed re-runs the view's refetches
// (jobs + match list + import-dir scan) exactly like the backend would.
console.log('F. queued state: synthetic rows, cancel controls, dir flip, multi-path import');

const queuedMatch = {
  id: 3,
  path: '/d/queued.dem',
  map: 'de_inferno',
  size: 4096,
  scoreCT: 0,
  scoreT: 0,
  ctName: 'Queued',
  tName: 'Side',
  realRounds: 0,
  durationS: 0,
  // Never extracted — the fixture's reprocess job carries no prior data
  // (a hybrid: kind 'reprocess', zero stamp), so the extracted_at gate
  // gives it the one-control presentation (see the re-pin below).
  extractedAt: '0001-01-01T00:00:00Z',
  status: 'queued',
  error: '',
};
// Import job with NO match row yet (still hashing/queued) → synthetic row
// + the import-dir flip (same path string the dir row lists).
const pendingImportJob = {
  id: 11,
  kind: 'import',
  path: '/imports/new.dem',
  status: 'queued',
  progress: 0,
  stage: 'queued',
  error: '',
  matchId: 0,
  createdAt: '2026-01-05T00:00:01Z',
  startedAt: null,
  finishedAt: null,
};
// Queued reprocess → its match row flipped to queued (visible wait).
const queuedReprocessJob = {
  id: 12,
  kind: 'reprocess',
  path: '/d/queued.dem',
  status: 'queued',
  progress: 0,
  stage: 'queued',
  error: '',
  matchId: 3,
  createdAt: '2026-01-05T00:00:00Z',
  startedAt: null,
  finishedAt: null,
};
// Running parse of the section-E parsing row (id 2): determinate bar.
const runningImportJob = {
  id: 13,
  kind: 'import',
  path: '/d/b.dem',
  status: 'running',
  progress: 0.42,
  stage: 'parse',
  error: '',
  matchId: 2,
  createdAt: '2026-01-05T00:00:02Z',
  startedAt: '2026-01-05T00:00:03Z',
  finishedAt: null,
};
// A pure dequeue: cancelled before it ever started (no startedAt) — its
// synthetic row is gone and it must NOT surface in "Recent import
// problems" (nothing was interrupted; the user removed it).
const dequeuedJob = {
  id: 14,
  kind: 'import',
  path: '/imports/gone.dem',
  status: 'cancelled',
  progress: 0,
  stage: 'queued',
  error: '',
  matchId: 0,
  createdAt: '2026-01-05T00:00:03Z',
  startedAt: null,
  finishedAt: '2026-01-05T00:00:04Z',
};
// A running REPROCESS of match 6 (never-extracted fixture rows are
// covered above; this one owns the reprocess-with-prior-data row the two
// new blocks below render). Inert for every earlier pin: it is not an
// import job (no synthetic row), not failed/cancelled (no problems row),
// and no earlier facet returns match id 6.
const reprocessRunningJob = {
  id: 15,
  kind: 'reprocess',
  path: '/d/old.dem',
  status: 'running',
  progress: 0.42,
  stage: 'parse',
  error: '',
  matchId: 6,
  createdAt: '2026-01-05T00:00:04Z',
  startedAt: '2026-01-05T00:00:05Z',
  finishedAt: null,
};
// Never-extracted FAILED row: the cancel-then-retry presentation. The
// extracted_at gate keeps the queued-style cells after the cancel (a row
// you just cancelled must not flip back to 0–0), while `failed` makes it
// openable again — Re-parse/Delete live, no job owns it so no cancel.
const failedFreshRow = {
  id: 5,
  path: '/d/failed.dem',
  map: 'de_vertigo',
  size: 512 * 1024,
  scoreCT: 0,
  scoreT: 0,
  ctName: '',
  tName: '',
  realRounds: 0,
  durationS: 0,
  extractedAt: '0001-01-01T00:00:00Z',
  status: 'failed',
  error: 'parse blew up',
};
// REPROCESS mid-parse WITH prior data — the anti-regression pin for the
// extracted_at gate: nothing clears the old values (Reprocess only flips
// status), so the row keeps its W/L score, rounds/duration/matchup and the
// reference 3-button set (Cancel live, Re-parse/Delete disabled).
const reprocessParsingRow = {
  id: 6,
  path: '/d/old.dem',
  map: 'de_nuke',
  size: 4096,
  scoreCT: 13,
  scoreT: 9,
  ctName: 'Old',
  tName: 'Guard',
  realRounds: 22,
  durationS: 1800,
  extractedAt: '2026-01-04T00:00:00Z',
  status: 'parsing',
  error: '',
};
bindings.LibraryService.ListJobs = () =>
  Promise.resolve([
    pendingImportJob,
    queuedReprocessJob,
    runningImportJob,
    dequeuedJob,
    reprocessRunningJob,
  ]);
bindings.LibraryService.ListDemoFiles = () =>
  Promise.resolve([
    { path: '/imports/new.dem', root: '/imports', size: 1234, modTime: '2026-01-01T00:00:00Z', hashed: false },
  ]);
const prevRowsForFacet = rowsForFacet;
rowsForFacet = (f) => (f && f.map === 'queued' ? [queuedMatch] : prevRowsForFacet(f));

// The event bus services.js subscribes to — same module instance the
// view's subscriptions use (the stub resolves to this file's URL).
const { fire } = await import(stub('wails-runtime.mjs'));
fire('spectra:library-changed');
await sleep(80); // jobs + list + import-dir scan land

check(
  'a pure dequeue (cancelled, never started) stays out of "Recent import problems"',
  !document.querySelector('.problems'),
  document.querySelector('.problems')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
);

// Both tables exist now: the match list and the import-dir list.
const matchRows = () => [...document.querySelectorAll('.dropzone .data-table tbody tr')];
const dirRows = () => [
  ...document.querySelectorAll('section[aria-label="Demos from your import dirs"] .data-table tbody tr'),
];
const cancelCalls = () => bindings.calls.filter((c) => c.method === 'CancelJob');

{
  // The section-E parsing row now has a live job: determinate bar +
  // Cancel. The synthetic import row sits ahead of it (pendingImports
  // render first), so the match row is the SECOND one.
  const rows = matchRows();
  check(
    'running parse row renders with its job (synthetic row first)',
    rows.length === 2,
    String(rows.length),
  );
  const tr = rows[1];
  const pct = tr.querySelector('.chip-pct');
  check(
    'determinate bar reads the stage + percentage',
    !!pct && pct.textContent.trim() === 'reading demo 42%',
    pct ? pct.textContent.trim() : 'missing',
  );
  const fill = tr.querySelector('.chip-bar-fill');
  check(
    'bar fill determinate at 42% (not the indeterminate animation)',
    !!fill && !fill.classList.contains('indeterminate') && fill.style.width === '42%',
    fill ? `${fill.style.width} indeterminate=${fill.classList.contains('indeterminate')}` : 'missing',
  );
  const btns = [...tr.querySelectorAll('.row-actions button')];
  // RE-PIN (deliberate behavior change): the never-extracted running row
  // renders EXACTLY the enabled Cancel control — its disabled
  // Re-parse/Delete pair is gone (owner ruling). The 42% chip pins above
  // are untouched; the pair's disabled form survives on a reprocess with
  // prior data (pinned in the reprocess block below).
  check(
    'running parse row: exactly the enabled Cancel control (RE-PIN: was Cancel + 2 disabled)',
    btns.length === 1 &&
      btns[0].textContent.trim() === 'Cancel' &&
      !btns[0].disabled,
    JSON.stringify(btns.map((b) => [b.textContent.trim(), b.disabled])),
  );
  const before = cancelCalls().length;
  click(btns[0]);
  await sleep(30);
  check(
    'Cancel calls CancelJob with the running job id',
    cancelCalls().length === before + 1 && cancelCalls().at(-1).args[0] === 13,
    JSON.stringify(cancelCalls().map((c) => c.args)),
  );
}

// Queued facet: a synthetic import row (no match row exists yet) plus the
// match row a queued reprocess flipped.
type(mapInput(), 'queued');
await sleep(350); // past the 250 ms debounce
{
  const rows = matchRows();
  check('queued facet: synthetic import row + the queued match row', rows.length === 2, String(rows.length));
  const synth = rows[0];
  check(
    'synthetic row names the demo being imported',
    synth.textContent.includes('new.dem'),
    synth.textContent.replace(/\s+/g, ' ').slice(0, 90),
  );
  const chip = synth.querySelector('.chip.status');
  check(
    'synthetic row chip says queued',
    !!chip && chip.textContent.includes('queued'),
    chip ? chip.textContent.replace(/\s+/g, ' ').trim() : 'missing',
  );
  check(
    'synthetic queued row shows the indeterminate bar (progress 0)',
    !!synth.querySelector('.chip-bar-fill.indeterminate'),
  );
  const btns = [...synth.querySelectorAll('.row-actions button')];
  check(
    'synthetic row offers exactly Remove',
    btns.length === 1 && btns[0].textContent.trim() === 'Remove',
    JSON.stringify(btns.map((b) => b.textContent.trim())),
  );
  const before = cancelCalls().length;
  click(btns[0]);
  await sleep(30);
  check(
    'Remove calls CancelJob with the pending import job id',
    cancelCalls().length === before + 1 && cancelCalls().at(-1).args[0] === 11,
    JSON.stringify(cancelCalls().map((c) => c.args)),
  );

  const tr = rows[1];
  check(
    'queued match row carries the queued chip',
    !!tr.querySelector('.chip.status') && tr.querySelector('.chip.status').textContent.includes('queued'),
    tr.querySelector('.chip.status')?.textContent.replace(/\s+/g, ' ').trim() ?? 'missing',
  );
  const mBtns = [...tr.querySelectorAll('.row-actions button')];
  // RE-PIN (deliberate behavior change): this fixture is NEVER-EXTRACTED
  // (extractedAt is the Go zero, scores/rounds/duration 0) despite its
  // reprocess job, so the extracted_at gate gives it the one-control
  // presentation — "if it's never-extracted, re-pin to 1". A reprocess
  // WITH prior data keeps the 3-button set mid-parse — pinned in the
  // reprocess block below.
  check(
    'queued match row: exactly Remove, live (RE-PIN: was Remove + 2 disabled)',
    mBtns.length === 1 &&
      mBtns[0].textContent.trim() === 'Remove' &&
      !mBtns[0].disabled,
    JSON.stringify(mBtns.map((b) => [b.textContent.trim(), b.disabled])),
  );
  const beforeM = cancelCalls().length;
  click(mBtns[0]);
  await sleep(30);
  check(
    'match-row Remove calls CancelJob with the reprocess job id',
    cancelCalls().length === beforeM + 1 && cancelCalls().at(-1).args[0] === 12,
    JSON.stringify(cancelCalls().map((c) => c.args)),
  );
}

{
  // Import-dir row for the SAME pending path: chip flips, Import is
  // swapped for the job's Remove.
  const rows = dirRows();
  check('import-dir row lists the pending file', rows.length === 1 && rows[0].textContent.includes('new.dem'), String(rows.length));
  const chip = rows[0].querySelector('.chip.status');
  check(
    'import-dir row flipped to the pending job chip',
    !!chip && chip.textContent.includes('queued'),
    chip ? chip.textContent.replace(/\s+/g, ' ').trim() : 'missing',
  );
  const btns = [...rows[0].querySelectorAll('.row-actions button')];
  check(
    'Import hidden — replaced by Remove (Delete from disk stays)',
    btns.length === 2 &&
      btns[0].textContent.trim() === 'Remove' &&
      !btns.some((b) => b.textContent.trim() === 'Import'),
    JSON.stringify(btns.map((b) => b.textContent.trim())),
  );
}

{
  // Multi-file import: the dialog may return N paths and the view must
  // hand them to ONE ImportPaths call (one job per path, Go side).
  bindings.handlers.ImportDialog = () => ['/imports/one.dem', '/imports/two.dem'];
  const before = bindings.calls.filter((c) => c.method === 'ImportPaths').length;
  const importBtn = [...document.querySelectorAll('.view-header .btn')].find(
    (b) => b.textContent.trim() === 'Import…',
  );
  check('header Import… present for the multi-path pin', !!importBtn);
  click(importBtn);
  await sleep(50);
  const pathCalls = bindings.calls.filter((c) => c.method === 'ImportPaths');
  check(
    'multi-path dialog → ONE ImportPaths call carrying both paths',
    pathCalls.length === before + 1 &&
      pathCalls.at(-1).args[0].length === 2 &&
      pathCalls.at(-1).args[0][0] === '/imports/one.dem' &&
      pathCalls.at(-1).args[0][1] === '/imports/two.dem',
    JSON.stringify(pathCalls.map((c) => c.args)),
  );
}

{
  // Never-extracted FAILED row — the cancel-then-retry presentation.
  // The extracted_at gate (never the status) keeps the queued-style
  // cells: a row you just cancelled must not flip back to 0–0. `failed`
  // is openable, so Re-parse/Delete are LIVE again (retry), and no job
  // owns the row — so there is no cancel control beside them.
  const prevRowsForFacetFail = rowsForFacet;
  rowsForFacet = (f) =>
    f && f.map === 'failedfresh' ? [failedFreshRow] : prevRowsForFacetFail(f);
  type(mapInput(), 'failedfresh');
  await sleep(350); // past the 250 ms debounce
  const rows = matchRows(); // the synthetic import row still renders ahead
  check('failed-fresh facet: synthetic row + the failed match row', rows.length === 2, String(rows.length));
  const tr = rows[1];
  const cells = [...tr.children].map((td) => td.textContent.trim());
  check(
    'failed fresh row keeps the never-extracted cells (file name, no 0–0 after a cancel)',
    cells[1] === 'failed.dem' &&
      cells[2] === '—' &&
      cells[3] === '—' &&
      cells[4] === '—' &&
      cells[5] === '—' &&
      cells[7] === '—',
    JSON.stringify(cells),
  );
  const btns = [...tr.querySelectorAll('.row-actions button')];
  check(
    'failed fresh row actionable again: Re-parse + Delete live, no cancel control',
    btns.length === 2 &&
      btns.map((b) => b.textContent.trim()).join(',') === 'Re-parse,Delete' &&
      btns.every((b) => !b.disabled),
    JSON.stringify(btns.map((b) => [b.textContent.trim(), b.disabled])),
  );
  const chip = tr.querySelector('.chip.status');
  check(
    'failed chip still carries the error title',
    !!chip && chip.textContent.includes('failed') && chip.getAttribute('title') === 'parse blew up',
    chip ? `${chip.textContent.trim()} / ${chip.getAttribute('title')}` : 'missing',
  );
}

{
  // REPROCESS mid-parse WITH prior data — the anti-regression pin for
  // the extracted_at gate: old values stay on screen (W/L score,
  // rounds/duration/matchup) and the row keeps the reference 3-button
  // set — Cancel live, Re-parse/Delete disabled — exactly as before the
  // never-extracted presentation was introduced.
  const prevRowsForFacetRep = rowsForFacet;
  rowsForFacet = (f) =>
    f && f.map === 'reprocessing' ? [reprocessParsingRow] : prevRowsForFacetRep(f);
  type(mapInput(), 'reprocessing');
  await sleep(350); // past the 250 ms debounce
  const rows = matchRows();
  check('reprocess facet: synthetic row + the reprocess match row', rows.length === 2, String(rows.length));
  const tr = rows[1];
  const cells = [...tr.children].map((td) => td.textContent.trim());
  check(
    'reprocess parsing row keeps its OLD values (matchup, 13/9 split, 22 rounds, 30m00s)',
    cells[1] === 'Old vs Guard' &&
      cells[2] === '13' &&
      cells[3] === '9' &&
      cells[4] === '22' &&
      cells[5] === '30m00s' &&
      cells[7] !== '—',
    JSON.stringify(cells),
  );
  const btns = [...tr.querySelectorAll('.row-actions button')];
  check(
    'reprocess parsing row keeps the 3-button set (Cancel live, pair disabled)',
    btns.length === 3 &&
      btns[0].textContent.trim() === 'Cancel' &&
      !btns[0].disabled &&
      btns.slice(1).every((b) => b.disabled),
    JSON.stringify(btns.map((b) => [b.textContent.trim(), b.disabled])),
  );
  const pct = tr.querySelector('.chip-pct');
  check(
    'reprocess row still shows the live parse progress',
    !!pct && pct.textContent.trim() === 'reading demo 42%',
    pct ? pct.textContent.trim() : 'missing',
  );
}

// ---------------------------------------------------------------------------
// Section G: StatusChip's progress contract, mounted directly — 0 means
// indeterminate (moving bar, no number, never "0%"), a real fraction
// renders the stage + rounded percentage and a fixed-width fill.
console.log('G. StatusChip: indeterminate 0 vs determinate 42%');
const chipMod = await import(pathToFileURL(join(dir, 'statuschip.js')).href);
const mountChip = (props) => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  mount(chipMod.default, { target: el, props });
  return el;
};
// The inline chip's exact markup as it stood BEFORE block mode existed
// (captured by compiling the pre-block StatusChip.svelte from git HEAD
// next to the new one — the two outerHTML strings match byte for byte).
// Block mode must never alter it: a diff here means inline mode changed.
const INLINE_GOLDEN =
  '<span class="chip status busy" title="reading demo · 42%">parsing <span class="chip-bar" aria-hidden="true"><span class="chip-bar-fill" style="width: 42%;"></span></span> <span class="chip-pct">reading demo 42%</span><!----><!----></span>';
{
  const ind = mountChip({ status: 'parsing', progress: 0, stage: 'hash' });
  const indPct = ind.querySelector('.chip-pct');
  check(
    'progress 0 → indeterminate fill, no percentage (stage word only, never "0%")',
    !!ind.querySelector('.chip-bar-fill.indeterminate') &&
      (indPct ? !indPct.textContent.includes('%') : true) &&
      !ind.textContent.includes('0%'),
    ind.innerHTML.slice(0, 240),
  );
  check(
    'progress 0 still labels the stage in the tooltip',
    ind.querySelector('.chip').getAttribute('title') === 'checking file',
    ind.querySelector('.chip').getAttribute('title'),
  );

  const det = mountChip({ status: 'parsing', progress: 0.42, stage: 'parse' });
  const fill = det.querySelector('.chip-bar-fill');
  check(
    'progress 0.42 → determinate fill at 42%',
    !!fill && !fill.classList.contains('indeterminate') && fill.style.width === '42%',
    fill ? fill.style.width : 'missing',
  );
  check(
    'progress 0.42 → chip text "reading demo 42%"',
    !!det.querySelector('.chip-pct') && det.querySelector('.chip-pct').textContent.trim() === 'reading demo 42%',
    det.querySelector('.chip-pct')?.textContent.trim() ?? 'missing',
  );
  check(
    'tooltip carries stage · percent',
    det.querySelector('.chip').getAttribute('title') === 'reading demo · 42%',
    det.querySelector('.chip').getAttribute('title'),
  );

  // A caller title (match error) rides along ahead of the stage.
  const titled = mountChip({ status: 'queued', progress: 0, stage: 'hash', title: 'disk on fire' });
  check(
    'caller title kept in the tooltip',
    titled.querySelector('.chip').getAttribute('title') === 'disk on fire · checking file',
    titled.querySelector('.chip').getAttribute('title'),
  );

  // --- BLOCK mode: the presentation rule for a progress display OUTSIDE
  // a table cell (PRODUCT.md "### Defaults" — centered, a ring when the
  // work is quantified and a spinner when it is not, with the details
  // text underneath). The inline pins above must stay green untouched:
  // the two modes share one component and one stylesheet, so this half
  // also pins that NO block furniture ever leaks into inline markup.
  const blk = (props) => mountChip({ block: true, ...props });

  const quant = blk({ progress: 0.42, stage: 'parse', detail: 'Reading the demo' });
  const quantBlock = quant.querySelector('.chip-block');
  check(
    'block mode wraps in .chip-block (no .chip.status pill beside it)',
    !!quantBlock && !quant.querySelector('.chip.status'),
    quant.innerHTML.slice(0, 200),
  );
  check(
    'quantified → RING: no spinner, no inline bar',
    !!quantBlock?.querySelector('.chip-ring') &&
      !quantBlock.querySelector('.chip-spin') &&
      !quantBlock.querySelector('.chip-bar'),
    quantBlock ? quantBlock.innerHTML.slice(0, 200) : 'missing',
  );
  const quantFill = quantBlock?.querySelector('.chip-ring-fill');
  const circ = 2 * Math.PI * 12; // RING_CIRC as declared in StatusChip.svelte
  check(
    'ring sweep encodes the honest percentage (never a fabricated arc)',
    !!quantFill &&
      Math.abs(Number(quantFill.getAttribute('stroke-dashoffset')) - circ * 0.58) < 0.01,
    quantFill ? quantFill.getAttribute('stroke-dashoffset') : 'missing',
  );
  check(
    'details line underneath: detail · stage · percent',
    quantBlock?.querySelector('.chip-detail')?.textContent.trim() ===
      'Reading the demo · reading demo · 42%',
    quantBlock?.querySelector('.chip-detail')?.textContent ?? 'missing',
  );
  check(
    'DOM order: indicator first, details text last',
    !!quantBlock &&
      quantBlock.firstElementChild?.classList.contains('chip-ring') &&
      quantBlock.lastElementChild?.classList.contains('chip-detail'),
    quantBlock ? quantBlock.innerHTML.slice(0, 200) : 'missing',
  );

  const zero = blk({ progress: 0, detail: 'Scanning folders…' });
  const zeroBlock = zero.querySelector('.chip-block');
  check(
    'progress 0 → SPINNER, no ring, never "0%"',
    !!zeroBlock?.querySelector('.chip-spin') &&
      !zeroBlock.querySelector('.chip-ring') &&
      !zero.textContent.includes('0%'),
    zero.innerHTML.slice(0, 200),
  );
  check(
    'progress 0 details line keeps the stage word but no number',
    zeroBlock?.querySelector('.chip-detail')?.textContent.trim() === 'Scanning folders…',
    zeroBlock?.querySelector('.chip-detail')?.textContent ?? 'missing',
  );

  // No progress prop at all = "cannot be quantified" → the same spinner
  // (this is how the bare rung-3 "Loading…" lines render).
  const bare = blk({ detail: 'Loading…' });
  check(
    'absent progress → spinner (the bare loading lines’ shape)',
    !!bare.querySelector('.chip-block .chip-spin') &&
      bare.querySelector('.chip-detail')?.textContent.trim() === 'Loading…',
    bare.innerHTML.slice(0, 200),
  );

  // The centering is CSS (jsdom has no layout) — pin the rule in the
  // ONE stylesheet spelling (.chip-block, public/style.css beside
  // .chip-bar) so "centered" cannot silently regress to left-aligned.
  const blockRule = /\.chip-block\s*\{[^}]*\}/.exec(
    readFileSync(join('public', 'style.css'), 'utf8'),
  )?.[0];
  check(
    'the block rule lays the column out centered',
    !!blockRule &&
      /display:\s*flex/.test(blockRule) &&
      /flex-direction:\s*column/.test(blockRule) &&
      /align-items:\s*center/.test(blockRule),
    blockRule || '.chip-block rule not found in style.css',
  );

  // Inline mode stays byte-identical: the ORIGINAL chip element, with
  // none of the block furniture anywhere in its subtree.
  const inline = mountChip({ status: 'parsing', progress: 0.42, stage: 'parse' });
  const inlineChip = inline.querySelector('.chip.status');
  check(
    'inline mode renders NO block furniture (no ring/spinner/detail)',
    !!inlineChip &&
      !inline.querySelector('.chip-block') &&
      !inline.querySelector('.chip-ring') &&
      !inline.querySelector('.chip-spin') &&
      !inline.querySelector('.chip-detail'),
    inline.innerHTML.slice(0, 240),
  );
  check(
    'inline chip DOM byte-identical to the pre-block markup',
    !!inlineChip && inlineChip.outerHTML === INLINE_GOLDEN,
    inlineChip ? inlineChip.outerHTML : 'missing',
  );
}

// ---------------------------------------------------------------------------
// Section H: keyset "Load more" pagination + the page-borne matchup
// roster. A scripted 201-row library (its first two rows recorded no
// team clan name) pages 200 + 1: the first window renders behind the
// footer, clicking Load more appends the next window with the last row's
// id as cursor, the footer disappears when the list is exhausted — and
// the nameless rows get their team_<player> matchup from the page's
// `rosters` with ZERO per-row GetScoreboard calls (the N+1 this feature
// replaces; the backend contract is store.TestListMatchesPage*).
console.log('H. Load more: first window, footer, append, batched roster');

const pagedRows = [];
for (let i = 201; i >= 1; i--) {
  const nameless = i >= 200; // these extracts recorded no team clan name
  pagedRows.push({
    id: 1000 + i,
    path: `/d/page${i}.dem`,
    map: 'de_paged',
    size: 4096,
    scoreCT: 13,
    scoreT: 10,
    ctName: nameless ? '' : `Team${i}`,
    tName: nameless ? '' : `Side${i}`,
    realRounds: 23,
    durationS: 2400,
    extractedAt: '2026-02-01T00:00:00Z',
    status: 'ready',
    error: '',
  });
}
const prevPagedRowsForFacet = rowsForFacet;
rowsForFacet = (f) => (f && f.map === 'paged' ? pagedRows : prevPagedRowsForFacet(f));

// match rows only — the synthetic import row (a job with no match row
// yet) renders ahead of them and is not part of any window.
const windowRows = () => matchRows().filter((tr) => !tr.hasAttribute('data-pending-import'));
const loadMoreBtn = () =>
  [...document.querySelectorAll('.dropzone .btn')].find((b) => b.textContent.trim() === 'Load more');

type(mapInput(), 'paged');
await sleep(350); // past the 250 ms debounce
{
  const call = pageCalls()[pageCalls().length - 1];
  check(
    'first window fetch: cursor 0, PAGE_SIZE limit',
    call.args[3] === 0 && call.args[4] === 200,
    JSON.stringify(call.args.slice(3, 5)),
  );
  check('first window renders exactly PAGE_SIZE rows', windowRows().length === 200, String(windowRows().length));
  check(
    'Load-more footer shows the loaded count',
    !!loadMoreBtn() &&
      [...document.querySelectorAll('.dropzone .row-between .muted')].some((el) =>
        el.textContent.includes('Showing 200 matches'),
      ),
    document.querySelector('.dropzone .row-between')?.textContent ?? 'no footer',
  );
  check(
    'no per-row GetScoreboard calls — the roster rides the page',
    bindings.callCount('GetScoreboard') === 0,
    String(bindings.callCount('GetScoreboard')),
  );
  const matchup = windowRows()[0].children[1].textContent.trim();
  check(
    'nameless row synthesizes team_<player> names from the page roster',
    matchup === 'team_alice vs team_bob',
    matchup,
  );
}

{
  // Append the second (final) window: cursor = the last rendered row's id.
  const beforeRows = windowRows().length;
  const beforeCalls = pageCalls().length;
  click(loadMoreBtn());
  await sleep(60);
  const call = pageCalls()[pageCalls().length - 1];
  check(
    'Load more fetches with the last row id as cursor',
    pageCalls().length === beforeCalls + 1 && call.args[3] === 1002,
    JSON.stringify(call.args.slice(3, 5)),
  );
  check(
    'second window appends its single remaining row',
    pageCalls().length === beforeCalls + 1 && windowRows().length === beforeRows + 1,
    `calls ${pageCalls().length - beforeCalls}, rows ${windowRows().length} (was ${beforeRows})`,
  );
  check('footer gone once the list is exhausted', !loadMoreBtn(), String(!!loadMoreBtn()));
  // The appended tail is the library's OLDEST row (ids descend): a
  // duplicated or mis-ordered window would end on some id 1200 instead.
  const lastRow = windowRows()[windowRows().length - 1];
  const beforeNav = navCalls().length;
  click(lastRow);
  check(
    'the appended tail is the oldest row (full order preserved)',
    navCalls().length === beforeNav + 1 && navCalls().at(-1) === '/match/1001',
    JSON.stringify(navCalls().slice(-2)),
  );
}

// ---------------------------------------------------------------------------
// Section I: the demo-copy actions. The scripted facet carries one ready
// row WITH a managed copy (copyState 'copied', stamped in production by
// LibraryService.ListMatchesPage from Importer.CopyState) beside a
// copy-less ready row, so the render gate, the confirm flow and the
// delete flow's second prompt can all be pinned against each other.
console.log('I. Free copy: gated render, confirm flow, delete second-confirm');

const copiedRow = {
  id: 4,
  path: '/d/copied.dem',
  map: 'de_overpass',
  size: 214 * 1024 * 1024,
  scoreCT: 13,
  scoreT: 11,
  ctName: 'Copied',
  tName: 'Team',
  realRounds: 24,
  durationS: 3000,
  extractedAt: '2026-01-03T00:00:00Z',
  status: 'ready',
  error: '',
  copyState: 'copied',
};
const prevRowsForFacetI = rowsForFacet;
rowsForFacet = (f) => (f && f.map === 'freecopy' ? [copiedRow, row] : prevRowsForFacetI(f));
bindings.handlers.EvictDemoCopy = (id) => (id === 4 ? copiedRow.size : 0);
globalThis.__deleted = [];
bindings.handlers.DeleteMatch = (id, also) => {
  globalThis.__deleted.push([id, also]);
  return also;
};

type(mapInput(), 'freecopy');
await sleep(350); // past the 250 ms debounce

const dlgBtn = (label) =>
  [...document.querySelectorAll('.cf-actions .btn')].find((b) => b.textContent.trim() === label);
const dlgOpen = () => !!document.querySelector('.cf-prompt');
const freeCopyBtn = (tr) =>
  [...tr.querySelectorAll('.row-actions button')].find((b) => b.textContent.trim() === 'Free copy');
const deleteBtn = (tr) =>
  [...tr.querySelectorAll('.row-actions button')].find((b) => b.textContent.trim() === 'Delete');
const roleStatus = () =>
  [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent).join(' | ');

{
  const rows = windowRows();
  check('copy facet renders two ready rows', rows.length === 2, String(rows.length));
  const copiedBtns = [...rows[0].querySelectorAll('.row-actions button')];
  check(
    'copied row renders Free copy between Re-parse and Delete',
    copiedBtns.map((b) => b.textContent.trim()).join(',') === 'Re-parse,Free copy,Delete',
    JSON.stringify(copiedBtns.map((b) => b.textContent.trim())),
  );
  const plainBtns = [...rows[1].querySelectorAll('.row-actions button')];
  check(
    'a row with no copy keeps exactly Re-parse + Delete (render gate)',
    plainBtns.map((b) => b.textContent.trim()).join(',') === 'Re-parse,Delete',
    JSON.stringify(plainBtns.map((b) => b.textContent.trim())),
  );

  // Cancel is a cancel: the confirm dialog resolves false, nothing hits
  // the backend.
  const before = bindings.callCount('EvictDemoCopy');
  click(freeCopyBtn(rows[0]));
  await sleep(40);
  check(
    'free-copy confirm opens and names the copy',
    dlgOpen() && document.body.textContent.includes('Free Spectra’s copy of the demo?'),
    document.querySelector('.cf-prompt')?.textContent.replace(/\s+/g, ' ').slice(0, 120) ?? '',
  );
  click(dlgBtn('Cancel'));
  await sleep(40);
  check('dialog dismissed after cancel', !dlgOpen());
  check(
    'cancelled free copies nothing',
    bindings.callCount('EvictDemoCopy') === before,
    String(bindings.callCount('EvictDemoCopy')),
  );

  // Confirm → one EvictDemoCopy with the row id, then the freed-bytes
  // notice (fmtBytes of what the backend reported).
  click(freeCopyBtn(windowRows()[0]));
  await sleep(40);
  click(dlgBtn('Free copy'));
  await sleep(150);
  const evictCalls = bindings.calls.filter((c) => c.method === 'EvictDemoCopy');
  check(
    'confirmed free → ONE EvictDemoCopy carrying the row id',
    evictCalls.length === before + 1 && evictCalls.at(-1).args[0] === 4,
    JSON.stringify(evictCalls.map((c) => c.args)),
  );
  check(
    'notice reports the freed size',
    roleStatus().includes('Freed 214.0 MB'),
    roleStatus(),
  );
  check('dialog closed after confirming', !dlgOpen());
}

{
  // Delete flow: the copied row asks BOTH confirms (data, then the file
  // we own) and passes alsoFile=true; the copy-less row asks only the
  // data confirm — there is no file of ours to delete, so the second
  // prompt would be a lie.
  const rows = windowRows();
  click(deleteBtn(rows[0]));
  await sleep(40);
  check(
    'delete opens the data confirm first',
    document.body.textContent.includes('Delete this match’s data?'),
  );
  click(dlgBtn('Delete'));
  await sleep(40);
  check(
    'copied row then asks about the demo file',
    document.body.textContent.includes('Also delete the demo file?'),
  );
  click(dlgBtn('Delete demo file'));
  await sleep(250); // delete + jobs/list/dir refetches
  check(
    'copied row delete passed alsoFile=true',
    globalThis.__deleted.length === 1 &&
      globalThis.__deleted[0][0] === 4 &&
      globalThis.__deleted[0][1] === true,
    JSON.stringify(globalThis.__deleted),
  );

  click(deleteBtn(windowRows()[1]));
  await sleep(40);
  check(
    'no-copy row asks only the data confirm',
    document.body.textContent.includes('Delete this match’s data?') &&
      !document.body.textContent.includes('Also delete the demo file?'),
  );
  click(dlgBtn('Delete'));
  await sleep(250);
  check(
    'no-copy row delete passed alsoFile=false (second confirm skipped)',
    globalThis.__deleted.length === 2 &&
      globalThis.__deleted[1][0] === 1 &&
      globalThis.__deleted[1][1] === false,
    JSON.stringify(globalThis.__deleted),
  );
}

// ---------------------------------------------------------------------------
// Section J: reserved column widths — the fix for the demo table jittering
// while a parse runs. The chip's stage tail ("checking file" → "copying" →
// "reading demo 42%"), the 44px progress bar and the Cancel/Free-copy
// buttons appearing and disappearing all change content inside
// table-layout:auto cells, which re-solves EVERY column — so each volatile
// column reserves its widest content instead. jsdom has no layout, so these
// pin the RULE'S APPLICATION: the reservation class on each column's cells
// and the min-width declarations in public/style.css (the values and their
// sizing arithmetic live in the style.css comments, not here).
console.log('J. reserved column widths: status, actions, job-row demo name');

const css = readFileSync(join('public', 'style.css'), 'utf8');
// ruleBody(sel) returns the declaration block that follows the FIRST
// occurrence of the selector text — enough to pin that the rule carries
// the reservation without re-asserting its exact pixel arithmetic.
const ruleBody = (sel) => {
  const i = css.indexOf(sel);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  if (open < 0) return null;
  const close = css.indexOf('}', open);
  return close < 0 ? null : css.slice(open + 1, close);
};

{
  // The status COLUMN: the match table's Status header, every row's status
  // cell (synthetic job row AND match rows), and the import-dir table's
  // Library column + its row — one class, both tables.
  const head = $('.dropzone .data-table thead th').find((th) =>
    th.textContent.includes('Status'),
  );
  check(
    'match table Status header carries lib-status-col',
    !!head && head.classList.contains('lib-status-col'),
    head ? head.outerHTML.slice(0, 140) : 'no Status header',
  );
  const rows = matchRows();
  // children[8]: the split score columns added a cell before Status
  // (Map, Matchup, W Score, L Score, Rounds, Duration, Size, Imported,
  // Status, Actions).
  check(
    'every match-table row reserves its status cell',
    rows.length > 0 && rows.every((tr) => tr.children[8].classList.contains('lib-status-col')),
    JSON.stringify(rows.map((tr) => tr.children[8] && tr.children[8].className)),
  );
  check(
    'the synthetic job row reserves its status cell too',
    rows.some((tr) => tr.hasAttribute('data-pending-import') && tr.children[8].classList.contains('lib-status-col')),
  );

  const dirHead = $(
    'section[aria-label="Demos from your import dirs"] .data-table thead th',
  ).find((th) => th.textContent.includes('Library'));
  check(
    'import-dir Library header carries lib-status-col',
    !!dirHead && dirHead.classList.contains('lib-status-col'),
    dirHead ? dirHead.outerHTML.slice(0, 140) : 'no Library header',
  );
  const dRows = dirRows();
  check(
    'import-dir rows reserve their status cell',
    dRows.length > 0 && dRows.every((tr) => tr.children[4].classList.contains('lib-status-col')),
    JSON.stringify(dRows.map((tr) => tr.children[4] && tr.children[4].className)),
  );

  // The stylesheet side of the same pins.
  const st = ruleBody('.view .data-table .lib-status-col');
  check(
    'status column rule carries a reserved min-width',
    !!st && /min-width:\s*calc\(/.test(st),
    st ? st.trim() : 'rule .view .data-table .lib-status-col not found',
  );
  const ra = ruleBody('.view .data-table td.row-actions');
  check(
    'actions cell rule carries a reserved min-width',
    !!ra && /min-width:\s*calc\(/.test(ra),
    ra ? ra.trim() : 'rule .view .data-table td.row-actions not found',
  );

  // Row-type difference: the synthetic job row's Matchup cell holds the
  // importing demo's file name — it rides the SAME truncation cap as every
  // other demo name in the view, so an unbounded basename cannot inflate
  // the column while the job runs and collapse it when the match row lands.
  // A never-extracted MATCH row's Matchup cell carries the same class now
  // (its pin lives in section E), so this rule covers that instance too.
  const synth = rows.find((tr) => tr.hasAttribute('data-pending-import'));
  const nameSpan = synth && synth.children[1].querySelector('span');
  check(
    'job-row demo name carries the lib-demo-name cap',
    !!nameSpan && nameSpan.classList.contains('lib-demo-name'),
    nameSpan ? nameSpan.className : 'no synthetic row / name span',
  );
  const cap = ruleBody('.lib-demo-name,');
  check(
    'the demo-name cap still bounds it (max-width + ellipsis)',
    !!cap && /max-width:\s*260px/.test(cap) && /text-overflow:\s*ellipsis/.test(cap),
    cap ? cap.trim() : 'rule .lib-demo-name not found',
  );
}

console.log('K. view-state registry: sort restores across a remount; URL facets never do; reset → defaults');
{
  // The jsdom cross-talk rule (viewstate.svelte.js header): this suite
  // shares ONE registry instance — reset before pinning fresh mounts.
  viewstate.resetViewState();
  // A rendered table (→ sortable headers): two ready rows, no facets —
  // the second is the DRAW fixture for the split score columns (equal
  // scores: both W/L cells show the same value, max = min, no invented
  // tie-break, and neither cell is side-coloured — no side took it).
  const kRow = {
    id: 42,
    path: '/d/k.dem',
    map: 'de_inferno',
    size: 2048,
    scoreCT: 13,
    scoreT: 11,
    ctName: 'K1',
    tName: 'K2',
    realRounds: 24,
    durationS: 2400,
    extractedAt: '2026-02-02T00:00:00Z',
    status: 'ready',
    error: '',
  };
  const drawRow = {
    id: 43,
    path: '/d/draw.dem',
    map: 'de_season',
    size: 2048,
    scoreCT: 12,
    scoreT: 12,
    ctName: 'D1',
    tName: 'D2',
    realRounds: 24,
    durationS: 2400,
    extractedAt: '2026-02-03T00:00:00Z',
    status: 'ready',
    error: '',
  };
  rowsForFacet = () => [kRow, drawRow];

  const mountLib = async (query) => {
    // Flush the read cache (services.cachedRead — same module instance
    // the view uses): a cache-served fetch never reaches the stub, so
    // without this the assertions below would read the PREVIOUS mount's
    // recorded call instead of this one's.
    services.invalidate();
    const t = document.createElement('div');
    document.body.appendChild(t);
    const inst = mount(mod.default, { target: t, props: { query } });
    await sleep(100); // mount + the immediate first list fetch
    return { inst, t };
  };
  const sortOf = () => {
    const c = lastCall();
    return c ? { sk: c.args[1], desc: c.args[2] } : null;
  };
  const sortBtn = (root, label) =>
    [...root.querySelectorAll('button.th-sort')].find(
      (b) => b.getAttribute('aria-label') === `Sort by ${label}`,
    );

  // (a) fresh mount after reset → the documented default key/direction.
  await unmount(libInst);
  const a = await mountLib({});
  check(
    'fresh mount sorts by the default key/direction',
    sortOf() && sortOf().sk === 'extracted_at' && sortOf().desc === true,
    JSON.stringify(sortOf()),
  );

  // (a2) the split score columns: cell values on both rendered rows
  // (13-11 → W13 in the winner's side colour + neutral L11; the draw
  // 12-12 → both cells 12, neither side-coloured), then one header
  // click per axis — first click applies the column's natural default
  // (W desc = most decisive finishes first, L asc = most lopsided games
  // first), the second flips the active header like every other SortTh.
  {
    const rowByText = (txt) =>
      [...document.querySelectorAll('.dropzone .data-table tbody tr')].find((tr) =>
        tr.textContent.includes(txt),
      );
    const cellsOf = (tr) => (tr ? [...tr.children].map((td) => td.textContent.trim()) : null);

    const kTr = rowByText('K1 vs K2');
    const kCells = cellsOf(kTr);
    const kW = kTr && kTr.children[2].querySelector('span');
    check(
      'ready row split: W 13 (winner side colour) + L 11 (neutral)',
      !!kCells &&
        kCells[2] === '13' &&
        kCells[3] === '11' &&
        !!kW &&
        kW.classList.contains('ct') &&
        !kW.classList.contains('t') &&
        !kTr.children[3].querySelector('.ct, .t'),
      JSON.stringify(kCells),
    );

    const dTr = rowByText('D1 vs D2');
    const dCells = cellsOf(dTr);
    const dW = dTr && dTr.children[2].querySelector('span');
    check(
      'draw row: both cells 12 (max = min), no side colour on either cell',
      !!dCells &&
        dCells[2] === '12' &&
        dCells[3] === '12' &&
        !!dW &&
        !dW.classList.contains('ct') &&
        !dW.classList.contains('t') &&
        !dTr.children[3].querySelector('.ct, .t'),
      JSON.stringify(dCells),
    );
  }
  click(sortBtn(a.t, 'W Score'));
  await sleep(350); // past the 250 ms debounce
  check(
    'W Score click → winner_score, default desc (most decisive finishes first)',
    sortOf() && sortOf().sk === 'winner_score' && sortOf().desc === true,
    JSON.stringify(sortOf()),
  );
  click(sortBtn(a.t, 'W Score'));
  await sleep(350);
  check(
    'second W Score click flips the direction (desc → asc)',
    sortOf() && sortOf().sk === 'winner_score' && sortOf().desc === false,
    JSON.stringify(sortOf()),
  );
  click(sortBtn(a.t, 'L Score'));
  await sleep(350);
  check(
    'L Score click → loser_score, default asc (most lopsided games first)',
    sortOf() && sortOf().sk === 'loser_score' && sortOf().desc === false,
    JSON.stringify(sortOf()),
  );

  // (b) mutate: two clicks on Map (second flips the direction) + a facet
  // typed into the URL-owned input (deliberately NOT registered).
  click(sortBtn(a.t, 'Map'));
  click(sortBtn(a.t, 'Map'));
  await sleep(350); // past the 250 ms debounce
  const mutated = sortOf();
  check(
    'sort mutated to Map / flipped direction',
    mutated && mutated.sk === 'map' && mutated.desc === true,
    JSON.stringify(mutated),
  );
  type(mapInput(), 'cache');
  await sleep(350);
  check('facet typed (URL-owned state)', mapInput().value === 'cache', mapInput().value);

  // (c) unmount → remount: the SORT restores (key + direction), the
  // facet does not — the registry never carries route-query state, so a
  // deep link / default always wins over anything typed before.
  await unmount(a.inst);
  const b = await mountLib({});
  const restored = sortOf();
  check(
    'sort RESTORED after remount (key + direction)',
    restored && restored.sk === 'map' && restored.desc === mutated.desc,
    JSON.stringify(restored),
  );
  check(
    'URL-owned facet NOT restored (registry never holds it)',
    mapInput().value === '',
    mapInput().value,
  );

  // (d) the test hook: reset → the next mount is defaults again.
  viewstate.resetViewState();
  await unmount(b.inst);
  const c = await mountLib({});
  const back = sortOf();
  check(
    'resetViewState() → defaults on the next mount',
    back && back.sk === 'extracted_at' && back.desc === true,
    JSON.stringify(back),
  );
  await unmount(c.inst);
}

// ---------------------------------------------------------------------------
// Section L: the cold-start loading gate (loading ladder rung 3 — PRODUCT.md
// ### Defaults). With BOTH first reads in flight the dropzone shows the
// plain loading indicator — it never claims "No matches yet" while the
// library is still on its way — and the table appears only once they land.
// The reads are delayed through the stubs (services.invalidate() first, so a
// cache-served promise cannot bypass them — section K's mountLib rule).
console.log('L. cold start: the empty state never claims "No matches yet" mid-load');
services.invalidate();
const prevList = bindings.handlers.ListMatchesPage;
const prevJobs = bindings.LibraryService.ListJobs;
bindings.handlers.ListMatchesPage = (...args) =>
  new Promise((res) => setTimeout(() => res(prevList(...args)), 250));
bindings.LibraryService.ListJobs = () =>
  new Promise((res) => setTimeout(() => res(prevJobs()), 250));

viewstate.resetViewState();
const coldTarget = document.createElement('div');
document.body.appendChild(coldTarget);
const coldInst = mount(mod.default, { target: coldTarget, props: { query: {} } });
await sleep(60); // both first reads still in flight (250 ms delay)
const coldDrop = () =>
  coldTarget.querySelector('.dropzone')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
check(
  'mid-load: loading indicator, no empty claim, no table',
  coldTarget.textContent.includes('Loading…') &&
    !coldTarget.textContent.includes('No matches yet') &&
    !coldTarget.querySelector('.dropzone .data-table'),
  coldDrop().slice(0, 140),
);
// The indicator's SHAPE (owner ruling + PRODUCT.md ladder rung 3): the
// canonical centered spinner with its details text underneath — never a
// number (there is no denominator for a first read).
check(
  'mid-load: block spinner + "Loading…" details underneath',
  !!coldTarget.querySelector('.dropzone .chip-block .chip-spin') &&
    coldTarget.querySelector('.dropzone .chip-detail')?.textContent.trim() === 'Loading…' &&
    !coldTarget.querySelector('.chip-bar'),
  coldTarget.querySelector('.dropzone .chip-block')?.outerHTML.slice(0, 160) ?? 'missing',
);
await sleep(400); // both reads landed
// Row count is section K's fixture (the ready row + the split-score
// draw row): the pin is the GATE (no Loading…, table present), the
// count just proves the data rendered.
check(
  'after both reads land: the list renders and the gate is gone',
  !coldTarget.textContent.includes('Loading…') &&
    coldTarget.querySelectorAll('.dropzone .data-table tbody tr:not([data-pending-import])')
      .length === 2,
  coldDrop().slice(0, 140),
);

// ---------------------------------------------------------------------------
// Section M: the Match-header prefetch from natural pre-click triggers. All
// four reads are services.cachedRead entries, so warming is fire-and-forget;
// the bail-outs are what need pinning — one warm per row entry (mouseenter
// fires once per entry, never per mousemove) with a per-id throttle, and
// job-done re-warming the fresh match by FORCE (past that throttle), after
// services.js's module-load flush listeners have already cleared the cache.
console.log('M. row hover warms the Match header reads; job-done re-warms by force');
const headerCalls = () =>
  ['GetMatch', 'GetRounds', 'GetMatchSummary', 'GetVoicePresence'].map(bindings.callCount);
// The match row — NOT the synthetic pending-import row rendered ahead of it
// (that one has nothing to open, so it is never warmed).
const coldRow = coldTarget.querySelector(
  '.dropzone .data-table tbody tr:not([data-pending-import])',
);
const beforeWarm = headerCalls();
coldRow.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
await sleep(20);
check(
  'hover fires the four header reads exactly once',
  headerCalls().every((c, i) => c === beforeWarm[i] + 1),
  JSON.stringify({ before: beforeWarm, after: headerCalls() }),
);
coldRow.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
await sleep(20);
check(
  'an immediate re-hover inside the per-row throttle does not re-fire',
  headerCalls().every((c, i) => c === beforeWarm[i] + 1),
  JSON.stringify(headerCalls()),
);

// Restore the handlers BEFORE the event below: job-done refetches jobs +
// list + a scheduled (300 ms) demo scan, and that cleanup must not inherit
// section L's delays.
bindings.handlers.ListMatchesPage = prevList;
bindings.LibraryService.ListJobs = prevJobs;
const beforeDone = bindings.callCount('GetMatch');
fire('spectra:job-done', { jobId: 99, matchId: 42, status: 'done', error: '' });
await sleep(20);
const matchCalls = bindings.calls.filter((c) => c.method === 'GetMatch');
check(
  'job-done warms the fresh match header by force (same id, inside the throttle)',
  bindings.callCount('GetMatch') === beforeDone + 1 &&
    matchCalls[matchCalls.length - 1].args[0] === 42,
  JSON.stringify(matchCalls.slice(-2)),
);

// ---------------------------------------------------------------------------
// Section N: the import-dir scan is off the hot path — event-driven rescans
// go through the trailing debounce (scheduleDemoScan), so a burst of
// job-done / library-changed events settles into ONE rescan instead of one
// per event (a first scan can stream gigabytes through sha256 inside the
// binding).
console.log('N. an event burst coalesces into ONE import-dir rescan');
{
  // Count scans through the stub (the section-F replacement is a plain
  // no-recording stub, so wrap it). The job-done above already scheduled
  // one scan; the events fired below land inside its 300 ms window and
  // push it out — still ONE call for the whole burst.
  const prevScan = bindings.LibraryService.ListDemoFiles;
  let scanCount = 0;
  bindings.LibraryService.ListDemoFiles = (...args) => {
    scanCount++;
    return prevScan(...args);
  };
  fire('spectra:library-changed');
  fire('spectra:job-done', { jobId: 100, matchId: 43, status: 'done', error: '' });
  await sleep(600); // past the 300 ms debounce + the scan itself
  check(
    'three events in one burst → exactly one scan',
    scanCount === 1,
    String(scanCount),
  );
  bindings.LibraryService.ListDemoFiles = prevScan;
}
// ---------------------------------------------------------------------------
// Section O: spectra:scan-progress drives the ONE StatusChip — in BLOCK
// mode now (the centered ring/spinner + details text underneath that
// PRODUCT.md "### Defaults" requires outside a table cell): 0 is the walk
// phase (spinner, no number), a real byte fraction flips it to the ring
// with its percentage in the details line, and the scan resolving hides it
// again. The display renders while a scan runs AND the import-dir list is
// still empty (the expensive first scan is exactly that state), so the
// list is emptied first.
console.log('O. scan progress drives the StatusChip: indeterminate → determinate → gone');
{
  const prevScan = bindings.LibraryService.ListDemoFiles;
  const dirRoot = () =>
    coldTarget.querySelector('section[aria-label="Demos from your import dirs"]');
  const blockOf = () => dirRoot()?.querySelector('.chip-block');

  // (a) Empty the import-dir list: one rescan resolving zero rows.
  bindings.LibraryService.ListDemoFiles = () => Promise.resolve([]);
  fire('spectra:library-changed');
  await sleep(500); // 300 ms debounce + the scan itself
  check(
    'import-dir list emptied (the display’s precondition)',
    !!dirRoot() && !dirRoot().querySelector('.data-table'),
    dirRoot() ? dirRoot().textContent.replace(/\s+/g, ' ').slice(0, 90) : 'no panel',
  );

  // (b) Stall the NEXT scan mid-flight — the display must be up and
  // indeterminate (progress 0) while the walk phase runs: the SPINNER,
  // never a ring and never a number.
  let release;
  bindings.LibraryService.ListDemoFiles = () =>
    new Promise((res) => (release = () => res([])));
  fire('spectra:library-changed');
  await sleep(400); // past the debounce: the scan is now in flight
  const stalledBlock = blockOf();
  check(
    'scan display up: spinner while the scan runs (never "0%", never a ring)',
    !!stalledBlock &&
      !!stalledBlock.querySelector('.chip-spin') &&
      !stalledBlock.querySelector('.chip-ring') &&
      !stalledBlock.textContent.includes('0%'),
    stalledBlock ? stalledBlock.textContent.replace(/\s+/g, ' ').trim() : 'missing',
  );
  check(
    'details text underneath names what is happening',
    !!stalledBlock &&
      stalledBlock.querySelector('.chip-detail')?.textContent.trim() === 'Scanning folders…',
    stalledBlock?.querySelector('.chip-detail')?.textContent ?? 'missing',
  );

  // (c) A real byte fraction renders the RING, with the percentage in
  // the details line underneath — DOM order: indicator first, text after.
  fire('spectra:scan-progress', { stage: 'hash', progress: 0.42, done: 42, total: 100 });
  await sleep(20);
  const detBlock = blockOf();
  const detFill = detBlock?.querySelector('.chip-ring-fill');
  check(
    'scan display reads the byte fraction: ring at 42%, no bar',
    !!detBlock &&
      !!detFill &&
      !detBlock.querySelector('.chip-spin') &&
      !detBlock.querySelector('.chip-bar') &&
      Number(detFill.getAttribute('stroke-dashoffset')) > 0 &&
      (detBlock.textContent.includes('42%') ?? false),
    detBlock
      ? `${detFill?.getAttribute('stroke-dashoffset')} ${detBlock.textContent.replace(/\s+/g, ' ').trim()}`
      : 'missing',
  );
  check(
    'indicator precedes the details text (ring/spinner → text)',
    !!detBlock &&
      detBlock.firstElementChild?.classList.contains('chip-ring') &&
      detBlock.lastElementChild?.classList.contains('chip-detail'),
    detBlock ? detBlock.innerHTML.slice(0, 200) : 'missing',
  );

  // (d) The scan resolving hides the display again.
  release();
  await sleep(60);
  check('scan display gone once the scan lands', !blockOf(), blockOf()?.textContent ?? '');
  bindings.LibraryService.ListDemoFiles = prevScan;
}
await unmount(coldInst);

// ---------------------------------------------------------------------------
// Section P: honesty gate on a FAILED list load — the error and the
// "No matches yet" claim must never render together (the failure is the
// truth about why nothing is here), and the next SUCCESSFUL refetch clears
// the error and lets the claim return. One mount, one failure, one retry:
// the view stays mounted throughout (no navigation, no remount).
console.log('P. failed list load: the error renders, the empty claim waits for a retry');
services.invalidate();
const prevListP = bindings.handlers.ListMatchesPage;
const prevRowsP = rowsForFacet;
const prevListJobsP = bindings.LibraryService.ListJobs;
// An empty library for this section: the claim under test is the PLAIN
// "No matches yet" (no rows, no jobs, no facets) — section K's scripted
// row and section F's job list must not stand in the way of it.
rowsForFacet = () => [];
bindings.LibraryService.ListJobs = () => Promise.resolve([]);
bindings.handlers.ListMatchesPage = () => {
  throw new Error('library backend down');
};
viewstate.resetViewState();
const pTarget = document.createElement('div');
document.body.appendChild(pTarget);
const pInst = mount(mod.default, { target: pTarget, props: { query: {} } });
await sleep(200); // the immediate first list fetch (failing) + the jobs read
{
  const errP = pTarget.querySelector('p.error[role="alert"]');
  check(
    'failed list load renders its error',
    !!errP && errP.textContent.includes('library backend down'),
    errP ? errP.textContent.trim() : 'no p.error',
  );
  check(
    'no "No matches yet" claim beside the error (honesty gate)',
    !pTarget.textContent.includes('No matches yet'),
    pTarget.textContent.replace(/\s+/g, ' ').slice(0, 160),
  );
  // The retry: the next successful refetch (a spectra:library-changed —
  // the event that drives every Library refresh) clears the error, and
  // only then may the empty claim return.
  bindings.handlers.ListMatchesPage = prevListP;
  fire('spectra:library-changed');
  await sleep(250);
  check(
    'a retry clears the error and the empty claim returns',
    !pTarget.querySelector('p.error[role="alert"]') &&
      pTarget.textContent.includes('No matches yet'),
    pTarget.textContent.replace(/\s+/g, ' ').slice(0, 160),
  );
}
await unmount(pInst);
rowsForFacet = prevRowsP;
bindings.LibraryService.ListJobs = prevListJobsP;

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
