<script>
  import {
    getMatch,
    getScoreboard,
    getRounds,
    getHeatmap,
    errText,
  } from '../services.js';
  // The signed kd raster has its own Go entry point (heatmap.go
  // GetHeatmapKD) — called on the binding directly; every other kind
  // shares getHeatmap.
  import { AnalyticsService } from '../../../bindings/github.com/ChristianWSmith/spectra';
  import { HEAT_CORE_KINDS, HEAT_GRENADE_THROW_KINDS, HEAT_GRENADE_DET_KINDS, heatKindLabel, heatRegionCats } from '../heatkinds.js';
  import { HEAT_STOPS, DEATH_STOPS, rampCss, signedRampCss } from '../heatramp.js';
  import { loadMapPack } from '../components/mapxform.js';
  import HeatmapLayer from '../components/HeatmapLayer.svelte';
  import { fmt1, fmtInt } from '../fmt.js';
  import { isCounted } from '../rounds.js';
  import { replayHash } from '../nav.js';
  import { listedPlayers } from '../players.js';

  let { id = 0, nav = () => {} } = $props();

  // The kind registry lives in lib/heatkinds.js (pinned to Go's
  // grenadeHeatmapKinds by its test) — core kinds, then one option per
  // grenade type in each flavor (thrown origins / detonations).
  const KIND_GROUPS = [
    { label: 'Overview', kinds: HEAT_CORE_KINDS },
    { label: 'Grenade thrown', kinds: HEAT_GRENADE_THROW_KINDS },
    { label: 'Grenade detonation', kinds: HEAT_GRENADE_DET_KINDS },
  ];

  let kind = $state('presence');
  let player = $state(''); // steamId, '' = all
  let team = $state(''); // '' | ct | t
  let roundFrom = $state(-1); // <0 = all
  let roundTo = $state(-1); // <0 = all

  let grid = $state(null);
  // Layer (floor) selector: `layer` is the LIVE selection — the radar
  // image switches with it immediately — while `gridLayer` is the layer
  // the displayed raster was FETCHED for, so a pending raster is never
  // presented as another floor's data (owner decision: hybrid timing —
  // Regenerate applies the band; the dirty banner below gates it).
  let layer = $state(0);
  let gridLayer = $state(0);
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
        players = listedPlayers(sb) || [];
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
    // A different map may declare different panels — drop any floor
    // selection rather than keeping an index the new pack may not have
    // (index 0 is the canonical default, layers.js "default first").
    layer = 0;
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

  const packNote = $derived.by(() => {
    if (!matchLoaded) return '';
    if (!map) return 'map name unknown — heatmap overlay unavailable';
    if (!pack)
      return packTried
        ? `map not found for ${map} — plain grid, no radar art`
        : 'loading map pack…';
    if (!pack.transform)
      return `map pack for ${map} has no transform — plain grid, no radar art`;
    if (!pack.meta.radar)
      return `map pack for ${map} has no radar image — overlay on dark grid only`;
    return '';
  });

  // The pack's radar panels — makeTransform's ONE pack→layers reader
  // (lib/components/mapxform.js): default first, each with its world-Z
  // band (zMin/zMax) and image file. Absent = single-floor pack.
  const layers = $derived(
    pack && pack.transform && Array.isArray(pack.transform.layers) ? pack.transform.layers : [],
  );
  // The selector shows only for a genuinely multi-floor pack: a no-pack /
  // plain-grid fallback and a single-layer pack keep the previous
  // one-raster behavior byte-identical (a bundled pack that declares
  // layers but ships no pixels still shows the selector — the plain-grid
  // presentation is packNote's, the band filter still applies).
  // Deliberately NO "All floors" option: one raster cannot be split — an
  // unfiltered raster painted on one floor's radar would show cross-floor
  // samples at the wrong XY.
  const showLayers = $derived(layers.length >= 2);

  // Legend labels must describe the data on screen, not the pending
  // controls (fetch is on-demand, so the two can diverge).
  const unitKind = $derived(grid && grid.kind ? grid.kind : kind);
  const unit = $derived(
    unitKind === 'presence'
      ? 'time-weighted seconds'
      : unitKind === 'kd'
        ? 'kills − deaths (net)'
        : 'count',
  );
  const maxLabel = $derived(
    grid ? (unitKind === 'presence' ? fmt1(grid.max) : fmtInt(grid.max)) : '—',
  );

  const filterKey = (k, p, t, from, to, l) => `${k}|${p}|${t}|${from}|${to}|${l}`;
  let lastKey = $state('');
  // The layer is part of the key: switching floors changes the band the
  // NEXT raster is fetched with, so the pending raster is stale until
  // Regenerate — the same dirty/stale gate as kind and the other controls.
  const dirty = $derived(
    !!grid && lastKey !== filterKey(kind, player, team, roundFrom, roundTo, layer),
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
    // The fetch is FOR the layer selected right now: the band it sends and
    // the gridLayer it records must be that one index, even if the radar
    // is flipped to another floor while the call is in flight.
    const sel = layer;
    const l = layers[sel];
    try {
      // The pack's own z band for the selected floor — half-open
      // [zMin, zMax), the convention layerIndexForZ applies
      // (lib/replay/layers.js) — so the raster holds only that floor's
      // samples. A missing Z belongs to the default layer (index 0) there,
      // hence includeUnknownZ only for layer 0.
      const filter = {
        roundFrom,
        roundTo,
        steamId: player,
        team,
        zMin: l ? l.zMin : null,
        zMax: l ? l.zMax : null,
        includeUnknownZ: sel === 0,
      };
      // kd is the signed kills−deaths raster (heatmap.go GetHeatmapKD);
      // every other kind shares GetHeatmap.
      grid =
        kind === 'kd'
          ? await AnalyticsService.GetHeatmapKD(id, filter)
          : await getHeatmap(id, kind, filter);
      gridLayer = sel;
      lastKey = filterKey(kind, player, team, roundFrom, roundTo, sel);
    } catch (e) {
      grid = null;
      error = errText(e);
    } finally {
      loading = false;
    }
  }

  // Region drill: cell-sized bbox around the click → the canonical event
  // browser (Replay's landmark feed) scoped to that region. The note
  // renders first so "filtered by region" is visible before the route
  // switch.
  function onRegion(bbox) {
    regionNote = `filtered by region — bbox (${Math.round(bbox.minX)}, ${Math.round(bbox.minY)}) → (${Math.round(bbox.maxX)}, ${Math.round(bbox.maxY)})`;
    // Mirror the viewed heatmap kind: a damage region drill enables the
    // damage category too (kills/deaths are kill events; presence has no
    // event category), a grenade drill opens exactly that flavor's
    // events — throws (grenade_throws) or detonations (grenade_dets) —
    // via heatRegionCats (lib/heatkinds.js).
    const cats = heatRegionCats(kind);
    const target = replayHash(id, { bbox, ...(cats ? { cats } : {}) }, { back: `match/${id}/heatmaps` });
    if (navTimer) clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      navTimer = null;
      nav(target);
    }, 400);
  }
