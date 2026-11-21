<script>
  // The Combat tab (builtin, dogfood/04 §7; PLAN C5-Heat-Combat). It composes
  // its two panels: the engagements (duels) and the clutches. Each panel
  // reads the match from the context it inherits and loads its own data.
  let { spectra } = $props();
</script>

<div class="view comb-view">
  <spectra.Child name="builtin-match-combat-engagements" />
  <spectra.Child name="builtin-match-combat-clutches" />
</div>
