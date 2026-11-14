<script>
  // DocsPopup — the dismissable help side-sheet: the canonical Dialog
  // wearing a component-owned variant pair (backClass="doc-back" /
  // panelClass="doc-panel", all shape CSS here in :global() — the same
  // pattern MapPackPrompt/MetricOrderDialog use to size their Dialog
  // panels). Escape, bare-backdrop click, focus move/return and
  // role="dialog"/aria-modal all come verbatim from Dialog.svelte —
  // never re-implemented here.
  //
  // State: NONE of it is this component's. App owns the transient
  // open/section/token (State placement — dialogs never restore: no
  // URL, no viewstate registry, no storage) and passes them down; the
  // in-popup scroll position dies with the {#if open} panel, and the
  // TOC's `current` is local "last navigation" state (scroll-spy is
  // deliberately deferred).
  //
  // Content is generic: any number of manuals from the registry
  // (docs/manuals/index.js self-registers them), the switcher renders
  // only while there is more than one, and DocBlocks is the one
  // AST → DOM renderer. A new manual never touches this file.
  import Dialog from './Dialog.svelte';
  import DocBlocks from './DocBlocks.svelte';
  import { listDocs, sectionAnchor } from '../docs/registry.js';
  import { parseBlocks } from '../docs/markdown.js';
  import '../docs/manuals/index.js'; // self-registering manuals
  import * as S from '../strings/index.js'; // chrome copy (strings-audit Check B)

  let { open = false, section = null, token = 0, onClose = () => {} } = $props();

  let docs = $state([]);
  let docIdx = $state(0);
  let bodyEl = $state(null);
  // The TOC entry of the LAST navigation (open → target section, TOC
  // click, back-to-top → first). Not a scroll-spy — see design §9.4.
  let current = $state('');

  const doc = $derived(docs.length ? docs[Math.min(docIdx, docs.length - 1)] : null);

  // Refresh the registry view on every open: manuals register as an
  // import side effect, and one registered after first paint must show
  // up on the next open (the switcher condition is listDocs().length > 1).
  // $effect.pre so the very first render after open already sees it —
  // no empty-TOC flash.
  $effect.pre(() => {
    if (open) docs = listDocs();
  });

  // Scroll-to-section on open / on a re-requested target (design §3.2).
  // Runs post-render, when the {#if open} panel and its body exist. On
  // OPEN it only scrolls — focus stays where Dialog put it (the panel),
  // so Dialog's open-time capture of document.activeElement is never
  // disturbed and focus-return keeps the canonical contract. TOC clicks
  // and internal doc links call goTo() directly with userInitiated=true
  // (scroll + focus the section heading).
  $effect(() => {
    if (!open) return;
    void token; // re-request token: asking for the SAME section again
    // (sidebar Help pressed twice) still re-targets — value-keyed
    // effects would otherwise not re-run on an identical section.
    if (!doc || !bodyEl) return;
    goTo(section || doc.sections[0].id, false);
  });

  // Parsed blocks, memoized per section object (sections are stable
  // post-registration; a re-registered doc yields fresh objects and
  // therefore fresh parses).
  const blockCache = new Map();
  function blocksOf(s) {
    let blocks = blockCache.get(s);
    if (!blocks) {
      blocks = parseBlocks(s.blocks);
      blockCache.set(s, blocks);
    }
    return blocks;
  }

  function goTo(sectionId, userInitiated = false) {
    if (!bodyEl || !doc) return;
    const el = bodyEl.querySelector('#' + sectionAnchor(doc.id, sectionId));
    if (!el) {
      // Unknown target: back to this document's top. Never a hash
      // change — the hash is the router (design §3.3).
      current = doc.sections[0].id;
      bodyEl.scrollTop = 0;
      return;
    }
    current = sectionId;
    // bodyEl is position:relative, so offsetTop is section-relative.
    // (jsdom has no layout — offsetTop reads 0 there, which the driver
    // pins as the scrollTop FORMULA, never a pixel position.)
    bodyEl.scrollTop = Math.max(0, el.offsetTop - 8);
    if (userInitiated) el.focus(); // section headings carry tabindex="-1"
  }

  function backToTop() {
    if (!bodyEl) return;
    bodyEl.scrollTop = 0;
    current = doc.sections[0].id;
  }

  function switchTo(i) {
    docIdx = i;
    const d = docs[i];
    current = d.sections[0].id;
    if (bodyEl) bodyEl.scrollTop = 0;
  }
