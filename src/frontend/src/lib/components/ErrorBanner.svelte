<script>
  // ErrorBanner — the one error line a panel shows (a failed read, a failed
  // action). Its text is the children; the role makes a screen reader announce it.
  let { children } = $props();
</script>

<p class="error" role="alert">{@render children()}</p>
