<script>
  import {
    getEvents,
    getEvent,
    getRounds,
    getScoreboard,
    takePendingTimelineFilter,
  } from '../services.js';
  import { prettyJson } from '../fmt.js';

  let { id = 0, nav = () => {} } = $props();

  // Hardcoded kind list — mirrors models.EventKind (Go side).
  const KINDS = [
    'kill',
    'damage',
    'blind',
    'bomb_plant',
    'bomb_defuse',
    'bomb_explode',
    'bomb_drop',
    'bomb_pickup',
    'grenade_throw',
    'grenade',
    'round_start',
    'round_end',
    'player_connect',
    'player_disconnect',
  ];

  const ROW_H = 30;
  const OVERSCAN = 8;

  let events = $state([]);
  let rounds = $state([]);
  let players = $state([]);
  // Pending-filter hand-off from Match (sessionStorage, read+clear once at
  // init so the first fetch already applies it).
  let initialFilter = takePendingTimelineFilter() || {};
  let roundF = $state(
    typeof initialFilter.round === 'number' ? initialFilter.round : -1,
  ); // -1 = all rounds (0 would mean round zero!)
  let kindF = $state(initialFilter.kind || '');
  let steamF = $state(initialFilter.steamId || '');
  let selected = $state(null); // EventDetail
  let detailError = $state('');
  let listError = $state('');
  let scrollTop = $state(0);
  let viewportH = $state(600);
  let listEl = $state(null);
  let copied = $state(false);
  let scrollReset = $state(0); // bump → scroll list back to top

  // Load filter options (rounds + players).
  $effect(() => {
    let live = true;
    Promise.all([getRounds(id), getScoreboard(id, 'kills', true)])
      .then(([r, sb]) => {
        if (!live) return;
        rounds = r || [];
        players = sb || [];
      })
      .catch((e) => {
        if (live) listError = errText(e);
      });
    return () => (live = false);
  });

  // Refetch only when filters change — a 50k fetch is a few MB, so no
  // per-keystroke refetch (the controls are selects, not inputs).
  $effect(() => {
    const f = {
      matchId: id,
      round: roundF,
      kind: kindF,
      steamId: steamF,
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

  function resetFilters() {
    roundF = -1;
    kindF = '';
    steamF = '';
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
</script>

<div class="view timeline-view">
  <header class="view-header">
    <button class="btn" onclick={() => nav(`/match/${id}`)}>← Match</button>
    <h1>Timeline</h1>
    <div class="spacer"></div>
    <div class="filter-bar" role="group" aria-label="Event filters">
      <label class="sr-only" for="tl-round">Round</label>
      <select class="input" id="tl-round" bind:value={roundF}>
        <option value={-1}>All rounds</option>
        {#each rounds as r (r.number)}
          <option value={r.number}>Round {r.number}</option>
        {/each}
      </select>

      <label class="sr-only" for="tl-kind">Kind</label>
      <select class="input" id="tl-kind" bind:value={kindF}>
        <option value="">All kinds</option>
        {#each KINDS as k (k)}
          <option value={k}>{k}</option>
        {/each}
      </select>

      <label class="sr-only" for="tl-player">Player</label>
      <select class="input" id="tl-player" bind:value={steamF}>
        <option value="">All players</option>
        {#each players as p (p.steamId)}
          <option value={p.steamId}>{p.name}</option>
        {/each}
      </select>

      <button class="btn" onclick={resetFilters}>Reset</button>
      <span class="muted num">{events.length} events</span>
    </div>
  </header>

  {#if listError}
    <p class="error" role="alert">{listError}</p>
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
            onclick={() => select(ev)}
          >
            <span class="num seq">{ev.seq}</span>
            <span class="mono tick">{ev.tick}</span>
            <span class="chip round-chip">R{ev.round}</span>
            <span class="chip kind">{ev.kind}</span>
            <span class="name atk">{ev.attackerName || '—'}</span>
            <span class="mono weapon">{ev.weapon || ''}</span>
            <span class="name vic">{ev.victimName || '—'}</span>
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
