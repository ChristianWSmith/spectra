<script>
  // The Combat tab. It composes
  // its two panels: the kill tags (duels) and the clutches. Each panel
  // reads the match from the context it inherits and loads its own data.
  let { spectra } = $props();
</script>

<div class="view comb-view">
  <spectra.Child name="builtin-match-combat-kill-tags" />
  <spectra.Child name="builtin-match-combat-clutches" />
</div>

<style>
  /* A tab root sits in a display: contents frame, so it is a flex item of the
     Match view's column, where the shared .view auto margins would shrink it to
     its content. Full width, like the other tabs. */
  .comb-view {
    margin-inline: 0;
  }
</style>
