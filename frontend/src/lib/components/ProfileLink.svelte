<script>
  // The one comb-name-btn profile link: name → #/player/:steamid for a
  // well-formed Steam id, plain text otherwise (the openProfile guard made
  // structural — bots and malformed ids were never linkable, they just
  // used to render as inert buttons). Used by RoundDetail's kill feed,
  // Combat's engagement/stats tables and ClutchCard.
  import { isSteam, openProfile } from '../nav.js';

  let { steam = '', name = '', nav = () => {}, title = '' } = $props();
</script>

{#if isSteam(steam)}
  <button
    class="comb-name-btn"
    title={title || `Open ${name} profile`}
    onclick={() => openProfile(nav, steam)}>{name || '—'}</button
  >
{:else}
  {name || '—'}
{/if}
