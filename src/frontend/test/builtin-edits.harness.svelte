<script>
  // Harness for test/builtin-edits.dom.mjs: one mount shape per scenario.
  //   mode "child"   — a named component mounted at the top of a surface
  //   mode "nested"  — a parent component whose markup mounts the named one
  //                    (the Match tabs' path: a component mounting a builtin)
  //   mode "surface" — a surface (SurfaceView) with a default fallback
  import ChildFrame from '../src/lib/components/ChildFrame.svelte';
  import ComponentFrame from '../src/lib/components/ComponentFrame.svelte';
  import SurfaceView from '../src/lib/components/SurfaceView.svelte';
  import { NESTED_SOURCE } from './builtin-edits.sources.js';

  let { mode = 'child', name = '', surface = 'match-view' } = $props();
</script>

{#if mode === 'child'}
  <ChildFrame {name} context={{ matchId: 7, steamId: null, round: null }} />
{:else if mode === 'nested'}
  <ComponentFrame source={NESTED_SOURCE} props={{ name }} context={{ matchId: 7, steamId: null, round: null }} />
{:else}
  <SurfaceView {surface} context={{ matchId: 7, steamId: null, round: null }}>
    {#snippet fallback()}
      <p class="default-marker">DEFAULT</p>
    {/snippet}
  </SurfaceView>
{/if}
