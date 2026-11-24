<script>
  // EmptyNote — the line a panel shows where there is nothing to show (no rows,
  // no templates). Its text is the children; role="status" announces it.
  let { children } = $props();
</script>

<p class="muted" role="status">{@render children()}</p>
