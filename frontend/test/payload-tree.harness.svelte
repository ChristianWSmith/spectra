<script>
  // Test harness: mounts N PayloadTree instances driven by one shared
  // state so a driver script can feed payloads/queries and assert on DOM.
  import PayloadTree from './pt-bundle.js';

  let json = $state('{"a":1}');
  let query = $state('');
  let count = $state(1);

  globalThis.__set = (j, q, c) => {
    if (j !== undefined) json = j;
    if (q !== undefined) query = q;
    if (c !== undefined) count = c;
  };
</script>

{#each Array(count) as _, i (i)}
  <PayloadTree {json} {query} />
{/each}
