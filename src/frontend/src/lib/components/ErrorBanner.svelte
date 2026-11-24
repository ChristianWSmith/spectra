<script>
  // ErrorBanner — the one error line a panel shows (a failed read, a failed
  // action). Its text is the children; the role makes a screen reader announce it.
  // With `ondismiss`, the line carries the close button, labelled `dismissLabel`.
  let { children, ondismiss = null, dismissLabel = '' } = $props();
</script>

<p class="error" role="alert">{@render children()}{#if ondismiss}<button class="btn small" aria-label={dismissLabel} onclick={ondismiss}><span class="codicon codicon-close"></span></button>{/if}</p>
