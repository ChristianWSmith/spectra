<script>
  // The Heatmaps tab. It
  // composes its panels and reads nothing itself: the card (HeatmapsPanel)
  // reads the match from the context it inherits. The Match tab mounts this
  // with `context` = { matchId }.
  let { spectra } = $props();
</script>

<spectra.Child name="builtin-match-heatmap" />
