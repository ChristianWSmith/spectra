<script>
  // The mount the match-tabs harness drives: the tab set (MatchTabs) in its own
  // frame, the way the Match view mounts it, with the context the frame gives
  // and the placement props the harness passes in (match-tabs.dom.mjs).
  import ComponentFrame from '../src/lib/components/ComponentFrame.svelte';
  import MatchTabs from '../src/lib/builtins/match/MatchTabs.svelte';

  let { context, props = {}, reads, nav } = $props();
</script>

<ComponentFrame component={MatchTabs} {context} {props} {reads} {nav} />