</script>

<div class="view heat-view">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if packNote}
    <p class="note-amber" role="status">{packNote}</p>
  {/if}

  <div class="toolbar heat-controls">
    <div class="heat-field">
      <label class="field-label" for="heat-kind">Kind</label>
      <select class="input" id="heat-kind" bind:value={kind}>
        {#each KIND_GROUPS as group (group.label)}
          <optgroup label={group.label}>
            {#each group.kinds as k (k)}
              <option value={k}>{heatKindLabel(k)}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </div>
    {#if showLayers}
      <!-- Multi-floor pack only (see showLayers): the pack's own panels,
           default first, named as the pack names them. Switching flips the
           RADAR immediately; the raster follows on Regenerate (layer is in
           filterKey, so the stale banner covers the pending raster). -->
      <div class="heat-field">
        <span class="field-label">Floor</span>
        <div class="sett-seg" role="group" aria-label="Floor">
          {#each layers as l, i (i)}
            <button
              class="btn"
              class:primary={layer === i}
              aria-pressed={layer === i}
              onclick={() => (layer = i)}>{l.name || l.id}</button
            >
          {/each}
        </div>
      </div>
    {/if}
    <div class="heat-field">
      <label class="field-label" for="heat-player">Player</label>
      <select class="input" id="heat-player" bind:value={player}>
        <option value="">All players</option>
        {#each players as p (p.steamId)}
          <option value={p.steamId}>{p.name}</option>
        {/each}
      </select>
    </div>
    <div class="heat-field">
      <label class="field-label" for="heat-team">Team</label>
      <select class="input" id="heat-team" bind:value={team}>
        <option value="">Both</option>
        <option value="ct">CT</option>
        <option value="t">T</option>
      </select>
    </div>
    <div class="heat-field">
      <label class="field-label" for="heat-from">Rounds from</label>
      <select class="input" id="heat-from" bind:value={roundFrom}>
        <option value={-1}>All</option>
        <!-- Counted rounds only (lib/rounds.js): knife/warmup rounds are
             numbered negatively, and -1 is this range's "all" sentinel. -->
        {#each rounds.filter(isCounted) as r (r.number)}
          <option value={r.number}>R{r.number}</option>
        {/each}
      </select>
    </div>
    <div class="heat-field">
      <label class="field-label" for="heat-to">Rounds to</label>
      <select class="input" id="heat-to" bind:value={roundTo}>
        <option value={-1}>All</option>
        {#each rounds.filter(isCounted) as r (r.number)}
          <option value={r.number}>R{r.number}</option>
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
      <!-- The ramp gradient is a complete background declaration built
           from lib/heatramp.js — the same stop tables the canvas
           renders — so legend and overlay cannot diverge (a bare
           gradient in style={…} would be invalid CSS and silently fall
           back to the stylesheet's static gradient). The kd legend is
           an opaque diverging bar: deaths (−) solid blue on the left,
           kills (+) amber→red→white-hot on the right, the two halves
           meeting at zero in the middle; the plain legend keeps the
           stops' alpha so its 0 end reads as "no signal". -->
      {#if unitKind === 'kd'}
        <span class="mono heat-legend-label heat-legend-neg">−{maxLabel}</span>
        <span class="heat-ramp signed" aria-hidden="true" style={signedRampCss(DEATH_STOPS, HEAT_STOPS)}></span>
        <span class="mono heat-legend-label heat-legend-pos">+{maxLabel}</span>
      {:else}
        <span class="mono heat-legend-label">0</span>
        <span class="heat-ramp" aria-hidden="true" style={rampCss(HEAT_STOPS)}></span>
        <span class="mono heat-legend-label">{maxLabel}</span>
      {/if}
      <span class="chip heat-unit">{unit}</span>
      <span class="muted"
        >{fmtInt(grid.samples)} samples · {grid.w}×{grid.h} grid · √ scale</span
      >
    </div>
  {/if}

  <HeatmapLayer {map} {pack} {grid} {onRegion} {layer} {gridLayer} />

  {#if grid}
    <p class="heat-hint muted">
      Click the map to open the replay events for that region (cell-sized bbox).
    </p>
  {:else if !loading}
    <p class="heat-empty muted" role="status">
      Choose filters and press Generate — heatmaps are computed on demand.
    </p>
  {/if}
</div>
