// jsdom driver for the metrics Builder's list UX (owner wave A: the
// built-in editor load + the scope/denominator filter pairs + the
// denominator chip; the filter UI is now ONE multi-select; the Type
// group = the format filter; w13c 2026-11-16 — Reading B's third
// Denominator box (None) and the fifth render-time Pinning group).
// Section labels below match the run's console.log letters:
//   A. the ONE filter multi-select (a Filters trigger opens the
//      canonical Popover's checkbox panel with five labelled groups —
//      Origin (Built-in|My metrics), Scope (Match|Profile),
//      Denominator (Rounds|Matches|None), Type (Auto|Int|Float1|Float2|
//      Percent|Currency), Pinning (Pinned|Unpinned); defaults: Built-in
//      OFF / My metrics ON (the owner's standing ruling), every OTHER
//      option ON — the owner's addendum, the Type ruling ("all six
//      checked except Built-in"), Reading B's three Denominator boxes
//      and both Pinning boxes —
//      so the first window is the mine partition and format "" (no
//      predicate)) — the trigger opens and closes it — and the
//      SERVER-side narrowings the checked sets drive: the scripted
//      backend below applies store.ListMetricsPage's exact predicates
//      to the fixture, so a view that filtered client-side, passed the
//      wrong partition word, or forgot an arg would render the wrong
//      rows here; the denominator chip rides each row beside its scope
//      chip;
//   B. an Origin checked-set change restarts the keyset window at
//      cursor 0 — the same path as a search change (one debounced
//      effect reads query + originFilter + scopeFilter + denomFilter +
//      formatFilter) — the group headers follow the partition, and
//      both Origin options off is a legal empty read;
//   C. the Scope group, the Denominator group and the Type group
//      narrow the SAME server call (exact args + cursor reset), all-off
//      in any server-side group is the empty state, the Denominator
//      group sends Reading B's canonical subset words (a row passes iff
//      its bucket is checked — "" = all three, "empty" = none), the
//      Pinning group narrows RENDER-TIME with NO new server call (the
//      one sanctioned exception — pins live in localStorage), and the
//      Type group's canonical subset word drives the auto bucket
//      (format '' rows), subsets and all-off;
//   D. the built-in EDITOR load: a builtin row is a button like every
//      other and fills the form read-only — Save disabled with the
//      end-user reason, chip present, delete absent (on the row AND in
//      the editor footer — w19 item 23 made the footer's delete
//      user-metric-only), pin/preview live —
//      Save stays disabled through an edit (dirty never re-enables it)
//      and loading a user row, a plugin row or New fully restores the
//      editable state; the short-name field caps at SIX characters and
//      an already-over-limit value refuses to save with its own field
//      message (N3 — never a silent truncation, never an API call);
//   E. a SAVED (unmodified) preview reads the canonical stored-value
//      read for the newest ready match + the no-execution compile as
//      provenance, shows the STATE indicator instead of a timing chip,
//      and never loads the form (design §5's saved-form criterion —
//      PreviewMetric stays the on-demand calculator for dirty drafts);
//      the table sorts CLIENT-side — N highest-first by default, the
//      numeric columns by VALUE (never their formatted text) and text
//      columns A→Z, every header flipping on a second click;
//   F. a user row still loads the form for editing (unaffected);
//   G. the search composes with the filters (all four server-side
//      groups, incl. a Denominator subset word) in ONE server call;
//   H. the filter checks are view-local registry state
//      (viewstate.svelte.js): all fifteen restore across unmount →
//      remount, and resetViewState() returns the next mount to the
//      defaults;
//   I. the compute-state surface (design §4/§5): every list item and
//      the editor card wear its state chip (all five words), processing
//      quantifies with the live k/N feed (block form on the card, inline
//      bar in the row), metric-done refetches the state and clears the
//      feed, the draft-vs-saved preview criterion holds, and no rendered
//      state output carries a version number or timestamp;
//   J. the Order dialog (dogfooding design §2 + metrics UI wave B,
//      reworked by N2/N4, M1/M4/M5/M6): the list-header entry point,
//      ONE dialog with its visible TITLE BAR + icon-only ✕ (N2) that
//      never scrolls (M4/M5 — the head sits outside the ONE scroll
//      region, the panel clips, the list no longer scrolls itself),
//      the merged reorder list (the fixed stats fold into the ONE
//      listbox as sequence entries — there is no read-only context
//      block any more — beside the pinned metrics), the per-row
//      show/hide toggle on every HIDEABLE fixed stat (hidden rows stay
//      listed; the scoreboard's Name is exempt) and the PIN toggle on
//      metric rows only (M6 — unpin through Builder's writer: both
//      pin keys, never the order pref, focus to the neighbour row,
//      Builder flipping behind the dialog), the right-aligned control
//      cluster (M1 — eye/pin/↑↓ in one .mo-acts span, no title on the
//      eye), the drag-free list (no handle, nothing draggable),
//      keyboard/button moves that write the WHOLE sequence through
//      (SetPref), Reset → FOUR deletes (both pref PAIRS), the w22
//      name-keyed delete-scrub (deleting a pinned metric drops its
//      NAME from both pin keys — names only, never an id), and the
//      header ✕ closing it.
//
// Section A opens with the N1 list-scroll pins and section F carries
// the N6 one-line actions-row anatomy pins (the delete that now leads
// the line on a user metric, then the validity slot + the
// hint→Pin→Save cluster).
//
// Backend semantics — the SQL partitions + keyset tiling
// (store.TestListMetricsPageOriginFilter*,
// TestListMetricsPageScopeFilter/DenominatorFilter/FormatFilter/
// AllFiltersCompose) and the SaveMetric/DeleteMetric guards
// (TestSaveMetricBuiltinGuards) — live in the Go tests; the
// read-cache key carries all four filter words via
// services-cache.test.js. This pins the VIEW wiring only.
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it (never `npm i --no-save`, which makes the next
// `npm ci` prune it). From frontend/ run:
//   node --test test/builder.dom.mjs
// (must be run with frontend/ as the working directory)
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from './esm-dir-hook.mjs';

installEsmDirHook();

// Same redirection as library.dom.mjs: services.js runs against the
// shared TEST STUBS (no live Wails backend), and 'svelte' is pinned to
// the CLIENT entry so plain `node --test` mounts for real.
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
  'DOMParser', 'localStorage',
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

const bindings = await import('./stubs/bindings.mjs');
const services = await import(pathToFileURL('src/lib/services.js').href);
// The Wails event-bus stub — the SAME module instance services.js
// subscribes to (the '@wailsio/runtime' hook above redirects to this
// file, built from the same cwd-relative path), so firing here drives
// the view's metric-progress / metric-done listeners.
const { fire } = await import(pathToFileURL(join('test', 'stubs', 'wails-runtime.mjs')).href);

// The mount-time fire-and-forget plugin-state read: an empty list keeps
// every row's plugin chip undimmed.
bindings.PlatformService.ListPlugins = () => Promise.resolve([]);
// The live expression check resolves "valid" so loading a row for edit
// never parks an error state beside the form.
bindings.handlers.ValidateExpr = () => [true, {}];

// The library-wide catalog (one cached listMetrics()): the mount effect
// resolves an ABSENT pins key's DEFAULT_PINS (design §1.6) through it,
// and the Order dialog reads the FULL catalog too (design §2.4 — one
// listMetrics() on open; wave B renders only the pinned subset of it).
// Scripted BEFORE the first mount so the resolved selection is stable
// across every section.
bindings.MetricsService.ListMetrics = () => Promise.resolve(METRICS);

// The fixture catalog in the store's canonical order (builtin → user →
// plugin, name ASC within each origin) — the order the paged read and
// the view's group headers are built on. Denominators: one 'rounds', one
// 'matches', two denominator-less — the chip presence/absence and the
// bucket-subset filter (Reading B) both read these. Formats: adr_avg is
// the AUTO bucket (format '' — what the Type group's Auto selects), then
// float1,
// float1, int beside the builtins' percent/float1 — the auto-bucket and
// subset flips read these.
const METRICS = [
  {
    id: 1, name: 'trade_rate', title: 'Trade rate', shortName: '',
    expr: 'from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))',
    scope: 'match', format: 'percent', doc: 'Formula: trade successes / opportunities',
    origin: 'builtin', pluginId: '', denominator: 'rounds',
  },
  {
    id: 2, name: 'adr_avg', title: 'ADR average', shortName: 'ADR',
    expr: 'from player_stats: avg(adr)', scope: 'match', format: '',
    doc: 'Formula: average ADR', origin: 'user', pluginId: '', denominator: '',
  },
  {
    id: 3, name: 'my_kd', title: 'My K/D', shortName: '',
    expr: 'from events: ratio(count(victim), count(attacker))', scope: 'match',
    format: 'float1', doc: 'Formula: kills / deaths', origin: 'user', pluginId: '',
    denominator: 'matches',
  },
  {
    id: 4, name: 'plug_stat', title: 'Plugin stat', shortName: '',
    expr: 'from events: count()', scope: 'match', format: 'int',
    doc: 'Formula: count()', origin: 'plugin', pluginId: 'p1', denominator: '',
  },
];

// The scripted paged read: the SAME partitions + LIKE the store applies
// (store.ListMetricsPage — including Reading B's denominator bucket
// subset and the format subset), recorded so the checks can assert the
// exact args the view sent — (query, originFilter, scopeFilter,
// denomFilter, formatFilter, afterID, limit).
const pageCalls = [];
bindings.handlers.ListMetricsPage = (
  q,
  originFilter,
  scopeFilter,
  denomFilter,
  formatFilter,
  afterID,
  limit,
) => {
  pageCalls.push([q, originFilter, scopeFilter, denomFilter, formatFilter, afterID, limit]);
  let rows = METRICS.slice();
  if (originFilter === 'builtin') rows = rows.filter((m) => m.origin === 'builtin');
  else if (originFilter === 'mine') rows = rows.filter((m) => m.origin !== 'builtin');
  else if (originFilter === 'none') rows = [];
  if (scopeFilter === 'match') rows = rows.filter((m) => (m.scope || 'match') === 'match');
  else if (scopeFilter === 'profile') rows = rows.filter((m) => m.scope === 'profile');
  else if (scopeFilter === 'none') rows = [];
  // The denominator BUCKET SUBSET (Reading B — the 2026-11-16 overturn
  // of the 2026-11-14 "denominator-less rows pass in every state"
  // ruling): the word is the checked set of buckets ("" = all three,
  // "empty" = the empty set, otherwise the canonical comma-subset) and
  // a row passes iff its bucket — the denominator column with '' spelled
  // "none" — is in that set. store.ListMetricsPage mirrors this exactly
  // (its DENOMINATOR FILTER note), and denomFilterWord composes the
  // words on the view side.
  if (denomFilter === 'empty') rows = [];
  else if (denomFilter) {
    const buckets = new Set(denomFilter.split(','));
    rows = rows.filter((m) => buckets.has(m.denominator || 'none'));
  }
  // The format subset (the Type group's word): "none" is the empty set
  // like origin's; any other word is the checked tokens, "auto" naming
  // the '' rows (the store's FORMAT FILTER).
  if (formatFilter === 'none') rows = [];
  else if (formatFilter) {
    const fmts = new Set(formatFilter.split(','));
    rows = rows.filter((m) => fmts.has(m.format || 'auto'));
  }
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((m) => `${m.name} ${m.title}`.toLowerCase().includes(needle));
  }
  const start = afterID ? rows.findIndex((r) => r.id === afterID) + 1 : 0;
  const win = rows.slice(start, start + (limit || 100));
  return { rows: win, hasNext: start + win.length < rows.length };
};

// The row play's preview: the stored definition echoed back (the shape
// MetricPreview carries — `metric` is the full row), recorded so the
// checks can assert the AD-HOC (dirty draft) leg still rides
// PreviewMetric — the SAVED leg must NOT (design §5: a saved +
// unmodified definition reads its stored rows).
const previewCalls = [];
bindings.handlers.PreviewMetric = (id, expr, scope, limit) => {
  previewCalls.push([id, expr, scope, limit]);
  const m = METRICS.find((r) => r.id === id) || {};
  return {
    metric: m,
    rows: [{ group: '', label: 'alice', value: 0.412, n: 13 }],
    ms: 3,
    sql: 'select 1',
    truncated: false,
  };
};

