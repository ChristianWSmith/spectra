<script>
  // Stat card cell — the anatomy shared by Match's top stats, the player
  // profile grid and the economy summary: label (with an optional badge
  // slot), value, sub. The view owns the data, the tooltip and whether
  // the cell drills anywhere: an `onclick` renders the cell as a button,
  // otherwise it stays a plain div.
  // `subCls` is an additive pass-through for the sub line (Match's top
  // stats pass the team-identity color, changes.txt #20); default '' and
  // the other call sites are unchanged.
  let {
    label,
    value,
    sub = '',
    title = undefined,
    cls = '',
    subCls = '',
    onclick = null,
    badge = null,
  } = $props();
</script>

{#snippet body()}
  <span class="field-label">{label}{#if badge}{@render badge()}{/if}</span>
  <span class="stat-value">{value}</span>
  <span class="stat-sub {subCls}">{sub}</span>
{/snippet}

{#if onclick}
  <button class="stat-cell {cls}" {title} {onclick}>{@render body()}</button>
{:else}
  <div class="stat-cell {cls}" {title}>{@render body()}</div>
{/if}
