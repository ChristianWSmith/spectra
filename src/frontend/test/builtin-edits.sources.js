// Source texts the builtin-edits harness mounts (a module, so the Svelte
// source of the nested parent is not written inside a .svelte <script>).
export const NESTED_SOURCE = `<script>
  let { spectra, name } = $props();
</script>
<spectra.Child {name} />`;
