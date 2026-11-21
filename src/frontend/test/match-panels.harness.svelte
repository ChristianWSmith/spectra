<script>
  // The mount the match-panels harness drives: one ComponentFrame around a
  // panel's source, with the context, the placement props and the fixture
  // read services the harness passes in (match-panels.dom.mjs).
  import ComponentFrame from '../src/lib/components/ComponentFrame.svelte';

  let { source, context, props = {}, reads, nav } = $props();
</script>

<ComponentFrame {source} {context} {props} {reads} {nav} />