</script>

{#if doc}
  <Dialog open={open} label={doc.title} backClass="doc-back" panelClass="doc-panel" {onClose}>
    <div class="doc-head">
      <h1>{doc.title}</h1>
      <button class="btn" type="button" title={S.common.closeHelp} aria-label={S.common.closeHelp} onclick={onClose}>
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </div>
    <div class="doc-main">
      <nav class="doc-toc" aria-label={S.common.tocLabel}>
        {#if docs.length > 1}
          <div class="doc-switch">
            {#each docs as d, i (d.id)}
              <button
                type="button"
                class="doc-switch-btn"
                class:active={i === docIdx}
                aria-current={i === docIdx ? 'true' : undefined}
                onclick={() => switchTo(i)}>{d.title}</button
              >
            {/each}
          </div>
        {/if}
        {#each doc.sections as s (s.id)}
          <button
            type="button"
            class="doc-toc-item"
            class:active={current === s.id}
            aria-current={current === s.id ? 'true' : undefined}
            onclick={() => goTo(s.id, true)}>{s.title}</button
          >
        {/each}
        <button type="button" class="doc-toc-top" onclick={backToTop}>{S.common.backToTop}</button>
      </nav>
      <div class="doc-body" bind:this={bodyEl}>
        {#each doc.sections as s (s.id)}
          <section class="doc-section">
            <!-- The anchor is composed from HAND-AUTHORED ids
                 (registry.sectionAnchor) — stable across rewording, and
                 tabindex -1 lets goTo() land focus on user navigation. -->
            <h2 id={sectionAnchor(doc.id, s.id)} tabindex="-1">{s.title}</h2>
            {#if s.placeholder}
              <p class="doc-placeholder">{S.common.guideComingSoon}</p>
            {:else}
              <DocBlocks blocks={blocksOf(s)} onNav={(id) => goTo(id, true)} />
            {/if}
          </section>
        {/each}
      </div>
    </div>
  </Dialog>
{/if}

<style>
  /* Dialog owns the backdrop/panel ELEMENTS, hence :global() — the
     pk-/mo-/cf- component-panel precedent (MapPackPrompt: "The panel
     element belongs to Dialog.svelte, so the prompt's own size reaches
     it through a global selector"). The shape: a right-hugging full-
     height sheet that leaves the left of the view visible behind the
     existing --overlay-55 wash — "covers the current view, though not
     entirely", and that visible strip is the backdrop-click target. */
  :global(.dlg-back.doc-back) {
    justify-content: flex-end; /* sheet hugs the right edge */
    align-items: stretch;
    padding: 0;
  }
  :global(.dlg-panel.doc-panel) {
    width: min(880px, 70vw);
    height: 100vh;
    max-height: 100vh;
    border-radius: var(--radius) 0 0 var(--radius);
    border-right: none;
    overflow: hidden; /* the panel is a flex column; the BODY scrolls */
    padding: 0;
    gap: 0;
  }

  .doc-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .doc-head h1 {
    flex: 1;
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
  }
  .doc-main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .doc-toc {
    flex: 0 0 auto;
    width: 230px;
    overflow-y: auto;
    padding: 10px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: stretch;
  }
  /* Both the section entries and the switcher's manual entries are
     buttons in this column — one button vocabulary for the whole nav. */
  .doc-toc button {
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: var(--text);
    font: inherit;
    font-size: 0.92em;
    text-align: left;
    padding: 5px 8px;
    cursor: pointer;
  }
  .doc-toc button:hover {
    background: var(--btn-hover-bg);
  }
  .doc-toc button.active {
    background: var(--btn-hover-bg);
    font-weight: 600;
  }
  .doc-switch {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-bottom: 8px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--divider);
  }
  .doc-toc-top {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--divider);
    border-radius: 0;
    color: var(--muted);
  }
  .doc-body {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    overscroll-behavior: contain; /* wheel input never escapes to the view behind */
    position: relative; /* goTo() reads section offsetTop against this */
    padding: 16px 22px 48px;
  }
  .doc-placeholder {
    color: var(--muted);
    font-style: italic;
  }
</style>
