<script>
  import { isSteam, replayHash } from '../nav.js';
  import { KAST_DEF } from '../definitions.js';
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
    previewMetric,
    subscribeJobProgress,
    errText,
  } from '../services.js';
  import {
    fmtDuration,
    fmtBytes,
    fmtDate,
    fmt1,
    fmt2,
    fmtPercent,
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
  // KAST% lives in the analytics pass (getCombatStats → kastPct), not the
  // scoreboard store — its sort is applied client-side (see viewRows).
  const SCORE_COLS = [
    { key: 'name', label: 'Name' },
    // "Team" column: the key stays `side` (the store's sort whitelist is
    // keyed by it) but the cell shows the TEAM's display name — see the
    // body branch below.
    { key: 'side', label: 'Team' },
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'assists', label: 'A' },
    { key: 'adr', label: 'ADR' },
    { key: 'kast', label: 'KAST%', title: KAST_DEF },
    { key: 'hs_pct', label: 'HS%' },
    { key: 'kd', label: 'K/D' },
    { key: 'kda', label: 'KDA' },
    { key: 'total_damage', label: 'DMG' },
    { key: 'rounds_played', label: 'Rnds' },
    // Multi-kill tiers, ascending 2K → 5K (a round counts at exactly one
    // tier — CS2.md "Multi-kill columns"). Keys are the snake_case store
    // sort keys ("two_k" is whitelisted in the Go scoreboardSort map); the
    // row field is the camelCase JSON tag (cellText: two_k → twoK).
    { key: 'two_k', label: '2K' },
    {
      key: 'three_k',
      label: '3K',
    },
    {
      key: 'four_k',
      label: '4K',
    },
    {
      key: 'five_k',
      label: '5K',
    },
    { key: 'entry_kills', label: 'Entry' },
    { key: 'trade_kills', label: 'Trade' },
    {
      key: 'opening_kills',
      label: 'Opening K/D',
      fmt: (p) => `${p.openingKills}/${p.openingDeaths}`,
    },
    { key: 'best_streak', label: 'Streak' },
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

  // Analytics (M3): per-player KAST for the scoreboard column + per-round
  // classification chips for the Rounds tab. Both are optional — failures
  // surface inline per section instead of breaking the whole match view.
  let combatBySteam = $state(new Map());
  let combatError = $state('');
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

  // localStorage contract (M5): 'spectra:pinned-metrics' holds a JSON array
  // of metric ids — written by Builder's pin toggles, read here when a
  // scoreboard renders. Ids are resolved through listMetrics() on load (a
  // deleted metric simply drops out) and each pin is previewed grouped by
  // player, scoped to this match; preview rows map group (SteamID64) → value.
  let pins = $state([]);
  let metricCols = $state([]);
  let metricError = $state('');

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

  // Scoreboard fetch: initial load + every sort change. KAST% is not a
  // store column — when it is the sort key we keep the current rows and
  // sort them client-side against combatBySteam (viewRows).
  $effect(() => {
    sortKey;
    desc;
    // kast + m:* metric columns sort client-side (viewRows) — the store
    // sort only ever runs for SCORE_COLS keys, so server ordering for
    // K/D/ADR/… stays exactly as GetScoreboard returns it.
    if (sortKey === 'kast' || sortKey.startsWith('m:')) return;
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

  // Per-player KAST% (models.CombatStat.kastPct) for the scoreboard column.
  $effect(() => {
    let live = true;
    combatError = '';
    getCombatStats(id)
      .then((rows) => {
        if (live) {
          combatBySteam = new Map((rows || []).map((r) => [r.steamId, r]));
        }
      })
      .catch((e) => {
        if (live) combatError = errText(e);
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
    if (sortKey === 'kast') return scoreboard;
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

  function kastPct(p) {
    const row = combatBySteam.get(p.steamId);
    return row && Number.isFinite(row.kastPct) ? row.kastPct : null;
  }

  // --- M5 pinned metric columns ---------------------------------------------
  // Column-merge: SCORE_COLS stays a pure store-driven set; pinned metrics
  // append as extra <th>/<td> cells rendered from their own preview map.
  // Sorting a metric key never leaves the client (the fetch effect skips
  // m:* keys), so GetScoreboard ordering for the M1/M3/M4 columns is
  // untouched; players without a value for the metric sort last either way.
  function readPins() {
    try {
      const raw = localStorage.getItem('spectra:pinned-metrics');
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return [...new Set(arr.map(Number).filter((n) => Number.isFinite(n)))];
    } catch {
      return [];
    }
  }

  function metricSortKey(metricId) {
    return `m:${metricId}`;
  }

  function metricSortVal(col, p) {
    const r = col.map.get(p.steamId);
    return r && Number.isFinite(r.value) ? r.value : null;
  }

  function columnOf(def, pv) {
    const rows = (pv && pv.rows) || [];
    let totalN = 0;
    for (const r of rows) totalN += r.n || 0;
    return { def, rows, map: new Map(rows.map((r) => [r.group, r])), error: '', totalN };
  }

  $effect(() => {
    id;
    let live = true;
    // Read localStorage directly — reading the `pins` state here would make
    // it a dependency of this effect and re-trigger it on every pin write.
    const pinIds = readPins();
    pins = pinIds;
    metricCols = [];
    metricError = '';
    if (pinIds.length === 0) return;
    listMetrics()
      .then((defs) => {
        const byId = new Map((defs || []).map((d) => [d.id, d]));
        const picked = pinIds.map((pid) => byId.get(pid)).filter(Boolean);
        return Promise.all(
          picked.map((def) =>
            previewMetric(def.id, '', 'player', `match:${id}`, 200)
              .then((pv) => columnOf(def, pv))
              .catch((e) => ({
                def,
                rows: [],
                map: new Map(),
                error: errText(e),
                totalN: 0,
              })),
          ),
        );
      })
      .then((cols) => {
        if (live) metricCols = cols;
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
    if (mc.error) return null;
    return mc.map.get(p.steamId) || null;
  }

  function metricCellText(mc, p) {
    const r = metricCell(mc, p);
    if (!r) return '—';
    return fmtMetric(r.value, mc.def.format);
  }

  function metricCellTitle(mc, p) {
    if (mc.error) return mc.error;
    const r = metricCell(mc, p);
    if (!r) return 'no data for this player';
    return `${mc.def.title || mc.def.name} — sample size n=${r.n}`;
  }

  function toggleSort(key) {
    if (sortKey === key) desc = !desc;
    else {
      sortKey = key;
      desc = true;
    }
    expanded = 0;
  }

  // Cell display for a scoreboard column: custom fmt wins, else map the
  // snake_case sort key onto the row's camelCase field with formatting.
  function cellText(col, p) {
    if (col.fmt) return col.fmt(p);
    const field = col.key.replace(/_(\w)/g, (_, c) => c.toUpperCase());
    switch (col.key) {
      case 'adr':
        return fmt1(p.adr);
      case 'kast': {
        const v = kastPct(p);
        return v == null ? '—' : fmtPercent(v);
      }
      case 'hs_pct':
        return fmtPercent(p.hsPct);
      case 'kd':
        return fmt2(p.kd);
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
      <button class="btn small" aria-label="Dismiss error" onclick={() => (error = '')}>
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
              ? 'Return to the replay (resumes where you left it)'
              : 'Watch this match in the replay view'}
            onclick={openReplay}
          >
            <span class="codicon codicon-play" aria-hidden="true"></span> Watch replay
          </button>
          {match.map || '—'}
          · {fmtDuration(match.playbackTimeS)}
          · patch {fmtPatch(match.patchVersion)}
          · <StatusChip status={match.status || 'ready'} title={match.error || ''} />
          {#if voice && !voice.keyFound && (match.encryptedMessages || 0) > 0}
            <span
              class="chip voice-badge idle"
              title="Encrypted chat present — needs the matching .dem.info file to read it"
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
          <h2>Import warnings</h2>
          <button class="btn small" aria-label="Dismiss warnings" onclick={() => (warningsDismissed = true)}>
            <span class="codicon codicon-close"></span>
          </button>
        </div>
        {#if warnings == null}
          <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
        {:else if warnings.length === 0}
          <p class="muted" role="status">None — this demo imported cleanly.</p>
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

    <nav class="tabs" aria-label="Match sections">
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
            title="Open the replay following {s.p.name}"
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
                title="Open {s.p.name} profile"
              />
            {/snippet}
          </StatCard>
        {/each}
      </div>

      <!-- Roster rows: K/D/A and ADR are event-derived for EVERY player
           (extract's applyFinal never overwrites them — one convention per
           player, see internal/extract/agg.go), so there is no
           snapshot-vs-events distinction left to mark on this tab. The old
           "derived" chip + row dim keyed on finalStatePresent advertised a
           retired M1 assumption and mislabeled exact event counts as
           guesses; finalStatePresent stays in the data model as provenance
           for the snapshot-only identity fields (score, ping, crosshair…). -->
      <div class="roster-grid">
        <section class="panel">
          <h2 class={teamCls('ct')}>{teams.ct} roster</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" class="num">K/D/A</th>
                <th scope="col" class="num">ADR</th>
              </tr>
            </thead>
            <tbody>
              {#each rosters.ct as p (p.steamId)}
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
                      title="Open {p.name} profile"
                    />
                  </td>
                  <td class="num">{p.kills}/{p.deaths}/{p.assists}</td>
                  <td class="num"><span class="chip adr">{fmt1(p.adr)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
        <section class="panel">
          <h2 class={teamCls('t')}>{teams.t} roster</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" class="num">K/D/A</th>
                <th scope="col" class="num">ADR</th>
              </tr>
            </thead>
            <tbody>
              {#each rosters.t as p (p.steamId)}
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
                      title="Open {p.name} profile"
                    />
                  </td>
                  <td class="num">{p.kills}/{p.deaths}/{p.assists}</td>
                  <td class="num"><span class="chip adr">{fmt1(p.adr)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if rosters.other.length > 0}
            <h2>Other</h2>
            <table class="data-table">
              <tbody>
                {#each rosters.other as p (p.steamId)}
                  <tr
                    class="clickable"
                    onclick={(e) => {
                      if (e.target instanceof Element && e.target.closest('button, input, a'))
                        return;
                      openPlayerEvents(p.steamId, { follow: true });
                    }}
                  >
                    <td>
                      <ProfileLink steam={p.steamId} name={p.name} {nav} title="Open {p.name} profile" />
                    </td>
                    <td class="num">{p.kills}/{p.deaths}/{p.assists}</td>
                    <td class="num"><span class="chip adr">{fmt1(p.adr)}</span></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
      </div>
    {:else if tab === 'Scoreboard'}
      {#if combatError}
        <p class="error" role="alert">
          KAST% unavailable: {combatError}
          <button class="btn small" aria-label="Dismiss KAST% error" onclick={() => (combatError = '')}>
            <span class="codicon codicon-close"></span>
          </button>
        </p>
      {/if}
      {#if metricError}
        <p class="error" role="alert">
          Pinned stats unavailable: {metricError}
          <button class="btn small" aria-label="Dismiss pinned stats error" onclick={() => (metricError = '')}>
            <span class="codicon codicon-close"></span>
          </button>
        </p>
      {/if}
      <div class="table-scroll">
        <table class="data-table scoreboard">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">Expand</span></th>
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
                  <span
                    class="m5-n"
                    title="based on {mc.totalN} rounds across {mc.rows.length} players"
                    >({fmtInt(mc.totalN)})</span
                  >
                  <button
                    class="m5-unpin"
                    title="Unpin from scoreboard"
                    aria-label="Unpin {mc.def.title || mc.def.name}"
                    onclick={() => unpin(mc.def.id)}><span class="codicon codicon-close"></span></button
                  >
                </SortTh>
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
                <td class="expand-cell" onclick={(e) => e.stopPropagation()}>
                  <button
                    class="btn small ghost"
                    aria-label="Breakdown for {p.name}"
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
                          title="Open {p.name}'s profile"
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
                  {:else}
                    <td class="num">{cellText(col, p)}</td>
                  {/if}
                {/each}
                {#each metricCols as mc (mc.def.id)}
                  <td class="num m5-cell" title={metricCellTitle(mc, p)}
                    >{metricCellText(mc, p)}</td
                  >
                {/each}
              </tr>
              {#if expanded === p.steamId}
                <tr class="expand-row">
                  <td colspan={SCORE_COLS.length + 1 + metricCols.length}>
                    <div class="weapon-grid util-grid">
                      <div>
                        <h3>Kills by weapon</h3>
                        <table class="data-table mini">
                          <thead>
                            <tr><th scope="col">Weapon</th><th scope="col" class="num">Kills</th></tr>
                          </thead>
                          <tbody>
                            {#each weaponEntries(p.killsByWeapon) as [w, n] (w)}
                              <tr><td>{w}</td><td class="num">{n}</td></tr>
                            {:else}
                              <tr><td colspan="2" class="muted">None recorded</td></tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                      <div>
                        <h3>Damage by weapon</h3>
                        <table class="data-table mini">
                          <thead>
                            <tr><th scope="col">Weapon</th><th scope="col" class="num">Damage</th></tr>
                          </thead>
                          <tbody>
                            {#each weaponEntries(p.damageByWeapon) as [w, n] (w)}
                              <tr><td>{w}</td><td class="num">{n}</td></tr>
                            {:else}
                              <tr><td colspan="2" class="muted">None recorded</td></tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                      <!-- Utility usage: read-only columns the scoreboard
                           row already carries (store GetScoreboard SELECT). -->
                      <div>
                        <h3>Utility</h3>
                        <table class="data-table mini">
                          <thead>
                            <tr><th scope="col">Stat</th><th scope="col" class="num">Value</th></tr>
                          </thead>
                          <tbody>
                            <tr><td>Utility damage</td><td class="num">{p.utilityDamage}</td></tr>
                            <tr><td>Enemies flashed</td><td class="num">{p.enemiesFlashed}</td></tr>
                            <tr><td>Flash assists</td><td class="num">{p.flashAssists}</td></tr>
                            <tr><td>Times flashed</td><td class="num">{p.flashedTimes}</td></tr>
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
          Round types unavailable: {classError}
          <button class="btn small" aria-label="Dismiss round types error" onclick={() => (classError = '')}>
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
                title="Select rounds to compare (up to 4)"
              >Cmp</th>
              <th scope="col" class="num">RD</th>
              <th scope="col">Winner</th>
              <th
                scope="col"
                class="def"
                title="Buy type (pistol/anti-eco/eco/force/full/bonus/save) with the rule text and rules version — hover a chip"
              >Class</th>
              <th scope="col">Reason</th>
              <th scope="col" class="num">Duration</th>
              <th scope="col">Site</th>
              <th scope="col">MVP</th>
              <th scope="col" class="num">Equip CT</th>
              <th scope="col" class="num">Equip T</th>
              <th scope="col">First blood</th>
              <th scope="col" class="num">Kills</th>
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
                    aria-label="Compare round {roundIndexLabel(r)}"
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
                      title="{cls.explanation || 'classified'} (rules v{cls.ruleVersion} — {Math.round((cls.confidence || 0) * 100)}% sure)"
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
                      title="Open {r.mvpName} profile"
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
                      title="Open {r.firstKillName} profile"
                    />
                    killed
                    <ProfileLink
                      steam={r.firstDeathSteam}
                      name={r.firstDeathName}
                      {nav}
                      cls={playerRoundCls(r.number, r.firstDeathSteam, r.firstDeathName)}
                      title="Open {r.firstDeathName} profile"
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
          {compareSel.length} of 4 rounds selected.
        </p>
      {/if}
      {#if compareSel.length >= 2}
        <button class="btn primary cmp-float" onclick={goCompare}>
          Compare {compareSel.length} rounds <span class="codicon codicon-chevron-right"></span>
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
        <h2>Key facts</h2>
        <dl class="facts">
          <div><dt>Server</dt><dd>{match.serverName || '—'}</dd></div>
          <div><dt>Tickrate</dt><dd>{fmt1(match.tickRate)} Hz</dd></div>
          <div><dt>Frames</dt><dd class="num">{fmtInt(match.frames)}</dd></div>
          <div><dt>Size</dt><dd>{fmtBytes(match.size)}</dd></div>
          <div><dt>Imported</dt><dd>{fmtDate(match.extractedAt)}</dd></div>
          <div><dt>Parser</dt><dd class="mono">{match.parserVersion || '—'}</dd></div>
          <div>
            <dt>Voice</dt>
            <dd>
              {#if !voice}
                <span class="muted">—</span>
              {:else if voice.hasVoice}
                <span
                  class="chip voice-badge busy"
                  title="Voice recorded for {voice.playerCount} players — Opus, played back live"
                  ><span class="codicon codicon-unmute"></span>
                  {voice.playerCount} players · voice recorded</span
                >
              {:else}
                <span
                  class="chip voice-badge idle"
                  title="This demo source does not record voice (e.g. Valve MM) — normal, not broken"
                  >no voice</span
                >
              {/if}
            </dd>
          </div>
          <div><dt>Warnings</dt><dd>{match.warningsCount}</dd></div>
          {#if firstBlood}
            <div>
              <dt>First blood</dt>
              <dd>
                <ProfileLink
                  steam={firstBlood.killSteam}
                  name={firstBlood.kill}
                  {nav}
                  cls={playerRoundCls(firstBlood.number, firstBlood.killSteam, firstBlood.kill)}
                  title="Open {firstBlood.kill} profile"
                />
                killed
                <ProfileLink
                  steam={firstBlood.deathSteam}
                  name={firstBlood.death}
                  {nav}
                  cls={playerRoundCls(firstBlood.number, firstBlood.deathSteam, firstBlood.death)}
                  title="Open {firstBlood.death} profile"
                />
                ({firstBlood.number >= 1 ? `RD${firstBlood.number}` : roundIndexLabel(firstBlood.number)})
              </dd>
            </div>
          {/if}
          <div class="fact-wide"><dt>Source</dt><dd class="mono">{match.path}</dd></div>
          <!-- State line under Source: which demo file Re-parse would read
               right now (copyState is fs-derived by Go on this read —
               store never fills it). -->
          <div class="fact-wide">
            <dt>Demo copy</dt>
            <dd>
              {#if match.copyState === 'copied'}
                <span>copy · {fmtBytes(match.size)}</span>
                <button
                  class="btn small"
                  disabled={copyBusy}
                  title="Free the disk space Spectra’s copy uses — your original file is not touched"
                  onclick={onFreeCopy}>{copyBusy ? 'Freeing…' : 'Free copy'}</button
                >
              {:else if match.copyState === 'external'}
                <span class="muted">no copy — using your file</span>
              {:else if match.copyState === 'missing'}
                <span class="muted">file not found</span>
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
