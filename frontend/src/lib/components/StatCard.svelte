<script>
  // Stat card cell — the anatomy shared by Match's top stats, the player
  // profile grid and the economy summary: label (with an optional badge
  // slot), value, sub. The view owns the data, the tooltip and whether
  // the cell drills anywhere: an `onclick` renders the cell as a button,
  // otherwise it stays a plain div.
  // `subCls` is an additive pass-through for the sub line (Match's top
  // stats pass the team-identity color, changes.txt #20); default '' and
  // the other call sites are unchanged.
  // `subSlot` is an optional snippet rendered INSTEAD of the `sub`
  // string — Match's top stats pass the player's ProfileLink there, so
  // the name text itself opens the profile while the rest of the cell
  // keeps its own drill. A click (or Enter) inside the sub line belongs
  // to that link and never fires the cell's onclick.
  let {
    label,
    value,
    sub = '',
    subSlot = null,
    title = undefined,
    cls = '',
    subCls = '',
    onclick = null,
    badge = null,
  } = $props();

  // A control nested INSIDE the cell — the sub line's ProfileLink — owns
  // its own activation; everything else (including the cell button itself,
  // which `closest` would also match) keeps the cell's drill.
  function insideLink(e) {
    const cell = e.currentTarget;
    const hit = e.target instanceof Element ? e.target.closest('button, a, input') : null;
    return !!hit && hit !== cell;
  }

  function onCellActivate(e) {
    if (insideLink(e)) return;
    onclick(e);
  }

  function onCellKey(e) {
    if ((e.key !== 'Enter' && e.key !== ' ') || insideLink(e)) return;
    e.preventDefault();
    onclick(e);
  }
</script>

{#snippet body()}
  <span class="field-label">{label}{#if badge}{@render badge()}{/if}</span>
  <span class="stat-value">{value}</span>
  <span class="stat-sub {subCls}"
    >{#if subSlot}{@render subSlot()}{:else}{sub}{/if}</span
  >
{/snippet}

{#if onclick}
  <button class="stat-cell {cls}" {title} onclick={onCellActivate} onkeydown={onCellKey}>{@render body()}</button>
{:else}
  <div class="stat-cell {cls}" {title}>{@render body()}</div>
{/if}
