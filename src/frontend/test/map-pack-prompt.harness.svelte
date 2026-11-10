<script>
  // Test harness for MapPackPrompt: mounts one instance and exposes its
  // presence-driven maybePrompt() to the driver script through
  // globalThis. The driver remounts this harness to prove that declining
  // the prompt leaves nothing persisted behind (fresh instance, same
  // missing-assets state → prompt opens again).
  import MapPackPrompt from './mappackprompt-bundle.js';

  let dlg = $state(null);

  globalThis.__prompt = {
    maybePrompt: () => {
      if (!dlg) throw new Error('MapPackPrompt not mounted');
      return dlg.maybePrompt();
    },
  };
</script>

<MapPackPrompt bind:this={dlg} />
