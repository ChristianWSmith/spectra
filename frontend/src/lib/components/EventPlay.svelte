<script>
  // The one ghost ▶ replay action cell for table rows — Combat's
  // engagement rows use it today (title/aria-label wording varies per row
  // context, so it rides as props). Landmark rows keep their own ▶: a
  // <button> may not nest inside the row's main button — see
  // LandmarkRow.svelte.
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
