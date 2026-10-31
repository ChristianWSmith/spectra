<script>
  import {
    getMatch,
    getScoreboard,
    getRounds,
    getHeatmap,
    getSpatialSeries,
    setPendingTimelineFilter,
  } from '../services.js';
  import { loadMapPack } from '../components/mapxform.js';
  import HeatmapLayer from '../components/HeatmapLayer.svelte';
  import { fmt1, fmtInt } from '../fmt.js';

  let { id = 0, nav = () => {} } = $props();

  const KINDS = ['presence', 'kills', 'deaths', 'damage'];

  let kind = $state('presence');
  let player = $state(''); // steamId, '' = all
  let team = $state(''); // '' | ct | t
  let roundFrom = $state(-1); // <0 = all
  let roundTo = $state(-1); // <0 = all

  let grid = $state(null);
  let loading = $state(false);
  let error = $state('');
  let players = $state([]);
  let rounds = $state([]);
  let map = $state('');
  let pack = $state(null);
  let matchLoaded = $state(false);
  let packTried = $state(false); // pack load attempt finished (ok or failed)
  let regionNote = $state('');

  let navTimer = null;

  $effect(() => {
    let live = true;
    Promise.all([
      getMatch(id),
      getScoreboard(id, 'kills', true).catch(() => []),
      getRounds(id).catch(() => []),
    ])
      .then(([m, sb, rs]) => {
        if (!live) return;
        map = (m && m.map) || '';
        players = sb || [];
        rounds = rs || [];
        matchLoaded = true;
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  $effect(() => {
    const m = map;
    if (!m) {
      pack = null;
      return;
    }
    let live = true;
    packTried = false;
    loadMapPack(m).then((p) => {
      if (live) {
        pack = p;
        packTried = true;
      }
    });
    return () => (live = false);
  });

  $effect(() => () => {
    if (navTimer) clearTimeout(navTimer);
  });

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  const packNote = $derived.by(() => {
    if (!matchLoaded) return '';
    if (!map) return 'map name unknown — heatmap overlay unavailable';
    if (!pack)
      return packTried
        ? `map pack missing for ${map} — overlay unavailable`
        : 'loading map pack…';
    if (!pack.transform)
      return `map pack for ${map} has no transform — overlay unavailable`;
    if (!pack.meta.radar)
      return `map pack for ${map} has no radar image — overlay on dark grid only`;
    return '';
  });

  // Legend labels must describe the data on screen, not the pending
  // controls (fetch is on-demand, so the two can diverge).
  const unitKind = $derived(grid && grid.kind ? grid.kind : kind);
  const unit = $derived(
    unitKind === 'presence' ? 'time-weighted seconds' : 'count',
  );
  const maxLabel = $derived(
    grid ? (unitKind === 'presence' ? fmt1(grid.max) : fmtInt(grid.max)) : '—',
  );

  const filterKey = (k, p, t, from, to) => `${k}|${p}|${t}|${from}|${to}`;
  let lastKey = $state('');
  const dirty = $derived(
    !!grid && lastKey !== filterKey(kind, player, team, roundFrom, roundTo),
  );

  // The heavy GetHeatmap call fires only on Generate — never on control
  // changes (heatmap generate is the expensive op).
  async function generate() {
    if (roundFrom >= 0 && roundTo >= 0 && roundFrom > roundTo) {
      error = 'round range inverted — first round must be ≤ last';
      return;
    }
    loading = true;
    error = '';
    regionNote = '';
    try {
      grid = await getHeatmap(id, kind, {
        roundFrom,
        roundTo,
        steamId: player,
        team,
      });
      lastKey = filterKey(kind, player, team, roundFrom, roundTo);
    } catch (e) {
      grid = null;
      error = errText(e);
    } finally {
      loading = false;
    }
  }

  // Region drill: cell-sized bbox around the click → pending timeline
  // filter (contract in services.js) → navigate. The note renders first so
  // "filtered by region" is visible before the route switch.
  function onRegion(bbox) {
    setPendingTimelineFilter({ bbox });
    regionNote = `filtered by region — bbox (${Math.round(bbox.minX)}, ${Math.round(bbox.minY)}) → (${Math.round(bbox.maxX)}, ${Math.round(bbox.maxY)})`;
    if (navTimer) clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      navTimer = null;
      nav(`/timeline/${id}`);
    }, 400);
  }
  // --- Spatial series (series only; pattern detection descoped pending -----
  // bomb-site region polygons — see ref/MISSING.md).
  const SPAT_W = 640;
  const SPAT_H = 140;

  let spatKind = $state('spacing'); // spacing|spread
  let series = $state(null); // SpatialSeries
  let spatLoading = $state(false);
  let spatError = $state('');
  let spatGen = 0;

  $effect(() => {
    const k = spatKind;
    const rid = id;
    const my = ++spatGen;
    spatLoading = true;
    spatError = '';
    getSpatialSeries(rid, k, 120)
      .then((s) => {
        if (my !== spatGen) return;
        series = s;
        spatLoading = false;
      })
      .catch((e) => {
        if (my !== spatGen) return;
        series = null;
        spatError = errText(e);
        spatLoading = false;
      });
  });

  // Polyline geometry: x = bucket over match time, y = world units; -1
  // buckets (no valid sample) break the path into separate segments.
  const spatPaths = $derived.by(() => {
    if (!series || !series.values || !series.values.length) {
      return { segs: [], min: 0, max: 0 };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const v of series.values) {
      if (v < 0) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min)) {
      min = 0;
      max = 0;
    }
    const span = Math.max(1e-6, max - min);
    const n = series.values.length;
    const segs = [];
    let cur = [];
    for (let i = 0; i < n; i++) {
      const v = series.values[i];
      if (v < 0) {
        if (cur.length > 1) segs.push(cur);
        cur = [];
        continue;
      }
      const x = n === 1 ? 0 : (i / (n - 1)) * SPAT_W;
      const y = SPAT_H - ((v - min) / span) * SPAT_H;
      cur.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    if (cur.length > 1) segs.push(cur);
    return { segs, min, max };
  });
</script>

<div class="heat-view">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if packNote}
    <p class="heat-note" role="status">{packNote}</p>
  {/if}

  <div class="heat-controls">
    <div class="heat-field">
      <label for="heat-kind">Kind</label>
      <select class="input" id="heat-kind" bind:value={kind}>
        {#each KINDS as k (k)}
          <option value={k}>{k}</option>
        {/each}
      </select>
    </div>
    <div class="heat-field">
      <label for="heat-player">Player</label>
      <select class="input" id="heat-player" bind:value={player}>
        <option value="">All players</option>
        {#each players as p (p.steamId)}
          <option value={p.steamId}>{p.name}</option>
        {/each}
      </select>
    </div>
    <div class="heat-field">
      <label for="heat-team">Team</label>
      <select class="input" id="heat-team" bind:value={team}>
        <option value="">Both</option>
        <option value="ct">CT</option>
        <option value="t">T</option>
      </select>
    </div>
    <div class="heat-field">
      <label for="heat-from">Rounds from</label>
      <select class="input" id="heat-from" bind:value={roundFrom}>
        <option value={-1}>All</option>
        {#each rounds as r (r.number)}
          <option value={r.number}
            >R{r.number}{r.warmup ? ' (wu)' : ''}</option
          >
        {/each}
      </select>
    </div>
    <div class="heat-field">
      <label for="heat-to">Rounds to</label>
      <select class="input" id="heat-to" bind:value={roundTo}>
        <option value={-1}>All</option>
        {#each rounds as r (r.number)}
          <option value={r.number}
            >R{r.number}{r.warmup ? ' (wu)' : ''}</option
          >
        {/each}
      </select>
    </div>
    <button class="btn primary heat-generate" disabled={loading} onclick={generate}>
      {loading ? 'Generating…' : grid ? 'Regenerate' : 'Generate'}
    </button>
  </div>

  {#if regionNote}
    <p class="heat-region-note" role="status">
      <span class="chip heat-region">filtered by region</span>
      <span class="mono muted">{regionNote}</span>
    </p>
  {/if}

  {#if dirty}
    <p class="heat-stale muted" role="status">
      controls changed — press Regenerate to apply them to the raster
    </p>
  {/if}

  {#if grid}
    <div class="heat-legend">
      <span class="mono heat-legend-label">0</span>
      <span class="heat-ramp" aria-hidden="true"></span>
      <span class="mono heat-legend-label">{maxLabel}</span>
      <span class="chip heat-unit">{unit}</span>
      <span class="muted"
        >{fmtInt(grid.samples)} samples · {grid.w}×{grid.h} grid · log-ish
        scale</span
      >
    </div>
  {/if}

  <HeatmapLayer {map} {pack} {grid} {onRegion} />

  {#if grid}
    <p class="heat-hint muted">
      Click the map to filter the timeline by region (cell-sized bbox).
    </p>
  {:else if !loading}
    <p class="heat-empty muted">
      Choose filters and press Generate — heatmaps are computed on demand.
    </p>
  {/if}

  <section class="panel spat-panel">
    <h2>Spatial series</h2>
    <div class="spat-controls">
      <div class="sett-seg" role="group" aria-label="Series kind">
        <button
          class="btn"
          class:primary={spatKind === 'spacing'}
          aria-pressed={spatKind === 'spacing'}
          onclick={() => (spatKind = 'spacing')}>spacing</button
        >
        <button
          class="btn"
          class:primary={spatKind === 'spread'}
          aria-pressed={spatKind === 'spread'}
          onclick={() => (spatKind = 'spread')}>spread</button
        >
      </div>
      <span class="muted"
        >{spatKind === 'spacing'
          ? 'average distance between alive teammates'
          : 'mean pairwise distance across all alive players'} —
        world units over match time</span
      >
      {#if series && !spatLoading}
        <span class="chip" title="Compute time">{series.ms} ms</span>
      {/if}
    </div>
    {#if spatError}
      <p class="error" role="alert">{spatError}</p>
    {/if}
    {#if spatLoading}
      <p class="muted" role="status">Computing series…</p>
    {:else if series}
      <svg
        class="spat-svg"
        viewBox="0 0 {SPAT_W} {SPAT_H}"
        preserveAspectRatio="none"
        role="img"
        aria-label="{spatKind} series over match time"
      >
        {#each spatPaths.segs as seg, i (i)}
          <polyline points={seg.join(' ')} />
        {/each}
      </svg>
      <div class="spat-axis muted">
        <span class="mono">max {fmtInt(spatPaths.max)}</span>
        <span class="mono"
          >{series.buckets} buckets · ticks {series.fromTick}–{series.toTick}</span
        >
        <span class="mono">min {fmtInt(spatPaths.min)}</span>
      </div>
    {/if}
    <p class="muted spat-desc">
      Pattern detection (executes/setups) descoped — needs bomb-site region
      polygons (see ref/MISSING.md).
    </p>
  </section>
</div>
