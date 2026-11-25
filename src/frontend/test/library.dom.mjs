import './compile-worker-node.mjs';
import { copyClosure } from './copy-closure.mjs';
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
// presentation), a REPROCESS mid-parse (old values kept + EXACTLY the
// live Cancel button — the disabled Re-parse/Delete pair hides on every
// mid-job row, owner 2026-11-16), the
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
// widths (those are sized in the style.css comments). The section also
// pins the width-FIT trim (library-fit, 2026-11-15): the lib-table class
// on BOTH library tables, its scoped padding-inline rule, and the
// demo-name cap that keeps the tables inside the default window's
// budget instead of clipping at its right edge.
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
// ListDemoFiles has NO rec() entry in the shared stub, so the plain
// replacements in this file would bypass `calls` entirely — every
// scanCalls() pin would be vacuous (0 === 0, red never possible).
// Route the property through a recording indirection instead: the
// getter hands the view a wrapper that records first and delegates to
// the current impl; each `bindings.LibraryService.ListDemoFiles = …`
// assignment below swaps that impl. Wrap-and-restore sites capture the
// RAW impl via takeDemoScan — capturing the getter's wrapper would
// recurse.
let demoScanImpl = () => Promise.resolve([]);
const takeDemoScan = () => demoScanImpl;
Object.defineProperty(bindings.LibraryService, 'ListDemoFiles', {
  get: () => (...args) => {
    bindings.calls.push({ method: 'ListDemoFiles', args });
    return demoScanImpl(...args);
  },
  set: (fn) => {
    demoScanImpl = fn;
  },
  configurable: true,
});
bindings.LibraryService.ListMapNames = () =>
  Promise.resolve(['de_ancient', 'de_cache', 'de_mirage']);
bindings.ProfileService.ListPlayers = () =>
  Promise.resolve([
    { steamId: '76561198000000001', name: 'alice', matches: 3, lastSeen: '2026-01-02' },
    { steamId: '76561198000000002', name: 'bob', matches: 1, lastSeen: '2026-01-01' },
    // A BOT in the source list (the pre-rule shape): the canonical
    // client-side filter (lib/players.js listedPlayers) must drop it —
    // the checks below pin that neither the suggestion list nor a typed
    // bot query ever surfaces it.
    { steamId: '18374686479671623692', name: 'Crew', matches: 1, lastSeen: '2026-01-03' },
  ]);
// The suggestion row's career ADR comes from the STORED `career_adr`
// bucket (SuggestInput → services.careerAdrRows), never from a
// Go-computed field on the summary row — ProfileSummary dropped adrAvg
// in dogfooding W4. The value below is deliberately NOT bob's old
// adrAvg (55.5): the assertion pins the SOURCE, not the number.
bindings.MetricsService.ListMetrics = () =>
  Promise.resolve([
    {
      id: 71, name: 'career_adr', title: 'ADR', scope: 'profile', format: 'float1',
      doc: 'Formula: avg(adr)', origin: 'builtin', shortName: 'ADR', denominator: '',
      pluginId: '', expr: '',
    },
  ]);
bindings.MetricsService.GetMetricValuesForPlayer = () =>
  Promise.resolve([{ metricId: 71, subjectKey: '76561198000000002', value: 61.5, n: 1 }]);

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
  // No side switches recorded → the start-side colours (matchup names,
  // W/L cells) equal the final-side ones. Section K's fixtures carry an
  // ODD count instead, so both parities are pinned.
  sideSwitches: 0,
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
// The modules the components reach are copied by closure (test/copy-closure.mjs). The harness's own
// compiles below overwrite the entries it customizes, so its rewrites still win.
copyClosure({
  dir,
  entries: [
  'views/Library.svelte',
  'listnav.js',
  'components/ConfirmDialog.svelte',
  'components/HelpButton.svelte',
  'components/LoadBox.svelte',
  'components/SuggestInput.svelte',
  'sortstate.js',
  ],
});
mkdirSync(dir, { recursive: true });

