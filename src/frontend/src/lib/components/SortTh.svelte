<script>
  // Sortable table header cell: label + direction caret, with the button
  // carrying the aria. Each view keeps its OWN sort state and backend —
  // Library sorts client-side with a per-column natural default, Match
  // sorts server-side through the service, Combat sorts client-side —
  // and passes the current direction in; nothing here re-sorts anything.
  //
  // `title` defaults to "Sort by <label>"; a definition tooltip passes its
  // own (and puts the dotted `.def` class in `cls` — the view owns that).
  let {
    label,
    cls = '',
    title = undefined,
    active = false,
    desc = false,
    onclick = () => {},
    children,
  } = $props();
</script>

<th scope="col" class={cls} title={title ?? `Sort by ${label}`}>
  <button class="th-sort" class:sorted={active} aria-label="Sort by {label}" {onclick}>
    {label}{#if active}<span class="codicon {desc ? 'codicon-arrow-down' : 'codicon-arrow-up'}"></span>{/if}
  </button>
  {@render children?.()}
</th>
