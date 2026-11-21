<script>
  // The Heatmaps tab (builtin, dogfood/04 §7; PLAN C5-Heat-Combat). It
  // composes its panels and reads nothing itself: the card (HeatmapsPanel)
  // reads the match from the context it inherits. The Match tab mounts this
  // with `context` = { matchId }.
  let { spectra } = $props();
</script>

<spectra.Child name="builtin-match-heatmap" />
