<script>
  import { nextSort } from '../sortstate.js';
  import * as S from '../strings/index.js';
  // Profiles: the sidebar's player directory — every player in the
  // library, searchable by name, one click away from the
  // canonical player profile. Rows come from the one player-list service
  // (listPlayers('') — the same source PlayerProfile's picker and the
  // command palette use); the search is a client-side filter over that
  // fetched list AND offers the same suggestion rows (SuggestInput) the
  // profile finder does — picking one opens the profile straight away.
  // A row only navigates when its id is a well-formed
  // 17-digit Steam id (isSteam — bots/rows without one are inert).
  // The TABLE is sortable on every column and defaults to matches DESC
  // (owner ruling: a player seen in many matches is the common case in a
import { plural } from '../fmt.js';
  // single-player import list, so they sit on top). The ADR AND Matches
  // columns are metric-backed: they read the stored `career_adr` /
  // `career_matches` metric rows (the canonical career read, ONE batched
  // read for the whole list) — `player_career` holds raw counts only, so
  // the player list read carries neither number.
  import {
    listPlayers,
    listMetrics,
    getMetricValuesForPlayer,
    getMetricComputeState,
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
  import { isSteam, openProfile } from '../nav.js';
  import { fmtMetric } from '../fmt.js';
  import { listedPlayers } from '../players.js';
  import SuggestInput from '../components/SuggestInput.svelte';
  import { openRow } from '../keys.js';
  import SortTh from '../components/SortTh.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import { seed, remember } from '../viewstate.svelte.js';
  import { createLoadState } from '../loadstate.svelte.js';
  import LoadBox from '../components/LoadBox.svelte';

  let { nav = () => {} } = $props();

  let players = $state([]);
  // The list’s load: the first load shows the spinner; a refresh keeps the list on screen.
  const load = createLoadState();
  let error = $state('');
  // The search box is view-local state: it restores across navigation
  // through the process-scoped registry (viewstate.svelte.js — flat key;
  // the table sort below stays view-local too but is NOT registered —
  // only the search is in scope for restore).
  const profSeed = seed('profiles', { query: '' });
  let query = $state(profSeed.query);
  $effect(() => remember('profiles', { query }));

  // The one list read (mount AND error's Retry): loading goes back up
  // for the flight so the panel shows "Loading players…" — never a
  // false "No players yet" — and the error clears only on success.
  let playersGen = 0;
  function loadPlayers() {
    const my = ++playersGen;
    error = '';
    load.track(listPlayers(''))
      .then((rows) => {
        if (my !== playersGen) return;
        players = listedPlayers(rows) || [];
        error = '';
      })
      .catch((e) => {
        if (my !== playersGen) return;
        error = errText(e);
      });
  }

  $effect(() => {
    loadPlayers();
  });

  // --- The ADR AND Matches columns read the STORED career metric rows --
  // both columns are metrics now (the owner ruling of 2026-11-17: the
  // metrics system IS the gameplay-statistics layer) — `career_adr` for
  // ADR, `career_matches` for Matches, each resolved by NAME through the
  // catalog and served by ONE batched getMetricValuesForPlayer('',
  // [ids]) read for the WHOLE list (the career bucket returns every
  // player's row; never per-player calls), split into a steamId → row map
  // per metric. Every cell then renders through lib/metricstate.js — the
  // same five-word state machine every other metric value slot uses:
  // fresh → the value, no fresh row → '—' (a gap is never a fabricated
  // 0), anything else → the state chip. The list read itself carries no
  // ADR column and no honest matches substitute: `player_career` holds
  // raw counts only, so a metric with no seed row never falls back to a
  // raw field.
  // Refetched on spectra:metric-done (the sweep's outcome replaced the
  // rows the read cache already flushed).
  let adrMetric = $state(null); // the resolved definition (null = not in the catalog)
  let adrRows = $state(new Map()); // steamId → the fresh stored row
  let adrHasRows = $state(false); // unit coverage: does this metric have ANY row?
  let matchesMetric = $state(null); // …the `career_matches` twin
  let matchesRows = $state(new Map());
  let matchesHasRows = $state(false);
  let adrStates = $state(new Map()); // metricId → {state, error}
  let adrProgress = $state(new Map()); // metricId → the live k/N feed
  let adrError = $state('');
  let adrReload = $state(0);

  $effect(() => subscribeMetricProgress((snap) => (adrProgress = snap)));
  $effect(() => onMetricDone(() => (adrReload += 1)));

  $effect(() => {
    adrReload; // spectra:metric-done → refetch (the cache flushed)
    let live = true;
    adrMetric = null;
    adrRows = new Map();
    adrHasRows = false;
    matchesMetric = null;
    matchesRows = new Map();
    matchesHasRows = false;
    adrStates = new Map();
    adrError = '';
    Promise.all([listMetrics(), getMetricComputeState()])
      .then(([defs, states]) => {
        if (!live) return null;
        const rows = defs || [];
        const bySeed = (name) =>
          rows.find((d) => d && d.name === name && (d.scope || 'match') === 'profile') || null;
        const adrDef = bySeed('career_adr');
        const matchesDef = bySeed('career_matches');
        adrStates = new Map((states || []).map((s) => [s.metricId, s]));
        const wanted = [adrDef, matchesDef].filter(Boolean);
        // Neither seed in the catalog → every cell renders '—' (a
        // definition gone is not an error, and never a raw fallback).
        if (!wanted.length) return null;
        return getMetricValuesForPlayer('', wanted.map((d) => d.id)).then((values) => ({
          adrDef,
          matchesDef,
          values,
        }));
      })
      .then((res) => {
        if (!live || !res) return;
        // Key by subject key but keep only EACH metric's own rows: the
        // read is already narrowed server-side, and filtering here keeps
        // the maps honest if a read ever returns a wider set.
        const split = (def) => {
          const bySteam = new Map();
          if (!def) return bySteam;
          for (const v of res.values || []) {
            if (v.metricId === def.id) bySteam.set(v.subjectKey, v);
          }
          return bySteam;
        };
        const adrBySteam = split(res.adrDef);
        const matchesBySteam = split(res.matchesDef);
        adrMetric = res.adrDef;
        adrRows = adrBySteam;
        adrHasRows = adrBySteam.size > 0;
        matchesMetric = res.matchesDef;
        matchesRows = matchesBySteam;
        matchesHasRows = matchesBySteam.size > 0;
      })
      .catch((e) => {
        if (live) adrError = errText(e);
      });
    return () => (live = false);
  });

  // The ADR sort key: the stored metric value, or null for a gap (the
  // sort below keeps nulls last in both directions).
  function adrValue(p) {
    const row = adrRows.get(p.steamId);
    return row ? row.value : null;
  }

  // THE state machine for one ADR cell (lib/metricstate.js — design §5).
  function adrPres(p) {
    const st = liveMetricState(adrProgress, adrStates, adrMetric ? adrMetric.id : undefined);
    return metricPresentation(st, adrRows.get(p.steamId) || null, adrHasRows);
  }

  function adrTitle(pres) {
    if (pres.kind === 'value') return `${(adrMetric && adrMetric.title) || 'ADR'}`;
    if (pres.kind === 'nodata') return 'no data for this player';
    return metricStateTitle(pres.state, adrError);
  }

  // The Matches column's twins over `career_matches` — the same state
  // machine, the same read, the seed's OWN `doc` as the value tooltip
  // (the Formula is the tooltip medium the tiering rule measures
  // wholesale — a seeded cell documents itself exactly like a metric
  // cell's header), falling back to the title when the
  // definition carries no doc.
  function matchesPres(p) {
    const st = liveMetricState(adrProgress, adrStates, matchesMetric ? matchesMetric.id : undefined);
    return metricPresentation(st, matchesRows.get(p.steamId) || null, matchesHasRows);
  }

  function matchesTitle(pres) {
    if (pres.kind === 'value') {
      if (matchesMetric && matchesMetric.doc) return matchesMetric.doc;
      return `${(matchesMetric && matchesMetric.title) || 'Matches'}`;
    }
    if (pres.kind === 'nodata') return 'no data for this player';
    return metricStateTitle(pres.state, adrError);
  }

  // Client-side name filter (case-insensitive; an empty query keeps the
  // fetched list as-is). The order here is only the FILTER's — the table
  // renders `sorted` below (matches DESC by default), while the search
  // box's SuggestInput keeps `players` in the service order.
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return players;
    return players.filter((p) => (p.name || '').toLowerCase().includes(q));
  });

  // Sortable columns (SortTh): the first click on a header applies that
  // column's NATURAL direction from this map — newest/largest first for
  // dates and counts, A→Z for the player name — never a blanket
  // `desc: true` (which would make the first click on Player read Z→A).
  // The table's own default state below is matches DESC (the ruling).
  const SORT_DEFAULT_DESC = {
    name: false,
    matches: true,
    adr: true,
    lastSeen: true,
  };
  let sortKey = $state('matches');
  let desc = $state(true);

  // Search first, THEN sort: `filtered` narrows the fetched list and the
  // sort orders what survives it. Sort semantics per column — Player →
  // p.name (localeCompare; an empty name '' sorts first ascending and
  // renders '—'), Matches → p.matches numeric — SORTING IS NOT DISPLAY,
  // the same deliberate decision the scoreboard's raw-field sort rests
  // on: the CELL renders the stored `career_matches` row while the ORDER
  // keeps the list read's own count, so the default DESC order holds
  // before the metric read lands and for a player whose seed row is a
  // gap, ADR → the STORED
  // `career_adr` metric value for that player (adrValue — never the
  // fmt1 string in the cell; the player list read carries no ADR at all,
  // since `player_career` holds raw counts only), the import-date column
  // (field `lastSeen`, header "Last import") → p.lastSeen string compare
  // (zero-padded YYYY-MM-DD, so lexicographic = chronological; '' renders
  // '—').
  //
  // A player with NO fresh ADR row sorts LAST in both directions: a gap
  // is not a zero, so it must not win the ascending sort by pretending
  // to be the smallest value.
  //
  // Ties are the SERVICE's order: Array#sort is stable (ES2019) over a
  // copy of the service-ordered array, so equal values fall back to
  // last-seen DESC then steam_id ASC — today's `ORDER BY 4 DESC,
  // c.steam_id ASC` in store.ListPlayers (internal/store/analytics.go).
  // The sort is view-local on purpose: `players` itself is NEVER
  // reordered — the SuggestInput above and every other listPlayers
  // consumer keep the service order.
  const sorted = $derived.by(() => {
    const key = sortKey;
    const direction = desc;
    const rows = [...filtered];
    rows.sort((a, b) => {
      const av = key === 'adr' ? adrValue(a) : a[key];
      const bv = key === 'adr' ? adrValue(b) : b[key];
      let c;
      if (typeof av === 'string' || typeof bv === 'string') {
        c = String(av ?? '').localeCompare(String(bv ?? ''));
      } else if (av == null || bv == null) {
        if (av == null && bv == null) return 0; // both gaps: keep the service order
        return av == null ? 1 : -1; // gaps last, whichever way the sort points
      } else {
        c = av - bv;
      }
      return direction ? -c : c;
    });
    return rows;
  });

  // First click on an inactive header → the column's natural direction;
  // a second click on the ACTIVE header flips it.
  function toggleSort(key) {
    const next = nextSort({ key: sortKey, desc }, key, SORT_DEFAULT_DESC);
    sortKey = next.key;
    desc = next.desc;
  }

  // Part-2 honesty: this column's value is the IMPORT date of the
  // player's most recent match (CS2 demos record no played time — see
  // CS2.md's played-at entry), never a "saw them playing" timestamp.
  // It doubles as SortTh's `title`, so it keeps the "Sort by" prefix the
  // component would otherwise default to.
  const LAST_IMPORT_TITLE =
    'Sort by Last import — the import date of this player’s most recent match (CS2 demos carry no played time)';

  function fmtLastSeen(p) {
    return p.lastSeen || '—';
  }
