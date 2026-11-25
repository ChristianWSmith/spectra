<script>
  // Test probe for spectra.loadForMatch: a match load that always fails, with no failure
  // handler, so the failure must reach the frame banner.
  let { spectra, context } = $props();
  $effect(spectra.loadForMatch(
    () => context.matchId,
    () => Promise.reject(new Error('probe match load failed')),
    () => {},
  ));
</script>

<p>load body</p>
