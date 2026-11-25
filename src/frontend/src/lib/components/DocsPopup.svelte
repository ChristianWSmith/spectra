<script>
  // DocsPopup — the help sheet: the canonical Dialog wearing the manual's panel shape (see the style
  // block). The sheet lists the manual's sections, searches them, and renders the chosen section's
  // body. Escape, backdrop click, focus and role come from Dialog.svelte.
  //
  // The navigation is deliberately flat: one list of sections in document order. Clicking a
  // section (or an in-manual link) scrolls its heading into view. Search filters the list and marks
  // the matching text in the body.
  //
  // State: transient (none of it outlives the session): the open document, the query and the
  // current section. Content is generic: every manual in the registry (docs/manuals/index.js
  // self-registers them); the switcher appears only when there is more than one.
  import { tick } from 'svelte';
  import Dialog from './Dialog.svelte';
  import DocBlocks from './DocBlocks.svelte';
  import { listDocs, sectionAnchor } from '../docs/registry.js';
  import '../docs/manuals/index.js'; // self-registering manuals
  import * as S from '../strings/index.js'; // chrome copy (strings-audit Check B)

  let { open = false, section = null, token = 0, onClose = () => {} } = $props();

  let docs = $state([]);
  let docIdx = $state(0);
  let bodyEl = $state(null);
  // The section the list highlights: set by goTo (a click, an in-manual link, the opening section).
  let current = $state('');
  // The header search: marks the matching text in the content (the section headings and the body,
  // never the section list) and steps through the matches.
  let query = $state('');
  let searchEl = $state(null);
  let matchIdx = $state(0);
  let matchCount = $state(0);

  const doc = $derived(docs.length ? docs[Math.min(docIdx, docs.length - 1)] : null);
  const needle = $derived(query.trim().toLowerCase());

  // Refresh the registry view on every open: manuals register as an import side effect, and one
  // registered after first paint must show up on the next open.
  $effect.pre(() => {
    if (open) docs = listDocs();
  });

  // Scroll-to-section on open, and on a re-requested target (the same section asked for again still
  // re-targets: the token changes). Opening only scrolls; focus stays where Dialog put it.
  $effect(() => {
    if (!open) return;
    void token;
    if (!doc || !bodyEl) return;
    goTo(section || doc.sections[0].id, false);
  });

  // Scroll a section's heading to the top of the body. A click or an in-manual link also moves focus
  // to the heading (userInitiated).
  function goTo(sectionId, userInitiated = false) {
    if (!bodyEl || !doc) return;
    const el = bodyEl.querySelector('#' + sectionAnchor(doc.id, sectionId));
    if (!el) {
      // An unknown target goes to the top of this document. Never a hash change: the hash is the router.
      current = doc.sections[0].id;
      bodyEl.scrollTop = 0;
      return;
    }
    current = sectionId;
    // bodyEl is position:relative, so offsetTop is section-relative.
    bodyEl.scrollTop = Math.max(0, el.offsetTop - 8);
    if (userInitiated) el.focus(); // section headings carry tabindex="-1"
  }

  // The content's match marks, in document order (the section headings and the body's marks).
  function marksOf() {
    return bodyEl ? [...bodyEl.querySelectorAll('mark.doc-hit')] : [];
  }

  // Show the current match: its mark wears .current, the body scrolls to it, and its section
  // becomes the one the list highlights.
  function showMatch() {
    const marks = marksOf();
    marks.forEach((m, i) => m.classList.toggle('current', i === matchIdx));
    const el = marks[matchIdx];
    if (!el || !bodyEl) return;
    bodyEl.scrollTop = Math.max(0, el.offsetTop - 8);
    const h2 = el.closest('.doc-section')?.querySelector('h2');
    const sec = h2 && doc ? doc.sections.find((s) => sectionAnchor(doc.id, s.id) === h2.id) : null;
    if (sec) current = sec.id;
  }

  // Step to the next (dir 1) or previous (dir -1) match, wrapping at both ends. Focus stays in the
  // search box.
  function stepMatch(dir) {
    const n = matchCount;
    if (!n) return;
    matchIdx = (matchIdx + dir + n) % n;
    showMatch();
  }

  // A new query or a new document starts on the first match. The marks are rebuilt by DocBlocks
  // after the render, so the count is read after the next tick.
  $effect(() => {
    void needle;
    void docIdx;
    void doc;
    tick().then(() => {
      matchCount = marksOf().length;
      matchIdx = 0;
      showMatch();
    });
  });

  // Escape in the search box clears a non-empty query first and stops there, so Dialog's backdrop
  // never sees it. An empty box lets Escape through (Dialog closes the sheet). Enter steps to the
  // next match, Shift+Enter to the previous; neither can close the sheet.
  function onSearchKey(e) {
    if (e.key === 'Escape' && query) {
      e.preventDefault();
      e.stopPropagation();
      query = '';
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      stepMatch(e.shiftKey ? -1 : 1);
    }
  }

  function switchTo(i) {
    docIdx = i;
    current = docs[i].sections[0].id;
    if (bodyEl) bodyEl.scrollTop = 0;
  }

  // Search-hit rendering for the section headings: plain segments as text, matched segments as
  // <mark class="doc-hit">. Matching is a plain lowercase indexOf, never a regex.
  function markSegments(text, q) {
    if (!q) return [{ text, hit: false }];
    const lower = text.toLowerCase();
    const out = [];
    let from = 0;
    for (;;) {
      const at = lower.indexOf(q, from);
      if (at < 0) break;
      if (at > from) out.push({ text: text.slice(from, at), hit: false });
      out.push({ text: text.slice(at, at + q.length), hit: true });
      from = at + q.length;
    }
    if (from < text.length) out.push({ text: text.slice(from), hit: false });
    return out;
  }
