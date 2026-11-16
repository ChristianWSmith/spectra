<script>
  import * as S from '../strings/index.js';
  import {
    listMetricsPage,
    listMetrics,
    listMatches,
    listPlayers,
    getMetric,
    saveMetric,
    deleteMetric,
    previewMetric,
    compileMetric,
    getMetricValuesForMatch,
    getMetricValuesForPlayer,
    getMetricComputeState,
    subscribeMetricProgress,
    onMetricDone,
    validateExpr,
    listPlugins,
    errText,
  } from '../services.js';
  import { resolvePinIds } from '../metricorder.js';
  import {
    liveMetricState,
    metricStateTitle,
    metricProgressFrac,
    metricProgressStage,
  } from '../metricstate.js';
  import { fmtInt, fmtMetric } from '../fmt.js';
  import { METRIC_FORMATS, formatFilterWord } from '../metricformats.js';
  import ProfileLink from '../components/ProfileLink.svelte';
  import SortTh from '../components/SortTh.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import MetricOrderDialog from '../components/MetricOrderDialog.svelte';
  import Popover from '../components/Popover.svelte';
  import { seed, remember } from '../viewstate.svelte.js';

  let { nav = () => {}, openDocs = () => {} } = $props();

  // localStorage contract (M5 §2.1): TWO keys, one mechanism, routed by
  // the metric's scope (stored-metrics design §3) —
  //   'spectra:pinned-metrics'           match scope  → Match scoreboard
  //   'spectra:pinned-profile-metrics'   profile scope → PlayerProfile's
  //                                              Career metrics panel
  // Builder owns every write (the pin toggles below); the views read
  // their own key and resolve ids through listMetrics() (a deleted
  // metric drops out there), and deleteMetric drops its id from BOTH
  // keys so an array can never keep a ghost.
  const PINS_KEY = 'spectra:pinned-metrics';
  const PROFILE_PINS_KEY = 'spectra:pinned-profile-metrics';

  const PREVIEW_LIMIT = 200;
  // Placeholder shows the current grammar: a single source, or a comma
  // list the engine joins (doc.go — the join extension).
  const EXAMPLE = 'from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))';

  // Window size for the metric list: one page per fetch, one more per
  // Load-more click (backend default store.ListMetricsPageSize is the
  // same 100 — the button's row counts and the store's window agree).
  const PAGE_SIZE = 100;

  // metrics is the ACCUMULATED keyset windows (never a whole-library
  // fetch) in the store's canonical builtin → user → plugin / name
  // order — the group headers below are derived from those contiguous
  // origin runs. hasNext is the backend's limit+1 probe.
  let metrics = $state([]);
  let hasNext = $state(false);
  // First-window gate for the empty state — transient by the
  // State-placement rule: never seeded, never remembered, never in the
  // URL (it re-arms on every refresh, but only shows while the list is
  // still empty).
  let loading = $state(true);
  let loadingMore = $state(false);
  let pins = $state([]); // match-scope pin ids (PINS_KEY)
  let profilePins = $state([]); // profile-scope pin ids (PROFILE_PINS_KEY)
  let disabledPlugins = $state(new Set());
  let listError = $state('');
  // The library-wide catalog the ABSENT pins key resolves its
  // DEFAULT_PINS through (design §1.6 — one cached listMetrics() read,
  // shared with the Order dialog) and the in-flight promise for it, so
  // a pin toggle in the first milliseconds after mount waits for the
  // catalog instead of writing from an unresolved selection.
  let catalog = [];
  let catalogP = Promise.resolve([]);
  // The Order dialog's open state — transient by the state-placement
  // rule: never seeded, never remembered, never in the URL.
  let orderOpen = $state(false);

  function openOrder() {
    orderOpen = true;
  }

  // The filter multi-select's open state + its two anchors — transient
  // by the state-placement rule (a popover): never seeded, never
  // remembered, never in the URL, so every mount starts closed. The
  // anchor is the canonical Popover's outside/Escape target, the
  // trigger is where a keyboard dismissal returns focus.
  let filterOpen = $state(false);
  let filterAnchor = $state(null);
  let filterTrigger = $state(null);

  // Dismissal split (MatchPicker's): Escape returns focus to the
  // trigger — focus must not strand on a node the panel just removed —
  // while a pointer dismissal leaves it where the click put it.
  function closeFilters() {
    filterOpen = false;
    filterTrigger?.focus();
  }

  function closeFiltersOutside() {
    filterOpen = false;
  }

  // --- Compute state + progress (design §4/§5) -----------------------------
  // The Builder is THE compute-state surface: every list item and the
  // editor card wear the state chip (all five words), and processing
  // quantifies with the live k/N feed. The state map is fetched on mount
  // and refetched on every spectra:metric-done (the sweep's outcome —
  // the transient words plus fresh/behind both move there); the
  // progress map is the live feed (a sweep starting mid-session flips
  // the chips without a refetch).
  let computeStates = $state(new Map()); // metricId → {state, error}
  let metricProgress = $state(new Map()); // metricId → {stage, done, total}

  function loadComputeState() {
    getMetricComputeState()
      .then((rows) => {
        computeStates = new Map((rows || []).map((s) => [s.metricId, s]));
      })
      .catch(() => {
        // A failed state read leaves the map as it was — a chip is
        // never GUESSED; the list's own error slot covers the reads
        // that gate this view (both come from the same backend).
      });
  }

  $effect(() => {
    loadComputeState();
    return onMetricDone(() => {
      loadComputeState();
      reloadPreview(); // a clean-saved preview re-reads its replaced rows
    });
  });
  $effect(() => subscribeMetricProgress((snap) => (metricProgress = snap)));

  // stateOf/stateErrorOf: the LIVE word (progress feed wins over the
  // refetch-time state — lib/metricstate.js) and the failed metric's
  // engine error (the chip's tooltip; never a stamp).
  function stateOf(id) {
    return liveMetricState(metricProgress, computeStates, id);
  }
  function stateErrorOf(id) {
    const s = computeStates.get(id);
    return (s && s.error) || '';
  }
  // The editor card's honest k/N detail (design §4: "k/N detail
  // underneath"); falls back to the plain word while the feed carries
  // no denominator for this metric yet (never a fabricated 0 of 0).
  function computeDetail(id) {
    const p = metricProgress.get(id);
    if (p && p.total > 0) return `computing ${p.done} of ${p.total} metrics`;
    return 'recomputing';
  }

  // The editor form (fields + the dirty-check baseline), the list's
  // search text and the filter multi-select's TWELVE CHECKBOXES are
  // view-local state: they restore across navigation through the
  // process-scoped registry (viewstate.svelte.js — flat key; they
  // travel together so the unsaved-changes flag, the search and the
  // filter checks read exactly as they did on leave; the search is the
  // Profiles precedent). The panel's OPEN state is transient (above).
  // Saving, previews, errors, the window cursor and the pin list stay
  // transient / their own store.
  const bldSeed = seed('builder', {
    form: newForm(),
    baseline: '',
    query: '',
    // Origin group: the owner's STANDING default — Built-in OFF, My
    // metrics ON — so the initial view lists the user's own metrics
    // (user + plugin). The Scope and Denominator groups start BOTH
    // options ON (the owner's addendum: "both scopes and both
    // denominators toggled on"), so neither narrows the first render.
    // Each group narrows SERVER-side only when an option goes off
    // (originFilter / scopeFilter / denomFilter below), and both-off is
    // legal in every group.
    builtin: false,
    mine: true,
    scopeMatch: true,
    scopeProfile: true,
    denomRounds: true,
    denomMatches: true,
    // Type group: the owner's ruling ("all six checked — auto + int +
    // float1 + float2 + percent + currency") — only Built-in starts off,
    // so the first render is unfiltered on every group but Origin.
    formatAuto: true,
    formatInt: true,
    formatFloat1: true,
    formatFloat2: true,
    formatPercent: true,
    formatCurrency: true,
  });
  let form = $state(bldSeed.form);
  let baseline = $state(bldSeed.baseline);
  let query = $state(bldSeed.query);
  let builtin = $state(bldSeed.builtin);
  let mine = $state(bldSeed.mine);
  let scopeMatch = $state(bldSeed.scopeMatch);
  let scopeProfile = $state(bldSeed.scopeProfile);
  let denomRounds = $state(bldSeed.denomRounds);
  let denomMatches = $state(bldSeed.denomMatches);
  let formatAuto = $state(bldSeed.formatAuto);
  let formatInt = $state(bldSeed.formatInt);
  let formatFloat1 = $state(bldSeed.formatFloat1);
  let formatFloat2 = $state(bldSeed.formatFloat2);
  let formatPercent = $state(bldSeed.formatPercent);
  let formatCurrency = $state(bldSeed.formatCurrency);
  $effect(() =>
    remember('builder', {
      form,
      baseline,
      query,
      builtin,
      mine,
      scopeMatch,
      scopeProfile,
      denomRounds,
      denomMatches,
      formatAuto,
      formatInt,
      formatFloat1,
      formatFloat2,
      formatPercent,
      formatCurrency,
    }),
  );
  let saveError = $state('');
  let saving = $state(false);

  // Live expression check: debounced 400 ms → validateExpr.
  // state: idle | pending | valid | error
  let exprCheck = $state({ state: 'idle' });
  let exprSeq = 0;

  let preview = $state(null); // {rows, format, sql, ms?, truncated?, match?, scope?}
  let previewAdhoc = $state(false);
  // previewKey identifies the SAVED definition a clean-saved preview
  // read ({id, scope}; null for an ad-hoc draft) — what a completed
  // sweep reloads and what pins the draft-vs-saved criterion.
  let previewKey = $state(null);
  let previewError = $state('');
  let previewBusy = $state(false);
  // Preview rows sort CLIENT-side (the bound is small — an ad-hoc run is
  // capped, a stored read is a roster or a career bucket), the same way
  // Profiles/Match keep their table sorts: transient view state, never in
  // the URL (a sort is not shareable) and never in the registry (this
  // view's own placement comment above keeps previews transient).
  //
  // Each header sorts its column. The NUMERIC columns (value, N) compare
  // by VALUE — never the formatted text, so "5%" cannot sort before
  // "41.2%" as text — and both take DESCENDING as their natural
  // direction, so the default order is N highest-first (the owner's
  // ruling); text columns start A→Z. Rows whose key is not a number sort
  // last either way (a gap is not a zero), and ties keep arrival order
  // (Array#sort is stable), so a fresh preview still renders what the
  // read returned.
  const PREVIEW_SORT_DEFAULT_DESC = { group: false, label: false, value: true, n: true };
  let previewSortKey = $state('n');
  let previewSortDesc = $state(true);

  // numKey reads a sort key as a NUMBER: numeric text ("13", "0.412")
  // compares as its value, anything unnumbered ("", null, "abc") is a
  // gap — never 0, which would let a gap win an ascending sort.
  function numKey(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  const sortedPreviewRows = $derived.by(() => {
    const key = previewSortKey;
    const dir = previewSortDesc ? -1 : 1;
    const rows = [...(preview ? preview.rows : [])];
    rows.sort((a, b) => {
      if (key === 'value' || key === 'n') {
        const av = numKey(a[key]);
        const bv = numKey(b[key]);
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0; // both gaps: keep arrival order
          return av === null ? 1 : -1; // gaps sort LAST either way
        }
        return (av - bv) * dir;
      }
      return String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * dir;
    });
    return rows;
  });

  // First click on an inactive header → that column's natural direction;
  // a second click on the ACTIVE header flips it (SortTh's contract, as
  // in Library/Profiles).
  function togglePreviewSort(key) {
    if (previewSortKey === key) previewSortDesc = !previewSortDesc;
    else {
      previewSortKey = key;
      previewSortDesc = !!PREVIEW_SORT_DEFAULT_DESC[key];
    }
  }
  // The format the preview's value column renders with: every preview
  // carries the format it was rendered for — an AD-HOC preview echoes
  // the FORM's (the definition being edited), a SAVED preview the stored
  // definition's. The distinction matters because the row play can
  // preview a BUILT-IN without loading it, so the form may hold a
  // different metric (or none) than the one on screen.
  const previewFormat = $derived(preview ? preview.format || '' : '');

  function newForm() {
    return {
      id: 0,
      name: '',
      title: '',
      shortName: '',
      expr: '',
      scope: 'match',
      format: '',
      denominator: '',
      doc: '',
      origin: 'user',
      pluginId: '',
    };
  }

  function snapshot(f) {
    return JSON.stringify({
      name: f.name,
      title: f.title,
      shortName: f.shortName,
      expr: f.expr,
      scope: f.scope,
      format: f.format,
      denominator: f.denominator,
      doc: f.doc,
    });
  }

  // readPins: the RAW stored selection — null when the key is ABSENT.
  // The absent-vs-present rule lives in metricorder.resolvePinIds
  // (design §1.6): absent ⇒ DEFAULT_PINS resolved by name through the
  // catalog, present (even '[]') ⇒ the stored selection verbatim.
  function readPins(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      return [...new Set(arr.map(Number).filter((n) => Number.isFinite(n)))];
    } catch {
      return null;
    }
  }

  // effectivePins — the selection this surface ACTUALLY shows (and the
  // base every toggle writes FROM, so a first pin toggle can never
  // silently drop the defaults): the stored ids when the key is
  // present, DEFAULT_PINS (name → id through the loaded catalog) when
  // it is absent. A still-empty catalog resolves defaults to [] — the
  // mount effect re-applies this once listMetrics lands.
  function effectivePins(key, scope) {
    const stored = readPins(key);
    if (stored !== null) return stored;
    return resolvePinIds(scope, null, catalog);
  }

  function writePins(key, ids) {
    try {
      localStorage.setItem(key, JSON.stringify(ids));
    } catch {
      /* storage unavailable — pins stay session-local */
    }
  }

  // pinnedIn reports which key owns the id ("" = unpinned): a metric
  // lives in exactly ONE key, so the icon/label never has to guess a
  // surface.
  function pinnedIn(id) {
    if (pins.includes(id)) return 'match';
    if (profilePins.includes(id)) return 'profile';
    return '';
  }

  // The pin button's label: the scope names the SURFACE the metric
  // reaches (design §3 — match → a scoreboard column, profile → the
  // player's Career metrics panel).
  function pinTitle(m) {
    const on = pinnedIn(m.id) !== '';
    if (m.scope === 'profile') return on ? 'Unpin from player profile' : 'Pin to player profile';
    return on ? 'Unpin from scoreboard' : 'Pin as scoreboard column';
  }

  // The left list's group runs: the paged read is origin-contiguous
  // (store metricOrder — builtin → user → plugin, name ASC), so the
  // accumulated windows form one run per origin present. The markup
  // renders ONE header per run, so a window boundary inside a group
  // never repeats a header — the final look matches the unpaginated
  // grouped list.
  const GROUP_LABEL = { builtin: 'Builtins', user: 'Yours', plugin: 'Plugins' };
  const runs = $derived.by(() => {
    const out = [];
    for (const m of metrics) {
      const last = out[out.length - 1];
      if (last && last.origin === m.origin) last.rows.push(m);
      else out.push({ origin: m.origin, rows: [m] });
    }
    return out;
  });

  const dirty = $derived(snapshot(form) !== baseline);
  // readOnly — a loaded definition the API never updates in place: a
  // PLUGIN row forks on save (payload id 0 → a new user copy), a
  // BUILT-IN row is not savable at all (saveDisabled below). Both wear
  // the form's read-only chip; neither ever shows a delete control.
  const readOnly = $derived(form.origin !== 'user');
  // saveDisabled — THE promise for a loaded built-in (owner wave): the
  // Save button stays off whatever the dirty flag says — the baseline
  // is re-snapshotted with every load, so neither a clean load nor an
  // edit can re-enable it. The service-level SaveMetric/DeleteMetric
  // guards (60ecdb7) are the backstop behind this, not a substitute.
  const builtinLoaded = $derived(form.origin === 'builtin');
  const saveDisabled = $derived(saving || builtinLoaded);

  // originFilter — THE one checked-set → server-word derivation (the
  // multi-select's Origin group): both checked = the whole catalog
  // (''), Built-in only / My metrics only = the store's partition words,
  // neither checked = 'none' (an empty list — legal, it falls out of the
  // same read path). "mine" is the store's complement (origin <>
  // 'builtin': user + plugin), so the options can never disagree with
  // the store about what "mine" means. It rides the list read's args —
  // see refreshList — so it restarts the window exactly like a search
  // change does (the effect below reads it) and joins listMetricsPage's
  // cache key for free (services.js).
  const originFilter = $derived.by(() => {
    if (builtin && mine) return '';
    if (builtin) return 'builtin';
    if (mine) return 'mine';
    return 'none';
  });

  // scopeFilter / denomFilter — the SAME derivation over the other two
  // groups (Match / Profile, Rounds / Matches): both checked = no
  // predicate, one checked = that side, neither = 'none'. The store
  // owns what each word means — including the denominator group's
  // denominator-less rule (a row with no denominator passes in every
  // state, so its "none" is not the empty set the other two spell).
  const scopeFilter = $derived.by(() => {
    if (scopeMatch && scopeProfile) return '';
    if (scopeMatch) return 'match';
    if (scopeProfile) return 'profile';
    return 'none';
  });
  const denomFilter = $derived.by(() => {
    if (denomRounds && denomMatches) return '';
    if (denomRounds) return 'rounds';
    if (denomMatches) return 'matches';
    return 'none';
  });

  // formatFilter — the fourth group's (Type) checked-set → server word:
  // unlike the three PAIRS it is six checkboxes, so the derivation is
  // the canonical one in lib/metricformats.js (all six = '' no
  // predicate, none = 'none', otherwise the canonical comma-subset —
  // "auto" being the format select's Auto, the '' format). Same
  // plumbing as the others: it rides the list read's args (refreshList
  // below restarts the window on any flip) and joins
  // listMetricsPage's cache key for free (services.js).
  const formatFilter = $derived(
    formatFilterWord({
      auto: formatAuto,
      int: formatInt,
      float1: formatFloat1,
      float2: formatFloat2,
      percent: formatPercent,
      currency: formatCurrency,
    }),
  );

  // The search text AND the four filters the current window sequence
  // serves: refreshList writes them, loadMore reads them (the cursor's
  // query + filters) and the empty-result copy below names the query —
  // $state because the template references them.
  let appliedQuery = $state('');
  let appliedFilter = $state('');
  let appliedScope = $state('');
  let appliedDenom = $state('');
  let appliedFormat = $state('');
  // listGen distinguishes the current window sequence from stale replies
  // (see refreshList/loadMore); non-reactive on purpose — it is not state.
  let listGen = 0;

  // The plugin states fire-and-forget on mount AND on Retry: they never
  // wait on the metric read (nor on its failure).
  function loadPluginStates() {
    listPlugins()
      .then((states) => {
        disabledPlugins = new Set(
          (states || []).filter((s) => !s.enabled).map((s) => s.manifest.id),
        );
      })
      .catch(() => {});
  }

  // Mount (runs once — it reads no reactive value): pins from
  // localStorage once per mount (a retry must not re-derive them over
  // the session's toggles) plus the plugin states. The stored
  // selection applies immediately; an ABSENT key resolves its
  // DEFAULT_PINS (design §1.6) once the library-wide catalog lands —
  // re-reading localStorage at that point is safe because every pin
  // write goes through writePins first (localStorage is the session's
  // truth).
  $effect(() => {
    pins = readPins(PINS_KEY) ?? [];
    profilePins = readPins(PROFILE_PINS_KEY) ?? [];
    loadPluginStates();
    catalogP = listMetrics()
      .then((rows) => {
        catalog = rows || [];
        pins = effectivePins(PINS_KEY, 'match');
        profilePins = effectivePins(PROFILE_PINS_KEY, 'profile');
        return catalog;
      })
      .catch(() => catalog);
  });

  // The list read (mount AND listError's Retry): the first run is
  // immediate (the list loads without the debounce delay), later runs
  // fire 250 ms after a query OR filter change (the Library's debounce)
  // so typing doesn't hammer the store — and ANY checkbox flip in the
  // multi-select (origin, scope, denominator or format) lands on this
  // SAME path, which restarts the window at cursor 0 (a filter change
  // never appends onto the previous filter's windows).
  let firstList = true;
  $effect(() => {
    const q = query;
    const f = originFilter;
    const sc = scopeFilter;
    const dn = denomFilter;
    const fm = formatFilter;
    if (firstList) {
      firstList = false;
      refreshList(q, f, sc, dn, fm);
      return;
    }
    const t = setTimeout(() => refreshList(q, f, sc, dn, fm), 250);
    return () => clearTimeout(t);
  });

  // Retry: the error slot's button — plugin states + a fresh first
  // window for the query/filters currently in play.
  async function loadLists() {
    loadPluginStates();
    await refreshList(query, originFilter, scopeFilter, denomFilter, formatFilter);
  }

  // refreshList RESTARTS the window sequence: cursor 0, replace — a
  // search change, a filter change (any of the four groups), a
  // save/delete refresh or a Retry must never APPEND onto the previous
  // window's rows. listGen tags the sequence so a Load-more reply
  // landing after a restart is dropped instead of appended (the
  // Library's refreshList/loadMore shape). Every narrowing is
  // SERVER-side (query LIKE + originFilter + scopeFilter + denomFilter +
  // formatFilter — store.ListMetricsPage), never a client-side slice of
  // a window.
  async function refreshList(q = '', f = '', sc = '', dn = '', fm = '') {
    appliedQuery = q;
    appliedFilter = f;
    appliedScope = sc;
    appliedDenom = dn;
    appliedFormat = fm;
    const gen = ++listGen;
    loading = true;
    try {
      const page = await listMetricsPage(q, f, sc, dn, fm, 0, PAGE_SIZE);
      if (gen !== listGen) return;
      metrics = (page && page.rows) || [];
      hasNext = !!(page && page.hasNext);
      listError = '';
      loading = false; // gen-guarded: only a CURRENT reply ends the wait
    } catch (e) {
      if (gen === listGen) {
        listError = errText(e);
        loading = false; // a failed first read shows the error, not a hang
      }
    }
  }

  // loadMore appends the NEXT window: the cursor is the last rendered
  // row's id (the store resolves it to its stored origin-rank/name key,
  // so windows never skip or duplicate a row). Duplicate ids are filtered
  // out anyway — a repeated keyed {#each} id would throw.
  async function loadMore() {
    if (loadingMore || !hasNext || !metrics.length) return;
    loadingMore = true;
    const gen = listGen;
    try {
      const last = metrics[metrics.length - 1];
      const page = await listMetricsPage(
        appliedQuery,
        appliedFilter,
        appliedScope,
        appliedDenom,
        appliedFormat,
        last.id,
        PAGE_SIZE,
      );
      if (gen !== listGen) return; // a refresh replaced the list meanwhile
      const seen = new Set(metrics.map((m) => m.id));
      const add = ((page && page.rows) || []).filter((m) => !seen.has(m.id));
      metrics = [...metrics, ...add];
      hasNext = !!(page && page.hasNext);
      listError = '';
    } catch (e) {
      if (gen === listGen) listError = errText(e);
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    const expr = form.expr;
    const seq = ++exprSeq;
    if (!expr.trim()) {
      exprCheck = { state: 'idle' };
      return;
    }
    exprCheck = { state: 'pending' };
    const t = setTimeout(() => {
      validateExpr(expr)
        .then(([ok, e]) => {
          if (seq !== exprSeq) return;
          exprCheck = ok
            ? { state: 'valid' }
            : { state: 'error', msg: e.message || 'invalid', pos: Number(e.pos) || 0 };
        })
        .catch((err) => {
          if (seq !== exprSeq) return;
          exprCheck = { state: 'error', msg: errText(err), pos: -1 };
        });
    }, 400);
    return () => clearTimeout(t);
  });

  // editMetric loads ANY stored definition into the form — a BUILT-IN
  // included (owner wave: the user reads how a built-in is written in
  // the editor), presented read-only: Save stays disabled for it
  // (saveDisabled above) and the read-only chip names the reason.
  // Plugin rows load the same way with their own chip and fork-on-save.
  function editMetric(m) {
    form = {
      id: m.id,
      name: m.name,
      title: m.title || '',
      shortName: m.shortName || '',
      expr: m.expr,
      scope: m.scope || 'match',
      format: m.format || '',
      denominator: m.denominator || '',
      doc: m.doc || '',
      origin: m.origin,
      pluginId: m.pluginId || '',
    };
    baseline = snapshot(form);
    saveError = '';
  }

  function newMetric() {
    form = newForm();
    baseline = snapshot(form);
    saveError = '';
  }

  // Id-based (not row-based): the edit card's Pin acts on form.id, which
  // may sit beyond the windows fetched so far — a paged list must not
  // make the toggle silently no-op. Scope-routed (design §3): an
  // already-pinned id toggles OFF wherever it lives; an unpinned one
  // lands in the key its SCOPE owns — a list row passes its saved
  // scope, the editor resolves the SAVED scope through getMetric (so a
  // dirty scope select can never mis-file the pin), and a metric is
  // always moved OUT of the other key (one mechanism, one home).
  async function togglePin(id, scope) {
    let s = pinnedIn(id) || scope;
    if (!s) {
      try {
        s = (await getMetric(id)).scope || 'match';
      } catch {
        s = 'match';
      }
    }
    // An absent key resolves its defaults through the catalog — wait
    // for the mount read so a first toggle can never drop them.
    await catalogP;
    const key = s === 'profile' ? PROFILE_PINS_KEY : PINS_KEY;
    const otherKey = key === PROFILE_PINS_KEY ? PINS_KEY : PROFILE_PINS_KEY;
    const otherScope = s === 'profile' ? 'match' : 'profile';
    const cur = effectivePins(key, s);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    // The OTHER scope's effective selection minus this id — writing it
    // materializes that key too (same rule as the order's first move:
    // the write carries the selection the other surface already shows).
    const other = effectivePins(otherKey, otherScope).filter((x) => x !== id);
    writePins(key, next);
    writePins(otherKey, other);
    if (key === PROFILE_PINS_KEY) {
      profilePins = next;
      pins = other;
    } else {
      pins = next;
      profilePins = other;
    }
  }

  async function removeMetric(m) {
    saveError = '';
    try {
      await deleteMetric(m.id);
      if (pins.includes(m.id) || profilePins.includes(m.id)) {
        // Both keys: the id must leave EVERY array (a scope-routed pin
        // lives in exactly one, but a stale array must not keep a
        // ghost either).
        pins = pins.filter((x) => x !== m.id);
        profilePins = profilePins.filter((x) => x !== m.id);
        writePins(PINS_KEY, pins);
        writePins(PROFILE_PINS_KEY, profilePins);
      }
      if (form.id === m.id) newMetric();
      if (previewKey && previewKey.id === m.id) {
        preview = null;
        previewKey = null;
      }
      await refreshList(appliedQuery, appliedFilter, appliedScope, appliedDenom);
    } catch (e) {
      saveError = errText(e);
    }
  }

  async function save() {
    saveError = '';
    const name = form.name.trim();
    if (!name) {
      saveError = 'Name is required.';
      return;
    }
    if (!form.expr.trim()) {
      saveError = 'Expression is required.';
      return;
    }
    if (!form.doc.trim()) {
      saveError = 'Doc is required for user metrics — document the formula.';
      return;
    }
    if (exprCheck.state === 'error') {
      saveError = `Fix the expression error first: ${exprCheck.msg}`;
      return;
    }
    saving = true;
    try {
      // A PLUGIN row is immutable through SaveMetric (the service and
      // store reject updates on it) — saving one forks a user copy
      // (id 0). A loaded BUILT-IN keeps its id, so a save that somehow
      // reached here would hit SaveMetric's built-in guard instead of
      // forking a copy of it — and in the UI the button never gets
      // there (saveDisabled), the guard being the backstop behind it.
      const payload = {
        id: form.origin === 'plugin' ? 0 : form.id,
        name,
        title: form.title.trim() || name,
        shortName: form.shortName.trim(),
        expr: form.expr,
        scope: form.scope,
        format: form.format,
        doc: form.doc.trim(),
        denominator: form.denominator,
        origin: 'user',
        pluginId: '',
      };
      const saved = await saveMetric(payload);
      form.id = saved.id;
      form.origin = saved.origin;
      form.name = saved.name;
      form.title = saved.title;
      form.shortName = saved.shortName;
      baseline = snapshot(form);
      await refreshList(appliedQuery, appliedFilter, appliedScope, appliedDenom);
    } catch (e) {
      saveError = errText(e);
    } finally {
      saving = false;
    }
  }

  // runPreview() previews the FORM (the panel's Preview button);
  // runPreview(row) previews that STORED definition straight off its id
  // — the row play's path for a BUILT-IN, which preview leaves out of
  // the form entirely (preview is not edit).
  //
  // DESIGN §5 PREVIEW CRITERION (THE saved-form criterion): a metric
  // VALUE is read from stored rows iff it is addressed by a SAVED
  // definition whose form is unmodified — `adhoc = dirty || id === 0`
  // is exactly that predicate. A clean-saved preview reads the
  // canonical stored rows (profile → every player's career rows; match
  // → the NEWEST READY MATCH's per-player rows, the match named in the
  // panel) and shows the no-execution Compile as provenance beside a
  // plain state indicator — no `ms`, because it timed nothing. A dirty
  // or unsaved draft is authoring state with NO rows: it stays an
  // on-demand calculation through PreviewMetric (timing included — it
  // genuinely computed), enforcing player-relativity like any invalid
  // expression.
  async function runPreview(target) {
    previewError = '';
    const id = target ? target.id : form.id;
    const expr = target ? '' : form.expr;
    if (!target && !expr.trim()) {
      preview = null;
      previewKey = null;
      previewError = 'Enter an expression to preview.';
      return;
    }
    const adhoc = !target && (dirty || form.id === 0);
    await doPreview({
      id,
      expr: adhoc ? expr : '',
      adhoc,
      scope: target ? target.scope || 'match' : form.scope,
      format: target ? target.format || '' : form.format,
    });
  }

  // doPreview runs one preview leg (shared by the button, the row play
  // and the metric-done reload below).
  async function doPreview(spec) {
    previewBusy = true;
    previewAdhoc = spec.adhoc;
    try {
      if (spec.adhoc) {
        const pv = await previewMetric(spec.id, spec.expr, '', PREVIEW_LIMIT);
        preview = {
          rows: (pv && pv.rows) || [],
          format: spec.format,
          sql: (pv && pv.sql) || '',
          ms: pv ? pv.ms : 0,
          truncated: pv ? !!pv.truncated : false,
        };
        previewKey = null;
      } else {
        preview = await storedPreview(spec.id, spec.scope, spec.format);
        previewKey = { id: spec.id, scope: spec.scope };
      }
    } catch (e) {
      preview = null;
      previewKey = null;
      previewError = errText(e);
    } finally {
      previewBusy = false;
    }
  }

  // reloadPreview re-reads a clean-saved preview after spectra:metric-
  // done replaced its rows (the read cache already flushed through
  // services' listener). Ad-hoc previews are never reloaded — they
  // calculated once, on demand.
  function reloadPreview() {
    if (!previewKey || previewBusy || !preview) return;
    void doPreview({
      id: previewKey.id,
      expr: '',
      adhoc: false,
      scope: previewKey.scope,
      format: preview.format,
    });
  }

  // storedPreview is the SAVED-form read: rows from the canonical read
  // (never calculated) plus the no-execution Compile of the SAME
  // addressing for the provenance block.
  async function storedPreview(id, scope, format) {
    if (scope === 'profile') {
      const [values, names, sql] = await Promise.all([
        getMetricValuesForPlayer('', [id]),
        playerNameMap(),
        compileMetric(id, '', ''),
      ]);
      return { rows: toPreviewRows(values, names), format, sql, scope };
    }
    const match = await newestReadyMatch();
    const sql = await compileMetric(id, '', match ? `match:${match.id}` : '');
    if (!match) return { rows: [], format, sql, scope, match: null };
    const [values, names] = await Promise.all([
      getMetricValuesForMatch(match.id, [id]),
      playerNameMap(),
    ]);
    return { rows: toPreviewRows(values, names), format, sql, scope, match };
  }

  // toPreviewRows shapes stored rows exactly like a preview's (group =
  // the subject SteamID, label = the player's name) so the SAME table
  // renders both — names come from the library-wide player list (one
  // cached read, shared with the palette/profile finder).
  function toPreviewRows(values, names) {
    return (values || []).map((v) => ({
      group: v.steamId,
      label: names.get(v.steamId) || v.steamId,
      value: v.value,
      n: v.n,
    }));
  }

  async function playerNameMap() {
    const rows = await listPlayers('');
    const m = new Map();
    for (const r of rows || []) if (r.steamId) m.set(r.steamId, r.name || '');
    return m;
  }

  // newestReadyMatch resolves the match-scope saved preview's unit —
  // the NEWEST READY match (design §5), from the same list and
  // ordering Reports' target defaults to (listMatches extracted_at
  // DESC, first ready row), so the two views never disagree about
  // "newest". null = no ready match yet (the panel says so).
  async function newestReadyMatch() {
    const rows = await listMatches('', 'extracted_at', true);
    return (rows || []).find((r) => r.status === 'ready' || r.status === '') || null;
  }

  // The row play control: preview THIS row. Non-builtin rows load into
  // the form first (existing behaviour — the panel then reads that
  // definition); a built-in previews off its STORED id and leaves the
  // form exactly as it was (preview is not edit), so a builtin still
  // previews while the form stays untouched.
  function previewRow(m) {
    if (m.origin === 'builtin') {
      runPreview(m);
      return;
    }
    editMetric(m);
    runPreview();
  }
