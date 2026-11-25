<script>
  // The one comb-name-btn profile link: name → #/player/:steamid for a
  // well-formed Steam id, plain text otherwise (the openProfile guard is
  // structural — bots and malformed ids are not linkable). Used by Combat's
  // stats/kill tags/clutches tables, the match/round name cells and
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

  // `variant` picks the button's look: the default is the Combat / Replay link (comb-name-btn);
  // 'name-link' is the match panels’ link (a ghost button). `stopRow` keeps the click from
  // reaching the row it sits in (a row that also opens something).
  let { steam = '', name = '', nav = () => {}, title = '', cls = '', variant = 'comb', stopRow = false } = $props();
  const buttonClass = $derived(variant === 'name-link' ? 'btn ghost small name-link' : 'comb-name-btn');
</script>

{#if isSteam(steam)}
  <button
    class="{buttonClass} {cls}"
    title={title || `Open ${name} profile`}
    onmouseenter={() => warmProfile(steam)}
    onclick={(e) => {
      if (stopRow) e.stopPropagation();
      openProfile(nav, steam);
    }}>{name || '—'}</button
  >
{:else}
  <span class={cls}>{name || '—'}</span>
{/if}
