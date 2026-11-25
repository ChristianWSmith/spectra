<script>
  // THE manual's body: a section's markdown source (lib/docs/render.js) as sanitized HTML.
  // The HTML is marked, then DOMPurify-sanitized, so it is the only {@html} in the manual.
  //
  // Links: an in-manual link (#section) is routed through onNav (the hash is the popup's router, so
  // a real navigation would leave the view behind it). Any other link opens in a new tab.
  //
  // Search: `needle` (lowercase) is marked inside every text leaf with <mark class="doc-hit">; the
  // popup steps through those marks. Marks are rebuilt whenever the HTML or the needle changes; the
  // text itself is unchanged.
  import { renderMarkdown } from '../docs/render.js';

  let { source = '', needle = '', onNav = null } = $props();
  const html = $derived(renderMarkdown(source));

  function unmark(node) {
    for (const hit of node.querySelectorAll('mark.doc-hit')) {
      hit.replaceWith(document.createTextNode(hit.textContent));
    }
    node.normalize();
  }

  function markLeaf(textNode, needle) {
    const text = textNode.nodeValue;
    const lower = text.toLowerCase();
    let at = lower.indexOf(needle);
    if (at < 0) return;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (at >= 0) {
      if (at > last) frag.append(text.slice(last, at));
      const hit = document.createElement('mark');
      hit.className = 'doc-hit';
      hit.textContent = text.slice(at, at + needle.length);
      frag.append(hit);
      last = at + needle.length;
      at = lower.indexOf(needle, last);
    }
    if (last < text.length) frag.append(text.slice(last));
    textNode.replaceWith(frag);
  }

  function markIn(node, needle) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const leaves = [];
    while (walker.nextNode()) leaves.push(walker.currentNode);
    for (const leaf of leaves) markLeaf(leaf, needle);
  }

  // docBody routes the body's clicks and keeps its search marks in step with the HTML and the needle.
  function docBody(node, params) {
    let p = params;
    function onClick(e) {
      const a = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
      if (!a || !node.contains(a)) return;
      e.preventDefault();
      p.onNav?.(a.getAttribute('href').slice(1));
    }
    function apply() {
      unmark(node);
      if (p.needle) markIn(node, p.needle);
    }
    node.addEventListener('click', onClick);
    apply();
    return {
      update(next) {
        p = next;
        apply();
      },
      destroy() {
        node.removeEventListener('click', onClick);
      },
    };
  }
</script>

<div class="doc-content" use:docBody={{ html, needle, onNav }}>{@html html}</div>

<style>
  /* The HTML is injected, so these reach it through :global. The `doc-` prefix is the manual's
     shared component prefix (DocsPopup + DocBlocks). */
  .doc-content :global(p) {
    margin: 0 0 10px;
    line-height: 1.5;
  }
  .doc-content :global(h3),
  .doc-content :global(h4),
  .doc-content :global(h5) {
    margin: 18px 0 8px;
    font-weight: 600;
    line-height: 1.3;
  }
  .doc-content :global(h3) {
    font-size: 1.02rem;
  }
  .doc-content :global(h4) {
    font-size: 0.96rem;
  }
  .doc-content :global(h5) {
    font-size: 0.9rem;
    color: var(--muted);
  }
  .doc-content :global(h3:first-child),
  .doc-content :global(h4:first-child),
  .doc-content :global(h5:first-child) {
    margin-top: 0;
  }
  .doc-content :global(pre) {
    margin: 0 0 12px;
    padding: 10px 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 0.86em;
    line-height: 1.45;
  }
  .doc-content :global(code) {
    font-family: var(--mono);
    font-size: 0.9em;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 4px;
  }
  .doc-content :global(pre code) {
    background: none;
    border: 0;
    padding: 0;
  }
  .doc-content :global(ul),
  .doc-content :global(ol) {
    margin: 0 0 12px;
    padding-left: 22px;
  }
  .doc-content :global(li) {
    margin: 4px 0;
    line-height: 1.5;
  }
  .doc-content :global(table) {
    margin: 0 0 14px;
  }
  .doc-content :global(.doc-link) {
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }
  .doc-content :global(a) {
    color: var(--accent);
  }
</style>
