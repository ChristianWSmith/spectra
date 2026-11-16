<script>
  import * as S from '../strings/index.js';
  import { isSteam, replayHash, entryLoopSpan } from '../nav.js';
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
  import { roundIndexLabel, separatorFlags, roundStartTick, roundEndTick } from '../rounds.js';
  import { winnerTeamKey } from '../sideparity.js';
  import { MATCH_TABS, MATCH_TAB_SECTIONS, matchTabSlug, buildHash } from '../router.js';
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
  import EventPlay from '../components/EventPlay.svelte';
  import HelpButton from '../components/HelpButton.svelte';
  import { readOrder, readHidden, resolvePinIds, composedSequence } from '../metricorder.js';
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
  let { id = 0, nav = () => {}, routeTab = '', expandReplay = null, openDocs = () => {} } = $props();

  // The tab bar is the canonical list from the route table, so a deep
  // link can never point at a tab that does not exist.
  const TABS = MATCH_TABS;

  // The header `?` targets the ACTIVE tab's guide section — the ONE
  // per-tab help button (Part 8's per-tab ruling): one button in the
  // view header, never one per tab (anti-spam criterion: primary
  // chrome only). MATCH_TAB_SECTIONS is the same table the lockstep
  // test pins, so the target and the documented coverage cannot drift.
  const helpSection = $derived(MATCH_TAB_SECTIONS[tab] || 'understanding-a-match');

  // The scoreboard's FIXED block (metricorder.js FIXED_BLOCK's `short`
  // mirrors this list): the Go-rendered stats' compact headers in their
  // store order. Combined
  // columns sort by their primary key. N4: these are SEQUENCE entries
  // now (the '@'-namespaced fixed keys in metricorder.js), so the
  // RENDERED column order comes from the composed sequence (sbCols) —
  // this array stays the fixed half's cell renderers + sort keys, and
  // the transposed corner still reads nameCol below.
  // ADR / KAST% / HS% / K/D left SCORE_COLS with the dogfooding
  // conversion (W2); A, 2K–5K, Entry, Trade and Streak left with the
  // inferred-conversion swap (W2a): all twelve render as PINNED METRIC
  // columns (composed into sbCols below — sourced from the stored
  // metric rows through the five-state machine), in today's relative
  // order once the default pins/sequence land (metricorder.js).
  // Opening K/D keeps its fixed position AND its sort key — only its
  // cell changed: it composes the entry_kills / entry_deaths metric
  // halves (design Q2).
  // Every key here sorts CLIENT-side over the displayed sequence (the
  // fold below): the fetch is id-keyed (one GetScoreboard call per
  // match, kills DESC) and no sort ever re-requests a row order from the
  // store again. The Rnds column is gone (owner C14) — rounds played is
  // still a store column and a metric input, just no longer a column.
  const SCORE_COLS = [
    { key: 'name', label: 'Name' },
    // "Team" column: the key stays `side` but the cell shows the TEAM's
    // display name — see the body branch below.
    { key: 'side', label: 'Team' },
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'kda', label: 'KDA' },
    { key: 'total_damage', label: 'DMG' },
    // Fixed position, metric-composed cell (design Q2): both halves
    // read the fixed named slots entry_kills / entry_deaths — the
    // identical stored columns this cell used to render raw. The body
    // branch below owns the cell (value-or-dash halves, never a chip).
    { key: 'opening_kills', label: 'Opening K/D' },
    { key: 'utility_damage', label: 'Util' },
    { key: 'mvps', label: 'MVPs' },
    { key: 'score', label: 'Score' },
  ];

  // The fixed block's `short` → its SCORE_COLS entry (the composed
  // sequence's fixed entries speak metricorder's `short` headers —
  // their `label` is the full name the dialog/Reports read; this map is
  // what turns a visible fixed entry into the renderer + sort key above
  // — the ONE bridge, since metricorder.FIXED_BLOCK's `short` is this
  // list's mirror). The SCORE_COLS labels themselves never change: the
  // rendered scoreboard headers stay the shorts.
  const colByLabel = new Map(SCORE_COLS.map((c) => [c.label, c]));

  // The (0,0) descriptor: the corner cell wears the Name header's own
  // label in BOTH shapes (the transpose button rides its children slot).
  const nameCol = SCORE_COLS.find((c) => c.key === 'name');

  let match = $state(null);
  let summary = $state(null); // MatchSummary row (team names)
  let rounds = $state([]);
  let scoreboard = $state([]);
  let tab = $state('Overview');
  // THE sort chain, newest entry LAST (owner C14's minimum-swap sort):
  // every entry is folded over the sequence the previous ones produced
  // (foldRows below), so sorting a second stat never destroys the first
  // one's order — it only refines it inside its own ties, and an
  // all-tied key moves nothing at all. sortKey/desc stay DERIVED from
  // the newest entry, so the SortTh markers keep their single-mark shape.
  // Re-seeded with the id-keyed fetch (kills DESC — the store's default).
  // N4 (lead ruling): hiding K leaves this seed alone — the fold still
  // orders the rows by kills, it just shows no K column marking it (no
  // re-seed machinery for a hidden default key).
  let sortStack = $state([{ key: 'kills', desc: true }]);
  const sortKey = $derived(sortStack[sortStack.length - 1]?.key ?? '');
  const desc = $derived(sortStack[sortStack.length - 1]?.desc ?? false);

  // Selection state (the Rounds-tab compare picks below, plus the
  // scoreboard's transposed shape — owner C14) restores per match
  // through the process-scoped registry (viewstate.svelte.js): the key
  // carries the match id (matchKey), so match A's picks never show in
  // match B. App reuses this component when only the id changes
  // (no remount), so ONE combined effect both RE-SEEDS on a key change
  // and writes through otherwise — self-ordering: the write branch runs
  // only while the key is unchanged, so the old match's values can never
  // land under the new key. The TAB stays URL-owned (routeTab effect
  // below) and is never registered; busy/error/warnings stay transient.
  const selDefaults = () => ({ compareSel: [], transposed: false });
  const selKey = $derived(matchKey('selection', id));
  // Deliberate ONE-TIME init capture: the derived is read inside a closure
  // (Svelte's documented state_referenced_locally fix); the snapshot carries
  // the key so lastKey matches without a second top-level derived read.
  // The combined reseed/write-through $effect below owns every later key
  // change — URL stays the sole durable record; registry semantics unchanged.
  const selInit = () => ({ ...seed(selKey, selDefaults()), key: selKey });
  const selSeed = selInit();
  let warnings = $state(null); // null = not loaded
  // Warnings render directly (no header button): the panel is open by
  // default whenever the match has warnings, and the dismiss X hides it
  // for the rest of this mounted session.
  let warningsDismissed = $state(false);
  let error = $state('');
  // M4 header badges: voice presence + chat-decrypt key state.
  let voice = $state(null);

  // Analytics (M3): the Rounds tab's Class column left THIS view (W3a —
  // the table opens with its far-left watch column instead), so the
  // per-side buy-class read (store.GetEconomy, the canonical read the
  // Economy tab and RoundDetail's Economy card still share) is no longer
  // fetched here — only warmed through the analytics warm below.
  // The per-player KAST path (combatBySteam + its fetch + the combatError
  // panel) died with the dogfooding conversion (W2) — KAST% is a pinned
  // metric column now (the Combat tab still warms getCombatStats below).
  // Rounds-tab compare picker: round numbers (max 4).
  let compareSel = $state(selSeed.compareSel);
  // The scoreboard's transposed shape (owner C14) — registry-owned and
  // match-scoped like compareSel (the expanded/compareSel precedent):
  // a process-local view shape, never a link, so it is NOT URL state and
  // never survives as a shareable address; each match restores the shape
  // it was left in.
  let transposed = $state(selSeed.transposed);
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
      compareSel = s.compareSel;
      transposed = s.transposed;
      return;
    }
    remember(k, { compareSel, transposed });
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
  let metricCols = $state([]);
  // The W2a fixed named slots (design §6.1): the compound cells' halves
  // read these metrics BY NAME — pins-independent, unioned into the ONE
  // stored read below (an unpinned metric still fills its cell — the
  // kast precedent).
  const FIXED_SLOTS = ['assists', 'entry_kills', 'entry_deaths'];
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

  // Scoreboard fetch — ID-KEYED (owner C14): ONE GetScoreboard call per
  // match, in the store's default order (kills DESC), whatever the user
  // sorts afterwards. Sorting is a pure client-side fold over this seed
  // (viewRows below), so a sort can never discard the order a previous
  // sort built. The stack re-seeds here too: every match starts at the
  // default kills-DESC marker, so one match's sort chain can never leak
  // into the next (the pre-C14 sortKey/desc were component state and did
  // not re-seed — ruling 5).
  $effect(() => {
    id;
    sortStack = [{ key: 'kills', desc: true }];
    let live = true;
    getScoreboard(id, 'kills', true)
      .then((sb) => {
        // The ONE place this view's roster rows enter: listedPlayers
        // (lib/players.js — the canonical client-side bot filter; the
        // store already filters GetScoreboard, this is its twin) covers
        // every derivation below — the fold's seed, rosters, topStats,
        // the team_<player> names and the per-round side lookups.
        if (live) scoreboard = listedPlayers(sb) || [];
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  // --- THE sort fold (owner C14 — minimum row swaps) ------------------------
  // Each stack entry is applied to the sequence the EARLIER entries
  // produced, so a second sort refines the first instead of replacing it:
  // sort by damage, then by deaths → inside equal deaths the damage order
  // stands, and a key whose values are all tied moves nothing at all.
  // Every step decorates its rows with their incoming index and breaks
  // ties on it — the explicit "prior order wins" chain (Array#sort has
  // been stable since ES2019; Profiles.svelte's `sorted` derived cites
  // the same precedent, but an index tiebreak makes the result
  // engine-luck-free by construction instead of relying on it).
  // Rejected: writing the sorted sequence back into the seed (breaks the
  // moment late-arriving metric values change a cell) and an SQL ORDER
  // chain (the store cannot express m: metric keys at all).
  function foldRows(rows, stack) {
    let out = rows;
    for (const entry of stack) out = stableStep(out, entry);
    return out;
  }

  function stableStep(rows, entry) {
    const keyed = rows.map((p, i) => ({ p, i }));
    keyed.sort((a, b) => {
      const c = compareSort(entry.key, a.p, b.p, entry.desc);
      return c !== 0 ? c : a.i - b.i;
    });
    return keyed.map((x) => x.p);
  }

  // One comparator for every key: fixed keys map through the cell's own
  // display value (cellText), m: keys through the metric column's stored
  // value; nulls/undefined sort LAST in both directions (a gap is not a
  // zero and must not win the ascending sort by pretending to be the
  // smallest), strings through localeCompare, numbers by value.
  function compareSort(key, a, b, isDesc) {
    const va = sortValue(key, a);
    const vb = sortValue(key, b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    let c;
    if (typeof va === 'string' || typeof vb === 'string') {
      c = String(va).localeCompare(String(vb));
    } else {
      c = va < vb ? -1 : va > vb ? 1 : 0;
    }
    return isDesc ? -c : c;
  }

  function sortValue(key, p) {
    if (key.startsWith('m:')) {
      const col = metricCols.find((c) => metricSortKey(c.def.id) === key);
      // Column not landed yet → every value null → the step moves
      // nothing (what the pre-C14 "return scoreboard" did, per step).
      return col ? metricSortVal(col, p) : null;
    }
    // kda sorts as the RAW number: cellText formats it through fmt2 for
    // display, and a formatted string would sort lexicographically
    // (10.00 before 9.00).
    if (key === 'kda') return Number.isFinite(p.kda) ? p.kda : null;
    return cellText({ key }, p);
  }

  const viewRows = $derived(foldRows(scoreboard, sortStack));

  // --- M5/W6 composed columns -----------------------------------------------
  // Column-merge (N4): the ONE composed list (metricorder.
  // composedSequence) decides WHICH columns exist and in what order —
  // the fixed stats as '@'-namespaced sequence entries (hideable: a
  // hidden one drops out of the render, never out of the sequence) and
  // the pinned metrics as metric entries. Sorting never leaves the
  // client for ANY key now (the fetch is id-keyed), and a metric key
  // folds over the sequence the fixed keys already ordered; players
  // without a value for the metric sort last either way (nulls-last in
  // both directions — sortValue above).
  // render = composedSequence ∩ visibility/pins (design §1.3's
  // composition, extended): the pins still SELECT the metric columns,
  // the order pref SEQUENCES everything — the pins array's own order
  // stopped being an ordering source — and the hidden pref (metric_-
  // hidden_match) removes fixed entries from THIS view only.
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

  // sbSeq — the composed render sequence as LOOKUP ENTRIES: a visible
  // fixed entry carries its SCORE_COLS renderer ({key:'f:…', col}), a
  // pinned metric its definition ({key:'m:…', def}). It lands BEFORE
  // the stored value read, so an empty or failed metric read still
  // renders the fixed half — never a blank scoreboard.
  let sbSeq = $state([]);

  // sbCols — the sequence joined with what has landed: fixed entries
  // are complete immediately, metric entries appear when their stored
  // read returns (the honest gap stays a gap, never a guessed cell).
  const sbCols = $derived.by(() => {
    const byId = new Map(metricCols.map((mc) => [mc.def.id, mc]));
    const out = [];
    for (const s of sbSeq) {
      if (s.col) {
        out.push({ kind: 'fixed', key: s.key, col: s.col });
      } else {
        const mc = byId.get(s.def.id);
        if (mc) out.push({ kind: 'metric', key: s.key, mc });
      }
    }
    return out;
  });

  // The TRANSPOSED axis (owner C14): stat rows = the composed columns
  // minus the Name/Team descriptors — those two move INTO the player
  // column headers in transposed form (name + side chip), so no
  // redundant Name/Team rows — i.e. the same column order the normal
  // table renders (N4: one composed list now, fixed and metric alike).
  const statCols = $derived(
    sbCols.filter((c) => !(c.kind === 'fixed' && (c.col.key === 'name' || c.col.key === 'side'))),
  );

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
    // Read localStorage directly, never through a component-state mirror:
    // the stored selection is a one-shot input to this effect, so caching
    // it in state would make the effect re-trigger on every pin write.
    const stored = readPins(); // null = ABSENT → metricorder resolves DEFAULT_PINS
    metricCols = [];
    fixedCols = new Map();
    metricError = '';
    sbSeq = [];
    // The catalog read ALWAYS runs (never gated on the pins): the fixed
    // named slots above need it even when a stored selection says "pin
    // nothing" — the selection governs the COLUMNS, not these cells.
    Promise.all([
      listMetrics(),
      readOrder('match'),
      // The visibility read is presentation-only: a failed pref read
      // falls back to "nothing hidden" instead of failing the columns.
      readHidden('match').catch(() => []),
    ])
      .then(([defs, order, hiddenKeys]) => {
        if (!live) return;
        const rows = defs || [];
        // Absent key ⇒ DEFAULT_PINS resolved by name through the catalog
        // (design §1.6); present ⇒ verbatim, even '[]' — a stored "pin
        // nothing" is never overridden (and never silences the fixed
        // slots either — they are not a selection).
        const pinIds = resolvePinIds('match', stored, rows);
        const pinSet = new Set(pinIds);
        // THE composition (lib/metricorder.js — the ONE site): fixed
        // stats and metrics in one ordered entry list. A hidden fixed
        // entry drops out of THIS render (it stays in the sequence and
        // in the ordering dialog); an unpinned metric drops out too —
        // pins SELECT, the sequence ORDERS. sbSeq lands here, BEFORE
        // the value read below.
        const seq = [];
        const picked = [];
        for (const e of composedSequence('match', order, rows, hiddenKeys)) {
          if (e.kind === 'fixed') {
            if (e.hidden) continue;
            const col = colByLabel.get(e.short);
            if (col) seq.push({ key: `f:${col.key}`, col });
          } else {
            if (!pinSet.has(e.def.id)) continue;
            seq.push({ key: `m:${e.def.id}`, def: e.def });
            picked.push(e.def);
          }
        }
        sbSeq = seq;
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
  // triples) read their metrics BY NAME from `fixedCols` — pins-
  // independent (an unpinned metric still fills its cell), resolved from
  // the SAME catalog read and served by the SAME ONE stored read as the
  // pinned columns.
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

  // A column click EXTENDS the chain (newest entry last): clicking the
  // already-newest key flips its direction in place, clicking any other
  // key pushes a new refinement on top — never a reset, so the previous
  // keys keep ordering inside the new key's ties (foldRows above).
  function toggleSort(key) {
    const last = sortStack[sortStack.length - 1];
    if (last && last.key === key) sortStack = [...sortStack.slice(0, -1), { key, desc: !last.desc }];
    else sortStack = [...sortStack, { key, desc: true }];
  }

  // The transpose toggle (owner C14) lives in the (0,0) cell — the Name
  // header's children slot (the ⓘ idiom: outside the .th-sort button, so
  // name sorting stays functional). Entering: the DISPLAYED sequence
  // becomes the fold's seed and the sort stack empties — the row order is
  // retained and every column sort mark goes with it (the owner's
  // "transposing toggles off the column sorts"). Leaving flips the shape
  // only: the retained order stands, still unmarked.
  function toggleTranspose() {
    if (transposed) {
      transposed = false;
      return;
    }
    const shown = viewRows;
    scoreboard = shown;
    sortStack = [];
    transposed = true;
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

  // Rounds-tab row ▶ — ROUND-level watch, byte-identical to Economy's
  // drill() and RoundDetail's "Watch round": the round's start tick as
  // ?tick=, its OWN start→end span as ?loop= (nav.entryLoopSpan — the
  // round IS the sequence, never an event-level pad) and THIS tab as the
  // ?back= origin. No landmark filter: outside the replay, buttons seek.
  // The row-click handler ignores button targets, so the row still opens
  // the round summary beside it.
  function watchRound(n) {
    const start = roundStartTick(rounds, n);
    // An unknown end stamps NO loop rather than a guessed bound —
    // entryLoopSpan yields undefined and buildHash drops it.
    const end = roundEndTick(rounds, n);
    nav(replayHash(id, {}, { tick: start, loop: entryLoopSpan(start, end), back: backPath() }));
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

  // Team display names for the scoreline header and the roster headings:
  // the demo's clan names when the extract recorded them, else a
  // player-derived `team_<player>` name per side (see lib/teams.js).
  // These label the TEAMS (final sides) — never the sides themselves.
  const teams = $derived(
    teamNames({
      ctName: summary?.ctName || '',
      tName: summary?.tName || '',
      // viewRows, not the raw seed: every derivation here follows the
      // DISPLAYED sequence (research step 1.5), so the roster order, the
      // stat cards and the transposed player columns can never disagree
      // about which row the scoreboard is showing.
      players: viewRows,
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
    const ct = viewRows.filter((p) => p.side === 'ct');
    const t = viewRows.filter((p) => p.side === 't');
    const other = viewRows.filter((p) => p.side !== 'ct' && p.side !== 't');
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
      viewRows,
      match?.sideSwitches || 0,
      rounds,
      roundNumber,
      steamId,
      name,
    );
  }

  const topStats = $derived.by(() => {
    if (!viewRows.length) return [];
    const maxBy = (fn) => viewRows.reduce((a, b) => (fn(b) > fn(a) ? b : a));
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
      <!-- The view's help affordance (HelpButton.svelte): ONE `?` in
           the header, right of the .spacer, targeting the section of
           the tab you are on (helpSection above — per-tab, one button). -->
      <div class="spacer"></div>
      <HelpButton section={helpSection} {openDocs} />
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
      <!-- The (0,0) transpose button (owner C14): it rides the NAME
           header's children slot — the same idiom the metric ⓘ uses, so
           it sits OUTSIDE the .th-sort button and the header keeps its
           primary affordance (name sorting). It renders in BOTH shapes:
           (0,0) is the Name column header in player rows and the corner
           cell in transposed rows. -->
      {#snippet transposeBtn()}
        <button
          class="btn ghost small sb-transpose"
          title={transposed ? S.match.transposeBackTitle : S.match.transposeTitle}
          aria-label={S.match.transposeLabel}
          aria-pressed={transposed}
          onclick={toggleTranspose}
        >
          <span class="codicon codicon-arrow-swap" aria-hidden="true"></span>
        </button>
      {/snippet}
      <!-- One fixed stat cell, shared by BOTH shapes: the normal body's
           else-branch and every transposed stat row. Opening K/D is the
           fixed position, metric-composed cell (design Q2) — each half is
           the fresh entry_kills / entry_deaths number in the unchanged
           ${k}/${d} format, or the honest dash with that half's state in
           the title (never a chip inside a compound cell — invariant 9);
           everything else maps through cellText. -->
      {#snippet fixedCell(col, p)}
        {#if col.key === 'opening_kills'}
          {@const kd = openingKd(p)}
          <td class="num" title={kd.title || undefined}>{kd.text}</td>
        {:else}
          <td class="num">{cellText(col, p)}</td>
        {/if}
      {/snippet}
      <!-- One pinned metric cell, shared by BOTH shapes (design §5's
           state machine: value / honest dash / chip, never a number in
           lieu of a chip). -->
      {#snippet metricCellView(mc, p)}
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
      {/snippet}
      {#if metricError}
        <p class="error" role="alert">
          {S.match.pinnedStatsUnavailable} {metricError}
          <button class="btn small" aria-label={S.match.dismissPinnedStatsError} onclick={() => (metricError = '')}>
            <span class="codicon codicon-close"></span>
          </button>
        </p>
      {/if}
      <div class="table-scroll">
        <table class="data-table scoreboard" class:transposed>
          {#if !transposed}
          <thead>
            <tr>
              <!-- ONE composed header list (N4): the fixed stats and the
                   pinned metrics share it, in sequence order — a fixed
                   header keeps its own label/sort key, a metric header
                   keeps the width cap and the ⓘ. -->
              {#each sbCols as c (c.key)}
                {#if c.kind === 'fixed'}
                  <SortTh
                    label={c.col.label}
                    cls={c.col.title ? 'num def' : 'num'}
                    title={c.col.title || ''}
                    active={sortKey === c.col.key}
                    {desc}
                    onclick={() => toggleSort(c.col.key)}
                  >
                    <!-- The (0,0) cell carries the transpose button
                         (children slot, outside .th-sort). -->
                    {#if c.col.key === 'name'}{@render transposeBtn()}{/if}
                  </SortTh>
                {:else}
                  {@const mc = c.mc}
                  <!-- Width-constrained column header (the .m5-mth cap): THE
                       short_name display criterion — short || title || name.
                       Every other metric display (cell tooltip, Reports,
                       Builder rows, palette) reads title || name. -->
                  <SortTh
                    label={mc.def.shortName || mc.def.title || mc.def.name}
                    cls="num def m5-mth"
                    title="{mc.def.doc || mc.def.name}{mc.error ? ` — couldn’t calculate: ${mc.error}` : ''}"
                    active={sortKey === metricSortKey(mc.def.id)}
                    {desc}
                    onclick={() => toggleSort(metricSortKey(mc.def.id))}
                  >
                    <!-- The ⓘ is the header's ONLY widget now: the unpin ✕
                         left with C12 (pins are managed in the Metric
                         builder / Order dialog, never at this surface). -->
                    <span class="m5-ib" title={mc.def.doc || ''}><span class="codicon codicon-info"></span></span>
                  </SortTh>
                {/if}
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each viewRows as p (p.steamId)}
              {@const nameCls = teamCls(p.side)}
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
                {#each sbCols as c (c.key)}
                  {#if c.kind === 'metric'}
                    {@render metricCellView(c.mc, p)}
                  {:else if c.col.key === 'name'}
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
                  {:else if c.col.key === 'side'}
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
                  {:else}
                    {@render fixedCell(c.col, p)}
                  {/if}
                {/each}
              </tr>
            {/each}
          </tbody>
          {:else}
          <!-- TRANSPOSED (owner C14): a true matrix transpose — the
               players become COLUMNS in the retained viewRows order
               (ruling 1: Name/Team move INTO these headers, with the
               side chip; ruling 4: the profile link stays, a column
               header is not a row so the row-click→replay affordance
               does not), and every stat becomes a ROW in the column
               order (the ONE composed sequence — fixed stats and pinned
               metrics alike, N4).
               No sorting on the stat-label rows (ruling 2): they are
               plain row headers, never SortTh. -->
          <thead>
            <tr>
              <SortTh
                label={nameCol.label}
                cls="num"
                active={sortKey === 'name'}
                {desc}
                onclick={() => toggleSort('name')}
              >
                {@render transposeBtn()}
              </SortTh>
              {#each viewRows as p (p.steamId)}
                {@const nameCls = teamCls(p.side)}
                <th scope="col" class="sb-player">
                  <!-- The name BLOCK (W3a): one wrapper covers both name
                       shapes (the profile button and the bare name), so
                       the team chip below always drops to its own line
                       instead of riding inline after the name. The chip
                       itself stays inside the <th> (pinned — Team
                       moves INTO this header, it never leaves it). -->
                  <span class="sb-name">
                    {#if isSteam(p.steamId)}
                      <button
                        class="btn ghost small name-link {nameCls}"
                        title={S.fill(S.match.openProfilePossessive, { name: p.name })}
                        onclick={(e) => {
                          e.stopPropagation();
                          nav(`/player/${p.steamId}`);
                        }}
                        >{p.name}</button
                      >
                    {:else}
                      {p.name}
                    {/if}
                  </span>
                  <!-- The Team column's cell rides along as the side chip
                       (team display name, colored by the team's START
                       side like every other team name). -->
                  <span class="chip {nameCls}"
                    >{p.side === 'ct' ? teams.ct : p.side === 't' ? teams.t : '—'}</span
                  >
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            <!-- ONE composed stat-row list (N4): the fixed stats and the
                 pinned metrics as rows in the COLUMN order, minus the
                 Name/Team descriptors those player headers carry. -->
            {#each statCols as c (c.key)}
              <tr>
                <!-- Row header = the stat label, frozen at left:0 in the
                     transposed form (public/style.css). -->
                {#if c.kind === 'fixed'}
                  <th scope="row">{c.col.label}</th>
                  {#each viewRows as p (p.steamId)}
                    {@render fixedCell(c.col, p)}
                  {/each}
                {:else}
                  {@const mc = c.mc}
                  <th scope="row" class="def" title={mc.def.doc || mc.def.name}>
                    {mc.def.shortName || mc.def.title || mc.def.name}
                    <!-- The ⓘ is the label's widget (the column header's
                         own ⓘ idiom, outside any sort button — there is
                         none on this axis). -->
                    <span class="m5-ib" title={mc.def.doc || ''}
                      ><span class="codicon codicon-info"></span></span
                    >
                  </th>
                  {#each viewRows as p (p.steamId)}
                    {@render metricCellView(mc, p)}
                  {/each}
                {/if}
              </tr>
            {/each}
          </tbody>
          {/if}
        </table>
      </div>
    {:else if tab === 'Rounds'}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <!-- Far-left watch column (W3a): the canonical ghost ▶ cell
                   (EventPlay) — same sr-only header idiom RoundDetail's
                   kill/bomb tables use. -->
              <th scope="col"><span class="sr-only">{S.match.colWatch}</span></th>
              <th
                scope="col"
                class="num cmp-cmp-col"
                title={S.match.compareSelectTitle}
              >{S.match.colCmp}</th>
              <th scope="col" class="num">RD</th>
              <th scope="col">{S.match.colWinner}</th>
              <th scope="col">{S.match.colReason}</th>
              <th scope="col" class="num">{S.match.colDuration}</th>
              <th scope="col">{S.match.colSite}</th>
              <th scope="col">{S.match.colMvp}</th>
              <th scope="col">{S.match.firstBloodLabel}</th>
              <th scope="col" class="num">{S.match.colKills}</th>
            </tr>
          </thead>
          <tbody>
            {#each rounds as r, ri (r.number)}
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
                <td>
                  <!-- The row's own ▶ — ROUND-level stamping (watchRound
                       above); the row handler ignores button targets, so
                       the row still opens the round summary. -->
                  <EventPlay
                    tick={roundStartTick(rounds, r.number)}
                    title={S.fill(S.match.watchRoundTitle, { round: r.number })}
                    label={S.fill(S.match.watchRoundAria, { round: r.number })}
                    onclick={() => watchRound(r.number)}
                  />
                </td>
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
      <!-- Details = technicals ONLY (owner ruling, 2026-11-15): the Key
           facts panel (server, tickrate, frames, size, import, parser,
           voice, warnings, source, demo copy) + Explorer's diagnostics
           (import details, advanced diagnostics), embedded and fixed to
           THIS match — the standalone Explorer's network-message census
           is Library copy, not this match's data, so it stays out of the
           tab. Gameplay-derived facts (the first blood) live on the
           Rounds tab. Map/Duration live in the match header. -->
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
