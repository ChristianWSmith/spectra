<script>
  // TokenSelect — the ONE type-to-search MULTI-select (the chip/token
  // input, "like in Jira"): type (or hit the arrow) to search the
  // caller's list, pick an entry and it lands INSIDE the field as a chip
  // with its own ✕ — no rows to add, no per-row dropdown.
  //
  // The caller owns the two interesting halves: the ITEM LIST (fetched
  // once — here the match-scoped metric catalog) and what a pick/remove
  // DOES (add an id to the selection set, drop one from it). This owns
  // the rest:
  //   * case-insensitive substring filtering over `text(item)` (first
  //     `cap` rows — 10), focus/typing/arrow opening the anchored panel;
  //   * NO DUPLICATES BY CONSTRUCTION: an item whose `id` is already in
  //     `tokens` never offers itself again, whatever the caller passes —
  //     the selection is a SET and the list cannot re-add to it;
  //   * ↑↓/Enter select, Esc (Popover) / outside pointer / focus leaving
  //     the widget dismiss (the focusout guard must not fire while the
  //     pointer is over a row — same rule as SuggestInput);
  //   * chips render INSIDE the field, each with a ✕ button whose aria
  //     comes from the caller's `removeAria` {name} template; **Backspace
  //     on an empty field removes the last chip** (the keyboard's fast
  //     path out — focus stays in the field), and removing through a ✕
  //     returns focus to the field, since the button unmounts with it.
  //
  // `tokens` is the RENDER order (the caller composes it — Reports uses
  // the metric-order sequence so chips read like the exported document);
  // the field is full-width by default, the panel anchors per `align`.
  import Popover from './Popover.svelte';
  import { fill } from '../strings/index.js';

  let {
    id = '',
    placeholder = '',
    ariaLabel = '',
    // {name} template for every chip's remove button. Callers pass their
    // catalog value (Reports: 'Remove {name}'); the default keeps the
    // button named even for a caller with no copy of its own.
    removeAria = 'Remove {name}',
    inputClass = '',
    wrapClass = '',
    items = [],
    // null → String(item); the caller's own search text otherwise.
    text = null,
    cap = 10,
    // 'end' anchors the panel to the field's right edge, 'start' to its
    // left — either way it grows inward, never off-screen.
    align = 'start',
    // The picked entries, in RENDER order: {id, label} (`id` is the
    // identity the list filters on and the remove callback carries).
    tokens = [],
    onselect = () => {},
    onremove = () => {},
  } = $props();

  const listId = $derived(id ? `${id}-list` : 'tk-list');

  let open = $state(false);
  let active = $state(0);
  let root = $state(null);
  let field = $state(null); // the <input> — focus return after a chip's ✕
  // The search query is widget-local working text (never a value the
  // caller reads): picks and removals clear it, a typo is never rejected.
  let value = $state('');

  const searchText = $derived(text || ((it) => String(it ?? '')));

  // The set already held, and what the list may therefore offer.
  const picked = $derived(new Set(tokens.map((t) => t.id)));
  const candidates = $derived(items.filter((it) => !picked.has(it.id)));

  const matches = $derived.by(() => {
    const q = value.trim().toLowerCase();
    if (!q) return candidates.slice(0, cap);
    return candidates.filter((it) => searchText(it).toLowerCase().includes(q)).slice(0, cap);
  });

  // Nothing to show → the panel (and its dismissal listeners) are gone;
  // `open` survives so typing a match again reopens without a refocus.
  const shown = $derived(open && matches.length > 0);
  const activeIdx = $derived(matches.length ? Math.min(active, matches.length - 1) : -1);
  const activeId = $derived(activeIdx >= 0 ? `${listId}-opt-${activeIdx}` : '');

  function dismiss() {
    open = false;
    active = 0;
  }

  function pick(item) {
    dismiss();
    value = '';
    onselect(item);
    field?.focus();
  }

  // remove drops one chip and hands focus back to the field — the ✕
  // button unmounts with it, and a keyboard user must not land on <body>.
  function remove(tok) {
    onremove(tok.id);
    field?.focus();
  }

  function removeLast() {
    if (tokens.length) remove(tokens[tokens.length - 1]);
  }

  function togglePanel() {
    if (open) {
      dismiss();
      return;
    }
    open = true;
    field?.focus(); // the focus handler opens the panel too (typing/focus)
  }

  function move(d) {
    const n = matches.length;
    if (!n) return;
    if (!open) {
      // First arrow on a closed panel lands on the edge row it points at.
      active = d > 0 ? 0 : n - 1;
      open = true;
      return;
    }
    const from = activeIdx < 0 ? 0 : activeIdx;
    active = (from + d + n) % n;
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter' && shown && activeIdx >= 0) {
      e.preventDefault();
      pick(matches[activeIdx]);
    } else if (e.key === 'Backspace' && !value && tokens.length) {
      // Empty field + Backspace → the last chip goes (header comment).
      e.preventDefault();
      removeLast();
    }
    // Esc is Popover's (document-level) — see onClose.
  }

  // Tab/shift-tab away closes; a pointer that moves focus INSIDE the
  // widget (a chip's ✕, a row) must not — and a click that leaves is
  // already handled by Popover's outside-pointerdown, which is why a
  // null relatedTarget (jsdom, or focus landing on nothing) stays put.
  function onFocusOut(e) {
    const to = e.relatedTarget;
    if (to && root && !root.contains(to)) dismiss();
  }
