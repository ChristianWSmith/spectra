<script>
  // The mount the match-panels harness drives: one ComponentFrame around a
  // panel's source, with the context, the placement props and the fixture
  // read services the harness passes in (match-panels.dom.mjs). `builtinDir`
  // is the source directory of a built-in panel (its helper imports resolve
  // there, as ChildFrame passes it); null for a user component.
  import ComponentFrame from '../src/lib/components/ComponentFrame.svelte';

  let { source, context, props = {}, reads, nav, builtinDir = null } = $props();
</script>

<ComponentFrame {source} {context} {props} {reads} {nav} {builtinDir} />
