import './compile-worker-node.mjs';
// jsdom driver for the metrics Builder's list UX (owner wave A: the
// built-in editor load + the origin/format filter groups + the
// denominator chip; the filter UI is now ONE multi-select; the Type
// group = the format filter; w13c 2026-11-16 — Reading B's third
// Denominator box (None) and the fifth render-time Pinning group;
// 2026-11-17 — the Origin group gained its third box (Plugin), its
// middle box relabelled Custom, and the origin word became the checked
// set's canonical comma-subset ("user,plugin" — the old "mine").
// Section labels below match the run's console.log letters:
//   A. the ONE filter multi-select (a Filters trigger opens the
//      canonical Popover's checkbox panel with six labelled groups —
//      Origin (Built-in|Custom|Plugin), Scope (Match|Profile),
//      Subject (Player|Match|Team — the metrics subject axis),
//      Denominator (Rounds|Matches|None), Type (Auto|Int|Float1|Float2|
//      Percent|Currency), Pinning (Pinned|Unpinned); defaults: Built-in
//      OFF / Custom + Plugin ON (the owner's standing ruling — every
//      non-builtin origin), every OTHER
//      option ON — the owner's addendum, the Type ruling ("all six
//      checked except Built-in"), Reading B's three Denominator boxes
//      and both Pinning boxes —
//      so the first window is the user,plugin partition and format "" (no
//      predicate)) — the trigger opens and closes it — and the
//      SERVER-side narrowings the checked sets drive: the scripted
//      backend below applies store.ListMetricsPage's exact predicates
//      to the fixture, so a view that filtered client-side, passed the
//      wrong partition word, or forgot an arg would render the wrong
//      rows here; the denominator chip rides each row beside its scope
//      chip;
//   B. an Origin checked-set change restarts the keyset window at
//      cursor 0 — the same path as a search change (one debounced
//      effect reads query + originFilter + scopeFilter + formatFilter) — the group headers follow the partition, and
//      all three Origin options off is a legal empty read;
//   C. the Type group
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
//      (viewstate.svelte.js): all twenty restore across unmount →
//      remount, and resetViewState() returns the next mount to the
//      defaults;
//   I. the compute-state surface (design §4/§5): every list item and
//      the editor card wear its state chip (all five words), processing
//      quantifies with the live k/N feed (block form on the card, inline
//      bar in the row), metric-done refetches the state and clears the
//      feed, the draft-vs-saved preview criterion holds, and no rendered
//      state output carries a version number or timestamp;
//   J. the Order dialog: the list-header entry point,
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
//   K. the Scoreboard section's SHAPE pref (w25): the "Scoreboard
//      starts transposed" checkbox sits in the MATCH section AFTER its
//      list and never in the profile section, opens unchecked with the
//      absent-pref default and its catalog label (the dialog reads the
//      bare kvstore key), the click writes ONLY
//      scoreboard_starts_transposed through SetPref, a close+reopen
//      with a stateful store reads the written value back as checked,
//      and Reset order leaves the shape key untouched.
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
    scope: 'match', format: 'percent',
    doc: 'Formula: trade successes / opportunities',
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
    format: 'float1', doc: 'Formula: kills / deaths', origin: 'user',
    pluginId: '', denominator: 'matches',
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
// exact args the view sent — (query, originFilter, formatFilter, afterID,
// limit).
const pageCalls = [];
bindings.handlers.ListMetricsPage = (q, originFilter, formatFilter, afterID, limit) => {
  pageCalls.push([q, originFilter, formatFilter, afterID, limit]);
  let rows = METRICS.slice();
  // The origin WORD SUBSET (2026-11-17 — the Origin group's three
  // boxes): "" = all, "none" = the empty set, otherwise the canonical
  // comma-subset of builtin/user/plugin — a row passes iff its origin
  // is a checked token. store.ListMetricsPage mirrors this exactly
  // (its ORIGIN FILTER note), and originFilterWord composes the words
  // on the view side.
  if (originFilter === 'none') rows = [];
  else if (originFilter) {
    const origins = new Set(originFilter.split(','));
    rows = rows.filter((m) => origins.has(m.origin));
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
bindings.handlers.PreviewMetric = (id, expr, limit) => {
  previewCalls.push([id, expr, limit]);
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
        { metricId: id, subjectKey: '76561198000000001', value: 0.412, n: 13 },
        { metricId: id, subjectKey: '76561198000000002', value: 0.9, n: 7 },
        { metricId: id, subjectKey: '76561198000000003', value: 0.05, n: 3 },
      );
    } else {
      rows.push({ metricId: id, subjectKey: '76561198000000001', value: 6, n: 13 });
    }
  }
  return rows;
};
const compileCalls = [];
bindings.handlers.CompileMetric = (id, expr) => {
  compileCalls.push([id, expr]);
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
// RunningMetricsDialog — the Builder's running-metrics popup (closed by
// default), its services and strings resolved like MetricOrderDialog's.
svelteCompile(
  readFileSync('src/lib/components/RunningMetricsDialog.svelte', 'utf8')
    .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
    .replace("from './Dialog.svelte'", "from './dialog.js'")
    .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`),
  'RunningMetricsDialog.svelte',
  join(dir, 'runningmetricsdialog.js'),
);
// The load state (a runes module) and the shell (a component) the view imports, compiled beside it.
const { compileModule: compileRunes } = await import('svelte/compiler');
writeFileSync(join(dir, 'loadstate.svelte.js'), compileRunes(readFileSync('src/lib/loadstate.svelte.js', 'utf8'), { filename: 'loadstate.svelte.js', generate: 'client' }).js.code);
svelteCompile(readFileSync('src/lib/components/LoadBox.svelte', 'utf8').replace("from '../componentruntime/sizememory.js'", `from '${fileURL('src/lib/componentruntime/sizememory.js')}'`), 'LoadBox.svelte', join(dir, 'loadbox.js'));
const bldSrc = readFileSync('src/lib/views/Builder.svelte', 'utf8')
  .replace("from '../loadstate.svelte.js'", `from '${fileURL(join(dir, 'loadstate.svelte.js'))}'`)
  .replace("from '../components/LoadBox.svelte'", "from './loadbox.js'")
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../metricorder.js'", `from '${fileURL('src/lib/metricorder.js')}'`)
  .replace("from '../metricformats.js'", `from '${fileURL('src/lib/metricformats.js')}'`)
  .replace("from '../metricorigins.js'", `from '${fileURL('src/lib/metricorigins.js')}'`)
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../metricstate.js'", `from '${fileURL('src/lib/metricstate.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
  .replace("from '../components/ProfileLink.svelte'", "from './profilelink.js'")
  .replace("from '../components/SortTh.svelte'", "from './sortth.js'")
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'")
  .replace("from '../components/RunningMetricsDialog.svelte'", "from './runningmetricsdialog.js'")
  .replace("from '../components/Popover.svelte'", "from './popover.js'")
  .replace("from '../components/HelpButton.svelte'", "from './helpbutton.js'")
  .replace("from '../fillheight.js'", `from '${fileURL('src/lib/fillheight.js')}'`)
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
// multi-select), and originOf/scopeOf/denomOf/typeOf/pinningOf read
// each group's boxes in panel order (null when a box is missing, which
// fails every expectation below); allBoxesOf is
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
// The Origin group's three boxes in panel order (2026-11-17 — the
// third Plugin box and the Custom relabel) and the Scope pair — their
// checked sets compose the origin/scope words.
const ORIGIN_LABELS = ['Built-in', 'Custom', 'Plugin'];
const originOf = (r) => ORIGIN_LABELS.map((l) => boxNamed(r, l)?.checked ?? null);
// The Type group's seven format boxes in panel order — the canonical
// enum order the subset word composes in (lib/metricformats.js).
const FMT_LABELS = ['Auto', 'Int', 'Float1', 'Float2', 'Percent', 'Currency', 'Identity'];
const typeOf = (r) => FMT_LABELS.map((l) => boxNamed(r, l)?.checked ?? null);
// The whole panel in DOM order: the Origin three and the Type seven — ten
// boxes in two groups.
const allBoxesOf = (r) => [...originOf(r), ...typeOf(r)];
// The panel's group names in DOM order (the panel itself first, then
// its four labelled groups).
const GROUP_LABELS = ['Metric filters', 'Origin', 'Type'];
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const heading = (r) => r.querySelector('.bld-right h2')?.textContent.trim();
// The row's CHIPS minus the compute-state one (StatusChip) — the static
// identity chips in render order: format, then plugin.
const chipsOf = (r, name) =>
  [...(rowNamed(r, name)?.querySelectorAll('.bld-row-sub .chip:not(.status)') || [])].map((c) =>
    c.textContent.trim(),
  );
// The editor card's Save button and its read-only chip (the one
// bld-readonly in the view — the form header's).
const saveButton = (r) => r.querySelector('.bld-actions .btn.primary');
const formChip = (r) => r.querySelector('.bld-readonly');

viewstate.resetViewState();

console.log('A. ONE multi-select for the two groups — defaults Built-in OFF / Custom + Plugin ON, every other option ON (Type: all seven checked); the trigger opens and closes the panel');
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
    'N1: style-m3a.css pins .bld-rows as the flexible scroller of the list (fills the panel, overflow-y auto)',
    /\.bld-rows\s*\{[^}]*flex:\s*1 1 auto[^}]*overflow-y:\s*auto/s.test(m3aCss),
    'no .bld-rows { flex: 1 1 auto; overflow-y: auto } rule',
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
  'first list call = (query "", origin "" (every box on: no origin predicate), format "", cursor 0, 100)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', 0, 100]),
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
  'the trigger opens the checkbox panel (aria-expanded + ten options)',
  trig?.getAttribute('aria-expanded') === 'true' && !!panel && boxesOf(r).length === 10,
  `expanded=${trig?.getAttribute('aria-expanded')} boxes=${boxesOf(r).length}`,
);
check(
  'defaults render with every Origin option checked (unfiltered)',
  JSON.stringify(originOf(r)) === JSON.stringify([true, true, true]),
  JSON.stringify(originOf(r)),
);
check(
  // 6 → 7 boxes (2026-11-18, metrics Phase 7): Identity joins the
  // owner's "all checked" ruling, so the first render stays
  // unfiltered (format '' — the identity seeds are visible by
  // default like every other row).
  'the Type group defaults to ALL SEVEN format boxes checked (owner: "all six checked" + the Phase-7 Identity box)',
  JSON.stringify(typeOf(r)) === JSON.stringify([true, true, true, true, true, true, true]),
  JSON.stringify(typeOf(r)),
);
{
  const names = panel
    ? [...panel.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))
    : [];
  check(
    'the panel is ONE named group holding two labelled groups (Origin, Type)',
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
  // Re-pinned 2026-11-18 (metrics Phase 7, W45 catalog gap): the user
  // group's header reads "Custom" — the same word the Origin box uses
  // for exactly those rows — from the strings catalog.
  'the default view is unfiltered (Builtins, Custom and Plugins headers, every row)',
  JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'adr_avg', 'my_kd', 'plug_stat']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Builtins', 'Custom', 'Plugins']),
  JSON.stringify(namesOf(r)) + ' headers=' + JSON.stringify(headersOf(r)),
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

