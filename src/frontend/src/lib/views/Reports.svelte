<script>
  // The standalone Reports route (#/reports/:id). The report itself is the
  // builtin Reports component (builtins/reports/ReportsView.svelte), which the
  // Match view's Reports tab mounts too. This surface owns only what the
  // standalone page adds: the match picker, which sets the context the
  // builtin reads (ruling 34), and the match list's own error.
  import { listMatches, errText } from '../services.js';
  import MatchPicker from '../components/MatchPicker.svelte';
  import ComponentFrame from '../components/ComponentFrame.svelte';
  import HelpButton from '../components/HelpButton.svelte';
  import ReportsView from '../builtins/reports/ReportsView.svelte';
  import * as S from '../strings/index.js';
  import { seed, remember } from '../viewstate.svelte.js';

  let { nav = () => {}, routeId = 0, openDocs = () => {} } = $props();

  // The picked match: the route's id wins; otherwise the restored pick, and
  // otherwise the newest match.
  let matchId = $state(seed('reports-match', { matchId: 0 }).matchId);
  let matches = $state([]);
  let matchError = $state('');

  $effect(() => {
    const rid = routeId;
    if (rid) matchId = rid;
  });
  $effect(() => remember('reports-match', { matchId }));

  async function loadMatches() {
    try {
      const rows = (await listMatches('', 'extracted_at', true)) || [];
      matches = rows.filter((row) => row.status === 'ready' || row.status === '');
      if (!matches.length) matches = rows;
      if (!matchId && matches.length) matchId = matches[0].id;
      matchError = '';
    } catch (e) {
      matchError = errText(e);
    }
  }

  $effect(() => {
    loadMatches();
  });

  const context = $derived({ matchId, steamId: null, round: null });
</script>

<div class="view">
  <header class="view-header">
    <h1>{S.reports.title}</h1>
    <span class="muted">{S.reports.subtitle}</span>
    <div class="spacer"></div>
    <HelpButton section="reports" {openDocs} />
  </header>

  {#if matchError}
    <p class="error" role="alert">
      {matchError}
      <button class="btn small" onclick={loadMatches}>{S.reports.retry}</button>
    </p>
  {/if}

  <section class="panel">
    <div class="rep-field">
      <label class="field-label" for="rep-match">{S.reports.matchLabel}</label>
      <MatchPicker {matches} value={matchId} id="rep-match" onselect={(mid) => (matchId = mid)} />
    </div>
    {#if !matches.length && !matchError}
      <!-- Gated on matchError: a failed match read is UNKNOWN, never "no matches". -->
      <p class="muted" role="status">{S.reports.noMatches}</p>
    {/if}
  </section>

  <ComponentFrame component={ReportsView} {context} props={{ embedded: false }} {nav} />
</div>
