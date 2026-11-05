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
  import { listPlayers, errText } from '../services.js';
  import { isSteam, openProfile } from '../nav.js';
  import { fmt1 } from '../fmt.js';
  import SuggestInput from '../components/SuggestInput.svelte';

  let { nav = () => {} } = $props();

  let players = $state([]);
  let loading = $state(true);
  let error = $state('');
  let query = $state('');

  $effect(() => {
    let live = true;
    listPlayers('')
      .then((rows) => {
        if (!live) return;
        players = rows || [];
        loading = false;
      })
      .catch((e) => {
        if (!live) return;
        error = errText(e);
        loading = false;
      });
    return () => (live = false);
  });

  // Client-side name filter (case-insensitive; an empty query keeps the
  // service order — most recently seen first).
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return players;
    return players.filter((p) => (p.name || '').toLowerCase().includes(q));
  });

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
    <p class="error" role="alert">{error}</p>
  {/if}

  <section class="panel">
    {#if loading}
      <p class="muted" role="status">Loading players…</p>
    {:else if players.length === 0}
      <div class="empty">
        <p class="empty-title" role="status">No players yet</p>
        <p class="muted">Players appear here once matches are imported.</p>
      </div>
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
              <th scope="col">Player</th>
              <th scope="col" class="num">Matches</th>
              <th scope="col" class="num">ADR</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as p (p.steamId)}
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
