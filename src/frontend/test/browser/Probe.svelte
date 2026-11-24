<script>
  // A probe under the shared shell: a block of rows whose count and identity the driver sets.
  import LoadBox from '../../src/lib/components/LoadBox.svelte';
  import { probe } from './probe.svelte.js';
</script>

<LoadBox tag="section" class="probe-box" busy={probe.busy} key={probe.key} name="probe">
  {#each Array.from({ length: probe.rows }, (_, i) => i) as i (i)}
    <div class="probe-row" style="height: 40px"></div>
  {/each}
</LoadBox>
