<script>
  import {
    getMatch,
    getScoreboard,
    getRounds,
    getHeatmap,
    errText,
    onEvent,
  } from '../services.js';
  // The signed kd raster has its own Go entry point (heatmap.go
  // GetHeatmapKD) — called on the binding directly; every other kind
  // shares getHeatmap.
  import { AnalyticsService } from '../../../bindings/github.com/ChristianWSmith/spectra';
  import { HEAT_CORE_KINDS, HEAT_GRENADE_THROW_KINDS, HEAT_GRENADE_DET_KINDS, heatKindLabel, heatRegionFilter, heatRegionTakesBBox } from '../heatkinds.js';
  import { HEAT_STOPS, DEATH_STOPS, rampCss, signedRampCss } from '../heatramp.js';
  import { loadMapPack } from '../components/mapxform.js';
  import HeatmapLayer from '../components/HeatmapLayer.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import { fmt1, fmtInt } from '../fmt.js';
  import { isCounted } from '../rounds.js';
  import { replayHash } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import { seed, remember, matchKey } from '../viewstate.svelte.js';

  let { id = 0, nav = () => {} } = $props();

  // View-local controls AND the generated raster restore per match
  // through the process-scoped registry (viewstate.svelte.js): the key
  // carries the match id (matchKey) — the player/round references are
  // match-scoped, so match A's heatmap never seeds into match B. NO URL
  // params are involved (sticky-registry-only ruling): a deep link
  // lands at the defaults exactly as today, and the registry fills only
  // what the route leaves alone. The record holds controls + grid +
  // gridLayer + lastKey TOGETHER, so a restored raster is consistent
  // with the restored controls (no spurious dirty banner). Loading,
  // error, region notes, pack/match data stay transient.
  const heatDefaults = () => ({
    kind: 'presence',
    player: '',
    team: '',
    roundFrom: -1,
    roundTo: -1,
    layer: 0,
    grid: null,
    gridLayer: 0,
    lastKey: '',
  });
  const heatKey = $derived(matchKey('heatmaps', id));
  // Deliberate ONE-TIME init capture: the derived is read inside a closure
  // (Svelte's documented state_referenced_locally fix); the snapshot carries
  // the key so lastKey matches without a second top-level derived read.
  // The combined reseed/write-through $effect below owns every later key
  // change — URL stays the sole durable record; registry semantics unchanged.
  const heatInit = () => ({ ...seed(heatKey, heatDefaults()), key: heatKey });
  const heatSeed = heatInit();

  // The kind registry lives in lib/heatkinds.js (pinned to Go's
  // grenadeHeatmapKinds by its test) — core kinds, then one option per
  // grenade type in each flavor (thrown origins / detonations).
  const KIND_GROUPS = [
    { label: 'Overview', kinds: HEAT_CORE_KINDS },
    { label: 'Grenade thrown', kinds: HEAT_GRENADE_THROW_KINDS },
    { label: 'Grenade detonation', kinds: HEAT_GRENADE_DET_KINDS },
  ];

  let kind = $state(heatSeed.kind);
  let player = $state(heatSeed.player); // steamId, '' = all
  let team = $state(heatSeed.team); // '' | ct | t — SIDE at the round (the selector's label says Side; the generate payload's wire key stays `team`)
  let roundFrom = $state(heatSeed.roundFrom); // <0 = all
  let roundTo = $state(heatSeed.roundTo); // <0 = all

  let grid = $state(heatSeed.grid);
  // Layer (floor) selector: `layer` is the LIVE selection — the radar
  // image switches with it immediately — while `gridLayer` is the layer
  // the displayed raster was FETCHED for. HeatmapLayer draws the raster
  // only while the two indices agree (owner decision: hybrid timing), so
  // a floor switch CLEARS the overlay — the new floor has no data yet —
  // until Regenerate refetches it with the new band; any other pending
  // control keeps the stale raster on screen under the dirty banner
  // (only a floor mismatch hides it).
  let layer = $state(heatSeed.layer);
  let gridLayer = $state(heatSeed.gridLayer);
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
    let live = true;
    packTried = false;
    loadMapPack(m).then((p) => {
      if (live) {
        pack = p;
        packTried = true;
        // Never keep a floor index the pack does not have — but only
        // clamp OUT-OF-RANGE values (a record restored from a pack with
        // more panels than this one — viewstate): a restored index in
        // range is this match's own and must survive the load (the
        // per-match re-seed already scoped it, so no cross-map carry
        // can be sitting here — the old blanket `layer = 0` would have
        // clobbered every restore). Index 0 stays the canonical default
        // (layers.js "default first").
        const ls =
          p && p.transform && Array.isArray(p.transform.layers) ? p.transform.layers : [];
        if (ls.length && layer >= ls.length) layer = 0;
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
  let lastKey = $state(heatSeed.lastKey);
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

  // Combined re-seed + write-through (viewstate.svelte.js): App's {#if}
  // chain reuses this component when only the id changes (no remount),
  // so on a key change the record for the NEW match is applied (fresh
  // defaults when it has none) and nothing is written — the entry keeps
  // exactly what was applied, so the old match's state can never land
  // under the new key. While the key is unchanged every control/raster
  // change writes through, keeping the record internally consistent
  // (controls + grid + gridLayer + lastKey move together).
  let heatLastKey = heatSeed.key;
  $effect(() => {
    const k = heatKey;
    if (k !== heatLastKey) {
      // Another match without a remount: apply its record (defaults
      // when it has none) and do not write — the entry keeps exactly
      // what was applied, so the old match's raster/controls can never
      // land under the new key (the write-through re-arms on the next
      // control change or Generate, which reads the re-seeded values).
      heatLastKey = k;
      const s = seed(k, heatDefaults());
      kind = s.kind;
      player = s.player;
      team = s.team;
      roundFrom = s.roundFrom;
      roundTo = s.roundTo;
      layer = s.layer;
      grid = s.grid;
      gridLayer = s.gridLayer;
      lastKey = s.lastKey;
      return;
    }
    remember(k, { kind, player, team, roundFrom, roundTo, layer, grid, gridLayer, lastKey });
  });

  // Live generate progress: the last spectra:heatmap-progress payload
  // ({stage, done, total} — AnalyticsService's presence emitter).
  // TRANSIENT like `loading` itself: never seeded/remembered, no URL or
  // viewstate-registry involvement; dropped when a run starts and ends.
  // null before the first event → the chip renders its indeterminate bar
  // (also what the fast event-kind rasters show — they emit no progress,
  // which is the honest picture: no denominator, no pretend percentage).
  let heatProgress = $state(null);

  // Subscribe for the whole view lifetime (the onEvent pattern at
  // services.js); the unsubscribe is the $effect cleanup. Generic
  // onEvent, no new wrapper: this is the event's only subscriber.
  $effect(() => {
    const off = onEvent('spectra:heatmap-progress', (p) => {
      if (p) heatProgress = p;
    });
    return off;
  });

  // 0 = StatusChip's animated indeterminate bar; a real 0..1 = the
  // determinate bar with its percentage (frames read so far / total).
  const heatPct = $derived(
    heatProgress && heatProgress.total > 0 ? Math.min(1, heatProgress.done / heatProgress.total) : 0,
  );
  const heatStage = $derived(heatProgress ? heatProgress.stage : '');

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
    // Drop any progress a previous run left behind — without this the bar
    // could open at a stale "N of N" (the asset-extraction run clears
    // mpProgress the same way).
    heatProgress = null;
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
      // Progress dies with the run — the chip renders only while loading.
      heatProgress = null;
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
  // THE BBOX IS THE CELL EXPANDED BY grid.pad, never the raw cell edges:
  // the displayed cell value is the Gaussian-smeared splat (σ = 150u,
  // windowed to zero at the 3σ reach = pad) of everything within the
  // kernel's reach, so cell ± pad is exactly the region whose events can
  // have painted this cell — the raw ~30×36u cell holds almost no event
  // endpoints, and querying it alone is what produced the guaranteed-
  // empty "No events match these filters." arrival (the nearest kill in
  // the owner's repro sat 238u away). The pad rides the wire from Go
  // (HeatmapGrid.Pad — Go owns the kernel width; the store stays a dumb
  // rectangle predicate), and regionNote states the APPLIED (padded)
  // rect, because that is what was actually queried.
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
    // Cell ± pad = the events whose splat can reach the clicked cell
    // (the kernel is windowed to zero AT pad, so a sample a touch beyond
    // the expanded edge contributes nothing — at most one cell of index
    // quantization at the zero-weight taper edge). A grid without a pad
    // (none exist today) expands by 0 rather than inventing a reach.
    const pad = grid && Number.isFinite(grid.pad) ? grid.pad : 0;
    const applied = {
      minX: bbox.minX - pad,
      minY: bbox.minY - pad,
      maxX: bbox.maxX + pad,
      maxY: bbox.maxY + pad,
    };
    if (carries) {
      regionChip = 'filtered by region';
      regionNote = `bbox (${Math.round(applied.minX)}, ${Math.round(applied.minY)}) → (${Math.round(applied.maxX)}, ${Math.round(applied.maxY)})`;
    } else {
      regionChip = 'region not applied';
      regionNote = `${kind} has no event rows behind it — replay opens without a bbox`;
    }
    const target = replayHash(
      id,
      carries ? { ...filter, bbox: applied } : filter,
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
    <p class="error" role="alert">
      {error}
      <button class="btn small" aria-label="Dismiss error" onclick={() => (error = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
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
          <option value={r.number}>RD{r.number}</option>
        {/each}
      </select>
    </div>
    <div class="heat-field">
      <label class="field-label" for="heat-to">Rounds to</label>
      <select class="input" id="heat-to" bind:value={roundTo}>
        <option value={-1}>All</option>
        {#each rounds.filter(isCounted) as r (r.number)}
          <option value={r.number}>RD{r.number}</option>
        {/each}
      </select>
    </div>
    <button class="btn primary heat-generate" disabled={loading} onclick={generate}>
      {loading ? 'Generating…' : grid ? 'Regenerate' : 'Generate'}
    </button>
    {#if loading}
      <!-- The ONE progress widget beside the (necessarily label-only)
           button: determinate frames while the sidecar loads
           (spectra:heatmap-progress), the raster phase and any generate
           with no honest denominator ride progress 0 = StatusChip's
           indeterminate bar — never a pretend percentage. -->
      <StatusChip status="running" progress={heatPct} stage={heatStage} />
    {/if}
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
      Click the map to open the replay events for that region (the clicked
      square, padded to the splat’s reach).
    </p>
  {:else if !loading}
    <p class="heat-empty muted" role="status">
      Choose filters and press Generate — heatmaps are computed on demand.
    </p>
  {/if}
</div>
