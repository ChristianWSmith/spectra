<script>
  // ErrorBanner — the one error line a panel shows (a failed read, a failed
  // action). Its text is the children; the role makes a screen reader announce it.
  // With `onretry`, the line carries a Retry button (labelled `retryLabel`) after
  // its text. With `ondismiss`, the line carries the close button, labelled `dismissLabel`.
  import RetryButton from './RetryButton.svelte';
  let { children, ondismiss = null, dismissLabel = '', onretry = null, retryLabel = '' } = $props();
</script>

<p class="error" role="alert">{@render children()}{#if onretry}{' '}<RetryButton {onretry} label={retryLabel} />{/if}{#if ondismiss}<button class="btn small" aria-label={dismissLabel} onclick={ondismiss}><span class="codicon codicon-close"></span></button>{/if}</p>
