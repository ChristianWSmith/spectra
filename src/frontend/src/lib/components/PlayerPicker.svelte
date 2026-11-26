<script>
  import { DASH } from '../builtinhelpers.js';
  import { stepActive, onListKey, scrollActive } from '../listnav.js';
  // Player selector for the Reports target panel — the native <select>
  // ("rep-player") replacement, styled to MatchPicker: the trigger shows
  // the current selection, the popover lists players the way the app
  // presents them elsewhere (name, side + the statline when the player
  // appears in the selected match, the career line when they do not)
  // behind a filter box.
  //
  // Keyboard follows MatchPicker/CommandPalette: the filter input owns
  // focus, ↑↓ move the highlight, Enter selects, Esc closes (and returns
  // focus to the trigger); clicking outside closes. Rows are real buttons;
  // aria-activedescendant on the combobox points at the highlighted option.
  import { fmtMetric } from '../fmt.js';
  import { careerRows, onMetricDone } from '../services.js';
  import { metricPresentation, metricStateTitle } from '../metricstate.js';
  import * as S from '../strings/index.js'; // chrome copy (strings-audit Check B)

  // players: ProfileSummary rows (ProfileService.ListPlayers) — steamId,
  // name, matches, lastSeen (neither a career count nor ADR: the Go DTO
  // carries no gameplay stat this picker may show — the career line reads
  // the stored `career_matches` / `career_adr` metric rows instead).
  // stats: steamId → PlayerStatsRow from MatchService.GetScoreboard for
  // the report's match (may be empty) — the row's IDENTITY fields only
  // (side, presence): every STATISTIC below comes from a seed row.
  // seeds: seed name → {def, bySteam: steamId → {value, n, format}} —
  // the match-scope reads Reports fetches beside sbBySteam (design
  // §3.1/Q2's compound-per-half rule, the owner ruling of 2026-11-17:
  // every half reads its seed). The CAREER pair below is this picker's
  // own batched bucket read, exactly as its career ADR line always was.
  // states: metricId → {state, error} — the compute-state read Reports
  // already holds, so a half with no fresh row renders the state word
  // in its title instead of the raw column behind it.
  // onerror (optional) receives a failed career read; the picker keeps its empty stats.
  let { players = [], stats = {}, seeds = new Map(), states = new Map(), value = '', onselect = () => {}, id = '', onerror = () => {} } = $props();

  // The list's height budget: below this much room under the trigger, it opens above.
  const POP_ROOM = 340;

  let open = $state(false);
  let query = $state('');
  let active = $state(0);
  let root = $state(null);
  let listEl = $state(null);
  let inputEl = $state(null);
  let triggerEl = $state(null);
  // Opens above the trigger when the room below is short and the room above is more.
  let above = $state(false);

  const cur = $derived(players.find((p) => p.steamId === value) || null);
  const curRow = $derived(stats[value] || null);

  // --- THE statline halves (every number below is a seed row) ----------
  const KDA_HALVES = ['kills', 'deaths', 'assists'];
  const CAREER_SEEDS = ['career_matches', 'career_adr'];

  // The career pair: the ONE batched bucket read (services.careerRows —
  // never per-player calls), refetched when the caller's list changes
  // and when a sweep replaces the stored rows. A failed read (or a seed
  // the catalog does not carry) leaves the map EMPTY: those halves are
  // the honest dash, never a number from the summary row.
  let career = $state(new Map()); // seed name → {def, bySteam}
  let careerReload = $state(0);
  $effect(() => onMetricDone(() => (careerReload += 1)));
  $effect(() => {
    players; // refetch when the caller's list changes
    careerReload; // …and when a sweep replaces the stored rows
    let live = true;
    career = new Map();
    careerRows(CAREER_SEEDS)
      .then((m) => {
        if (live) career = m;
      })
      .catch((e) => {
        if (live) {
          career = new Map();
          onerror(e);
        }
      });
    return () => (live = false);
  });

  // One seed's entry, whichever grain carries it (the names never
  // collide: the match-scope five above, the career pair below).
  function seedEntry(name) {
    return seeds.get(name) || career.get(name) || null;
  }
  function seedRow(name, p) {
    const e = seedEntry(name);
    return e ? e.bySteam.get(p.steamId) || null : null;
  }
  // unitHasRows — the sibling coverage the state machine needs: does the
  // read produce ANY row for this seed? (For the career pair that is the
  // whole bucket, exactly like the value reads' coverage.)
  function seedHasRows(name) {
    const e = seedEntry(name);
    return !!e && e.bySteam.size > 0;
  }
  // THE state machine for one half (lib/metricstate.js — design §5):
  // fresh → the stored value, no fresh row → the dash, a live/behind/
  // failed state → the state word (which reaches the cell through the
  // TITLE — never a chip inside a picker row, invariant 9).
  function seedPres(name, p) {
    const e = seedEntry(name);
    const st = e && states.get(e.def.id) ? states.get(e.def.id).state : '';
    return metricPresentation(st, seedRow(name, p), seedHasRows(name));
  }
  // One half's rendered number: the fresh value through the seed's OWN
  // format tag, the honest dash otherwise — never the raw scoreboard or
  // profile field behind it, never a fabricated 0.
  function seedText(name, p) {
    const pres = seedPres(name, p);
    if (pres.kind !== 'value') return DASH;
    const e = seedEntry(name);
    return fmtMetric(pres.value, e ? e.def.format : '');
  }
  // A single-seed cell's tooltip: fresh → the seed's OWN `doc` (the
  // Formula — the tooltip medium the tiering rule measures wholesale),
  // dash → the no-data copy, a state → its state word (failed carries
  // the engine's error text).
  function seedTitle(name, p) {
    const pres = seedPres(name, p);
    const e = seedEntry(name);
    if (pres.kind === 'value') {
      if (e && e.def.doc) return e.def.doc;
      return `${(e && e.def.title) || name}`;
    }
    if (pres.kind === 'nodata') return 'no data for this player';
    return metricStateTitle(pres.state, (e && states.get(e.def.id) && states.get(e.def.id).error) || '');
  }
  // The rounds half keeps its "24r" shape on a value and the plain dash
  // otherwise (an "—r" would read as a unit the number never had).
  function roundsText(p) {
    const pres = seedPres('rounds_played', p);
    return pres.kind === 'value' ? `${seedText('rounds_played', p)}r` : DASH;
  }
  // The K/D/A line is the compound form (design Q2): the fresh value
  // through each seed's format tag, the dash otherwise, and the state
  // word in the TITLE — the cell's own chrome label while every half
  // shows its number (it carried that tooltip before the conversion),
  // the first non-value half's state word otherwise (invariant 9: never
  // a chip inside a compound cell, never a raw field).
  function kdaText(p) {
    return KDA_HALVES.map((n) => seedText(n, p)).join('/');
  }
  function kdaTitle(p) {
    for (const n of KDA_HALVES) {
      if (seedPres(n, p).kind !== 'value') return seedTitle(n, p);
    }
    return S.common.playerPickerKdaTitle;
  }
  // The career pair's value gate: the career-matches half's own number
  // (the old `p.matches > 0` gate on the ADR line, now the seed's) — a
  // gap never claims "they have played matches", so the ADR line stays
  // hidden behind it exactly as before.
  function careerMatchesPositive(p) {
    const pres = seedPres('career_matches', p);
    return pres.kind === 'value' && pres.value > 0;
  }

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
    const r = triggerEl?.getBoundingClientRect();
    if (r) {
      const below = window.innerHeight - r.bottom;
      above = below < POP_ROOM && r.top > below;
    }
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
    active = stepActive(filtered.length, activeIdx, d);
  }

  function onInputKey(e) {
    onListKey(e, { move, pick: () => pick(activeIdx) });
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
    scrollActive(listEl, '.pp-opt.active');
  });