// --- The SAVED-preview read path (design §5) -------------------------------
// The canonical stored-value read (recorded so the checks can pin the
// args), the no-execution compile for provenance, the newest-ready-match
// resolution, the label source, and the compute-state read.
const storedCalls = [];
bindings.handlers.GetMetricValuesForMatch = (matchID, metricIDs) => {
  storedCalls.push([matchID, metricIDs]);
  const rows = [];
  for (const id of metricIDs || []) {
    if (id === 1) {
      // THREE rows so section E can pin the client-side sort: alice's
      // row keeps the default (N highest-first) first position the value
      // check below reads, bob's value is the largest (90%), and carl's
      // is numerically the smallest (5%) while its percent TEXT ("5%")
      // sorts before "41.2%" lexicographically — a text sort cannot
      // pass these checks. Ns descend 13 → 7 → 3 in arrival order.
      rows.push(
        { metricId: id, steamId: '76561198000000001', value: 0.412, n: 13 },
        { metricId: id, steamId: '76561198000000002', value: 0.9, n: 7 },
        { metricId: id, steamId: '76561198000000003', value: 0.05, n: 3 },
      );
    } else {
      rows.push({ metricId: id, steamId: '76561198000000001', value: 6, n: 13 });
    }
  }
  return rows;
};
const compileCalls = [];
bindings.handlers.CompileMetric = (id, expr, scope) => {
  compileCalls.push([id, expr, scope]);
  return 'select 1';
};
bindings.handlers.ListMatches = () => [{ id: 9, status: 'ready', map: 'de_cache' }];
bindings.handlers.ListPlayers = () => [{ steamId: '76561198000000001', name: 'alice' }];
bindings.handlers.GetMetric = (id) => METRICS.find((m) => m.id === id) || null;

// The compute-state read: one entry per metric covering the whole
// vocabulary (the state-surface section below asserts each chip).
let computeStates = [
  { metricId: 1, state: 'fresh' },
  { metricId: 2, state: 'behind' },
  { metricId: 3, state: 'failed', error: 'upstream vanished' },
  { metricId: 4, state: 'processing' },
];
let stateReads = 0;
bindings.handlers.GetMetricComputeState = () => {
  stateReads++;
  return computeStates;
};

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'builder');
mkdirSync(dir, { recursive: true });

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};
const fileURL = (p) => pathToFileURL(p).href;

// StatusChip is a leaf (no imports) → local bundle. ProfileLink imports
// nav.js + services.js → local bundle with both pinned to the SAME
// absolute URLs the view links (one module instance each).
svelteCompile(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  join(dir, 'statuschip.js'),
);
const plSrc = readFileSync('src/lib/components/ProfileLink.svelte', 'utf8')
  .replace("from '../nav.js'", `from '${fileURL('src/lib/nav.js')}'`)
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`);
svelteCompile(plSrc, 'ProfileLink.svelte', join(dir, 'profilelink.js'));

// SortTh (the preview table's sortable headers) — a leaf apart from
// 'svelte', compiled to the local bundle the view's rewritten
// './sortth.js' import resolves; its strings catalog import comes from
// the real tree (Strings Stage 3 plumbing, as in library/profiles).
svelteCompile(
  readFileSync('src/lib/components/SortTh.svelte', 'utf8').replace(
    "from '../strings/index.js'",
    `from '${fileURL('src/lib/strings/index.js')}'`,
  ),
  'SortTh.svelte',
  join(dir, 'sortth.js'),
);

// The Order dialog + its Dialog wrapper: the dialog rewrites its
// services/metricorder imports to the same absolute URLs the view links
// (one module instance each) and its ./Dialog.svelte to the local
// bundle; Dialog itself is a leaf apart from 'svelte'.
const moSrc = readFileSync('src/lib/components/MetricOrderDialog.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../metricorder.js'", `from '${fileURL('src/lib/metricorder.js')}'`)
  .replace("from './Dialog.svelte'", "from './dialog.js'")
  // plumbing (Strings Stage 3): the dialog imports the strings catalog.
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(moSrc, 'MetricOrderDialog.svelte', join(dir, 'metricorderdialog.js'));
svelteCompile(
  readFileSync('src/lib/components/Dialog.svelte', 'utf8'),
  'Dialog.svelte',
  join(dir, 'dialog.js'),
);

// The filter multi-select's dismissal layer — the canonical Popover
// (Escape / outside pointerdown): a leaf apart from 'svelte', compiled
// to the SAME local bundle the view's rewritten './popover.js' import
// resolves (one module instance each).
svelteCompile(
  readFileSync('src/lib/components/Popover.svelte', 'utf8'),
  'Popover.svelte',
  join(dir, 'popover.js'),
);

// HelpButton — the shared header `?` (help-buttons wave, 2026-11-15):
// the Builder header's button is this component now (one canonical
// idiom); its strings catalog import resolves from the real tree like
// every other ../ module above.
svelteCompile(
  readFileSync('src/lib/components/HelpButton.svelte', 'utf8').replace(
    "from '../strings/index.js'",
    `from '${fileURL('src/lib/strings/index.js')}'`,
  ),
  'HelpButton.svelte',
  join(dir, 'helpbutton.js'),
);

// The view: plain-ESM imports (services/fmt/viewstate) resolve from
// their real module locations — viewstate through the SAME absolute URL
// the pins below import, so the view and the test share one registry
// instance (the jsdom cross-talk rule in that module's header).
const bldSrc = readFileSync('src/lib/views/Builder.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../metricorder.js'", `from '${fileURL('src/lib/metricorder.js')}'`)
  .replace("from '../metricformats.js'", `from '${fileURL('src/lib/metricformats.js')}'`)
  .replace("from '../metricdenoms.js'", `from '${fileURL('src/lib/metricdenoms.js')}'`)
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../metricstate.js'", `from '${fileURL('src/lib/metricstate.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
  .replace("from '../components/ProfileLink.svelte'", "from './profilelink.js'")
  .replace("from '../components/SortTh.svelte'", "from './sortth.js'")
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'")
  .replace("from '../components/MetricOrderDialog.svelte'", "from './metricorderdialog.js'")
  .replace("from '../components/Popover.svelte'", "from './popover.js'")
  .replace("from '../components/HelpButton.svelte'", "from './helpbutton.js'")
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(bldSrc, 'Builder.svelte', join(dir, 'builder-bundle.js'));

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'builder-bundle.js')).href);
// The registry the view imports (same URL → same instance — section F
// drives it directly).
const viewstate = await import(pathToFileURL('src/lib/viewstate.svelte.js').href);

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
// The list effect debounces non-first refreshes by 250 ms — wait past it.
const DEBOUNCE = 350;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

let inst = null;
let root = null;
async function mountBuilder() {
  if (inst) {
    await unmount(inst);
    inst = null;
  }
  if (root) {
    root.remove();
    root = null;
  }
  root = document.createElement('div');
  document.body.appendChild(root);
  inst = mount(mod.default, { target: root, props: { nav: () => {} } });
  await sleep(120); // mount + the immediate first list fetch
  return root;
}

const rowsOf = (r) => [...r.querySelectorAll('.bld-row')];
// The raw metric name rides line 1 (.bld-row-title) since the w19 row
// restructure — it used to live in .bld-row-sub.
const namesOf = (r) =>
  rowsOf(r).map((x) => x.querySelector('.bld-row-title .mono')?.textContent.trim());
const headersOf = (r) =>
  [...r.querySelectorAll('.bld-group h3')].map((h) => h.textContent.trim());
const rowNamed = (r, name) =>
  rowsOf(r).find((x) => x.querySelector('.bld-row-title .mono')?.textContent.trim() === name);
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
// The filter multi-select (replaces the three toggle lines): the
// trigger owns the canonical Popover's anchor, so openFilters/closeFilters
// drive it the way a user does (a programmatic click() dispatches no
// pointerdown, so the panel only closes when a test clicks the trigger
// or sends Escape). setBox flips ONE option to the requested state
// through the same DOM path (the panel stays open — it is a
// multi-select), and sixOf/typeOf read the first six (the three pairs —
// Reading B's Denominator NONE box sits AFTER Rounds/Matches, so the
// first-six shape holds) and the Type six in panel order (null when a
// box is missing, which fails every expectation below); fifteenOf is
// the whole panel.
const filterTrigger = (r) => r.querySelector('.bld-filter-host > button');
const panelOf = (r) => r.querySelector('.bld-filter-pop');
const boxesOf = (r) => [...(panelOf(r)?.querySelectorAll('input[type="checkbox"]') || [])];
const boxNamed = (r, label) =>
  boxesOf(r).find((cb) => (cb.closest('label')?.textContent || '').trim() === label);
const openFilters = async (r) => {
  const t = filterTrigger(r);
  if (t && t.getAttribute('aria-expanded') !== 'true') click(t);
  await sleep(40); // the panel mounts on the next flush
};
const closeFilters = async (r) => {
  const t = filterTrigger(r);
  if (t && t.getAttribute('aria-expanded') === 'true') click(t);
  await sleep(40);
};
const setBox = async (r, label, on) => {
  await openFilters(r);
  const cb = boxNamed(r, label);
  if (cb && cb.checked !== on) cb.click();
};
const sixOf = (r) =>
  ['Built-in', 'My metrics', 'Match', 'Profile', 'Rounds', 'Matches'].map(
    (l) => boxNamed(r, l)?.checked ?? null,
  );
// The Denominator group's three boxes in panel order (Reading B) and
// the Pinning group's pair — read beside sixOf/typeOf below.
const denomOf = (r) => ['Rounds', 'Matches', 'None'].map((l) => boxNamed(r, l)?.checked ?? null);
const PIN_LABELS = ['Pinned', 'Unpinned'];
const pinningOf = (r) => PIN_LABELS.map((l) => boxNamed(r, l)?.checked ?? null);
// The Type group's six format boxes in panel order — the canonical
// enum order the subset word composes in (lib/metricformats.js).
const FMT_LABELS = ['Auto', 'Int', 'Float1', 'Float2', 'Percent', 'Currency'];
const typeOf = (r) => FMT_LABELS.map((l) => boxNamed(r, l)?.checked ?? null);
// The whole panel in DOM order: the first six (the three pairs), the
// Denominator group's third None box, the Type six and the Pinning pair
// — fifteen boxes in five groups.
const fifteenOf = (r) => [...sixOf(r), denomOf(r)[2], ...typeOf(r), ...pinningOf(r)];
// The panel's group names in DOM order (the panel itself first, then
// its five labelled groups).
const GROUP_LABELS = ['Metric filters', 'Origin', 'Scope', 'Denominator', 'Type', 'Pinning'];
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const heading = (r) => r.querySelector('.bld-right h2')?.textContent.trim();
// The row's CHIPS minus the compute-state one (StatusChip) — the static
// identity chips in render order: scope, denominator (ALWAYS — the
// none word for a denominator-less row since w19), format, plugin.
const chipsOf = (r, name) =>
  [...(rowNamed(r, name)?.querySelectorAll('.bld-row-sub .chip:not(.status)') || [])].map((c) =>
    c.textContent.trim(),
  );
// The editor card's Save button and its read-only chip (the one
// .bld-readonly in the view — the form header's).
const saveButton = (r) => r.querySelector('.bld-actions .btn.primary');
const formChip = (r) => r.querySelector('.bld-readonly');

viewstate.resetViewState();

