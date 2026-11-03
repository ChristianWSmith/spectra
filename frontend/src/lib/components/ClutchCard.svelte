<script>
  // ClutchCard — one detected 1vN (clutch v2) summary + deep links.
  // Replay ▶ uses the pendingSeek contract ({tick}); Timeline uses the
  // pending-filter contract ({round}).
  import { setPendingSeek, setPendingTimelineFilter } from '../services.js';
  import { fmtDuration } from '../fmt.js';

  let { clutch, id = 0, nav = () => {}, tickRate = 64 } = $props();

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
    setPendingSeek({ tick: clutch.replayAnchorTick || clutch.startTick });
    nav(`/replay/${id}`);
  }

  function openTimeline() {
    setPendingTimelineFilter({ round: clutch.round });
    nav(`/match/${id}/timeline`);
  }

  function openProfile() {
    if (/^\d{17}$/.test(clutch.steamId || '')) nav(`/player/${clutch.steamId}`);
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
    <span class="chip status {clutch.won ? 'ready' : 'failed'}">
      {clutch.won ? 'won' : 'lost'}
    </span>
    <span class="chip round-chip">R{clutch.round}</span>
    <span class="muted">{fmtDuration(durationS)}</span>
    <span class="muted">{clutch.hpLeft} HP</span>
    {#if clutch.bombState && clutch.bombState !== 'none'}
      <span class="chip">bomb {clutch.bombState}</span>
    {/if}
    <button
      class="comb-name-btn"
      title="Open player profile"
      onclick={openProfile}
    >{clutch.name || '—'}</button>
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

  <div class="comb-actions">
    <button class="btn small" title="Watch the clutch in the replay" onclick={replay}>
      ▶ Replay
    </button>
    <button class="btn small" title="Open this round in the timeline" onclick={openTimeline}>
      Timeline
    </button>
  </div>
</article>
