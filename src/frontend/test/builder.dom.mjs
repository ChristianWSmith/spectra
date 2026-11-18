// jsdom driver for the metrics Builder's list UX (owner wave A: the
// built-in editor load + the scope/denominator filter pairs + the
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
//      effect reads query + originFilter + scopeFilter + denomFilter +
//      formatFilter) — the group headers follow the partition, and
//      all three Origin options off is a legal empty read;
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
//      (viewstate.svelte.js): all twenty restore across unmount →
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
    scope: 'match', subject: 'player', format: 'percent',
    doc: 'Formula: trade successes / opportunities',
    origin: 'builtin', pluginId: '', denominator: 'rounds',
  },
  {
    id: 2, name: 'adr_avg', title: 'ADR average', shortName: 'ADR',
    expr: 'from player_stats: avg(adr)', scope: 'match', subject: 'player', format: '',
    doc: 'Formula: average ADR', origin: 'user', pluginId: '', denominator: '',
  },
  {
    id: 3, name: 'my_kd', title: 'My K/D', shortName: '',
    expr: 'from events: ratio(count(victim), count(attacker))', scope: 'match',
    subject: 'match', format: 'float1', doc: 'Formula: kills / deaths', origin: 'user',
    pluginId: '', denominator: 'matches',
  },
  {
    id: 4, name: 'plug_stat', title: 'Plugin stat', shortName: '',
    expr: 'from events: count()', scope: 'match', subject: 'team', format: 'int',
    doc: 'Formula: count()', origin: 'plugin', pluginId: 'p1', denominator: '',
  },
];

// The scripted paged read: the SAME partitions + LIKE the store applies
// (store.ListMetricsPage — including Reading B's denominator bucket
// subset and the format subset), recorded so the checks can assert the
// exact args the view sent — (query, originFilter, scopeFilter,
// subjectFilter, denomFilter, formatFilter, afterID, limit).
const pageCalls = [];
bindings.handlers.ListMetricsPage = (
  q,
  originFilter,
  scopeFilter,
  subjectFilter,
  denomFilter,
  formatFilter,
  afterID,
  limit,
) => {
  pageCalls.push([q, originFilter, scopeFilter, subjectFilter, denomFilter, formatFilter, afterID, limit]);
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
  if (scopeFilter === 'match') rows = rows.filter((m) => (m.scope || 'match') === 'match');
  else if (scopeFilter === 'profile') rows = rows.filter((m) => m.scope === 'profile');
  else if (scopeFilter === 'none') rows = [];
  // The subject SUBSET (the Subject group's word — the metrics subject
  // axis): "none" is the empty set like origin's; any other word is the
  // checked tokens, a row passing iff its subject is one of them (a
  // fixture row without the field reads the DDL default "player").
  // store.ListMetricsPage mirrors this exactly (its SUBJECT FILTER
  // note), and the view composes the words from the checked set.
  if (subjectFilter === 'none') rows = [];
  else if (subjectFilter) {
    const subs = new Set(subjectFilter.split(','));
    rows = rows.filter((m) => subs.has(m.subject || 'player'));
  }  // The denominator BUCKET SUBSET (Reading B — the 2026-11-16 overturn
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
bindings.handlers.PreviewMetric = (id, expr, subject, partition, scope, limit) => {
  previewCalls.push([id, expr, subject, partition, scope, limit]);
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
  .replace("from '../metricorigins.js'", `from '${fileURL('src/lib/metricorigins.js')}'`)
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
const scopeOf = (r) => ['Match', 'Profile'].map((l) => boxNamed(r, l)?.checked ?? null);
// The Subject group's three boxes in panel order — scoped by the group's
// aria-label, because its middle box shares the Scope group's "Match"
// word (one spelling per concept) and boxNamed takes the FIRST match.
const SUBJ_LABELS = ['Player', 'Match', 'Team'];
const subjGroup = (r) =>
  [...(panelOf(r)?.querySelectorAll('.bld-filter-group') || [])].find(
    (g) => g.getAttribute('aria-label') === 'Subject',
  );
const subjectOf = (r) =>
  SUBJ_LABELS.map(
    (l) =>
      [...(subjGroup(r)?.querySelectorAll('input[type="checkbox"]') || [])].find(
        (cb) => (cb.closest('label')?.textContent || '').trim() === l,
      )?.checked ?? null,
  );
const setSubjBox = async (r, label, on) => {
  await openFilters(r);
  const cb = [...(subjGroup(r)?.querySelectorAll('input[type="checkbox"]') || [])].find(
    (x) => (x.closest('label')?.textContent || '').trim() === label,
  );
  if (cb && cb.checked !== on) cb.click();
};
// The Denominator group's three boxes in panel order (Reading B) and
// the Pinning group's pair — read beside originOf/typeOf below.
const denomOf = (r) => ['Rounds', 'Matches', 'None'].map((l) => boxNamed(r, l)?.checked ?? null);
const PIN_LABELS = ['Pinned', 'Unpinned'];
const pinningOf = (r) => PIN_LABELS.map((l) => boxNamed(r, l)?.checked ?? null);
// The Type group's seven format boxes in panel order — the canonical
// enum order the subset word composes in (lib/metricformats.js).
const FMT_LABELS = ['Auto', 'Int', 'Float1', 'Float2', 'Percent', 'Currency', 'Identity'];
const typeOf = (r) => FMT_LABELS.map((l) => boxNamed(r, l)?.checked ?? null);
// The whole panel in DOM order: the Origin three, the Scope pair, the
// Subject three, the Denominator three, the Type seven and the Pinning
// pair — twenty boxes in six groups.
const allBoxesOf = (r) => [
  ...originOf(r),
  ...scopeOf(r),
  ...subjectOf(r),
  ...denomOf(r),
  ...typeOf(r),
  ...pinningOf(r),
];
// The panel's group names in DOM order (the panel itself first, then
// its six labelled groups).
const GROUP_LABELS = ['Metric filters', 'Origin', 'Scope', 'Subject', 'Denominator', 'Type', 'Pinning'];
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

console.log('A. ONE multi-select for the four groups — defaults Built-in OFF / Custom + Plugin ON, every other option ON (Type: all seven checked); the trigger opens and closes the panel');
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
  'first list call = (query "", origin "user,plugin", scope "", denominator "", format "", cursor 0, 100)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user,plugin', '', '', '', '', 0, 100]),
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
  // 17 → 20 boxes (2026-11-18): the Subject group's three boxes join
  // the metrics subject axis (after the Phase-7 Identity box).
  'the trigger opens the checkbox panel (aria-expanded + twenty options)',
  trig?.getAttribute('aria-expanded') === 'true' && !!panel && boxesOf(r).length === 20,
  `expanded=${trig?.getAttribute('aria-expanded')} boxes=${boxesOf(r).length}`,
);
check(
  'defaults render with Built-in unchecked and every other Origin/Scope/Denominator option checked (owner ruling)',
  JSON.stringify([...originOf(r), ...scopeOf(r)]) ===
    JSON.stringify([false, true, true, true, true]),
  JSON.stringify([...originOf(r), ...scopeOf(r)]),
);
check(
  "the Denominator group defaults to ALL THREE boxes checked (Rounds, Matches, None — Reading B) and the Pinning group to BOTH (Pinned, Unpinned)",
  JSON.stringify(denomOf(r)) === JSON.stringify([true, true, true]) &&
    JSON.stringify(pinningOf(r)) === JSON.stringify([true, true]),
  JSON.stringify(denomOf(r)) + ' / ' + JSON.stringify(pinningOf(r)),
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
    'the panel is ONE named group holding six labelled groups (Origin, Scope, Subject, Denominator, Type, Pinning)',
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
  'the default view is the user,plugin partition (Custom + Plugins headers, no builtin row)',
  JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Custom', 'Plugins']),
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

console.log('B. the Origin group narrows server-side (cursor 0) and all options off is a legal empty read');
services.invalidate(); // same-key windows are cached — record this window fresh
pageCalls.length = 0;
await setBox(r, 'Built-in', true); // from the default: the user,plugin partition → the whole catalog
await sleep(DEBOUNCE);
check(
  'Built-in checked → (query "", origin "", scope "", denominator "", format "", cursor 0, 100) — all four rows with the Builtins header',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'adr_avg', 'my_kd', 'plug_stat']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Builtins', 'Custom', 'Plugins']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Custom', false);
