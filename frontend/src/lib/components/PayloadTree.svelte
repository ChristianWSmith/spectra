<script>
  // Recursive key/value tree for ONE event payload — the render path of
  // Explorer's "Generic payload browser". Pure presentation: it takes the
  // raw payload JSON plus the key filter and owns expansion state.
  //
  // Rendering contract (see payloadTree.js for the pure half):
  //
  //  * Snippets are invoked with `{@render node(...)}` — a bare
  //    `{node(...)}` compiles to a plain function call whose first
  //    argument becomes the snippet's DOM anchor, so the payload key
  //    lands in `$$anchor`, the value in `key`, the depth number in
  //    `val`… and the first `val()` throws `TypeError: val is not a
  //    function`, aborting the whole update (the panel then looks like
  //    it never finishes loading). Always use {@render}.
  //  * Branches are lazy: a branch's children mount only while the
  //    branch is open, so a payload costs O(visible rows) of DOM and the
  //    initial view stays "root + one level, click to go deeper".
  //  * Filtering runs once per payload per keystroke (matchPaths) and
  //    the template only does O(1) Set lookups — no per-node subtree
  //    re-walks, no full-tree rebuild on every keystroke.
  import {
    parsePayload,
    entries,
    countKeys,
    kvText,
    kvClass,
    isObj,
    matchPaths,
  } from '../payloadTree.js';
  import { untrack } from 'svelte';

  let { json = '{}', query = '' } = $props();

  const payload = $derived(parsePayload(json));
  // null = no filter ("show everything"); otherwise the visible-path set.
  const matches = $derived(matchPaths(payload, query));

  // Explicit open/closed choices keyed by payload path ("userid",
  // "round:score", …). A path with no entry yet opens only at depth 0.
  let openPaths = $state({});

  // A different payload (event switched underneath a reused instance)
  // starts collapsed again; an unchanged payload keeps the user's
  // expansion state. untrack() reads the prop once, at init.
  let lastJson = untrack(() => json);
  $effect(() => {
    if (json !== lastJson) {
      lastJson = json;
      openPaths = {};
    }
  });

  function openOf(path, depth) {
    const v = openPaths[path];
    return v === undefined ? depth === 0 : v;
  }

  // <details> toggle: record the user's choice so lazy children mount /
  // unmount with it. Writing only on a real change keeps Svelte's `open`
  // re-application a no-op — no toggle/re-render loop.
  function setOpen(path, depth, e) {
    const want = !!e.currentTarget.open;
    if (openOf(path, depth) !== want) openPaths = { ...openPaths, [path]: want };
  }
</script>

{#if payload === null}
  <pre class="mono expl-kv-err">unparseable payload JSON — use the raw toggle</pre>
{:else}
  <div class="expl-kv">
    {#each entries(payload) as [k, v] (k)}
      {#if !matches || matches.has(k)}
        {#snippet node(key, val, depth, path)}
          {#if isObj(val)}
            <details
              class="kv-obj"
              open={openOf(path, depth)}
              ontoggle={(e) => setOpen(path, depth, e)}
            >
              <summary>
                <span class="kv-key">{key}</span>
                <span class="kv-meta muted"
                  >{Array.isArray(val) ? 'array' : 'object'} ({countKeys(val)})</span
                >
              </summary>
              {#if openOf(path, depth)}
                {#each entries(val) as [k2, v2] (k2)}
                  {#if !matches || matches.has(`${path}:${k2}`)}
                    {@render node(k2, v2, depth + 1, `${path}:${k2}`)}
                  {/if}
                {/each}
              {/if}
            </details>
          {:else}
            <div class="kv-row">
              <span class="kv-key">{key}</span>
              <span class={kvClass(val)}>{kvText(val)}</span>
            </div>
          {/if}
        {/snippet}
        {@render node(k, v, 0, k)}
      {/if}
    {/each}
    {#if matches && matches.size === 0}
      <p class="muted">No keys match “{query}”.</p>
    {/if}
  </div>
{/if}
