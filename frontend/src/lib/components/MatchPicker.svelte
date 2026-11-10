<script>
  // Compact match selector for view headers — the Explorer's native
  // <select> ("expl-match") replacement. The trigger button shows the
  // current selection; clicking it opens a popover listing matches the
  // way the Library table presents them (map, score, rounds, duration,
  // extract time, status, matchup) behind a filter box.
  //
  // Keyboard follows CommandPalette's pattern: the filter input owns
  // focus, ↑↓ move the highlight, Enter selects, Esc closes (and returns
  // focus to the trigger); clicking outside closes. Rows are real
  // buttons; aria-activedescendant on the combobox points at the
  // highlighted option.
  import { fmtDate, fmtDuration } from '../fmt.js';
  import StatusChip from './StatusChip.svelte';
  import Popover from './Popover.svelte';

  let { matches = [], value = 0, onselect = () => {}, id = '', placeholder = 'Select match…' } = $props();

  let open = $state(false);
  let query = $state('');
  let active = $state(0);
  let root = $state(null);
  let listEl = $state(null);
  let inputEl = $state(null);
  let triggerEl = $state(null);

  const cur = $derived(matches.find((m) => m.id === value) || null);

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return matches;
    return matches.filter((m) =>
      `${m.map || ''} ${m.ctName || ''} ${m.tName || ''} ${m.id} ${m.path || ''}`
        .toLowerCase()
        .includes(q),
    );
  });

  // Render cap: the picker never mounts the whole library — search still
  // filters the ENTIRE set first, and only the first RENDER_CAP matches
  // of the filtered result are rendered (with a muted hint below when the
  // cap bites: "type more to narrow"). The highlight and keyboard
  // movement operate on the CAPPED list so the active option can never
  // point at a row that is not in the DOM.
  const RENDER_CAP = 200;
  const shown = $derived(filtered.slice(0, RENDER_CAP));
  const capped = $derived(filtered.length > shown.length);

  // Highlight index clamped to the RENDERED list (it shrinks while typing).
  const activeIdx = $derived(shown.length ? Math.min(active, shown.length - 1) : -1);
  const activeId = $derived(
    activeIdx >= 0 && shown[activeIdx] ? `mp-opt-${shown[activeIdx].id}` : '',
  );

  // Same presentation rule as the Library's Matchup column, minus its
  // scoreboard fallback (the picker stays a cheap, synchronous list).
  function matchup(m) {
    return m.ctName && m.tName ? `${m.ctName} vs ${m.tName}` : '';
  }

  function openPop() {
    open = true;
    query = '';
    // Highlight the selected match when it is INSIDE the rendered cap;
    // a match beyond it has no row to highlight, so start at the top.
    const at = shown.findIndex((m) => m.id === value);
    active = at >= 0 ? at : 0;
    requestAnimationFrame(() => inputEl && inputEl.focus());
  }

  function close(refocus = false) {
    if (!open) return;
    open = false;
    query = '';
    if (refocus && triggerEl) triggerEl.focus();
  }

  function togglePop() {
    if (open) close(true);
    else openPop();
  }

  function pick(i) {
    const m = shown[i];
    if (!m) return;
    close(true);
    onselect(m.id);
  }

  function move(d) {
    const n = shown.length;
    if (!n) return;
    const from = activeIdx < 0 ? 0 : activeIdx;
    active = (from + d + n) % n;
  }

  function onInputKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(activeIdx);
    }
  }

  // Popover owns the two dismissal listeners (outside pointerdown and
  // Escape). Focus handling stays here: a keyboard dismissal returns focus
  // to the trigger, a pointer dismissal leaves it where the click put it.
  function closeOnEscape() {
    close(true);
  }

  function closeOnOutside() {
    close(false);
  }

  // Keep the highlighted row in view (DOM-only, no state loop).
  $effect(() => {
    activeIdx;
    open;
    shown.length;
    if (!open) return;
    requestAnimationFrame(() => {
      const el = listEl && listEl.querySelector('.mp-opt.active');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
  });
</script>

<div class="mp" bind:this={root}>
  <button
    type="button"
    class="mp-trigger"
    id={id || null}
    bind:this={triggerEl}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? 'mp-list' : null}
    aria-label="Match"
    onclick={togglePop}
  >
    {#if cur}
      <span class="mp-trigger-map">{cur.map || 'unknown'}</span>
      <span class="mp-trigger-score num"
        ><span class="ct">{cur.scoreCT}</span>–<span class="t">{cur.scoreT}</span></span
      >
      <span class="mp-trigger-id mono muted">#{cur.id}</span>
    {:else}
      <span class="muted">{placeholder}</span>
    {/if}
    <span class="mp-caret" aria-hidden="true"><span class="codicon {open ? 'codicon-chevron-up' : 'codicon-chevron-down'}"></span></span>
  </button>

  <Popover open={open} anchor={root} onClose={closeOnEscape} onOutside={closeOnOutside}>
    <div class="mp-pop">
      <input
        class="input mp-search"
        type="search"
        placeholder="Filter matches…"
        aria-label="Filter matches"
        role="combobox"
        aria-expanded="true"
        aria-controls={filtered.length > 0 ? 'mp-list' : null}
        aria-activedescendant={activeId || null}
        aria-autocomplete="list"
        bind:this={inputEl}
        bind:value={query}
        onkeydown={onInputKey}
      />
      {#if filtered.length > 0}
        <div class="mp-list" id="mp-list" role="listbox" aria-label="Matches" bind:this={listEl}>
          {#each shown as m, i (m.id)}
            <button
              type="button"
              class="mp-opt"
              class:active={i === activeIdx}
              class:current={m.id === value}
              id={'mp-opt-' + m.id}
              role="option"
              aria-selected={m.id === value}
              onmouseenter={() => (active = i)}
              onclick={() => pick(i)}
            >
              <span class="mp-line1">
                <span class="mp-map">{m.map || 'unknown'}</span>
                <span class="mp-score num"
                  ><span class="ct">{m.scoreCT}</span>–<span class="t">{m.scoreT}</span></span
                >
                <span class="spacer"></span>
                <span class="chip round-chip" title="Rounds">{m.realRounds}</span>
                <span class="muted num" title="Duration">{fmtDuration(m.durationS)}</span>
                <StatusChip status={m.status} title={m.error || ''} />
              </span>
              <span class="mp-line2 muted">
                {#if matchup(m)}
                  <span>{matchup(m)}</span>
                {/if}
                <span class="mono">#{m.id}</span>
                <span>{fmtDate(m.extractedAt)}</span>
              </span>
            </button>
          {/each}
        </div>
        {#if capped}
          <p class="mp-empty muted" role="status">
            Showing {RENDER_CAP} of {filtered.length} — type more to narrow.
          </p>
        {/if}
      {:else}
        <p class="mp-empty muted" role="status">
          {query.trim()
            ? `No matches match “${query.trim()}”.`
            : 'No matches yet — import one in the Library.'}
        </p>
      {/if}
      <div class="mp-foot muted">
        <span><span class="codicon codicon-arrow-up"></span><span class="codicon codicon-arrow-down"></span> move</span><span>Enter select</span><span>Esc close</span>
        <span class="spacer"></span>
        <span class="num">{filtered.length}/{matches.length}</span>
      </div>
    </div>
  </Popover>
</div>

<style>
  .mp {
    position: relative;
    display: inline-flex;
  }

  .mp-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 460px;
    min-width: 0;
    padding: 4px 10px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: var(--radius);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }

  .mp-trigger:hover {
    border-color: var(--muted);
  }

  .mp-trigger:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .mp-trigger-map {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mp-trigger-score {
    font-variant-numeric: tabular-nums;
  }

  .mp-trigger-id {
    font-size: 0.86em;
  }

  .mp-caret {
    color: var(--muted);
    font-size: 0.75em;
  }

  .mp-pop {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 35;
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: max-content;
    min-width: 100%;
    max-width: min(640px, 92vw);
    padding: 6px;
    background: var(--widget-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }

  .mp-search {
    width: 100%;
  }

  .mp-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 320px;
    overflow-y: auto;
  }

  .mp-opt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 4px 8px;
    line-height: 1.3;
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }

  .mp-opt:hover {
    background: var(--list-hover);
  }

  .mp-opt.active {
    background: var(--list-hover-strong);
  }

  /* Current selection: amber indent guide + tint, VS Code list-style
     (inset shadow so selecting a row doesn't shift its content). */
  .mp-opt.current {
    background: var(--accent-tint);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .mp-opt.current.active {
    background: var(--list-hover-strong);
  }

  .mp-line1 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .mp-line2 {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.85em;
  }

  .mp-map {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mp-score {
    font-variant-numeric: tabular-nums;
  }

  .mp-empty {
    padding: 6px 8px;
    font-size: 0.9em;
  }

  .mp-foot {
    display: flex;
    gap: 10px;
    padding-top: 4px;
    font-size: 0.8em;
    border-top: 1px solid var(--divider);
  }
</style>
