<script>
  // The one ghost ▶ replay action cell for table rows: RoundDetail's kill
  // feed, Context's admin stream and Combat's engagement rows share this
  // exact button (title/aria-label wording varies per row context, so it
  // rides as props). Timeline's virtualized rows keep their own
  // span[role=button] variant — a <button> may not nest inside the row
  // button — see Timeline.svelte.
  let {
    tick = 0,
    title = `Watch at tick ${tick} in replay`,
    label = `Watch tick ${tick} in replay`,
    cls = '',
    onclick = () => {},
  } = $props();
</script>

<button class="btn small ghost {cls}" {title} aria-label={label} {onclick}
  ><span class="codicon codicon-play"></span></button
>