console.log('A. ONE multi-select for the four groups — defaults Built-in OFF / My metrics ON, every other option ON (Type: all six checked); the trigger opens and closes the panel');
let r = await mountBuilder();
// N1 — the list BODY is the view's one scroll region: one .bld-rows
// scroller holds the rows + the Load-more footer, while the panel
// header, the search box and the Filters trigger sit OUTSIDE it (the
// filter popover anchors to that trigger, so it must never scroll
// away). The scroller's rule itself is a source pin (jsdom has no
// layout): the viewport-capped calc is what makes the chrome fixed.
{
  const rowsWrap = r.querySelector('.bld-list .bld-rows');
  const list = r.querySelector('.bld-list');
  const m3aCss = readFileSync('public/style-m3a.css', 'utf8');
  check(
    'N1: the rows ride ONE .bld-rows scroller; the header, search and Filters trigger stay outside it',
    !!list && !!rowsWrap &&
      !!rowsWrap.querySelector('.bld-group') &&
      !rowsWrap.contains(list.querySelector('h2')) &&
      !rowsWrap.contains(list.querySelector('input[type="search"]')) &&
      !rowsWrap.contains(filterTrigger(r)) &&
      !!list.querySelector(':scope > .toolbar .bld-filter-host'),
    list
      ? `wrap=${!!rowsWrap} groups=${rowsWrap ? rowsWrap.querySelectorAll('.bld-group').length : 0}`
      : 'no list',
  );
  check(
    'N1: style-m3a.css pins .bld-rows to the viewport-capped scroller (100vh − 300px chrome, overflow-y auto)',
    /\.bld-rows\s*\{[^}]*max-height:\s*calc\(100vh - 300px\)[^}]*overflow-y:\s*auto/s.test(m3aCss),
    'no .bld-rows { max-height: calc(100vh - 300px); overflow-y: auto } rule',
  );
  // N6's IDLE leg: the left slot renders even when the expression
  // check has nothing to say — that is what keeps the right cluster
  // flush right in every state.
  check(
    'N6: the actions row always renders its validity slot — empty while the expression check is idle',
    !!r.querySelector('.bld-actions > .bld-valid') &&
      r.querySelector('.bld-actions > .bld-valid').textContent.trim() === '',
    r.querySelector('.bld-actions > .bld-valid')?.textContent ?? 'no .bld-valid slot',
  );
  // w19 23d — jsdom has no layout, so the overflow fix pins its RULE
  // (the N1 source-pin precedent): the validity slot is the row's
  // flexible item (basis 0, min-width 0) with the canonical single-line
  // ellipsis, which is what keeps a long error from pushing the
  // right-side cluster onto a second line.
  check(
    'N6: .bld-valid is the flexible slot (flex 1 1 0, min-width 0) with the canonical single-line ellipsis — a long error can never shove the cluster to a second line',
    /\.bld-valid\s*\{[^}]*flex:\s*1\s+1\s+0[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap[^}]*\}/s.test(
      m3aCss,
    ),
    'no .bld-valid { flex: 1 1 0; min-width: 0; … text-overflow: ellipsis; white-space: nowrap } rule',
  );
}
check(
  'first list call = (query "", origin "mine", scope "", denominator "", format "", cursor 0, 100)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'mine', '', '', '', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
const trig = filterTrigger(r);
check(
  'the three toggle lines are gone — ONE Filters trigger stands in their place',
  !!trig &&
    !r.querySelector('button.bld-src') &&
    ![...r.querySelectorAll('.bld-list [aria-label]')].some((g) =>
      ['Metric sources', 'Metric scopes', 'Metric denominators'].includes(g.getAttribute('aria-label')),
    ),
  trig ? trig.textContent.replace(/\s+/g, ' ').trim() : 'no trigger',
);
await openFilters(r);
const panel = panelOf(r);
check(
  'the trigger opens the checkbox panel (aria-expanded + fifteen options)',
  trig?.getAttribute('aria-expanded') === 'true' && !!panel && boxesOf(r).length === 15,
  `expanded=${trig?.getAttribute('aria-expanded')} boxes=${boxesOf(r).length}`,
);
check(
  'defaults render with Built-in unchecked and every other pair option checked (owner ruling)',
  JSON.stringify(sixOf(r)) === JSON.stringify([false, true, true, true, true, true]),
  JSON.stringify(sixOf(r)),
);
check(
  "the Denominator group defaults to ALL THREE boxes checked (Rounds, Matches, None — Reading B) and the Pinning group to BOTH (Pinned, Unpinned)",
  JSON.stringify(denomOf(r)) === JSON.stringify([true, true, true]) &&
    JSON.stringify(pinningOf(r)) === JSON.stringify([true, true]),
  JSON.stringify(denomOf(r)) + ' / ' + JSON.stringify(pinningOf(r)),
);
check(
  'the Type group defaults to ALL SIX format boxes checked (owner: "all six checked except Built-in")',
  JSON.stringify(typeOf(r)) === JSON.stringify([true, true, true, true, true, true]),
  JSON.stringify(typeOf(r)),
);
{
  const names = panel
    ? [...panel.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))
    : [];
  check(
    'the panel is ONE named group holding five labelled groups (Origin, Scope, Denominator, Type, Pinning)',
    panel?.getAttribute('aria-label') === 'Metric filters' &&
      JSON.stringify(names) === JSON.stringify(GROUP_LABELS.slice(1)),
    JSON.stringify([panel?.getAttribute('aria-label'), ...names]),
  );
}
await closeFilters(r);
check(
  'the trigger click closes the panel (aria-expanded=false, no panel left in the DOM)',
  !panelOf(r) && trig?.getAttribute('aria-expanded') === 'false',
  `panel=${!!panelOf(r)} expanded=${trig?.getAttribute('aria-expanded')}`,
);
await openFilters(r);
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(40);
check(
  'Escape closes the panel too (the canonical Popover owns the dismissal)',
  !panelOf(r) && trig?.getAttribute('aria-expanded') === 'false',
  `panel=${!!panelOf(r)} expanded=${trig?.getAttribute('aria-expanded')}`,
);
check(
  'the default view is the mine partition (Yours + Plugins headers, no builtin row)',
  JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Yours', 'Plugins']),
  JSON.stringify(namesOf(r)) + ' headers=' + JSON.stringify(headersOf(r)),
);
check(
  'the denominator chip rides beside the scope chip when a metric carries one',
  JSON.stringify(chipsOf(r, 'my_kd')) === JSON.stringify(['match', 'matches', 'float1']),
  JSON.stringify(chipsOf(r, 'my_kd')),
);
check(
  // w19 owner ruling: the denominator tag is ALWAYS visible — a
  // denominator-less row states the vocabulary's own denominator-less
  // word ('none') instead of dropping the chip, and the auto-format
  // row still wears its raw format chip.
  'a denominator-less metric states the none word in its always-present denominator chip',
  JSON.stringify(chipsOf(r, 'adr_avg')) === JSON.stringify(['match', 'none', 'raw']) &&
    JSON.stringify(chipsOf(r, 'plug_stat')) === JSON.stringify(['match', 'none', 'int', 'plugin']),
  JSON.stringify(chipsOf(r, 'adr_avg')) + ' / ' + JSON.stringify(chipsOf(r, 'plug_stat')),
);
{
  // The w19 row restructure, pinned as DOM ORDER: line 1 runs title
  // text → raw mono name → the ⓘ doc icon (the mono slot only when the
  // title is not already the name — the double-print guard), line 2
  // holds chips ONLY (never a second copy of the name).
  const row = rowNamed(r, 'adr_avg');
  const title = row?.querySelector('.bld-row-title');
  const sub = row?.querySelector('.bld-row-sub');
  const kids = title ? [...title.children] : [];
  check(
    'the row runs title → mono name → ⓘ on line 1, and line 2 holds chips only',
    !!title &&
      title.firstChild?.nodeType === 3 &&
      title.firstChild.textContent.includes('ADR average') &&
      kids.length === 2 &&
      kids[0].classList.contains('mono') &&
      kids[0].textContent.trim() === 'adr_avg' &&
      kids[1].classList.contains('m5-ib') &&
      !!sub &&
      sub.children.length > 0 &&
      [...sub.children].every((el) => el.classList.contains('chip')) &&
      !sub.querySelector('.mono'),
    title
      ? `title-kids=${kids.map((k) => k.className || k.tagName).join('|')} sub=${sub?.textContent.replace(/\s+/g, ' ')}`
      : 'no .bld-row-title',
  );
}
check(
  'the server-side search box is rendered',
  !!r.querySelector('input[type="search"][aria-label="Search metrics"]'),
);

console.log('B. the Origin group narrows server-side (cursor 0) and both options off is a legal empty read');
services.invalidate(); // same-key windows are cached — record this window fresh
pageCalls.length = 0;
await setBox(r, 'Built-in', true); // from the default: the mine partition → the whole catalog
await sleep(DEBOUNCE);
check(
  'Built-in checked → (query "", origin "", scope "", denominator "", format "", cursor 0, 100) — all four rows with the Builtins header',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'adr_avg', 'my_kd', 'plug_stat']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Builtins', 'Yours', 'Plugins']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'My metrics', false);
