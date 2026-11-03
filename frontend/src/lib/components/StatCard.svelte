<script>
  // Stat card cell — the anatomy shared by Match's top stats, the player
  // profile grid and the economy summary: label (with an optional badge
  // slot), value, sub. The view owns the data, the tooltip and whether
  // the cell drills anywhere: an `onclick` renders the cell as a button,
  // otherwise it stays a plain div.
  let {
    label,
    value,
    sub = '',
    title = undefined,
    cls = '',
    onclick = null,
    badge = null,
  } = $props();
</script>

{#snippet body()}
  <span class="field-label">{label}{#if badge}{@render badge()}{/if}</span>
  <span class="stat-value">{value}</span>
  <span class="stat-sub">{sub}</span>
{/snippet}

{#if onclick}
  <button class="stat-cell {cls}" {title} {onclick}>{@render body()}</button>
{:else}
  <div class="stat-cell {cls}" {title}>{@render body()}</div>
{/if}
