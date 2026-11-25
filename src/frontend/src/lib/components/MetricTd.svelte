<script>
  // MetricTd — the numeric table cell every built-in table uses for one stored value:
  // a `td.num` whose body is a MetricCell. `pres` is the cell presentation, `format`
  // turns its value into text, `chip` is the chip's progress and stage props, `words`
  // names a state in words (see MetricCell), and `title` is the cell's tooltip (a
  // failed metric's error, say). The formula belongs on the column header.
  import MetricCell from './MetricCell.svelte';

  let { pres, format, chip = null, words = null, title = null } = $props();
  // The cell's tooltip: the caller's title, else the presentation's own reason (its state title).
  const tip = $derived(title || pres.title || '');
</script>

<td class="num" title={tip || undefined}>
  <MetricCell {pres} {format} {chip} {words} />
</td>