await sleep(DEBOUNCE);
check(
  'My metrics unchecked → origin "builtin": only the builtin row renders, and its rounds chip rides beside its scope chip',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'builtin', '', '', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']) &&
    !headersOf(r).includes('Yours') &&
    JSON.stringify(chipsOf(r, 'trade_rate')) === JSON.stringify(['match', 'rounds', 'percent']),
  JSON.stringify(pageCalls[0]) +
    ' rows=' +
    JSON.stringify(namesOf(r)) +
    ' trade_rate=' +
    JSON.stringify(chipsOf(r, 'trade_rate')),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Built-in', false);
await sleep(DEBOUNCE);
check(
  'both Origin options off → origin "none" — a legal empty read',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'none', '', '', '', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
check(
  'both off → empty list, no error, the empty state says so',
  rowsOf(r).length === 0 &&
    !r.querySelector('p.error[role="alert"]') &&
    r.textContent.includes('No metrics to show.'),
  `rows=${rowsOf(r).length} text=${r.textContent.replace(/\s+/g, ' ').slice(0, 200)}`,
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'My metrics', true);
await sleep(DEBOUNCE);
check(
  'My metrics back checked → origin "mine" — cursor reset again, mine rows render',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'mine', '', '', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Built-in', true);
await sleep(DEBOUNCE);
check(
  'both Origin options back on → the whole catalog window again',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', 0, 100]) &&
    rowsOf(r).length === 4,
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);

console.log('C. the Scope, Denominator and Type groups narrow the same server call (Reading B\'s bucket subsets + the format subset hold), and the Pinning group narrows render-time with no call');
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Match', false); // Profile only
await sleep(DEBOUNCE);
check(
  'Match unchecked → (query "", origin "", scope "profile", denominator "", format "", cursor 0, 100)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', 'profile', '', '', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
check(
  'Profile only → the empty state (the fixture carries no profile-scoped metric)',
  rowsOf(r).length === 0 && r.textContent.includes('No metrics to show.'),
  `rows=${rowsOf(r).length}`,
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Profile', false); // both Scope options off
await sleep(DEBOUNCE);
check(
  'both Scope options off → scope "none" — the same legal empty read as origin',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', 'none', '', '', 0, 100]) &&
    rowsOf(r).length === 0 &&
    r.textContent.includes('No metrics to show.'),
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Match', true); // Match only
await sleep(DEBOUNCE);
check(
  'Match back checked (Profile still off) → scope "match" — cursor reset again',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', 'match', '', '', 0, 100]) &&
    rowsOf(r).length === 4,
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Profile', true);
await sleep(DEBOUNCE);
check(
  'both Scope options on → scope "" — no narrowing',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Rounds', false); // Matches + None (the default third box)
await sleep(DEBOUNCE);
check(
  'Rounds unchecked → (…, denominator "matches,none", cursor 0, 100) — the canonical subset word',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', 'matches,none', '', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
check(
  'Matches+None → the matches metric AND both denominator-less rows (today\'s old "matches" window, behaviour preserved)',
  JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
  JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Matches', false); // only None left
await sleep(DEBOUNCE);
check(
  'Matches unchecked → denominator "none" (the {None} subset)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', 'none', '', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
check(
  'only {None} checked → ONLY the denominator-less rows (today\'s old "none" window, behaviour preserved)',
  JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'plug_stat']),
  JSON.stringify(namesOf(r)),
);
// Reading B's empty checked set (2026-11-16): all three boxes off is
// the EMPTY set — nothing passes, said through the empty state (the
// 2026-11-14 rule this overturns kept the denominator-less rows here).
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'None', false); // no Denominator box left
await sleep(DEBOUNCE);
check(
  'every Denominator box off → denominator "empty" — the empty set, a legal empty read',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', 'empty', '', 0, 100]) &&
    rowsOf(r).length === 0 &&
    r.textContent.includes('No metrics to show.'),
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
// The NEW subsets (the ones the old pair could not spell): {Rounds}
// drops the denominator-less rows, {Rounds, Matches} keeps exactly the
// two denominated metrics.
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Rounds', true); // {Rounds} only
await sleep(DEBOUNCE);
check(
  '{Rounds} alone → denominator "rounds" — the NEW rounds-only subset, one store-side row (the denominator-less rows are gone)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', 'rounds', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Matches', true); // {Rounds, Matches}
await sleep(DEBOUNCE);
check(
  '{Rounds, Matches} → denominator "rounds,matches" — both denominated metrics, still no denominator-less row',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', 'rounds,matches', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'my_kd']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'None', true); // all three back on
await sleep(DEBOUNCE);
check(
  'all three Denominator boxes on → denominator "" — all four rows again',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);

// --- The Pinning group (the fifth) — RENDER-TIME, the one sanctioned
// exception: pins live in localStorage (spectra:pinned-metrics), so Go
// cannot narrow on them and flipping these boxes must issue NO
// listMetricsPage call at all — the rows below are a render-time filter
// over the windows already accumulated. trade_rate is pinned first (it
// is the fixture's one unpinned-at-rest row later sections expect), and
// it is unpinned again at the end so sections D–J see the pins as they
// found them.
{
  // The row's pin button is re-queried on every use: each render can
  // rebuild the row's DOM (the group it sits in changed with the
  // filter), and a destroyed node's handler is gone with it.
  const pinToggle = () =>
    rowNamed(r, 'trade_rate')?.querySelector('[aria-label="Toggle pin for trade_rate"]');
  click(pinToggle());
  await sleep(40);
  services.invalidate(); // any wrong fetch below would hit the stub and be recorded
  pageCalls.length = 0;
  await setBox(r, 'Unpinned', false); // Pinned only
  await sleep(DEBOUNCE);
  check(
    'Pinned only → NO new ListMetricsPage call (the pin filter never reaches the server) and only the pinned row renders',
    pageCalls.length === 0 &&
      pinToggle()?.classList.contains('bld-pin-on') &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']),
    `calls=${JSON.stringify(pageCalls)} rows=${JSON.stringify(namesOf(r))} pin=${pinToggle()?.className}`,
  );
  await setBox(r, 'Pinned', false); // neither — both Pinning boxes off
  await sleep(DEBOUNCE);
  check(
    'both Pinning boxes off → still no call, no rows render, the empty state says so',
    pageCalls.length === 0 &&
      rowsOf(r).length === 0 &&
      r.textContent.includes('No metrics to show.'),
    `calls=${JSON.stringify(pageCalls)} rows=${rowsOf(r).length}`,
  );
  await setBox(r, 'Unpinned', true);
  await setBox(r, 'Pinned', true);
  await sleep(DEBOUNCE);
  check(
    'both Pinning boxes back on → the full window renders again (still no new call)',
    pageCalls.length === 0 && rowsOf(r).length === 4,
    `calls=${JSON.stringify(pageCalls)} rows=${rowsOf(r).length}`,
  );
  click(pinToggle()); // restore: trade_rate unpinned for sections D–J
  await sleep(40);
  check(
    'trade_rate is unpinned again — sections D–J see the pins as they found them',
    !pinToggle()?.classList.contains('bld-pin-on'),
    pinToggle()?.className,
  );
}
// The Type group narrows the SAME call (origin is the whole catalog
// here): the word is the CHECKED set in canonical enum order, "auto"
// being the '' rows — unchecking Auto hands the five literal tokens to
// the store and the auto-format row drops out.
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Auto', false); // every format but the '' rows
await sleep(DEBOUNCE);
check(
  'Auto unchecked → format "int,float1,float2,percent,currency" — the canonical subset, the auto-format row gone',
  JSON.stringify(pageCalls[0]) ===
    JSON.stringify(['', '', '', '', 'int,float1,float2,percent,currency', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'my_kd', 'plug_stat']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Auto', true);
for (const l of ['Int', 'Float1', 'Float2', 'Currency']) await setBox(r, l, false);
await sleep(DEBOUNCE);
check(
  'Auto + Percent only → format "auto,percent" — the auto bucket and the percent rows in one window',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', 'auto,percent', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'adr_avg']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Auto', false);
await setBox(r, 'Percent', false);
await sleep(DEBOUNCE);
check(
  'every Type box off → format "none" — the same legal empty read as the pair groups',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', 'none', 0, 100]) &&
    rowsOf(r).length === 0 &&
    r.textContent.includes('No metrics to show.'),
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
services.invalidate();
pageCalls.length = 0;
for (const l of FMT_LABELS) await setBox(r, l, true);
await sleep(DEBOUNCE);
check(
  'all six Type boxes back on → format "" — the whole catalog window again',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
// Hand a CLOSED panel to the untouched sections below (D/E/F open
// nothing; G reopens it).
await closeFilters(r);

console.log('D. a built-in row loads the editor READ-ONLY: Save disabled, chip present, no delete');
{
  const bRow = rowNamed(r, 'trade_rate');
  const uRow = rowNamed(r, 'adr_avg');
  const pRow = rowNamed(r, 'plug_stat');
  const saveBtn = () => saveButton(r);
  const chip = () => formChip(r);
  const REASON = "Built-in metrics can't be edited";

  check('the builtin row renders', !!bRow, JSON.stringify(namesOf(r)));
  check(
    'the builtin row main area is a button, like every other row',
    !!bRow && !!bRow.querySelector('button.bld-row-main'),
    bRow ? [...bRow.children].map((c) => c.className || c.tagName).join(' | ') : 'no row',
  );
  check(
    'the builtin row has NO delete control',
    !!bRow && !bRow.querySelector('[aria-label="Delete trade_rate"]'),
    bRow ? bRow.innerHTML.slice(0, 200) : 'no row',
  );
  check(
    'the builtin row keeps pin + preview',
    !!bRow &&
      !!bRow.querySelector('[aria-label="Toggle pin for trade_rate"]') &&
      !!bRow.querySelector('[aria-label="Preview trade_rate"]'),
  );
  check(
    'a user row still HAS a delete control',
    !!uRow && !!uRow.querySelector('[aria-label="Delete adr_avg"]'),
    uRow ? [...uRow.children].map((c) => c.className || c.tagName).join(' | ') : 'no row',
  );
  check(
    // w19 23b: the row's destructive glyph is the ONE app-wide trash
    // icon (it was the ✕, which reads "dismiss").
    'the user row delete wears the trash glyph, never the ✕',
    !!uRow?.querySelector('[aria-label="Delete adr_avg"] .codicon-trash') &&
      !uRow?.querySelector('[aria-label="Delete adr_avg"] .codicon-close'),
    uRow?.querySelector('[aria-label="Delete adr_avg"]')?.innerHTML ?? 'no delete',
  );
  // The builtin still pins (round trip — the pin state is left as found).
  const pinBtn = bRow.querySelector('[aria-label="Toggle pin for trade_rate"]');
  click(pinBtn);
  await sleep(40);
  check(
    'the builtin row still pins (title flips to Unpin + the on-class)',
    pinBtn.classList.contains('bld-pin-on') &&
      pinBtn.getAttribute('title') === 'Unpin from scoreboard',
    `class=${pinBtn.className} title=${pinBtn.getAttribute('title')}`,
  );
  click(pinBtn);
  await sleep(40);

  // The form is untouched: heading "New metric", empty name field.
  check('the form starts at "New metric"', heading(r) === 'New metric', heading(r));
  click(bRow.querySelector('button.bld-row-main'));
  await sleep(60);
  check(
    'clicking the builtin row loads it into the editor',
    heading(r) === 'Edit metric' && r.querySelector('#bld-name')?.value === 'trade_rate',
    `heading=${heading(r)} name=${r.querySelector('#bld-name')?.value}`,
  );
  check(
    'the loaded definition fills every field (title, expression, scope, format, denominator, doc)',
    r.querySelector('#bld-title')?.value === 'Trade rate' &&
      (r.querySelector('#bld-expr')?.value || '').includes('ratio(sum(trade_kills)') &&
      r.querySelector('#bld-scope')?.value === 'match' &&
      r.querySelector('#bld-format')?.value === 'percent' &&
      r.querySelector('#bld-denom')?.value === 'rounds' &&
      (r.querySelector('#bld-doc')?.value || '').includes('trade successes'),
    `title=${r.querySelector('#bld-title')?.value} denom=${r.querySelector('#bld-denom')?.value}`,
  );
  // The built-in's contents are READ-ONLY but not DISABLED (owner
  // wave): readonly blocks backspace/delete/caret editing while the
  // text stays selectable and copyable — a disabled input would be
  // greyed out and unselectable in WebKit. The three selects take
  // disabled instead (a dropdown is not a copy surface).
  check(
    'the three text inputs are readonly for a built-in (never disabled — selection/copy stays live)',
    ['bld-name', 'bld-title', 'bld-short'].every((id) => {
      const el = r.querySelector('#' + id);
      return el && el.readOnly === true && el.disabled === false;
    }),
    ['bld-name', 'bld-title', 'bld-short']
      .map((id) => {
        const el = r.querySelector('#' + id);
        return `${id}:readOnly=${el?.readOnly} disabled=${el?.disabled}`;
      })
      .join(' '),
  );
  check(
    'the two textareas (Doc, Expression) are readonly for a built-in, not disabled',
    ['bld-doc', 'bld-expr'].every((id) => {
      const el = r.querySelector('#' + id);
      return el && el.readOnly === true && el.disabled === false;
    }),
    ['bld-doc', 'bld-expr']
      .map((id) => {
        const el = r.querySelector('#' + id);
        return `${id}:readOnly=${el?.readOnly} disabled=${el?.disabled}`;
      })
      .join(' '),
  );
  check(
    'the three selects (Scope, Denominator, Format) are disabled for a built-in',
    ['bld-scope', 'bld-denom', 'bld-format'].every((id) => {
      const el = r.querySelector('#' + id);
      return el && el.disabled === true;
    }),
    ['bld-scope', 'bld-denom', 'bld-format']
      .map((id) => `${id}:disabled=${r.querySelector('#' + id)?.disabled}`)
      .join(' '),
  );
  // The form's TWO FIXED ROWS (owner ruling, origin-independent — it
  // pins .bld-fields markup, not the built-in state): row 1 Name /
  // Title / Short name, row 2 Scope / Denominator / Format, then the
  // full-width Doc and Expression rows underneath. ALL eight fields in
  // DOM order, deep-equalled: a reorder, a dropped field or a new one
  // spliced in anywhere fails loudly. The wide pair is included on
  // purpose — "Doc/Expression last and full-width" is part of the same
  // ruling, so their position is worth the same pin.
  const fieldIds = [...r.querySelectorAll('.bld-fields .bld-field')].map(
    (f) => f.querySelector('[id]')?.id ?? '',
  );
  check(
    'the form fields sit in the two fixed rows (Name/Title/Short · Scope/Denominator/Format, then Doc/Expression)',
    JSON.stringify(fieldIds) ===
      JSON.stringify([
        'bld-name',
        'bld-title',
        'bld-short',
        'bld-scope',
        'bld-denom',
        'bld-format',
        'bld-doc',
        'bld-expr',
      ]),
    JSON.stringify(fieldIds),
  );
  check(
    'the read-only chip is present, worded for the user',
    !!chip() && chip().textContent.trim() === 'built-in' && chip().getAttribute('title') === REASON,
    chip() ? `${chip().className} title=${chip().getAttribute('title')}` : 'no chip',
  );
  check(
    'Save is DISABLED and states the reason',
    !!saveBtn() &&
      saveBtn().disabled &&
      saveBtn().getAttribute('title') === REASON &&
      saveBtn().textContent.trim() === 'Save metric',
    saveBtn()
      ? `disabled=${saveBtn().disabled} text="${saveBtn().textContent.trim()}" title=${saveBtn().getAttribute('title')}`
      : 'no Save button',
  );
  // w19 item 23: the editor delete is USER-metric-only — a loaded
  // built-in gets neither the control nor the extra slot (the footer
  // keeps exactly its two children, validity slot first).
  {
    const actions = r.querySelector('.bld-actions');
    const kids = actions ? [...actions.children] : [];
    check(
      'the editor footer carries NO delete control for a loaded built-in (two slots, validity slot first)',
      kids.length === 2 &&
        kids[0].classList.contains('bld-valid') &&
        kids[1].classList.contains('toolbar') &&
        !actions.querySelector('[aria-label^="Delete"]'),
      JSON.stringify(kids.map((k) => k.className)),
    );
  }
  {
    // w19 item 2: the compact state chip rides the EDITOR HEADER, left
    // of the built-in chip (fresh here) — compareDocumentPosition pins
    // the ORDER, not just the presence.
    const head = r.querySelector('.bld-right > section.panel > .row-between');
    const status = head?.querySelector('.chip.status');
    const ro = head?.querySelector('.bld-readonly');
    check(
      'the state chip renders in the editor header, before the built-in chip',
      !!head &&
        !!status &&
        !!ro &&
        (status.compareDocumentPosition(ro) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
        status.textContent.trim() === 'fresh',
      status
        ? `status="${status.textContent.trim()}" ro=${!!ro}`
        : 'no status chip in the editor header',
    );
  }
  check(
    // N6: the hint keeps its .bld-actions .bld-note home — it moved
    // from AFTER the buttons to the front of the right cluster, so the
    // check's NAME says cluster now (the selector is unchanged).
    'the note in the actions cluster repeats the same reason',
    (r.querySelector('.bld-actions .bld-note')?.textContent || '').includes(REASON),
    r.querySelector('.bld-actions .bld-note')?.textContent?.replace(/\s+/g, ' ').trim(),
  );

  // Dirtying the form must NEVER re-enable Save for a loaded built-in.
  type(r.querySelector('#bld-name'), 'trade_rate_edited');
  await sleep(20);
  check(
    'editing the loaded built-in keeps Save disabled (the dirty flag never re-enables it)',
    !!saveBtn() && saveBtn().disabled && !!chip() && heading(r) === 'Edit metric',
    `disabled=${saveBtn().disabled} chip=${!!chip()}`,
  );

  // → a USER row restores the fully editable state.
  click(uRow.querySelector('button.bld-row-main'));
  await sleep(60);
  check(
    'loading a user metric restores the editable state (Save on, no chip)',
    heading(r) === 'Edit metric' &&
      r.querySelector('#bld-name')?.value === 'adr_avg' &&
      !saveBtn().disabled &&
      !chip(),
    `name=${r.querySelector('#bld-name')?.value} disabled=${saveBtn().disabled} chip=${!!chip()}`,
  );
  check(
    'the user metric lifts every readonly/disabled gate off the fields',
    ['bld-name', 'bld-title', 'bld-short', 'bld-doc', 'bld-expr'].every(
      (id) => r.querySelector('#' + id)?.readOnly === false,
    ) &&
      ['bld-scope', 'bld-denom', 'bld-format'].every((id) => r.querySelector('#' + id)?.disabled === false),
    ['bld-name', 'bld-doc', 'bld-scope', 'bld-format']
      .map((id) => {
        const el = r.querySelector('#' + id);
        return `${id}:readOnly=${el?.readOnly} disabled=${el?.disabled}`;
      })
      .join(' '),
  );

  // → back to the built-in: read-only again.
  click(bRow.querySelector('button.bld-row-main'));
  await sleep(60);
  check(
    'loading the built-in again re-disables Save and brings the chip back',
    r.querySelector('#bld-name')?.value === 'trade_rate' && !!saveBtn()?.disabled && !!chip(),
    `disabled=${saveBtn()?.disabled} chip=${!!chip()}`,
  );

  // → a PLUGIN row keeps its OWN chip with an enabled Save (it forks).
  click(pRow.querySelector('button.bld-row-main'));
  await sleep(60);
  check(
    'a plugin row loads with the plugin chip and an enabled Save (fork-on-save)',
    r.querySelector('#bld-name')?.value === 'plug_stat' &&
      !!chip() &&
      chip().textContent.trim() === 'read-only source' &&
      !saveBtn().disabled,
    `name=${r.querySelector('#bld-name')?.value} chip=${chip() && chip().textContent.trim()} disabled=${saveBtn().disabled}`,
  );
  {
    // w19 item 23: plugins are the loader's territory — the editor
    // footer carries no delete control for them either.
    const actions = r.querySelector('.bld-actions');
    const kids = actions ? [...actions.children] : [];
    check(
      'the editor footer carries NO delete control for a plugin metric (two slots)',
      kids.length === 2 && !actions.querySelector('[aria-label^="Delete"]'),
      JSON.stringify(kids.map((k) => k.className)),
    );
  }

  // --- N3: the short-name cap -----------------------------------------------
  // maxlength stops new typing at six characters; this guard is what
  // reports a value that is ALREADY over it (loaded from a stale seed
  // or pasted): a plain reject through saveError with the field-level
  // message, before any round trip — never a silent truncation.
  check(
    'the short-name field caps typing at six characters (maxlength)',
    r.querySelector('#bld-short')?.getAttribute('maxlength') === '6',
    r.querySelector('#bld-short')?.getAttribute('maxlength'),
  );
  {
    const savesBefore = bindings.callCount('SaveMetric');
    type(r.querySelector('#bld-short'), '1234567');
    await sleep(20);
    click(saveButton(r));
    await sleep(60);
    check(
      'an over-limit short name refuses to save with its own message (no API call, no truncation)',
      (r.querySelector('p.error')?.textContent || '').includes('Short name must be 6 characters or fewer') &&
        bindings.callCount('SaveMetric') === savesBefore &&
        r.querySelector('#bld-short').value === '1234567',
      `err="${r.querySelector('p.error')?.textContent}" saves ${savesBefore} -> ${bindings.callCount('SaveMetric')}`,
    );
  }

  // → New resets everything (the reset transition, both ways pinned).
  const newBtn = [...r.querySelectorAll('.bld-list button')].find((b) => b.textContent.includes('New'));
  click(newBtn);
  await sleep(60);
  check(
    'New resets to the fresh editable state (heading, empty form, Save on, no chip)',
    heading(r) === 'New metric' &&
      r.querySelector('#bld-name')?.value === '' &&
      !saveBtn().disabled &&
      !chip(),
    `heading=${heading(r)} name=${r.querySelector('#bld-name')?.value} disabled=${saveBtn().disabled} chip=${!!chip()}`,
  );
}

console.log('E. the builtin PREVIEWS from its STORED rows — a saved read never calculates');
previewCalls.length = 0;
storedCalls.length = 0;
compileCalls.length = 0;
{
  const bRow = rowNamed(r, 'trade_rate');
  click(bRow.querySelector('[aria-label="Preview trade_rate"]'));
  await sleep(120);
  check(
    'the saved preview read the stored rows for the newest ready match',
    JSON.stringify(storedCalls[0]) === JSON.stringify([9, [1]]),
    JSON.stringify(storedCalls[0]),
  );
  check(
    'PreviewMetric was NOT called — saved + unmodified reads stored (design §5)',
    previewCalls.length === 0,
    JSON.stringify(previewCalls),
  );
  check(
    'the provenance SQL came from the no-execution compile of that same match',
    JSON.stringify(compileCalls[0]) === JSON.stringify([1, '', 'match:9']),
    JSON.stringify(compileCalls[0]),
  );
  check(
    'the preview table renders',
    !!r.querySelector('.bld-preview table.data-table tbody tr'),
    r.querySelector('.bld-preview')?.textContent.replace(/\s+/g, ' ').slice(0, 160),
  );
  const valueCell = r.querySelector('.bld-preview table.data-table tbody tr td.num')?.textContent;
  check(
    "the value formats from the BUILTIN's stored format (percent), not the empty form",
    valueCell === '41.2%',
    String(valueCell),
  );
  const previewText = r.querySelector('.bld-preview')?.textContent || '';
  check(
    'the panel names the unit the stored rows came from (match stated)',
    previewText.includes('newest ready match #9') && previewText.includes('de_cache'),
    previewText.replace(/\s+/g, ' ').slice(0, 200),
  );
  check(
    'the saved preview shows the STATE indicator and no timing chip (it timed nothing)',
    !!r.querySelector('.bld-preview .toolbar .chip.status') &&
      ![...r.querySelectorAll('.bld-preview .toolbar .chip')].some((c) => /ms$/.test(c.textContent.trim())),
    r.querySelector('.bld-preview .toolbar')?.textContent.replace(/\s+/g, ' '),
  );
  {
    // w19 23c: the preview panel's state chip sits immediately LEFT of
    // the Preview button (position only — the chip itself is unchanged,
    // and the button's own finder above still resolves it).
    const chip = r.querySelector('.bld-preview .toolbar .chip.status');
    const btn = [...r.querySelectorAll('.bld-preview .toolbar button')].find((b) =>
      b.textContent.includes('Preview'),
    );
    check(
      'the preview panel state chip sits immediately left of the Preview button',
      !!chip && !!btn && btn.previousElementSibling === chip,
      chip && btn
        ? `prev=${btn.previousElementSibling?.className} chip=${chip.className}`
        : `chip=${!!chip} btn=${!!btn}`,
    );
  }
  check(
    'previewing a builtin still does NOT load the form',
    heading(r) === 'New metric' && r.querySelector('#bld-name')?.value === '',
    `heading=${heading(r)} name=${r.querySelector('#bld-name')?.value}`,
  );
  // The fresh state chip on the list item (the state vocabulary's
  // fifth word — the others are pinned in section I).
  {
    const chip = rowNamed(r, 'trade_rate')?.querySelector('.bld-row-sub .chip.status');
    check(
      'list item: fresh renders the ok chip',
      !!chip && chip.classList.contains('ok') && chip.textContent.trim() === 'fresh',
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
  }

  // --- The preview table sorts CLIENT-side (owner ruling, row 28) ---
  // The stub above returns THREE rows for this metric — alice n=13
  // (41.2%), bob n=7 (90%), carl n=3 (5%): N arrives already descending
  // (the default), the values are numeric where their percent TEXT is
  // not ("5%" < "41.2%" lexically, 5 > 41.2 never), and the labels mix
  // a name with two ids so a text sort is observable too.
  const pRows = () => [...r.querySelectorAll('.bld-preview table.data-table tbody tr')];
  const pCol = (i) => pRows().map((row) => row.querySelectorAll('td')[i]?.textContent);
  const pTh = () => [...r.querySelectorAll('.bld-preview table.data-table thead th button')];

  check(
    'preview rows default to N descending — highest N first (owner ruling)',
    JSON.stringify(pCol(3)) === JSON.stringify(['13', '7', '3']),
    JSON.stringify(pCol(3)),
  );

  click(pTh()[2]); // Value — a numeric column's natural direction is highest first
  await sleep(60);
  check(
    'the first click on Value sorts by VALUE, highest first (never the formatted text)',
    JSON.stringify(pCol(2)) === JSON.stringify(['90%', '41.2%', '5%']),
    JSON.stringify(pCol(2)),
  );
  click(pTh()[2]); // Value again
  await sleep(60);
  check(
    'a second click on Value flips to lowest first',
    JSON.stringify(pCol(2)) === JSON.stringify(['5%', '41.2%', '90%']),
    JSON.stringify(pCol(2)),
  );

  click(pTh()[3]); // N — inactive after the Value clicks → its natural direction
  await sleep(60);
  const nTh = r.querySelector('.bld-preview table.data-table thead th:nth-child(4)');
  check(
    'the first click on N sorts highest-first and marks that header active',
    JSON.stringify(pCol(3)) === JSON.stringify(['13', '7', '3']) &&
      nTh.querySelector('button')?.classList.contains('sorted') &&
      !!nTh.querySelector('.codicon-arrow-down'),
    `${JSON.stringify(pCol(3))} ${nTh.innerHTML.slice(0, 120)}`,
  );
  check(
    'the N header keeps its sample-size tooltip',
    (nTh.getAttribute('title') || '').length > 0,
    nTh.getAttribute('title'),
  );
  click(pTh()[3]); // N again
  await sleep(60);
  check(
    'a second click on N flips to lowest first',
    JSON.stringify(pCol(3)) === JSON.stringify(['3', '7', '13']),
    JSON.stringify(pCol(3)),
  );

  click(pTh()[1]); // Label — text columns start A→Z
  await sleep(60);
  check(
    'a text column sorts A→Z by its own text (the two ids before "alice")',
    JSON.stringify(pCol(1)) ===
      JSON.stringify(['76561198000000002', '76561198000000003', 'alice']),
    JSON.stringify(pCol(1)),
  );
}

console.log('F. a user row still loads the form for editing (unaffected)');
{
  const uRow = rowNamed(r, 'adr_avg');
  click(uRow.querySelector('button.bld-row-main'));
  await sleep(60);
  check(
    'clicking the user row loads it into the form',
    heading(r) === 'Edit metric' && r.querySelector('#bld-name')?.value === 'adr_avg',
    `heading=${heading(r)} name=${r.querySelector('#bld-name')?.value}`,
  );
  await sleep(500); // the 400 ms expression check lands on its scripted "valid"
  check(
    'the live expression check resolves valid for the loaded row',
    !!r.querySelector('.bld-expr-state.ok'),
    r.querySelector('.bld-expr-state')?.textContent ?? 'no state line',
  );

  // --- N6: ONE actions line (the lead's W1/T1 pattern) ----------------------
  // The validity indicator and the hint + Pin + Save cluster share a
  // single row; the cluster is its LAST child, and the indicator lives
  // there (never under the textarea — there is exactly ONE). w19 item
  // 23 added a third slot on a USER metric: the editor delete LEADS
  // the line (destructive left, positive actions right), so on this
  // loaded user row the children are delete → validity slot → cluster.
  const actions = r.querySelector('.bld-actions');
  const aKids = actions ? [...actions.children] : [];
  check(
    'N6: the actions row is one line — on a user metric the delete leads it, then the validity slot, then the hint→Pin→Save cluster LAST',
    aKids.length === 3 &&
      !!aKids[0]?.querySelector('.codicon-trash') &&
      aKids[0].classList.contains('danger') &&
      aKids[0].getAttribute('aria-label') === 'Delete adr_avg' &&
      aKids[0].getAttribute('title') === 'Delete metric' &&
      aKids[1].classList.contains('bld-valid') &&
      aKids[2].classList.contains('toolbar'),
    JSON.stringify(aKids.map((k) => k.className)),
  );
  check(
    'N6: the validity indicator lives in its own slot — nothing renders under the Expression textarea',
    !!aKids[1]?.querySelector('.bld-expr-state.ok') && !r.querySelector('.bld-fields .bld-expr-state'),
    r.querySelector('.bld-fields .bld-expr-state') ? 'still under the textarea' : 'moved',
  );
  check(
    // w19 item 23: DOM order — the destructive action precedes Save
    // (Save itself keeps its codicon-save, checked in the cluster pin
    // below).
    'the editor delete precedes Save in the actions line',
    (() => {
      const del = aKids[0];
      const save = actions?.querySelector('.toolbar .btn.primary');
      return (
        !!del &&
        !!save &&
        !!del.querySelector('.codicon-trash') &&
        (del.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      );
    })(),
    JSON.stringify(aKids.map((k) => k.className)),
  );
  {
    const cluster = aKids[2] ? [...aKids[2].children] : [];
    check(
      'N6: the cluster runs hint → Pin → Save, no divider and no separator',
      cluster.length === 3 &&
        cluster[0].classList.contains('bld-note') &&
        !!cluster[1].querySelector('.codicon-pin') &&
        /^Pin(ned)?$/.test(cluster[1].textContent.trim()) &&
        cluster[2].classList.contains('btn') &&
        cluster[2].classList.contains('primary') &&
        !!cluster[2].querySelector('.codicon-save') &&
        !actions.querySelector('.toolbar-sep') &&
        !/\|/.test(actions.textContent),
      JSON.stringify(
        cluster.map((c) => c.className + ':' + c.textContent.trim().replace(/\s+/g, ' ')),
      ),
    );
  }
}

console.log('G. the search composes with the filters in ONE server call');
{
  const search = r.querySelector('input[type="search"][aria-label="Search metrics"]');
  services.invalidate();
  pageCalls.length = 0;
  await setBox(r, 'Built-in', false); // narrow the origin first…
  await sleep(DEBOUNCE);
  pageCalls.length = 0; // …so the typing below is the only call recorded
  type(search, 'adr');
  await sleep(DEBOUNCE);
  check(
    'typing restarts the window with BOTH narrowings: (query "adr", origin "mine", scope "", denominator "", format "", cursor 0, 100)',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['adr', 'mine', '', '', '', 0, 100]),
    JSON.stringify(pageCalls[0]),
  );
  check(
    'the composed server-side result renders (one row)',
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg']),
    JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  type(search, '');
  await sleep(DEBOUNCE);
  check(
    'clearing the query restores the mine partition window',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'mine', '', '', '', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  // The Type group composes in the SAME call: formats narrowed to Auto
  // alone (the other five off), then the search on top — one window,
  // three narrowings, the format word riding the same args as the rest.
  services.invalidate();
  pageCalls.length = 0;
  for (const l of ['Int', 'Float1', 'Float2', 'Percent', 'Currency']) await setBox(r, l, false);
  await sleep(DEBOUNCE);
  check(
    'formats narrowed to Auto alone → format "auto" — only the auto-format row survives in the mine partition',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'mine', '', '', 'auto', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  type(search, 'adr');
  await sleep(DEBOUNCE);
  check(
    'the search composes with origin AND format in ONE call: (query "adr", origin "mine", format "auto", …)',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['adr', 'mine', '', '', 'auto', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  type(search, '');
  for (const l of FMT_LABELS) await setBox(r, l, true);
  await sleep(DEBOUNCE);
  check(
    'clearing the query AND re-checking every Type box → the mine partition window again (format word back to "")',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'mine', '', '', '', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  await setBox(r, 'Built-in', true);
  await sleep(DEBOUNCE);
  check(
    'Built-in back checked → the whole catalog window again',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
    JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
  );
  // A Denominator SUBSET word composes with the search in the same ONE
  // call ({Rounds, None} → "rounds,none"): the fifth group's
  // render-time narrowing rides none of these args — section C pinned
  // that it issues no call of its own.
  services.invalidate();
  pageCalls.length = 0;
  await setBox(r, 'Matches', false); // {Rounds, None} → "rounds,none"
  await sleep(DEBOUNCE);
  pageCalls.length = 0; // …so the typing below is the only call recorded
  type(search, 'trade');
  await sleep(DEBOUNCE);
  check(
    'the Denominator subset composes with the search in ONE call: (query "trade", denominator "rounds,none", origin "", …)',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['trade', '', '', 'rounds,none', '', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  type(search, '');
  await setBox(r, 'Matches', true);
  await sleep(DEBOUNCE);
  check(
    'clearing the query and restoring the Denominator boxes → the whole catalog window again',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
    JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
  );
}

console.log('H. the filter checks are view-local registry state (restore all fifteen, then reset to defaults)');
{
  // Leave a DISTINCT state behind — one option off in EACH of the
  // Origin, Denominator and Type groups (the Pinning pair and the
  // Denominator NONE box stay on), so the restore proves every one of
  // the fifteen keys round-trips.
  services.invalidate();
  pageCalls.length = 0;
  await setBox(r, 'Built-in', false);
  await sleep(DEBOUNCE);
  services.invalidate();
  pageCalls.length = 0;
  await setBox(r, 'Matches', false);
  await sleep(DEBOUNCE);
  services.invalidate();
  pageCalls.length = 0;
  await setBox(r, 'Currency', false); // no currency row in the fixture — the rows below stand
  await sleep(DEBOUNCE);
  check(
    // Reading B re-pin (2026-11-16): Matches off with Rounds AND None
    // on sends the subset word "rounds,none" (the old "rounds" rows).
    'the parting state is mine + Rounds/None minus Currency (Built-in, Matches and Currency off)',
    JSON.stringify(pageCalls[pageCalls.length - 1]) ===
      JSON.stringify(['', 'mine', '', 'rounds,none', 'auto,int,float1,float2,percent', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'plug_stat']),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  r = await mountBuilder(); // unmount → remount, registry intact
  await openFilters(r);
  check(
    'unmount → remount restores ALL fifteen checks (only Built-in, Matches and Currency off)',
    JSON.stringify(fifteenOf(r)) ===
      JSON.stringify([false, true, true, true, true, false, true, true, true, true, true, true, false, true, true]),
    JSON.stringify(fifteenOf(r)),
  );
  check(
    '…and the restored view shows the restored rows',
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'plug_stat']),
    JSON.stringify(namesOf(r)),
  );
  viewstate.resetViewState();
  r = await mountBuilder();
  await openFilters(r);
  check(
    'resetViewState() → the next mount is back to the defaults (Built-in OFF / My metrics ON, every other option ON — Denominator all three, Type all six, Pinning both)',
    JSON.stringify(fifteenOf(r)) ===
      JSON.stringify([false, true, true, true, true, true, true, true, true, true, true, true, true, true, true]),
    JSON.stringify(fifteenOf(r)),
  );
  check(
    '…and the default view is the mine partition again',
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(namesOf(r)),
  );
  // Hand a CLOSED panel to the untouched sections below.
  await closeFilters(r);
}

console.log('I. compute-state surface: list chips, editor card, k/N progress, draft-vs-saved preview');
{
  const chipOf = (name) => rowNamed(r, name)?.querySelector('.bld-row-sub .chip.status');
  const editorPanel = () => r.querySelector('.bld-right > section.panel');
  const previewBtn = () =>
    [...r.querySelectorAll('.bld-preview .toolbar button')].find((b) =>
      b.textContent.includes('Preview'),
    );

  // Every list item wears its state chip (the scripted states: 2
  // behind, 3 failed, 4 processing — and 1 fresh, checked in E).
  {
    const chip = chipOf('adr_avg');
    check(
      'list item: behind renders the idle chip',
      !!chip && chip.classList.contains('idle') && chip.textContent.trim() === 'behind',
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
  }
  {
    const chip = chipOf('my_kd');
    check(
      'list item: failed renders the bad chip with the engine error as its title',
      !!chip &&
        chip.classList.contains('bad') &&
        chip.textContent.trim() === 'failed' &&
        chip.getAttribute('title') === 'upstream vanished',
      chip ? `${chip.className} title=${chip.getAttribute('title')}` : 'no chip',
    );
  }
  {
    const chip = chipOf('plug_stat');
    check(
      'list item: processing renders the busy chip',
      !!chip && chip.classList.contains('busy') && chip.textContent.includes('processing'),
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
  }

  // The editor card shows the loaded metric's state (adr_avg = behind).
  click(rowNamed(r, 'adr_avg').querySelector('button.bld-row-main'));
  await sleep(60);
  {
    const chip = editorPanel()?.querySelector('.chip.status');
    check(
      'editor card: the loaded metric shows its state chip (behind)',
      !!chip && chip.classList.contains('idle') && chip.textContent.trim() === 'behind',
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
    check(
      'no block progress while nothing runs for this metric',
      !editorPanel()?.querySelector('.bld-card-prog'),
      editorPanel()?.querySelector('.bld-card-prog')?.textContent ?? '',
    );
  }

  // The live feed flips BOTH surfaces to processing and quantifies:
  // the card goes block-form with the honest k/N underneath, the list
  // row keeps the compact inline bar (in-cell rule).
  fire('spectra:metric-progress', { metricId: 2, stage: 'compute', done: 2, total: 5 });
  await sleep(60);
  {
    const prog = editorPanel()?.querySelector('.bld-card-prog .chip-block');
    check(
      'editor card: processing shows the block indicator with "computing 2 of 5 metrics" underneath',
      !!prog && prog.textContent.includes('computing 2 of 5 metrics'),
      prog ? prog.textContent.replace(/\s+/g, ' ') : 'no block progress',
    );
    check(
      // w19 item 2: every state word but processing renders in the
      // header — so while the block form is up, the header carries NO
      // state chip (one progress widget, never both).
      'processing keeps the BLOCK form only — the editor header carries no state chip',
      !editorPanel()?.querySelector(':scope > .row-between .chip.status') &&
        !!editorPanel()?.querySelector('.bld-card-prog'),
      editorPanel()?.querySelector(':scope > .row-between')?.textContent.replace(/\s+/g, ' ') ??
        'no header',
    );
    const chip = chipOf('adr_avg');
    check(
      'list item: the same metric quantifies with the inline k/N bar',
      !!chip &&
        chip.classList.contains('busy') &&
        chip.textContent.includes('processing') &&
        !!chip.querySelector('.chip-bar') &&
        chip.textContent.includes('40%'),
      chip ? chip.textContent.replace(/\s+/g, ' ') : 'no chip',
    );
  }

  // metric-done: the sweep is over — the state read refetches and the
  // feed clears, so the card falls back to the refetched word.
  {
    const before = stateReads;
    fire('spectra:metric-done', { ok: true, error: '', metricIds: [2] });
    await sleep(80);
    check('metric-done refetches GetMetricComputeState', stateReads > before, `${before} -> ${stateReads}`);
    const chip = editorPanel()?.querySelector('.chip.status');
    check(
      'the feed cleared: the editor is back to the refetched behind chip',
      !editorPanel()?.querySelector('.bld-card-prog') &&
        !!chip &&
        chip.classList.contains('idle'),
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
  }

  // THE draft-vs-saved preview criterion: clean-saved form → stored
  // rows (no PreviewMetric); dirty draft → on-demand calculation.
  storedCalls.length = 0;
  previewCalls.length = 0;
  compileCalls.length = 0;
  click(previewBtn());
  await sleep(120);
  check(
    'clean-saved form preview reads stored rows (PreviewMetric untouched)',
    JSON.stringify(storedCalls[0]) === JSON.stringify([9, [2]]) && previewCalls.length === 0,
    `stored=${JSON.stringify(storedCalls)} preview=${JSON.stringify(previewCalls)}`,
  );

  type(r.querySelector('#bld-name'), 'adr_avg_edited'); // dirty the form
  await sleep(20);
  storedCalls.length = 0;
  previewCalls.length = 0;
  click(previewBtn());
  await sleep(120);
  check(
    'a dirty draft previews on demand through PreviewMetric (no stored read)',
    previewCalls.length === 1 && storedCalls.length === 0,
    `stored=${JSON.stringify(storedCalls)} preview=${JSON.stringify(previewCalls)}`,
  );
  check(
    'the ad-hoc preview keeps its timing chip (it genuinely computed)',
    [...r.querySelectorAll('.bld-preview .toolbar .chip')].some((c) =>
      /ms$/.test(c.textContent.trim()),
    ),
    r.querySelector('.bld-preview .toolbar')?.textContent.replace(/\s+/g, ' '),
  );

  // The no-version pin on this surface: no stamp, version number or
  // timestamp in any state chip, chip title, progress detail or the
  // preview toolbar.
  const leakRe = /version|\bv\d+\b|\d{4}-\d{2}-\d{2}|rule stamp|computed at/i;
  const leaks = [];
  for (const chip of r.querySelectorAll('.chip.status, .chip-block')) {
    const tip = chip.getAttribute('title') || '';
    if (leakRe.test(tip)) leaks.push(`title: ${tip}`);
    if (leakRe.test(chip.textContent || '')) leaks.push(`text: ${chip.textContent.trim()}`);
  }
  for (const w of r.querySelectorAll('.bld-preview .toolbar .chip')) {
    if (leakRe.test(w.textContent || '')) leaks.push(`toolbar: ${w.textContent.trim()}`);
  }
  check(
    'no version number or timestamp appears in any Builder state output',
    leaks.length === 0,
    leaks.join(' | '),
  );
}

console.log('J. the Order dialog: merged fixed+metric list, show/hide, right-aligned cluster, fixed title bar + one scroll region, unpin, no drag, write-through moves, Reset, header ✕');
{
  // Two opens: FIRST with nothing pinned — the honest empty state plus
  // the help line (the owner copy rule: user's domain, no dev
  // shorthand — the retired "fixed Go stats" phrase must be gone);
  // THEN after pinning three metrics from the Builder rows (the single
  // pins writer) — the reorder suite over the PINNED list only.
  const orderBtn = [...r.querySelectorAll('.bld-list button')].find((b) =>
    b.textContent.includes('Order'),
  );
  check(
    'the Order… button sits in the list header beside New, arrow-glyph pair',
    !!orderBtn &&
      !!orderBtn.querySelector('.codicon-arrow-up') &&
      !!orderBtn.querySelector('.codicon-arrow-down') &&
      [...(orderBtn.parentElement?.querySelectorAll('button') || [])].some((b) =>
        b.textContent.includes('New'),
      ),
    orderBtn ? orderBtn.textContent.replace(/\s+/g, ' ').trim() : 'no Order button',
  );

  bindings.resetCalls();
  click(orderBtn);
  await sleep(150);
  let dlg = document.querySelector('.dlg-panel.mo-prompt');
  check(
    'the dialog opens (mo-prompt panel with role=dialog)',
    !!dlg && dlg.getAttribute('role') === 'dialog',
    dlg ? 'open' : 'not found',
  );
  check(
    'both order prefs were read through their bare kvstore keys',
    ['metric_order_match', 'metric_order_profile'].every((k) =>
      bindings.calls.some((c) => c.method === 'GetPref' && c.args[0] === k),
    ),
    JSON.stringify(bindings.calls.filter((c) => c.method === 'GetPref').map((c) => c.args)),
  );

  // Closures over `dlg` — re-read on every use, so the second open
  // below re-queries through the same helpers.
  const sec = (scope) => dlg?.querySelector(`.mo-sec[data-mo-scope="${scope}"]`);
  const dRows = (scope) => [...(sec(scope)?.querySelectorAll('.mo-row') || [])];
  const dNames = (scope) => dRows(scope).map((x) => x.dataset.moName);

  check(
    'one dialog, two stacked sections (scoreboard then profile — no tabs)',
    [...(dlg?.querySelectorAll('.mo-sec-title') || [])].map((h) => h.textContent.trim()).join(' | ') ===
      'Scoreboard (match metrics) | Player profile (profile metrics)' &&
      !dlg?.querySelector('[role="tab"]'),
    [...(dlg?.querySelectorAll('.mo-sec-title') || [])].map((h) => h.textContent.trim()).join(' | '),
  );

  // The visible title bar (N2) — the KAST dialog's idiom: the label as
  // an <h2> with an icon-only ✕ at its right edge, ABOVE the note.
  const head = dlg?.querySelector(':scope > .row-between.mo-head');
  check(
    'N2: the dialog opens with a visible title bar — "Metric order" as an <h2> and an icon-only ✕ at its right edge',
    !!head &&
      head.querySelector(':scope > h2')?.textContent.trim() === 'Metric order' &&
      head.lastElementChild?.getAttribute('aria-label') === 'Close' &&
      !!head.lastElementChild?.querySelector('.codicon-close') &&
      head.querySelector('button') === head.lastElementChild,
    head ? head.textContent.replace(/\s+/g, ' ').trim() : 'no title bar',
  );

  // M1/M4/M5 — structure pins. jsdom has no layout, so the geometry
  // (right-alignment, the fixed title bar, the single scroll region)
  // is pinned as DOM structure + the component's own CSS source, the
  // N1 source-pin precedent (section A over style-m3a.css).
  {
    const headEl = dlg?.querySelector(':scope > .row-between.mo-head');
    const bodyEl2 = dlg?.querySelector(':scope > .mo-body');
    check(
      'M4: the title bar sits OUTSIDE the scroll region — a direct child of the panel, immediately above .mo-body',
      !!headEl &&
        !!bodyEl2 &&
        headEl.parentElement === dlg &&
        headEl.nextElementSibling === bodyEl2 &&
        !bodyEl2.contains(headEl),
      headEl && bodyEl2
        ? `parent-ok=${headEl.parentElement === dlg} adjacent=${headEl.nextElementSibling === bodyEl2}`
        : 'missing head/body',
    );
    const src = readFileSync('src/lib/components/MetricOrderDialog.svelte', 'utf8');
    const ruleOf = (sel) => (src.match(new RegExp(`(?:^|\\n)\\s*${sel}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
    const panelR = ruleOf(':global\\(\\.dlg-panel\\.mo-prompt\\)');
    const headR = ruleOf('\\.mo-head');
    const bodyR = ruleOf('\\.mo-body');
    const listR = ruleOf('\\.mo-list');
    check(
      'M4/M5: the panel clips, .mo-head is fixed and .mo-body is THE scroll region — .mo-list carries neither max-height nor overflow',
      /overflow:\s*hidden/.test(panelR) &&
        /flex:\s*0 0 auto/.test(headR) &&
        /min-height:\s*0/.test(bodyR) &&
        /overflow-y:\s*auto/.test(bodyR) &&
        !/max-height/.test(listR) &&
        !/overflow/.test(listR),
      `panel="${panelR.trim()}" head="${headR.trim()}" body="${bodyR.trim()}" list="${listR.trim()}"`,
    );
    const actsR = ruleOf('\\.mo-acts');
    const movesR = ruleOf('\\.mo-moves');
    check(
      'M1: the row controls cluster right — .mo-acts carries margin-left:auto and .mo-moves no longer does',
      /margin-left:\s*auto/.test(actsR) &&
        /display:\s*flex/.test(actsR) &&
        /align-items:\s*center/.test(actsR) &&
        !/margin-left/.test(movesR),
      `acts="${actsR.trim()}" moves="${movesR.trim()}"`,
    );
    const rowsC = dRows('match');
    check(
      'M1: every row rides ONE .mo-acts cluster (toggle + ↑↓ together) and the eye carries no title=',
      rowsC.length > 0 &&
        rowsC.every((x) => {
          const acts = x.querySelector(':scope > .mo-acts');
          const moves = x.querySelector('.mo-moves');
          const eye = x.querySelector('button[aria-label^="Show "], button[aria-label^="Hide "]');
          return (
            !!acts &&
            !!moves &&
            acts.contains(moves) &&
            (!eye || (acts.contains(eye) && !eye.hasAttribute('title')))
          );
        }),
      rowsC
        .map(
          (x) =>
            `${x.dataset.moName}:acts=${!!x.querySelector(':scope > .mo-acts')} eye-title=${x
              .querySelector('button[aria-label^="Show "], button[aria-label^="Hide "]')
              ?.hasAttribute('title')}`,
        )
        .join(', '),
    );
  }

  // The help line (reworded for N4: fixed stats are listed now, and
  // they can be hidden — the pins-only copy was wrong once they
  // folded into the list; M6: it names the unpin HERE instead of
  // pointing back at the metric list). Still the owner's domain, no
  // dev shorthand.
  const note = (dlg?.querySelector('.mo-note')?.textContent || '').replace(/\s+/g, ' ').trim();
  check(
    'help line: fixed stats AND pinned metrics, reorder with the arrows, hide with the eye, unpin here in the dialog; no dev-process phrase',
    /Fixed stats and your pinned metrics are listed/.test(note) &&
      /hide a fixed stat with the eye/.test(note) &&
      /unpin a metric here/.test(note) &&
      !/Go stats/i.test(dlg?.textContent || ''),
    note,
  );

  // N4: with nothing pinned the match section still lists the FIXED
  // stats — the old "nothing to order" / "no metrics yet" empty states
  // are gone (a fixed stat always has something to order and hide).
  check(
    'nothing pinned yet → the match section still lists the fixed stats in canonical order (no empty state, a real listbox)',
    !!sec('match') &&
      JSON.stringify(dNames('match')) ===
        JSON.stringify([
          '@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score',
        ]) &&
      !!sec('match').querySelector('[role="listbox"]') &&
      !sec('match').querySelector('p[role="status"]'),
    sec('match')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
  );
  check(
    'the profile section lists its fixed stats (Matches, Win%) even with an empty catalog',
    JSON.stringify(dNames('profile')) === JSON.stringify(['@Matches', '@Win%']),
    JSON.stringify(dNames('profile')),
  );
  {
    const closeBtn = head?.querySelector('button[aria-label="Close"]');
    click(closeBtn);
    await sleep(60);
    check('the header ✕ dismisses the empty dialog', !document.querySelector('.dlg-panel.mo-prompt'));
  }

  // Pin three of the four match metrics from the Builder rows —
  // trade_rate stays UNPINNED, which is exactly what the list must
  // never show (the fixed stats are there by their own right).
  for (const name of ['adr_avg', 'my_kd', 'plug_stat']) {
    click(rowNamed(r, name)?.querySelector(`[aria-label="Toggle pin for ${name}"]`));
    await sleep(40);
  }

  bindings.resetCalls();
  click(orderBtn);
  await sleep(150);
  dlg = document.querySelector('.dlg-panel.mo-prompt');

  {
    // N4 (W6): the fixed stats FOLD INTO the one listbox — the
    // read-only .mo-fixed context block is gone, and the section's
    // caption now describes the list (aria-describedby) while the
    // listbox keeps its name from the section heading. Every row is a
    // real listbox option: fixed and metric alike.
    const secEl = sec('match');
    const fixed = secEl?.querySelector('.mo-fixed');
    const cap = secEl?.querySelector('.mo-fixed-cap');
    const list = secEl?.querySelector('.mo-list');
    const rows = [...(list?.querySelectorAll('.mo-row') || [])];
    check(
      'N4: ONE listbox holds the fixed stats AND the pinned metrics — the read-only .mo-fixed block is gone, rows are unselected options',
      !fixed &&
        list?.getAttribute('role') === 'listbox' &&
        list?.getAttribute('aria-labelledby') === secEl?.querySelector('.mo-sec-title')?.id &&
        list?.getAttribute('aria-describedby') === cap?.id &&
        /Fixed stats lead/.test(cap?.textContent || '') &&
        rows.length === 11 &&
        rows.every((x) => x.getAttribute('role') === 'option' && x.getAttribute('aria-selected') === 'false'),
      !fixed && list
        ? `rows=${rows.length} cap="${cap?.textContent.trim()}" desc=${list.getAttribute('aria-describedby')}`
        : 'the read-only block is back',
    );
  }
  check(
    'the list = the fixed stats (canonical order) then the pinned metrics in sequence order — the unpinned trade_rate never appears',
    JSON.stringify(dNames('match')) ===
      JSON.stringify([
        '@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score',
        'adr_avg', 'my_kd', 'plug_stat',
      ]) &&
      !dRows('match').some((x) => x.dataset.moName === 'trade_rate'),
    JSON.stringify(dNames('match')),
  );
  {
    // The show/hide toggle (N4/M1): every HIDEABLE fixed row carries
    // one — named Show/Hide {label} (never the word "pin": the eye is
    // visibility only; the PIN toggle on metric rows below is a
    // separate control), the Name column is EXEMPT (owner ruling), and
    // metric rows never carry a show/hide (their visibility is the pin
    // selection).
    const rows = dRows('match');
    const toggleFor = (row) => row.querySelector('button[aria-label^="Show "], button[aria-label^="Hide "]');
    check(
      'every hideable fixed row carries a Show/Hide toggle; the Name column is exempt; metric rows never carry one',
      rows.slice(1, 8).every((x) => x.dataset.moKind === 'fixed' && !!toggleFor(x)) &&
        !toggleFor(rows[0]) &&
        rows.slice(8).every((x) => x.dataset.moKind === 'metric' && !toggleFor(x)),
      rows
        .map((x) => `${x.dataset.moName}:${x.dataset.moKind}:${toggleFor(x)?.getAttribute('aria-label') ?? '-'}`)
        .join(', '),
    );
    check(
      'the toggle never says "pin" and starts exactly at Hide (nothing hidden yet)',
      rows.every((x) => !/pin/i.test(toggleFor(x)?.getAttribute('aria-label') || '')) &&
        rows[1].querySelector('button[aria-label="Hide Team"]') !== null,
      rows[1].querySelectorAll('button[aria-label]').length
        ? [...rows[1].querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).join(' | ')
        : 'no buttons',
    );
  }
  {
    const rows = dRows('match');
    check(
      'no drag source anywhere: nothing in the dialog is draggable and no row carries a grip handle — the ↑/↓ buttons are the only move path',
      rows.length === 11 &&
        !dlg.querySelector('[draggable]') &&
        rows.every((x) => !x.hasAttribute('draggable') && !x.querySelector('.mo-grip')),
      rows
        .map(
          (x) =>
            `${x.dataset.moName}:row-draggable=${x.hasAttribute('draggable')} grip=${!!x.querySelector('.mo-grip')}`,
        )
        .join(', '),
    );
  }
  {
    const rows = dRows('match');
    const label = (row) => row.querySelector('.mo-title')?.textContent.trim();
    const upFirst = rows[0]?.querySelector(`[aria-label="Move ${label(rows[0])} up"]`);
    const downFirst = rows[0]?.querySelector(`[aria-label="Move ${label(rows[0])} down"]`);
    const up0 = rows[8]?.querySelector('[aria-label="Move ADR average up"]');
    const down0 = rows[8]?.querySelector('[aria-label="Move ADR average down"]');
    const upLast = rows[10]?.querySelector('[aria-label="Move Plugin stat up"]');
    const downLast = rows[10]?.querySelector('[aria-label="Move Plugin stat down"]');
    check(
      'every row carries labelled ↑/↓ buttons (named for the row’s visible label); the boundary ones are disabled',
      !!upFirst && upFirst.disabled &&
        !!downFirst && !downFirst.disabled &&
        !!up0 && !up0.disabled &&
        !!down0 && !down0.disabled &&
        !!upLast && !upLast.disabled &&
        !!downLast && downLast.disabled,
      `first↑=${upFirst && upFirst.disabled} first↓=${downFirst && !downFirst.disabled} mid↑=${up0 && !up0.disabled} mid↓=${down0 && !down0.disabled} last↑=${upLast && !upLast.disabled} last↓=${downLast && downLast.disabled}`,
    );
  }
  {
    // W13b (2026-11-16) — the structured {name, short} fixed entries:
    // the row TITLE reads the FULL name (Kills), the mono slot carries
    // the SHORT (K) only when the two differ (Team never doubles to
    // "Team Team"). w19 item 5: a METRIC row now carries the same slot
    // from the metric's own short name (e.def.shortName) under the same
    // rule — ADR shows under "ADR average", while a metric with no
    // short name (my_kd) keeps NO slot (its title alone identifies it;
    // the old "Assists assists" title+name doubling stays dead). The
    // aria labels derive from the same visible full name (Hide Kills /
    // Move Kills up) while data-mo-name keeps the '@'-key identity
    // (pinned by the dNames lists above — unchanged).
    const rows = dRows('match');
    const kRow = rows.find((x) => x.dataset.moName === '@K');
    const teamRow = rows.find((x) => x.dataset.moName === '@Team');
    const metricRow = rows.find((x) => x.dataset.moName === 'adr_avg');
    const shortRow = rows.find((x) => x.dataset.moName === 'my_kd');
    const monos = (row) =>
      [...(row?.querySelectorAll('.mo-name') || [])].map((s) => s.textContent.trim());
    check(
      'the mono short slot shows K under Kills, nothing under Team (never "Team Team"), the metric short under its title, and nothing when a metric has no short name',
      kRow?.querySelector('.mo-title')?.textContent.trim() === 'Kills' &&
        JSON.stringify(monos(kRow)) === JSON.stringify(['K']) &&
        teamRow?.querySelector('.mo-title')?.textContent.trim() === 'Team' &&
        monos(teamRow).length === 0 &&
        JSON.stringify(monos(metricRow)) === JSON.stringify(['ADR']) &&
        JSON.stringify(monos(shortRow)) === JSON.stringify([]),
      `Kills title="${kRow?.querySelector('.mo-title')?.textContent ?? 'no row'}" monos=${JSON.stringify(monos(kRow))} Team monos=${JSON.stringify(monos(teamRow))} adr monos=${JSON.stringify(monos(metricRow))} my_kd monos=${JSON.stringify(monos(shortRow))}`,
    );
    check(
      "the fixed rows' aria labels derive from the visible FULL name — Hide Kills / Move Kills up and down; Team keeps Hide Team",
      !!kRow?.querySelector('button[aria-label="Hide Kills"]') &&
        !!kRow?.querySelector('button[aria-label="Move Kills up"]') &&
        !!kRow?.querySelector('button[aria-label="Move Kills down"]') &&
        !!teamRow?.querySelector('button[aria-label="Hide Team"]'),
      (kRow || teamRow)
        ? [...(kRow?.querySelectorAll('button[aria-label]') || [])].map((b) => b.getAttribute('aria-label')).join(' | ')
        : 'no fixed row',
    );
  }
  {
    const rows = dRows('match');
    const from = dNames('match').indexOf('adr_avg');
    rows[from].focus();
    rows[from].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await sleep(80);
    check(
      'ArrowDown on the focused metric row moves it one slot down (the fixed rows above stay put)',
      JSON.stringify(dNames('match')) ===
        JSON.stringify([
          '@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score',
          'my_kd', 'adr_avg', 'plug_stat',
        ]),
      JSON.stringify(dNames('match')),
    );
    const sets = bindings.calls.filter((c) => c.method === 'SetPref' && c.args[0] === 'metric_order_match');
    const set = sets[sets.length - 1];
    check(
      'the move is write-through: SetPref carries the key AND the whole merged sequence — fixed stats and the unpinned entry keep their slots',
      !!set &&
        JSON.stringify(set.args[1]) ===
          JSON.stringify([
            '@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score',
            'trade_rate', 'my_kd', 'adr_avg', 'plug_stat',
          ]),
      set ? JSON.stringify(set.args) : 'no SetPref call',
    );
  }
  {
    // Focus follows the moved row — pinned through the BUTTON path: a
    // keyboard move re-focuses the same DOM node (the keyed each moves
    // nodes), so only a button click on a NON-focused row can prove
    // focusRow ran. The move also leaves a non-default sequence behind,
    // which is what the reset check below must undo.
    const btn = dRows('match')
      .find((x) => x.dataset.moName === 'plug_stat')
      ?.querySelector('[aria-label="Move Plugin stat up"]');
    click(btn);
    await sleep(80);
    check(
      'focus follows the row moved by its button',
      document.activeElement?.dataset?.moName === 'plug_stat' &&
        dNames('match').slice(8).join(',') === 'my_kd,plug_stat,adr_avg',
      `${document.activeElement?.className ?? 'none'} seq=${JSON.stringify(dNames('match').slice(8))}`,
    );
  }
  {
    // The show/hide WRITE: Team hides, the ROW STAYS LISTED (the owner's
    // requirement — the toggle never removes a row from the ordering
    // view) with its hidden mark and the Show label, and only the
    // visibility key is written (the order pref is untouched).
    const rows = dRows('match');
    const teamRow = rows.find((x) => x.dataset.moName === '@Team');
    const hideBtn = teamRow?.querySelector('button[aria-label="Hide Team"]');
    const ordersBefore = bindings.calls.filter(
      (c) => c.method === 'SetPref' && c.args[0] === 'metric_order_match',
    ).length;
    click(hideBtn);
    await sleep(80);
    const hiddenSet = bindings.calls.find(
      (c) => c.method === 'SetPref' && c.args[0] === 'metric_hidden_match',
    );
    const teamAfter = dRows('match').find((x) => x.dataset.moName === '@Team');
    check(
      'hiding a fixed stat writes the VISIBILITY pref and the row stays listed (marked hidden, offered as Show)',
      !!hiddenSet &&
        JSON.stringify(hiddenSet.args[1]) === JSON.stringify(['@Team']) &&
        !!teamAfter &&
        teamAfter.classList.contains('mo-hidden') &&
        teamAfter.querySelector('[aria-label="Show Team"]') !== null &&
        /hidden/.test(teamAfter.textContent) &&
        dRows('match').length === 11 &&
        bindings.calls.filter((c) => c.method === 'SetPref' && c.args[0] === 'metric_order_match').length === ordersBefore,
      teamAfter
        ? `class=${teamAfter.className} label=${teamAfter.querySelector('button[aria-label^="Sh"]')?.getAttribute('aria-label')} set=${JSON.stringify(hiddenSet && hiddenSet.args)}`
        : 'row gone',
    );
  }
  {
    // M6 — the old "no pin indicator, no pin control anywhere" ban,
    // INVERTED by design: a pin toggle now rides the METRIC rows (it
    // unpins through Builder's writer), fixed rows carry none, and the
    // eye still never says "pin" — its Show/Hide aria is untouched.
    // The pin button's title composes the SAME catalog wording
    // Builder's row button shows (byte-identical: 'Unpin from …').
    const rows = dRows('match');
    const metricRows = rows.filter((x) => x.dataset.moKind === 'metric');
    const fixedRows = rows.filter((x) => x.dataset.moKind === 'fixed');
    const pinOf = (row) => row.querySelector('[aria-label^="Toggle pin"]');
    const eyes = rows
      .map((x) => x.querySelector('button[aria-label^="Show "], button[aria-label^="Hide "]'))
      .filter(Boolean);
    check(
      'the pin control exists on metric rows ONLY (fixed rows carry none) and the eye still never says "pin"',
      metricRows.length === 3 &&
        metricRows.every(
          (x) =>
            pinOf(x)?.getAttribute('aria-label') === `Toggle pin for ${x.dataset.moName}` &&
            pinOf(x)?.getAttribute('title') === 'Unpin from scoreboard',
        ) &&
        fixedRows.every((x) => !pinOf(x)) &&
        eyes.length === 7 &&
        eyes.every((b) => !/pin/i.test(b.getAttribute('aria-label') || '')),
      rows
        .map(
          (x) =>
            `${x.dataset.moName}:${x.dataset.moKind}:pin=${pinOf(x)?.getAttribute('title') ?? '-'}`,
        )
        .join(', '),
    );
  }
  {
    const resetBtn = [...dlg.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Reset order'),
    );
    click(resetBtn);
    await sleep(80);
    const dels = bindings.calls.filter((c) => c.method === 'Delete');
    check(
      'Reset order deletes BOTH pref PAIRS — the order keys and the hidden keys (the lead: visibility resets too)',
      JSON.stringify(dels.map((c) => c.args[0]).sort()) ===
        JSON.stringify([
          'metric_hidden_match',
          'metric_hidden_profile',
          'metric_order_match',
          'metric_order_profile',
        ]),
      JSON.stringify(dels.map((c) => c.args)),
    );
    check(
      'the list snaps back to the DEFAULT sequence (fixed stats + the pinned metrics, default order) after reset',
      JSON.stringify(dNames('match')) ===
        JSON.stringify([
          '@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score',
          'adr_avg', 'my_kd', 'plug_stat',
        ]),
      JSON.stringify(dNames('match')),
    );
    const teamBack = dRows('match').find((x) => x.dataset.moName === '@Team');
    check(
      'Reset also SHOWS the hidden Team again (its row carries Hide, no hidden mark)',
      !!teamBack && !teamBack.classList.contains('mo-hidden') && !!teamBack.querySelector('button[aria-label="Hide Team"]'),
      teamBack ? `class=${teamBack.className}` : 'row gone',
    );
  }
  {
    // M6 — unpin from the ORDERING dialog (the writer stays in Builder):
    // the click routes through onTogglePin → togglePin, which writes
    // BOTH pin keys (localStorage) and never metric_order_* (the
    // kvstore — the sequence keeps the slot for re-pinning); the row
    // leaves .mo-list at once and focus moves to the row that took its
    // place. adr_avg is still loaded in the editor from section I, so
    // BOTH Builder surfaces flip behind the dialog in the same click.
    const pinsKey = 'spectra:pinned-metrics';
    const profileKey = 'spectra:pinned-profile-metrics';
    const before = JSON.parse(localStorage.getItem(pinsKey) || '[]');
    const orderWrites = bindings.calls.filter(
      (c) => c.method === 'SetPref' && c.args[0] === 'metric_order_match',
    ).length;
    const setKeys = [];
    const origSet = dom.window.Storage.prototype.setItem;
    dom.window.Storage.prototype.setItem = function (k, v) {
      setKeys.push(k);
      return origSet.call(this, k, v);
    };
    const dlgPin = dRows('match')
      .find((x) => x.dataset.moName === 'adr_avg')
      ?.querySelector('[aria-label^="Toggle pin"]');
    if (dlgPin) click(dlgPin);
    await sleep(80);
    dom.window.Storage.prototype.setItem = origSet;
    const after = JSON.parse(localStorage.getItem(pinsKey) || '[]');
    const rowGone = !dNames('match').includes('adr_avg');
    const focused = document.activeElement?.dataset?.moName;
    check(
      'unpin writes BOTH pin keys (never the order pref), drops the row from the list at once and focuses the neighbouring row',
      setKeys.includes(pinsKey) &&
        setKeys.includes(profileKey) &&
        after.length === before.length - 1 &&
        after.every((x) => before.includes(x)) &&
        bindings.calls.filter((c) => c.method === 'SetPref' && c.args[0] === 'metric_order_match')
          .length === orderWrites &&
        rowGone &&
        focused === 'my_kd',
      `keys=${JSON.stringify(setKeys)} pins ${JSON.stringify(before)} → ${JSON.stringify(after)} rowGone=${rowGone} focus=${focused} dlgPin=${!!dlgPin}`,
    );
    const rowBtn = rowNamed(r, 'adr_avg')?.querySelector('[aria-label="Toggle pin for adr_avg"]');
    const editorBtn = [...(r.querySelectorAll('.bld-actions .toolbar button') || [])].find((b) =>
      b.querySelector('.codicon-pin'),
    );
    check(
      'Builder flips behind the dialog — the list row AND the editor Pin button both return to the unpinned state',
      !!rowBtn &&
        rowBtn.getAttribute('title') === 'Pin as scoreboard column' &&
        !rowBtn.classList.contains('bld-pin-on') &&
        !!editorBtn &&
        editorBtn.textContent.trim() === 'Pin' &&
        !editorBtn.classList.contains('bld-pin-on'),
      `row title=${rowBtn?.getAttribute('title')} class=${rowBtn?.className} editor="${editorBtn?.textContent.trim()}" class=${editorBtn?.className}`,
    );
  }
  {
    // w22 (2026-11-16) — NAME-keyed pins: deleting a PINNED user metric
    // scrubs its NAME from BOTH pin keys (the delete-scrub survives the
    // id → name flip) and the write carries names only — never an id.
    // my_kd is pinned from the row-pin loop above and unpinned only for
    // adr_avg by M6, so it is the live pinned user metric here.
    const pinsKey = 'spectra:pinned-metrics';
    const profileKey = 'spectra:pinned-profile-metrics';
    const pinsBefore = JSON.parse(localStorage.getItem(pinsKey) || '[]');
    const delBtn = rowNamed(r, 'my_kd')?.querySelector('[aria-label="Delete my_kd"]');
    click(delBtn);
    await sleep(80);
    const pinsAfter = JSON.parse(localStorage.getItem(pinsKey) || '[]');
    const profAfter = JSON.parse(localStorage.getItem(profileKey) || '[]');
    check(
      'deleting a pinned metric scrubs its NAME from BOTH pin keys (the write is names-only, and DeleteMetric got the id)',
      !!delBtn &&
        pinsBefore.includes('my_kd') &&
        !pinsAfter.includes('my_kd') &&
        pinsAfter.every((x) => pinsBefore.includes(x)) &&
        !profAfter.includes('my_kd') &&
        pinsAfter.every((x) => typeof x === 'string') &&
        bindings.calls.some((c) => c.method === 'DeleteMetric' && c.args[0] === 3),
      `pins ${JSON.stringify(pinsBefore)} → ${JSON.stringify(pinsAfter)} profile=${JSON.stringify(profAfter)} delBtn=${!!delBtn}`,
    );
  }
  {
    const closeBtn = dlg.querySelector('button[aria-label="Close"]');
    click(closeBtn);
    await sleep(60);
    check('the header ✕ dismisses the dialog', !document.querySelector('.dlg-panel.mo-prompt'));
  }
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
