<script>
  // The profile link on a player's name: a button that opens the player's profile for a
  // well-formed Steam id, and plain text otherwise (bots and malformed ids are not linkable).
  // Its look is `variant`: the default is the Combat, Replay and Builder link (comb-name-btn);
  // 'name-link' is the match view's link (a ghost button). `cls` adds the caller's own classes
  // (the team or side colour). `stopRow` keeps the click from reaching the row it sits in.
  // Hover warms the cheap profile read (warmProfile); the career trend is never prefetched.
  import { isSteam, openProfile } from '../nav.js';
  import * as S from '../strings/index.js';
  import { DASH } from '../builtinhelpers.js';
  import { warmProfile } from '../services.js';

  let { steam = '', name = '', nav = () => {}, title = '', cls = '', variant = 'comb', stopRow = false } = $props();
  const buttonClass = $derived(variant === 'name-link' ? 'btn ghost small name-link' : 'comb-name-btn');
</script>

{#if isSteam(steam)}
  <button
    class="{buttonClass} {cls}"
    title={title || S.fill(S.match.openProfile, { name })}
    onmouseenter={() => warmProfile(steam)}
    onclick={(e) => {
      if (stopRow) e.stopPropagation();
      openProfile(nav, steam);
    }}>{name || DASH}</button
  >
{:else}
  <span class={cls}>{name || DASH}</span>
{/if}
