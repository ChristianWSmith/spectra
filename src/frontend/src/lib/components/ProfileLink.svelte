<script>
  // The one comb-name-btn profile link: name → #/player/:steamid for a
  // well-formed Steam id, plain text otherwise (the openProfile guard is
  // structural — bots and malformed ids are not linkable). Used by Combat's
  // stats/engagements/clutches tables, the match/round name cells and
  // Replay's event detail pane.
  //
  // `cls` is an optional pass-through for the caller's own classes — the
  // match view passes the team-identity color on aggregate surfaces
  // (lib/teams.js playerStartClass) and the per-round side color on
  // round-scoped ones (playerSideClassAt). Default '' keeps every
  // existing call site rendering exactly as before.
  import { isSteam, openProfile } from '../nav.js';
  // Hover prefetch (loading ladder, PRODUCT.md "### Defaults"): warming
  // the CHEAP profile read on hover so the click finds it cached — the
  // career trend stays click-driven (never prefetched). warmProfile
  // throttles per steamId (no refire on pointer jitter) and swallows
  // failures; see services.js.
  import { warmProfile } from '../services.js';

  let { steam = '', name = '', nav = () => {}, title = '', cls = '' } = $props();
</script>

{#if isSteam(steam)}
  <button
    class="comb-name-btn {cls}"
    title={title || `Open ${name} profile`}
    onmouseenter={() => warmProfile(steam)}
    onclick={() => openProfile(nav, steam)}>{name || '—'}</button
  >
{:else}
  <span class={cls}>{name || '—'}</span>
{/if}
