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
  // single-player import list, so they sit on top).
  import { listPlayers, errText } from '../services.js';
  import { isSteam, openProfile } from '../nav.js';
  import { fmt1 } from '../fmt.js';
  import { listedPlayers } from '../players.js';
  import SuggestInput from '../components/SuggestInput.svelte';
  import SortTh from '../components/SortTh.svelte';
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
    adrAvg: true,
    lastSeen: true,
  };
  let sortKey = $state('matches');
  let desc = $state(true);

  // Search first, THEN sort: `filtered` narrows the fetched list and the
  // sort orders what survives it. Sort semantics per column — Player →
  // p.name (localeCompare; an empty name '' sorts first ascending and
  // renders '—'), Matches → p.matches numeric, ADR → the RAW p.adrAvg
  // numeric (never the fmt1 string in the cell), the import-date column
  // (field `lastSeen`, header "Last import") → p.lastSeen string compare
  // (zero-padded YYYY-MM-DD, so lexicographic = chronological; '' renders
  // '—').
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
      const av = a[key];
      const bv = b[key];
      let c;
      if (typeof av === 'string' || typeof bv === 'string') {
        c = String(av ?? '').localeCompare(String(bv ?? ''));
      } else {
        c = (av ?? 0) - (bv ?? 0);
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
      placeholder="Search players…"
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

  <section class="panel">
    {#if loading}
      <p class="muted" role="status">Loading players…</p>
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
              <SortTh label="ADR" cls="num" active={sortKey === 'adrAvg'} {desc} onclick={() => toggleSort('adrAvg')} />
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
                <td class="num">{fmt1(p.adrAvg)}</td>
                <td>{fmtLastSeen(p)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>
