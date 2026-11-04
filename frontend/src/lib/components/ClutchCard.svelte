<script>
  // ClutchCard — one detected 1vN (clutch v2) summary + deep links.
  // Both actions open THE event browser (Replay's landmark feed): Replay
  // at the clutch's anchor tick, Events scoped to the clutch's round.
  import { replayHash } from '../nav.js';
  import { fmtDuration } from '../fmt.js';
  import ProfileLink from './ProfileLink.svelte';

  let { clutch, id = 0, nav = () => {}, tickRate = 64 } = $props();

  const back = $derived(`match/${id}/combat`);

  function parseTicks(json) {
    if (!json) return [];
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  const killTicks = $derived(parseTicks(clutch.killTicks));
  const durationS = $derived(
    tickRate > 0 ? Math.max(0, (clutch.endTick - clutch.startTick) / tickRate) : 0,
  );

  function replay() {
    nav(replayHash(id, {}, { tick: clutch.replayAnchorTick || clutch.startTick, back }));
  }

  function openEvents() {
    nav(replayHash(id, { round: clutch.round }, { back }));
  }

</script>

<article
  class="comb-card"
  class:won={clutch.won}
  class:lost={!clutch.won}
  aria-label="Clutch {clutch.size}v1 in round {clutch.round}"
>
  <div class="comb-sum">
    <strong>1v{clutch.size}</strong>
    <span class="chip status {clutch.won ? 'ok' : 'bad'}">
      {clutch.won ? 'won' : 'lost'}
    </span>
    <span class="chip round-chip">R{clutch.round}</span>
    <span class="muted">{fmtDuration(durationS)}</span>
    <span class="muted">{clutch.hpLeft} HP</span>
    {#if clutch.bombState && clutch.bombState !== 'none'}
      <span class="chip">bomb {clutch.bombState}</span>
    {/if}
    <ProfileLink
      steam={clutch.steamId}
      name={clutch.name || '—'}
      {nav}
      title="Open player profile"
    />
    {#if clutch.equip > 0}
      <span class="muted">equip {clutch.equip}</span>
    {/if}
  </div>

  {#if killTicks.length > 0}
    <div class="comb-ticks" aria-label="Kill ticks">
      {#each killTicks as t, i (i)}
        <span class="chip mono" title="Kill at tick {t}">K{i + 1} · {t}</span>
      {/each}
    </div>
  {/if}

  <div class="toolbar comb-actions">
    <button class="btn small" title="Watch the clutch in the replay" onclick={replay}>
      <span class="codicon codicon-play"></span> Replay
    </button>
    <button class="btn small" title="Open this round's events in the replay landmark feed" onclick={openEvents}>
      Events
    </button>
  </div>
</article>