</script>

{#snippet rowMain(m)}
  <span class="bld-row-title">
    {m.title || m.name}
    {#if m.doc}
      <span class="m5-ib" title={m.doc}><span class="codicon codicon-info"></span></span>
    {/if}
  </span>
  <span class="bld-row-sub">
    <span class="mono">{m.name}</span>
    <span class="chip">{m.scope || 'match'}</span>
    <!-- The denominator chip (owner wave): the SAME plain .chip the
         scope chip renders — no new concept class — and only when the
         metric carries a denominator at all (absence is honest: a count
         or plain sum has none). -->
    {#if m.denominator}
      <span class="chip">{m.denominator}</span>
    {/if}
    <span class="chip">{m.format || 'raw'}</span>
    <!-- The compute-state surface (design §4/§5): EVERY list item wears
         its state chip through StatusChip — processing quantifies with
         the live k/N feed, failed carries the engine error as its
         tooltip. Absent until the state read lands (a chip is never
         guessed). -->
    {#if stateOf(m.id)}
      <StatusChip
        status={stateOf(m.id)}
        title={metricStateTitle(stateOf(m.id), stateErrorOf(m.id))}
        progress={metricProgressFrac(metricProgress, m.id)}
        stage={metricProgressStage(metricProgress, m.id)}
      />
    {/if}
    {#if m.origin === 'plugin'}
      <span class="chip bld-plugin">{S.builder.originPlugin}</span>
      {#if disabledPlugins.has(m.pluginId)}
        <span class="chip bld-disabled">{S.builder.pluginDisabled}</span>
      {/if}
    {/if}
  </span>
{/snippet}

{#snippet metricRow(m)}
  <div class="bld-row" class:active={form.id === m.id}>
    <!-- Every stored row loads into the editor: a user row edits, a
         plugin row forks, a BUILT-IN loads read-only (Save disabled —
         owner wave, so the user can read how it is written). Pin and
         preview stay live on every row; delete stays user-only. -->
    <button class="bld-row-main" onclick={() => editMetric(m)}>{@render rowMain(m)}</button>
    <span class="bld-row-acts">
      <button
        class="btn small ghost"
        title={S.builder.previewThisMetric}
        aria-label={S.fill(S.builder.previewAria, { name: m.name })}
        onclick={() => previewRow(m)}><span class="codicon codicon-play"></span></button
      >
      <button
        class="btn small ghost"
        class:bld-pin-on={pinnedIn(m.id) !== ''}
        title={pinTitle(m)}
        aria-label={S.fill(S.builder.togglePinAria, { name: m.name })}
        onclick={() => togglePin(m.id, m.scope)}><span class="codicon codicon-pin"></span></button
      >
      <!-- Delete is the user-row control: built-ins are guarded
           server-side (SaveMetric/DeleteMetric) and plugins are the
           loader's territory, so neither ever shows one. -->
      {#if m.origin === 'user'}
        <button
          class="btn small ghost"
          title={S.builder.deleteMetric}
          aria-label={S.fill(S.builder.deleteAria, { name: m.name })}
          onclick={() => removeMetric(m)}><span class="codicon codicon-close"></span></button
        >
      {/if}
    </span>
  </div>
{/snippet}

<div class="view bld-view">
  <header class="view-header">
    <div>
      <h1>{S.builder.heading}</h1>
      <p class="muted bld-head-note">
        {S.builder.headNotePinned}<span class="codicon codicon-pin"></span>{S.builder.headNoteScopes}
      </p>
    </div>
    <!-- Metric-language help: opens the docs popup AT the
         metric-language section (openDocs prop — no navigation, the
         Builder stays mounted behind the sheet). The global .spacer
         inside .view-header right-aligns it (Library's header does the
         same). Not a route: no hash change, no active treatment. -->
    <div class="spacer"></div>
    <button
      class="btn"
      type="button"
      title={S.builder.metricLanguageHelp}
      aria-label={S.builder.metricLanguageHelp}
      onclick={() => openDocs('metric-language')}
    >
      <span class="codicon codicon-question" aria-hidden="true"></span>
    </button>
  </header>

  {#if listError}
    <p class="error" role="alert">
      {listError}
      <button class="btn small" onclick={loadLists}>{S.builder.retry}</button>
    </p>
  {/if}
  {#if saveError}
    <p class="error" role="alert">{saveError}</p>
  {/if}

  <div class="bld-grid">
    <section class="panel bld-list">
      <div class="row-between">
        <h2>{S.builder.metricsHeading}</h2>
        <div class="toolbar">
          <!-- The order is a property of the metric SET across both
               surfaces (not of one metric's editor), so it sits beside
               the other set-level action; the arrow pair is the repo's
               move vocabulary (MatchPicker / PlayerPicker /
               CommandPalette). -->
          <button
            class="btn small"
            onclick={openOrder}
            title={S.builder.orderDialogTitle}
            ><span class="codicon codicon-arrow-up"></span><span
              class="codicon codicon-arrow-down"></span
            > {S.builder.orderLabel}</button
          >
          <button class="btn small" onclick={newMetric}
            ><span class="codicon codicon-add"></span> {S.builder.newLabel}</button
          >
        </div>
      </div>
      <!-- Server-side search: the debounced query reaches the store
           (LIKE over name/title) and restarts the window at cursor 0. -->
      <input
        class="input"
        type="search"
        aria-label={S.builder.searchAria}
        placeholder={S.builder.searchPlaceholder}
        bind:value={query}
      />
      <!-- ONE multi-select for every list filter (owner ruling:
           "probably just a multi-select is good enough") — it replaces
           the three toggle-button lines: a trigger opens ONE checkbox
           panel with four labelled groups (Origin / Scope /
           Denominator / Type) over the SAME twelve viewstate booleans
           and the SAME debounced list read below. The FilterBar vein —
           the control commits, the parent owns the filter state, the
           debounced refetch follows — without reusing FilterBar itself
           (that is the landmark feed's conditional-fields panel).
           Dismissal is the canonical Popover's (Escape / outside
           pointerdown); focus returns to the trigger on Escape only. -->
      <div class="toolbar">
        <span class="bld-filter-host" bind:this={filterAnchor}>
          <button
            class="btn small"
            class:primary={filterOpen}
            bind:this={filterTrigger}
            aria-haspopup="true"
            aria-expanded={filterOpen}
            aria-controls={filterOpen ? 'bld-filter-pop' : null}
            title={S.builder.filtersTitle}
            onclick={() => (filterOpen = !filterOpen)}
            ><span class="codicon codicon-filter" aria-hidden="true"></span> {S.builder.filtersLabel}
            <span class="codicon codicon-chevron-down" aria-hidden="true"></span></button
          >
          <Popover
            open={filterOpen}
            anchor={filterAnchor}
            onClose={closeFilters}
            onOutside={closeFiltersOutside}
          >
            <div
              class="bld-filter-pop"
              id="bld-filter-pop"
              role="group"
              aria-label={S.builder.metricFiltersAria}
            >
              <div class="bld-filter-group" role="group" aria-label={S.builder.originLabel}>
                <span class="filt-lab">{S.builder.originLabel}</span>
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={builtin}
                    onchange={(e) => (builtin = e.currentTarget.checked)}
                  /> {S.builder.filterBuiltIn}</label
                >
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={mine}
                    onchange={(e) => (mine = e.currentTarget.checked)}
                  /> {S.builder.filterMyMetrics}</label
                >
              </div>
              <div class="bld-filter-group" role="group" aria-label={S.builder.scopeLabel}>
                <span class="filt-lab">{S.builder.scopeLabel}</span>
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={scopeMatch}
                    onchange={(e) => (scopeMatch = e.currentTarget.checked)}
                  /> {S.builder.filterMatch}</label
                >
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={scopeProfile}
                    onchange={(e) => (scopeProfile = e.currentTarget.checked)}
                  /> {S.builder.filterProfile}</label
                >
              </div>
              <div class="bld-filter-group" role="group" aria-label={S.builder.denominatorLabel}>
                <span class="filt-lab">{S.builder.denominatorLabel}</span>
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={denomRounds}
                    onchange={(e) => (denomRounds = e.currentTarget.checked)}
                  /> {S.builder.filterRounds}</label
                >
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={denomMatches}
                    onchange={(e) => (denomMatches = e.currentTarget.checked)}
                  /> {S.builder.filterMatches}</label>
              </div>
              <!-- Type = the metric's format (the editor's Format
                   select vocabulary, lib/metricformats.js): every
                   option its own checkbox, ALL six checked by default
                   (the owner's ruling) — only Built-in starts off — so
                   the first render carries format '' (no predicate). -->
              <div class="bld-filter-group" role="group" aria-label={S.builder.typeLabel}>
                <span class="filt-lab">{S.builder.typeLabel}</span>
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={formatAuto}
                    onchange={(e) => (formatAuto = e.currentTarget.checked)}
                  /> {S.builder.filterAuto}</label
                >
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={formatInt}
                    onchange={(e) => (formatInt = e.currentTarget.checked)}
                  /> {S.builder.filterInt}</label
                >
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={formatFloat1}
                    onchange={(e) => (formatFloat1 = e.currentTarget.checked)}
                  /> {S.builder.filterFloat1}</label
                >
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={formatFloat2}
                    onchange={(e) => (formatFloat2 = e.currentTarget.checked)}
                  /> {S.builder.filterFloat2}</label
                >
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={formatPercent}
                    onchange={(e) => (formatPercent = e.currentTarget.checked)}
                  /> {S.builder.filterPercent}</label
                >
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={formatCurrency}
                    onchange={(e) => (formatCurrency = e.currentTarget.checked)}
                  /> {S.builder.filterCurrency}</label>
              </div>
            </div>
          </Popover>
        </span>
      </div>
      {#if metrics.length === 0 && !listError}
        {#if loading}
          <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
        {:else if appliedQuery}
          <p class="muted" role="status">{S.fill(S.builder.noMetricsMatch, { q: appliedQuery })}</p>
        {:else}
          <!-- Query-less empty: a filter group narrowed the window to
               nothing (an empty My-metrics side, both origin options
               off, Match+Profile off, every Type box off) — legal, and
               said so here instead of leaving a blank panel. -->
          <p class="muted" role="status">{S.builder.noMetricsToShow}</p>
        {/if}
      {:else}
        <!-- One header per contiguous origin run (runs above): a window
             boundary inside a group never repeats the header. -->
        {#each runs as run (run.origin + ':' + run.rows[0].id)}
          <div class="bld-group">
            <h3>{GROUP_LABEL[run.origin] || run.origin}</h3>
            {#each run.rows as m (m.id)}
              {@render metricRow(m)}
            {/each}
          </div>
        {/each}
        {#if hasNext}
          <div class="row-between">
            <span class="muted" role="status">{S.fill(S.builder.showingMetrics, { n: metrics.length })}</span>
            <button class="btn" disabled={loadingMore} onclick={loadMore}>
              {loadingMore ? S.builder.loadingMore : S.builder.loadMore}
            </button>
          </div>
        {/if}
      {/if}
    </section>

    <div class="bld-right">
      <section class="panel">
        <div class="row-between">
          <h2>{form.id ? S.builder.editMetric : S.builder.newMetric}</h2>
          {#if builtinLoaded}
            <!-- A built-in loads read-only (owner wave): the chip names
                 it in the user's words, mirroring the plugin chip. -->
            <span class="chip bld-readonly" title={S.builder.builtinReadOnly}
              >{S.builder.builtinChip}</span>
          {:else if readOnly}
            <!-- Plugin rows: immutable through Save — saving stores a
                 copy of this definition as your own metric. -->
            <span class="chip bld-readonly" title={S.builder.pluginImmutable}
              >{S.builder.pluginReadOnlyChip}</span>
          {/if}
        </div>

        <!-- The editor card's compute state (design §4): processing is
             the BLOCK form — centered indicator with the honest k/N
             underneath (PRODUCT.md "Progress presentation": outside a
             table cell) — every other state is the compact chip. Never
             both: one progress widget. -->
        {#if form.id > 0 && stateOf(form.id)}
          {#if stateOf(form.id) === 'processing'}
            <div class="bld-card-prog">
              <StatusChip
                block
                progress={metricProgressFrac(metricProgress, form.id)}
                detail={computeDetail(form.id)}
              />
            </div>
          {:else}
            <StatusChip
              status={stateOf(form.id)}
              title={metricStateTitle(stateOf(form.id), stateErrorOf(form.id))}
            />
          {/if}
        {/if}

        <!-- Two fixed rows (owner wave): row 1 = Name / Title / Short
             name, row 2 = Scope / Denominator / Format — the grid below
             is a fixed three columns, so the DOM order IS the row order
             (Denominator therefore precedes Format). Doc and Expression
             keep their full-width rows underneath. -->
        <div class="bld-fields">
          <!-- readonly, never disabled, on the text fields (owner wave):
               a built-in's contents stay selectable and copyable while
               backspace/delete/caret editing are blocked — WebKit greys
               a disabled input out and forbids selection, which is
               exactly what the owner ruled out. The selects take
               disabled instead: a dropdown is not a copy surface. -->
          <div class="bld-field">
            <label class="field-label" for="bld-name">{S.builder.fieldName}</label>
            <input
              id="bld-name"
              class="input mono"
              bind:value={form.name}
              placeholder={S.builder.namePlaceholder}
              readonly={builtinLoaded}
            />
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-title">{S.builder.fieldTitle}</label>
            <input
              id="bld-title"
              class="input"
              bind:value={form.title}
              placeholder={S.builder.titlePlaceholder}
              readonly={builtinLoaded}
            />
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-short">{S.builder.fieldShortName}</label>
            <input
              id="bld-short"
              class="input"
              bind:value={form.shortName}
              placeholder={S.builder.shortNamePlaceholder}
              readonly={builtinLoaded}
            />
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-scope">{S.builder.scopeLabel}</label>
            <select id="bld-scope" class="input" bind:value={form.scope} disabled={builtinLoaded}>
              <option value="match">{S.builder.scopeMatchOption}</option>
              <option value="profile">{S.builder.scopeProfileOption}</option>
            </select>
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-denom">{S.builder.denominatorLabel}</label>
            <select id="bld-denom" class="input" bind:value={form.denominator} disabled={builtinLoaded}>
              <option value="">{S.builder.denomNone}</option>
              <option value="rounds">{S.builder.denomRounds}</option>
              <option value="matches">{S.builder.denomMatches}</option>
            </select>
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-format">{S.builder.fieldFormat}</label>
            <!-- The vocabulary renders from THE canonical list
                 (lib/metricformats.js — same order and tokens as the
                 Type filter's options; auto's value is the '' format). -->
            <select id="bld-format" class="input" bind:value={form.format} disabled={builtinLoaded}>
              {#each METRIC_FORMATS as f (f.token)}
                <option value={f.value}>{f.token}</option>
              {/each}
            </select>
          </div>
          <div class="bld-field wide">
            <label class="field-label" for="bld-doc">{S.builder.fieldDoc}</label>
            <textarea
              id="bld-doc"
              class="input"
              rows="3"
              bind:value={form.doc}
              placeholder={S.builder.docPlaceholder}
              readonly={builtinLoaded}
            ></textarea>
          </div>
          <div class="bld-field wide">
            <label class="field-label" for="bld-expr">{S.builder.fieldExpression}</label>
            <textarea
              id="bld-expr"
              class="input mono bld-expr"
              rows="4"
              spellcheck="false"
              bind:value={form.expr}
              placeholder={EXAMPLE}
              readonly={builtinLoaded}
            ></textarea>
            <p class="bld-hint mono">from &lt;table&gt;[, &lt;table&gt;…]: count() | sum(col) | avg(col) | ratio(a, b) | stddev(col) | percentile(p, col) — a comma list LEFT JOINs the sources (no ON/join syntax); denominator: rounds | matches</p>
            {#if exprCheck.state === 'pending'}
              <p class="bld-expr-state muted">{S.builder.exprChecking}</p>
            {:else if exprCheck.state === 'valid'}
              <p class="bld-expr-state ok"><span class="codicon codicon-check"></span> {S.builder.exprValid}</p>
            {:else if exprCheck.state === 'error'}
              <p class="bld-expr-state bad">
                <span class="codicon codicon-error"></span> {exprCheck.msg}{exprCheck.pos >= 0 ? ` · byte ${exprCheck.pos}` : ''}
              </p>
            {/if}
          </div>
        </div>

        <div class="toolbar bld-actions">
          <button
            class="btn primary"
            onclick={save}
            disabled={saveDisabled}
            title={builtinLoaded ? S.builder.builtinReadOnly : undefined}
          >
            {saving
              ? S.builder.saving
              : !builtinLoaded && form.id && !dirty
                ? S.builder.saved
                : S.builder.saveMetric}
          </button>
          <button
            class="btn"
            class:bld-pin-on={form.id > 0 && pinnedIn(form.id) !== ''}
            disabled={form.id === 0}
            onclick={() => togglePin(form.id)}
          >
            <span class="codicon codicon-pin"></span>
            {form.id > 0 && pinnedIn(form.id) !== '' ? S.builder.pinned : S.builder.pin}
          </button>
          <span class="muted bld-note">
            <!-- The disabled Save's reason, in the user's words (the
                 button carries the same string as its tooltip). -->
            {builtinLoaded
              ? S.builder.builtinReadOnly
              : S.builder.saveNoteDefault}
          </span>
        </div>
      </section>

      <section class="panel bld-preview">
        <div class="row-between">
          <h2>{S.builder.previewHeading}</h2>
          <div class="toolbar">
            <button class="btn primary" onclick={() => runPreview()} disabled={previewBusy}>
              {previewBusy ? S.builder.running : S.builder.preview}
            </button>
            <!-- Timing is provenance ONLY for an ad-hoc run (it genuinely
                 computed — design §5). A clean-saved preview shows the
                 STATE instead: it read stored rows and timed nothing. -->
            {#if preview && previewAdhoc && preview.ms != null}
              <span class="chip">{preview.ms} ms</span>
            {/if}
            {#if preview && preview.truncated}
              <span class="chip">{S.builder.previewTruncated}</span>
            {/if}
            {#if preview && !previewAdhoc && previewKey}
              <StatusChip
                status={stateOf(previewKey.id)}
                title={metricStateTitle(stateOf(previewKey.id), stateErrorOf(previewKey.id))}
                progress={metricProgressFrac(metricProgress, previewKey.id)}
                stage={metricProgressStage(metricProgress, previewKey.id)}
              />
            {/if}
          </div>
        </div>

        {#if previewError}
          <p class="error" role="alert">{previewError}</p>
        {:else if preview}
          {#if previewAdhoc && form.denominator}
            <p class="muted bld-note">
              {S.fill(S.builder.adhocNote, { denominator: form.denominator })}
            </p>
          {/if}
          {#if !previewAdhoc}
            <!-- Which unit the stored rows came from (design §5: the
                 match is stated in the panel; profile reads every
                 player's career rows). -->
            <p class="muted bld-note">
              {S.builder.storedValuesLabel}
              {#if preview.scope === 'profile'}
                {S.builder.storedProfileScope}
              {:else if preview.match}
                {S.builder.storedMatchScope}{preview.match.id}{preview.match.map
                  ? ` (${preview.match.map})`
                  : ''}
              {:else}
                {S.builder.storedNoMatch}
              {/if}
            </p>
          {/if}
          {#if preview.rows.length === 0}
            <p class="muted" role="status">
              {previewAdhoc ? S.builder.noGroups : S.builder.noStoredValues}
            </p>
          {:else}
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <SortTh
                      label={S.builder.colGroup}
                      active={previewSortKey === 'group'}
                      desc={previewSortDesc}
                      onclick={() => togglePreviewSort('group')}
                    />
                    <SortTh
                      label={S.builder.colLabel}
                      active={previewSortKey === 'label'}
                      desc={previewSortDesc}
                      onclick={() => togglePreviewSort('label')}
                    />
                    <SortTh
                      label={S.builder.colValue}
                      cls="num"
                      active={previewSortKey === 'value'}
                      desc={previewSortDesc}
                      onclick={() => togglePreviewSort('value')}
                    />
                    <SortTh
                      label="N"
                      cls="num"
                      title={S.builder.sampleSizeTitle}
                      active={previewSortKey === 'n'}
                      desc={previewSortDesc}
                      onclick={() => togglePreviewSort('n')}
                    />
                  </tr>
                </thead>
                <tbody>
                  {#each sortedPreviewRows as r, i (i)}
                    <tr
                      class:bld-missing={r.n === 0}
                      class:bld-egroup={!r.group}
                      title={r.n === 0 ? S.builder.noDataBehind : ''}
                    >
                      <td class="mono">{r.group || '—'}</td>
                      <td>
                        <!-- A player grouping carries the Steam id in r.group
                             (ProfileLink's own isSteam guard makes that a
                             link); every other grouping — side, weapon, … —
                             stays plain text. -->
                        <ProfileLink steam={r.group} name={r.label || '—'} {nav} />
                      </td>
                      <td class="num">{fmtMetric(r.value, previewFormat)}</td>
                      <td class="num">{fmtInt(r.n)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          <!-- Provenance copy: the statement arrives with its bound
               values WRITTEN IN (metrics.Plan/Preview.DisplaySQL — display
               only, the run itself used binds), so a single-statement
               metric pastes and runs as-is. A metric whose formula mixes
               percentile with other aggregations appends its companion
               statement, whose values are not carried on the plan — those
               markers stay `?`, honestly, and two statements need running
               one at a time. -->
          <details class="bld-sql">
            <summary>{S.builder.compiledSql}</summary>
            <pre class="mono">{preview.sql}</pre>
          </details>
        {:else}
          <p class="muted" role="status">
            {S.builder.noPreviewYetLead} <span class="codicon codicon-play"></span> {S.builder.noPreviewYetTail}
          </p>
        {/if}
      </section>
    </div>
  </div>

  <!-- ONE dialog, two stacked sections (design §2.2); its open state
       is transient (openOrder above), pins ride as read-only props. -->
  <MetricOrderDialog
    open={orderOpen}
    pinnedMatch={pins}
    pinnedProfile={profilePins}
    onClose={() => (orderOpen = false)}
  />
</div>
