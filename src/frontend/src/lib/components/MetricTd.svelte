<script>
  // MetricTd — a numeric table cell that shows one stored value: the cell is a
  // `td.num` carrying the presentation's title, and its body is a MetricCell. `pres`
  // is the cell presentation, `format` turns its value into text, and `chip` is the
  // chip's progress and stage props.
  import MetricCell from './MetricCell.svelte';

  let { pres, format, chip = {}, words = null } = $props();
</script>

<td class="num" title={pres.title}>
  <MetricCell {pres} {format} {chip} {words} />
</td>
