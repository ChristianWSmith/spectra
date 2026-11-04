<script>
  // The kill-event flag chips — the one markup the raw-event surfaces
  // share (Replay's landmark detail pane; the retired Timeline/RoundDetail
  // feeds used to carry byte-identical copies of this sequence). The
  // canonical flag list + code/title pairs live here; `none` renders the
  // detail pane's "no flags" fallback when no chip applies.
  let { event: e = {}, none = false } = $props();

  // [event field, chip code, tooltip title] — keep the codes/titles in
  // sync with the Go EventRow flag fields (headshot/wallbang/noscope/
  // throughSmoke/attackerBlind/assistedFlash).
  const FLAGS = [
    ['headshot', 'HS', 'headshot'],
    ['wallbang', 'WB', 'wallbang'],
    ['noscope', 'NS', 'no scope'],
    ['throughSmoke', 'SMK', 'through smoke'],
    ['attackerBlind', 'BLD', 'attacker blind'],
    ['assistedFlash', 'AFL', 'assisted flash'],
  ];
</script>

{#each FLAGS as [key, code, title] (code)}
  {#if e[key]}<span class="chip flag" {title}>{code}</span>{/if}
{/each}
{#if none && !FLAGS.some(([key]) => e[key])}<span class="muted">none</span>{/if}
