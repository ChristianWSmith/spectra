<script>
  // RetryButton — the button a panel shows beside a failed read, to load it again.
  // `onretry` runs the load; `label` is the caller's word for it.
  let { onretry, label = '' } = $props();
</script>

<button class="btn small" onclick={onretry}>{label}</button>
