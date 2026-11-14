<script>
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
  // single-player import list, so they sit on top). The ADR column is
  // metric-backed (dogfooding W3): it reads the stored `career_adr`
  // career-bucket rows, never ListPlayers' adr_avg.
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
  import SortTh from '../components/SortTh.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import { seed, remember } from '../viewstate.svelte.js';

  let { nav = () => {} } = $props();

  let players = $state([]);
  let loading = $state(true);
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
    loading = true;
    error = '';
    listPlayers('')
      .then((rows) => {
        if (my !== playersGen) return;
        players = listedPlayers(rows) || [];
        loading = false;
        error = '';
      })
      .catch((e) => {
        if (my !== playersGen) return;
        error = errText(e);
        loading = false;
      });
  }

  $effect(() => {
    loadPlayers();
  });

  // --- The ADR column reads the STORED career metric row --------------
  // dogfooding design §3.5: the list's ADR is the `career_adr` metric
  // (D2), not ListPlayers' adr_avg — ONE batched
  // getMetricValuesForPlayer('', [career_adr]) read for the WHOLE list
  // (the career bucket returns every player's row; never per-player
  // calls), merged into a steamId → row map. Every cell then renders
  // through lib/metricstate.js — the same five-word state machine every
  // other metric value slot uses: fresh → the value, no fresh row → '—'
  // (a gap is never a fabricated 0), anything else → the state chip.
  // Refetched on spectra:metric-done (the sweep's outcome replaced the
  // rows the read cache already flushed).
  let adrMetric = $state(null); // the resolved definition (null = not in the catalog)
  let adrRows = $state(new Map()); // steamId → the fresh stored row
  let adrHasRows = $state(false); // unit coverage: does this metric have ANY row?
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
    adrStates = new Map();
    adrError = '';
    Promise.all([listMetrics(), getMetricComputeState()])
      .then(([defs, states]) => {
        if (!live) return null;
        const rows = defs || [];
        const def = rows.find((d) => d && d.name === 'career_adr' && (d.scope || 'match') === 'profile');
        adrStates = new Map((states || []).map((s) => [s.metricId, s]));
        if (!def) return null; // definition gone → every cell renders '—'
        return getMetricValuesForPlayer('', [def.id]).then((values) => ({ def, values }));
      })
      .then((res) => {
        if (!live || !res) return;
        // Key by steam id but keep only THIS metric's rows: the read is
        // already narrowed server-side, and filtering here keeps the
        // map honest if a read ever returns a wider set.
        const bySteam = new Map();
        for (const v of res.values || []) {
          if (v.metricId === res.def.id) bySteam.set(v.steamId, v);
        }
        adrMetric = res.def;
        adrRows = bySteam;
        adrHasRows = bySteam.size > 0;
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
    if (pres.kind === 'value') return `${(adrMetric && adrMetric.title) || 'ADR'} — sample size n=${pres.n}`;
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
  // renders '—'), Matches → p.matches numeric, ADR → the STORED
  // `career_adr` metric value for that player (adrValue — never the
  // fmt1 string in the cell, and never ListPlayers' adr_avg, which this
  // column stopped reading in dogfooding W3), the import-date column
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
    if (sortKey === key) desc = !desc;
    else {
      sortKey = key;
      desc = !!SORT_DEFAULT_DESC[key];
    }
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
    <h1>Profiles</h1>
    <span class="muted">Every player in the library — click a row for their profile.</span>
  </header>

  <div class="toolbar pf-toolbar">
    <SuggestInput
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
      {filtered.length} of {players.length} player{players.length === 1 ? '' : 's'}
    </span>
  </div>

  {#if error}
    <p class="error" role="alert">
      {error}
      <button class="btn small" onclick={loadPlayers}>Retry</button>
    </p>
  {/if}

  {#if adrError}
    <!-- The metric read failing is UNKNOWN, not "no data": the alert
         carries it (the cells keep rendering their honest state). -->
    <p class="error" role="alert">
      ADR unavailable: {adrError}
      <button class="btn small" aria-label="Dismiss ADR error" onclick={() => (adrError = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {/if}

  <section class="panel">
    {#if loading}
      <p class="muted" role="status"><StatusChip block detail="Loading players…" /></p>
    {:else if players.length === 0}
      {#if !error}
        <!-- Gated on error: a failed list read is UNKNOWN, never "no
             players yet" — the alert above carries the failure. -->
        <div class="empty">
          <p class="empty-title" role="status">No players yet</p>
          <p class="muted">Players appear here once matches are imported.</p>
        </div>
      {/if}
    {:else if filtered.length === 0}
      <div class="empty">
        <p class="empty-title" role="status">No players match “{query.trim()}”</p>
        <p class="muted">Try a different name.</p>
      </div>
    {:else}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <SortTh label="Player" active={sortKey === 'name'} {desc} onclick={() => toggleSort('name')} />
              <SortTh label="Matches" cls="num" active={sortKey === 'matches'} {desc} onclick={() => toggleSort('matches')} />
              <SortTh label="ADR" cls="num" active={sortKey === 'adr'} {desc} onclick={() => toggleSort('adr')} />
              <SortTh
                label="Last import"
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
              <tr
                class:clickable={isSteam(p.steamId)}
                title={isSteam(p.steamId) ? `Open ${p.name || p.steamId}’s profile` : p.steamId}
                onclick={isSteam(p.steamId) ? () => openProfile(nav, p.steamId) : undefined}
                onkeydown={isSteam(p.steamId)
                  ? (e) => e.key === 'Enter' && openProfile(nav, p.steamId)
                  : undefined}
                tabindex={isSteam(p.steamId) ? 0 : undefined}
              >
                <td>
                  <span class="pf-name">{p.name || '—'}</span>
                  <span class="muted mono pf-steam">{p.steamId}</span>
                </td>
                <td class="num">{p.matches}</td>
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
  </section>
</div>