</script>

<div class="view">
  <header class="view-header">
    <h1>{S.profiles.title}</h1>
    <span class="muted">{S.profiles.subtitle}</span>
  </header>

  <div class="toolbar pf-toolbar">
    <SuggestInput
      onerror={(e) => (adrError = errText(e))}
      id="pf-search"
      wrapClass="pf-search"
      ariaLabel="Search players"
      items={players}
      kind="player"
      align="start"
      bind:value={query}
      onselect={(p) => {
        if (isSteam(p.steamId)) openProfile(nav, p.steamId);
      }}
    />
    <span class="muted pf-count" role="status">
      {filtered.length} of {players.length}{S.profiles.playerSuffix}{plural(players.length)}
    </span>
  </div>

  {#if error}
    <p class="error" role="alert">
      {error}
      <button class="btn small" onclick={loadPlayers}>{S.profiles.retry}</button>
    </p>
  {/if}

  {#if adrError}
    <!-- The metric read failing is UNKNOWN, not "no data": the alert
         carries it (the cells keep rendering their honest state). -->
    <p class="error" role="alert">
      {S.profiles.adrErrorLead}{adrError}
      <button class="btn small" aria-label={S.profiles.dismissAdrError} onclick={() => (adrError = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {/if}

  <LoadBox tag="section" class="panel" busy={load.busy} key={load.key} name="view:profiles">
    {#if players.length === 0}
      {#if !error}
        <!-- Gated on error: a failed list read is UNKNOWN, never "no
             players yet" — the alert above carries the failure. -->
        <div class="empty">
          <p class="empty-title" role="status">{S.profiles.noPlayers}</p>
          <p class="muted">{S.profiles.noPlayersHint}</p>
        </div>
      {/if}
    {:else if filtered.length === 0}
      <div class="empty">
        <p class="empty-title" role="status">{S.profiles.noMatchPrefix}{query.trim()}”</p>
        <p class="muted">{S.profiles.tryDifferentName}</p>
      </div>
    {:else}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <SortTh label={S.profiles.thPlayer} active={sortKey === 'name'} {desc} onclick={() => toggleSort('name')} />
              <SortTh label={S.profiles.thMatches} cls="num" active={sortKey === 'matches'} {desc} onclick={() => toggleSort('matches')} />
              <SortTh label={S.profiles.thAdr} cls="num" active={sortKey === 'adr'} {desc} onclick={() => toggleSort('adr')} />
              <SortTh
                label={S.profiles.thLastImport}
                title={LAST_IMPORT_TITLE}
                active={sortKey === 'lastSeen'}
                {desc}
                onclick={() => toggleSort('lastSeen')}
              />
            </tr>
          </thead>
          <tbody>
            {#each sorted as p (p.steamId)}
              {@const pres = adrPres(p)}
              {@const mp = matchesPres(p)}
              <tr
                class:clickable={isSteam(p.steamId)}
                title={isSteam(p.steamId) ? `Open ${p.name || p.steamId}’s profile` : p.steamId}
                {...(isSteam(p.steamId) ? openRow(() => openProfile(nav, p.steamId)) : {})}
                tabindex={isSteam(p.steamId) ? 0 : undefined}
              >
                <td>
                  <span class="pf-name">{p.name || '—'}</span>
                  <span class="muted mono pf-steam">{p.steamId}</span>
                </td>
                <!-- The stored `career_matches` metric row, through the
                     same state machine as ADR: fresh → the value, no
                     fresh row → '—', otherwise the state chip (never a
                     fabricated 0, never the list read's raw count — a
                     missing seed row is a gap, not a number). -->
                <td class="num" title={matchesTitle(mp)}>
                  {#if mp.kind === 'value'}
                    {fmtMetric(mp.value, matchesMetric ? matchesMetric.format : 'int')}
                  {:else if mp.kind === 'nodata'}
                    —
                  {:else}
                    <StatusChip
                      status={mp.state}
                      title={matchesTitle(mp)}
                      progress={metricProgressFrac(adrProgress, matchesMetric ? matchesMetric.id : undefined)}
                      stage={metricProgressStage(adrProgress, matchesMetric ? matchesMetric.id : undefined)}
                    />
                  {/if}
                </td>
                <!-- The stored `career_adr` metric row, through the one
                     state machine: fresh → the value, no fresh row → '—',
                     otherwise the state chip (never a fabricated 0). -->
                <td class="num" title={adrTitle(pres)}>
                  {#if pres.kind === 'value'}
                    {fmtMetric(pres.value, adrMetric ? adrMetric.format : 'float1')}
                  {:else if pres.kind === 'nodata'}
                    —
                  {:else}
                    <StatusChip
                      status={pres.state}
                      title={adrTitle(pres)}
                      progress={metricProgressFrac(adrProgress, adrMetric ? adrMetric.id : undefined)}
                      stage={metricProgressStage(adrProgress, adrMetric ? adrMetric.id : undefined)}
                    />
                  {/if}
                </td>
                <td>{fmtLastSeen(p)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </LoadBox>
</div>
