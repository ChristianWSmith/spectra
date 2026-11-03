<script>
  import {
    getEvents,
    getEvent,
    getVoicePresence,
    takePendingTimelineFilter,
    setPendingSeek,
    listSavedFilters,
    saveFilter,
    deleteSavedFilter,
  } from '../services.js';
  import { prettyJson } from '../fmt.js';
  import FilterBar from '../components/FilterBar.svelte';
  import VoiceLanes from '../components/VoiceLanes.svelte';

  let { id = 0, nav = () => {} } = $props();

  const ROW_H = 30;
  const OVERSCAN = 8;

  // Advanced filter state. Seeded from the sessionStorage
  // pending-filter hand-off (services.js TIMELINE_PENDING_KEY) — the whole
  // extended object (kind/steamId/round/weapon/ticks/dmg/distance/headshot/
  // bbox) passes through, FilterBar normalizes missing fields.
  const DEFAULT_FILTER = {
    round: -1,
    kind: '',
    steamId: '',
    weapon: '',
    tickFrom: 0,
    tickTo: 0,
    dmgMin: 0,
    dmgMax: 0,
    distanceMax: 0,
    headshotOnly: false,
    bbox: null,
  };

  let filter = $state({ ...DEFAULT_FILTER, ...(takePendingTimelineFilter() || {}) });

  let events = $state([]);
  let selected = $state(null); // EventDetail
  let detailError = $state('');
  let listError = $state('');
  let scrollTop = $state(0);
  let viewportH = $state(600);
  let listEl = $state(null);
  let copied = $state(false);
  let scrollReset = $state(0); // bump → scroll list back to top

  // M4: voice presence gates the lanes strip + "Hear ±10s" affordance.
  // Voice hasVoice only — absence is the normal MM case.
  let voice = $state(null);

  $effect(() => {
    let live = true;
    getVoicePresence(id)
      .then((p) => {
        if (live) voice = p;
      })
      .catch(() => {
        /* lanes/hear simply hidden */
      });
    return () => (live = false);
  });

  // The command palette can jump Timeline to another match without
  // remounting this component (the Timeline tab stays active, only the
  // id prop changes) — the constructor's take above already ran, so re-arm
  // the pending-filter hand-off on every match switch. On first mount this
  // finds nothing (the seed above consumed it).
  $effect(() => {
    const mid = id;
    const pending = mid ? takePendingTimelineFilter() : null;
    if (pending) filter = { ...DEFAULT_FILTER, ...pending };
  });

  // Saved filter presets (scope "match").
  let saved = $state([]);
  let savedSel = $state('');
  let savedError = $state('');

  async function refreshSaved() {
    try {
      const rows = await listSavedFilters();
      saved = (rows || []).filter((s) => s.scope === 'match');
      if (savedSel && !saved.some((s) => String(s.id) === savedSel)) savedSel = '';
    } catch (e) {
      savedError = errText(e);
    }
  }

  $effect(() => {
    refreshSaved();
  });

  // Refetch only when the filter object changes — a 50k fetch is a few MB,
  // so no per-keystroke refetch (the controls commit on change/blur).
  $effect(() => {
    const f = {
      matchId: id,
      round: typeof filter.round === 'number' ? filter.round : -1,
      kind: filter.kind || '',
      steamId: filter.steamId || '',
      weapon: filter.weapon || '',
      tickFrom: Number(filter.tickFrom) || 0,
      tickTo: Number(filter.tickTo) || 0,
      dmgMin: Number(filter.dmgMin) || 0,
      dmgMax: Number(filter.dmgMax) || 0,
      distanceMax: Number(filter.distanceMax) || 0,
      headshotOnly: !!filter.headshotOnly,
      bbox: filter.bbox || undefined,
      offset: 0,
      limit: 50000, // store hard cap
    };
    let live = true;
    listError = '';
    getEvents(f)
      .then((rows) => {
        if (!live) return;
        events = rows || [];
        selected = null;
        scrollTop = 0;
        scrollReset++;
      })
      .catch((e) => {
        if (live) listError = errText(e);
      });
    return () => (live = false);
  });

  // Scroll-to-top on filter change (DOM write only — no state loop).
  $effect(() => {
    scrollReset;
    if (listEl) listEl.scrollTop = 0;
  });

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  function onFilterChange(next) {
    filter = next;
  }

  // --- Saved presets ---------------------------------------------------------
  function applySaved() {
    const s = saved.find((x) => String(x.id) === savedSel);
    if (!s) return;
    try {
      const parsed = JSON.parse(s.filterJson || '{}');
      filter = { ...filter, ...parsed, round: typeof parsed.round === 'number' ? parsed.round : -1 };
      savedError = '';
    } catch (e) {
      savedError = 'Saved filter is not valid JSON: ' + errText(e);
    }
  }

  async function saveCurrent() {
    const name = prompt('Save current filter as:');
    if (!name) return;
    try {
      // Match-scope preset: the extended filter minus matchId/offset/limit —
      // applying it later rebinds to the match being viewed.
      const { round, kind, steamId, weapon, tickFrom, tickTo, dmgMin, dmgMax, distanceMax, headshotOnly, bbox } = filter;
      const json = JSON.stringify({
        round,
        kind,
        steamId,
        weapon,
        tickFrom,
        tickTo,
        dmgMin,
        dmgMax,
        distanceMax,
        headshotOnly,
        bbox,
      });
      const row = await saveFilter(name, 'match', json);
      await refreshSaved();
      if (row) savedSel = String(row.id);
      savedError = '';
    } catch (e) {
      savedError = errText(e);
    }
  }

  async function removeSaved() {
    const s = saved.find((x) => String(x.id) === savedSel);
    if (!s) return;
    try {
      await deleteSavedFilter(s.id);
      savedSel = '';
      savedError = '';
      await refreshSaved();
    } catch (e) {
      savedError = errText(e);
    }
  }

  function onScroll(e) {
    scrollTop = e.currentTarget.scrollTop;
  }

  // Fixed-row-height virtualization: render only the visible slice,
  // absolutely positioned inside a full-height spacer.
  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
  const visibleCount = $derived(Math.ceil(viewportH / ROW_H) + OVERSCAN * 2);
  const slice = $derived(events.slice(start, start + visibleCount));
  const spacerH = $derived(events.length * ROW_H);

  async function select(ev) {
    detailError = '';
    copied = false;
    try {
      const d = await getEvent(ev.id);
      selected = d;
      if (!d) detailError = 'Event not found.';
    } catch (e) {
      detailError = errText(e);
    }
  }

  async function copyDetail() {
    if (!selected) return;
    const text =
      (selected.detailJson || '') +
      (selected.rawJson ? '\n' + selected.rawJson : '');
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch (e) {
      detailError = errText(e);
    }
  }

  function flagsOf(e) {
    const f = [];
    if (e.headshot) f.push(['HS', 'headshot']);
    if (e.wallbang) f.push(['WB', 'wallbang']);
    if (e.noscope) f.push(['NS', 'no scope']);
    if (e.throughSmoke) f.push(['SMK', 'through smoke']);
    if (e.attackerBlind) f.push(['BLD', 'attacker blind']);
    if (e.assistedFlash) f.push(['AFL', 'assisted flash']);
    return f;
  }

  // ▶ hands the event's tick to the replay via the pendingSeek contract.
  function watchTick(ev, e) {
    e.stopPropagation();
    setPendingSeek({ tick: ev.tick });
    nav(`/replay/${id}`);
  }

  // M4 comms-around (walkthrough): open replay AT the event with
  // playback + voice on — the audio engine starts from there. play/voice
  // are extra pendingSeek keys Replay understands; other writers omit them.
  function hearTick(ev, e) {
    e.stopPropagation();
    setPendingSeek({ tick: ev.tick, play: true, voice: true });
    nav(`/replay/${id}`);
  }

  // Lanes click → same exit path (index-only, audio follows).
  function laneSeek(tick) {
    setPendingSeek({ tick, play: true, voice: true });
    nav(`/replay/${id}`);
  }

  // Profile icon on a row → cross-match profile (#/player/:steamid).
  function isSteam(s) {
    return /^\d{17}$/.test(s || '');
  }

  function watchProfile(steam, e) {
    e.stopPropagation();
    nav(`/player/${steam}`);
  }
