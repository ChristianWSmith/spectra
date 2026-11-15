<script>
  import * as S from '../strings/index.js';
  import { isSteam, replayHash } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import {
    getMatch,
    getScoreboard,
    getRounds,
    getWarnings,
    getCombatStats,
    getRoundClasses,
    getEconomy,
    getClutches,
    getEngagements,
    getUtility,
    getVoicePresence,
    getMatchSummary,
    evictDemoCopy,
    listMetrics,
    getMetricValuesForMatch,
    getMetricComputeState,
    subscribeJobProgress,
    subscribeMetricProgress,
    onMetricDone,
    errText,
  } from '../services.js';
  import {
    metricPresentation,
    metricStateTitle,
    liveMetricState,
    metricProgressFrac,
    metricProgressStage,
  } from '../metricstate.js';
  import {
    fmtDuration,
    fmtBytes,
    fmtDate,
    fmt1,
    fmt2,
    fmtInt,
    fmtMetric,
    fmtPatch,
  } from '../fmt.js';
  import { teamNames, teamStartClass, playerSideClassAt } from '../teams.js';
  import { roundIndexLabel, separatorFlags } from '../rounds.js';
  import { winnerTeamKey } from '../sideparity.js';
  import { MATCH_TABS, matchTabSlug, buildHash } from '../router.js';
  import RoundStrip from '../components/RoundStrip.svelte';
  import Economy from './Economy.svelte';
  import Utility from './Utility.svelte';
  import Heatmaps from './Heatmaps.svelte';
  import Combat from './Combat.svelte';
  // Details / Reports tabs embed the standalone views (embedded=true
  // fixes them to THIS match — no picker, no newest-match default).
  import Explorer from './Explorer.svelte';
  import Reports from './Reports.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import SortTh from '../components/SortTh.svelte';
  import StatCard from '../components/StatCard.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';
  import WinnerCell from '../components/WinnerCell.svelte';
  import { readOrder, resolvePinIds, pinnedInSequence } from '../metricorder.js';
  import { seed, remember, matchKey } from '../viewstate.svelte.js';
  // Tier 1 of the loading ladder (PRODUCT.md "### Defaults"): the
  // replay's data bundle, warmed in the BACKGROUND from this screen.
  import { preloadReplay } from '../replay/preload.js';

  // routeTab: the deep-linked tab from App's route (#/match/:id/<slug> —
  // every tab is deep-linkable, see MATCH_TABS in lib/router.js); '' for
  // plain #/match/:id. Tabs are otherwise local state like every other
  // match tab — see selectTab for how the active tab mirrors itself in
  // the URL.
  // expandReplay: when App still holds a LIVE Replay instance for this
  // match (the mini-player dock — keepalive.js), it is THE expand path
  // back into it (App.expandReplay): "Watch replay" then returns to the
  // running instance (filter/loop/selection/playhead intact) instead of
  // minting a fresh entry hash. Null while no instance is alive → the
  // fresh-entry replayHash below, exactly as before.
  let { id = 0, nav = () => {}, routeTab = '', expandReplay = null } = $props();

  // The tab bar is the canonical list from the route table, so a deep
  // link can never point at a tab that does not exist.
  const TABS = MATCH_TABS;

  // GetScoreboard sort whitelist (mirror of the Go store's map).
  // Combined columns sort by their primary key.
  // ADR / KAST% / HS% / K/D left SCORE_COLS with the dogfooding
  // conversion (W2); A, 2K–5K, Entry, Trade and Streak left with the
  // inferred-conversion swap (W2a): all twelve render as PINNED METRIC
  // columns at the tail (metricCols below — sourced from the stored
  // metric rows through the five-state machine), in today's relative
  // order once the default pins/sequence land (metricorder.js).
  // Opening K/D keeps its fixed position AND its sort key (server
  // ordering over opening_kills is value-identical to the entry_kills
  // metric) — only its cell changed: it composes the entry_kills /
  // entry_deaths metric halves (design Q2). Every remaining key here
  // is a store column, so the server sort applies verbatim.
  const SCORE_COLS = [
    { key: 'name', label: 'Name' },
    // "Team" column: the key stays `side` (the store's sort whitelist is
    // keyed by it) but the cell shows the TEAM's display name — see the
    // body branch below.
    { key: 'side', label: 'Team' },
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'kda', label: 'KDA' },
    { key: 'total_damage', label: 'DMG' },
    { key: 'rounds_played', label: 'Rnds' },
    // Fixed position, metric-composed cell (design Q2): both halves
    // read the fixed named slots entry_kills / entry_deaths — the
    // identical stored columns this cell used to render raw. The body
    // branch below owns the cell (value-or-dash halves, never a chip).
    { key: 'opening_kills', label: 'Opening K/D' },
    { key: 'utility_damage', label: 'Util' },
    { key: 'mvps', label: 'MVPs' },
    { key: 'score', label: 'Score' },
  ];

  let match = $state(null);
  let summary = $state(null); // MatchSummary row (team names)
  let rounds = $state([]);
  let scoreboard = $state([]);
  let tab = $state('Overview');
  let sortKey = $state('kills');
  let desc = $state(true);

  // Selection state (the expanded scoreboard row + the Rounds-tab
  // compare picks below) restores per match through the process-scoped
  // registry (viewstate.svelte.js): the key carries the match id
  // (matchKey), so match A's picks never show in match B. App reuses
  // this component when only the id changes (no remount), so ONE
  // combined effect both RE-SEEDS on a key change and writes through
  // otherwise — self-ordering: the write branch runs only while the key
  // is unchanged, so the old match's values can never land under the
  // new key. The TAB stays URL-owned (routeTab effect below) and is
  // never registered; busy/error/warnings stay transient.
  const selDefaults = () => ({ expanded: 0, compareSel: [] });
  const selKey = $derived(matchKey('selection', id));
  // Deliberate ONE-TIME init capture: the derived is read inside a closure
  // (Svelte's documented state_referenced_locally fix); the snapshot carries
  // the key so lastKey matches without a second top-level derived read.
  // The combined reseed/write-through $effect below owns every later key
  // change — URL stays the sole durable record; registry semantics unchanged.
  const selInit = () => ({ ...seed(selKey, selDefaults()), key: selKey });
  const selSeed = selInit();
  let expanded = $state(selSeed.expanded); // steamId of the expanded scoreboard row
  let warnings = $state(null); // null = not loaded
  // Warnings render directly (no header button): the panel is open by
  // default whenever the match has warnings, and the dismiss X hides it
  // for the rest of this mounted session.
  let warningsDismissed = $state(false);
  let error = $state('');
  // M4 header badges: voice presence + chat-decrypt key state.
  let voice = $state(null);

  // Analytics (M3): per-round classification chips for the Rounds tab.
  // The per-player KAST path (combatBySteam + its fetch + the combatError
  // panel) died with the dogfooding conversion (W2) — KAST% is a pinned
  // metric column now (the Combat tab still warms getCombatStats below).
  let classByRound = $state(new Map());
  let classError = $state('');
  // Rounds-tab compare picker: round numbers (max 4).
  let compareSel = $state(selSeed.compareSel);
  let selLastKey = selSeed.key;
  $effect(() => {
    const k = selKey;
    if (k !== selLastKey) {
      // Another match without a remount: apply its record (defaults
      // when it has none) and do not write — the entry keeps exactly
      // what was applied, so the old match's picks can never land under
      // the new key (the write-through re-arms on the next selection
      // change, which reads the re-seeded values).
      selLastKey = k;
      const s = seed(k, selDefaults());
      expanded = s.expanded;
      compareSel = s.compareSel;
      return;
    }
    remember(k, { expanded, compareSel });
  });

  // Side-switch boundary per row (index-aligned with rounds): the
  // round-group separator gating from the canonical helper
  // (lib/rounds.js separatorFlags — cadence + counted-gating + trailing
  // suppression). Row i carries the boundary that follows row i-1 as its
  // `.split-before` class (public/style.css, the table twin of
  // RoundStrip's `.round-split`); counted-gating keeps a legacy
  // pre-reprocess negative row from shifting a line and the last row can
  // never carry a trailing one.
  const sepFlags = $derived(separatorFlags(rounds));

  // localStorage contract (M5): 'spectra:pinned-metrics' holds a JSON
  // array of metric ids — written by Builder's scope-routed pin toggles
  // (match scope only; profile-scope pins live under
  // 'spectra:pinned-profile-metrics' and surface on PlayerProfile), read
  // here when a scoreboard renders. Ids resolve through listMetrics() on
  // load (a deleted metric drops out, and only scope='match' metrics
  // ever become a column — design §5's pin-picker filter). The VALUES
  // come from the ONE canonical read (getMetricValuesForMatch — stored
  // rows, never a query-time calculation); the compute state and the
  // live progress feed decide whether a cell shows the number or the
  // state chip (lib/metricstate.js — design §5's state machine).
  let pins = $state([]);
  let metricCols = $state([]);
  // The W2a fixed named slots (design §6.1): the compound cells'
  // halves and the expanded row's two stat lines read these metrics BY
  // NAME — pins-independent, unioned into the ONE stored read below (an
  // unpinned metric still fills its cell — the kast precedent).
  const FIXED_SLOTS = [
    'assists',
    'entry_kills',
    'entry_deaths',
    'flash_assists',
    'enemies_flashed',
  ];
  // name → columnOf() data for each fixed slot the catalog carried
  // (empty until the read lands; a name the catalog lacks stays absent
  // → the honest dash, never a guessed number).
  let fixedCols = $state(new Map());
  let metricError = $state('');
  // metricId → {state, error} from GetMetricComputeState (refetched on
  // mount and on every spectra:metric-done — the sweep's outcome);
  // metricProgress is the LIVE k/N feed (subscribeMetricProgress), so a
  // sweep that starts after this view mounted still flips its cells to
  // processing without a refetch. metricReload re-runs the pins effect
  // at completion (the cache already flushed — this is the refetch).
  let metricStates = $state(new Map());
  let metricProgress = $state(new Map());
  let metricReload = $state(0);

  $effect(() => subscribeMetricProgress((snap) => (metricProgress = snap)));
  $effect(() => onMetricDone(() => (metricReload += 1)));

  // Match header + rounds + summary. Scoreboard has its own effect below
  // (sort changes must not re-trigger this one). The summary row is the
  // one-match GetMatchSummary getter (same JSON shape as a ListMatches
  // element) — never the whole library list for a single header lookup.
  $effect(() => {
    let live = true;
    Promise.all([
      getMatch(id),
      getRounds(id),
      getMatchSummary(id),
      getVoicePresence(id).catch(() => null),
    ])
      .then(([m, r, s, v]) => {
        if (!live) return;
        match = m;
        rounds = r || [];
        summary = s || null;
        voice = v;
        error = m ? '' : 'Match not found.';
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  // Tier 1 of the loading ladder (PRODUCT.md "### Defaults"): warm the
  // replay bundle the MOMENT the match screen opens — before "Watch
  // replay" is ever clicked — so the replay usually resolves from
  // memory. Fire-and-forget: never awaited, never gates this view's
  // rendering (Replay's load() awaits the SAME memo, start-if-missing,
  // so a deep link straight to #/replay/:id keeps working). preloadReplay
  // skips the start while a library job is running — warming cached
  // reads mid-import is systematically wasted (preload.js documents the
  // bail-out; its flush listeners are the correctness net either way).
  // App reuses this view across id changes without remounting (see the
  // selection-key comment above), so the effect is keyed on id alone.
  $effect(() => {
    preloadReplay(id);
  });

  // Tier 1 of the loading ladder (PRODUCT.md "### Defaults"): warm the
  // per-match ANALYTICS set — this view's own KAST column and round chips
  // plus the Combat/Utility/Economy tabs' reads — the MOMENT the match
  // screen opens, so tab switches stop flashing "Loading…" / empty
  // tables. Fire-and-forget: never awaited, never gates rendering; the
  // reads below go through services' cachedRead wrappers, so this warm
  // shares ONE entry per (method, args) with this view's own effects and
  // with RoundDetail/CompareRounds.
  //
  // BAIL-OUT (mirror of preload.js:204-223 libraryJobsActive — READ-ONLY
  // reference, that module owns the replay bundle memo and pulls in the
  // whole preload engine, so the tiny flag is mirrored here): every
  // spectra:* data event clears services' readCache and spectra:job-progress
  // fires every ~100 ms, so warming cached reads mid-import is
  // systematically wasted. subscribeJobProgress hands the CURRENT snapshot
  // to the callback SYNCHRONOUSLY, so `running` is primed before the warm
  // decision below — whatever slips through the first ~100 ms window is
  // dropped by the flush listeners (the correctness net). The subscription
  // is scoped to this effect run and unsubscribed in its cleanup (a
  // component-lifetime registration would outlive every unmount). App
  // reuses this view across id changes without remounting (see the
  // selection-key comment above), so the effect is keyed on id alone —
  // and a falsy id has nothing to warm.
  $effect(() => {
    const mid = id;
    if (!(mid > 0)) return;
    let running = false;
    const off = subscribeJobProgress((snap) => {
      running = !!(snap && snap.size);
    });
    if (running) return off;
    void Promise.allSettled([
      getEconomy(mid),
      getRoundClasses(mid),
      getCombatStats(mid),
      getClutches(mid),
      getEngagements(mid, ''),
      getUtility(mid),
    ]);
    return off;
  });

  // Demo-copy state line (Details → Key facts): copyState is fs-derived
  // by Go on this read (copied / external / missing). Freeing re-reads the
  // header through the normal getter (the mutating wrapper invalidated the
  // read cache), so the state line re-derives instead of being guessed.
  let copyBusy = $state(false);

  async function onFreeCopy() {
    if (copyBusy || !match) return;
    copyBusy = true;
    try {
      await evictDemoCopy(match.id);
      match = await getMatch(id);
    } catch (e) {
      error = errText(e);
    } finally {
      copyBusy = false;
    }
  }

  // Warnings fetch — only when the match actually has warnings
  // (match.warningsCount > 0; a clean match renders no panel at all).
  // Re-runs when the match changes (id switch) and resets the list, so
  // the panel always shows this match's warnings while it is visible.
  $effect(() => {
    const n = match ? match.warningsCount : 0;
    if (!(n > 0)) return;
    let live = true;
    warnings = null;
    getWarnings(id)
      .then((w) => {
        if (live) warnings = w || [];
      })
      .catch((e) => {
        if (live) {
          warnings = [];
          error = errText(e);
        }
      });
    return () => (live = false);
  });

  // Deep-linked tab from App's route (#/match/:id/<slug>): select the
  // tab whenever the route carries one — runs on mount before first
  // paint, so it also seeds the initial tab (no local prop read in the
  // $state initializer). When the tab bar clears the segment (selectTab →
  // plain #/match/:id for Overview) routeTab becomes '' and the local tab
  // state is left alone.
  $effect(() => {
    if (routeTab) tab = routeTab;
  });

  // Scoreboard fetch: initial load + every sort change. The four
  // converted columns (ADR/KAST%/HS%/K/D) sort as m:* metric keys —
  // never a store sort — so server ordering for the remaining SCORE_COLS
  // stays exactly as GetScoreboard returns it.
  $effect(() => {
    sortKey;
    desc;
    // m:* metric columns sort client-side (viewRows) — the store sort
    // only ever runs for SCORE_COLS keys.
    if (sortKey.startsWith('m:')) return;
    let live = true;
    getScoreboard(id, sortKey, desc)
      .then((sb) => {
        // The ONE place this view's roster rows enter: listedPlayers
        // (lib/players.js — the canonical client-side bot filter; the
        // store already filters GetScoreboard, this is its twin) covers
        // every derivation below — rosters, viewRows, topStats, the
        // team_<player> names and the per-round side lookups.
        if (live) scoreboard = listedPlayers(sb) || [];
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  // Round classification chips (label + explanation + rule version).
  $effect(() => {
    let live = true;
    classError = '';
    getRoundClasses(id)
      .then((rows) => {
        if (live) classByRound = new Map((rows || []).map((r) => [r.round, r]));
      })
      .catch((e) => {
        if (live) classError = errText(e);
      });
    return () => (live = false);
  });

  const viewRows = $derived.by(() => {
    if (sortKey.startsWith('m:')) {
      const col = metricCols.find((c) => metricSortKey(c.def.id) === sortKey);
      if (!col) return scoreboard;
      return [...scoreboard].sort((a, b) => {
        const va = metricSortVal(col, a);
        const vb = metricSortVal(col, b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return desc ? vb - va : va - vb;
      });
    }
    return scoreboard;
  });

  // --- M5 pinned metric columns ---------------------------------------------
  // Column-merge: SCORE_COLS stays a pure store-driven set; pinned metrics
  // append as extra <th>/<td> cells rendered from their own preview map.
  // Sorting a metric key never leaves the client (the fetch effect skips
  // m:* keys), so GetScoreboard ordering for the M1/M3/M4 columns is
  // untouched; players without a value for the metric sort last either way.
  // render = FIXED_BLOCK ++ resolveOrder ∩ pins (design §1.3): pins
  // SELECT the columns, the order pref SEQUENCES them — the pins array's
  // own order stopped being an ordering source.
  function readPins() {
    // The RAW stored selection — null when the key is ABSENT (the
    // absent-vs-present rule lives in metricorder.resolvePinIds:
    // absent ⇒ DEFAULT_PINS through the catalog, present ⇒ verbatim).
    try {
      const raw = localStorage.getItem('spectra:pinned-metrics');
      if (raw == null) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      return [...new Set(arr.map(Number).filter((n) => Number.isFinite(n)))];
    } catch {
      return null;
    }
  }

  function metricSortKey(metricId) {
    return `m:${metricId}`;
  }

  function metricSortVal(col, p) {
    const r = col.map.get(p.steamId);
    return r && Number.isFinite(r.value) ? r.value : null;
  }

  function columnOf(def, rows, st) {
    // rows: the canonical read's stored values for THIS match (fresh
    // only), keyed by steam id; st: the metric's compute-state entry.
    return {
      def,
      rows,
      map: new Map(rows.map((r) => [r.steamId, r])),
      // The unit's sibling coverage: at least one fresh row for this
      // metric in THIS match — what separates no-data ('—') from the
      // behind chip (design §5 states 4/5).
      unitHasRows: rows.length > 0,
      error: (st && st.error) || '',
    };
  }

  $effect(() => {
    id;
    metricReload; // spectra:metric-done → refetch (the cache flushed)
    let live = true;
    // Read localStorage directly — reading the `pins` state here would make
    // it a dependency of this effect and re-trigger it on every pin write.
    const stored = readPins(); // null = ABSENT → metricorder resolves DEFAULT_PINS
    pins = stored || [];
    metricCols = [];
    fixedCols = new Map();
    metricError = '';
    // The catalog read ALWAYS runs (never gated on the pins): the fixed
    // named slots above need it even when a stored selection says "pin
    // nothing" — the selection governs the COLUMNS, not these cells.
    Promise.all([listMetrics(), readOrder('match')])
      .then(([defs, order]) => {
        if (!live) return;
        const rows = defs || [];
        // Absent key ⇒ DEFAULT_PINS resolved by name through the catalog
        // (design §1.6); present ⇒ verbatim, even '[]' — a stored "pin
        // nothing" is never overridden (and never silences the fixed
        // slots either — they are not a selection).
        const pinIds = resolvePinIds('match', stored, rows);
        pins = pinIds;
        // THE composition (lib/metricorder.js — the ONE site): the
        // sequence filtered to the pinned set. The pins array orders
        // nothing; a newly pinned metric appears where the sequence
        // puts it, never appended.
        const picked = pinnedInSequence('match', order, rows, pinIds);
        // THE one stored read: the pinned column ids UNIONED with the
        // fixed named slots' ids (design §6.1). An empty id list would
        // mean "every metric" on the wire — never send one; with
        // nothing to read both outputs stay empty (columns and fixed
        // cells render their honest gaps).
        const byName = new Map(rows.map((d) => [d.name, d]));
        const fixed = FIXED_SLOTS.map((n) => byName.get(n)).filter(Boolean);
        const ids = [...new Set([...picked.map((d) => d.id), ...fixed.map((d) => d.id)])];
        if (ids.length === 0) return;
        // ONE stored read for every pin and every fixed slot (design §5:
        // N previewMetric calls → one stored read) beside the one
        // compute-state read.
        return Promise.all([getMetricValuesForMatch(id, ids), getMetricComputeState()]).then(
          ([values, states]) => {
            const byMetric = new Map();
            for (const v of values || []) {
              if (!byMetric.has(v.metricId)) byMetric.set(v.metricId, []);
              byMetric.get(v.metricId).push(v);
            }
            const stateById = new Map((states || []).map((s) => [s.metricId, s]));
            if (live) metricStates = stateById;
            const colFor = (def) =>
              columnOf(def, byMetric.get(def.id) || [], stateById.get(def.id));
            return {
              cols: picked.map(colFor),
              fixed: new Map(fixed.map((d) => [d.name, colFor(d)])),
            };
          },
        );
      })
      .then((res) => {
        if (live && res) {
          metricCols = res.cols;
          fixedCols = res.fixed;
        }
      })
      .catch((e) => {
        if (live) metricError = errText(e);
      });
    return () => (live = false);
  });

  function unpin(metricId) {
    pins = pins.filter((x) => x !== metricId);
    try {
      localStorage.setItem('spectra:pinned-metrics', JSON.stringify(pins));
    } catch {
      /* storage unavailable — the column still drops for this render */
    }
    metricCols = metricCols.filter((c) => c.def.id !== metricId);
    if (sortKey === metricSortKey(metricId)) {
      sortKey = 'kills';
      desc = true;
    }
  }

  function metricCell(mc, p) {
    return mc.map.get(p.steamId) || null;
  }

  // THE state machine (lib/metricstate.js, design §5): the live
  // progress feed wins over the refetch-time state word, then the
  // precedence picks value / '—' / chip. Every metric cell renders
  // through this — no view spells the rule itself.
  function metricCellPres(mc, p) {
    const st = liveMetricState(metricProgress, metricStates, mc.def.id);
    return metricPresentation(st, metricCell(mc, p), mc.unitHasRows);
  }

  // The cell's tooltip: fresh → formula + sample size n (never a
  // stamp); '—' → the no-data copy; a chip → the state title (failed
  // carries the engine's error text).
  function metricCellTitle(mc, pres) {
    if (pres.kind === 'value') return `${mc.def.title || mc.def.name} — sample size n=${pres.n}`;
    if (pres.kind === 'nodata') return 'no data for this player';
    return metricStateTitle(pres.state, mc.error);
  }

  // --- W2a fixed named slots (design §6.1) --------------------------------
  // The compound cells (Opening K/D pair, Overview roster K/D/A
  // triples) and the expanded row's two stat lines read their metrics
  // BY NAME from `fixedCols` — pins-independent (an unpinned metric
  // still fills its cell), resolved from the SAME catalog read and
  // served by the SAME ONE stored read as the pinned columns.
  function fixedPres(name, p) {
    const mc = fixedCols.get(name);
    // Slot not resolved yet (read in flight / name absent from the
    // catalog): the neutral dash — never a guessed chip, never a number.
    if (!mc) return metricPresentation('', null, false);
    const st = liveMetricState(metricProgress, metricStates, mc.def.id);
    return metricPresentation(st, mc.map.get(p.steamId) || null, mc.unitHasRows);
  }

  // fixedTitle — one fixed slot's tooltip (the Combat slot pattern):
  // fresh → title + sample size, dash → the no-data copy, a state →
  // its state title (failed carries the engine's error text).
  function fixedTitle(name, pres) {
    const mc = fixedCols.get(name);
    const label = mc ? mc.def.title || mc.def.name : name;
    if (pres.kind === 'value') return `${label} — sample size n=${pres.n}`;
    if (pres.kind === 'nodata') return 'no data for this player';
    return metricStateTitle(pres.state, (mc && mc.error) || '');
  }

  // halfText — one COMPOUND half's rendered number: the fresh value
  // through the metric's format tag, the honest dash otherwise. A
  // non-value half never renders a number or a chip inside a compound
  // cell (invariant 9) — its state reaches the cell via compoundTitle.
  function halfText(name, pres) {
    if (pres.kind !== 'value') return '—';
    const mc = fixedCols.get(name);
    return fmtMetric(pres.value, (mc && mc.def.format) || '');
  }

  // compoundTitle — a value pair/triple's tooltip: EMPTY while every
  // half shows its number (these cells carried no tooltip before the
  // conversion, so the rendered output stays byte-identical), otherwise
  // the first non-value half's state title (invariant 9 — the state
  // lives in the title, never a second chip).
  function compoundTitle(halves) {
    for (const h of halves) {
      if (h.pres.kind !== 'value') return fixedTitle(h.name, h.pres);
    }
    return '';
  }

  // The Opening K/D cell (fixed SCORE_COLS position — design Q2): the
  // entry_kills / entry_deaths halves — the identical stored columns
  // the cell used to render raw — in the unchanged ${k}/${d} format.
  function openingKd(p) {
    const halves = [
      { name: 'entry_kills', pres: fixedPres('entry_kills', p) },
      { name: 'entry_deaths', pres: fixedPres('entry_deaths', p) },
    ];
    return {
      text: halves.map((h) => halfText(h.name, h.pres)).join('/'),
      title: compoundTitle(halves),
    };
  }

  // The roster K/D/A line (design Q2): raw K + raw D + the assists
  // metric half, read by NAME so an unpinned assists still fills it.
  function rosterKda(p) {
    const a = { name: 'assists', pres: fixedPres('assists', p) };
    return {
      text: `${p.kills}/${p.deaths}/${halfText(a.name, a.pres)}`,
      title: compoundTitle([a]),
    };
  }

  // slotText — one STANDALONE fixed slot's text half (the expanded
  // row, the Combat pattern): the stored number through the metric's
  // format, the honest dash for no-data, and NOTHING for a state — the
  // chip renders instead. (Compound halves use halfText above, which
  // never renders a chip inside a pair/triple — invariant 9.)
  function slotText(name, pres) {
    if (pres.kind === 'nodata') return '—';
    if (pres.kind !== 'value') return '';
    const mc = fixedCols.get(name);
    return fmtMetric(pres.value, (mc && mc.def.format) || '');
  }

  // fixedId — one resolved slot's metric id (the live-progress feed's
  // key); undefined until the read lands.
  function fixedId(name) {
    const mc = fixedCols.get(name);
    return mc && mc.def.id;
  }

  function toggleSort(key) {
    if (sortKey === key) desc = !desc;
    else {
      sortKey = key;
      desc = true;
    }
    expanded = 0;
  }

  // Cell display for a scoreboard column: map the snake_case sort key
  // onto the row's camelCase field. Every column that carried its own
  // display (the converted metrics, incl. Opening K/D's ${k}/${d}) left
  // SCORE_COLS with the conversions — those cells render through the
  // metric machinery above; kda keeps its case (Go-computed,
  // inexpressible, N1).
  function cellText(col, p) {
    const field = col.key.replace(/_(\w)/g, (_, c) => c.toUpperCase());
    switch (col.key) {
      case 'kda':
        return fmt2(p.kda);
      default:
        return p[field];
    }
  }

  // The origin path for drill-down return trips (?back=…) — RoundDetail,
  // CompareRounds and Replay's Back button resolve it to this tab (plain
  // #/match/:id for Overview).
  function backPath() {
    return tab === 'Overview' ? `match/${id}` : `match/${id}/${matchTabSlug(tab)}`;
  }

  // Player entry → THE event browser with the camera on that player.
  // opts.follow asks Replay to set the camera to that player; EVERY
  // player entry point passes it — roster rows, scoreboard rows and the
  // Overview stat cards — so a click on any of them opens Replay focused
  // on the player it belongs to. back + follow are navigation context,
  // NOT a landmark filter: the steamId scope is deliberately not set
  // (outside the replay, buttons seek/follow — never filter).
  function openPlayerEvents(steamId, opts) {
    const follow = opts && opts.follow ? { follow: steamId } : {};
    nav(replayHash(id, {}, { back: backPath(), ...follow }));
  }

  function openReplay() {
    // Keep-alive expand: the dock's one canonical path (same function the
    // mini-panel's click uses) — replayHash() below is only for a FRESH
    // entry (no instance alive), where the entry query is the point.
    if (expandReplay) {
      expandReplay();
      return;
    }
    nav(replayHash(id, {}, { back: backPath() }));
  }

  // SteamID64 guard — bots/short ids never match #/player/(\d{17}).
  // --- Rounds-tab compare picker (max 4) --------------------------------
  function toggleCompare(n) {
    if (compareSel.includes(n)) compareSel = compareSel.filter((x) => x !== n);
    else if (compareSel.length < 4) compareSel = [...compareSel, n];
  }

  // The compared rounds ride the URL — CompareRounds reads ?rounds= and
  // ?back=.
  function goCompare() {
    nav(
      buildHash(`/compare/${id}`, {
        rounds: compareSel.join(','),
        back: backPath(),
      }),
    );
  }

  // Tab switch: the active tab mirrors itself in the URL so every tab is
  // deep-linkable (#/match/:id/<slug>, slugs from MATCH_TABS in
  // lib/router.js). The default Overview tab keeps the plain #/match/:id
  // form (that is the URL-cleanup case — plain parses back to Overview),
  // and writing the segment always produces a hashchange, so drill-downs
  // that target another tab (nav('/match/:id/economy')) are never a
  // no-op while a different tab is visible. The hashchange re-parses to
  // the same route.name, so this view never remounts — only routeTab
  // changes, which the effect above applies.
  function selectTab(t) {
    tab = t;
    nav(t === 'Overview' ? `/match/${id}` : `/match/${id}/${matchTabSlug(t)}`);
  }

  // JSON.parse of killsByWeapon/damageByWeapon — "" or malformed → [].
  function weaponEntries(json) {
    if (!json) return [];
    try {
      const obj = JSON.parse(json);
      if (!obj || typeof obj !== 'object') return [];
      return Object.entries(obj).sort((a, b) => Number(b[1]) - Number(a[1]));
    } catch {
      return [];
    }
  }

  // Team display names for the scoreline header and the roster headings:
  // the demo's clan names when the extract recorded them, else a
  // player-derived `team_<player>` name per side (see lib/teams.js).
  // These label the TEAMS (final sides) — never the sides themselves.
  const teams = $derived(
    teamNames({
      ctName: summary?.ctName || '',
      tName: summary?.tName || '',
      players: scoreboard,
    }),
  );

  // Winner cell label for ONE round row: the TEAM that won it, resolved
  // by the canonical round-number parity (sideparity.winnerTeamKey) and
  // looked up in `teams` (keyed by final side). A side never names a
  // team past the halftime switch. Unknown (no winner side, round not
  // loaded) → '' so WinnerCell falls back to the bare side chip — never
  // a guessed name.
  function winnerName(r) {
    const key = winnerTeamKey(rounds, match?.sideSwitches || 0, r.number, r.winner);
    return key ? teams[key] : '';
  }

  const rosters = $derived.by(() => {
    const ct = scoreboard.filter((p) => p.side === 'ct');
    const t = scoreboard.filter((p) => p.side === 't');
    const other = scoreboard.filter((p) => p.side !== 'ct' && p.side !== 't');
    return { ct, t, other };
  });

  // Team-identity color for a NAME: a team is indigo if it started the
  // first half on CT, orange if on T — derived from the canonical
  // side-parity helper (lib/teams.js → sideparity.startSideFor), never
  // from the live side. Unknown side → '' (no color, no guess).
  function teamCls(finalSide) {
    return teamStartClass(finalSide, match?.sideSwitches || 0);
  }

  // Per-round SIDE color for a NAME carried as steam id + display name
  // (round MVP / first-blood rows): the side that player had IN THAT
  // round, resolved through lib/teams.js playerSideClassAt (scoreboard
  // lookup by id, then exact name, then the round's era) — not the
  // team's start side, which is what the aggregate surfaces above use.
  // Unresolved player → '' (never a guessed color).
  function playerRoundCls(roundNumber, steamId, name) {
    return playerSideClassAt(
      scoreboard,
      match?.sideSwitches || 0,
      rounds,
      roundNumber,
      steamId,
      name,
    );
  }

  const topStats = $derived.by(() => {
    if (!scoreboard.length) return [];
    const maxBy = (fn) => scoreboard.reduce((a, b) => (fn(b) > fn(a) ? b : a));
    const frag = maxBy((p) => p.kills);
    const util = maxBy((p) => p.utilityDamage);
    const adr = maxBy((p) => p.adr);
    const entry = maxBy((p) => p.entryKills);
    const mvp = maxBy((p) => p.mvps);
    return [
      { label: 'Top fragger', p: frag, value: `${frag.kills}/${frag.deaths}/${frag.assists}` },
      { label: 'Best ADR', p: adr, value: fmt1(adr.adr) },
      { label: 'Most util', p: util, value: `${util.utilityDamage}` },
      { label: 'Entry opens', p: entry, value: `${entry.entryKills}` },
      { label: 'Most MVPs', p: mvp, value: `${mvp.mvps}` },
    ];
  });

  // First blood of the first round that recorded one — kept as parts (not
  // one formatted string) so both names can carry their per-round side
  // color (lib/teams.js playerSideClassAt) and link to their profiles.
  const firstBlood = $derived.by(() => {
    const r = rounds.find((x) => x.firstKillName && x.firstDeathName);
    return r
      ? {
          kill: r.firstKillName,
          killSteam: r.firstKillSteam,
          death: r.firstDeathName,
          deathSteam: r.firstDeathSteam,
          number: r.number,
        }
      : null;
  });
</script>

<div class="view">
  {#if error}
    <!-- In-place dismissal: the ✕ clears the state variable itself (the
         id-keyed effect below re-arms it on the next match load). -->
    <p class="error" role="alert">
      {error}
      <button class="btn small" aria-label={S.match.dismissError} onclick={() => (error = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {/if}

  {#if match}
    <header class="view-header match-header">
      <div>
        <h1>
          <span class={teamCls('ct')}>{teams.ct}</span>
          <span class="score">{match.scoreCT}–{match.scoreT}</span>
          <span class={teamCls('t')}>{teams.t}</span>
        </h1>
        <!-- The view's primary action: the FIRST cell of the meta line
             below the team names/scoreline — far LEFT, with the line's
             details following to its right (the component-scoped rule at
             the end of this file zeroes the global .match-replay
             auto-margin that used to park it on the right). It carries
             the play codicon and a size bump (.match-replay), so it
             still reads as the primary action without costing a line of
             its own. It launches at NO tick — a plain fresh entry (or the
             keep-alive expand), via openReplay below. Tickrate, voice
             presence and parser version live in the Details tab (Key
             facts); only the encrypted-chat key state stays up here. -->
        <p class="muted match-sub">
          <button
            class="btn primary match-replay"
            title={expandReplay
              ? S.match.replayReturnTitle
              : S.match.replayWatchTitle}
            onclick={openReplay}
          >
            <span class="codicon codicon-play" aria-hidden="true"></span> {S.match.watchReplay}
          </button>
          {match.map || '—'}
          · {fmtDuration(match.playbackTimeS)}
          {S.match.patchLabel} {fmtPatch(match.patchVersion)}
          · <StatusChip status={match.status || 'ready'} title={match.error || ''} />
          {#if voice && !voice.keyFound && (match.encryptedMessages || 0) > 0}
            <span
              class="chip voice-badge idle"
              title={S.match.encryptedChatTitle}
              ><span class="codicon codicon-lock"></span></span
            >
          {/if}
        </p>
      </div>
    </header>

    <!-- Warnings: no button — the panel is present iff the match has
         warnings (fetched on load), open until dismissed. -->
    {#if match.warningsCount > 0 && !warningsDismissed}
      <div class="panel warnings-panel">
        <div class="row-between">
          <h2>{S.match.importWarnings}</h2>
          <button class="btn small" aria-label={S.match.dismissWarnings} onclick={() => (warningsDismissed = true)}>
            <span class="codicon codicon-close"></span>
          </button>
        </div>
        {#if warnings == null}
          <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
        {:else if warnings.length === 0}
          <p class="muted" role="status">{S.match.warningsNone}</p>
        {:else}
          <ul class="warning-list">
            {#each warnings as w, i (i)}
              <li>{w}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    <RoundStrip
      {rounds}
      matchId={id}
      teamAbove={teams.ct}
      teamBelow={teams.t}
      sideSwitches={match.sideSwitches || 0}
      back={backPath()}
      {nav}
    />

    <nav class="tabs" aria-label={S.match.matchSectionsAria}>
      {#each TABS as t (t)}
        <button class="tab" class:active={tab === t} onclick={() => selectTab(t)}>
          {t}
        </button>
      {/each}
    </nav>

    {#if tab === 'Overview'}
      <div class="stat-grid">
        {#each topStats as s (s.label)}
          <StatCard
            label={s.label}
            value={s.value}
            sub={s.p.name}
            subCls={teamCls(s.p.side)}
            title={S.fill(S.match.followReplayTitle, { name: s.p.name })}
            onclick={() => openPlayerEvents(s.p.steamId, { follow: true })}
          >
            <!-- Aggregate (per-match) surface: the name keeps the TEAM
                 identity color, but the text itself is the profile link —
                 the card's own click opens Replay with the camera on that
                 player (same as the roster/scoreboard rows). -->
            {#snippet subSlot()}
              <ProfileLink
                steam={s.p.steamId}
                name={s.p.name}
                {nav}
                cls={teamCls(s.p.side)}
                title={S.fill(S.match.openProfile, { name: s.p.name })}
              />
            {/snippet}
          </StatCard>
        {/each}
      </div>

      <!-- Roster rows: K, D and the ADR chip are event-derived for EVERY
           player (extract's applyFinal never overwrites them — one
           convention per player, see internal/extract/agg.go); the
           K/D/A line's A half reads the assists metric instead (design
           Q2 — a value triple composes each half from its own source),
           so there is no snapshot-vs-events distinction left to mark on
           this tab. The old
           "derived" chip + row dim keyed on finalStatePresent advertised a
           retired M1 assumption and mislabeled exact event counts as
           guesses; finalStatePresent stays in the data model as provenance
           for the snapshot-only identity fields (score, ping, crosshair…). -->
      <div class="roster-grid">
        <section class="panel">
          <h2 class={teamCls('ct')}>{teams.ct} {S.match.rosterSuffix}</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">{S.match.colPlayer}</th>
                <th scope="col" class="num">K/D/A</th>
                <th scope="col" class="num">{S.match.colAdr}</th>
              </tr>
            </thead>
            <tbody>
              {#each rosters.ct as p (p.steamId)}
                {@const kda = rosterKda(p)}
                <tr
                  class="clickable"
                  onclick={(e) => {
                    // The name cell carries ProfileLink: a click on the
                    // link belongs to the profile, not to this row's
                    // Replay drill-down (target guard, as on the
                    // scoreboard rows).
                    if (e.target instanceof Element && e.target.closest('button, input, a'))
                      return;
                    openPlayerEvents(p.steamId, { follow: true });
                  }}
                >
                  <td class={teamCls(p.side)}>
                    <ProfileLink
                      steam={p.steamId}
                      name={p.name}
                      {nav}
                      cls={teamCls(p.side)}
                      title={S.fill(S.match.openProfile, { name: p.name })}
                    />
                  </td>
                  <td class="num" title={kda.title || undefined}>{kda.text}</td>
                  <td class="num"><span class="chip adr">{fmt1(p.adr)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
        <section class="panel">
          <h2 class={teamCls('t')}>{teams.t} {S.match.rosterSuffix}</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">{S.match.colPlayer}</th>
                <th scope="col" class="num">K/D/A</th>
                <th scope="col" class="num">{S.match.colAdr}</th>
              </tr>
            </thead>
            <tbody>
              {#each rosters.t as p (p.steamId)}
                {@const kda = rosterKda(p)}
                <tr
                  class="clickable"
                  onclick={(e) => {
                    // The name cell carries ProfileLink: a click on the
                    // link belongs to the profile, not to this row's
                    // Replay drill-down (target guard, as on the
                    // scoreboard rows).
                    if (e.target instanceof Element && e.target.closest('button, input, a'))
                      return;
                    openPlayerEvents(p.steamId, { follow: true });
                  }}
                >
                  <td class={teamCls(p.side)}>
                    <ProfileLink
                      steam={p.steamId}
                      name={p.name}
                      {nav}
                      cls={teamCls(p.side)}
                      title={S.fill(S.match.openProfile, { name: p.name })}
                    />
                  </td>
                  <td class="num" title={kda.title || undefined}>{kda.text}</td>
                  <td class="num"><span class="chip adr">{fmt1(p.adr)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if rosters.other.length > 0}
            <h2>{S.match.rosterOther}</h2>
            <table class="data-table">
              <tbody>
                {#each rosters.other as p (p.steamId)}
                  {@const kda = rosterKda(p)}
                  <tr
                    class="clickable"
                    onclick={(e) => {
                      if (e.target instanceof Element && e.target.closest('button, input, a'))
                        return;
                      openPlayerEvents(p.steamId, { follow: true });
                    }}
                  >
                    <td>
                      <ProfileLink steam={p.steamId} name={p.name} {nav} title={S.fill(S.match.openProfile, { name: p.name })} />
                    </td>
                    <td class="num" title={kda.title || undefined}>{kda.text}</td>
                    <td class="num"><span class="chip adr">{fmt1(p.adr)}</span></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
      </div>
    {:else if tab === 'Scoreboard'}
      {#if metricError}
        <p class="error" role="alert">
          {S.match.pinnedStatsUnavailable} {metricError}
          <button class="btn small" aria-label={S.match.dismissPinnedStatsError} onclick={() => (metricError = '')}>
            <span class="codicon codicon-close"></span>
          </button>
        </p>
      {/if}
      <div class="table-scroll">
        <table class="data-table scoreboard">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">{S.match.expandLabel}</span></th>
              {#each SCORE_COLS as col (col.key)}
                <SortTh
                  label={col.label}
                  cls={col.title ? 'num def' : 'num'}
                  title={col.title || ''}
                  active={sortKey === col.key}
                  {desc}
                  onclick={() => toggleSort(col.key)}
                />
              {/each}
              <!-- Width-constrained column header (the .m5-mth cap): THE
                   short_name display criterion — short || title || name.
                   Every other metric display (cell tooltip, unpin label,
                   Reports, Builder rows, palette) reads title || name. -->
              {#each metricCols as mc (mc.def.id)}
                <SortTh
                  label={mc.def.shortName || mc.def.title || mc.def.name}
                  cls="num def m5-mth"
                  title="{mc.def.doc || mc.def.name}{mc.error ? ` — couldn’t calculate: ${mc.error}` : ''}"
                  active={sortKey === metricSortKey(mc.def.id)}
                  {desc}
                  onclick={() => toggleSort(metricSortKey(mc.def.id))}
                >
                  <span class="m5-ib" title={mc.def.doc || ''}><span class="codicon codicon-info"></span></span>
                  <button
                    class="m5-unpin"
                    title={S.match.unpinTitle}
                    aria-label={S.fill(S.match.unpinAria, { name: mc.def.title || mc.def.name })}
                    onclick={() => unpin(mc.def.id)}><span class="codicon codicon-close"></span></button
                  >
                </SortTh>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each viewRows as p (p.steamId)}
              {@const nameCls = teamCls(p.side)}
              {@const kdCell = openingKd(p)}
              <tr
                class="clickable"
                onclick={(e) => {
                  // Svelte 5 delegated events: child stopPropagation does not
                  // reliably stop this row handler — guard on target instead.
                  if (e.target instanceof Element && e.target.closest('button, input, a'))
                    return;
                  openPlayerEvents(p.steamId, { follow: true });
                }}
                onkeydown={(e) =>
                  e.key === 'Enter' && openPlayerEvents(p.steamId, { follow: true })}
                tabindex="0"
              >
                <td class="expand-cell" onclick={(e) => e.stopPropagation()}>
                  <button
                    class="btn small ghost"
                    aria-label={S.fill(S.match.breakdownAria, { name: p.name })}
                    aria-expanded={expanded === p.steamId}
                    onclick={() => (expanded = expanded === p.steamId ? 0 : p.steamId)}
                  >
                    <span class="codicon {expanded === p.steamId ? 'codicon-chevron-down' : 'codicon-chevron-right'}"></span>
                  </button>
                </td>
                {#each SCORE_COLS as col (col.key)}
                  {#if col.key === 'name'}
                    <td class="num name-cell {nameCls}"
                      >{#if isSteam(p.steamId)}
                        <button
                          class="btn ghost small name-link {nameCls}"
                          title={S.fill(S.match.openProfilePossessive, { name: p.name })}
                          onclick={(e) => {
                            e.stopPropagation();
                            nav(`/player/${p.steamId}`);
                          }}
                        >{p.name}</button>
                      {:else}
                        {p.name}
                      {/if}
                      <!-- No `bot` chip any more: bots never reach this
                           table (GetScoreboard is humans-only —
                           store.HumanOnly — and the rows pass through
                           listedPlayers/lib/players.js on the way in).
                           The replay view is the only place a bot is
                           listed (lib/replay/playercard.js presentAt). -->
                    </td>
                  {:else if col.key === 'side'}
                    <!-- Team cell: the display name for this row's final
                         side (teamNames in lib/teams.js — clan name, else
                         team_<player>, else the bare side), colored by the
                         team's START side like every other team name
                         (teamCls). A row with no recorded side gets no
                         name and no color. -->
                    <td class="num"
                      ><span class="chip {teamCls(p.side)}"
                        >{p.side === 'ct' ? teams.ct : p.side === 't' ? teams.t : '—'}</span
                      ></td
                    >
                  {:else if col.key === 'opening_kills'}
                    <!-- Opening K/D: fixed position, metric-composed
                         cell (design Q2) — each half is the fresh
                         entry_kills / entry_deaths number in the
                         unchanged ${k}/${d} format, or the honest dash
                         with that half's state in the title (never a
                         chip inside a compound cell — invariant 9). -->
                    <td class="num" title={kdCell.title || undefined}>{kdCell.text}</td>
                  {:else}
                    <td class="num">{cellText(col, p)}</td>
                  {/if}
                {/each}
                {#each metricCols as mc (mc.def.id)}
                  {@const pres = metricCellPres(mc, p)}
                  <td class="num m5-cell" title={metricCellTitle(mc, pres)}>
                    {#if pres.kind === 'value'}
                      {fmtMetric(pres.value, mc.def.format)}
                    {:else if pres.kind === 'nodata'}
                      —
                    {:else}
                      <!-- State chip in lieu of a number (design §5):
                           processing / failed / behind. The bar
                           quantifies when the live feed carries k/N. -->
                      <StatusChip
                        status={pres.state}
                        title={metricCellTitle(mc, pres)}
                        progress={metricProgressFrac(metricProgress, mc.def.id)}
                        stage={metricProgressStage(metricProgress, mc.def.id)}
                      />
                    {/if}
                  </td>
                {/each}
              </tr>
              {#if expanded === p.steamId}
                {@const flashed = fixedPres('enemies_flashed', p)}
                {@const flashAssists = fixedPres('flash_assists', p)}
                <tr class="expand-row">
                  <td colspan={SCORE_COLS.length + 1 + metricCols.length}>
                    <div class="weapon-grid util-grid">
                      <div>
                        <h3>{S.match.killsByWeapon}</h3>
                        <table class="data-table mini">
                          <thead>
                            <tr><th scope="col">{S.match.colWeapon}</th><th scope="col" class="num">{S.match.colKills}</th></tr>
                          </thead>
                          <tbody>
                            {#each weaponEntries(p.killsByWeapon) as [w, n] (w)}
                              <tr><td>{w}</td><td class="num">{n}</td></tr>
                            {:else}
                              <tr><td colspan="2" class="muted">{S.match.noneRecorded}</td></tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                      <div>
                        <h3>{S.match.damageByWeapon}</h3>
                        <table class="data-table mini">
                          <thead>
                            <tr><th scope="col">{S.match.colWeapon}</th><th scope="col" class="num">{S.match.colDamage}</th></tr>
                          </thead>
                          <tbody>
                            {#each weaponEntries(p.damageByWeapon) as [w, n] (w)}
                              <tr><td>{w}</td><td class="num">{n}</td></tr>
                            {:else}
                              <tr><td colspan="2" class="muted">{S.match.noneRecorded}</td></tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                      <!-- Utility usage: Utility damage and Times
                           flashed are read-only columns the scoreboard
                           row already carries (store GetScoreboard
                           SELECT); Enemies flashed and Flash assists
                           are fixed metric slots (design §6.1 — the
                           Combat pattern: value / honest dash / state
                           chip, read by NAME from the pins-independent
                           fixed set). -->
                      <div>
                        <h3>{S.match.utilStatsHeading}</h3>
                        <table class="data-table mini">
                          <thead>
                            <tr><th scope="col">{S.match.colStat}</th><th scope="col" class="num">{S.match.colValue}</th></tr>
                          </thead>
                          <tbody>
                            <tr><td>{S.match.statUtilityDamage}</td><td class="num">{p.utilityDamage}</td></tr>
                            <tr>
                              <td>{S.match.statEnemiesFlashed}</td>
                              <td class="num" title={fixedTitle('enemies_flashed', flashed)}
                                >{slotText('enemies_flashed', flashed)}{#if flashed.kind === 'chip'}
                                  <StatusChip
                                    status={flashed.state}
                                    title={fixedTitle('enemies_flashed', flashed)}
                                    progress={metricProgressFrac(metricProgress, fixedId('enemies_flashed'))}
                                    stage={metricProgressStage(metricProgress, fixedId('enemies_flashed'))}
                                  />
                                {/if}</td
                              >
                            </tr>
                            <tr>
                              <td>{S.match.statFlashAssists}</td>
                              <td class="num" title={fixedTitle('flash_assists', flashAssists)}
                                >{slotText('flash_assists', flashAssists)}{#if flashAssists.kind === 'chip'}
                                  <StatusChip
                                    status={flashAssists.state}
                                    title={fixedTitle('flash_assists', flashAssists)}
                                    progress={metricProgressFrac(metricProgress, fixedId('flash_assists'))}
                                    stage={metricProgressStage(metricProgress, fixedId('flash_assists'))}
                                  />
                                {/if}</td
                              >
                            </tr>
                            <tr><td>{S.match.statTimesFlashed}</td><td class="num">{p.flashedTimes}</td></tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {:else if tab === 'Rounds'}
      {#if classError}
        <p class="error" role="alert">
          {S.match.roundTypesUnavailable} {classError}
          <button class="btn small" aria-label={S.match.dismissRoundTypesError} onclick={() => (classError = '')}>
            <span class="codicon codicon-close"></span>
          </button>
        </p>
      {/if}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th
                scope="col"
                class="num cmp-cmp-col"
                title={S.match.compareSelectTitle}
              >{S.match.colCmp}</th>
              <th scope="col" class="num">RD</th>
              <th scope="col">{S.match.colWinner}</th>
              <th
                scope="col"
                class="def"
                title={S.match.buyClassTitle}
              >{S.match.colClass}</th>
              <th scope="col">{S.match.colReason}</th>
              <th scope="col" class="num">{S.match.colDuration}</th>
              <th scope="col">{S.match.colSite}</th>
              <th scope="col">{S.match.colMvp}</th>
              <th scope="col" class="num">{S.match.colEquipCt}</th>
              <th scope="col" class="num">{S.match.colEquipT}</th>
              <th scope="col">{S.match.firstBloodLabel}</th>
              <th scope="col" class="num">{S.match.colKills}</th>
            </tr>
          </thead>
          <tbody>
            {#each rounds as r, ri (r.number)}
              {@const cls = classByRound.get(r.number)}
              <tr
                class="clickable"
                class:split-before={ri > 0 && sepFlags[ri - 1]}
                onclick={(e) => {
                  if (e.target instanceof Element && e.target.closest('input, button, a'))
                    return;
                  nav(buildHash(`/match/${id}/round/${r.number}`, { back: backPath() }));
                }}
                onkeydown={(e) =>
                  e.key === 'Enter' && nav(buildHash(`/match/${id}/round/${r.number}`, { back: backPath() }))}
                tabindex="0"
              >
                <td class="num cmp-cmp-col" onclick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    class="cmp-cb"
                    checked={compareSel.includes(r.number)}
                    disabled={compareSel.length >= 4 && !compareSel.includes(r.number)}
                    aria-label={S.fill(S.match.compareRoundAria, { round: roundIndexLabel(r) })}
                    onchange={() => toggleCompare(r.number)}
                  />
                </td>
                <td class="num">{roundIndexLabel(r)}</td>
                <td>
                  <WinnerCell winner={r.winner} name={winnerName(r)} />
                </td>
                <td>
                  {#if cls}
                    <span
                      class="chip cmp-class {cls.label || 'unknown'}"
                      title={S.fill(S.match.classChipTitle, { what: cls.explanation || 'classified', v: cls.ruleVersion, pct: Math.round((cls.confidence || 0) * 100) })}
                      >{cls.label || 'unknown'}</span
                    >
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td>{r.reason || '—'}</td>
                <td class="num">{fmtDuration(r.durationS)}</td>
                <td>{r.bombSite || '—'}</td>
                <td>
                  {#if r.mvpName}
                    <ProfileLink
                      steam={r.mvp}
                      name={r.mvpName}
                      {nav}
                      cls={playerRoundCls(r.number, r.mvp, r.mvpName)}
                      title={S.fill(S.match.openProfile, { name: r.mvpName })}
                    />
                  {:else}
                    —
                  {/if}
                </td>
                <td class="num"><span class="chip side ct">{r.equipCT}</span></td>
                <td class="num"><span class="chip side t">{r.equipT}</span></td>
                <td>
                  {#if r.firstKillName && r.firstDeathName}
                    <ProfileLink
                      steam={r.firstKillSteam}
                      name={r.firstKillName}
                      {nav}
                      cls={playerRoundCls(r.number, r.firstKillSteam, r.firstKillName)}
                      title={S.fill(S.match.openProfile, { name: r.firstKillName })}
                    />
                    {S.match.killedVerb}
                    <ProfileLink
                      steam={r.firstDeathSteam}
                      name={r.firstDeathName}
                      {nav}
                      cls={playerRoundCls(r.number, r.firstDeathSteam, r.firstDeathName)}
                      title={S.fill(S.match.openProfile, { name: r.firstDeathName })}
                    />
                  {:else}
                    —
                  {/if}
                </td>
                <td class="num">{r.kills}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if compareSel.length > 0}
        <p class="cmp-hint">
          {S.fill(S.match.roundsSelected, { n: compareSel.length })}
        </p>
      {/if}
      {#if compareSel.length >= 2}
        <button class="btn primary cmp-float" onclick={goCompare}>
          {S.fill(S.match.compareBtn, { n: compareSel.length })} <span class="codicon codicon-chevron-right"></span>
        </button>
      {/if}
    {:else if tab === 'Economy'}
      <Economy {id} {nav} />
    {:else if tab === 'Utility'}
      <Utility {id} />
    {:else if tab === 'Heatmaps'}
      <Heatmaps {id} {nav} />
    {:else if tab === 'Combat'}
      <Combat {id} {nav} />
    {:else if tab === 'Reports'}
      <Reports embedded routeId={id} {nav} />
    {:else if tab === 'Details'}
      <!-- Details = Key facts + Explorer's diagnostics (Provenance,
           Entity summary, Network message census), embedded and fixed to
           THIS match. Map/Duration live in the match header. -->
      <section class="panel">
        <h2>{S.match.keyFacts}</h2>
        <dl class="facts">
          <div><dt>{S.match.factServer}</dt><dd>{match.serverName || '—'}</dd></div>
          <div><dt>{S.match.factTickrate}</dt><dd>{fmt1(match.tickRate)} Hz</dd></div>
          <div><dt>{S.match.factFrames}</dt><dd class="num">{fmtInt(match.frames)}</dd></div>
          <div><dt>{S.match.factSize}</dt><dd>{fmtBytes(match.size)}</dd></div>
          <div><dt>{S.match.factImported}</dt><dd>{fmtDate(match.extractedAt)}</dd></div>
          <div><dt>{S.match.factParser}</dt><dd class="mono">{match.parserVersion || '—'}</dd></div>
          <div>
            <dt>{S.match.factVoice}</dt>
            <dd>
              {#if !voice}
                <span class="muted">—</span>
              {:else if voice.hasVoice}
                <span
                  class="chip voice-badge busy"
                  title={S.fill(S.match.voiceRecordedTitle, { n: voice.playerCount })}
                  ><span class="codicon codicon-unmute"></span>
                  {S.fill(S.match.voiceRecordedBadge, { n: voice.playerCount })}</span
                >
              {:else}
                <span
                  class="chip voice-badge idle"
                  title={S.match.voiceNoneTitle}
                  >{S.match.voiceNoneBadge}</span
                >
              {/if}
            </dd>
          </div>
          <div><dt>{S.match.factWarnings}</dt><dd>{match.warningsCount}</dd></div>
          {#if firstBlood}
            <div>
              <dt>{S.match.firstBloodLabel}</dt>
              <dd>
                <ProfileLink
                  steam={firstBlood.killSteam}
                  name={firstBlood.kill}
                  {nav}
                  cls={playerRoundCls(firstBlood.number, firstBlood.killSteam, firstBlood.kill)}
                  title={S.fill(S.match.openProfile, { name: firstBlood.kill })}
                />
                {S.match.killedVerb}
                <ProfileLink
                  steam={firstBlood.deathSteam}
                  name={firstBlood.death}
                  {nav}
                  cls={playerRoundCls(firstBlood.number, firstBlood.deathSteam, firstBlood.death)}
                  title={S.fill(S.match.openProfile, { name: firstBlood.death })}
                />
                ({firstBlood.number >= 1 ? `RD${firstBlood.number}` : roundIndexLabel(firstBlood.number)})
              </dd>
            </div>
          {/if}
          <div class="fact-wide"><dt>{S.match.factSource}</dt><dd class="mono">{match.path}</dd></div>
          <!-- State line under Source: which demo file Re-parse would read
               right now (copyState is fs-derived by Go on this read —
               store never fills it). -->
          <div class="fact-wide">
            <dt>{S.match.factDemoCopy}</dt>
            <dd>
              {#if match.copyState === 'copied'}
                <span>{S.match.copyPrefix} {fmtBytes(match.size)}</span>
                <button
                  class="btn small"
                  disabled={copyBusy}
                  title={S.match.freeCopyTitle}
                  onclick={onFreeCopy}>{copyBusy ? S.match.freeing : S.match.freeCopy}</button
                >
              {:else if match.copyState === 'external'}
                <span class="muted">{S.match.copyExternal}</span>
              {:else if match.copyState === 'missing'}
                <span class="muted">{S.match.copyMissing}</span>
              {:else}
                <!-- Unstamped (never in production — Go always derives one
                     of the three states): a placeholder, never a claim. -->
                <span class="muted">—</span>
              {/if}
            </dd>
          </div>
        </dl>
      </section>
      <Explorer embedded routeId={id} {nav} />
    {/if}
  {:else if !error}
    <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
  {/if}
</div>

<style>
  /* Watch replay sits at the FAR LEFT of the .match-sub meta row (its
     first flex child — the details follow to its right). The global
     .match-replay rule in public/style.css carries `margin-left: auto`,
     which parks it at the RIGHT end of that flex row; this component-
     scoped override zeroes it for THIS row only instead of editing the
     shared rule (public/style.css stays the design worker's file, and
     the right-parked layout remains available to any other host).
     Component CSS is injected after the global sheet and this selector
     is more specific, so it wins. */
  .match-sub .match-replay {
    margin-left: 0;
  }
</style>
