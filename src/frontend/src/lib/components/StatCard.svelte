<script>
  import { activateOnKey, CONTROL_SELECTOR } from '../keys.js';
  // Stat card cell — the anatomy shared by Match's top stats, the player
  // profile grid and the economy summary: label (with an optional badge
  // slot), value, sub. The view owns the data, the tooltip and whether
  // the cell drills anywhere: an `onclick` renders the cell as a button,
  // otherwise it stays a plain div.
  // `subCls` is an additive pass-through for the sub line (a view may pass a
  // team-identity color); default '' leaves the sub line unchanged.
  // `subSlot` is an optional snippet rendered INSTEAD of the `sub`
  // string — a view may pass a player's ProfileLink there, so
  // the name text itself opens the profile while the rest of the cell
  // keeps its own drill. A click (or Enter) inside the sub line belongs
  // to that link and never fires the cell's onclick.
  // `valueSlot` is the value's own twin (additive, same contract):
  // rendered INSTEAD of the `value` string when present — the profile's
  // career tiles pass their state-machine body there (value / honest
  // dash / state chip), which needs markup a string cannot carry.
  // `labelTitle` is an additive tooltip on the LABEL span alone — the
  // career tiles carry two tooltips (the name's metric doc lives here,
  // the value's formula/state rides the cell's own `title`), and a nested
  // element's own title always wins over its ancestor's.
  let {
    label,
    value,
    sub = '',
    subSlot = null,
    valueSlot = null,
    title = undefined,
    labelTitle = undefined,
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
    const hit = e.target instanceof Element ? e.target.closest(CONTROL_SELECTOR) : null;
    return !!hit && hit !== cell;
  }

  function onCellActivate(e) {
    if (insideLink(e)) return;
    onclick(e);
  }

  function onCellKey(e) {
    if (insideLink(e)) return;
    activateOnKey(onclick)(e);
  }
</script>

{#snippet body()}
  <span class="field-label" title={labelTitle}>{label}{#if badge}{@render badge()}{/if}</span>
  <span class="stat-value">{#if valueSlot}{@render valueSlot()}{:else}{value}{/if}</span>
  <span class="stat-sub {subCls}"
    >{#if subSlot}{@render subSlot()}{:else}{sub}{/if}</span
  >
{/snippet}

{#if onclick}
  <button class="stat-cell {cls}" {title} onclick={onCellActivate} onkeydown={onCellKey}>{@render body()}</button>
{:else}
  <div class="stat-cell {cls}" {title}>{@render body()}</div>
{/if}