// Every compiled component lands in this cache dir beside its closure copies, so its
// import of a src/lib module ('../x.js') is the sibling copy ('./x.js').
const svelteCompile = (src, filename, out) => {
  const code = compile(src.replace(/from '\.\.\//g, "from './"), { filename, generate: 'client' }).js.code;
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
    // plumbing (Strings Stage 3): SortTh imports the strings catalog —
    // resolve it from the real tree (no-op for the import-less leaves).
    readFileSync(`src/lib/components/${name}.svelte`, 'utf8').replace(
      "from '../strings/index.js'",
      `from '${fileURL('src/lib/strings/index.js')}'`,
    ),
    `${name}.svelte`,
    join(dir, out),
  );
}

// ConfirmDialog imports Dialog → point at the local bundle; its strings
// catalog import resolves from the real tree (Strings Stage 3 plumbing).
const cdSrc = readFileSync('src/lib/components/ConfirmDialog.svelte', 'utf8')
  .replace("import Dialog from './Dialog.svelte';", "import Dialog from './dialog.js';")
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(cdSrc, 'ConfirmDialog.svelte', join(dir, 'confirmdialog.js'));

// HelpButton — the shared header `?` (help-buttons wave, 2026-11-15):
// the view's header button is this component; its strings catalog
// import resolves from the real tree like every other ../ module.
svelteCompile(
  readFileSync('src/lib/components/HelpButton.svelte', 'utf8').replace(
    "from '../strings/index.js'",
    `from '${fileURL('src/lib/strings/index.js')}'`,
  ),
  'HelpButton.svelte',
  join(dir, 'helpbutton.js'),
);

// SuggestInput (the shared suggestion dropdown) imports Popover, the
// plain-ESM fmt helper and services (the career ADR metric read) →
// local bundle + absolute module URLs; the strings catalog likewise.
const siSrc = readFileSync('src/lib/components/SuggestInput.svelte', 'utf8')
  .replace("from './Popover.svelte'", "from './popover.js'")
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(siSrc, 'SuggestInput.svelte', join(dir, 'suggestinput.js'));

// Library → its plain-ESM imports (services/fmt/teams) resolve from the
// real module locations; its components resolve from the local bundles.
// viewstate.svelte.js is rewritten to the SAME absolute URL the pins
// below import, so the view and the test share one registry instance
// (the jsdom cross-talk rule in that module's header).
// The load state (a runes module) and the shell (a component) the view imports, compiled beside it.
const { compileModule } = await import('svelte/compiler');
writeFileSync(join(dir, 'loadstate.svelte.js'), compileModule(readFileSync('src/lib/loadstate.svelte.js', 'utf8'), { filename: 'loadstate.svelte.js', generate: 'client' }).js.code);
const loadBoxSrc = readFileSync('src/lib/components/LoadBox.svelte', 'utf8').replace(
  "from '../componentruntime/sizememory.js'",
  `from '${fileURL('src/lib/componentruntime/sizememory.js')}'`,
);
svelteCompile(loadBoxSrc, 'LoadBox.svelte', join(dir, 'LoadBox.js'));
const libSrc = readFileSync('src/lib/views/Library.svelte', 'utf8')
  .replace("from '../loadstate.svelte.js'", `from '${fileURL(join(dir, 'loadstate.svelte.js'))}'`)
  .replace("from '../components/LoadBox.svelte'", `from '${fileURL(join(dir, 'LoadBox.js'))}'`)
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../teams.js'", `from '${fileURL('src/lib/teams.js')}'`)
  .replace("from '../players.js'", `from '${fileURL('src/lib/players.js')}'`)
  // the map-icon manifest reader (map logos wave) — same absolute URL the
  // section-Q checks import, so the view and the test share one module
  // instance (the session memo + resetIconManifest()).
  .replace("from '../replay/icons.js'", `from '${fileURL('src/lib/replay/icons.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'")
  .replace("from '../components/SortTh.svelte'", "from './sortth.js'")
  .replace("from '../components/ConfirmDialog.svelte'", "from './confirmdialog.js'")
  .replace("from '../components/SuggestInput.svelte'", "from './suggestinput.js'")
  .replace("from '../components/HelpButton.svelte'", "from './helpbutton.js'")
  // plumbing (Strings Stage 3): the view imports the strings catalog —
  // resolve it from the real tree, like every other ../ module above.
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
// The bundle sits at the cache root, so a top-level module (../sortstate.js) is its sibling copy.
svelteCompile(libSrc.replace(/from '\.\.\/([\w.-]+\.js)'/g, "from './$1'"), 'Library.svelte', join(dir, 'library-bundle.js'));

// Harness: the Library with the profile → library deep-link query. nav
// records every target on globalThis.__nav so the checks below can tell
// "the row navigated" from "the row did nothing".
const harnessSrc = `<script>
  import Library from './library-bundle.js';
  let { query = {} } = $props();
</script>
<Library nav={(p) => (globalThis.__nav = [...(globalThis.__nav || []), p])} openDocs={(s) => (globalThis.__docs = [...(globalThis.__docs || []), s])} {query} />
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
// The import-dirs card's manual Refresh (scan trigger (b), owner ruling
// 2026-11-18: the table refreshes manually only) — scoped so the cold
// mount's own card can be driven in section O.
const refreshBtn = (root = document) =>
  root.querySelector('section[aria-label="Demos from your import dirs"] .row-between .btn');
const clickRefresh = (root = document) => click(refreshBtn(root));
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
// L1 (R2, 2026-11-16): the map facet's own hint is the SHORT form —
// ASCII `...`, exactly as the adjacent player facet spells its own hint
// ("Search players..."): local consistency governs the ellipsis (lead
// ruling). The aria-label below stays the same phrase.
check('map facet keeps its own hint', mapInput().placeholder === 'Filter by map...', mapInput().placeholder);
check('map facet marked active', mapInput().classList.contains('active'));
// The header `?` (help-buttons wave, 2026-11-15): the shared
// HelpButton is the header's LAST element — right of the .spacer and
// the facet group it shares the row with — and opens the guide at the
// `library` section (docslockstep VIEW_SECTIONS['Library.svelte']).
const libHelp = document.querySelector('.view-header > button[aria-label="Help for this view"]');
const libHeader = document.querySelector('.view-header');
check(
  'the ? is the header’s LAST element, right of the .spacer, with the shared labels + question glyph',
  !!libHelp && !!libHeader && libHeader.lastElementChild === libHelp &&
    !!libHeader.querySelector(':scope > .spacer') &&
    libHelp.getAttribute('title') === 'Help for this view' &&
    libHelp.classList.contains('btn') && !!libHelp.querySelector('.codicon-question'),
  libHeader ? [...libHeader.children].map((c) => c.className || c.tagName).join(' | ') : 'no header',
);
const libDocs0 = (globalThis.__docs || []).length;
const libNav0 = navCalls().length;
click(libHelp);
await sleep();
check(
  'clicking it opens the guide at the library section (openDocs) and navigates nowhere',
  (globalThis.__docs || []).length === libDocs0 + 1 &&
    (globalThis.__docs || []).at(-1) === 'library' &&
    navCalls().length === libNav0,
  JSON.stringify((globalThis.__docs || []).slice(libDocs0)),
);
check('player facet marked active', playerInput().classList.contains('active'));
check('clear button present', clearBtn().length === 1, String(clearBtn().length));
// L2 (R2, 2026-11-16): the Clear button sits at the LEFT of the filter
// row — .lib-filters is a flex container, so DOM order IS visual order
// (no CSS change). Both halves are pinned: it is the row's FIRST element
// and it precedes the map input in document order.
{
  const clear = clearBtn()[0];
  const row = clear && clear.parentElement;
  check(
    'clear button is the first element of .lib-filters, before the map input',
    !!clear &&
      !!row &&
      row.classList.contains('lib-filters') &&
      row.firstElementChild === clear &&
      !!(clear.compareDocumentPosition(mapInput()) & Node.DOCUMENT_POSITION_FOLLOWING),
    clear
      ? `first=${row.firstElementChild?.className || row.firstElementChild?.tagName} / pos=${clear.compareDocumentPosition(mapInput())}`
      : 'no clear button',
  );
  // N8-2 (library-buttons wave, 2026-11-16): the clear button is
  // ICON-ONLY — the word it used to render is now its aria-label (so the
  // guide's "**Clear filters** resets both" stays true), the longer hint
  // stays the title, and the glyph is codicon-clear-all (close is the
  // generic dismiss, filter is Builder's/Replay's toggle glyph — both
  // rejected for this spot).
  check(
    'clear button is icon-only: clear-all glyph + aria-label "Clear filters" + its own title',
    !!clear &&
      clear.getAttribute('aria-label') === 'Clear filters' &&
      clear.getAttribute('title') === 'Clear the map and player filters' &&
      !!clear.querySelector('.codicon.codicon-clear-all[aria-hidden="true"]') &&
      !clear.textContent.trim(),
    clear ? clear.outerHTML.slice(0, 220) : 'no clear button',
  );
  // N8-1 (library-buttons wave, 2026-11-16): the import-dirs card's
  // rescan button is ICON-ONLY the same way — "Refresh" is its
  // aria-label (the guide's "a **Refresh** to rescan" claim), the rescan
  // hint stays the title, and codicon-refresh is the glyph (deliberately
  // distinct from Re-parse's codicon-sync, so the view never shows two
  // re-run glyphs).
  const rescan = document.querySelector(
    'section[aria-label="Demos from your import dirs"] .row-between .btn',
  );
  check(
    'card rescan button is icon-only: refresh glyph + aria-label "Refresh" + its own title',
    !!rescan &&
      rescan.getAttribute('aria-label') === 'Refresh' &&
      rescan.getAttribute('title') === 'Rescan the configured import dirs' &&
      !!rescan.querySelector('.codicon.codicon-refresh[aria-hidden="true"]') &&
      !rescan.textContent.trim(),
    rescan ? rescan.outerHTML.slice(0, 240) : 'no rescan button',
  );
}
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
  // RE-PIN (owner ruling 2026-11-15 — START-side colours): the one Score
  // column is TWO columns, W Score = max(scoreCT, scoreT), L Score =
  // min(), each with its own store sort key (winner_score /
  // loser_score). Header old → new: "Score" → "W Score" + "L Score".
  // Cell old → new: "13–9" (CT-blue 13, T-orange 9) → "13" + "9", each
  // in the TEAM colour of the side that team STARTED on (the row rule
  // for this whole table: matchup names and both score cells alike),
  // never the side at match end. This fixture records no side switches,
  // so start side == final side: winner indigo .team-start-ct, loser
  // orange .team-start-t.
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
    const lSpan = scoreTr.children[3].querySelector('span');
    check(
      'RE-PIN: cell 13–9 → W 13 (winner start side) + L 9 (loser start side)',
      scoreCells[2] === '13' &&
        scoreCells[3] === '9' &&
        !!wSpan &&
        wSpan.classList.contains('team-start-ct') &&
        !wSpan.classList.contains('team-start-t') &&
        !!lSpan &&
        lSpan.classList.contains('team-start-t') &&
        !lSpan.classList.contains('team-start-ct'),
      `${JSON.stringify(scoreCells)} / w=${wSpan && wSpan.className} / l=${lSpan && lSpan.className}`,
    );
    // The same rule on the Matchup cell: first name = the team that
    // finished CT, second = the team that finished T, each coloured by
    // the side that team STARTED on.
    const nameSpans = [...scoreTr.children[1].querySelectorAll('span')];
    check(
      'RE-PIN: matchup team names carry their own start-side colours',
      scoreTr.children[1].textContent.trim() === 'Alpha vs Beta' &&
        nameSpans.length === 2 &&
        nameSpans[0].classList.contains('team-start-ct') &&
        nameSpans[1].classList.contains('team-start-t'),
      scoreTr.children[1].innerHTML,
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
    // N9 (library-buttons wave, 2026-11-16): every row-action button is
    // ICON-ONLY — no visible word left in the cell, so each carries its
    // label on aria-label, its hint on title, and one decorative
    // codicon glyph (aria-hidden). Count unchanged: this is an
    // attribute/glyph pin over the same two buttons.
    check(
      'row actions are icon-only: no text, aria-label + title + a decorative glyph on each',
      readyBtns.length === 2 &&
        readyBtns.every((b) => !b.textContent.trim()) &&
        readyBtns.every((b) => !!b.getAttribute('aria-label')) &&
        readyBtns.every((b) => !!b.title) &&
        readyBtns.every((b) => !!b.querySelector('.codicon[aria-hidden="true"]')),
      JSON.stringify(
        readyBtns.map((b) => [b.getAttribute('aria-label'), b.title, b.textContent.trim()]),
      ),
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
    'player row carries matches + the STORED career ADR metric (never ListPlayers\' adrAvg)',
    rows[0].textContent.includes('1 match') &&
      rows[0].textContent.includes('ADR 61.5') &&
      !rows[0].textContent.includes('55.5'),
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
  // W17 (owner, 2026-11-16): the header Import… carries the file-add
  // codicon BEFORE its label (the import-dir row's icon-button
  // precedent) — the visible word is unchanged, so the text pins above
  // and below stay green; only the glyph's placement is new.
  check(
    'header Import… leads with the file-add codicon (icon before the label)',
    [...document.querySelectorAll('.view-header .btn')].some(
      (b) =>
        b.textContent.trim() === 'Import…' &&
        b.firstElementChild?.classList.contains('codicon-file-add'),
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
console.log('F. queued state: synthetic rows, cancel controls, dir-row transfer, problems dismiss, multi-path import');

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
// status), so the row keeps its W/L score, rounds/duration/matchup — and
// (owner, 2026-11-16) EXACTLY the live Cancel button, the disabled
// Re-parse/Delete pair hidden while the row is mid-job.
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
    // new.dem is the queued job's path (pendingImportJob) — w31
    // (2026-11-17) it must NOT list here (it lives as the synthetic row
    // above); ready.dem has no job and keeps the listable row.
    { path: '/imports/new.dem', root: '/imports', size: 1234, modTime: '2026-01-01T00:00:00Z', hashed: false },
    { path: '/imports/ready.dem', root: '/imports', size: 4321, modTime: '2026-01-02T00:00:00Z', hashed: true },
  ]);
const prevRowsForFacet = rowsForFacet;
rowsForFacet = (f) => (f && f.map === 'queued' ? [queuedMatch] : prevRowsForFacet(f));

// The event bus services.js subscribes to — same module instance the
// view's subscriptions use (the stub resolves to this file's URL).
const { fire } = await import(stub('wails-runtime.mjs'));
fire('spectra:library-changed');
await sleep(80); // jobs + list land
// The dir fixture lands through the MANUAL Refresh (scan trigger (b)) —
// library-changed no longer scans (owner ruling 2026-11-18), so the
// section's ListDemoFiles replacement is picked up by the button.
clickRefresh();
await sleep(60);

check(
  'a pure dequeue (cancelled, never started) stays out of "Recent import problems"',
  !document.querySelector('.problems'),
  document.querySelector('.problems')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
);

{
  // Recent import problems — dismiss (owner, 2026-11-17): session-
  // transient plain view state (Match's warningsDismissed pattern — no
  // pref, no URL, no registry), and a NEW problem re-shows the panel so
  // a later error is never silently muted. The main ListJobs stub
  // carries no failed job, so this block scripts its own snapshots and
  // restores the stub after.
  const prevJobsD = bindings.LibraryService.ListJobs;
  const failedJob = {
    id: 16,
    kind: 'import',
    path: '/imports/broken.dem',
    status: 'failed',
    progress: 0,
    stage: 'failed',
    error: 'no replay data in that file',
    matchId: 0,
    createdAt: '2026-01-05T00:00:05Z',
    startedAt: '2026-01-05T00:00:05Z',
    finishedAt: new Date().toISOString(),
  };
  const panel = () => document.querySelector('.problems');
  const withJobs = (extra) => () =>
    Promise.resolve([
      pendingImportJob,
      queuedReprocessJob,
      runningImportJob,
      dequeuedJob,
      reprocessRunningJob,
      ...extra,
    ]);
  bindings.LibraryService.ListJobs = withJobs([failedJob]);
  fire('spectra:library-changed');
  await sleep(80);
  const p1 = panel();
  check(
    'a failed import lands on the problems panel — never the pure dequeue',
    !!p1 && p1.textContent.includes('broken.dem') && !p1.textContent.includes('gone.dem'),
    p1 ? p1.textContent.replace(/\s+/g, ' ').slice(0, 120) : 'no panel',
  );
  const x = p1 && p1.querySelector('.row-between .btn');
  check(
    'the panel wears the house dismiss control (icon-only ✕, aria + title)',
    !!x &&
      x.classList.contains('small') &&
      !!x.querySelector('.codicon-close') &&
      !!x.getAttribute('aria-label') &&
      !!x.getAttribute('title') &&
      x.textContent.trim() === '',
    x ? x.outerHTML.slice(0, 160) : 'missing',
  );
  click(x);
  await sleep(20);
  check('dismiss hides the panel (session-transient view state)', !panel());
  const failedJob2 = { ...failedJob, id: 17, path: '/imports/corrupt.dem' };
  bindings.LibraryService.ListJobs = withJobs([failedJob, failedJob2]);
  fire('spectra:library-changed');
  await sleep(80);
  const p2 = panel();
  check(
    'a NEW import problem re-shows a dismissed panel (never silently muted)',
    !!p2 && p2.textContent.includes('corrupt.dem'),
    p2 ? p2.textContent.replace(/\s+/g, ' ').slice(0, 120) : 'still dismissed',
  );
  // Baseline for the sections below: the original job snapshot (no
  // failed job) — the panel is gone again and stays gone.
  bindings.LibraryService.ListJobs = prevJobsD;
  fire('spectra:library-changed');
  await sleep(400);
  check('restored baseline: no problems panel', !panel());
}

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
  // are untouched; since 2026-11-16 NO parsing/queued row renders the
  // pair, prior data or not (the reprocess block below pins that too).
  // Re-pinned to aria-label 2026-11-16 (library-buttons): the row
  // buttons are icon-only, so the visible word lives on aria-label.
  check(
    'running parse row: exactly the enabled Cancel control (RE-PIN: was Cancel + 2 disabled)',
    btns.length === 1 &&
      btns[0].getAttribute('aria-label') === 'Cancel' &&
      !btns[0].disabled,
    JSON.stringify(btns.map((b) => [b.getAttribute('aria-label'), b.disabled])),
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
  // Re-pinned to aria-label 2026-11-16 (library-buttons): icon-only row
  // buttons — the word moved to aria-label, the count did not.
  check(
    'synthetic row offers exactly Remove',
    btns.length === 1 && btns[0].getAttribute('aria-label') === 'Remove',
    JSON.stringify(btns.map((b) => b.getAttribute('aria-label'))),
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
  // WITH prior data renders the same one control since 2026-11-16 —
  // pinned in the reprocess block below.
  check(
    'queued match row: exactly Remove, live (RE-PIN: was Remove + 2 disabled)',
    mBtns.length === 1 &&
      mBtns[0].getAttribute('aria-label') === 'Remove' &&
      !mBtns[0].disabled,
    JSON.stringify(mBtns.map((b) => [b.getAttribute('aria-label'), b.disabled])),
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
  // w31 transfer (owner, 2026-11-17): a queued file leaves the
  // import-dir table — RE-PIN of the three flip pins (was: the row
  // stayed and flipped to the job chip, putting it on both tables). The
  // fixture's job-less file keeps the listable row with Import.
  const rows = dirRows();
  check(
    'a queued file is absent from the import-dir table (RE-PIN: was "lists the pending file")',
    rows.length === 1 && rows[0].textContent.includes('ready.dem') &&
      !rows[0].textContent.includes('new.dem'),
    JSON.stringify(rows.map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 40))),
  );
  check(
    'the listed row shows the plain "not imported" chip, never a live-job chip (RE-PIN: was the queued flip)',
    !!rows[0] && !rows[0].querySelector('.chip.status') && rows[0].textContent.includes('not imported'),
    rows[0] ? rows[0].textContent.replace(/\s+/g, ' ').slice(0, 80) : 'no row',
  );
  const btns = rows[0] ? [...rows[0].querySelectorAll('.row-actions button')] : [];
  // Re-pinned to aria-label 2026-11-16 (library-buttons): icon-only row
  // buttons. w31: the queued file's row is gone entirely, so the listed
  // row keeps Import + Delete (was: "Import hidden — replaced by Remove").
  check(
    'listed row offers Import + Delete from disk, no Remove (RE-PIN: was "Import hidden — replaced by Remove")',
    btns.length === 2 &&
      btns[0].getAttribute('aria-label') === 'Import' &&
      btns[1].getAttribute('aria-label') === 'Delete from disk',
    JSON.stringify(btns.map((b) => b.getAttribute('aria-label'))),
  );
}

{
  // w31 transfer (owner, 2026-11-17): Import click takes the row out
  // of the scan table SYNCHRONOUSLY (the enqueue below is held open),
  // and once the jobs snapshot owns the path the row stays out while
  // its synthetic row shows above — never both. A FAILED enqueue puts
  // the row back; the existing error banner carries the reason.
  const rowFor = (name) => dirRows().find((tr) => tr.textContent.includes(name));
  const importBtnFor = (name) => {
    const r = rowFor(name);
    return r && [...r.querySelectorAll('.row-actions button')].find((b) => b.getAttribute('aria-label') === 'Import');
  };
  let releaseImport;
  bindings.handlers.ImportPaths = () => new Promise((res) => (releaseImport = () => res(null)));
  const scanCalls = () => bindings.calls.filter((c) => c.method === 'ListDemoFiles').length;
  const scans0 = scanCalls();
  const btn = importBtnFor('ready.dem');
  check('the job-less dir row offers Import before the click', !!btn, String(!!btn));
  click(btn);
  await sleep(30); // Svelte flush — the enqueue has NOT resolved
  check(
    'row GONE from the scan table while the enqueue is still pending (optimistic removal)',
    !rowFor('ready.dem'),
    JSON.stringify(dirRows().map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 40))),
  );
  check(
    'no rescan produced the removal (the scan stub was not called again)',
    scanCalls() === scans0,
    String(scanCalls() - scans0),
  );
  // Release the enqueue with a jobs snapshot that now owns the path:
  // refreshJobs lands the synthetic row above; the dir row must STAY
  // gone even though the scan still lists the file.
  const prevListJobsT = bindings.LibraryService.ListJobs;
  bindings.LibraryService.ListJobs = () =>
    Promise.resolve([
      pendingImportJob,
      queuedReprocessJob,
      runningImportJob,
      dequeuedJob,
      reprocessRunningJob,
      {
        id: 18,
        kind: 'import',
        path: '/imports/ready.dem',
        status: 'queued',
        progress: 0,
        stage: 'queued',
        error: '',
        matchId: 0,
        createdAt: '2026-01-05T00:00:06Z',
        startedAt: null,
        finishedAt: null,
      },
    ]);
  releaseImport();
  await sleep(80); // refreshJobs + refreshList (NO scan — manual-only)
  const above = matchRows().filter((tr) => tr.hasAttribute('data-pending-import'));
  check(
    'the queued file shows as the synthetic row in the table above (as today)',
    above.some((tr) => tr.textContent.includes('ready.dem')),
    JSON.stringify(above.map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 60))),
  );
  check(
    'and is STILL gone from the scan table — never on both at once',
    !rowFor('ready.dem'),
    JSON.stringify(dirRows().map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 40))),
  );
  // Fail-before-fix pin (owner ruling 2026-11-18): the WHOLE timeline
  // from the import click is scan-free — the enqueue landing included
  // (base: doImportPaths' post-enqueue refreshDemoFiles fired here).
  check(
    'no rescan fired from the import click through the enqueue landing',
    scanCalls() === scans0,
    String(scanCalls() - scans0),
  );
  // Failure leg: the enqueue rejects → the row comes back and the
  // error banner says why (a failed import never swallows the row).
  bindings.LibraryService.ListJobs = prevListJobsT;
  fire('spectra:library-changed');
  await sleep(400); // jobs + list land; no scan is scheduled by the event
  // The row was spliced out at click time and no event re-lists it —
  // the manual Refresh (trigger (b)) is how it comes back here.
  clickRefresh();
  await sleep(60);
  bindings.handlers.ImportPaths = () => Promise.reject(new Error('queue unavailable'));
  const btn2 = importBtnFor('ready.dem');
  check('the row is listable again for the failure leg', !!btn2, String(!!btn2));
  click(btn2);
  await sleep(50);
  check(
    'a failed enqueue restores the row to the scan table',
    !!rowFor('ready.dem'),
    JSON.stringify(dirRows().map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 40))),
  );
  const banner = [...document.querySelectorAll('.error')].map((e) => e.textContent).join(' ');
  check(
    'the existing error banner carries the failure reason',
    banner.includes('queue unavailable'),
    banner.slice(0, 140),
  );
  delete bindings.handlers.ImportPaths; // back to the default resolving stub
  fire('spectra:library-changed');
  await sleep(400);
}

