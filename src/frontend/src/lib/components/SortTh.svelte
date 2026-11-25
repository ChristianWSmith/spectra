<script>
  // Sortable table header cell: label + direction caret, with the button
  // carrying the aria. Each view keeps its OWN sort state and backend. Library
  // sorts client-side with a per-column natural default, the Match scoreboard
  // keeps a sort chain (MatchScoreboard.svelte), Combat sorts client-side. The
  // view passes the current direction and the header's aria-sort in; nothing
  // here re-sorts anything.
  //
  // `title` defaults to "Sort by <label>"; a definition tooltip passes its
  // own (and puts the dotted `.def` class in `cls` — the view owns that).
  import * as S from '../strings/index.js'; // chrome copy (strings-audit Check B)

  let {
    label,
    cls = '',
    title = undefined,
    active = false,
    desc = false,
    ariaSort = undefined,
    onclick = () => {},
    children,
  } = $props();
</script>

<th scope="col" class={cls} title={title ?? `Sort by ${label}`} aria-sort={ariaSort}>
  <button class="th-sort" class:sorted={active} aria-label="{S.common.sortThSortByPrefix}{label}" {onclick}>
    {label}{#if active}<span class="codicon {desc ? 'codicon-arrow-down' : 'codicon-arrow-up'}"></span>{/if}
  </button>
  {@render children?.()}
</th>
