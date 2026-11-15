<script>
  // The metric ORDER preference UI (dogfooding design §2): ONE dialog,
  // TWO stacked sections — Scoreboard (match metrics) then Player
  // profile (profile metrics) — not tabs: both lists are short, and
  // the whole point is showing "fixed block first, then your pinned
  // metrics" for each surface at a glance.
  //
  // Pins-only (metrics UI wave B): a section lists ONLY its surface's
  // pinned metrics, in sequence order — `pinnedInSequence` is THE
  // composition and is consumed here, never re-spelled — and unpinned
  // metrics appear nowhere in the dialog (so there is no pin indicator
  // to show either). Pin TOGGLING stays with Builder's rows (the single
  // pins writer), so this dialog can never fork the pins contract: the
  // help line points the user at the metric list's pin buttons, and a
  // surface with nothing pinned says so instead of rendering an empty
  // box.
  //
  // Every move is WRITE-THROUGH: one move rewrites the scope's full
  // resolved sequence and persists it immediately (kvstore AutoSave —
  // no unsaved-order state exists, so the dialog is `dismissable` with
  // no dirty/cancel gate). Gestures index the PINNED list the user
  // sees, but the persisted value is always the WHOLE sequence —
  // unpinned entries keep their relative slots (see move). Reset
  // deletes both pref keys; Close just closes (dialog open state is
  // transient — never seeded, never remembered, never in the URL).
  //
  // Drag: no reorder-dnd exists anywhere else in the frontend, so the
  // dialog ships its own deliberately-dual-path one — HTML5 drag
  // starting at each row's GRABBER handle (the only draggable element;
  // the handlers stay on the row, where role=option makes them
  // ARIA-valid, and dragstart/dragend bubble up from the handle) AND
  // first-class keyboard (row focus + ArrowUp/ArrowDown) plus per-row
  // move buttons, ALL of it routed through the same write-through
  // move(). The handle is aria-hidden on purpose: it is a pointer
  // affordance that duplicates the named ↑/↓ buttons, which stay the
  // accessible path. Escape/outside-click/focus-return come from
  // Dialog (never re-implemented here).
  import { tick } from 'svelte';
  import Dialog from './Dialog.svelte';
  import { listMetrics, errText } from '../services.js';
  import {
    inSequence,
    pinnedInSequence,
    readOrder,
    writeOrder,
    resetOrder,
    fixedBlock,
  } from '../metricorder.js';
  import * as S from '../strings/index.js'; // chrome copy (strings-audit Check B)

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

  // fullOf — the scope's WHOLE catalog in sequence order: what a move
  // PERSISTS, and what decides "the surface has no metrics yet" below.
  function fullOf(scope) {
    return inSequence(scope, orders[scope], defs);
  }

  // seqOf — WHAT THE DIALOG SHOWS: the surface's pinned metrics in
  // sequence order (the metricorder.js composition, consumed as-is).
  // Every gesture index — keyboard, ↑/↓ buttons, drag — is an index
  // into THIS list, not into the catalog.
  function seqOf(scope) {
    return pinnedInSequence(scope, orders[scope], defs, pinnedIds(scope));
  }

  // THE one move: splice the PINNED order the user sees, then re-apply
  // it to the scope's full sequence — the pinned slots take the new
  // order in place while unpinned entries keep their relative
  // positions — update the local view, and persist the FULL sequence
  // immediately (write-through: the pref is never written as a
  // pins-filtered view). A failed write snaps the section back to the
  // previous sequence — an order that did not save is never shown as
  // saved.
  async function move(scope, from, to) {
    const shown = seqOf(scope);
    if (from < 0 || from >= shown.length) return;
    const t = Math.max(0, Math.min(shown.length - 1, to));
    if (t === from) return;
    const prev = orders[scope];
    const reordered = shown.slice();
    const [moved] = reordered.splice(from, 1);
    reordered.splice(t, 0, moved);
    const queue = reordered.map((d) => d.name);
    const pinnedNames = new Set(shown.map((d) => d.name));
    const next = fullOf(scope).map((d) => (pinnedNames.has(d.name) ? queue.shift() : d.name));
    orders = { ...orders, [scope]: next };
    try {
      await writeOrder(scope, next);
    } catch (e) {
      orders = { ...orders, [scope]: prev };
      error = errText(e);
      return;
    }
    await tick();
    focusRow(scope, moved.name);
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

  // HTML5 DnD — thin handlers only: dragstart/dragend bubble up from
  // the row's grabber handle (the only draggable element), every
  // gesture ends in the same move the keyboard uses (jsdom has no
  // DragEvent/DataTransfer, so the DOM tests dispatch plain bubbling
  // Events on the handle and pin the handle markup).
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
  {@const all = fullOf(scope)}
  {@const seq = seqOf(scope)}
  <section class="mo-sec" data-mo-scope={scope}>
    <h3 class="mo-sec-title" id="mo-sec-title-{scope}">{title}</h3>
    <p class="mo-fixed-cap muted" id="mo-fixed-cap-{scope}">
      {S.common.metricOrderFixedCaption}
    </p>
    <!-- The fixed block as READ-ONLY context (never draggable, no
         buttons, no state — values do not render in this dialog).
         aria-readonly is NOT a supported property of role=list (nor of
         role=listitem), so the read-only statement is carried by the
         list's accessible NAME — the visible caption above, heard when
         a screen reader enters the list. -->
    <div class="mo-fixed" role="list" aria-labelledby="mo-fixed-cap-{scope}">
      {#each fixedBlock(scope) as label (label)}
        <span class="mo-fixed-item" role="listitem">{label}</span>
      {/each}
    </div>
    {#if all.length === 0}
      <!-- The surface has no metrics at all yet — nothing exists to
           pin or order. -->
      <p class="muted" role="status">
        {scope === 'profile'
          ? S.common.metricOrderNoProfileMetrics
          : S.common.metricOrderNoMatchMetrics}
      </p>
    {:else if seq.length === 0}
      <!-- Pins-only empty state: metrics exist but none are pinned —
           say so and point at the pin buttons (the help line above
           repeats the where-to-pin guidance). -->
      <p class="muted" role="status">{S.common.metricOrderNothingToOrder}</p>
    {:else}
      <!-- The reorderable half is a real listbox/option pair: option is
           the ARIA construct that legitimately carries tabindex, a
           keydown handler and drag handlers (role=listitem cannot — it
           is non-interactive), so ↑/↓ and HTML5 DnD stay unchanged.
           aria-selected is required on option and is statically false:
           this dialog never selects anything (pinning stays with
           Builder's rows). The listbox takes its name from the section
           heading and lists ONLY the surface's pinned metrics, in
           sequence order. -->
      <div class="mo-list" role="listbox" aria-labelledby="mo-sec-title-{scope}">
        {#each seq as m, i (m.name)}
          <div
            class="mo-row"
            role="option"
            aria-selected="false"
            data-mo-scope={scope}
            data-mo-name={m.name}
            tabindex="0"
            ondragstart={(e) => dragStart(scope, i, e)}
            ondragover={(e) => dragOver(scope, i, e)}
            ondrop={(e) => dropOn(scope, e)}
            ondragend={dragEnd}
            onkeydown={(e) => onRowKey(scope, i, e)}
          >
            <!-- The GRABBER is the drag source: `draggable` lives here
                 (never on the row — grabbing text must not start a
                 drag) while the handlers above catch it bubbling up.
                 aria-hidden on purpose: it is a pointer affordance that
                 duplicates the named ↑/↓ buttons, which stay the
                 accessible path. -->
            <span
              class="mo-grip codicon codicon-grabber"
              draggable="true"
              aria-hidden="true"
              title={S.common.metricOrderDragTitle}
            ></span>
            <span class="mo-title">{m.title || m.name}</span>
            <span class="mono mo-name">{m.name}</span>
            <span class="mo-moves">
              <button
                class="btn small ghost"
                aria-label={S.fill(S.common.metricOrderMoveUp, { name: m.name })}
                disabled={i === 0}
                onclick={() => move(scope, i, i - 1)}
                ><span class="codicon codicon-arrow-up"></span></button
              >
              <button
                class="btn small ghost"
                aria-label={S.fill(S.common.metricOrderMoveDown, { name: m.name })}
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

<Dialog {open} label={S.common.metricOrderDialogLabel} panelClass="mo-prompt" {onClose}>
  <div class="mo-body" bind:this={bodyEl}>
    <p class="muted mo-note">
      {S.common.metricOrderNote}
    </p>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    {@render section('match', S.common.metricOrderScoreboardSection)}
    {@render section('profile', S.common.metricOrderProfileSection)}
    <div class="toolbar mo-foot">
      <span class="muted mo-hint"
        >{S.common.metricOrderHintDrag}<span class="codicon codicon-arrow-up"></span><span
          class="codicon codicon-arrow-down"></span
        >{S.common.metricOrderHintKeys}</span
      >
      <span class="spacer"></span>
      <button class="btn ghost" onclick={resetAll}>{S.common.metricOrderReset}</button>
      <button class="btn primary" onclick={onClose}>{S.common.metricOrderClose}</button>
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
  .mo-grip:active {
    cursor: grabbing;
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
