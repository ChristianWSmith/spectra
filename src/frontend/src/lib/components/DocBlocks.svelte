<script>
  // THE one docs content renderer: AST (lib/docs/markdown.js) → DOM.
  // Every span is interpolated as Svelte TEXT — there is deliberately NO
  // {@html} anywhere in this feature, so HTML embedded in content is
  // inert by construction (repo-authored content, XSS-free by the
  // interpolation itself).
  //
  // Heading map: the popup owns <h1> (document title) and <h2> (section
  // titles), so content headings shift +2 — `#` → <h3>, `##` → <h4>,
  // `###` → <h5> — keeping h1 → h2 → h3 … with no skips (design §2.4).
  //
  // Links: an internal `#…` target is a BUTTON routed through onNav (the
  // hash IS the router — a real `<a href="#…">` would navigate the app
  // away from the view behind the popup, design §3.3); an external href
  // is a normal new-tab anchor (v1 manuals ship none — unverified in
  // WebKitGTK until one does).
  //
  // Search marking: DocsPopup passes its `marked` snippet down (the ONE
  // segment → <mark> builder), and every text leaf renders through
  // `leaf` — so a body hit is marked exactly like a TOC label, still
  // with no {@html} anywhere (the <mark> elements are built from plain
  // segment objects). Marking is PER LEAF: the filter searches a
  // section's WHOLE flattened text, so a phrase crossing markup or
  // block boundaries can select a section whose leaves hold no complete
  // match — that section lists with no visible mark (the honest scope
  // of per-leaf marking; see the `marked` snippet's comment in
  // DocsPopup). Segments re-join to the original string, so
  // textContent is byte-identical whether or not a leaf is marked.
  // Without the prop (DocsPopup is the sole caller today) a leaf
  // renders plain.
  let { blocks = [], onNav = null, marked = null } = $props();
</script>

{#snippet leaf(text)}{#if marked}{@render marked(text)}{:else}{text}{/if}{/snippet}

{#snippet inline(span)}
  {#if span.type === 'text'}{@render leaf(span.text)}
  {:else if span.type === 'code'}<code class="doc-code">{@render leaf(span.text)}</code>
  {:else if span.type === 'strong'}<strong>{#each span.spans as child}{@render inline(child)}{/each}</strong>
  {:else if span.type === 'em'}<em>{#each span.spans as child}{@render inline(child)}{/each}</em>
  {:else if span.type === 'link'}
    {#if span.href.startsWith('#')}
      <button type="button" class="doc-link" onclick={() => onNav?.(span.href.slice(1))}
        >{#each span.spans as child}{@render inline(child)}{/each}</button
      >
    {:else}
      <a href={span.href} target="_blank" rel="noopener noreferrer"
        >{#each span.spans as child}{@render inline(child)}{/each}</a
      >
    {/if}
  {/if}
{/snippet}

{#snippet list(node)}
  {#if node.ordered}
    <ol>
      {#each node.items as item (item)}
        <li>
          {#each item.spans as child}{@render inline(child)}{/each}
          {#if item.children}
            {#each item.children as nested}{@render list(nested)}{/each}
          {/if}
        </li>
      {/each}
    </ol>
  {:else}
    <ul>
      {#each node.items as item (item)}
        <li>
          {#each item.spans as child}{@render inline(child)}{/each}
          {#if item.children}
            {#each item.children as nested}{@render list(nested)}{/each}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#each blocks as block, i (i)}
  {#if block.type === 'heading'}
    {#if block.level === 1}
      <h3>{#each block.spans as child}{@render inline(child)}{/each}</h3>
    {:else if block.level === 2}
      <h4>{#each block.spans as child}{@render inline(child)}{/each}</h4>
    {:else}
      <h5>{#each block.spans as child}{@render inline(child)}{/each}</h5>
    {/if}
  {:else if block.type === 'paragraph'}
    <p>{#each block.spans as child}{@render inline(child)}{/each}</p>
  {:else if block.type === 'code'}
    <pre class="mono"><code>{@render leaf(block.text)}</code></pre>
  {:else if block.type === 'list'}
    {@render list(block)}
  {:else if block.type === 'table'}
    <!-- The canonical table vocabulary (style.css .data-table inside
         .table-scroll) — never a second table style. -->
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            {#each block.header as cell, j (j)}
              <th>{#each cell as child}{@render inline(child)}{/each}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each block.rows as row, j (j)}
            <tr>
              {#each row as cell, k (k)}
                <td>{#each cell as child}{@render inline(child)}{/each}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/each}

<style>
  /* Block rhythm inside the popup's body column. The `doc-` prefix is
     the docs feature's shared component prefix (DocsPopup + DocBlocks —
     design §1.3); `.doc-code` is inline code and is a NEW concept (no
     inline-code class exists in style.css — verified). */
  p {
    margin: 0 0 10px;
    line-height: 1.5;
  }
  h3,
  h4,
  h5 {
    margin: 18px 0 8px;
    font-weight: 600;
    line-height: 1.3;
  }
  h3 {
    font-size: 1.02rem;
  }
  h4 {
    font-size: 0.96rem;
  }
  h5 {
    font-size: 0.9rem;
    color: var(--muted);
  }
  h3:first-child,
  h4:first-child,
  h5:first-child {
    margin-top: 0;
  }
  pre.mono {
    margin: 0 0 12px;
    padding: 10px 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow-x: auto;
    font-size: 0.86em;
    line-height: 1.45;
  }
  code.doc-code {
    font-family: var(--mono);
    font-size: 0.9em;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 4px;
  }
  ul,
  ol {
    margin: 0 0 12px;
    padding-left: 22px;
  }
  li {
    margin: 4px 0;
    line-height: 1.5;
  }
  table {
    margin: 0 0 14px;
  }
  .doc-link {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }
  a {
    color: var(--accent);
  }
</style>