</script>

{#snippet marked(text)}{#each markSegments(text, needle) as seg, i (i)}{#if seg.hit}<mark class="doc-hit">{seg.text}</mark>{:else}{seg.text}{/if}{/each}{/snippet}

{#if doc}
  <Dialog open={open} label={doc.title} backClass="doc-back" panelClass="doc-panel" {onClose}>
    <div class="doc-head">
      <h1>{doc.title}</h1>
      {#if needle}
        <button
          class="btn doc-find-btn"
          type="button"
          disabled={matchCount === 0}
          title={S.common.searchPrev}
          aria-label={S.common.searchPrev}
          onclick={() => {
            stepMatch(-1);
            searchEl?.focus();
          }}
        >
          <span class="codicon codicon-chevron-up" aria-hidden="true"></span>
        </button>
        <button
          class="btn doc-find-btn"
          type="button"
          disabled={matchCount === 0}
          title={S.common.searchNext}
          aria-label={S.common.searchNext}
          onclick={() => {
            stepMatch(1);
            searchEl?.focus();
          }}
        >
          <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
        </button>
      {/if}
      <input
        class="input doc-search"
        type="search"
        placeholder={S.common.searchSections}
        aria-label={S.common.searchSections}
        bind:value={query}
        bind:this={searchEl}
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
        {#each doc.sections as s (s.id)}
          <button
            type="button"
            class="doc-toc-item"
            class:active={current === s.id}
            aria-current={current === s.id ? 'true' : undefined}
            onclick={() => goTo(s.id, true)}>{s.title}</button
          >
        {/each}
      </nav>
      <div class="doc-body" bind:this={bodyEl}>
        {#each doc.sections as s (s.id)}
          <section class="doc-section">
            <!-- The anchor is composed from hand-authored ids (registry.sectionAnchor), stable across rewording. -->
            <h2 id={sectionAnchor(doc.id, s.id)} tabindex="-1">{@render marked(s.title)}</h2>
            {#if s.placeholder}
              <p class="doc-placeholder">{S.common.guideComingSoon}</p>
            {:else}
              <DocBlocks source={s.blocks} {needle} onNav={(id) => goTo(id, true)} />
            {/if}
          </section>
        {/each}
      </div>
    </div>
  </Dialog>
{/if}

<style>
  /* The search marks in the content: every match in the accent tint, the current one solid. */
  .doc-body :global(mark.doc-hit) {
    background: var(--accent-40);
    color: inherit;
    border-radius: 2px;
  }
  .doc-body :global(mark.doc-hit.current) {
    background: var(--accent);
    color: var(--bg);
    box-shadow: 0 0 0 2px var(--accent);
  }

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
  /* The match-stepper buttons (M1): glyph-sized, glued to the input by
     .doc-head's gap — they never grow with the header. */
  
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
    display: block;
    width: 100%;
    box-sizing: border-box;
    height: auto;
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: var(--text);
    font: inherit;
    font-size: 0.92em;
    line-height: 1.3;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
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
  /* --- Two-tier contents list (N3) ---------------------------------------
     A major's row is its nav button plus the subsection toggle (a
     sibling — nested buttons are invalid HTML); its minors sit in an
     indented column beneath. The toggle inherits .doc-toc button's
     reset, so it only needs to size itself and mute its glyph. */
  
  
  
  
  /* Dual highlight: the entry in view wears .active (unchanged — the
     wash PLUS the weight); the major CONTAINING it wears
     .parent-active — the same wash without the weight, plus an accent
     rail — so the nav reads "chapter + section" at a glance, and only
     ONE entry (the true current) ever carries aria-current. */
  
  /* The honest empty state when the search filter leaves nothing. */
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
  /* --- Section tiers + separators (C4, 2026-11-15) -----------------------
     The owner's report: every section heading renders at ONE size, so the
     metric chapter's subsections read as peers of their own chapter.
     The tier criterion is the registry's `parent` field (absent = major,
     set = minor, rendered as .doc-section.major/.minor) — applied
     GLOBALLY on that criterion, not scoped to #metric-language, so any
     future minor (or manual) gets the same treatment without a new
     selector (metric-language is the only major with minors today).

     The two h2 rules DECLARE the ladder instead of leaving it to the
     UA: majors keep the 1.5em default they already rendered at
     (font-size-less parent → 1.5em ≈ 1.5rem, so tier 1 is a no-op), and
     minors step down one clear size — level with the doc-title h1
     (1.15rem) and still above DocBlocks' content h3 (1.02rem), so the
     h1 → h2 → h3 ladder keeps no skip. NOT --fs-section: that is the
     panel-chrome section-label vocabulary, the wrong concept here.

     Separators are CSS, never content: the markdown subset degrades a
     literal `---` to text (pinned by docsmd.test.js), so each major
     AFTER the first carries the divider rule. The colour is
     var(--divider) — the same border .doc-switch uses — with margin and
     padding so the line does not crowd the heading above it. */
  .doc-body .doc-section > h2 {
    font-size: 1.5rem;
  }
  
  
  .doc-placeholder {
    color: var(--muted);
    font-style: italic;
  }
</style>
