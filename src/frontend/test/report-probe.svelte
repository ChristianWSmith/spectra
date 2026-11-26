<script>
  // Test probe for spectra.report: a component that reports one failure to its frame when it mounts.
  let { spectra } = $props();
  $effect(() => {
    spectra.report(new Error('probe load failed'));
  });
</script>

<p>probe body</p>
