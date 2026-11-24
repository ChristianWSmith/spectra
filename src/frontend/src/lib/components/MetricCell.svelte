<script>
  // MetricCell — the body of a stored-value table cell, drawn from one
  // presentation (metricstate.js metricPresentation): the formatted value, the
  // dash for no value, or the state. A state is drawn as a chip when `chip`
  // (the progress and stage props, sweep.chip) is given, and as its word from
  // `words` otherwise.
  import StatusChip from './StatusChip.svelte';

  let { pres, format, chip = null, words = null } = $props();
</script>

{#if pres.kind === 'value'}{format(pres.value)}{:else if pres.kind === 'nodata'}—{:else if chip}<StatusChip status={pres.state} title={pres.title} {...chip} />{:else}{(words && words[pres.state]) || pres.state}{/if}