console.log('B. the Origin group narrows server-side (cursor 0) and all options off is a legal empty read');
services.invalidate(); // same-key windows are cached — record this window fresh
pageCalls.length = 0;
await setBox(r, 'Built-in', false); // every box starts on: take Built-in off first, then back on
await sleep(DEBOUNCE);
const beforeOn = pageCalls.length;
await setBox(r, 'Built-in', true); // → the whole catalog again
await sleep(DEBOUNCE);
check(
  'Built-in checked → (query "", origin "", scope "", denominator "", format "", cursor 0, 100) — all four rows with the Builtins header',
  JSON.stringify(pageCalls[beforeOn]) === JSON.stringify(['', '', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'adr_avg', 'my_kd', 'plug_stat']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Builtins', 'Custom', 'Plugins']),
  JSON.stringify(pageCalls[beforeOn]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Custom', false);
await sleep(DEBOUNCE);
check(
  'Custom unchecked → origin "builtin,plugin": the built-in and plugin rows render, no Custom header',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'builtin,plugin', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'plug_stat']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Builtins', 'Plugins']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Built-in', false);
await sleep(DEBOUNCE);
check(
  'Built-in unchecked → origin "plugin": only the plugin row renders, and its plugin chip rides beside its scope chip',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'plugin', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['plug_stat']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Plugins']) &&
    JSON.stringify(chipsOf(r, 'plug_stat')) === JSON.stringify(['int', 'plugin']),
  JSON.stringify(pageCalls[0]) +
    ' rows=' +
    JSON.stringify(namesOf(r)) +
    ' plug_stat=' +
    JSON.stringify(chipsOf(r, 'plug_stat')),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Plugin', false);
await sleep(DEBOUNCE);
check(
  'all three Origin options off → origin "none" — a legal empty read',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'none', '', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
check(
  'all off → empty list, no error, the empty state says so',
  rowsOf(r).length === 0 &&
    !r.querySelector('p.error[role="alert"]') &&
    r.textContent.includes('No metrics to show.'),
  `rows=${rowsOf(r).length} text=${r.textContent.replace(/\s+/g, ' ').slice(0, 200)}`,
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Custom', true);
await sleep(DEBOUNCE);
check(
  'Custom checked → origin "user": the user rows render under the Custom header',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Custom']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Plugin', true);
await sleep(DEBOUNCE);
check(
  'Custom and Plugin back checked → origin "user,plugin" — cursor reset again, the non-builtin rows render',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user,plugin', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Built-in', true);
await sleep(DEBOUNCE);
check(
  'all three Origin options back on → the whole catalog window again',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', 0, 100]) &&
    rowsOf(r).length === 4,
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);

console.log('D. a built-in row loads with its expression editable (owner ruling 44): Save stores the edit, Restore to default brings the shipped one back, no delete');
{
  const bRow = rowNamed(r, 'trade_rate');
  const uRow = rowNamed(r, 'adr_avg');
  const pRow = rowNamed(r, 'plug_stat');
  const saveBtn = () => saveButton(r);
  const chip = () => formChip(r);
  const REASON = 'Your edit replaces this built-in. Restore to default undoes it.';
  // The scripted override: SaveBuiltinMetric stores the expression on the
  // served row, RestoreBuiltinMetric puts the shipped one back (the value the
  // store would return). A refused edit rejects with the gate's message.
  const SHIPPED_TRADE_EXPR = 'from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))';
  const builtinCalls = [];
  let refuseEdit = null;
  bindings.handlers.SaveBuiltinMetric = (id, expr) => {
    builtinCalls.push({ op: 'save', id, expr });
    if (refuseEdit) return Promise.reject(new Error(refuseEdit));
    const row = METRICS.find((x) => x.id === id);
    row.expr = expr;
    row.edited = true;
    return { ...row, edited: true };
  };
  bindings.handlers.RestoreBuiltinMetric = (id) => {
    builtinCalls.push({ op: 'restore', id });
    const row = METRICS.find((x) => x.id === id);
    row.expr = SHIPPED_TRADE_EXPR;
    row.edited = false;
    return { ...row, edited: false };
  };

  check('the builtin row renders', !!bRow, JSON.stringify(namesOf(r)));
  // Owner ruling 50: an edited builtin wears the Edited chip in the list.
  // The shipped builtin (no override) and the user rows show none.
  const listEdited = (row) =>
    !!row && [...row.querySelectorAll('.bld-row-sub .chip')].some((c) => c.textContent.trim() === 'edited');
  check(
    'a builtin with no override shows no Edited chip in the list, and neither does a user row',
    !!bRow && !listEdited(bRow) && !!uRow && !listEdited(uRow),
    bRow ? bRow.querySelector('.bld-row-sub')?.textContent : 'no row',
  );
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
    'the builtin row keeps preview',
    !!bRow && !!bRow.querySelector('[aria-label="Preview trade_rate"]'),
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
    'the loaded definition fills every field (title, expression, format, doc)',
    r.querySelector('#bld-title')?.value === 'Trade rate' &&
      (r.querySelector('#bld-expr')?.value || '').includes('ratio(sum(trade_kills)') &&
      r.querySelector('#bld-format')?.value === 'percent' &&
      (r.querySelector('#bld-doc')?.value || '').includes('trade successes'),
    `title=${r.querySelector('#bld-title')?.value}`,
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
    'the Doc textarea is readonly for a built-in, and the Expression textarea is editable (the one edit)',
    (() => {
      const doc = r.querySelector('#bld-doc');
      const expr = r.querySelector('#bld-expr');
      return !!doc && doc.readOnly === true && doc.disabled === false &&
        !!expr && expr.readOnly === false && expr.disabled === false;
    })(),
    ['bld-doc', 'bld-expr']
      .map((id) => {
        const el = r.querySelector('#' + id);
        return `${id}:readOnly=${el?.readOnly} disabled=${el?.disabled}`;
      })
      .join(' '),
  );
  check(
    'the Format select is disabled for a built-in',
    ['bld-format'].every((id) => {
      const el = r.querySelector('#' + id);
      return el && el.disabled === true;
    }),
    ['bld-format']
      .map((id) => `${id}:disabled=${r.querySelector('#' + id)?.disabled}`)
      .join(' '),
  );
  // The form's FIXED ROWS (owner rulings, origin-independent — it pins
  // .bld-fields markup, not the built-in state): row 1 Name / Title /
  // Short name, then Format, then the full-width Doc and Expression rows.
  // ALL the fields in DOM order, deep-equalled: a reorder, a dropped field
  // or a new one spliced in anywhere fails loudly.
  const fieldIds = [...r.querySelectorAll('.bld-fields .bld-field')].map(
    (f) => f.querySelector('[id]')?.id ?? '',
  );
  check(
    'the form fields sit in the fixed rows (Name/Title/Short · Format, then Doc/Expression)',
    JSON.stringify(fieldIds) ===
      JSON.stringify([
        'bld-name',
        'bld-title',
        'bld-short',
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
    'Save is disabled while the built-in is unedited (clean form), with its label kept',
    !!saveBtn() &&
      saveBtn().disabled &&
      saveBtn().textContent.trim() === 'Save metric',
    saveBtn()
      ? `disabled=${saveBtn().disabled} text="${saveBtn().textContent.trim()}"`
      : 'no Save button',
  );
  check(
    'no restore control is offered for an unedited built-in',
    ![...r.querySelectorAll('.bld-actions button')].some((b) => b.textContent.trim() === 'Restore to default'),
    '',
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

  // A refused edit (the save gate's message) surfaces and stores nothing.
  // The live check runs first on the typed expression, so the refusal is
  // the save's own: the scripted backend rejects with the gate's wording.
  type(r.querySelector('#bld-expr'), 'from jobs: count()');
  await sleep(500); // the debounced live check settles
  refuseEdit = 'invalid metric expression: the table jobs is not readable by a metric';
  click(saveBtn());
  await sleep(80);
  check(
    'a refused built-in edit shows the gate message and stores nothing',
    (r.querySelector('p.error')?.textContent || '').includes('jobs') &&
      builtinCalls.at(-1)?.op === 'save' && !chip()?.textContent.includes('edited') &&
      ![...r.querySelectorAll('.bld-right .chip')].some((c) => c.textContent.trim() === 'edited'),
    `err="${r.querySelector('p.error')?.textContent}"`,
  );
  refuseEdit = null;

  // The valid edit: typing enables Save; Save stores it as the override.
  const EDIT = 'from events: count()';
  type(r.querySelector('#bld-expr'), EDIT);
  await sleep(500);
  check('editing the expression enables Save', !!saveBtn() && !saveBtn().disabled, `disabled=${saveBtn()?.disabled}`);
  click(saveBtn());
  await sleep(80);
  const saveCall = builtinCalls.filter((c) => c.op === 'save').at(-1);
  check(
    'Save stores the edit as the built-in override: SaveBuiltinMetric(id, expression)',
    saveCall?.id === 1 && saveCall.expr === EDIT,
    JSON.stringify(saveCall),
  );
  await sleep(60);
  check(
    'the list row of the edited built-in wears the Edited chip, and no other row does',
    listEdited(rowNamed(r, 'trade_rate')) &&
      rowsOf(r).filter((x) => listEdited(x)).length === 1,
    `rows edited=${rowsOf(r).filter((x) => listEdited(x)).length}`,
  );
  check(
    'after the save the built-in shows the edited chip, Save is clean again, and Restore to default appears',
    !!chip() && heading(r) === 'Edit metric' && [...r.querySelectorAll('.bld-readonly ~ .chip, .bld-actions .chip')].some((c) => c.textContent.trim() === 'edited') &&
      saveBtn().disabled &&
      [...r.querySelectorAll('.bld-actions button')].some((b) => b.textContent.trim() === 'Restore to default'),
    `disabled=${saveBtn()?.disabled}`,
  );
  // Restore to default: the override goes, the shipped expression is back.
  const restoreBtn = [...r.querySelectorAll('.bld-actions button')].find((b) => b.textContent.trim() === 'Restore to default');
  click(restoreBtn);
  await sleep(80);
  const restoreCall = builtinCalls.at(-1);
  check(
    'Restore to default calls RestoreBuiltinMetric and the shipped expression is back in the form',
    restoreCall?.op === 'restore' && restoreCall.id === 1 &&
      (r.querySelector('#bld-expr')?.value || '') === SHIPPED_TRADE_EXPR &&
      ![...r.querySelectorAll('.chip')].some((c) => c.textContent.trim() === 'edited'),
    `${JSON.stringify(restoreCall)} expr=${r.querySelector('#bld-expr')?.value}`,
  );
  await sleep(60);
  check(
    'restore to default removes the Edited chip from the list row',
    !!rowNamed(r, 'trade_rate') && !listEdited(rowNamed(r, 'trade_rate')) &&
      rowsOf(r).every((x) => !listEdited(x)),
    `row=${rowNamed(r, 'trade_rate')?.querySelector('.bld-row-sub')?.textContent}`,
  );
  check(
    'the restored built-in is unedited again: Save disabled, no restore control',
    saveBtn().disabled &&
      ![...r.querySelectorAll('.bld-actions button')].some((b) => b.textContent.trim() === 'Restore to default'),
    '',
  );
  delete bindings.handlers.SaveBuiltinMetric;
  delete bindings.handlers.RestoreBuiltinMetric;

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
      ['bld-format'].every(
        (id) => r.querySelector('#' + id)?.disabled === false,
      ),
    ['bld-name', 'bld-doc', 'bld-format']
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
    JSON.stringify(compileCalls[0]) === JSON.stringify([1, '']),
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
    valueCell === '90%',
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
  // The stub above returns THREE rows for this metric — alice 41.2%,
  // bob 90%, carl 5%: the values are numeric where their percent TEXT is
  // not ("5%" < "41.2%" lexically, 5 > 41.2 never), and the labels mix
  // a name with two ids so a text sort is observable too. The preview
  // carries no N column (a value has no sample size), so Value is the
  // numeric column and its active default is highest first.
  const pRows = () => [...r.querySelectorAll('.bld-preview table.data-table tbody tr')];
  const pCol = (i) => pRows().map((row) => row.querySelectorAll('td')[i]?.textContent);
  const pTh = () => [...r.querySelectorAll('.bld-preview table.data-table thead th button')];

  check(
    'preview rows default to value descending — highest value first (owner ruling)',
    JSON.stringify(pCol(2)) === JSON.stringify(['90%', '41.2%', '5%']),
    JSON.stringify(pCol(2)),
  );
  check(
    'the preview has no N column (a value carries no sample size)',
    pTh().length === 3 && !pTh().some((b) => b.textContent.trim() === 'N'),
    pTh().map((b) => b.textContent.trim()).join('|'),
  );

  click(pTh()[2]); // Value is the active header: the click flips it
  await sleep(60);
  check(
    'a click on the active Value header sorts by VALUE, lowest first (never the formatted text)',
    JSON.stringify(pCol(2)) === JSON.stringify(['5%', '41.2%', '90%']),
    JSON.stringify(pCol(2)),
  );
  click(pTh()[2]); // Value again
  await sleep(60);
  check(
    'a second click on Value flips back to highest first',
    JSON.stringify(pCol(2)) === JSON.stringify(['90%', '41.2%', '5%']),
    JSON.stringify(pCol(2)),
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
    'N6: the actions row is one line — on a user metric the delete leads it, then the validity slot, then the hint→Save cluster LAST',
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
      'N6: the cluster runs hint → Save, no divider and no separator',
      cluster.length === 2 &&
        cluster[0].classList.contains('bld-note') &&
        cluster[1].classList.contains('btn') &&
        cluster[1].classList.contains('primary') &&
        !!cluster[1].querySelector('.codicon-save') &&
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
    'typing restarts the window with BOTH narrowings: (query "adr", origin "user,plugin", format "", cursor 0, 100)',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['adr', 'user,plugin', '', 0, 100]),
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
    'clearing the query restores the user,plugin partition window',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user,plugin', '', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  // The Type group composes in the SAME call: formats narrowed to Auto
  // alone (the other six off — Identity included, the Phase-7 box),
  // then the search on top — one window,
  // three narrowings, the format word riding the same args as the rest.
  services.invalidate();
  pageCalls.length = 0;
  for (const l of ['Int', 'Float1', 'Float2', 'Percent', 'Currency', 'Identity']) await setBox(r, l, false);
  await sleep(DEBOUNCE);
  check(
    'formats narrowed to Auto alone → format "auto" — only the auto-format row survives in the user,plugin partition',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user,plugin', 'auto', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  type(search, 'adr');
  await sleep(DEBOUNCE);
  check(
    'the search composes with origin AND format in ONE call: (query "adr", origin "user,plugin", format "auto", …)',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['adr', 'user,plugin', 'auto', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  type(search, '');
  for (const l of FMT_LABELS) await setBox(r, l, true);
  await sleep(DEBOUNCE);
  check(
    'clearing the query AND re-checking every Type box → the user,plugin partition window again (format word back to "")',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user,plugin', '', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  await setBox(r, 'Built-in', true);
  await sleep(DEBOUNCE);
  check(
    'Built-in back checked → the whole catalog window again',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', 0, 100]) && rowsOf(r).length === 4,
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
    JSON.stringify(pageCalls[0]) === JSON.stringify(['trade', '', '', 0, 100]) &&
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
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', 0, 100]) && rowsOf(r).length === 4,
    JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
  );
}

console.log('H. the filter checks are view-local registry state (restore all ten, then reset to defaults)');
{
  // Leave a DISTINCT state behind — one option off in EACH of the
  // Origin and Type groups, so the restore proves every key round-trips.
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
    // Identity stays checked (the Phase-7 box), so the format word
    // carries it: 2026-11-18 re-pin.
    'the parting state is user,plugin minus Currency (Built-in and Currency off)',
    JSON.stringify(pageCalls[pageCalls.length - 1]) ===
      JSON.stringify(['', 'user,plugin', 'auto,int,float1,float2,percent,identity', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  r = await mountBuilder(); // unmount → remount, registry intact
  await openFilters(r);
  check(
    'unmount → remount restores ALL ten checks (only Built-in and Currency off)',
    JSON.stringify(allBoxesOf(r)) ===
      JSON.stringify([false, true, true, true, true, true, true, true, false, true]),
    JSON.stringify(allBoxesOf(r)),
  );
  check(
    '…and the restored view shows the restored rows',
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(namesOf(r)),
  );
  viewstate.resetViewState();
  r = await mountBuilder();
  await openFilters(r);
  check(
    'resetViewState() → the next mount is back to the defaults (every Origin box ON, unfiltered; Type all seven ON)',
    JSON.stringify(allBoxesOf(r)) ===
      JSON.stringify([true, true, true, true, true, true, true, true, true, true]),
    JSON.stringify(allBoxesOf(r)),
  );
  check(
    '…and the default view is unfiltered again',
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'adr_avg', 'my_kd', 'plug_stat']),
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

// ---------------------------------------------------------------------------
// Section K: the Type group's Identity box (metrics expansion Phase 7,
// 2026-11-18) — the key-valued identity metrics gain their filter
// treatment, flowing exactly like every other format option: declared
// on the definition's `format` column, never text in the expression.
// The identity fixture is pushed ONLY for this section and popped in
// its finally, so the earlier sections' pinned four-row windows keep
// their shapes.
console.log('K. the Type group offers Identity: an identity metric is selectable, chips identity, loads read-only, and wears its five-state row chip');
{
  viewstate.resetViewState();
  const IDENTITY = {
    id: 5, name: 'top_fragger', title: 'Top fragger', shortName: '',
    expr: 'from player_stats: argmax(kills)', scope: 'match',
    format: 'identity', doc: 'Formula: argmax(player_stats.kills) — N = the pool',
    origin: 'builtin', pluginId: '', denominator: '',
  };
  METRICS.push(IDENTITY);
  computeStates = [...computeStates, { metricId: 5, state: 'behind' }];
  services.invalidate();
  try {
    r = await mountBuilder();
    await openFilters(r);
    await setBox(r, 'Built-in', true); // the seeds are built-ins
    await sleep(DEBOUNCE);
    for (const l of FMT_LABELS.filter((x) => x !== 'Identity')) await setBox(r, l, false);
    await sleep(DEBOUNCE);
    check(
      'Identity checked alone → format word "identity" in the ONE server call, and the identity metric is the window',
      JSON.stringify(pageCalls[pageCalls.length - 1]) ===
        JSON.stringify(['', '', 'identity', 0, 100]) &&
        JSON.stringify(namesOf(r)) === JSON.stringify(['top_fragger']) &&
        JSON.stringify(headersOf(r)) === JSON.stringify(['Builtins']),
      JSON.stringify(pageCalls[pageCalls.length - 1]) +
        ' rows=' +
        JSON.stringify(namesOf(r)) +
        ' headers=' +
        JSON.stringify(headersOf(r)),
    );
    check(
      'the identity row wears the identity format chip',
      JSON.stringify(chipsOf(r, 'top_fragger')) === JSON.stringify(['identity']),
      JSON.stringify(chipsOf(r, 'top_fragger')),
    );
    const idChip = rowNamed(r, 'top_fragger')?.querySelector('.bld-row-sub .chip.status');
    check(
      'the identity row renders the established five-state chip (behind — the library word, labelled any match behind)',
      !!idChip && (idChip.getAttribute('title') || '') === 'behind for any match — a match needs a recompute',
      idChip ? `class=${idChip.className} title=${idChip.getAttribute('title')}` : 'no status chip',
    );
    click(rowNamed(r, 'top_fragger')?.querySelector('button.bld-row-main'));
    await sleep(60);
    const fmtSel = r.querySelector('#bld-format');
    check(
      'the identity metric loads read-only and its Format select shows identity (the filter-only token renders for a loaded definition, never as a fresh choice)',
      heading(r) === 'Edit metric' &&
        fmtSel?.value === 'identity' &&
        fmtSel?.disabled === true &&
        ![...fmtSel.options].some((o) => o.value === 'identity' && !o.selected),
      `heading=${heading(r)} value=${fmtSel?.value} disabled=${fmtSel?.disabled} options=${fmtSel ? [...fmtSel.options].map((o) => o.value).join(',') : 'none'}`,
    );
  } finally {
    computeStates = computeStates.filter((s) => s.metricId !== 5);
    const i = METRICS.indexOf(IDENTITY);
    if (i >= 0) METRICS.splice(i, 1);
    services.invalidate();
  }
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
