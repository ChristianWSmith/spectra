<script>
  import { fillHeight } from '../fillheight.js';
  import { createLoadState } from '../loadstate.svelte.js';
  import LoadBox from '../components/LoadBox.svelte';
  import * as S from '../strings/index.js';
  import {
    listMetricsPage,
    listMetrics,
    listMatches,
    listPlayers,
    getMetric,
    saveMetric,
    deleteMetric,
    saveBuiltinMetric,
    restoreBuiltinMetric,
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
  import {
    liveMetricState,
    metricStateTitle,
    metricProgressFrac,
    metricProgressStage,
  } from '../metricstate.js';
  import { fmtMetric } from '../fmt.js';
  import { METRIC_FORMATS, formatFilterWord } from '../metricformats.js';
  import { originFilterWord } from '../metricorigins.js';
  import ProfileLink from '../components/ProfileLink.svelte';
  import SortTh from '../components/SortTh.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import RunningMetricsDialog from '../components/RunningMetricsDialog.svelte';
  import Popover from '../components/Popover.svelte';
  import HelpButton from '../components/HelpButton.svelte';
  import SourceEditor from '../components/SourceEditor.svelte';
  import { sqlItems, METRIC_BINDS } from '../editor/sqlCompletions.js';
  import { metricTables, savedMetrics } from '../editor/completionSources.js';
  import { seed, remember } from '../viewstate.svelte.js';

  // The expression's completions: the metric-readable tables with their columns,
  // the reserved binds, the saved metrics a metric('…') reference may name, and the bot filter.
  async function builderCompletions() {
    const [tables, saved] = await Promise.all([metricTables(), savedMetrics()]);
    return sqlItems({ tables, binds: METRIC_BINDS, metrics: saved, botFilter: true });
  }

  let { nav = () => {}, openDocs = () => {} } = $props();

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
  // The list’s load: a new query or filter is busy (the list is held and dimmed under a spinner); a refresh
  // of the same query is not.
  const load = createLoadState();
  let loadingMore = $state(false);
  let disabledPlugins = $state(new Set());
  let listError = $state('');
  let runningOpen = $state(false);

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
  // A chip's title. The behind word here is the library-wide one (any match
  // behind), so its title says that rather than the per-metric copy.
  function chipTitleOf(id) {
    const state = stateOf(id);
    if (state === 'behind') return S.builder.behindAnyMatch;
    return metricStateTitle(state, stateErrorOf(id));
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
  // search text and the filter multi-select's FIFTEEN CHECKBOXES are
  // view-local state: they restore across navigation through the
  // process-scoped registry (viewstate.svelte.js — flat key; they
  // travel together so the unsaved-changes flag, the search and the
  // filter checks read exactly as they did on leave; the search is the
  // Profiles precedent). The panel's OPEN state is transient (above).
  // Saving, previews, errors and the window cursor stay transient / their
  // own store.
  const bldSeed = seed('builder', {
    form: newForm(),
    baseline: '',
    query: '',
    // Origin group: every box ON, so the first render is unfiltered (built-in,
    // yours and plugin metrics together). A box narrows SERVER-side when it goes
    // off (originFilter below), and all-off is legal.
    builtin: true,
    custom: true,
    plugin: true,
    // Type group: the owner's ruling ("all six checked — auto + int +
    // float1 + float2 + percent + currency") extended by the seventh
    // Identity box (metrics Phase 7, 2026-11-18 — the key-valued
    // metrics' filter treatment; seed() merges over defaults, so a
    // registry record written before it still starts checked). Every box
    // starts on: the first render is unfiltered.
    formatAuto: true,
    formatInt: true,
    formatFloat1: true,
    formatFloat2: true,
    formatPercent: true,
    formatCurrency: true,
    formatIdentity: true,
  });
  let form = $state(bldSeed.form);
  let baseline = $state(bldSeed.baseline);
  let query = $state(bldSeed.query);
  let builtin = $state(bldSeed.builtin);
  let custom = $state(bldSeed.custom);
  let plugin = $state(bldSeed.plugin);
  let formatAuto = $state(bldSeed.formatAuto);
  let formatInt = $state(bldSeed.formatInt);
  let formatFloat1 = $state(bldSeed.formatFloat1);
  let formatFloat2 = $state(bldSeed.formatFloat2);
  let formatPercent = $state(bldSeed.formatPercent);
  let formatCurrency = $state(bldSeed.formatCurrency);
  let formatIdentity = $state(bldSeed.formatIdentity);
  $effect(() =>
    remember('builder', {
      form,
      baseline,
      query,
      builtin,
      custom,
      plugin,
      formatAuto,
      formatInt,
      formatFloat1,
      formatFloat2,
      formatPercent,
      formatCurrency,
      formatIdentity,
    }),
  );
  let saveError = $state('');
  let saving = $state(false);

  // Live expression check: debounced 400 ms → validateExpr.
  // state: idle | pending | valid | error
  let exprCheck = $state({ state: 'idle' });
  let exprSeq = 0;
  // The error line's full text — ONE spelling for the visible message
  // AND for the slot's title tooltip (w19 23d: the validity slot
  // ellipsizes a long line inside the actions row instead of pushing
  // the right-side cluster onto a second line, so the whole message
  // stays reachable on hover).
  const exprErrorText = $derived(
    exprCheck.state === 'error'
      ? `${exprCheck.msg}${exprCheck.pos >= 0 ? ` · byte ${exprCheck.pos}` : ''}`
      : '',
  );

  let preview = $state(null); // {rows, format, sql, ms?, truncated?, match?, scope?}
  let previewAdhoc = $state(false);
  // previewKey identifies the SAVED definition a clean-saved preview
  // read ({id, scope}; null for an ad-hoc draft) — what a completed
  // sweep reloads and what decides the draft-vs-saved criterion.
  let previewKey = $state(null);
  let previewError = $state('');
  let previewBusy = $state(false);
  // Preview rows sort CLIENT-side (the bound is small — an ad-hoc run is
  // capped, a stored read is a roster or a career bucket), the same way
  // Profiles/Match keep their table sorts: transient view state, never in
  // the URL (a sort is not shareable) and never in the registry (this
  // view's own placement comment above keeps previews transient).
  //
  // Each header sorts its column. The NUMERIC column (value) compares
  // by VALUE — never the formatted text, so "5%" cannot sort before
  // "41.2%" as text — and it takes DESCENDING as its natural
  // direction, so the default order is value highest-first; text columns
  // start A→Z. Rows whose key is not a number sort
  // last either way (a gap is not a zero), and ties keep arrival order
  // (Array#sort is stable), so a fresh preview still renders what the
  // read returned.
  const PREVIEW_SORT_DEFAULT_DESC = { group: false, label: false, value: true };
  let previewSortKey = $state('value');
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
      if (key === 'value') {
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
      doc: '',
      origin: 'user',
      pluginId: '',
      edited: false,
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
      doc: f.doc,
    });
  }

  // The left list's group runs: the paged read is origin-contiguous
  // (store metricOrder — builtin → user → plugin, name ASC), so the
  // accumulated windows form one run per origin present. The markup
  // renders ONE header per run, so a window boundary inside a group
  // never repeats a header — the final look matches the unpaginated
  // grouped list. Runs derive from the accumulated rows.
  // The list's origin run headers (2026-11-18, metrics Phase 7): the
  // strings catalog is THE home for the labels (one spelling per
  // concept) — the user group's header reads "Custom", the same word
  // the Origin filter's box uses for exactly those rows (W45's ruling;
  // it replaced the inline "Yours").
  const GROUP_LABEL = {
    builtin: S.builder.groupBuiltins,
    user: S.builder.groupCustom,
    plugin: S.builder.groupPlugins,
  };

  const dirty = $derived(snapshot(form) !== baseline);
  // readOnly — a loaded definition the API never updates in place: a
  // PLUGIN row forks on save (payload id 0 → a new user copy), a
  // BUILT-IN row is not savable at all (saveDisabled below). Both wear
  // the form's read-only chip; neither ever shows a delete control.
  const readOnly = $derived(form.origin !== 'user');
  // A built-in edits in place (owner ruling 44): only its SQL is editable.
  // Save stays off until the SQL is dirty, and saving stores the SQL as the
  // built-in's override. Its name, title, format and addressing stay shipped.
  const builtinLoaded = $derived(form.origin === 'builtin');
  const saveDisabled = $derived(saving || (builtinLoaded && !dirty));

  // originFilter — THE one checked-set → server-word derivation (the
  // multi-select's Origin group): the group's boxes are exactly the
  // origin column's three values (Built-in / Custom / Plugin), so the
  // word is originFilterWord's canonical comma-subset of the checked
  // set — all three = '' (no predicate), none = 'none', otherwise the
  // subset ("builtin,plugin") — the ONE composer in lib/metricorigins.js
  // mirroring the store's metricOriginTokens, so the options can never
  // disagree with the store about what an origin means. It rides the
  // list read's args — see refreshList — so it restarts the window
  // exactly like a search change does (the effect below reads it) and
  // joins listMetricsPage's cache key for free (services.js).
  const originFilter = $derived(
    originFilterWord({ builtin, user: custom, plugin }),
  );

  const runs = $derived.by(() => {
    const out = [];
    for (const m of metrics) {
      const last = out[out.length - 1];
      if (last && last.origin === m.origin) last.rows.push(m);
      else out.push({ origin: m.origin, rows: [m] });
    }
    return out;
  });

  // formatFilter — the fourth group's (Type) checked-set → server word:
  // unlike the pair-shaped Origin group it is
  // seven checkboxes, so the derivation is the canonical one
  // in lib/metricformats.js (all seven = '' no
  // predicate, none = 'none', otherwise the canonical comma-subset —
  // "auto" being the format select's Auto, the '' format, "identity"
  // the key-valued metrics). Same
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
      identity: formatIdentity,
    }),
  );

  // The editor Format select's options: the SELECTABLE members of THE
  // canonical list, plus a filter-only token the loaded definition
  // already carries (identity on the M1 built-ins) so a read-only row
  // shows its own format instead of a mismatched one — a filter-only
  // format is never offered as a fresh choice (metricformats.js).
  const editorFormats = $derived(METRIC_FORMATS.filter((f) => !f.filterOnly || f.value === form.format));

  // The search text AND the four filters the current window sequence
  // serves: refreshList writes them, loadMore reads them (the cursor's
  // query + filters) and the empty-result copy below names the query —
  // $state because the template references them.
  let appliedQuery = $state('');
  let appliedFilter = $state('');
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

  // Mount (runs once — it reads no reactive value): the plugin states.
  $effect(() => {
    loadPluginStates();
  });

  // The list read (mount AND listError's Retry): the first run is
  // immediate (the list loads without the debounce delay), later runs
  // fire 250 ms after a query OR filter change (the Library's debounce)
  // so typing doesn't hammer the store — and ANY checkbox flip in the
  // multi-select's two groups (origin, type) are both
  // SERVER-side, so any checkbox flip lands on this SAME path, which
  // restarts the window at cursor 0 (a filter change never appends onto
  // the previous filter's windows).
  let firstList = true;
  $effect(() => {
    const q = query;
    const f = originFilter;
    const fm = formatFilter;
    if (firstList) {
      firstList = false;
      refreshList(q, f, fm);
      return;
    }
    const t = setTimeout(() => refreshList(q, f, fm), 250);
    return () => clearTimeout(t);
  });

  // Retry: the error slot's button — plugin states + a fresh first
  // window for the query/filters currently in play.
  async function loadLists() {
    loadPluginStates();
    await refreshList(query, originFilter, formatFilter);
  }

  // refreshList RESTARTS the window sequence: cursor 0, replace — a
  // search change, a filter change (any of the four SERVER-side
  // groups), a save/delete refresh or a Retry must never APPEND onto
  // the previous window's rows. listGen tags the sequence so a
  // Load-more reply landing after a restart is dropped instead of
  // appended (the Library's refreshList/loadMore shape). Every
  // narrowing here is SERVER-side (query LIKE + originFilter +
  // formatFilter — store.ListMetricsPage),
  // never a client-side slice of a window: every filter group is
  // server-side (metrics above).
  async function refreshList(q = '', f = '', fm = '') {
    appliedQuery = q;
    appliedFilter = f;
    appliedFormat = fm;
    const gen = ++listGen;
    try {
      await load.track(listMetricsPage(q, f, fm, 0, PAGE_SIZE), [q, JSON.stringify(f), fm].join('|'), (page) => {
        if (gen !== listGen) return;
        metrics = (page && page.rows) || [];
        hasNext = !!(page && page.hasNext);
        listError = '';
      });
    } catch (e) {
      if (gen === listGen) {
        listError = errText(e);
      }
    }
  }

  // loadMore appends the NEXT window: the cursor is the last FETCHED
  // row's id (metrics — the server's list, so the cursor keeps tiling the
  // store's order; the store resolves it to its stored origin-rank/name
  // key, so windows never skip or duplicate a row).
  // Duplicate ids are filtered out anyway — a repeated keyed {#each} id
  // would throw.
  async function loadMore() {
    if (loadingMore || !hasNext || !metrics.length) return;
    loadingMore = true;
    const gen = listGen;
    try {
      const last = metrics[metrics.length - 1];
      const page = await listMetricsPage(
        appliedQuery,
        appliedFilter,
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

  // The live check validates the statement alone: its scope is derived
  // from its binds, so there is no addressing to send.
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
      doc: m.doc || '',
      origin: m.origin,
      pluginId: m.pluginId || '',
      edited: !!m.edited,
    };
    baseline = snapshot(form);
    saveError = '';
  }

  function newMetric() {
    form = newForm();
    baseline = snapshot(form);
    saveError = '';
  }

  async function removeMetric(m) {
    saveError = '';
    try {
      await deleteMetric(m.id);
      if (form.id === m.id) newMetric();
      if (previewKey && previewKey.id === m.id) {
        preview = null;
        previewKey = null;
      }
      await refreshList(appliedQuery, appliedFilter, appliedFormat);
    } catch (e) {
      saveError = errText(e);
    }
  }

  // A built-in's Save stores its edited SQL as the override (owner ruling 44).
  // The save gate is the same live check the user save uses; the service
  // refuses anything else. Name, doc and addressing are not part of the edit.
  async function saveBuiltin() {
    saveError = '';
    if (exprCheck.state === 'error') {
      saveError = `Fix the expression error first: ${exprCheck.msg}`;
      return;
    }
    saving = true;
    try {
      const edit = await saveBuiltinMetric(form.id, form.expr);
      form.expr = edit.expr;
      form.edited = edit.edited;
      baseline = snapshot(form);
      await refreshList(appliedQuery, appliedFilter, appliedFormat);
    } catch (e) {
      saveError = errText(e);
    } finally {
      saving = false;
    }
  }

  // Restore to default (owner ruling 44): the override is deleted, the shipped
  // SQL is back in the form, and the metric recomputes with it.
  async function restoreBuiltin() {
    saveError = '';
    saving = true;
    try {
      const shipped = await restoreBuiltinMetric(form.id);
      editMetric(shipped);
      await refreshList(appliedQuery, appliedFilter, appliedFormat);
    } catch (e) {
      saveError = errText(e);
    } finally {
      saving = false;
    }
  }

  async function save() {
    saveError = '';
    if (builtinLoaded) return saveBuiltin();
    const name = form.name.trim();
    if (!name) {
      saveError = 'Name is required.';
      return;
    }
    if (!form.expr.trim()) {
      saveError = 'Expression is required.';
      return;
    }
    // The short-name cap (N3): six characters, counted as characters
    // (never UTF-16 units) — the same bound SaveMetric enforces
    // server-side, surfaced here before the round trip. The input's
    // maxlength keeps new typing inside the cap; this guard is what
    // reports an EXISTING over-limit value on save (plain reject — no
    // validate-only-on-change, no truncation).
    if ([...form.shortName.trim()].length > 6) {
      saveError = S.builder.shortNameTooLong;
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
        format: form.format,
        doc: form.doc.trim(),
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
      await refreshList(appliedQuery, appliedFilter, appliedFormat);
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
  // genuinely computed) under the draft's own statement.
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
        const pv = await previewMetric(spec.id, spec.expr, PREVIEW_LIMIT);
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
        compileMetric(id, ''),
      ]);
      return { rows: toPreviewRows(values, names), format, sql, scope };
    }
    const match = await newestReadyMatch();
    const sql = await compileMetric(id, '');
    if (!match) return { rows: [], format, sql, scope, match: null };
    const [values, names] = await Promise.all([
      getMetricValuesForMatch(match.id, [id]),
      playerNameMap(),
    ]);
    return { rows: toPreviewRows(values, names), format, sql, scope, match };
  }

  // toPreviewRows shapes stored rows exactly like a preview's (group =
  // the subject key, label = the player's name) so the SAME table
  // renders both — names come from the library-wide player list (one
  // cached read, shared with the palette/profile finder).
  function toPreviewRows(values, names) {
    return (values || []).map((v) => ({
      group: v.subjectKey,
      label: names.get(v.subjectKey) || v.subjectKey,
      value: v.value,
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
  <!-- Line 1 = the display title, the raw metric name, then the doc
       info icon; line 2 holds ONLY chips (w19 row restructure). The
       mono name's double-print guard follows the Order dialog's
       short !== label pattern: when the title IS the name (empty title
       falls back to it), the name already renders as the title, so the
       mono slot stays out. -->
  <span class="bld-row-title">
    {m.title || m.name}
    {#if m.title && m.title !== m.name}
      <span class="mono">{m.name}</span>
    {/if}
    {#if m.doc}
      <span class="m5-ib" title={m.doc}><span class="codicon codicon-info"></span></span>
    {/if}
  </span>
  <span class="bld-row-sub">
    <span class="chip">{m.format || 'raw'}</span>
    <!-- The compute-state surface (design §4/§5): EVERY list item wears
         its state chip through StatusChip — processing quantifies with
         the live k/N feed, failed carries the engine error as its
         tooltip. Absent until the state read lands (a chip is never
         guessed). -->
    {#if stateOf(m.id)}
      <StatusChip
        status={stateOf(m.id)}
        title={chipTitleOf(m.id)}
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
    <!-- An edited built-in wears the Edited chip in the list too (owner
         ruling 50): the service sets Edited only on a builtin whose
         override is in place, and the chip goes when it is restored. -->
    {#if m.edited}
      <span class="chip" title={S.builder.editedTitle}>{S.builder.editedChip}</span>
    {/if}
  </span>
{/snippet}

{#snippet metricRow(m)}
  <div class="bld-row" class:active={form.id === m.id}>
    <!-- Every stored row loads into the editor: a user row edits, a
         plugin row forks, a BUILT-IN loads read-only (Save disabled —
         owner wave, so the user can read how it is written). Preview
         stays live on every row; delete stays user-only. -->
    <button class="bld-row-main" onclick={() => editMetric(m)}>{@render rowMain(m)}</button>
    <span class="bld-row-acts">
      <button
        class="btn small ghost"
        title={S.builder.previewThisMetric}
        aria-label={S.fill(S.builder.previewAria, { name: m.name })}
        onclick={() => previewRow(m)}><span class="codicon codicon-play"></span></button
      >
      <!-- Delete is the user-row control: built-ins are guarded
           server-side (SaveMetric/DeleteMetric) and plugins are the
           loader's territory, so neither ever shows one. The trash
           glyph is the ONE app-wide destructive glyph (w19 23b — it
           used to be the ✕, which reads "dismiss"). -->
      {#if m.origin === 'user'}
        <button
          class="btn small ghost"
          title={S.builder.deleteMetric}
          aria-label={S.fill(S.builder.deleteAria, { name: m.name })}
          onclick={() => removeMetric(m)}><span class="codicon codicon-trash"></span></button
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
        {S.builder.headNoteScopes}
      </p>
    </div>
    <!-- Metric-language help: the shared header `?` (HelpButton.svelte
         — the ONE spelling of this idiom) opened AT the metric-language
         section (openDocs prop — no navigation, the Builder stays
         mounted behind the sheet). The global .spacer inside
         .view-header right-aligns it (every view header does the same).
         Not a route: no hash change, no active treatment. Builder is
         the one caller that names its target — the label says which
         section opens; the view headers share the common copy. -->
    <div class="spacer"></div>
    <HelpButton section="metric-language" {openDocs} label={S.builder.metricLanguageHelp} />
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
    <section class="panel bld-list" use:fillHeight>
      <div class="row-between">
        <h2>{S.builder.metricsHeading}</h2>
        <div class="toolbar">
          <button
            class="btn small"
            onclick={() => (runningOpen = true)}
            title={S.builder.runningTitle}
            ><span class="codicon codicon-pulse"></span> {S.builder.runningLabel}</button
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
           panel with two labelled groups (Origin / Type) over the SAME viewstate booleans and the SAME debounced
           list read below — all four SERVER-side. The FilterBar
           vein — the control commits, the parent owns the filter state,
           the debounced refetch follows — without reusing FilterBar
           itself (that is the landmark feed's conditional-fields
           panel). Dismissal is the canonical Popover's (Escape /
           outside pointerdown); focus returns to the trigger on Escape
           only. -->
      <div class="toolbar">
        <span class="bld-filter-host" bind:this={filterAnchor}>
          <button
            class="input multi-trigger"
            class:multi-open={filterOpen}
            bind:this={filterTrigger}
            aria-haspopup="true"
            aria-expanded={filterOpen}
            aria-controls={filterOpen ? 'bld-filter-pop' : null}
            title={S.builder.filtersTitle}
            onclick={() => (filterOpen = !filterOpen)}
            ><span class="codicon codicon-filter" aria-hidden="true"></span> {S.builder.filtersLabel}</button
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
                    checked={custom}
                    onchange={(e) => (custom = e.currentTarget.checked)}
                  /> {S.builder.filterCustom}</label
                >
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={plugin}
                    onchange={(e) => (plugin = e.currentTarget.checked)}
                  /> {S.builder.filterPlugin}</label
                >
              </div>
              <!-- Type = the metric's format (the canonical format
                   vocabulary, lib/metricformats.js): every
                   option its own checkbox, ALL seven checked by default
                   (the owner's six-box ruling extended by Identity,
                   metrics Phase 7 2026-11-18) — only Built-in starts off — so
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
                <label class="filt-check"
                  ><input
                    type="checkbox"
                    checked={formatIdentity}
                    onchange={(e) => (formatIdentity = e.currentTarget.checked)}
                  /> {S.builder.filterIdentity}</label>
              </div>
            </div>
          </Popover>
        </span>
      </div>
      <LoadBox tag="div" class="bld-list-body" busy={load.busy} key={load.key} name="view:builder">
      {#if metrics.length === 0 && !listError}
        {#if metrics.length === 0 && appliedQuery}
          <p class="muted" role="status">{S.fill(S.builder.noMetricsMatch, { q: appliedQuery })}</p>
        {:else}
          <!-- Empty: either a server-side filter group narrowed the
               window to nothing (an empty My-metrics side, both origin
               options off, Match+Profile off, every Type box off) or the
               filter hid every fetched row — legal, and said so here
               instead of leaving a blank panel. The gate is the FILTERED
               count (metrics), so a fully filtered list shows this copy
               instead of rendering blank. -->
          <p class="muted" role="status">{S.builder.noMetricsToShow}</p>
        {/if}
      {:else}
        <!-- The list BODY is the view's one scroll region (N1): the
             panel header, the search box and the Filters trigger stay
             put above it (the filter popover is anchored to that
             trigger, so it must never scroll away), while the rows and
             the Load-more footer ride the height-capped scroller
             (.bld-rows in style-m3a.css — the .sql-side calc idiom). -->
        <div class="bld-rows">
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
        </div>
      {/if}
      </LoadBox>
    </section>

    <div class="bld-right">
      <section class="panel">
        <div class="row-between">
          <h2>{form.id ? S.builder.editMetric : S.builder.newMetric}</h2>
          <!-- The header's right slot holds the compact state chip FIRST
               (w19 item 2), then the read-only chip — every state word
               but processing renders here, top-right, left of the
               built-in/plugin chip (processing keeps its BLOCK form
               below: PRODUCT.md "Progress presentation" — never both,
               one progress widget). -->
          <div class="toolbar">
            {#if form.id > 0 && stateOf(form.id) && stateOf(form.id) !== 'processing'}
              <StatusChip
                status={stateOf(form.id)}
                title={chipTitleOf(form.id)}
              />
            {/if}
            {#if builtinLoaded}
              <!-- A built-in edits in place (owner ruling 44): the chip names
                   it in the user's words, and an edit shows beside it. -->
              <span class="chip bld-readonly" title={S.builder.builtinEditNote}
                >{S.builder.builtinChip}</span>
              {#if form.edited}
                <span class="chip" title={S.builder.editedTitle}>{S.builder.editedChip}</span>
              {/if}
            {:else if readOnly}
              <!-- Plugin rows: immutable through Save — saving stores a
                   copy of this definition as your own metric. -->
              <span class="chip bld-readonly" title={S.builder.pluginImmutable}
                >{S.builder.pluginReadOnlyChip}</span>
            {/if}
          </div>
        </div>

        <!-- The editor card's compute state (design §4): processing is
             the BLOCK form — centered indicator with the honest k/N
             underneath (PRODUCT.md "Progress presentation": outside a
             table cell). Every OTHER state is the compact chip in the
             header above (w19 item 2) — never both: one progress
             widget. -->
        {#if form.id > 0 && stateOf(form.id) === 'processing'}
          <div class="bld-card-prog">
            <StatusChip
              block
              progress={metricProgressFrac(metricProgress, form.id)}
              detail={computeDetail(form.id)}
            />
          </div>
        {/if}

        <!-- One row of the four identity fields (Name, Title, Short name,
             Format — twelve columns in all, see style-m3a.css), then the
             full-width Doc line and Expression. The DOM order is the row order. -->
        <div class="bld-fields">
          <!-- readonly, never disabled, on the text fields (owner wave):
               a built-in's contents stay selectable and copyable while
               backspace/delete/caret editing are blocked — WebKit greys
               a disabled input out and forbids selection, which is
               exactly what the owner ruled out. The selects take
               disabled instead: a dropdown is not a copy surface. -->
          <div class="bld-field bld-name">
            <label class="field-label" for="bld-name">{S.builder.fieldName}</label>
            <input
              id="bld-name"
              class="input mono"
              bind:value={form.name}
              placeholder={S.builder.namePlaceholder}
              readonly={builtinLoaded}
            />
          </div>
          <div class="bld-field bld-title">
            <label class="field-label" for="bld-title">{S.builder.fieldTitle}</label>
            <input
              id="bld-title"
              class="input"
              bind:value={form.title}
              placeholder={S.builder.titlePlaceholder}
              readonly={builtinLoaded}
            />
          </div>
          <div class="bld-field bld-short">
            <label class="field-label" for="bld-short">{S.builder.fieldShortName}</label>
            <input
              id="bld-short"
              class="input"
              maxlength="6"
              bind:value={form.shortName}
              placeholder={S.builder.shortNamePlaceholder}
              readonly={builtinLoaded}
            />
          </div>
          <div class="bld-field bld-format">
            <label class="field-label" for="bld-format">{S.builder.fieldFormat}</label>
            <!-- The vocabulary renders from THE canonical list
                 (lib/metricformats.js — same order and tokens as the
                 Type filter's options; auto's value is the '' format)
                 minus its FILTER-ONLY members — except one the loaded
                 definition already carries, which renders so a read-only
                 identity built-in shows its own format (editorFormats). -->
            <select id="bld-format" class="input" bind:value={form.format} disabled={builtinLoaded}>
              {#each editorFormats as f (f.token)}
                <option value={f.value}>{f.token}</option>
              {/each}
            </select>
          </div>
          <div class="bld-field wide">
            <label class="field-label" for="bld-doc">{S.builder.fieldDoc}</label>
            <input
              id="bld-doc"
              class="input"
              bind:value={form.doc}
              placeholder={S.builder.docPlaceholder}
              readonly={builtinLoaded}
            />
          </div>
          <div class="bld-field wide">
            <label class="field-label" for="bld-expr">{S.builder.fieldExpression}</label>
            <SourceEditor
              id="bld-expr"
              cls="bld-expr"
              language="sql"
              rows={4}
              ariaLabel={S.builder.fieldExpression}
              placeholder={EXAMPLE}
              bind:value={form.expr}
              completions={builderCompletions}
            />
            <p class="bld-hint mono">One SELECT or WITH statement over the metric-readable tables; it returns subject_key, dim and value. :match_id, :steam_id and :round are the reserved binds.</p>
          </div>
        </div>

        <!-- ONE actions line (N6): the expression validity indicator and
             the hint + Save cluster share a single row — the left
             slot ALWAYS renders (empty while the check is idle) so the
             right cluster sits flush right in every state, and there is
             exactly ONE validity indicator (the block below moved here
             from under the Expression textarea — never a second one; the
             short-name length error stays up in saveError with the other
             save guards, so this slot is expression-only). The row's
             DESTRUCTIVE action leads it (w19 item 23): the editor delete
             sits at the line's left edge while the positive actions
             (hint, Save) stay right — USER metrics only, the list
             row's criterion (built-ins are guarded server-side, plugins
             are the loader's territory), and it routes through the SAME
             removeMetric path, so the delete-blocked-while-referenced
             error still surfaces through saveError unchanged. The
             validity slot is also the row's FLEXIBLE item (w19 23d —
             the .bld-valid rule): a long error ellipsizes inside it
             instead of pushing the cluster to a second line, with the
             full text on the message's title. -->
        <div class="row-between bld-actions">
          {#if builtinLoaded && form.edited}
            <button class="btn" onclick={restoreBuiltin} title={S.builder.restoreTitle}
              >{S.builder.restoreDefault}</button
            >
          {/if}
          {#if form.id > 0 && form.origin === 'user'}
            <button
              class="btn danger"
              title={S.builder.deleteMetric}
              aria-label={S.fill(S.builder.deleteAria, { name: form.name })}
              onclick={() => removeMetric(form)}
            >
              <span class="codicon codicon-trash"></span>
            </button>
          {/if}
          <span class="bld-valid">
            {#if exprCheck.state === 'pending'}
              <span class="bld-expr-state muted">{S.builder.exprChecking}</span>
            {:else if exprCheck.state === 'valid'}
              <span class="bld-expr-state ok"><span class="codicon codicon-check"></span> {S.builder.exprValid}</span>
            {:else if exprCheck.state === 'error'}
              <!-- w19 23d: the full line rides the title — the slot
                   ellipsizes a long error in place. -->
              <span class="bld-expr-state bad" title={exprErrorText}>
                <span class="codicon codicon-error"></span> {exprErrorText}
              </span>
            {/if}
          </span>
          <span class="toolbar">
            <span class="muted bld-note">
              <!-- The disabled Save's reason, in the user's words (the
                   button carries the same string as its tooltip). -->
              {builtinLoaded
                ? form.edited
                  ? S.builder.builtinEditedNote
                  : S.builder.builtinEditNote
                : S.builder.saveNoteDefault}
            </span>
            <button
              class="btn primary"
              onclick={save}
              disabled={saveDisabled}
            >
              <span class="codicon codicon-save"></span>
              {saving
                ? S.builder.saving
                : (builtinLoaded ? form.edited : form.id) && !dirty
                  ? S.builder.saved
                  : S.builder.saveMetric}
            </button>
          </span>
        </div>
      </section>

      <section class="panel bld-preview">
        <div class="row-between">
          <h2>{S.builder.previewHeading}</h2>
          <div class="toolbar">
            <!-- The preview panel's state chip sits immediately LEFT of
                 the Preview button (w19 item 23c — the owner's ruling),
                 the same cluster order as hint → Save in the
                 editor's actions line. Position only: the chip's markup
                 and wording are untouched, and the ms/truncated chips
                 keep their slots after the button. -->
            {#if preview && !previewAdhoc && previewKey}
              <StatusChip
                status={stateOf(previewKey.id)}
                title={chipTitleOf(previewKey.id)}
                progress={metricProgressFrac(metricProgress, previewKey.id)}
                stage={metricProgressStage(metricProgress, previewKey.id)}
              />
            {/if}
            <button class="btn primary" onclick={() => runPreview()} disabled={previewBusy}>
              <span class="codicon codicon-play"></span>
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
          </div>
        </div>

        {#if previewError}
          <p class="error" role="alert">{previewError}</p>
        {:else if preview}
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
                  </tr>
                </thead>
                <tbody>
                  {#each sortedPreviewRows as r, i (i)}
                    <tr
                      class:bld-missing={r.value == null}
                      class:bld-egroup={!r.group}
                      title={r.value == null ? S.builder.noDataBehind : ''}
                    >
                      <td class="mono">{r.group || '—'}</td>
                      <td>
                        <!-- A player grouping carries the Steam id in r.group
                             (ProfileLink's own isSteam guard makes that a
                             link); every other grouping — side, weapon, … —
                             stays plain text. -->
                        <ProfileLink steam={r.group} name={r.label || '—'} {nav} />
                      </td>
                      <td class="num">{fmtMetric(r.value, previewFormat, r.valueKey, () => r.label)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          <!-- Provenance copy: the statement as written. A raw statement is
               its own display SQL and runs as it reads. -->
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

  <RunningMetricsDialog open={runningOpen} onClose={() => (runningOpen = false)} />
</div>