</script>

<div class="view timeline-view">
  <header class="view-header">
    <h1>Timeline</h1>
    <div class="spacer"></div>
    <div class="filter-bar filt-saved" role="group" aria-label="Saved filters">
      <label class="sr-only" for="tl-saved">Saved filter</label>
      <select class="input" id="tl-saved" value={savedSel} onchange={(e) => (savedSel = e.currentTarget.value)}>
        <option value="">Saved filters…</option>
        {#each saved as s (s.id)}
          <option value={String(s.id)}>{s.name}</option>
        {/each}
      </select>
      <button class="btn small" disabled={!savedSel} onclick={applySaved}>Apply</button>
      <button
        class="btn small"
        disabled={!savedSel}
        title="Delete the selected saved filter"
        onclick={removeSaved}
      >✕</button>
      <button class="btn small" onclick={saveCurrent} title="Save the current filter as a preset">Save</button>
    </div>
    <span class="muted num">{events.length} events</span>
  </header>

  <div class="filter-wrap">
    <FilterBar {id} filter={filter} onchange={onFilterChange} />
    {#if savedError}
      <p class="error" role="alert">{savedError}</p>
    {/if}
  </div>

  {#if listError}
    <p class="error" role="alert">{listError}</p>
  {/if}

  {#if voice && voice.hasVoice}
    <div class="voice-lanes-wrap">
      <VoiceLanes matchId={id} onSeek={laneSeek} />
    </div>
  {/if}

  <div class="timeline-body">
    <div
      class="vlist"
      bind:this={listEl}
      bind:clientHeight={viewportH}
      onscroll={onScroll}
      aria-label="Events"
    >
      <div class="vspacer" style="height:{spacerH}px">
        {#each slice as ev, i (ev.id)}
          <button
            class="vrow"
            class:active={selected?.id === ev.id}
            style="top:{(start + i) * ROW_H}px"
            onclick={(e) => {
              if (e.target instanceof Element && e.target.closest('.vrow-play, .filt-prof'))
                return;
              select(ev);
            }}
          >
            <span
              class="vrow-play"
              role="button"
              tabindex="-1"
              title="Watch at tick {ev.tick} in replay"
              aria-label="Watch tick {ev.tick} in replay"
              onclick={(e) => watchTick(ev, e)}
              onkeydown={(e) =>
                (e.key === 'Enter' || e.key === ' ') &&
                (e.preventDefault(), watchTick(ev, e))}>▶</span
            >
            <span class="num seq">{ev.seq}</span>
            <span class="mono tick">{ev.tick}</span>
            <span class="chip round-chip">R{ev.round}</span>
            <span class="chip kind">{ev.kind}</span>
            <span class="name atk"
              >{ev.attackerName || '—'}{#if isSteam(ev.attacker)}
                <span
                  class="filt-prof"
                  role="button"
                  tabindex="-1"
                  title="Open {ev.attackerName} profile"
                  aria-label="Open {ev.attackerName} profile"
                  onclick={(e) => watchProfile(ev.attacker, e)}
                  onkeydown={(e) =>
                    (e.key === 'Enter' || e.key === ' ') &&
                    (e.preventDefault(), watchProfile(ev.attacker, e))}>◉</span
                >
              {/if}</span
            >
            <span class="mono weapon">{ev.weapon || ''}</span>
            <span class="name vic"
              >{ev.victimName || '—'}{#if isSteam(ev.victim)}
                <span
                  class="filt-prof"
                  role="button"
                  tabindex="-1"
                  title="Open {ev.victimName} profile"
                  aria-label="Open {ev.victimName} profile"
                  onclick={(e) => watchProfile(ev.victim, e)}
                  onkeydown={(e) =>
                    (e.key === 'Enter' || e.key === ' ') &&
                    (e.preventDefault(), watchProfile(ev.victim, e))}>◉</span
                >
              {/if}</span
            >
            <span class="flags">
              {#each flagsOf(ev) as [code, title] (code)}
                <span class="chip flag" {title}>{code}</span>
              {/each}
            </span>
            <span class="num dmg">{ev.dmg || ''}</span>
            <span class="num dist">{ev.distance ? Math.round(ev.distance) : ''}</span>
          </button>
        {/each}
        {#if events.length === 0 && !listError}
          <p class="empty muted">No events match these filters.</p>
        {/if}
      </div>
    </div>

    <aside class="detail-pane" aria-label="Event detail">
      {#if detailError}
        <p class="error" role="alert">{detailError}</p>
      {/if}
      {#if selected}
        <div class="detail-head">
          <span class="chip kind">{selected.kind}</span>
          <span class="mono">#{selected.seq}</span>
          <span class="mono muted">tick {selected.tick}</span>
          <span class="chip round-chip">R{selected.round}</span>
          <div class="spacer"></div>
          {#if voice && voice.hasVoice}
            <button
              class="btn small hear-btn"
              title="Open replay at this event with voice on — hear comms around it (±10s window from the replay engine)"
              onclick={(e) => hearTick(selected, e)}>Hear ±10s ▶</button
            >
          {/if}
          <button class="btn small" onclick={copyDetail}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <dl class="facts">
          <div>
            <dt>Attacker</dt>
            <dd>{selected.attackerName || '—'}</dd>
          </div>
          <div>
            <dt>Victim</dt>
            <dd>{selected.victimName || '—'}</dd>
          </div>
          <div>
            <dt>Assister</dt>
            <dd>{selected.assisterName || '—'}</dd>
          </div>
          <div>
            <dt>Weapon</dt>
            <dd class="mono">{selected.weapon || '—'}</dd>
          </div>
          <div>
            <dt>Damage</dt>
            <dd class="num">{selected.dmg}</dd>
          </div>
          <div>
            <dt>Distance</dt>
            <dd class="num">{selected.distance ? Math.round(selected.distance) : '—'}</dd>
          </div>
          <div>
            <dt>Hitgroup</dt>
            <dd>{selected.hitgroup || '—'}</dd>
          </div>
          <div>
            <dt>Site</dt>
            <dd>{selected.site || '—'}</dd>
          </div>
          <div class="fact-wide">
            <dt>Flags</dt>
            <dd>
              {#if selected.headshot}<span class="chip flag" title="headshot">HS</span>{/if}
              {#if selected.wallbang}<span class="chip flag" title="wallbang">WB</span>{/if}
              {#if selected.noscope}<span class="chip flag" title="no scope">NS</span>{/if}
              {#if selected.throughSmoke}<span class="chip flag" title="through smoke">SMK</span>{/if}
              {#if selected.attackerBlind}<span class="chip flag" title="attacker blind">BLD</span>{/if}
              {#if selected.assistedFlash}<span class="chip flag" title="assisted flash">AFL</span>{/if}
              {#if !selected.headshot && !selected.wallbang && !selected.noscope && !selected.throughSmoke && !selected.attackerBlind && !selected.assistedFlash}
                <span class="muted">none</span>
              {/if}
            </dd>
          </div>
        </dl>
        <details class="json-block" open>
          <summary>detail.json</summary>
          <pre class="mono">{prettyJson(selected.detailJson)}</pre>
        </details>
        <details class="json-block">
          <summary>raw.json</summary>
          <pre class="mono">{prettyJson(selected.rawJson)}</pre>
        </details>
      {:else}
        <p class="muted">Select an event to inspect its payload.</p>
      {/if}
    </aside>
  </div>
</div>
