<script>
  // The metric ORDER preference UI (dogfooding design §2): ONE dialog,
  // TWO stacked sections — Scoreboard (match metrics) then Player
  // profile (profile metrics) — not tabs: both orders are short, and
  // the whole point is showing "fixed block first, then metrics" for
  // each surface at a glance.
  //
  // Every move is WRITE-THROUGH: one move(id, from, to) rewrites the
  // scope's full resolved sequence and persists it immediately
  // (kvstore AutoSave — no unsaved-order state exists, so the dialog is
  // `dismissable` with no dirty/cancel gate). Reset deletes both pref
  // keys; Close just closes (dialog open state is transient — never
  // seeded, never remembered, never in the URL).
  //
  // Pins: the indicator is READ-ONLY here — pin TOGGLING stays with
  // Builder's rows (the single pins writer), so this dialog can never
  // fork the pins contract. Reordering an unpinned metric is legal and
  // meaningful: the order pref covers the scope's WHOLE catalog, pins
  // only select what renders, the sequence decides where the selection
  // renders.
  //
  // Drag: no reorder-dnd exists anywhere else in the frontend, so the
  // dialog ships its own deliberately-dual-path one — HTML5 drag AND
  // first-class keyboard (row focus + ArrowUp/ArrowDown) plus per-row
  // move buttons, ALL of it routed through the same write-through
  // move(). Escape/outside-click/focus-return come from Dialog (never
  // re-implemented here).
  import { tick } from 'svelte';
  import Dialog from './Dialog.svelte';
  import { listMetrics, errText } from '../services.js';
  import { inSequence, readOrder, writeOrder, resetOrder, fixedBlock } from '../metricorder.js';

  let {
    open = false,
    pinnedMatch = [],
    pinnedProfile = [],
    onClose = () => {},
  } = $props();

  let bodyEl = $state(null);
  let defs = $state([]); // the full catalog (listMetrics) — both sections scope-filter it
  let orders = $state({ match: null, profile: null }); // saved pref per scope (null = absent)
  let error = $state('');

  // One listMetrics() + both order reads on open (design §2.4: no
  // async inside a move — everything below is synchronous over this
  // snapshot; listMetrics is the shared library-wide cached read).
  $effect(() => {
    if (!open) return;
    error = '';
    Promise.all([listMetrics(), readOrder('match'), readOrder('profile')])
      .then(([rows, m, p]) => {
        if (!open) return; // closed mid-flight
        defs = rows || [];
        orders = { match: m, profile: p };
      })
      .catch((e) => {
        error = errText(e);
      });
  });

  function pinnedIds(scope) {
    return scope === 'match' ? pinnedMatch : pinnedProfile;
  }
  function isPinned(scope, id) {
    return pinnedIds(scope).includes(id);
  }

  function seqOf(scope) {
    return inSequence(scope, orders[scope], defs).map((d) => d.name);
  }

  // THE one move: splice the full sequence, update the local view,
  // persist immediately (write-through). A failed write snaps the
  // section back to the previous sequence — an order that did not save
  // is never shown as saved.
  async function move(scope, from, to) {
    const seq = seqOf(scope);
    if (from < 0 || from >= seq.length) return;
    const t = Math.max(0, Math.min(seq.length - 1, to));
    if (t === from) return;
    const prev = orders[scope];
    const next = seq.slice();
    next.splice(from, 1);
    next.splice(t, 0, seq[from]);
    orders = { ...orders, [scope]: next };
    try {
      await writeOrder(scope, next);
    } catch (e) {
      orders = { ...orders, [scope]: prev };
      error = errText(e);
      return;
    }
    await tick();
    focusRow(scope, next[t]);
  }

  // Focus follows the moved row (house a11y: the keyboard gesture keeps
  // its target under the user's fingers).
  function focusRow(scope, name) {
    if (!bodyEl) return;
    for (const el of bodyEl.querySelectorAll('.mo-row')) {
      if (el.dataset.moScope === scope && el.dataset.moName === name) {
        el.focus();
        break;
      }
    }
  }

  function onRowKey(scope, i, e) {
    if (e.key === 'ArrowUp') {
      e.preventDefault(); // the dialog must not scroll — the row moves
      move(scope, i, i - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(scope, i, i + 1);
    }
  }

  // HTML5 DnD — thin handlers only: every gesture ends in the same
  // move the keyboard uses (jsdom cannot fire drag events, so DOM tests
  // drive the buttons/keys).
  let dragFrom = null; // {scope, index}
  let dropAt = null; // insertion index under the pointer
  function dragStart(scope, i, e) {
    dragFrom = { scope, i };
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function dragOver(scope, i, e) {
    if (!dragFrom || dragFrom.scope !== scope) return;
    e.preventDefault(); // must be prevented or the drop is refused
    const rect = e.currentTarget.getBoundingClientRect();
    dropAt = e.clientY < rect.top + rect.height / 2 ? i : i + 1;
  }
  function dropOn(scope, e) {
    if (!dragFrom || dragFrom.scope !== scope || dropAt == null) return;
    e.preventDefault();
    let to = dropAt;
    if (dragFrom.i < to) to -= 1; // removing the row shifts the target down
    move(scope, dragFrom.i, to);
    dragFrom = null;
    dropAt = null;
  }
  function dragEnd() {
    dragFrom = null;
    dropAt = null;
  }

  // Reset order: delete BOTH pref keys ⇒ each section snaps back to its
  // default sequence (the fixed block is untouched — reset can never
  // reorder it).
  async function resetAll() {
    const prev = orders;
    orders = { match: null, profile: null };
    error = '';
    try {
      await Promise.all([resetOrder('match'), resetOrder('profile')]);
    } catch (e) {
      orders = prev;
      error = errText(e);
    }
  }
</script>

{#snippet section(scope, title)}
  {@const seq = inSequence(scope, orders[scope], defs)}
  <section class="mo-sec" data-mo-scope={scope}>
    <h3 class="mo-sec-title">{title}</h3>
    <p class="mo-fixed-cap muted">Fixed stats — always first, not reorderable</p>
    <!-- The fixed block as READ-ONLY context (never draggable, no
         buttons, no state — values do not render in this dialog). -->
    <div class="mo-fixed" role="list" aria-readonly="true">
      {#each fixedBlock(scope) as label (label)}
        <span class="mo-fixed-item" role="listitem">{label}</span>
      {/each}
    </div>
    {#if seq.length === 0}
      <p class="muted" role="status">
        {scope === 'profile' ? 'No profile metrics yet.' : 'No match metrics yet.'}
      </p>
    {:else}
      <div class="mo-list">
        {#each seq as m, i (m.name)}
          <div
            class="mo-row"
            data-mo-scope={scope}
            data-mo-name={m.name}
            draggable="true"
            tabindex="0"
            ondragstart={(e) => dragStart(scope, i, e)}
            ondragover={(e) => dragOver(scope, i, e)}
            ondrop={(e) => dropOn(scope, e)}
            ondragend={dragEnd}
            onkeydown={(e) => onRowKey(scope, i, e)}
          >
            <span class="mo-grip codicon codicon-grabber" aria-hidden="true"></span>
            <span class="mo-title">{m.title || m.name}</span>
            <span class="mono mo-name">{m.name}</span>
            <!-- Pin indicator: READ-ONLY (the single pins writer stays
                 with Builder's rows) — an unpinned row is simply
                 repositioned for when it gets pinned. -->
            <span
              class="mo-pin"
              class:mo-pin-on={isPinned(scope, m.id)}
              title={isPinned(scope, m.id) ? 'Pinned' : 'Not pinned'}
            >
              <span class="codicon codicon-pin" aria-hidden="true"></span>
            </span>
            <span class="mo-moves">
              <button
                class="btn small ghost"
                aria-label="Move {m.name} up"
                disabled={i === 0}
                onclick={() => move(scope, i, i - 1)}
                ><span class="codicon codicon-arrow-up"></span></button
              >
              <button
                class="btn small ghost"
                aria-label="Move {m.name} down"
                disabled={i === seq.length - 1}
                onclick={() => move(scope, i, i + 1)}
                ><span class="codicon codicon-arrow-down"></span></button
              >
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/snippet}

<Dialog {open} label="Metric order" panelClass="mo-prompt" {onClose}>
  <div class="mo-body" bind:this={bodyEl}>
    <p class="muted mo-note">
      Order of the metric columns and career rows — the fixed Go stats always stay first.
    </p>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    {@render section('match', 'Scoreboard (match metrics)')}
    {@render section('profile', 'Player profile (profile metrics)')}
    <div class="toolbar mo-foot">
      <span class="muted mo-hint"
        >drag · <span class="codicon codicon-arrow-up"></span><span
          class="codicon codicon-arrow-down"></span
        > move · Esc close</span
      >
      <span class="spacer"></span>
      <button class="btn ghost" onclick={resetAll}>Reset order</button>
      <button class="btn primary" onclick={onClose}>Close</button>
    </div>
  </div>
</Dialog>

<style>
  /* The panel element belongs to Dialog.svelte, so the dialog's size
     reaches it through a global selector (mo- = MetricOrderDialog). */
  :global(.dlg-panel.mo-prompt) {
    width: min(720px, 94vw);
    padding: 16px 18px;
  }
  .mo-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .mo-note {
    margin: 0;
    font-size: 0.9em;
  }
  .mo-sec {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mo-sec-title {
    margin: 0;
    font-size: 1em;
  }
  .mo-fixed-cap {
    margin: 0;
    font-size: 0.85em;
  }
  /* Fixed block: muted context line, non-interactive by construction. */
  .mo-fixed {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    font-size: 0.85em;
    opacity: 0.75;
  }
  .mo-fixed-item::after {
    content: '·';
    margin-left: 10px;
    opacity: 0.6;
  }
  .mo-fixed-item:last-child::after {
    content: '';
    margin: 0;
  }
  .mo-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 34vh;
    overflow: auto;
  }
  .mo-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--widget-bg);
  }
  .mo-row:last-child {
    border-bottom: none;
  }
  .mo-row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .mo-grip {
    opacity: 0.55;
    cursor: grab;
  }
  .mo-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40%;
  }
  .mo-name {
    font-size: 0.85em;
    opacity: 0.75;
  }
  .mo-pin {
    opacity: 0.35;
  }
  .mo-pin-on {
    opacity: 1;
    color: var(--accent);
  }
  .mo-moves {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
  .mo-foot {
    margin-top: 0;
  }
  .mo-foot .spacer {
    flex: 1;
  }
  .mo-hint {
    font-size: 0.85em;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
</style>