</script>

<span class="tk {wrapClass}" bind:this={root}>
  {#each tokens as tok (tok.id)}
    <span class="chip tk-tok">
      {tok.label}
      <button
        type="button"
        class="tk-x"
        aria-label={fill(removeAria, { name: tok.label })}
        onclick={() => remove(tok)}
        ><span class="codicon codicon-close"></span></button
      >
    </span>
  {/each}
  <input
    {id}
    class="tk-in {inputClass}"
    type="search"
    placeholder={placeholder}
    aria-label={ariaLabel || null}
    role="combobox"
    aria-expanded={shown}
    aria-controls={shown ? listId : null}
    aria-activedescendant={shown ? activeId : null}
    aria-autocomplete="list"
    {value}
    oninput={(e) => {
      value = e.currentTarget.value;
      open = true;
    }}
    onfocus={() => (open = true)}
    onkeydown={onKey}
    onfocusout={onFocusOut}
    bind:this={field}
  />
  <button
    type="button"
    class="tk-arrow"
    aria-label={ariaLabel || null}
    aria-expanded={shown}
    onclick={togglePanel}
    ><span class="codicon codicon-chevron-down"></span></button
  >
  <Popover open={shown} anchor={root} onClose={dismiss}>
    <div
      class="tk-pop tk-pop-{align}"
      id={listId}
      role="listbox"
      aria-multiselectable="true"
      aria-label={ariaLabel || null}
    >
      {#each matches as item, i (i)}
        <button
          type="button"
          class="tk-opt"
          class:active={i === activeIdx}
          id="{listId}-opt-{i}"
          role="option"
          aria-selected={picked.has(item.id)}
          onmouseenter={() => (active = i)}
          onclick={() => pick(item)}
        >
          {searchText(item)}
        </button>
      {/each}
    </div>
  </Popover>
</span>

<style>
  /* The token field (tk-): a full-width input box whose chips sit
     inside it before the text, a caret button toggling the anchored
     panel (tk-pop — same shape as SuggestInput's sg-pop). */
  .tk {
    position: relative;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    width: 100%;
    min-width: 0;
    padding: 3px 6px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: var(--radius);
    line-height: 1.2;
  }

  .tk:focus-within {
    border-color: var(--focus);
  }

  /* The chip INSIDE the field: the base .chip is muted gray on a
     near-invisible wash (public/style.css), which reads as disabled
     sitting in the input — the picked token is the point of the field,
     so it takes an accent presence instead: `--text` on an
     `--accent-12` wash with an `--accent-40` border — the accent
     vocabulary `.chip.flag` and the suggestion-row hover already speak.
     Component-owned styling under tk-: never a new global .chip.*
     concept class. */
  .tk-tok {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
    background: var(--accent-12);
    border-color: var(--accent-40);
  }

  .tk-x {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0 1px;
    font-size: 0.9em;
    line-height: 1;
  }

  .tk-x:hover {
    color: var(--danger);
  }

  /* The query text: no box of its own (the .tk wrapper carries the
     field's border), it just takes the room the chips leave. */
  .tk-in {
    flex: 1 1 8ch;
    min-width: 8ch;
    padding: 0;
    background: none;
    border: none;
    outline: none;
    color: var(--text);
    font: inherit;
  }

  .tk-in::placeholder {
    color: var(--muted);
  }

  .tk-arrow {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }

  .tk-arrow:hover {
    color: var(--text);
  }

  .tk-pop {
    position: absolute;
    top: calc(100% + 4px);
    z-index: 25;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: max-content;
    min-width: 100%;
    max-width: min(420px, calc(100vw - 32px));
    max-height: 280px;
    overflow-y: auto;
    padding: 4px;
    background: var(--widget-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }

  .tk-pop-start {
    left: 0;
  }

  .tk-pop-end {
    right: 0;
  }

  :global([data-theme='light']) .tk-pop {
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
  }

  .tk-opt {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    background: none;
    border: none;
    border-radius: var(--radius-md);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .tk-opt:hover {
    background: var(--accent-12);
  }

  /* Keyboard highlight: the row Enter would pick keeps an accent guide
     so it stays visible while the pointer hovers elsewhere. */
  .tk-opt.active {
    background: var(--accent-12);
    box-shadow: inset 2px 0 0 var(--accent);
  }
</style>
