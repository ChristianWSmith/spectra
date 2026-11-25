<script>
  // Chip: the one chip the builder lists and editors use, so a chip looks the same wherever it appears.
  //   tone '' (neutral): a fact about the row, such as a format or a scope, or a plain state word (edited);
  //   tone 'accent': a marker that the row is shipped or read-only (built-in, read-only source);
  //   tone 'view': a component the user placed on a view (the match or profile view);
  //   tone 'plugin': a row a plugin owns (dashed outline);
  //   tone 'bad': a row that cannot run (its plugin is switched off).
  // The compute-state chip is StatusChip (its own palette), not this one.
  let { tone = '', title = undefined, children } = $props();
</script>

<span class="chip {tone}" {title}>{@render children()}</span>
