<script>
  // SurfaceView — a surface's placed components, or its default (dogfood/04
  // §2; owner ruling 43). A surface with no placement renders its default
  // composition (the `fallback` snippet) exactly as before. A surface with
  // placements renders each placed component, in order, in its own frame
  // (ChildFrame resolves the name: an edited builtin, a shipped builtin, or a
  // user component). Until the placements are read the default shows, so a
  // surface without a placement never waits on the read.
  import ChildFrame from './ChildFrame.svelte';
  import { loadPlacements } from '../componentruntime/placements.js';

  let { surface = '', context = null, nav = undefined, fallback } = $props();

  let placed = $state([]);
  $effect(() => {
    const s = surface;
    let live = true;
    loadPlacements(s).then(
      (entries) => {
        if (live) placed = entries;
      },
      () => {
        if (live) placed = [];
      },
    );
    return () => {
      live = false;
    };
  });
</script>

{#if placed.length}
  {#each placed as p (p.key)}
    <ChildFrame name={p.component} props={p.props} {context} {nav} />
  {/each}
{:else}
  {@render fallback?.()}
{/if}
