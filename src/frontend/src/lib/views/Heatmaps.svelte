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
  import { HEAT_CORE_KINDS, HEAT_GRENADE_THROW_KINDS, HEAT_GRENADE_DET_KINDS, heatKindLabel, heatRegionFilter, heatRegionTakesBBox } from '../heatkinds.js';
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
  let team = $state(''); // '' | ct | t — SIDE at the round (the selector's label says Side; the generate payload's wire key stays `team`)
  let roundFrom = $state(-1); // <0 = all
  let roundTo = $state(-1); // <0 = all

  let grid = $state(null);
  // Layer (floor) selector: `layer` is the LIVE selection — the radar
  // image switches with it immediately — while `gridLayer` is the layer
  // the displayed raster was FETCHED for. HeatmapLayer draws the raster
  // only while the two indices agree (owner decision: hybrid timing), so
  // a floor switch CLEARS the overlay — the new floor has no data yet —
  // until Regenerate refetches it with the new band; any other pending
  // control keeps the stale raster on screen under the dirty banner
  // (only a floor mismatch hides it).
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
  // The note's chip wording is decided WITH the note (onRegion): a drill
  // that carried its bbox says so, a presence click says the region was
  // NOT applied. Both render only while regionNote is set.
  let regionChip = $state('filtered by region');

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
  // On top of the banner, a floor mismatch HIDES the raster outright
  // (HeatmapLayer's `layer === gridLayer` gate): a stale other-floor
  // raster must not be drawn over the newly selected floor's image —
  // only a floor mismatch clears the overlay, every other pending
  // control keeps it visible under this banner.
  const dirty = $derived(
    !!grid && lastKey !== filterKey(kind, player, team, roundFrom, roundTo, layer),
  );

  // The heavy GetHeatmap call fires only on Generate — never on control
  // changes (heatmap generate is the expensive op).
  async function generate() {
    if (roundFrom >= 0 && roundTo >= 0 && roundFrom > roundTo) {
      error = 'First round can’t be higher than the last round.';
      return;
    }
    loading = true;
    error = '';
    regionNote = '';
    regionChip = 'filtered by region';
    // The fetch is FOR the layer selected right now: the band it sends and
    // the gridLayer it records must be that one index, even if the radar
    // is flipped to another floor while the call is in flight — the
    // overlay gate then compares exactly these two indices.
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
  // renders first so the effect of the click is visible before the route
  // switch.
  // ACCEPTED EXCEPTION to "outside-replay buttons seek, never filter":
  // this region drill is a documented power-user path that arrives with
  // a landmark filter (the cell bbox + the mirrored categories AND the
  // heatmap's own player/round settings — heatRegionFilter, lib/
  // heatkinds.js), kept by product-owner decision — together with the
  // command palette's saved-filter apply, the ONLY two filter-arrival
  // paths outside the replay. Its non-default arriving filter is what
  // triggers the replay's feed reveal on entry (lib/replay/landmarks.js
  // shouldRevealFeed), which picks the mirrored keys up through the same
  // serialization.
  function onRegion(bbox) {
    const carries = heatRegionTakesBBox(kind);
    // The heatmap's settings mirrored into the arrival filter (cats, the
    // player selector, the SIDE selector, the round range — `-1 = all`
    // maps to the filter's open bound). presence is the exception: its
    // raster has NO events behind it, so a bbox it cannot satisfy would
    // guarantee an empty feed — that click arrives WITHOUT one (settings
    // only). The side selector's value is side-AT-ROUND (its old "Team"
    // label was the misnomer — relabelled), so it mirrors into the
    // filter's `side` key; the `team` (identity) key never rides this
    // selector — identity is not a heatmap setting.
    const filter = heatRegionFilter(kind, { player, side: team, roundFrom, roundTo });
    if (carries) {
      regionChip = 'filtered by region';
      regionNote = `bbox (${Math.round(bbox.minX)}, ${Math.round(bbox.minY)}) → (${Math.round(bbox.maxX)}, ${Math.round(bbox.maxY)})`;
    } else {
      regionChip = 'region not applied';
      regionNote = `${kind} has no event rows behind it — replay opens without a bbox`;
    }
    const target = replayHash(
      id,
      carries ? { ...filter, bbox } : filter,
      { back: `match/${id}/heatmaps` },
    );
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
           RADAR immediately AND clears the raster (HeatmapLayer's
           floor-mismatch gate — the new floor has no data yet); it is
           drawn again on Regenerate, and layer being in filterKey keeps
           the stale banner on the pending controls. -->
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
      <!-- The selector is SIDE-AT-ROUND (the exact freeze-end sample via
           GetRoundPlayerSides) — the old "Team" label was the misnomer
           the audit found; relabelled to Side. The option VALUES stay
           ct/t and the generate payload keeps its `team` key
           (HeatmapFilter.Team — the wire is unchanged); only this label
           (and the arrival filter's `side` key — heatRegionFilter) name
           it for what it is. -->
      <label class="field-label" for="heat-side">Side</label>
      <select class="input" id="heat-side" bind:value={team}>
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
      <span class="chip heat-region">{regionChip}</span>
      <span class="mono muted">{regionNote}</span>
    </p>
  {/if}

  {#if dirty}
    <p class="heat-stale muted" role="status">
      controls changed — press Regenerate to redraw the heatmap
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
        >{fmtInt(grid.samples)} plotted points · {grid.w}×{grid.h} grid · square-root scale</span
      >
    </div>
  {/if}

  <HeatmapLayer {map} {pack} {grid} {onRegion} {layer} {gridLayer} />

  {#if grid}
    <p class="heat-hint muted">
      Click the map to open the replay events for that region (the clicked square).
    </p>
  {:else if !loading}
    <p class="heat-empty muted" role="status">
      Choose filters and press Generate — heatmaps are computed on demand.
    </p>
  {/if}
</div>
