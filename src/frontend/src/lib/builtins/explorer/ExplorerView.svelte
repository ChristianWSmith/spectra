<script>
  // The Explorer builtin (dogfood/04-COMPONENTS.md §7): the demo-file
  // diagnostics for the match in the context, composed from its panels. The
  // Match view's Details tab mounts it embedded (the facts above it stay
  // hardcoded there); the standalone Explorer route mounts it with the picked
  // match and adds the static reference card, which the embedded tab omits
  // (the network census is not this match's data).
  let { spectra, embedded = false } = $props();
</script>

<spectra.Child name="builtin-explorer-provenance" />
<spectra.Child name="builtin-explorer-diagnostics" />
{#if !embedded}
  <spectra.Child name="builtin-explorer-reference" />
{/if}
