<script>
  // DocsPopup — the dismissable help sheet: the canonical Dialog
  // wearing a component-owned variant pair (backClass="doc-back" /
  // panelClass="doc-panel", all shape CSS here in :global() — the same
  // pattern MapPackPrompt/MetricOrderDialog use to size their Dialog
  // panels). The shape is NEAR-FULLSCREEN: the panel takes most of the
  // screen behind a small uniform margin on every edge, and the
  // --overlay-55 backdrop shows through that margin (it is still the
  // backdrop-click target). Escape, bare-backdrop click, focus
  // move/return and role="dialog"/aria-modal all come verbatim from
  // Dialog.svelte — never re-implemented here. The ONE key this
  // component intercepts is Escape while the search input holds text:
  // it clears the query and stops propagation so Dialog's backdrop
  // handler never sees the event (an empty input lets Escape through
  // and Dialog closes the sheet as always).
  //
  // State: NONE of it outlives the session (State placement — dialogs
  // never restore: no URL, no viewstate registry, no storage). App
  // owns the transient open/section/token and passes them down; the
  // in-popup scroll position dies with the {#if open} panel; the TOC's
  // `current` is component-local SCROLL-SPY state — syncCurrent()
  // re-derives it from the body's scroll events, TOC/switcher
  // navigation writes the same one variable (one source of truth) —
  // and the search query is component-local transient state too.
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
  // The TOC entry marked current — ONE source of truth for the
  // .active/aria-current highlight: the scroll-spy (syncCurrent)
  // re-derives it from the body's scroll events, and goTo()/switchTo()
  // write it directly for programmatic navigation (the scroll those
  // cause re-derives the same value from the layout — agreement, never
  // a flicker back).
  let current = $state('');
  // The header search — transient component state (never restored):
  // it filters the TOC list only; the body always renders every
  // section of doc.sections (TOC-only filtering — the sheet answers
  // "where is X?" without hiding content the reader may already be
  // reading).
  let query = $state('');

  const doc = $derived(docs.length ? docs[Math.min(docIdx, docs.length - 1)] : null);

  // The filter: trimmed, case-insensitive substring over a section's
  // TITLE + its rendered block text — the same markdown AST DocBlocks
  // renders, flattened to plain text here (no DOM, no layout). Empty
  // needle → every section (today's behaviour).
  const needle = $derived(query.trim().toLowerCase());
  const visibleSections = $derived(
    !doc ? [] : !needle ? doc.sections : doc.sections.filter((s) => searchTextOf(s).includes(needle)),
  );

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

  // --- Search text extraction (title + rendered text, no DOM) --------------
  // Spans are {text|code} leaves or {strong|em|link} nodes carrying their
  // own spans; blocks are heading/paragraph (spans), code (text), list
  // (items with optional nested lists) and table (header + rows of spans).
  function spansText(spans) {
    let out = '';
    for (const sp of spans || []) out += sp.spans ? spansText(sp.spans) : sp.text || '';
    return out;
  }
  function blockText(b) {
    switch (b.type) {
      case 'code':
        return b.text || '';
      case 'list':
        return (b.items || [])
          .map((it) => spansText(it.spans) + ' ' + (it.children || []).map(blockText).join(' '))
          .join(' ');
      case 'table':
        return [...(b.header || []).map(spansText), ...(b.rows || []).flat().map(spansText)].join(' ');
      default:
        return spansText(b.spans); // heading / paragraph
    }
  }
  // Lowercased "title + body" per section, memoized like blockCache.
  const searchCache = new Map();
  function searchTextOf(s) {
    let t = searchCache.get(s);
    if (t === undefined) {
      t = (s.title + '\n' + blocksOf(s).map(blockText).join('\n')).toLowerCase();
      searchCache.set(s, t);
    }
    return t;
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

  // Scroll-spy — `current` follows MANUAL scrolling too (wired to the
  // body's scroll event). The current section is the LAST one whose
  // heading sits at/above the scroll top plus SPY_THRESHOLD px —
  // last-wins, so the highlight hands over the moment a later heading
  // crosses that line and never moves while the reader is idle. At the
  // very bottom of the document the LAST section owns the highlight
  // (its heading may sit further down than the threshold when the final
  // section is taller than the viewport). goTo()/switchTo() still
  // write `current` directly; the scroll event those programmatic
  // scrolls fire re-derives the same value from the layout, so the spy
  // agrees with the clicked section instead of flickering back.
  const SPY_THRESHOLD = 24; // px a heading may sit below the scroll top
  function syncCurrent() {
    if (!bodyEl || !doc || !doc.sections.length) return;
    const atBottom =
      bodyEl.scrollHeight > bodyEl.clientHeight && // jsdom reports 0/0 — never "bottom"
      bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 1;
    if (atBottom) {
      current = doc.sections[doc.sections.length - 1].id;
      return;
    }
    const limit = bodyEl.scrollTop + SPY_THRESHOLD;
    let id = doc.sections[0].id;
    for (const s of doc.sections) {
      const el = bodyEl.querySelector('#' + sectionAnchor(doc.id, s.id));
      if (el && el.offsetTop <= limit) id = s.id; // last one wins
    }
    current = id;
  }

  // Escape inside the search input clears a non-empty query FIRST and
  // stops the event before Dialog's backdrop onkeydown can see it
  // (keydown bubbles input → panel → backdrop; Svelte's delegated walk
  // aborts on cancelBubble). An empty input lets Escape through, so
  // Dialog closes the sheet exactly as before.
  function onSearchKey(e) {
    if (e.key === 'Escape' && query) {
      e.preventDefault();
      e.stopPropagation();
      query = '';
    }
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
      <input
        class="input doc-search"
        type="search"
        placeholder={S.common.searchSections}
        aria-label={S.common.searchSections}
        bind:value={query}
        onkeydown={onSearchKey}
      />
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
        {#each visibleSections as s (s.id)}
          <button
            type="button"
            class="doc-toc-item"
            class:active={current === s.id}
            aria-current={current === s.id ? 'true' : undefined}
            onclick={() => goTo(s.id, true)}>{s.title}</button
          >
        {/each}
        {#if visibleSections.length === 0}
          <p class="doc-toc-empty">{S.common.noSectionsMatch}</p>
        {/if}
      </nav>
      <div class="doc-body" bind:this={bodyEl} onscroll={syncCurrent}>
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
     it through a global selector"). The shape: NEAR-FULLSCREEN — the
     panel fills the viewport behind a small uniform 16px margin (the
     .replay-view precedent: 100vh/vw − 2×16px), centred on all four
     edges, so the --overlay-55 backdrop shows through as a visible
     margin and stays the backdrop-click target. The base .dlg-panel
     border + radius (var(--border), var(--radius)) therefore apply on
     every edge — the old right-sheet override that cancelled the right
     border and the right corners is gone. */
  :global(.dlg-back.doc-back) {
    justify-content: center;
    align-items: center;
    padding: 16px; /* the visible margin: backdrop wash on every edge */
  }
  :global(.dlg-panel.doc-panel) {
    width: calc(100vw - 32px); /* 100vw − 2×16px */
    height: calc(100vh - 32px); /* 100vh − 2×16px */
    max-height: none; /* the base modal cap (70vh) does not apply here */
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
  /* The header search: left of Close, shrinking with the header
     (the title keeps flex: 1). */
  .doc-search {
    flex: 0 1 220px;
    min-width: 120px;
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
  /* The honest empty state when the search filter leaves nothing. */
  .doc-toc-empty {
    color: var(--muted);
    font-size: 0.9em;
    padding: 5px 8px; /* aligns with the buttons it stands in for */
  }
  .doc-switch {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-bottom: 8px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--divider);
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