{
  // The copy→parse boundary (owner, 2026-11-17): the card's claim keys
  // on the import job's NON-TERMINAL STATUS — never on `matchId`. At
  // the boundary Go creates the match row and stamps the job
  // (CreateMatchRow + SetJobMatch, then spectra:library-changed), so
  // the synthetic row above correctly disappears — but the file must
  // NOT flash back into the import-dir card for the rescan's trailing
  // debounce window (SCAN_DEBOUNCE_MS), because the click-time scan
  // still lists the pending file (the backend lists it and only flags
  // it). Characterization: keyed on `!matchId` (the synthetic row's
  // condition) the row re-appeared for the whole debounce window.
  const rowFor = (name) => dirRows().find((tr) => tr.textContent.includes(name));
  const scanCalls = () => bindings.calls.filter((c) => c.method === 'ListDemoFiles').length;
  const pendingRows = () =>
    matchRows().filter((tr) => tr.hasAttribute('data-pending-import'));
  const matchListRows = () =>
    matchRows().filter((tr) => !tr.hasAttribute('data-pending-import'));
  const prevJobsB = bindings.LibraryService.ListJobs;
  const prevDemoB = takeDemoScan(); // RAW impl — the getter's wrapper would recurse
  const prevRowsForFacetB = rowsForFacet;
  // The boundary job: same id/path through both snapshots, only the
  // boundary fields differ (matchId lands, the job keeps RUNNING).
  const boundaryJob = (over) => ({
    id: 19,
    kind: 'import',
    path: '/imports/ready.dem',
    progress: 0.7,
    stage: 'parsing',
    error: '',
    createdAt: '2026-01-05T00:00:07Z',
    startedAt: '2026-01-05T00:00:07Z',
    finishedAt: null,
    ...over,
  });
  // The match row the boundary's CreateMatchRow produced (id 42).
  const boundaryMatch = {
    id: 42,
    path: '/imports/ready.dem',
    map: 'de_overpass',
    size: 4321,
    scoreCT: 0,
    scoreT: 0,
    ctName: '',
    tName: '',
    realRounds: 0,
    durationS: 0,
    extractedAt: '0001-01-01T00:00:00Z',
    status: 'parsing',
    error: '',
  };
  const jobsWith = (job) => () =>
    Promise.resolve([
      pendingImportJob,
      queuedReprocessJob,
      runningImportJob,
      dequeuedJob,
      reprocessRunningJob,
      job,
    ]);
  const dirDump = () =>
    JSON.stringify(dirRows().map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 40)));

  // (a) The queued state — the exact click-time snapshot: the job owns
  // the path with matchId 0, and the scan STILL lists the file.
  const scans0 = scanCalls();
  bindings.LibraryService.ListJobs = jobsWith(
    boundaryJob({ status: 'queued', progress: 0, stage: 'queued', matchId: 0, startedAt: null }),
  );
  fire('spectra:library-changed');
  await sleep(80); // jobs + list land; the trailing rescan has NOT fired
  check(
    'boundary setup: the queued claim holds (file off the card, synthetic row above)',
    !rowFor('ready.dem') &&
      pendingRows().some((tr) => tr.textContent.includes('ready.dem')),
    dirDump(),
  );
  check(
    'boundary setup: no rescan has run yet (nothing below can be masked)',
    scanCalls() === scans0,
    String(scanCalls() - scans0),
  );

  // (b) THE boundary: the same job now carries matchId 42 while still
  // running — the fresh jobs snapshot lands via library-changed, still
  // inside the 300 ms scan debounce.
  bindings.LibraryService.ListJobs = jobsWith(
    boundaryJob({ status: 'running', stage: 'parsing', progress: 0.7, matchId: 42 }),
  );
  rowsForFacet = (f) =>
    f && f.map === 'queued' ? [queuedMatch, boundaryMatch] : prevRowsForFacetB(f);
  const scansAtBoundary = scanCalls();
  fire('spectra:library-changed');
  await sleep(80); // < SCAN_DEBOUNCE_MS (300) — provably pre-rescan
  check(
    'the rescan provably has not run at the boundary',
    scanCalls() === scansAtBoundary,
    String(scanCalls() - scansAtBoundary),
  );
  check(
    'copy→parse boundary: the claimed row does NOT flash back into the card',
    !rowFor('ready.dem'),
    dirDump(),
  );
  check(
    'the synthetic row is gone (matchId landed — no twin in the table above)',
    !pendingRows().some((tr) => tr.textContent.includes('ready.dem')),
    JSON.stringify(pendingRows().map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 40))),
  );
  check(
    'the boundary match row is present above (CreateMatchRow reached the list)',
    matchListRows().some((tr) => tr.textContent.includes('ready.dem')),
    JSON.stringify(matchListRows().map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 40))),
  );
  // Fail-before-fix pin (owner ruling 2026-11-18): past every debounce
  // window the timeline is STILL scan-free — base fired a rescan here
  // (the boundary's spectra:library-changed scheduled one).
  await sleep(450);
  check(
    'no rescan fires past the debounce after the boundary (manual-only)',
    scanCalls() === scansAtBoundary,
    String(scanCalls() - scansAtBoundary),
  );
  check(
    'the claimed row is still off the card after the debounce window',
    !rowFor('ready.dem'),
    dirDump(),
  );

  // (c) Job-done SUCCESS — the whole-timeline pins. The ListDemoFiles
  // stub stays the CLICK-TIME SNAPSHOT (it still lists the file): that
  // is the stale demoFiles a real parse leaves behind under manual-only
  // scanning, and the jobs snapshot now turns the job TERMINAL, so the
  // claim releases. Without the local job-done splice the row would
  // flash back from that stale snapshot (and base also scheduled a
  // rescan here) — both must stay green only after the fix.
  bindings.LibraryService.ListJobs = jobsWith(
    boundaryJob({
      status: 'done',
      stage: 'done',
      progress: 1,
      matchId: 42,
      finishedAt: '2026-01-05T00:00:10Z',
    }),
  );
  const scansBeforeDone = scanCalls();
  fire('spectra:job-done', { jobId: 19, matchId: 42, status: 'done', error: '' });
  await sleep(80); // the jobs read has landed (claim released)
  check(
    'job-done success: the imported row never reappears (claim released, snapshot stale)',
    !rowFor('ready.dem'),
    dirDump(),
  );
  check(
    'no rescan ran to hide it either',
    scanCalls() === scansBeforeDone,
    String(scanCalls() - scansBeforeDone),
  );
  await sleep(450); // well past any event-driven scan window
  check(
    'still absent, still no rescan — the whole job-done timeline is scan-free',
    !rowFor('ready.dem') && scanCalls() === scansBeforeDone,
    `${dirDump()} scans=${scanCalls() - scansBeforeDone}`,
  );

  // (d) Restore the baseline for the sections below: jobs, the scan
  // stub and the queued facet fixture — the row comes back through the
  // MANUAL Refresh (scan trigger (b)), the only way it can now.
  bindings.LibraryService.ListJobs = prevJobsB;
  bindings.LibraryService.ListDemoFiles = prevDemoB;
  rowsForFacet = prevRowsForFacetB;
  fire('spectra:library-changed');
  await sleep(120); // jobs + list restore (the event schedules no scan)
  clickRefresh();
  await sleep(60);
  check(
    'manual Refresh restores the file for the sections below (trigger (b))',
    !!rowFor('ready.dem'),
    dirDump(),
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
  // Re-pinned to aria-label 2026-11-16 (library-buttons): icon-only row
  // buttons — the order pin now reads the labels' order, unchanged.
  check(
    'failed fresh row actionable again: Re-parse + Delete live, no cancel control',
    btns.length === 2 &&
      btns.map((b) => b.getAttribute('aria-label')).join(',') === 'Re-parse,Delete' &&
      btns.every((b) => !b.disabled),
    JSON.stringify(btns.map((b) => [b.getAttribute('aria-label'), b.disabled])),
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
  // rounds/duration/matchup). Button set RE-PINNED (owner, 2026-11-16):
  // a parsing row renders EXACTLY one button — the live Cancel — and
  // Re-parse/Delete/Free copy are ABSENT from the DOM, not disabled.
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
  // RE-PIN (owner, 2026-11-16, parsing-row buttons): the mid-parse row's
  // ONLY button is the live Cancel — length 1 pins Re-parse/Delete/Free
  // copy ABSENT (never merely disabled; the aria-label re-pin of
  // 2026-11-16 rides the same assertion).
  check(
    'reprocess parsing row: EXACTLY one button — live Cancel, no disabled pair (RE-PIN: was 3-button set)',
    btns.length === 1 &&
      btns[0].getAttribute('aria-label') === 'Cancel' &&
      !btns[0].disabled,
    JSON.stringify(btns.map((b) => [b.getAttribute('aria-label'), b.disabled])),
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
  [...tr.querySelectorAll('.row-actions button')].find(
    (b) => b.getAttribute('aria-label') === 'Free copy',
  );
const deleteBtn = (tr) =>
  [...tr.querySelectorAll('.row-actions button')].find(
    (b) => b.getAttribute('aria-label') === 'Delete',
  );
const roleStatus = () =>
  [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent).join(' | ');

{
  const rows = windowRows();
  check('copy facet renders two ready rows', rows.length === 2, String(rows.length));
  const copiedBtns = [...rows[0].querySelectorAll('.row-actions button')];
  // Re-pinned to aria-label 2026-11-16 (library-buttons): icon-only row
  // buttons — the order pin reads the labels' order, unchanged.
  check(
    'copied row renders Free copy between Re-parse and Delete',
    copiedBtns.map((b) => b.getAttribute('aria-label')).join(',') === 'Re-parse,Free copy,Delete',
    JSON.stringify(copiedBtns.map((b) => b.getAttribute('aria-label'))),
  );
  const plainBtns = [...rows[1].querySelectorAll('.row-actions button')];
  check(
    'a row with no copy keeps exactly Re-parse + Delete (render gate)',
    plainBtns.map((b) => b.getAttribute('aria-label')).join(',') === 'Re-parse,Delete',
    JSON.stringify(plainBtns.map((b) => b.getAttribute('aria-label'))),
  );

  // N9 (library-buttons wave, 2026-11-16): the destructive FAMILY pin —
  // the criterion is "is this action destructive", never "is it in this
  // view". Delete (the match's data) and Delete from disk carry the
  // `danger` class (whose rule now paints --danger at REST, not only on
  // hover) plus the trash glyph; Free copy evicts Spectra's managed copy
  // rather than data, so it takes the discard glyph and NO danger class;
  // Re-parse is mutating-but-safe and stays neutral.
  check(
    'destructive family: Delete = danger + trash glyph, Free copy = discard (no danger), Re-parse neutral',
    copiedBtns.some((b) => b.classList.contains('danger') && !!b.querySelector('.codicon-trash')) &&
      copiedBtns.some(
        (b) => !b.classList.contains('danger') && !!b.querySelector('.codicon-discard'),
      ) &&
      plainBtns[1].classList.contains('danger') &&
      !!plainBtns[1].querySelector('.codicon-trash') &&
      !plainBtns[0].classList.contains('danger') &&
      !!plainBtns[0].querySelector('.codicon-sync'),
    JSON.stringify(copiedBtns.map((b) => [b.getAttribute('aria-label'), b.className])),
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
  // Scan trigger (c) (owner ruling 2026-11-18): match deletion is one
  // of the THREE scan triggers — deleting a match brings its demo back
  // to the import-dirs card, and this pin fails if the delete path ever
  // stops scanning (DeleteMatch emits no event, so nothing else would).
  const scansBeforeDelete = bindings.calls.filter((c) => c.method === 'ListDemoFiles').length;
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
  check(
    'match deletion rescanned the import dirs exactly once (add-back trigger (c))',
    bindings.calls.filter((c) => c.method === 'ListDemoFiles').length ===
      scansBeforeDelete + 1,
    String(
      bindings.calls.filter((c) => c.method === 'ListDemoFiles').length - scansBeforeDelete,
    ),
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
// The same section pins the width-FIT trim (library-fit, 2026-11-15): both
// library tables carry the lib-table class and style.css trims their
// horizontal cell padding through a rule scoped to that class (never
// `.view .data-table` — that would hit Match/Combat/…), so the tables fit
// the default window's budget instead of trailing off its right edge.
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

  // The width-FIT trim (library-fit, 2026-11-15): the two Library tables
  // are the data-tables NOT wrapped in .table-scroll, so anything past the
  // content budget clips at the window's right edge. Both sides are pinned
  // — the scoping class on each <table> (markup) and the padding rule
  // scoped to that class (stylesheet; never `.view .data-table`, which
  // would trim Match/Combat/… too).
  const libTables = [
    $('.dropzone .data-table')[0],
    $('section[aria-label="Demos from your import dirs"] .data-table')[0],
  ];
  check(
    'both library tables carry the lib-table width-trim class',
    libTables.every((t) => t && t.classList.contains('lib-table')),
    JSON.stringify(libTables.map((t) => t && t.className)),
  );
  const trim = ruleBody('.lib-table th');
  check(
    'library tables trim cell padding-inline in a .lib-table-scoped rule',
    !!trim && /padding-inline:\s*6px/.test(trim),
    trim ? trim.trim() : 'rule .lib-table th/.lib-table td not found',
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
  // Re-pinned 2026-11-15 (library-fit, C15): the cap came 260px → 170px —
  // one of the width floors that pushed the match table past the default
  // window's budget (neither library table scrolls horizontally, so the
  // overflow clipped at the window edge). Same rule, same ellipsis; only
  // the value moved, and the full path still rides the title attribute.
  const cap = ruleBody('.lib-demo-name,');
  check(
    'the demo-name cap still bounds it (max-width + ellipsis)',
    !!cap && /max-width:\s*170px/.test(cap) && /text-overflow:\s*ellipsis/.test(cap),
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
  // Both fixtures record an ODD side-switch count, so their start sides
  // are the FLIP of their final sides — the start-side colour rule can't
  // be satisfied by accident from the final-side data.
  const kRow = {
    id: 42,
    path: '/d/k.dem',
    map: 'de_inferno',
    size: 2048,
    scoreCT: 13,
    scoreT: 11,
    sideSwitches: 1, // odd → the CT-finishing team STARTED T
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
    sideSwitches: 1, // odd, and STILL neutral: a draw has no side to colour
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
  // (13-11 → W13 + L11, each in its team's START-side colour — these
  // fixtures record an ODD switch count, so the winner reads T-orange
  // and the loser CT-indigo, the OPPOSITE of their final sides; the draw
  // 12-12 → both cells 12, neither side-coloured even with that odd
  // count), the matchup names carrying the same start-side rule, then
  // one header click per axis — first click applies the column's
  // natural default (W desc = most decisive finishes first, L asc =
  // most lopsided games first), the second flips the active header like
  // every other SortTh.
  {
    const rowByText = (txt) =>
      [...document.querySelectorAll('.dropzone .data-table tbody tr')].find((tr) =>
        tr.textContent.includes(txt),
      );
    const cellsOf = (tr) => (tr ? [...tr.children].map((td) => td.textContent.trim()) : null);

    const kTr = rowByText('K1 vs K2');
    const kCells = cellsOf(kTr);
    const kW = kTr && kTr.children[2].querySelector('span');
    const kL = kTr && kTr.children[3].querySelector('span');
    check(
      'ready row split: W 13 + L 11, each in its team’s start-side colour (odd switches)',
      !!kCells &&
        kCells[2] === '13' &&
        kCells[3] === '11' &&
        !!kW &&
        kW.classList.contains('team-start-t') &&
        !kW.classList.contains('team-start-ct') &&
        !!kL &&
        kL.classList.contains('team-start-ct') &&
        !kL.classList.contains('team-start-t'),
      `w=${kW && kW.className} / l=${kL && kL.className} / ${JSON.stringify(kCells)}`,
    );

    const dTr = rowByText('D1 vs D2');
    const dCells = cellsOf(dTr);
    const dW = dTr && dTr.children[2].querySelector('span');
    const dL = dTr && dTr.children[3].querySelector('span');
    check(
      'draw row: both cells 12 (max = min), no start-side colour on either cell',
      !!dCells &&
        dCells[2] === '12' &&
        dCells[3] === '12' &&
        !!dW &&
        !dW.classList.contains('team-start-ct') &&
        !dW.classList.contains('team-start-t') &&
        !!dL &&
        !dL.classList.contains('team-start-ct') &&
        !dL.classList.contains('team-start-t'),
      `w=${dW && dW.className} / l=${dL && dL.className} / ${JSON.stringify(dCells)}`,
    );

    // The Matchup cell follows the same rule on BOTH rows: first name =
    // the team that finished CT, second = the team that finished T,
    // each coloured by the side it STARTED on (odd switches → flipped).
    const nameClasses = (txt) => {
      const tr = rowByText(txt);
      if (!tr) return null;
      const spans = [...tr.children[1].querySelectorAll('span')];
      return {
        text: tr.children[1].textContent.trim(),
        spans: spans.map((s) => s.className),
      };
    };
    const kNames = nameClasses('K1 vs K2');
    const dNames = nameClasses('D1 vs D2');
    check(
      'matchup names carry their start-side colours (both rows, odd switches)',
      !!kNames &&
        kNames.text === 'K1 vs K2' &&
        kNames.spans.join('|') === 'team-start-t|team-start-ct' &&
        !!dNames &&
        dNames.text === 'D1 vs D2' &&
        dNames.spans.join('|') === 'team-start-t|team-start-ct',
      JSON.stringify({ kNames, dNames }),
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
  !!coldTarget.querySelector('.lib-body.load-busy.load-first') &&
    !coldTarget.textContent.includes('No matches yet') &&
    !coldTarget.querySelector('.dropzone .data-table'),
  coldDrop().slice(0, 140),
);
// The indicator's SHAPE (owner ruling + PRODUCT.md ladder rung 3): the
// canonical centered spinner with its details text underneath — never a
// number (there is no denominator for a first read).
check(
  'mid-load: block spinner + "Loading…" details underneath',
  !!coldTarget.querySelector('.lib-body.load-busy:not(:has(.load-busy))') &&
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
// list (the import-dir table settles locally — no scan), and that
// cleanup must not inherit section L's delays.
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
// Section N: the import-dir table refreshes MANUALLY (owner ruling
// 2026-11-18) — job/library events must schedule NO demo-dir rescan at
// all: a parse fires spectra:library-changed at its boundary and
// spectra:job-done at its end, and neither may touch the table (a
// mid-parse rescan only flashes the panel). RE-PIN (was: the burst
// coalesced into ONE rescan — the auto-refresh the ruling removed).
console.log('N. an event burst schedules NO import-dir rescan (manual-only)');
{
  // Count scans through the stub (the section-F replacement is a plain
  // no-recording stub, so wrap it), then fire the exact event pair a
  // parse produces and wait well past any debounce window.
  const prevScan = takeDemoScan(); // RAW impl — the getter's wrapper would recurse
  let scanCount = 0;
  bindings.LibraryService.ListDemoFiles = (...args) => {
    scanCount++;
    return prevScan(...args);
  };
  fire('spectra:library-changed');
  fire('spectra:job-done', { jobId: 100, matchId: 43, status: 'done', error: '' });
  await sleep(600); // well past the 300 ms any event-driven scan would use
  check(
    'library-changed + job-done schedule NO import-dir rescan (RE-PIN: was "exactly one")',
    scanCount === 0,
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
  const prevScan = takeDemoScan(); // RAW impl — the getter's wrapper would recurse
  const dirRoot = () =>
    coldTarget.querySelector('section[aria-label="Demos from your import dirs"]');
  const blockOf = () => dirRoot()?.querySelector('.chip-block');

  // (a) Empty the import-dir list: one MANUAL rescan (the Refresh
  // button — events no longer scan, owner ruling 2026-11-18) resolving
  // zero rows.
  bindings.LibraryService.ListDemoFiles = () => Promise.resolve([]);
  clickRefresh(coldTarget);
  await sleep(60); // the button scans directly — no debounce
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
  clickRefresh(coldTarget);
  await sleep(60); // the manual scan is now in flight
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

// ---------------------------------------------------------------------------
// Section Q: the Map column's logo (map logos wave). The manifest rides
// /api/icons/manifest.json and this suite had no fetch stub until now, so
// the section installs one, drops the session memo (replay/icons.js
// resetIconManifest — the same module instance the view links) and mounts
// fresh: with a logo extracted the <img> renders BEFORE the map text with
// alt="" (so textContent stays byte-identical), a map with no logo is
// text-only, and a manifest that never arrives leaves the cell exactly as
// it was. jsdom has no layout, so the fixed-size rule is pinned in
// public/style.css through section J's ruleBody instead.
console.log('Q. the Map column shows the map logo when extracted, else bare text');
{
  const iconMods = await import(pathToFileURL('src/lib/replay/icons.js').href);
  const realFetch = globalThis.fetch;
  const manifestBody = {
    extracted: true,
    count: 2,
    icons: { 'AK-47': '/api/icons/ak47.svg', 'Smoke Grenade': '/api/icons/smokegrenade.svg' },
    maps: { de_mirage: '/api/icons/map_icon_de_mirage.svg' },
    mapCount: 1,
    note: '',
  };
  globalThis.fetch = (url) =>
    String(url).includes('/api/icons/manifest.json')
      ? Promise.resolve({ ok: true, json: async () => manifestBody })
      : Promise.resolve({ ok: false }); // nothing else fetches here

  // Two ready rows: one whose map has a logo, one whose map does not.
  const logoRow = { ...row, id: 71, path: '/d/logo.dem', map: 'de_mirage' };
  const bareRow = { ...row, id: 72, path: '/d/bare.dem', map: 'de_dust2' };
  const prevRowsQ = rowsForFacet;
  rowsForFacet = () => [logoRow, bareRow];

  const mountLogos = async () => {
    viewstate.resetViewState();
    services.invalidate(); // a cache-served list would never reach the stub
    iconMods.resetIconManifest(); // the memo must not carry an earlier load
    const t = document.createElement('div');
    document.body.appendChild(t);
    const inst = mount(mod.default, { target: t, props: { query: {} } });
    await sleep(150); // mount + list fetch + the manifest fetch
    return { inst, t };
  };
  const matchRowsIn = (root) => [
    ...root.querySelectorAll('.dropzone .data-table tbody tr:not([data-pending-import])'),
  ];
  const cellFor = (root, mapName) =>
    matchRowsIn(root).find((tr) => tr.textContent.includes(mapName))?.children[0];

  const first = await mountLogos();
  {
    const iconTd = cellFor(first.t, 'de_mirage');
    const bareTd = cellFor(first.t, 'de_dust2');
    check(
      'both rows render (logo map + logo-less map)',
      !!iconTd && !!bareTd,
      `icon=${!!iconTd} bare=${!!bareTd}`,
    );
    const img = iconTd && iconTd.querySelector('img');
    check(
      'the extracted map renders its logo at the manifest URL',
      !!img && img.getAttribute('src') === '/api/icons/map_icon_de_mirage.svg',
      iconTd ? iconTd.innerHTML : 'no cell',
    );
    check(
      'the logo is decorative: alt="" + aria-hidden (no text, no announcement)',
      !!img && img.getAttribute('alt') === '' && img.getAttribute('aria-hidden') === 'true',
      img ? img.outerHTML : 'no img',
    );
    check(
      'the logo carries the fixed-size lib-map-icon class',
      !!img && img.classList.contains('lib-map-icon'),
      img ? img.className : 'no img',
    );
    check(
      'DOM order: logo FIRST, and textContent is byte-identically the map name',
      !!iconTd && iconTd.firstElementChild === img && iconTd.textContent === 'de_mirage',
      iconTd ? iconTd.innerHTML : 'no cell',
    );
    check(
      'a map with no logo stays text-only (the fallback contract)',
      !!bareTd && !bareTd.querySelector('img') && bareTd.textContent === 'de_dust2',
      bareTd ? bareTd.innerHTML : 'no cell',
    );
    // The stylesheet half: fixed height + auto width, so the column never
    // jitters between a logo row and a bare one.
    const logoRule = ruleBody('.lib-map-icon');
    check(
      'style.css pins the logo size (fixed height, auto width)',
      !!logoRule && /height:\s*1\.1em/.test(logoRule) && /width:\s*auto/.test(logoRule),
      logoRule ? logoRule.trim() : 'no .lib-map-icon rule',
    );
  }

  // A manifest that never arrives (endpoint down / not extracted): the
  // cell must be EXACTLY the bare map name — the same text-only shape
  // the logo-less row has, with no leftover <img>.
  globalThis.fetch = () => Promise.resolve({ ok: false });
  await unmount(first.inst);
  const second = await mountLogos();
  {
    const iconTd = cellFor(second.t, 'de_mirage');
    check(
      'missing manifest → identical text-only cell (no img, exact map name)',
      !!iconTd && !iconTd.querySelector('img') && iconTd.textContent === 'de_mirage',
      iconTd ? iconTd.innerHTML : 'no cell',
    );
  }
  await unmount(second.inst);

  globalThis.fetch = realFetch;
  iconMods.resetIconManifest();
  rowsForFacet = prevRowsQ;
  services.invalidate();
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