await sleep(DEBOUNCE);
check(
  'Custom unchecked → origin "builtin,plugin": the built-in and plugin rows render, no Custom header',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'builtin,plugin', '', '', '', '', 0, 100]) &&
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'plugin', '', '', '', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['plug_stat']) &&
    JSON.stringify(headersOf(r)) === JSON.stringify(['Plugins']) &&
    JSON.stringify(chipsOf(r, 'plug_stat')) === JSON.stringify(['match', 'none', 'int', 'plugin']),
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'none', '', '', '', '', 0, 100]),
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user', '', '', '', '', 0, 100]) &&
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user,plugin', '', '', '', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Built-in', true);
await sleep(DEBOUNCE);
check(
  'all three Origin options back on → the whole catalog window again',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', '', 0, 100]) &&
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', 'profile', '', '', '', 0, 100]),
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', 'none', '', '', '', 0, 100]) &&
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', 'match', '', '', '', 0, 100]) &&
    rowsOf(r).length === 4,
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Profile', true);
await sleep(DEBOUNCE);
check(
  'both Scope options on → scope "" — no narrowing',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Rounds', false); // Matches + None (the default third box)
await sleep(DEBOUNCE);
check(
  'Rounds unchecked → (…, denominator "matches,none", cursor 0, 100) — the canonical subset word',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', 'matches,none', '', 0, 100]),
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', 'none', '', 0, 100]),
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', 'empty', '', 0, 100]) &&
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', 'rounds', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Matches', true); // {Rounds, Matches}
await sleep(DEBOUNCE);
check(
  '{Rounds, Matches} → denominator "rounds,matches" — both denominated metrics, still no denominator-less row',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', 'rounds,matches', '', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'my_kd']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'None', true); // all three back on
await sleep(DEBOUNCE);
check(
  'all three Denominator boxes on → denominator "" — all four rows again',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
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
// being the '' rows — unchecking Auto hands the six literal tokens to
// the store (Identity stays checked — the Phase-7 box) and the
// auto-format row drops out.
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Auto', false); // every format but the '' rows
await sleep(DEBOUNCE);
check(
  'Auto unchecked → format "int,float1,float2,percent,currency,identity" — the canonical subset, the auto-format row gone',
  JSON.stringify(pageCalls[0]) ===
    JSON.stringify(['', '', '', '', '', 'int,float1,float2,percent,currency,identity', 0, 100]) &&
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'my_kd', 'plug_stat']),
  JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
);
services.invalidate();
pageCalls.length = 0;
await setBox(r, 'Auto', true);
for (const l of ['Int', 'Float1', 'Float2', 'Currency', 'Identity']) await setBox(r, l, false);
await sleep(DEBOUNCE);
check(
  'Auto + Percent only → format "auto,percent" — the auto bucket and the percent rows in one window',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', 'auto,percent', 0, 100]) &&
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
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', 'none', 0, 100]) &&
    rowsOf(r).length === 0 &&
    r.textContent.includes('No metrics to show.'),
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
services.invalidate();
pageCalls.length = 0;
for (const l of FMT_LABELS) await setBox(r, l, true);
await sleep(DEBOUNCE);
check(
  'all seven Type boxes back on → format "" — the whole catalog window again',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
  JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
);
// Hand a CLOSED panel to the untouched sections below (D/E/F open
// nothing; G reopens it).
await closeFilters(r);

console.log('C2. the Subject group narrows the same server call (the metrics subject axis)');
{
  // The block runs on whatever filter state section C left (like every
  // section before it) and pins the SUBJECT token's position (arg 4),
  // each subject ALONE, a combination, the empty set and the all-on
  // default — the baseline rows are captured with the subject group
  // all-on, which is what the default view is.
  await openFilters(r);
  await setSubjBox(r, 'Player', true);
  await setSubjBox(r, 'Match', true);
  await setSubjBox(r, 'Team', true);
  await sleep(DEBOUNCE);
  const baselineRows = namesOf(r);
  const subjArg = () => pageCalls[pageCalls.length - 1]?.[3];
  pageCalls.length = 0;
  await setSubjBox(r, 'Player', false);
  await sleep(DEBOUNCE);
  check(
    'Player off → subject token "match,team" (arg 4): the match- and team-subject rows survive',
    subjArg() === 'match,team' &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['my_kd', 'plug_stat']),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  pageCalls.length = 0;
  await setSubjBox(r, 'Match', false);
  await sleep(DEBOUNCE);
  check(
    'Team alone → subject token "team"',
    subjArg() === 'team' && JSON.stringify(namesOf(r)) === JSON.stringify(['plug_stat']),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  pageCalls.length = 0;
  await setSubjBox(r, 'Player', true);
  await setSubjBox(r, 'Team', false);
  await sleep(DEBOUNCE);
  check(
    'Player alone → subject token "player"',
    subjArg() === 'player' &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'adr_avg']),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  pageCalls.length = 0;
  await setSubjBox(r, 'Player', false);
  await setSubjBox(r, 'Match', true);
  await sleep(DEBOUNCE);
  check(
    'Match alone → subject token "match"',
    subjArg() === 'match' && JSON.stringify(namesOf(r)) === JSON.stringify(['my_kd']),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  pageCalls.length = 0;
  await setSubjBox(r, 'Match', false);
  await sleep(DEBOUNCE);
  check(
    'all three Subject boxes off → subject "none" (the legal empty read)',
    subjArg() === 'none' && rowsOf(r).length === 0,
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + rowsOf(r).length,
  );
  // The restored all-on word is the DEFAULT state's own args (section A
  // already read them once), so it would hit the read cache and issue no
  // backend call at all — flush first, then prove the flip re-reads.
  services.invalidate();
  pageCalls.length = 0;
  await setSubjBox(r, 'Player', true);
  await setSubjBox(r, 'Match', true);
  await setSubjBox(r, 'Team', true);
  await sleep(DEBOUNCE);
  check(
    'all three back on → subject "" (no predicate): the default view is unchanged',
    subjArg() === '' && JSON.stringify(namesOf(r)) === JSON.stringify(baselineRows),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
}

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
    'the four selects (Subject, Scope, Denominator, Format) are disabled for a built-in',
    ['bld-subject', 'bld-scope', 'bld-denom', 'bld-format'].every((id) => {
      const el = r.querySelector('#' + id);
      return el && el.disabled === true;
    }),
    ['bld-subject', 'bld-scope', 'bld-denom', 'bld-format']
      .map((id) => `${id}:disabled=${r.querySelector('#' + id)?.disabled}`)
      .join(' '),
  );
  // The form's FIXED ROWS (owner rulings, origin-independent — it pins
  // .bld-fields markup, not the built-in state): row 1 Name / Title /
  // Short name, row 2 Subject / Scope alone (Subject sits immediately
  // LEFT of Scope — the owner's placement), row 3 Denominator / Format
  // below it (the owner's row split, 2026-11-18), then the full-width
  // Doc and Expression rows underneath. ALL nine
  // fields in DOM order, deep-equalled: a reorder, a dropped field or a
  // new one spliced in anywhere fails loudly. The wide pair is included
  // on purpose — "Doc/Expression last and full-width" is part of the
  // same ruling, so their position is worth the same pin.
  const fieldIds = [...r.querySelectorAll('.bld-fields .bld-field')].map(
    (f) => f.querySelector('[id]')?.id ?? '',
  );
  check(
    'the form fields sit in the fixed rows (Name/Title/Short · Subject/Scope · Denominator/Format, then Doc/Expression)',
    JSON.stringify(fieldIds) ===
      JSON.stringify([
        'bld-name',
        'bld-title',
        'bld-short',
        'bld-subject',
        'bld-scope',
        'bld-denom',
        'bld-format',
        'bld-doc',
        'bld-expr',
      ]),
    JSON.stringify(fieldIds),
  );
  // The SUBJECT select renders immediately LEFT of Scope in edit mode
  // (the owner's placement, verbatim): DOM order is the visual order in
  // this grid, so previousElementSibling pins the position itself.
  {
    // The FIELD (not the select) is the grid cell, so the position pins
    // on the two .bld-field siblings: Subject's cell is the one directly
    // before Scope's cell.
    const subjField = r.querySelector('#bld-subject')?.closest('.bld-field');
    const scopeField = r.querySelector('#bld-scope')?.closest('.bld-field');
    check(
      'the Subject select sits immediately left of the Scope select (edit mode)',
      !!subjField && !!scopeField && scopeField.previousElementSibling === subjField,
      subjField && scopeField
        ? `prevCell=${scopeField.previousElementSibling?.querySelector('[id]')?.id}`
        : 'missing field',
    );
  }
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
      ['bld-subject', 'bld-scope', 'bld-denom', 'bld-format'].every(
        (id) => r.querySelector('#' + id)?.disabled === false,
      ),
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

console.log('D2. the Subject select persists through save (round trip) and an illegal pair surfaces the server refusal');
{
  // The scripted backend PERSISTS what it is handed, so the reload
  // below is a real round trip through the view's own save/load path —
  // not just a payload assertion.
  const payloads = [];
  bindings.handlers.SaveMetric = (m) => {
    payloads.push(m);
    const row = METRICS.find((x) => x.id === m.id);
    if (row) Object.assign(row, m);
    return { ...m };
  };
  const saveBtnOf = () =>
    [...r.querySelectorAll('.bld-actions button')].find((b) => b.textContent.includes('Save metric'));
  try {
    click(rowNamed(r, 'adr_avg').querySelector('button.bld-row-main'));
    await sleep(60);
    check(
      'a user row loads its stored subject into the select (player — the authoring default)',
      r.querySelector('#bld-subject')?.value === 'player' &&
        r.querySelector('#bld-scope')?.value === 'match',
      `subject=${r.querySelector('#bld-subject')?.value} scope=${r.querySelector('#bld-scope')?.value}`,
    );
    const sel = r.querySelector('#bld-subject');
    sel.value = 'team';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await sleep(20);
    check(
      'the select binds the form: Subject now reads team',
      r.querySelector('#bld-subject')?.value === 'team',
      `subject=${r.querySelector('#bld-subject')?.value}`,
    );
    click(saveBtnOf());
    await sleep(80);
    check(
      'Save carries subject (and the preserved partition) in the payload',
      payloads.length === 1 &&
        payloads[0].subject === 'team' &&
        payloads[0].partition === '' &&
        payloads[0].scope === 'match',
      JSON.stringify(
        payloads[0] && {
          subject: payloads[0].subject,
          partition: payloads[0].partition,
          scope: payloads[0].scope,
        },
      ),
    );
    click(rowNamed(r, 'adr_avg').querySelector('button.bld-row-main'));
    await sleep(60);
    check(
      'reloading the definition restores the saved subject (round trip)',
      r.querySelector('#bld-subject')?.value === 'team',
      `subject=${r.querySelector('#bld-subject')?.value}`,
    );
    // New → the authoring default, not the last edit's value.
    const newBtn = [...r.querySelectorAll('.bld-list button')].find((b) => b.textContent.includes('New'));
    click(newBtn);
    await sleep(60);
    check(
      'New starts on the authoring default subject (player)',
      r.querySelector('#bld-subject')?.value === 'player',
      `subject=${r.querySelector('#bld-subject')?.value}`,
    );
  } finally {
    delete bindings.handlers.SaveMetric;
  }
  // An ILLEGAL subject × scope pair surfaces the SERVER's own refusal —
  // the editor builds no client-side validity matrix (every option stays
  // enabled; the guard lives in SaveMetric).
  bindings.handlers.SaveMetric = () =>
    Promise.reject(
      new Error("a match-subject metric can't be profile-scoped (a match or team has no career — pick match scope)"),
    );
  try {
    // A fresh draft, filled past the front-door guards, so the report
    // below is the SERVER's matrix refusal and nothing else.
    type(r.querySelector('#bld-name'), 'side_split');
    type(r.querySelector('#bld-doc'), 'Formula: side split');
    type(r.querySelector('#bld-expr'), 'from player_stats: count()');
    await sleep(500); // the debounced live check settles on "valid"
    const sel = r.querySelector('#bld-subject');
    sel.value = 'match';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const scopeSel = r.querySelector('#bld-scope');
    scopeSel.value = 'profile';
    scopeSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await sleep(20);
    const enabled = [...r.querySelectorAll('.bld-fields select')].every((x) => x.disabled === false);
    click(saveBtnOf());
    await sleep(80);
    check(
      'the illegal pair (match subject + profile scope) surfaces the save refusal, with no option disabled',
      enabled &&
        (r.querySelector('p.error')?.textContent || '').includes("can't be profile-scoped"),
      `enabled=${enabled} err="${r.querySelector('p.error')?.textContent}"`,
    );
  } finally {
    delete bindings.handlers.SaveMetric;
  }
  // Block B leaves a FILLED draft behind; section E pins the pristine
  // New form ("previewing a builtin does NOT load the form"), so reset
  // it exactly the way section D's own reset does.
  const newBtn2 = [...r.querySelectorAll('.bld-list button')].find((b) => b.textContent.includes('New'));
  click(newBtn2);
  await sleep(60);
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
    'typing restarts the window with BOTH narrowings: (query "adr", origin "user,plugin", scope "", denominator "", format "", cursor 0, 100)',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['adr', 'user,plugin', '', '', '', '', 0, 100]),
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
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user,plugin', '', '', '', '', 0, 100]) &&
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
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user,plugin', '', '', '', 'auto', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  type(search, 'adr');
  await sleep(DEBOUNCE);
  check(
    'the search composes with origin AND format in ONE call: (query "adr", origin "user,plugin", format "auto", …)',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['adr', 'user,plugin', '', '', '', 'auto', 0, 100]) &&
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
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'user,plugin', '', '', '', '', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(pageCalls[0]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  await setBox(r, 'Built-in', true);
  await sleep(DEBOUNCE);
  check(
    'Built-in back checked → the whole catalog window again',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
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
    JSON.stringify(pageCalls[0]) === JSON.stringify(['trade', '', '', '', 'rounds,none', '', 0, 100]) &&
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
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', '', '', '', '', 0, 100]) && rowsOf(r).length === 4,
    JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
  );
}

console.log('H. the filter checks are view-local registry state (restore all twenty, then reset to defaults)');
{
  // Leave a DISTINCT state behind — one option off in EACH of the
  // Origin, Denominator and Type groups (the Pinning pair and the
  // Denominator NONE box stay on), so the restore proves every one of
  // the twenty keys round-trip.
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
    'the parting state is user,plugin + Rounds/None minus Currency (Built-in, Matches and Currency off)',
    JSON.stringify(pageCalls[pageCalls.length - 1]) ===
      JSON.stringify(['', 'user,plugin', '', '', 'rounds,none', 'auto,int,float1,float2,percent,identity', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'plug_stat']),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  r = await mountBuilder(); // unmount → remount, registry intact
  await openFilters(r);
  check(
    'unmount → remount restores ALL twenty checks (only Built-in, Matches and Currency off)',
    JSON.stringify(allBoxesOf(r)) ===
      JSON.stringify([
        false, true, true, true, true, true, true, true, true, false, true, true, true, true,
        true, true, false, true, true, true,
      ]),
    JSON.stringify(allBoxesOf(r)),
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
    'resetViewState() → the next mount is back to the defaults (Built-in OFF / Custom + Plugin ON, every other option ON — Denominator all three, Type all seven, Pinning both)',
    JSON.stringify(allBoxesOf(r)) ===
      JSON.stringify([
        false, true, true, true, true, true, true, true, true, true, true, true, true, true,
        true, true, true, true, true, true,
      ]),
    JSON.stringify(allBoxesOf(r)),
  );
  check(
    '…and the default view is the user,plugin partition again',
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
    'one dialog, three stacked sections (scoreboard, profile, overview — no tabs)',
    [...(dlg?.querySelectorAll('.mo-sec-title') || [])].map((h) => h.textContent.trim()).join(' | ') ===
      'Scoreboard (match metrics) | Player profile (profile metrics) | Match overview (top cards)' &&
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
  // pointing back at the metric list; owner item 5: it names the third
  // table). Still the owner's domain, no dev shorthand.
  const note = (dlg?.querySelector('.mo-note')?.textContent || '').replace(/\s+/g, ' ').trim();
  check(
    'help line: fixed stats AND pinned metrics, reorder with the arrows, hide with the eye, unpin here in the dialog, the overview table picks the top cards; no dev-process phrase',
    /Fixed stats and pinned metrics are listed in order/.test(note) &&
      /hide a fixed stat with the eye/.test(note) &&
      /unpin a metric here/.test(note) &&
      /overview table picks the match top cards/.test(note) &&
      !/Go stats/i.test(dlg?.textContent || ''),
    note,
  );

  // N4: with nothing pinned the match section still lists the FIXED
  // stats — the old "nothing to order" / "no metrics yet" empty states
  // are gone (a fixed stat always has something to order and hide).
  // UNIFICATION (2026-11-18): the fixed block is exactly Name/Team/
  // Score — the five count entries are metric entities now (they land
  // as rows only when pinned, and this fixture's catalog carries none).
  check(
    'nothing pinned yet → the match section still lists the fixed stats in canonical order (no empty state, a real listbox)',
    !!sec('match') &&
      JSON.stringify(dNames('match')) === JSON.stringify(['@Name', '@Team', '@Score']) &&
      !!sec('match').querySelector('[role="listbox"]') &&
      !sec('match').querySelector('p[role="status"]'),
    sec('match')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
  );
  check(
    'the profile section has NO fixed rows (the pair unified with its metrics) — with an empty catalog and nothing pinned its list is empty',
    !!sec('profile') &&
      JSON.stringify(dNames('profile')) === JSON.stringify([]) &&
      !!sec('profile').querySelector('[role="listbox"]'),
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

  // The overview universe for the dialog (owner item 5): the ONE cached
  // listMetrics() gains the identity metrics — top_fragger (a DEFAULT
  // overview pin ⇒ its row opens pinned) and a user argmax (unpinned).
  // The Builder LIST behind the dialog is untouched: it pages through
  // ListMetricsPage, a separate stub over METRICS.
  const baseListMetrics = bindings.MetricsService.ListMetrics;
  bindings.MetricsService.ListMetrics = () =>
    Promise.resolve([
      ...METRICS,
      {
        id: 91, name: 'top_fragger', title: 'Top fragger', shortName: '',
        expr: 'from player_stats: argmax(kills)', scope: 'match', format: 'identity',
        doc: 'Formula: argmax(player_stats.kills)', origin: 'builtin', pluginId: '', denominator: '',
      },
      {
        id: 92, name: 'my_argmax', title: 'My leader', shortName: '',
        expr: 'from player_stats: argmax(kast)', scope: 'match', format: 'identity',
        doc: 'Formula: argmax(player_stats.kast)', origin: 'user', pluginId: '', denominator: '',
      },
    ]);
  services.invalidate(); // flush the cached catalog read so the open sees it

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
        rows.length === 6 &&
        rows.every((x) => x.getAttribute('role') === 'option' && x.getAttribute('aria-selected') === 'false'),
      !fixed && list
        ? `rows=${rows.length} cap="${cap?.textContent.trim()}" desc=${list.getAttribute('aria-describedby')}`
        : 'the read-only block is back',
    );
  }
  check(
    'the list = the fixed stats (canonical order) then the pinned metrics in sequence order — the unpinned trade_rate never appears',
    JSON.stringify(dNames('match')) ===
      JSON.stringify(['@Name', '@Team', '@Score', 'adr_avg', 'my_kd', 'plug_stat']) &&
      !dRows('match').some((x) => x.dataset.moName === 'trade_rate'),
    JSON.stringify(dNames('match')),
  );
  {
    // The show/hide toggle (N4/M1): every HIDEABLE fixed row carries
    // one — named Show/Hide {label} (never the word "pin": the eye is
    // visibility only; the PIN toggle on metric rows below is a
    // separate control), the Name column is EXEMPT (owner ruling), and
    // metric rows never carry a show/hide (their visibility is the pin
    // selection). Since the unification the fixed rows are exactly
    // Name/Team/Score: Team and Score carry the eye, Name does not.
    const rows = dRows('match');
    const toggleFor = (row) => row.querySelector('button[aria-label^="Show "], button[aria-label^="Hide "]');
    check(
      'every hideable fixed row carries a Show/Hide toggle; the Name column is exempt; metric rows never carry one',
      rows.slice(1, 3).every((x) => x.dataset.moKind === 'fixed' && !!toggleFor(x)) &&
        !toggleFor(rows[0]) &&
        rows.slice(3).every((x) => x.dataset.moKind === 'metric' && !toggleFor(x)),
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
      rows.length === 6 &&
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
    const up0 = rows[3]?.querySelector('[aria-label="Move ADR average up"]');
    const down0 = rows[3]?.querySelector('[aria-label="Move ADR average down"]');
    const upLast = rows[5]?.querySelector('[aria-label="Move Plugin stat up"]');
    const downLast = rows[5]?.querySelector('[aria-label="Move Plugin stat down"]');
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
    // the row TITLE reads the FULL name, the mono slot carries the SHORT
    // only when the two differ (Team never doubles to
    // "Team Team"). w19 item 5: a METRIC row now carries the same slot
    // from the metric's own short name (e.def.shortName) under the same
    // rule — ADR shows under "ADR average", while a metric with no
    // short name (my_kd) keeps NO slot (its title alone identifies it;
    // the old "Assists assists" title+name doubling stays dead). Since
    // the unification of 2026-11-18 every surviving fixed row is
    // short-equal (Name/Team/Score) so no fixed row shows a slot — the
    // K/D/DMG/Util/MVPs shorts live on as the count metrics' shortNames
    // (the scoreboard column headers). The aria labels derive from the
    // same visible full name (Hide Score / Move Score up) while
    // data-mo-name keeps the '@'-key identity (pinned by the dNames
    // lists above — unchanged).
    const rows = dRows('match');
    const scoreRow = rows.find((x) => x.dataset.moName === '@Score');
    const teamRow = rows.find((x) => x.dataset.moName === '@Team');
    const metricRow = rows.find((x) => x.dataset.moName === 'adr_avg');
    const shortRow = rows.find((x) => x.dataset.moName === 'my_kd');
    const monos = (row) =>
      [...(row?.querySelectorAll('.mo-name') || [])].map((s) => s.textContent.trim());
    check(
      'the mono short slot: none on the short-equal fixed rows, the metric short under its title, nothing when a metric has no short name',
      scoreRow?.querySelector('.mo-title')?.textContent.trim() === 'Score' &&
        monos(scoreRow).length === 0 &&
        teamRow?.querySelector('.mo-title')?.textContent.trim() === 'Team' &&
        monos(teamRow).length === 0 &&
        JSON.stringify(monos(metricRow)) === JSON.stringify(['ADR']) &&
        JSON.stringify(monos(shortRow)) === JSON.stringify([]),
      `Score monos=${JSON.stringify(monos(scoreRow))} Team monos=${JSON.stringify(monos(teamRow))} adr monos=${JSON.stringify(monos(metricRow))} my_kd monos=${JSON.stringify(monos(shortRow))}`,
    );
    check(
      "the fixed rows' aria labels derive from the visible FULL name — Hide Score / Move Score up and down; Team keeps Hide Team",
      !!scoreRow?.querySelector('button[aria-label="Hide Score"]') &&
        !!scoreRow?.querySelector('button[aria-label="Move Score up"]') &&
        !!scoreRow?.querySelector('button[aria-label="Move Score down"]') &&
        !!teamRow?.querySelector('button[aria-label="Hide Team"]'),
      (scoreRow || teamRow)
        ? [...(scoreRow?.querySelectorAll('button[aria-label]') || [])].map((b) => b.getAttribute('aria-label')).join(' | ')
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
        JSON.stringify(['@Name', '@Team', '@Score', 'my_kd', 'adr_avg', 'plug_stat']),
      JSON.stringify(dNames('match')),
    );
    const sets = bindings.calls.filter((c) => c.method === 'SetPref' && c.args[0] === 'metric_order_match');
    const set = sets[sets.length - 1];
    check(
      'the move is write-through: SetPref carries the key AND the whole merged sequence — fixed stats and the unpinned entry keep their slots',
      !!set &&
        JSON.stringify(set.args[1]) ===
          JSON.stringify([
            '@Name', '@Team', '@Score',
            'trade_rate', 'my_kd', 'adr_avg', 'plug_stat',
            // The identity metrics are match-catalog members too: they
            // sequence at rank ∞ behind the shown entries (owner item 5
            // — the fixture's dialog catalog carries them).
            'top_fragger', 'my_argmax',
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
        dNames('match').slice(3).join(',') === 'my_kd,plug_stat,adr_avg',
      `${document.activeElement?.className ?? 'none'} seq=${JSON.stringify(dNames('match').slice(3))}`,
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
        dRows('match').length === 6 &&
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
        eyes.length === 2 &&
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
    // Owner item 5 — the Match-overview table: its WHOLE identity
    // universe is listed (pin toggles ADD here — this table is the
    // overview's only picker, unlike the match/profile unpin-only
    // rows), the shipped default card opens pinned, and each write
    // lands on the table's own kvstore key.
    const ovRows = dRows('overview');
    check(
      'the overview table lists its identity universe in sequence order (the default-pinned card first, the unpinned user metric after)',
      JSON.stringify(ovRows.map((x) => x.dataset.moName)) ===
        JSON.stringify(['top_fragger', 'my_argmax']),
      JSON.stringify(ovRows.map((x) => x.dataset.moName)),
    );
    const ovTitle = (row) =>
      row?.querySelector('[aria-label^="Toggle pin"]')?.getAttribute('title') ?? '-';
    check(
      'the default card opens pinned (its row carries the unpin state); the unpinned metric offers the pin',
      ovRows[0]?.querySelector('[title="Unpin from overview"]') !== null &&
        ovRows[0]?.querySelector('[aria-label^="Toggle pin"]')?.getAttribute('aria-pressed') === 'true' &&
        ovRows[1]?.querySelector('[title="Pin as overview card"]') !== null,
      ovRows.map((x) => `${x.dataset.moName}:${ovTitle(x)}`).join(', '),
    );
    check(
      'overview rows are metric rows with ↑↓ and no eye (the eye stays a fixed-stat control)',
      ovRows.length > 0 &&
        ovRows.every(
          (x) => x.dataset.moKind === 'metric' && x.querySelector('.mo-moves') &&
            !x.querySelector('button[aria-label^="Hide "]'),
        ),
      ovRows.map((x) => `${x.dataset.moName}:${x.dataset.moKind}`).join(', '),
    );
    // Pin the user metric: the selection lands on ITS kvstore key —
    // never Builder's localStorage pins, and the order key is untouched.
    const ovOrderWrites = () =>
      bindings.calls.filter((c) => c.method === 'SetPref' && c.args[0] === 'metric_order_overview')
        .length;
    const orderWritesBefore = ovOrderWrites();
    click(ovRows[1].querySelector('[aria-label^="Toggle pin"]'));
    await sleep(80);
    const pinsSet = bindings.calls.filter((c) => c.method === 'SetPref' && c.args[0] === 'metric_pins_overview').pop();
    check(
      'pinning an overview card writes ONLY the overview pin key, carrying the whole set (default + the new one)',
      !!pinsSet &&
        JSON.stringify(pinsSet.args[1]) === JSON.stringify(['top_fragger', 'my_argmax']) &&
        ovOrderWrites() === orderWritesBefore,
      pinsSet ? JSON.stringify(pinsSet.args) : 'no SetPref',
    );
    // Reorder through the same write-through move() as every other
    // table — the moved sequence lands on the overview ORDER key.
    click(dRows('overview')[1]?.querySelector('[aria-label="Move My leader up"]'));
    await sleep(80);
    const orderSet = bindings.calls.filter((c) => c.method === 'SetPref' && c.args[0] === 'metric_order_overview').pop();
    check(
      'reordering the overview table writes its own order key with the moved sequence',
      !!orderSet && JSON.stringify(orderSet.args[1]) === JSON.stringify(['my_argmax', 'top_fragger']),
      orderSet ? JSON.stringify(orderSet.args) : 'no SetPref',
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
      'Reset order deletes BOTH pref PAIRS plus the overview pair — order, visibility and the card selection (the lead: every default restores)',
      JSON.stringify(dels.map((c) => c.args[0]).sort()) ===
        JSON.stringify([
          'metric_economy',
          'metric_hidden_match',
          'metric_hidden_profile',
          'metric_order_match',
          'metric_order_overview',
          'metric_order_profile',
          'metric_pins_overview',
        ]),
      JSON.stringify(dels.map((c) => c.args)),
    );
    check(
      'the list snaps back to the DEFAULT sequence (fixed stats + the pinned metrics, default order) after reset',
      JSON.stringify(dNames('match')) ===
        JSON.stringify(['@Name', '@Team', '@Score', 'adr_avg', 'my_kd', 'plug_stat']),
      JSON.stringify(dNames('match')),
    );
    const teamBack = dRows('match').find((x) => x.dataset.moName === '@Team');
    check(
      'Reset also SHOWS the hidden Team again (its row carries Hide, no hidden mark)',
      !!teamBack && !teamBack.classList.contains('mo-hidden') && !!teamBack.querySelector('button[aria-label="Hide Team"]'),
      teamBack ? `class=${teamBack.className}` : 'row gone',
    );
    const ovBack = dRows('overview');
    check(
      'Reset restores the overview table too — default order and the default card set (my_argmax unpinned again)',
      JSON.stringify(ovBack.map((x) => x.dataset.moName)) ===
        JSON.stringify(['top_fragger', 'my_argmax']) &&
        ovBack[0]?.querySelector('[title="Unpin from overview"]') !== null &&
        ovBack[1]?.querySelector('[title="Pin as overview card"]') !== null,
      ovBack.map((x) => `${x.dataset.moName}:${x.querySelector('[aria-label^="Toggle pin"]')?.getAttribute('title') ?? '-'}`).join(', '),
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
  // Restore the shared catalog stub (the identity fixture was this
  // dialog section's only consumer) and flush the cached read so later
  // mounts resolve through the original METRICS.
  bindings.MetricsService.ListMetrics = baseListMetrics;
  services.invalidate();
}

console.log(
  "K. the Scoreboard section's shape checkbox (w25): placement after its list, default off, the one key it writes, read-back on reopen, Reset leaves it alone",
);
{
  // w25 — the ordering dialog's THIRD pref (metricorder.js
  // STARTS_TRANSPOSED_KEY): "Scoreboard starts transposed" is the shape
  // a match OPENS in (the Match view reads it once per mount). Section J
  // left the dialog closed; open it fresh with NO GetPref handler, so
  // the read below is the honest absent-pref default (off).
  delete bindings.handlers.GetPref;
  delete bindings.handlers.SetPref;
  bindings.resetCalls();
  const orderBtn = [...r.querySelectorAll('.bld-list button')].find((b) =>
    b.textContent.includes('Order'),
  );
  if (orderBtn) click(orderBtn);
  await sleep(150);
  const dlgK = document.querySelector('.dlg-panel.mo-prompt');
  const matchSec = dlgK?.querySelector('.mo-sec[data-mo-scope="match"]');
  const profSec = dlgK?.querySelector('.mo-sec[data-mo-scope="profile"]');
  const box = matchSec?.querySelector('#mo-starts-transposed');
  const listEl = matchSec?.querySelector('.mo-list');
  const followsList = !!box && !!listEl &&
    (listEl.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  check(
    'the shape checkbox sits in the Scoreboard section AFTER its list, and never in the profile section',
    followsList && !profSec?.querySelector('#mo-starts-transposed'),
    box ? `afterList=${followsList}` : 'no #mo-starts-transposed in the match section',
  );
  check(
    'it opens UNCHECKED by default (no GetPref handler — absent ⇒ off) with the catalog label, over a bare-key read',
    !!box &&
      box.checked === false &&
      (box.closest('label')?.textContent || '').trim() === 'Scoreboard starts transposed' &&
      bindings.calls.some(
        (c) => c.method === 'GetPref' && c.args[0] === 'scoreboard_starts_transposed',
      ),
    box
      ? `checked=${box.checked} label="${(box.closest('label')?.textContent || '').trim()}"`
      : 'no box',
  );

  // The ONE writer: a stateful kvstore store goes in FIRST, so the click
  // below lands in it and the reopen reads that very value back.
  const store = {};
  bindings.handlers.GetPref = (k) => store[k];
  bindings.handlers.SetPref = (k, v) => {
    store[k] = v;
  };
  bindings.resetCalls();
  box?.click();
  await sleep(80);
  const sets = bindings.calls.filter((c) => c.method === 'SetPref');
  check(
    'the click writes SetPref("scoreboard_starts_transposed", true) — and ONLY that key',
    !!box &&
      box.checked === true &&
      sets.length === 1 &&
      sets[0].args[0] === 'scoreboard_starts_transposed' &&
      sets[0].args[1] === true &&
      store.scoreboard_starts_transposed === true,
    `checked=${box?.checked} sets=${JSON.stringify(sets.map((c) => c.args))}`,
  );

  // Close + reopen: the dialog re-reads on open, so the written value
  // comes back from the store — a fresh read, not the in-memory state.
  bindings.resetCalls();
  const closeBtn = dlgK?.querySelector('button[aria-label="Close"]');
  if (closeBtn) click(closeBtn);
  await sleep(60);
  const orderBtn2 = [...r.querySelectorAll('.bld-list button')].find((b) =>
    b.textContent.includes('Order'),
  );
  if (orderBtn2) click(orderBtn2);
  await sleep(150);
  const dlgK2 = document.querySelector('.dlg-panel.mo-prompt');
  const box2 = dlgK2?.querySelector('#mo-starts-transposed');
  const reads = bindings.calls.filter(
    (c) => c.method === 'GetPref' && c.args[0] === 'scoreboard_starts_transposed',
  );
  check(
    'close + reopen re-reads the bare key through the store and comes back CHECKED',
    !!box2 && box2.checked === true && reads.length >= 1 && store.scoreboard_starts_transposed === true,
    box2 ? `checked=${box2.checked} reads=${reads.length}` : 'no reopened dialog',
  );

  // Reset order (lead ruling): it restores ORDER + VISIBILITY only — the
  // shape is neither, so no SetPref/Delete may ever target its key here.
  bindings.resetCalls();
  const resetBtn = [...(dlgK2?.querySelectorAll('button') || [])].find((b) =>
    b.textContent.includes('Reset order'),
  );
  if (resetBtn) click(resetBtn);
  await sleep(80);
  const shapeCalls = bindings.calls.filter((c) => c.args[0] === 'scoreboard_starts_transposed');
  check(
    'Reset order writes/deletes NOTHING for the shape key (the checkbox stays as it was)',
    shapeCalls.length === 0 && !!box2 && box2.checked === true,
    JSON.stringify(bindings.calls.map((c) => [c.method, c.args[0]])),
  );

  delete bindings.handlers.GetPref;
  delete bindings.handlers.SetPref;
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
    expr: 'from player_stats: argmax(kills)', scope: 'match', subject: 'match',
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
        JSON.stringify(['', '', '', '', '', 'identity', 0, 100]) &&
        JSON.stringify(namesOf(r)) === JSON.stringify(['top_fragger']) &&
        JSON.stringify(headersOf(r)) === JSON.stringify(['Builtins']),
      JSON.stringify(pageCalls[pageCalls.length - 1]) +
        ' rows=' +
        JSON.stringify(namesOf(r)) +
        ' headers=' +
        JSON.stringify(headersOf(r)),
    );
    check(
      'the identity row wears the identity format chip beside its scope and none-denominator chips',
      JSON.stringify(chipsOf(r, 'top_fragger')) === JSON.stringify(['match', 'none', 'identity']),
      JSON.stringify(chipsOf(r, 'top_fragger')),
    );
    const idChip = rowNamed(r, 'top_fragger')?.querySelector('.bld-row-sub .chip.status');
    check(
      'the identity row renders the established five-state chip (behind — the computed state, never a fabricated value)',
      !!idChip && (idChip.getAttribute('title') || '').includes('value not available yet'),
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

console.log('L. the unpin-removes-row contract + the Economy placement toggle (match rows, $ glyph, pref round-trip, overview exclusion, Reset)');
{
  // Fresh-install shape: BOTH pins keys absent and a catalog carrying
  // default-pinned names — kills (DEFAULT_PINS.match), career_adr
  // (DEFAULT_PINS.profile), pistol_hold (a DEFAULT_ECONOMY member, so
  // the shipped economy set resolves to it) and the identity pair for
  // the overview table. GetMetric scripts the WHOLE set (the real
  // backend serves any stored id).
  localStorage.setItem('spectra:pinned-metrics', JSON.stringify(['kills', 'pistol_hold', 'top_fragger']));
  localStorage.setItem('spectra:pinned-profile-metrics', JSON.stringify(['career_adr']));
  const withDefaults = [
    ...METRICS,
    { id: 91, name: 'top_fragger', title: 'Top fragger', shortName: '',
      expr: 'from player_stats: argmax(kills)', scope: 'match', subject: 'match',
      format: 'identity', doc: 'Formula: argmax(player_stats.kills)', origin: 'builtin', pluginId: '', denominator: '' },
    { id: 93, name: 'kills', title: 'Kills', shortName: '',
      expr: 'from player_stats: sum(kills)', scope: 'match', subject: 'player',
      format: 'int', doc: 'Formula: sum(player_stats.kills)', origin: 'builtin', pluginId: '', denominator: '' },
    { id: 94, name: 'career_adr', title: 'Career ADR', shortName: '',
      expr: 'from player_stats: avg(adr)', scope: 'profile', subject: 'player',
      format: 'float1', doc: 'Formula: average ADR', origin: 'builtin', pluginId: '', denominator: '' },
    { id: 95, name: 'pistol_hold', title: 'Pistol \u2192 next round', shortName: '',
      expr: 'from rounds, round_classifications: ratio(count(where label = \'pistol\'), count(where label = \'pistol\'))',
      scope: 'match', subject: 'match', format: 'percent',
      doc: 'Formula: pistol rounds held \u00f7 pistol rounds won \u2014 addressed per match',
      origin: 'builtin', pluginId: '', denominator: '' },
  ];
  const prevList = bindings.MetricsService.ListMetrics;
  const prevGet = bindings.handlers.GetMetric;
  bindings.MetricsService.ListMetrics = () => Promise.resolve(withDefaults);
  bindings.handlers.GetMetric = (id) => withDefaults.find((m) => m.id === id) || null;
  services.invalidate();
  try {
    r = await mountBuilder();
    const orderBtn = [...r.querySelectorAll('.bld-list button')].find((b) => b.textContent.includes('Order'));
    click(orderBtn);
    await sleep(150);
    let dlg = document.querySelector('.dlg-panel.mo-prompt');
    const sec = (scope) => dlg?.querySelector(`.mo-sec[data-mo-scope="${scope}"]`);
    const dRows = (scope) => [...(sec(scope)?.querySelectorAll('.mo-row') || [])];
    const dNames = (scope) => dRows(scope).map((x) => x.dataset.moName);
    const econBtn = (row) => row?.querySelector('[aria-label^="Toggle Economy tab"]');
    const prefSet = (key) =>
      [...bindings.calls].reverse().find((c) => c.method === 'SetPref' && c.args[0] === key);

    check(
      'the dialog lists the pinned match/profile metrics (sequence order) and the shipped economy set opens TOGGLED ON (pistol_hold)',
      JSON.stringify(dNames('match')) ===
        JSON.stringify(['@Name', '@Team', 'kills', '@Score', 'top_fragger', 'pistol_hold']) &&
        JSON.stringify(dNames('profile')) === JSON.stringify(['career_adr']),
      JSON.stringify(dNames('match')) + ' profile=' + JSON.stringify(dNames('profile')),
    );
    const pistolRow = () => dRows('match').find((x) => x.dataset.moName === 'pistol_hold');
    check(
      'match metric rows carry the Economy toggle with aria-pressed on for a default-set metric (and profile rows never do)',
      econBtn(pistolRow())?.getAttribute('aria-pressed') === 'true' &&
        econBtn(pistolRow())?.getAttribute('title') === 'Remove from the Economy tab' &&
        !!econBtn(pistolRow())?.querySelector('.codicon-credit-card') &&
        dRows('profile').every((x) => !econBtn(x)),
      econBtn(pistolRow()) ? `pressed=${econBtn(pistolRow()).getAttribute('aria-pressed')} title=${econBtn(pistolRow()).getAttribute('title')}` : 'no toggle',
    );

    // The toggle is PLACEMENT only: the row stays listed, pin state is
    // untouched, and the write lands on the one kvstore key.
    const matchPinsBefore = localStorage.getItem('spectra:pinned-metrics');
    click(econBtn(pistolRow()));
    await sleep(80);
    let ecoSet = prefSet('metric_economy');
    check(
      'untoggling a default-set metric writes ONLY metric_economy (the resolved set minus it) and the row stays listed',
      !!ecoSet && JSON.stringify(ecoSet.args[1]) === JSON.stringify([]) &&
        dNames('match').includes('pistol_hold') &&
        econBtn(pistolRow())?.getAttribute('aria-pressed') === 'false' &&
        localStorage.getItem('spectra:pinned-metrics') === matchPinsBefore,
      ecoSet ? JSON.stringify(ecoSet.args) : 'no SetPref' + ' rows=' + JSON.stringify(dNames('match')),
    );

    // Toggle a NON-default metric on → the set gains it (write-through
    // from the resolved default).
    click(econBtn(dRows('match').find((x) => x.dataset.moName === 'kills')));
    await sleep(80);
    ecoSet = prefSet('metric_economy');
    check(
      'toggling another match metric on adds it to the economy set (write-through: resolved default + the name)',
      !!ecoSet && JSON.stringify(ecoSet.args[1]) === JSON.stringify(['kills']) &&
        econBtn(dRows('match').find((x) => x.dataset.moName === 'kills'))?.getAttribute('aria-pressed') === 'true',
      ecoSet ? JSON.stringify(ecoSet.args) : 'no SetPref',
    );

    // THE OVERVIEW EXCLUSION (binding): top_fragger is an identity
    // metric, pinned in BOTH the match section and the overview
    // section. Economy-toggling it moves its placement — its overview
    // row disappears (the card would render on the Economy tab
    // instead), its match row stays with the toggle on. Toggling back
    // restores the overview row. Driver pin, both directions.
    const ovNames = () => dRows('overview').map((x) => x.dataset.moName);
    check(
      'the identity metric opens in BOTH the match and overview sections (pinned as an overview card)',
      dNames('match').includes('top_fragger') && ovNames().includes('top_fragger'),
      JSON.stringify(dNames('match')) + ' overview=' + JSON.stringify(ovNames()),
    );
    const topRow = () => dRows('match').find((x) => x.dataset.moName === 'top_fragger');
    click(econBtn(topRow()));
    await sleep(80);
    ecoSet = prefSet('metric_economy');
    check(
      'economy-toggling the identity metric KEEPS its match row (toggle on) and REMOVES it from the overview section — the placement carve-out, both directions',
      !!ecoSet && JSON.stringify(ecoSet.args[1]).includes('top_fragger') &&
        econBtn(topRow())?.getAttribute('aria-pressed') === 'true' &&
        !ovNames().includes('top_fragger'),
      ecoSet ? JSON.stringify(ecoSet.args) + ' overview=' + JSON.stringify(ovNames()) : 'no SetPref',
    );
    click(econBtn(topRow()));
    await sleep(80);
    ecoSet = prefSet('metric_economy');
    check(
      'toggling it OFF restores the overview row (the exclusion is the only thing that hid it)',
      !!ecoSet && !JSON.stringify(ecoSet.args[1]).includes('top_fragger') &&
        ovNames().includes('top_fragger'),
      ecoSet ? JSON.stringify(ecoSet.args) + ' overview=' + JSON.stringify(ovNames()) : 'no SetPref',
    );

    // THE UNPIN CONTRACT (owner bug 2026-11-18): a repeat click while
    // the first write is in flight must NOT re-pin the metric — the
    // dialog's pin button is unpin-ONLY, so the writer applies
    // "remove" idempotently (intent 'off'). Two rapid clicks used to
    // toggle twice and the row stayed (RED on base).
    const killRow = () => dRows('match').find((x) => x.dataset.moName === 'kills');
    click(econBtn(killRow())); // leave kills economy-untoggled first
    await sleep(60);
    const kPin = () => killRow()?.querySelector('[aria-label^="Toggle pin"]');
    click(kPin());
    click(kPin());
    await sleep(150);
    check(
      'double-clicking a match metric\u2019s pin still removes the row (the second click cannot re-pin it)',
      !dNames('match').includes('kills') &&
        !JSON.parse(localStorage.getItem('spectra:pinned-metrics') || '[]').includes('kills'),
      JSON.stringify(dNames('match')) + ' storage=' + localStorage.getItem('spectra:pinned-metrics'),
    );
    // The same contract for a PROFILE metric (the other unpin-only
    // section) — one click, idempotent by the same writer.
    const profPin = () => dRows('profile').find((x) => x.dataset.moName === 'career_adr')
      ?.querySelector('[aria-label^="Toggle pin"]');
    click(profPin());
    await sleep(120);
    check(
      'unpinning the profile metric removes its row too (the same intent writer across sections)',
      !dNames('profile').includes('career_adr'),
      JSON.stringify(dNames('profile')),
    );

    // RESET restores the shipped economy set (the placement family is
    // Reset-cleared) — the toggle snaps back to the default member.
    click(econBtn(pistolRow())); // toggle pistol_hold OFF (materialize a non-default set)
    await sleep(60);
    const resetBtn = [...dlg.querySelectorAll('button')].find((b) => b.textContent.includes('Reset order'));
    click(resetBtn);
    await sleep(100);
    const dels = bindings.calls.filter((c) => c.method === 'Delete').map((c) => c.args[0]);
    check(
      'Reset deletes metric_economy with the other placement prefs and the default set resolves back (pistol_hold toggled on)',
      dels.includes('metric_economy') &&
        econBtn(pistolRow())?.getAttribute('aria-pressed') === 'true',
      JSON.stringify(dels) + ' pressed=' + econBtn(pistolRow())?.getAttribute('aria-pressed'),
    );

    dlg.querySelector('button[aria-label="Close"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
  } finally {
    bindings.MetricsService.ListMetrics = prevList;
    bindings.handlers.GetMetric = prevGet;
    services.invalidate();
    localStorage.removeItem('spectra:pinned-metrics');
    localStorage.removeItem('spectra:pinned-profile-metrics');
  }
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