</script>

<div class="pp" bind:this={root}>
  <button
    type="button"
    class="pp-trigger multi-trigger"
    id={id || null}
    bind:this={triggerEl}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? 'pp-list' : null}
    aria-label={S.common.playerPickerTriggerLabel}
    onclick={togglePop}
  >
    {#if cur}
      <span class="pp-trigger-name">{cur.name || cur.steamId}</span>
      {#if curRow}
        <span class="chip side {curRow.side}">{(curRow.side || '?').toUpperCase()}</span>
      {/if}
      <span class="pp-trigger-id mono muted">{cur.steamId}</span>
    {:else}
      <span class="muted">{S.common.playerPickerSelectPlayer}</span>
    {/if}
    <span class="pp-caret" aria-hidden="true"><span class="codicon {open ? 'codicon-chevron-up' : 'codicon-chevron-down'}"></span></span>
  </button>

  {#if open}
    <div class="pp-pop" class:up={above}>
      <input
        class="input pp-search"
        type="search"
        placeholder="Filter players…"
        aria-label={S.common.playerPickerFilterLabel}
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
        <div class="pp-list" id="pp-list" role="listbox" aria-label={S.common.playerPickerListLabel} bind:this={listEl}>
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
                  <!-- Every half reads its SEED row (design §3.1/Q2 —
                       compound per half; the owner ruling of 2026-11-17:
                       the metrics system IS the gameplay-statistics
                       layer): the stored value through the seed's own
                       format tag, the honest dash otherwise. The raw
                       scoreboard fields behind the row (kills, deaths,
                       adr, roundsPlayed) are identity here and NEVER
                       render — no raw fallback. -->
                  <span class="muted num pp-kda" title={kdaTitle(p)}>{kdaText(p)}</span>
                  <span class="num pp-adr" title={seedTitle('adr', p)}>{seedText('adr', p)}</span>
                  <span class="muted num pp-rounds" title={seedTitle('rounds_played', p)}>{roundsText(p)}</span>
                {:else}
                  <span class="muted num" title={seedTitle('career_matches', p)}
                    >{seedPres('career_matches', p).kind === 'value'
                      ? seedText('career_matches', p) + S.common.playerPickerMatchesSuffix
                      : DASH}</span
                  >
                  {#if careerMatchesPositive(p)}
                    <span class="muted num" title={seedTitle('career_adr', p)}>{seedText('career_adr', p)}{S.common.playerPickerAdrSuffix}</span>
                  {/if}
                {/if}
              </span>
              <span class="pp-line2 muted">
                <span class="mono">{p.steamId}</span>
                <span>{row ? S.common.playerPickerInMatch : S.common.playerPickerNotInMatch}</span>
                {#if p.lastSeen}
                  <span>{S.common.playerPickerSeenPrefix}{p.lastSeen}</span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="pp-empty muted" role="status">
          {query.trim()
            ? S.fill(S.common.playerPickerNoMatch, { q: query.trim() })
            : S.common.playerPickerEmpty}
        </p>
      {/if}
      <div class="pp-foot muted">
        <span><span class="codicon codicon-arrow-up"></span><span class="codicon codicon-arrow-down"></span>{S.common.pickerMoveHint}</span><span>{S.common.pickerEnterSelect}</span><span>{S.common.pickerEscClose}</span>
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
    max-width: 460px;
    min-width: 0;
    /* The picker's caret (below) is the only chevron: drop the select's static one. */
    background-image: none;
    padding-right: 8px;
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

  .pp-pop.up {
    top: auto;
    bottom: calc(100% + 4px);
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
