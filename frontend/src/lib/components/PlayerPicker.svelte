<script>
  // Player selector for the Reports target panel — the native <select>
  // ("rep-player") replacement, styled to MatchPicker: the trigger shows
  // the current selection, the popover lists players the way the app
  // presents them elsewhere (name, side + scoreboard line when the player
  // appears in the selected match, career totals from the profile list)
  // behind a filter box.
  //
  // Keyboard follows MatchPicker/CommandPalette: the filter input owns
  // focus, ↑↓ move the highlight, Enter selects, Esc closes (and returns
  // focus to the trigger); clicking outside closes. Rows are real buttons;
  // aria-activedescendant on the combobox points at the highlighted option.
  import { fmt1 } from '../fmt.js';

  // players: ProfileSummary rows (ProfileService.ListPlayers) — steamId,
  // name, matches, adrAvg, lastSeen. stats: steamId → PlayerStatsRow from
  // MatchService.GetScoreboard for the report's match (may be empty).
  let { players = [], stats = {}, value = '', onselect = () => {}, id = '' } = $props();

  let open = $state(false);
  let query = $state('');
  let active = $state(0);
  let root = $state(null);
  let listEl = $state(null);
  let inputEl = $state(null);
  let triggerEl = $state(null);

  const cur = $derived(players.find((p) => p.steamId === value) || null);
  const curRow = $derived(stats[value] || null);

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return players;
    return players.filter((p) =>
      `${p.name || ''} ${p.steamId || ''}`.toLowerCase().includes(q),
    );
  });

  // Highlight index clamped to the filtered list (it shrinks while typing).
  const activeIdx = $derived(filtered.length ? Math.min(active, filtered.length - 1) : -1);
  const activeId = $derived(
    activeIdx >= 0 && filtered[activeIdx] ? `pp-opt-${filtered[activeIdx].steamId}` : '',
  );

  function openPop() {
    open = true;
    query = '';
    const at = filtered.findIndex((p) => p.steamId === value);
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
    const p = filtered[i];
    if (!p) return;
    close(true);
    onselect(p.steamId);
  }

  function move(d) {
    const n = filtered.length;
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

  // Close when the pointer lands outside the picker.
  $effect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (root && !root.contains(e.target)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  });

  // Esc closes from wherever focus is — document-level, MatchPicker's shape.
  $effect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Keep the highlighted row in view (DOM-only, no state loop).
  $effect(() => {
    activeIdx;
    open;
    filtered.length;
    if (!open) return;
    requestAnimationFrame(() => {
      const el = listEl && listEl.querySelector('.pp-opt.active');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
  });
</script>

<div class="pp" bind:this={root}>
  <button
    type="button"
    class="pp-trigger"
    id={id || null}
    bind:this={triggerEl}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? 'pp-list' : null}
    aria-label="Player"
    onclick={togglePop}
  >
    {#if cur}
      <span class="pp-trigger-name">{cur.name || cur.steamId}</span>
      {#if curRow}
        <span class="chip side {curRow.side}">{(curRow.side || '?').toUpperCase()}</span>
      {/if}
      <span class="pp-trigger-id mono muted">{cur.steamId}</span>
    {:else}
      <span class="muted">Select player…</span>
    {/if}
    <span class="pp-caret" aria-hidden="true"><span class="codicon {open ? 'codicon-chevron-up' : 'codicon-chevron-down'}"></span></span>
  </button>

  {#if open}
    <div class="pp-pop">
      <input
        class="input pp-search"
        type="search"
        placeholder="Filter players…"
        aria-label="Filter players"
        role="combobox"
        aria-expanded="true"
        aria-controls={filtered.length > 0 ? 'pp-list' : null}
        aria-activedescendant={activeId || null}
        aria-autocomplete="list"
        bind:this={inputEl}
        bind:value={query}
        onkeydown={onInputKey}
      />
      {#if filtered.length > 0}
        <div class="pp-list" id="pp-list" role="listbox" aria-label="Players" bind:this={listEl}>
          {#each filtered as p, i (p.steamId)}
            {@const row = stats[p.steamId]}
            <button
              type="button"
              class="pp-opt"
              class:active={i === activeIdx}
              class:current={p.steamId === value}
              id={'pp-opt-' + p.steamId}
              role="option"
              aria-selected={p.steamId === value}
              onmouseenter={() => (active = i)}
              onclick={() => pick(i)}
            >
              <span class="pp-line1">
                <span class="pp-name">{p.name || p.steamId}</span>
                {#if row}
                  <span class="chip side {row.side}">{(row.side || '?').toUpperCase()}</span>
                {/if}
                <span class="spacer"></span>
                {#if row}
                  <span class="muted num" title="K / D / A in this match"
                    >{row.kills}/{row.deaths}/{row.assists}</span
                  >
                  <span class="num" title="ADR in this match">{fmt1(row.adr)}</span>
                  <span class="muted num" title="Rounds played">{row.roundsPlayed}r</span>
                {:else}
                  <span class="muted num" title="Matches in the library"
                    >{p.matches ?? 0} matches</span
                  >
                  {#if p.matches > 0}
                    <span class="muted num" title="Career ADR">{fmt1(p.adrAvg)} ADR</span>
                  {/if}
                {/if}
              </span>
              <span class="pp-line2 muted">
                <span class="mono">{p.steamId}</span>
                <span>{row ? 'in this match' : 'not in this match'}</span>
                {#if p.lastSeen}
                  <span>seen {p.lastSeen}</span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="pp-empty muted">
          {query.trim()
            ? `No players match “${query.trim()}”.`
            : 'No players yet — import a match in the Library.'}
        </p>
      {/if}
      <div class="pp-foot muted">
        <span><span class="codicon codicon-arrow-up"></span><span class="codicon codicon-arrow-down"></span> move</span><span>Enter select</span><span>Esc close</span>
        <span class="spacer"></span>
        <span class="num">{filtered.length}/{players.length}</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .pp {
    position: relative;
    display: inline-flex;
  }

  .pp-trigger {
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

  .pp-trigger:hover {
    border-color: var(--muted);
  }

  .pp-trigger:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .pp-trigger-name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pp-trigger-id {
    font-size: 0.86em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pp-caret {
    color: var(--muted);
    font-size: 0.75em;
  }

  .pp-pop {
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

  .pp-search {
    width: 100%;
  }

  .pp-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 320px;
    overflow-y: auto;
  }

  .pp-opt {
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

  .pp-opt:hover {
    background: var(--list-hover);
  }

  .pp-opt.active {
    background: var(--list-hover-strong);
  }

  /* Current selection: amber indent guide + tint, VS Code list-style
     (inset shadow so selecting a row doesn't shift its content). */
  .pp-opt.current {
    background: var(--accent-tint);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .pp-opt.current.active {
    background: var(--list-hover-strong);
  }

  .pp-line1 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .pp-line2 {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.85em;
  }

  .pp-name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pp-empty {
    padding: 6px 8px;
    font-size: 0.9em;
  }

  .pp-foot {
    display: flex;
    gap: 10px;
    padding-top: 4px;
    font-size: 0.8em;
    border-top: 1px solid var(--divider);
  }
</style>
