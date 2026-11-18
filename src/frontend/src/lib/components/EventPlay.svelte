<script>
  // The one ghost ▶ replay action cell — the canonical play cell: table
  // rows (Combat's engagements, Match's) and LIST rows (Utility's throw
  // log, where it is the row's leading cell) all render it (title/
  // aria-label wording varies per row context, so it rides as props).
  // Landmark rows keep their own ▶: a <button> may not nest inside the
  // row's main button — see LandmarkRow.svelte.
  let {
    tick = 0,
    // Defaults identify the EVENT, never a landing position or a tick
    // number (owner ruling 2026-11-18): every current call site passes
    // its own title/label, these are the fallback copy only. `tick` stays
    // a prop for the callers that pass it.
    title = `Watch this event in replay`,
    label = `Watch this event in replay`,
    cls = '',
    onclick = () => {},
  } = $props();
</script>

<button class="btn small ghost {cls}" {title} aria-label={label} {onclick}
  ><span class="codicon codicon-play"></span></button
>
