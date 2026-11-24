<script>
  // EmptyTableRow — the one row a table shows when it has nothing to list: a
  // state chip while the rows are being computed or are not ready (the `empty`
  // presentation from a split table's emptyChip), and the honest text otherwise.
  // `chip` is the chip's progress and stage props (sweep.chip for the empty metric).
  import StatusChip from './StatusChip.svelte';

  let { colspan, empty = null, text = '', chip = {} } = $props();
</script>

<tr>
  <td colspan={colspan} class="muted">
    {#if empty}
      <StatusChip status={empty.state} title={empty.title} {...chip} />
    {:else}
      {text}
    {/if}
  </td>
</tr>
