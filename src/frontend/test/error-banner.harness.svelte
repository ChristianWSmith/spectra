<script>
  // Test harness for ErrorBanner: the banner with or without a retry, as a panel mounts it.
  import ErrorBanner from '../src/lib/components/ErrorBanner.svelte';
  let { retry = null } = $props();
</script>

<ErrorBanner onretry={retry} retryLabel="Try again">Load failed</ErrorBanner>
