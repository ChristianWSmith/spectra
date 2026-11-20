<script>
  // Test harness for ComponentFrame: one surface holding several frames —
  // a builtin, a missing placement and (withUser) user sources that break
  // in each way the frame must contain — plus a probe paragraph that must
  // keep rendering whatever the frames do.
  import ComponentFrame from './components/ComponentFrame.js';

  let { withUser = false, sources = {}, builtin = null, reads = null } = $props();
</script>

<section class="surface">
  <div data-slot="builtin"><ComponentFrame component={builtin} props={{ label: 'built' }} {reads} /></div>
  <div data-slot="missing"><ComponentFrame name="My overview" /></div>
  {#if withUser}
    {#each Object.entries(sources) as [slot, source] (slot)}
      <div data-slot={slot}><ComponentFrame {source} {reads} /></div>
    {/each}
  {/if}
  <p id="probe">surface still renders</p>
</section>
