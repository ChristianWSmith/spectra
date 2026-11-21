<script>
  // Test harness for the component context and nested mount (04 §3, §3.5):
  // one surface with one top-level frame that mounts `source` with the
  // given `context`, plus a probe paragraph that must keep rendering.
  import ComponentFrame from '../src/lib/components/ComponentFrame.svelte';

  let { source = null, context = null } = $props();
</script>

<section class="surface">
  <div data-slot="top"><ComponentFrame {source} {context} /></div>
  <p id="probe">surface still renders</p>
</section>
