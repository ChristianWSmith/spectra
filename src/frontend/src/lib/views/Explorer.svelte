<script>
  // Explorer, the standalone route (#/explorer/:id): the demo-file diagnostics
  // page. The panels are the builtin Explorer component
  // (builtins/explorer/ExplorerView.svelte), which the Match view's Details
  // tab mounts too. This surface adds only the match picker, which sets the
  // context the builtin reads, and the match list's own error. Warnings live
  // on the Match view.
  import { listMatches, errText } from '../services.js';
  import MatchPicker from '../components/MatchPicker.svelte';
  import ComponentFrame from '../components/ComponentFrame.svelte';
  import ExplorerView from '../builtins/explorer/ExplorerView.svelte';
  import * as S from '../strings/index.js';

  let { nav = () => {}, routeId = 0 } = $props();

  let matches = $state([]);
  let matchId = $state(0);
  let loadError = $state('');

  // The route's id is authoritative; the newest match is the default only
  // while nothing is selected.
  $effect(() => {
    const rid = routeId;
    if (rid) matchId = rid;
  });

  async function loadMatches() {
    try {
      const rows = await listMatches('', 'extracted_at', true);
      matches = rows || [];
      if (!matchId && matches.length) matchId = matches[0].id;
      loadError = '';
    } catch (e) {
      loadError = errText(e);
    }
  }

  $effect(() => {
    loadMatches();
  });

  const context = $derived({ matchId, steamId: null, round: null });
</script>

<div class="view">
  <header class="view-header">
    <h1>{S.library.explorerTitle}</h1>
    <MatchPicker id="expl-match" matches={matches} value={matchId} onselect={(id) => (matchId = id)} />
    <span class="muted">{S.library.explorerSubtitle}</span>
  </header>

  {#if loadError}
    <p class="error" role="alert">
      {loadError}
      <button class="btn small" onclick={loadMatches}>{S.library.retry}</button>
    </p>
  {/if}

  {#if !matchId}
    {#if !loadError}
      <!-- Gated on loadError: a failed match-list read is UNKNOWN, never "no matches". -->
      <div class="panel empty">
        <p class="empty-title" role="status">{S.library.noMatches}</p>
        <p class="muted">{S.library.noMatchesHint}</p>
      </div>
    {/if}
  {:else}
    <ComponentFrame component={ExplorerView} {context} props={{ embedded: false }} {nav} />
  {/if}
</div>
