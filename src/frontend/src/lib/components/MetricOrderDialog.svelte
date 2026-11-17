<script>
  // The metric ORDER preference UI (dogfooding design §2): ONE dialog,
  // TWO stacked sections — Scoreboard (match metrics) then Player
  // profile (profile metrics) — not tabs: both lists are short, and
  // the whole point is showing "your fixed stats, then your pinned
  // metrics" for each surface at a glance.
  //
  // W6: the fixed stats are SEQUENCE entries now (metricorder.js
  // composedSequence), so they fold into the SAME listbox as the pinned
  // metrics — there is no read-only context block any more, and every
  // hideable row carries its own show/hide toggle. Hidden rows REMAIN
  // listed here (owner requirement: the ordering view is where you find
  // a stat again — the toggle never removes the row), they just stop
  // rendering on the scoreboard / profile. Metric visibility stays
  // pin-driven: a metric row carries a PIN toggle (M6 — unpin from
  // here), but the write never happens in this dialog — Builder owns
  // both pin keys and is handed in as `onTogglePin` (the single pins
  // writer), so this dialog still cannot fork the pins contract, and
  // the unpin leaves metric_order_* untouched — the sequence keeps the
  // slot for re-pinning. The eye keeps its Show/Hide name and never
  // says "pin"; the pin toggle's label comes from the same catalog
  // keys Builder's pin button composes (strings/builder.js).
  //
  // Every move is WRITE-THROUGH: one move rewrites the scope's full
  // resolved sequence and persists it immediately (kvstore AutoSave —
  // no unsaved-order state exists, so the dialog is `dismissable` with
  // no dirty/cancel gate). Gestures index the LIST the user sees, but
  // the persisted value is always the WHOLE sequence — entries that are
  // not listed (unpinned metrics) keep their relative slots (see move).
  // Reset deletes BOTH pref pairs per scope (order + hidden) — the
  // lead's ruling: Reset order restores the defaults INCLUDING showing
  // every fixed stat again. Close is the header's ✕ (dialog open state
  // is transient — never seeded, never remembered, never in the URL).
  //
  // Reordering is BUTTON + KEYBOARD ONLY (owner, 2026-11-15: retire the
  // drag path — "dragging doesn't work well"). The named ↑/↓ buttons
  // per row and first-class keyboard (row focus + ArrowUp/ArrowDown)
  // both route through the same write-through move(); no drag source
  // exists anywhere in the dialog — rows are never draggable. The ↑/↓
  // buttons are the pointer AND the accessible path. Escape/outside-
  // click/focus-return come from Dialog (never re-implemented here).
  import { tick } from 'svelte';
  import Dialog from './Dialog.svelte';
  import { listMetrics, errText } from '../services.js';
  import {
    composedSequence,
    readOrder,
    writeOrder,
    resetOrder,
    readHidden,
    writeHidden,
    resetHidden,
    readStartsTransposed,
    writeStartsTransposed,
    hideable,
  } from '../metricorder.js';
  import * as S from '../strings/index.js'; // chrome copy (strings-audit Check B)

  let {
    open = false,
    pinnedMatch = [],
    pinnedProfile = [],
    onTogglePin = () => {},
    onClose = () => {},
  } = $props();

  let bodyEl = $state(null);
  let defs = $state([]); // the full catalog (listMetrics) — both sections scope-filter it
  let orders = $state({ match: null, profile: null }); // saved pref per scope (null = absent)
  let hidden = $state({ match: [], profile: [] }); // hidden fixed-entry keys per scope (absent ⇒ [])
  // w25 — the dialog's THIRD pref (metricorder.js STARTS_TRANSPOSED_KEY):
  // the scoreboard's opening shape, read with the rest on open (absent ⇒
  // off) and written through setStartsTransposed below.
  let startsTransposed = $state(false);
  let error = $state('');

  // One listMetrics() + both order reads + both visibility reads + the
  // shape pref on open (design §2.4: no async inside a move — everything
  // below is synchronous over this snapshot; listMetrics is the shared
  // library-wide cached read).
  $effect(() => {
    if (!open) return;
    error = '';
    Promise.all([
      listMetrics(),
      readOrder('match'),
      readOrder('profile'),
      readHidden('match'),
      readHidden('profile'),
      readStartsTransposed(),
    ])
      .then(([rows, m, p, hm, hp, st]) => {
        if (!open) return; // closed mid-flight
        defs = rows || [];
        orders = { match: m, profile: p };
        hidden = { match: hm, profile: hp };
        startsTransposed = st;
      })
      .catch((e) => {
        error = errText(e);
      });
  });

  function pinnedIds(scope) {
    return scope === 'match' ? pinnedMatch : pinnedProfile;
  }

  // fullKeysOf — the scope's WHOLE sequence as identity keys: what a
  // move PERSISTS and what the re-apply below walks.
  function fullKeysOf(scope) {
    return composedSequence(scope, orders[scope], defs, hidden[scope]).map((e) => e.key);
  }

  // seqOf — WHAT THE DIALOG SHOWS: the composed sequence filtered to
  // the fixed stats (ALL of them, hidden ones included — they stay
  // listed) plus the pinned metrics. Every gesture index — keyboard and
  // the ↑/↓ buttons — is an index into THIS list, not into the catalog.
  function seqOf(scope) {
    const pins = new Set(pinnedIds(scope));
    return composedSequence(scope, orders[scope], defs, hidden[scope]).filter(
      (e) => e.kind === 'fixed' || pins.has(e.def.id),
    );
  }

  // THE one move: splice the LIST the user sees, then re-apply it to
  // the scope's full sequence — the shown entries take the new order in
  // place while unpinned entries keep their relative positions — update
  // the local view, and persist the FULL sequence immediately
  // (write-through: the pref is never written as a shown-list view). A
  // failed write snaps the section back to the previous sequence — an
  // order that did not save is never shown as saved.
  async function move(scope, from, to) {
    const shown = seqOf(scope);
    if (from < 0 || from >= shown.length) return;
    const t = Math.max(0, Math.min(shown.length - 1, to));
    if (t === from) return;
    const prev = orders[scope];
    const reordered = shown.slice();
    const [moved] = reordered.splice(from, 1);
    reordered.splice(t, 0, moved);
    const queue = reordered.map((e) => e.key);
    const shownKeys = new Set(shown.map((e) => e.key));
    const next = fullKeysOf(scope).map((k) => (shownKeys.has(k) ? queue.shift() : k));
    orders = { ...orders, [scope]: next };
    try {
      await writeOrder(scope, next);
    } catch (e) {
      orders = { ...orders, [scope]: prev };
      error = errText(e);
      return;
    }
    await tick();
    focusRow(scope, moved.key);
  }

  // toggleHidden — the show/hide half (W6): the scope's hidden set plus
  // or minus ONE fixed key, written through immediately like a move
  // (kvstore AutoSave). Only a HIDEABLE entry ever reaches here (the
  // render guards it), and a failed write snaps back — a visibility that
  // did not save is never shown as saved.
  async function toggleHidden(scope, key) {
    if (!hideable(scope, key)) return;
    const prev = hidden[scope] || [];
    const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
    hidden = { ...hidden, [scope]: next };
    try {
      await writeHidden(scope, next);
    } catch (e) {
      hidden = { ...hidden, [scope]: prev };
      error = errText(e);
    }
  }

  // setStartsTransposed — the SHAPE pref write (w25): write-through with
  // the same snap-back contract as toggleHidden above — a write that did
  // not save is never shown as saved. This checkbox is the ONLY writer of
  // the key (toggling a match's scoreboard never writes it), and it is
  // not part of the order sequence: Reset order below never touches it.
  async function setStartsTransposed(on) {
    const prev = startsTransposed;
    startsTransposed = on;
    try {
      await writeStartsTransposed(on);
    } catch (e) {
      startsTransposed = prev;
      error = errText(e);
    }
  }

  // unpin (M6) — the dialog's pin toggle on a METRIC row. The write
  // stays with Builder: onTogglePin → togglePin writes BOTH pin keys
  // and never metric_order_* (the sequence keeps the slot, so
  // re-pinning restores the position). The row leaves through Builder's
  // pins prop (reactive — nothing here removes it), and focus moves to
  // the row that takes its place (or the section listbox if it was the
  // last one) — never a detached node.
  async function unpin(scope, entry) {
    const shown = seqOf(scope);
    const i = shown.findIndex((x) => x.key === entry.key);
    const neighbour = shown[i + 1] || shown[i - 1] || null;
    await onTogglePin(entry.def.id, scope); // Builder's writer resolves before the list updates
    await tick();
    if (neighbour) {
      focusRow(scope, neighbour.name);
    } else {
      bodyEl?.querySelector(`.mo-sec[data-mo-scope="${scope}"] .mo-list`)?.focus();
    }
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

  // Reset order: delete BOTH pref PAIRS (order + hidden, both scopes)
  // ⇒ each section snaps back to its default sequence with every fixed
  // stat showing again (the lead's ruling: Reset restores the defaults,
  // visibility included). It deliberately does NOT touch the SHAPE pref
  // (STARTS_TRANSPOSED_KEY, the checkbox below the scoreboard list) —
  // that is the shape a match opens in, neither order nor visibility
  // (w25; no delete of it exists anywhere in this dialog).
  async function resetAll() {
    const prevOrders = orders;
    const prevHidden = hidden;
    orders = { match: null, profile: null };
    hidden = { match: [], profile: [] };
    error = '';
    try {
      await Promise.all([
        resetOrder('match'),
        resetOrder('profile'),
        resetHidden('match'),
        resetHidden('profile'),
      ]);
    } catch (e) {
      orders = prevOrders;
      hidden = prevHidden;
      error = errText(e);
    }
  }
</script>

{#snippet section(scope, title)}
  {@const shown = seqOf(scope)}
  <section class="mo-sec" data-mo-scope={scope}>
    <h3 class="mo-sec-title" id="mo-sec-title-{scope}">{title}</h3>
    <p class="mo-fixed-cap muted" id="mo-fixed-cap-{scope}">
      {S.common.metricOrderFixedCaption}
    </p>
    <!-- ONE listbox per section (W6): the fixed stats and the pinned
         metrics share it, in sequence order. option is the ARIA
         construct that legitimately carries tabindex and a keydown
         handler (role=listitem cannot — it is non-interactive), so ↑/↓
         and the move buttons stay unchanged. aria-selected is required
         on option and is statically false: this dialog never selects
         anything (unpinning below routes through Builder's writer, it
         is not a selection). tabindex=-1 makes the listbox the
         PROGRAMMATIC focus fallback when the last row unpins (the
         neighbour focus above is the normal path). The listbox takes
         its name from the section heading and its description from the
         caption above. -->
    <div
      class="mo-list"
      role="listbox"
      tabindex="-1"
      aria-labelledby="mo-sec-title-{scope}"
      aria-describedby="mo-fixed-cap-{scope}"
    >
      {#each shown as e, i (e.key)}
        <div
          class="mo-row"
          class:mo-hidden={e.hidden}
          role="option"
          aria-selected="false"
          data-mo-scope={scope}
          data-mo-name={e.name}
          data-mo-kind={e.kind}
          tabindex="0"
          onkeydown={(ev) => onRowKey(scope, i, ev)}
        >
          <span class="mo-title">{e.label}</span>
          <!-- W13b — the structured fixed label: the title reads the
               FULL name (e.label), the mono slot carries the entry's
               SHORT (e.short) only when the two differ (Team never
               doubles to "Team Team"), and a hidden fixed stat keeps
               its in-place mark. A metric row carries NO mono slot —
               its title alone identifies it (the old title+name
               doubling, "Assists assists", is gone). -->
          {#if e.kind === 'fixed'}
            {#if e.short !== e.label}
              <span class="mono mo-name">{e.short}</span>
            {/if}
            {#if e.hidden}
              <!-- A hidden fixed stat says so in place — the row never
                   leaves the list (owner requirement). -->
              <span class="mono mo-name">{S.common.metricOrderHiddenMark}</span>
            {/if}
          {/if}
          <!-- M1: ONE right-aligned cluster — the row's controls (eye,
               pin, ↑↓) sit together at the row's right edge instead of
               the eye floating after the label. The eye keeps its
               Show/Hide name ONLY (no visible text, no title — the icon
               alone, owner ruling); the pin toggle is metric-row-only
               and composes the catalog keys Builder's pin button uses. -->
          <span class="mo-acts">
            {#if e.kind === 'fixed' && hideable(scope, e.key)}
              <button
                class="btn small ghost"
                aria-label={e.hidden
                  ? S.fill(S.common.metricOrderShow, { name: e.label })
                  : S.fill(S.common.metricOrderHide, { name: e.label })}
                onclick={() => toggleHidden(scope, e.key)}
                ><span class="codicon {e.hidden ? 'codicon-eye-closed' : 'codicon-eye'}"></span
              ></button>
            {/if}
            {#if e.kind === 'metric'}
              <!-- M6: unpin only — every listed metric IS pinned (the
                   list is fixed stats + pinned metrics), so the toggle
                   always shows the pinned state and the row leaves the
                   list the moment it is clicked. The WRITE rides
                   onTogglePin back to Builder; the title is the same
                   catalog wording Builder's row pin button shows. -->
              <button
                class="btn small ghost mo-pin-on"
                title={scope === 'profile'
                  ? S.builder.unpinFromProfile
                  : S.builder.unpinFromScoreboard}
                aria-label={S.fill(S.builder.togglePinAria, { name: e.name })}
                onclick={() => unpin(scope, e)}
                ><span class="codicon codicon-pin"></span
              ></button>
            {/if}
            <span class="mo-moves">
              <button
                class="btn small ghost"
                aria-label={S.fill(S.common.metricOrderMoveUp, { name: e.label })}
                disabled={i === 0}
                onclick={() => move(scope, i, i - 1)}
                ><span class="codicon codicon-arrow-up"></span></button
              >
              <button
                class="btn small ghost"
                aria-label={S.fill(S.common.metricOrderMoveDown, { name: e.label })}
                disabled={i === shown.length - 1}
                onclick={() => move(scope, i, i + 1)}
                ><span class="codicon codicon-arrow-down"></span></button
              >
            </span>
          </span>
        </div>
      {/each}
    </div>
    {#if scope === 'match'}
      <!-- w25 — the Scoreboard section's SHAPE preference, after its
           list: "Scoreboard starts transposed" (default off) is the
           shape a match OPENS in — the Match view reads it once per
           mount as the seed default, while a session record for that
           match still wins. .filt-check is THE shared checkbox row
           (public/style-m3b.css — Builder's filter boxes and Settings'
           copy-on-import row), so this adds no dialog-scoped style. -->
      <label
        class="filt-check"
        for="mo-starts-transposed"
        title={S.common.metricOrderStartsTransposedHint}
      >
        <input
          id="mo-starts-transposed"
          type="checkbox"
          checked={startsTransposed}
          onchange={(e) => setStartsTransposed(e.currentTarget.checked)}
        />
        <span>{S.common.metricOrderStartsTransposed}</span>
      </label>
    {/if}
  </section>
{/snippet}

<Dialog {open} label={S.common.metricOrderDialogLabel} panelClass="mo-prompt" {onClose}>
  <!-- The visible title bar (N2): the dialog's name as an <h2> plus an
       icon-only ✕ — the KAST dialog's idiom — so the close affordance
       is on screen where the heading is, not only down in the footer.
       Dismissal itself stays Dialog-owned. -->
  <div class="row-between mo-head">
    <h2>{S.common.metricOrderDialogLabel}</h2>
    <button class="btn small" aria-label={S.common.metricOrderClose} onclick={onClose}
      ><span class="codicon codicon-close"></span></button
    >
  </div>
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
        ><span class="codicon codicon-arrow-up"></span><span
          class="codicon codicon-arrow-down"></span
        >{S.common.metricOrderHintKeys}</span
      >
      <span class="spacer"></span>
      <button class="btn ghost" onclick={resetAll}>{S.common.metricOrderReset}</button>
    </div>
  </div>
</Dialog>

<style>
  /* The panel element belongs to Dialog.svelte, so the dialog's size
     reaches it through a global selector (mo- = MetricOrderDialog). */
  :global(.dlg-panel.mo-prompt) {
    width: min(720px, 94vw);
    padding: 16px 18px;
    /* M4: the panel is a flex column — clip it so the TITLE BAR never
       scrolls (DocsPopup.svelte's .doc-panel precedent: "the panel is
       a flex column; the BODY scrolls"). The base .dlg-panel cap
       (max-height: 70vh) stays; other dialogs keep their own
       overflow — Dialog.svelte is untouched. */
    overflow: hidden;
  }
  .mo-head {
    /* M4: fixed above the scroll region — never scrolls away. */
    flex: 0 0 auto;
    margin-bottom: 4px;
  }
  .mo-head h2 {
    margin: 0;
    font-size: 1.1em;
  }
  .mo-body {
    /* M4/M5: THE one scroll region — the panel's 70vh cap shrinks it
       (min-height: 0) and it scrolls everything below the title bar,
       so the sections, the note and the footer ride ONE scrollbar
       (the per-table .mo-list scrolling is gone). */
    min-height: 0;
    overflow-y: auto;
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
  /* M5: .mo-list carries NO cap or scrolling of its own — the rows
     run to the section's end and .mo-body scrolls them (the
     border/radius keep framing the whole list). */
  .mo-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius);
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
  /* A hidden fixed stat dims in place — it is still a listed, movable
     row (the eye tells you it is off the view). */
  .mo-row.mo-hidden {
    opacity: 0.6;
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
  /* M1: the row's whole control cluster, right-aligned — the eye and
     the pin toggle sit beside the ↑↓ instead of after the label. */
  .mo-acts {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mo-moves {
    /* the right-alignment moved OUT to .mo-acts (M1) — this stays a
       plain flex pair inside the cluster. */
    display: flex;
    gap: 2px;
  }
  /* M6 — the pin toggle's pinned state. Deliberately NOT .bld-pin-on:
     that spelling is Builder's (bld- = its component prefix, in
     public/style-m3a.css), and the one-prefix-per-component rule keeps
     it out of this dialog; pin-state is not a shared concept class
     either (style.css spells no unprefixed .pin-* concept, and this
     wave freezes style-m3a.css), so the dialog scopes its own twin —
     the same accent tint, cross-referencing Builder's spelling. */
  .mo-pin-on {
    color: var(--accent);
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
