<script>
  // SuggestInput — the ONE suggestion dropdown behind every "search
  // input that offers what is actually in the library" (the canonical
  // way: Library's map facet, Library's player facet, the Profiles
  // search and the profile finder all render through here instead of
  // growing three copies of the same popover).
  //
  // The caller owns the two interesting halves: the ITEM LIST (fetched
  // once — store.ListMapNames, ProfileService.ListPlayers) and what a
  // pick DOES (set the facet value, or navigate). This owns the rest:
  // case-insensitive substring filtering over the item's search text
  // (first `cap` rows — 10), focus/typing opening the anchored panel,
  // ↑↓/Enter selection, and dismissal (Esc, an outside pointerdown, or
  // focus leaving the widget — see the focusout guard, which must not
  // fire while the pointer is over a row).
  //
  // A value that matches nothing is never rejected: the input keeps its
  // text and the caller's facet keeps doing its LIKE filter — a
  // suggestion is a shortcut to an exact name, not a constraint.
  //
  // The hint is owned here too: a kind='player' box wears THE standard
  // player-search hint (owner ruling — "Search players...", three ASCII
  // periods, not the … glyph) unless the caller passes its own, so no
  // call site re-spells it. A kind='text' box (Library's map facet) keeps
  // passing its own placeholder as before.
  import Popover from './Popover.svelte';
  import { fmt1 } from '../fmt.js';
  import { careerAdrRows, onMetricDone } from '../services.js';

  const PLAYER_SEARCH_HINT = 'Search players...';

  let {
    id = '',
    placeholder = '',
    ariaLabel = '',
    inputClass = '',
    wrapClass = '',
    items = [],
    // null → the kind's own search text (player rows match on
    // name + SteamID, exactly like PlayerPicker's filter).
    text = null,
    cap = 10,
    // 'end' anchors the panel to the input's right edge (inputs that sit
    // on the right of a header), 'start' to its left edge (left-side
    // inputs) — either way the panel grows inward, never off-screen.
    align = 'end',
    // 'text' renders text(item); 'player' renders the one player row
    // (name · matches · ADR) every player suggestion shows.
    kind = 'text',
    value = $bindable(''),
    onselect = () => {},
  } = $props();

  const listId = $derived(id ? `${id}-list` : 'sg-list');

  // The rendered hint: the caller's own placeholder wins; otherwise a
  // player-kind box gets the standard hint (see the header comment).
  const hint = $derived(placeholder || (kind === 'player' ? PLAYER_SEARCH_HINT : ''));

  let open = $state(false);
  let active = $state(0);
  let root = $state(null);

  const searchText = $derived(
    text ||
      (kind === 'player'
        ? (it) => `${it.name || ''} ${it.steamId || ''}`
        : (it) => String(it ?? '')),
  );

  const matches = $derived.by(() => {
    const q = value.trim().toLowerCase();
    if (!q) return items.slice(0, cap);
    return items.filter((it) => searchText(it).toLowerCase().includes(q)).slice(0, cap);
  });

  // The player row's career ADR reads the STORED `career_adr` metric
  // rows through the one canonical career read (services.careerAdrRows
  // — the same bucket Profiles' ADR column uses), never the ListPlayers
  // row: ProfileSummary stopped carrying a Go-computed ADR in
  // dogfooding W4 (adoption-means-migration — this was its last
  // reader). No fresh row (absent or behind) renders the honest dash,
  // the missing marker every metric value slot uses; a failed read
  // lands on the same dash instead of a stale number.
  let adrRows = $state(new Map());
  let adrReload = $state(0);
  $effect(() => onMetricDone(() => (adrReload += 1)));
  $effect(() => {
    if (kind !== 'player') return;
    items; // refetch when the caller's list changes
    adrReload; // …and when a sweep replaces the stored rows
    let live = true;
    careerAdrRows()
      .then((rows) => {
        if (live) adrRows = rows;
      })
      .catch(() => {
        if (live) adrRows = new Map();
      });
    return () => (live = false);
  });
  function adrText(item) {
    const row = adrRows.get(item.steamId);
    return row ? fmt1(row.value) : '—';
  }

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
    onselect(item);
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
    }
    // Esc is Popover's (document-level) — see onClose.
  }

  // Tab/shift-tab away closes; a pointer that moves focus INSIDE the
  // widget (clicking a row) must not — and a click that leaves is
  // already handled by Popover's outside-pointerdown, which is why a
  // null relatedTarget (jsdom, or focus landing on nothing) stays put.
  function onFocusOut(e) {
    const to = e.relatedTarget;
    if (to && root && !root.contains(to)) dismiss();
  }
</script>

<span class="sg {wrapClass}" bind:this={root}>
  <input
    {id}
    class="input {inputClass}"
    class:active={!!value.trim()}
    type="search"
    placeholder={hint}
    aria-label={ariaLabel || null}
    role="combobox"
    aria-expanded={shown}
    aria-controls={shown ? listId : null}
    aria-activedescendant={shown ? activeId : null}
    aria-autocomplete="list"
    bind:value
    oninput={() => (open = true)}
    onfocus={() => (open = true)}
    onkeydown={onKey}
    onfocusout={onFocusOut}
  />
  <Popover open={shown} anchor={root} onClose={dismiss}>
    <div class="sg-pop sg-pop-{align}" id={listId} role="listbox" aria-label={ariaLabel || 'Suggestions'}>
      {#each matches as item, i (i)}
        <button
          type="button"
          class="sg-opt"
          class:active={i === activeIdx}
          id="{listId}-opt-{i}"
          role="option"
          aria-selected={i === activeIdx}
          onmouseenter={() => (active = i)}
          onclick={() => pick(item)}
        >
          {#if kind === 'player'}
            <strong title={item.name || item.steamId}>{item.name || item.steamId}</strong>
            <span class="muted">{item.matches ?? 0} match{item.matches === 1 ? '' : 'es'}</span>
            <span class="spacer"></span>
            <span class="num muted">ADR {adrText(item)}</span>
          {:else}
            {searchText(item)}
          {/if}
        </button>
      {/each}
    </div>
  </Popover>
</span>

<style>
  /* The one suggestion panel (sg-): anchored under its input, sized to
     the content but never wider than the viewport, scrollable past 10
     rows (the caller caps the list). */
  .sg {
    position: relative;
    display: inline-flex;
  }

  .sg-pop {
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

  .sg-pop-end {
    right: 0;
  }

  .sg-pop-start {
    left: 0;
  }

  :global([data-theme='light']) .sg-pop {
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
  }

  .sg-opt {
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

  .sg-opt:hover {
    background: var(--accent-12);
  }

  /* Keyboard highlight: the row Enter would pick keeps an accent guide
     so it stays visible while the pointer hovers elsewhere. */
  .sg-opt.active {
    background: var(--accent-12);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  /* Long player names truncate instead of stretching the panel; the
     full value is on the row's title. */
  .sg-opt strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 240px;
  }
</style>
