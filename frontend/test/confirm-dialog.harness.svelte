<script>
  // Test harness for ConfirmDialog: mounts one instance and exposes its
  // imperative ask() to the driver script through globalThis.
  import ConfirmDialog from './confirmdialog-bundle.js';

  let dlg = $state(null);

  globalThis.__ask = (opts) => {
    if (!dlg) throw new Error('ConfirmDialog not mounted');
    return dlg.ask(opts);
  };
</script>

<ConfirmDialog bind:this={dlg} />
