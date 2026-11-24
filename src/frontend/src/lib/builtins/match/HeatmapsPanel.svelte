<script>
  import { whenCurrent } from '../../current.js';
  import { whileCurrent } from '../../current.js';
  import ErrorBanner from '../../components/ErrorBanner.svelte';
  import * as S from '../../strings/index.js';
  import {
    getMatch,
    getScoreboard,
    getRounds,
    getHeatmap,
    errText,
  } from '../../services.js';
  // The signed kd raster has its own Go entry point (heatmap.go
  // GetHeatmapKD) — called on the binding directly; every other kind
  // shares getHeatmap.
  import { AnalyticsService } from '../../../../bindings/github.com/ChristianWSmith/spectra';
  import { HEAT_CORE_KINDS, HEAT_GRENADE_THROW_KINDS, HEAT_GRENADE_DET_KINDS, heatKindLabel, heatRegionFilter, heatRegionTakesBBox } from '../../heatkinds.js';
  import { HEAT_STOPS, DEATH_STOPS, rampCss, signedRampCss } from '../../heatramp.js';
  import { loadMapPack } from '../../components/mapxform.js';
  import HeatmapLayer from '../../components/HeatmapLayer.svelte';
  import { fmt1, fmtInt } from '../../fmt.js';
  import { isCounted, roundScoreLabel } from '../../rounds.js';
  import { downloadCanvasPNG } from '../../download.js';
  import { replayHash } from '../../nav.js';
  import { listedPlayers } from '../../players.js';
  import { seed, remember, matchKey } from '../../viewstate.svelte.js';
  // The ONE background-work wrapper (lib/workstate.svelte.js): generate
  // is heavy work the floating indicator shows — wrapping the call site
  // covers BOTH binding paths (GetHeatmap below and GetHeatmapKD) in one
  // spot, since services.getHeatmap is only ever this non-kd path.
  import { runWork } from '../../workstate.svelte.js';

  // The heatmap card. It
  // reads its match from the read-only `context` the Heatmaps builtin passes
  // down (`matchId`), and navigates through the read API, so the panel mounts
  // nothing else. Its data path is unchanged: getMatch / getScoreboard /
  // getRounds and the heatmap binding, never a stored metric.
  let { spectra, context } = $props();
  const id = $derived(context.matchId);

  // View-local controls AND the generated raster restore per match
  // through the process-scoped registry (viewstate.svelte.js): the key
  // carries the match id (matchKey) — the player/round references are
  // match-scoped, so match A's heatmap never seeds into match B. NO URL
  // params are involved (sticky-registry-only ruling): a deep link
  // lands at the defaults exactly as today, and the registry fills only
  // what the route leaves alone. The record holds controls + grid +
  // gridLayer + lastKey + gen TOGETHER, so a restored raster is
  // consistent with the controls it was fetched under AND still knows
  // the population it depicts (gen — the region drill's source while the
  // raster is stale). Loading, error, region notes, pack/match data stay
  // transient.
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
    // The generating settings: captured with the fetch that produced
    // `grid` (same moment the payload is built) and stored WITH it — see
    // `src` below. null until the first successful Generate.
    gen: null,
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
    { label: S.heatmaps.kindOverview, kinds: HEAT_CORE_KINDS },
    { label: S.heatmaps.kindGrenadeThrown, kinds: HEAT_GRENADE_THROW_KINDS },
    { label: S.heatmaps.kindGrenadeDetonation, kinds: HEAT_GRENADE_DET_KINDS },
  ];

  let kind = $state(heatSeed.kind);
  let player = $state(heatSeed.player); // steamId, '' = all
  let team = $state(heatSeed.team); // '' | ct | t — SIDE at the round (the selector's label says Side; the generate payload's wire key stays `team`)
  let roundFrom = $state(heatSeed.roundFrom); // <0 = all
  let roundTo = $state(heatSeed.roundTo); // <0 = all

  let grid = $state(heatSeed.grid);
  // `gen` — the generating settings of the raster on screen: kind + the
  // player/side/round controls the fetch actually sent, captured with the
  // payload in generate(). The region drill composes EVERY arrival key
  // from it (owner ruling: "query what's displayed"), so a stale raster
  // under changed live controls still opens the population it depicts.
  let gen = $state(heatSeed.gen);
  // The single source the drill reads: the generating settings when a
  // raster produced them, else the live controls — the fallback is only
  // reachable with no raster at all (HeatmapLayer needs a grid to emit a
  // region), so it never becomes a second source of truth.
  const src = $derived(gen || { kind, player, team, roundFrom, roundTo });
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
  // V8e — the floating Save needs the composite canvas (radar + overlay,
  // exactly what HeatmapLayer's draw() paints). That canvas is private to
  // the layer; it reaches this view only through the explicit onCanvas
  // bridge (a callback handle — no global state), handed over on mount
  // and withdrawn (null) on teardown. Never seeded/remembered: it is a
  // live element handle, transient like `loading` (State placement).
  let heatCanvas = $state(null);
  // Stable identity (a const, never an inline arrow in the markup): the
  // layer's onCanvas effect reads the prop, so a fresh function every
  // parent render would re-fire it on every render.
  const onHeatCanvas = (c) => {
    heatCanvas = c;
  };
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
  // that carried its bbox says so, a bbox-less kind's click says the
  // region was NOT applied — and that one never navigates (the gate in
  // onRegion, mirroring the affordance HeatmapLayer hides). Both render
  // only while regionNote is set.
  let regionChip = $state(S.heatmaps.regionFiltered);

  let navTimer = null;

  $effect(() => whileCurrent((isCurrent) => {
    Promise.all([
      getMatch(id),
      getScoreboard(id, 'kills', true).catch(() => []),
      getRounds(id).catch(() => []),
    ])
      .then(([m, sb, rs]) => {
        if (!isCurrent()) return;
        map = (m && m.map) || '';
        players = listedPlayers(sb) || [];
        rounds = rs || [];
        matchLoaded = true;
      })
      .catch(whenCurrent(isCurrent, (e) => {
        error = errText(e);
      }));
  }));

  $effect(() => whileCurrent((isCurrent) => {
    const m = map;
    if (!m) {
      pack = null;
      return;
    }
    packTried = false;
    loadMapPack(m).then((p) => {
      if (isCurrent()) {
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
  }));

  $effect(() => () => {
    if (navTimer) clearTimeout(navTimer);
  });

  const packNote = $derived.by(() => {
    if (!matchLoaded) return '';
    if (!map) return S.heatmaps.noMapName;
    if (!pack)
      return packTried
        ? S.fill(S.heatmaps.mapNotFound, { map })
        : S.heatmaps.loadingMapPack;
    if (!pack.transform)
      return S.fill(S.heatmaps.mapNoTransform, { map });
    if (!pack.meta.radar)
      return S.fill(S.heatmaps.mapNoRadar, { map });
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

  // The radar's ASPECT (width ÷ height) for the height cap in
  // public/style-m3a.css (.heat-canvas-wrap): the canvas is aspect-driven
  // off its WIDTH (canvas.heat-canvas is width:100% / height:auto), so
  // bounding the wrap's width by (viewport − chrome) × aspect is what
  // bounds the canvas's HEIGHT. It mirrors HeatmapLayer's image-space W/H
  // exactly — the live floor's panel when the pack declares layers, else
  // the pack transform (its dims ARE the radar's) — and for the no-pack /
  // no-transform case, HeatmapLayer's plain-grid fallback (mapxform fb
  // builds it from the heatmap's world bounds → aspect spanX/spanY, the
  // square 1024² default with no grid). That last branch is floored at 1:
  // assuming the SMALLER aspect only under-sizes the radar (safe — the
  // cap guards a height), while an over-guessed aspect would let a
  // portrait canvas overrun the budget and scroll again.
  const heatAspect = $derived.by(() => {
    const t = pack && pack.transform ? pack.transform : null;
    const l = t && Array.isArray(t.layers) ? t.layers[layer] : null;
    const w = (l && l.width) || (t && t.width) || 0;
    const h = (l && l.height) || (t && t.height) || 0;
    if (w > 0 && h > 0) return Math.round((w / h) * 1000) / 1000;
    const spanX = grid && grid.w ? Math.max(1, grid.maxX - grid.minX) : 1024;
    const spanY = grid && grid.h ? Math.max(1, grid.maxY - grid.minY) : 1024;
    return Math.round(Math.min(1, spanX / spanY) * 1000) / 1000;
  });

  // Legend labels must describe the data on screen, not the pending
  // controls (fetch is on-demand, so the two can diverge). presence's
  // unit says "live play" because it IS the live-play population now:
  // the raster skips every frame inside a round's freeze window
  // (analyticservice.go inFreezeTime — the buy phase would otherwise
  // weigh the T/CT spawns).
  const unitKind = $derived(grid && grid.kind ? grid.kind : kind);
  const unit = $derived(
    unitKind === 'presence'
      ? S.heatmaps.timeWeighted
      : unitKind === 'kd'
        ? S.heatmaps.killsMinusDeaths
        : S.heatmaps.unitCount,
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
      gen = s.gen;
      return;
    }
    remember(k, { kind, player, team, roundFrom, roundTo, layer, grid, gridLayer, lastKey, gen });
  });


  // The heavy GetHeatmap call fires only on Generate — never on control
  // changes (heatmap generate is the expensive op).
  // The generate run is a load the frame counts (spectra.track): the busy state is the frame's.
  function generate() {
    return spectra.track(runGenerate());
  }

  async function runGenerate() {
    if (roundFrom >= 0 && roundTo >= 0 && roundFrom > roundTo) {
      error = S.heatmaps.roundRangeError;
      return;
    }
    loading = true;
    error = '';
    regionNote = '';
    regionChip = S.heatmaps.regionFiltered;
    // Drop any progress a previous run left behind — without this the bar
    // could open at a stale "N of N" (the asset-extraction run clears
    // mpProgress the same way).
    // The fetch is FOR the layer selected right now: the band it sends and
    // the gridLayer it records must be that one index, even if the radar
    // is flipped to another floor while the call is in flight — the
    // overlay gate then compares exactly these two indices.
    const sel = layer;
    const l = layers[sel];
    // The generating settings, captured WITH the payload below (the same
    // live values the fetch sends) so `gen` always describes exactly the
    // raster that lands — never a control the user touched mid-flight.
    const genSel = { kind, player, team, roundFrom, roundTo };
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
      // every other kind shares GetHeatmap. One runWork around the whole
      // fetch so EITHER path marks the heatmap source busy.
      grid = await runWork(
        'heatmap',
        kind === 'kd'
          ? AnalyticsService.GetHeatmapKD(id, filter)
          : getHeatmap(id, kind, filter),
      );
      gridLayer = sel;
      lastKey = filterKey(kind, player, team, roundFrom, roundTo, sel);
      // …and the population that fetch selected travels WITH the raster
      // (the record keeps grid/gridLayer/lastKey/gen together).
      gen = genSel;
    } catch (e) {
      grid = null;
      gen = null; // no raster → no generating settings (never a stale pair)
      error = errText(e);
    } finally {
      loading = false;
      // Progress dies with the run — the chip renders only while loading.
      }
  }

  // V8e — Save the raster on screen: the composite canvas (radar +
  // overlay, exactly what HeatmapLayer's draw() painted — handed up
  // through the onCanvas bridge) goes through downloadCanvasPNG, THE
  // canonical way to land generated bytes on disk (lib/download.js → the
  // native save dialog). A cancelled dialog resolves "" and stays silent;
  // a genuine failure lands in the dismissible error alert above.
  async function saveRaster() {
    if (!heatCanvas) return;
    try {
      await downloadCanvasPNG(heatCanvas, heatRasterName());
    } catch (e) {
      error = errText(e);
    }
  }

  // The default filename the save dialog opens on: the map (or "map" when
  // the match's map is unknown) + today's date — two saves of different
  // maps on different days never collide, and the name says what it is.
  function heatRasterName() {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `heatmap-${map || 'map'}-${stamp}.png`;
  }

  // Region drill: a bbox around the gesture → the canonical event browser
  // (Replay's landmark feed) scoped to that region. The bbox is the CELL
  // under the cursor for a bare press and the DRAGGED box AS DRAWN for a
  // rubber-band selection (both emitted by HeatmapLayer, whose gesture
  // math is lib/heatselect.js; the third argument `source` names the
  // shape). The note renders first so the effect of the drill is visible
  // before the route switch.
  // ACCEPTED EXCEPTION to "outside-replay buttons seek, never filter":
  // this region drill is a documented power-user path that arrives with
  // a landmark filter (the region bbox + the mirrored categories AND the
  // heatmap's own player/round settings — heatRegionFilter, lib/
  // heatkinds.js), kept by product-owner decision — together with the
  // command palette's saved-filter apply, the ONLY two filter-arrival
  // paths outside the replay. Its non-default arriving filter is what
  // triggers the replay's feed reveal on entry (lib/replay/landmarks.js
  // shouldRevealFeed), which picks the mirrored keys up through the same
  // serialization.
  // A 'cell' BBOX IS EXPANDED BY grid.pad before it is queried; a 'drag'
  // BBOX IS NEVER PADDED — its applied rect === the drawn box (owner fix
  // 2026-11-16: the pad's own contract is the CLICKED-CELL splat reach,
  // and non-playable margins are thinner than it — de_cache's top margin
  // is 14u — so padding every emission made a margin box query a rect
  // that reached into the map and returned events for a region the owner
  // had drawn over nothing). For a bare press the pad IS the point: the
  // displayed cell value is the Gaussian-smeared splat (σ = 150u,
  // windowed to zero at the 3σ reach = pad) of everything within the
  // kernel's reach, so bbox ± pad is exactly the region whose events can
  // have painted this cell — the raw ~30×36u cell holds almost no event
  // endpoints, and querying it alone is what produced the
  // guaranteed-empty "No events match these filters." arrival (the
  // nearest kill in the owner's repro sat 238u away). The pad rides the
  // wire from Go (HeatmapGrid.Pad — Go owns the kernel width; the store
  // stays a dumb rectangle predicate), and regionNote states the APPLIED
  // rect, because that is what was actually queried (for a drag: the
  // drawn box, verbatim).
  // A kind that takes NO bbox at all (heatRegionTakesBBox — presence,
  // and any future bbox-less kind) does not navigate: the drill is a
  // bbox drill, and an arrival without one opens the replay on its
  // default feed as if a region had been selected (it had not). The
  // gate reads the predicate, never a kind name — HeatmapLayer hides the
  // click affordance for the SAME predicate, and this is the view-side
  // backstop for a click that still lands.
  //
  // EVERYTHING HERE READS `src` — the raster's generating settings
  // (owner ruling: "query what's displayed"): bbox AND cats AND player/
  // side/rounds describe the population on screen, so a stale raster
  // under changed live controls never opens an arrival that contradicts
  // what the user is clicking. The live controls only reach the drill
  // through the documented `src` fallback (no raster → nothing to click).
  function onRegion(bbox, value, source) {
    const carries = heatRegionTakesBBox(src.kind);
    if (!carries) {
      regionChip = S.heatmaps.regionNotApplied;
      regionNote = S.fill(S.heatmaps.noEventRows, { kind: src.kind });
      return;
    }
    // The raster's settings mirrored into the arrival filter (cats, the
    // player selector, the SIDE selector, the round range — `-1 = all`
    // maps to the filter's open bound). The side selector's value is
    // side-AT-ROUND (its old "Team" label was the misnomer — relabelled),
    // so it mirrors into the filter's `side` key; the `team` (identity)
    // key never rides this selector — identity is not a heatmap setting.
    const filter = heatRegionFilter(src.kind, {
      player: src.player,
      side: src.team,
      roundFrom: src.roundFrom,
      roundTo: src.roundTo,
    });
    // KD IS SIGNED — the emitted VALUE picks the endpoint the arrival
    // asks for (the clicked cell's own value for a bare press, the drag's
    // anchor cell's value for a rubber band — HeatmapLayer; the sign
    // override lives HERE, at the click site;
    // heatRegionCats('kd') keeps its ['kills'] default projection, so the
    // registry's pinned test line is untouched). Polarity, verified:
    // heatmap.go GetHeatmapKD builds the kills population from
    // heatmapEvents("kills") (the ATTACKER's position — analyticservice.go
    // heatmapEvents) and the deaths population from heatmapEvents("deaths")
    // (the VICTIM's position), then combineSignedHeatmaps does
    // `v += kills; v -= deaths` (heatmap.go) — "Output cells hold net
    // kills (positive) / net deaths (negative)"; heatramp.js paints the
    // same polarity (positive → HEAT_STOPS, negative → DEATH_STOPS).
    //   value > 0  → killers stood in this cell   → cats ['kills'] (the
    //                projection that SHOULD have returned rows — the pad
    //                fix is what makes them appear)
    //   value < 0  → victims fell in this cell    → cats ['deaths'] (the
    //                victim endpoint: killRoleFor over those category ids
    //                derives 'victim', and the side scope follows the same
    //                role in store.endpointScopeClause)
    //   0 / missing → no signal cell (nothing to pick with) → cats
    //                ['kills','deaths'] = either endpoint: killRoleFor
    //                returns 'any', which the store renders as the
    //                either-endpoint predicate — no invented pick.
    if (src.kind === 'kd') {
      const v = Number(value);
      filter.cats =
        Number.isFinite(v) && v !== 0 ? (v > 0 ? ['kills'] : ['deaths']) : ['kills', 'deaths'];
    }
    // Cell ± pad = the events whose splat can reach the clicked cell
    // (the kernel is windowed to zero AT pad, so a sample a touch beyond
    // the expanded edge contributes nothing — at most one cell of index
    // quantization at the zero-weight taper edge). ONLY a 'cell'
    // emission receives it: a drag's box is the user's own gesture and is
    // queried VERBATIM (a drag that missed the raster queries honestly
    // empty rather than reaching into the map). Any other/absent source
    // also stays unpadded — fail honest, never pad what was not a clicked
    // cell. A grid without a pad (none exist today) expands by 0 rather
    // than inventing a reach.
    const pad =
      source === 'cell' && grid && Number.isFinite(grid.pad) ? grid.pad : 0;
    const applied = {
      minX: bbox.minX - pad,
      minY: bbox.minY - pad,
      maxX: bbox.maxX + pad,
      maxY: bbox.maxY + pad,
    };
    regionChip = S.heatmaps.regionFiltered;
    regionNote = S.fill(S.heatmaps.bboxLabel, { x0: Math.round(applied.minX), y0: Math.round(applied.minY), x1: Math.round(applied.maxX), y1: Math.round(applied.maxY) });
    const target = replayHash(id, { ...filter, bbox: applied }, { back: `match/${id}/heatmaps` });
    if (navTimer) clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      navTimer = null;
      spectra.navigate(target);
    }, 400);
  }
</script>

<div class="view heat-view" style="--heat-aspect: {heatAspect}">
  {#if error}
    <ErrorBanner>
      {error}
      <button class="btn small" aria-label={S.heatmaps.dismissError} onclick={() => (error = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </ErrorBanner>
  {/if}

  {#if packNote}
    <p class="note-amber" role="status">{packNote}</p>
  {/if}

  {#if regionNote}
    <p class="heat-region-note" role="status">
      <span class="chip heat-region">{regionChip}</span>
      <span class="mono muted">{regionNote}</span>
    </p>
  {/if}

  {#if dirty}
    <p class="heat-stale muted" role="status">
      {S.heatmaps.controlsChanged}
    </p>
  {/if}

  <!-- C18 as REVISED (owner ruling, match-view V8b): the filter toolbar
       and its generate-progress row now live INSIDE the card with the
       heatmap content (legend, radar, hint) — the controls belong to the
       card they drive, so the whole surface reads as one unit instead of
       a toolbar parked beside it. The earlier C18 rule recorded here (the
       card holds only the content; the filter toolbar and status rows
       stay OUTSIDE it, per the sibling convention and the C17
       precedent) is what this reverses; only the transient status rows
       above — error, pack note, region/stale notes — still ride outside
       the card. -->
  <section class="panel">
    <div class="toolbar heat-controls">
      <div class="heat-field">
        <label class="field-label" for="heat-kind">{S.heatmaps.kindLabel}</label>
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
             default first, named as the pack names them — ONE native
             select (the kind selector's shape, the round-range selects'
             numeric binding) instead of the old button group: floorLabel
             labels it through for/id, no aria-label group of its own.
             Switching flips the RADAR immediately AND clears the raster
             (HeatmapLayer's floor-mismatch gate — the new floor has no data
             yet); it is drawn again on Regenerate, and layer being in
             filterKey keeps the stale banner on the pending controls. -->
        <div class="heat-field">
          <label class="field-label" for="heat-floor">{S.heatmaps.floorLabel}</label>
          <select class="input" id="heat-floor" bind:value={layer}>
            {#each layers as l, i (i)}
              <option value={i}>{l.name || l.id}</option>
            {/each}
          </select>
        </div>
      {/if}
      <div class="heat-field">
        <label class="field-label" for="heat-player">{S.heatmaps.playerLabel}</label>
        <select class="input" id="heat-player" bind:value={player}>
          <option value="">{S.heatmaps.allPlayers}</option>
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
        <label class="field-label" for="heat-side">{S.heatmaps.sideLabel}</label>
        <select class="input" id="heat-side" bind:value={team}>
          <option value="">{S.heatmaps.bothSides}</option>
          <option value="ct">{S.match.sideCt}</option>
          <option value="t">{S.match.sideT}</option>
        </select>
      </div>
      <div class="heat-field">
        <label class="field-label" for="heat-from">{S.heatmaps.roundsFrom}</label>
        <select class="input" id="heat-from" bind:value={roundFrom}>
          <option value={-1}>{S.heatmaps.allRounds}</option>
          <!-- Counted rounds only (lib/rounds.js): knife/warmup rounds are
               numbered negatively, and -1 is this range's "all" sentinel. -->
          {#each rounds.filter(isCounted) as r (r.number)}
            <option value={r.number}>{roundScoreLabel(rounds, r.number)}</option>
          {/each}
        </select>
      </div>
      <div class="heat-field">
        <label class="field-label" for="heat-to">{S.heatmaps.roundsTo}</label>
        <select class="input" id="heat-to" bind:value={roundTo}>
          <option value={-1}>{S.heatmaps.allRounds}</option>
          {#each rounds.filter(isCounted) as r (r.number)}
            <option value={r.number}>{roundScoreLabel(rounds, r.number)}</option>
          {/each}
        </select>
      </div>
      <!-- W17 (owner, 2026-11-16): Generate is NOT a toolbar control —
           it moved out to the floating bottom-right cluster with Save
           image (see .heat-float at the card's end), visible from the
           first render so the primary action never hides behind a grid. -->
    </div>
    <!-- No progress row here: while a run is in flight the frame covers the whole panel
         with its spinner (and hides everything but the panel shell), so an inline row would
         only grow the panel for nothing. The legend and hint rows below hold their height
         whether or not a raster is on screen, so the panel never resizes around a run. -->

    <div class="heat-legend">
      {#if grid}
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
          >{fmtInt(grid.samples)}{S.heatmaps.plottedSuffix}{grid.w}×{grid.h}{S.heatmaps.gridSuffix}</span
        >
      {:else}
        <!-- Before the first run the reserved row says what to do, so the panel is not blank. -->
        <span class="muted">{S.heatmaps.generatePrompt}</span>
      {/if}
    </div>

    <HeatmapLayer
      {map}
      {pack}
      {grid}
      {onRegion}
      {layer}
      {gridLayer}
      kind={src.kind}
      onCanvas={onHeatCanvas}
    />

    <p class="heat-hint muted">
      {#if grid}
        {#if heatRegionTakesBBox(src.kind)}
          {S.heatmaps.bboxHint}
        {:else}
          {src.kind}{S.heatmaps.noRowsSuffix}
        {/if}
      {/if}
    </p>

    <!-- W17 (owner, 2026-11-16): the floating bottom-right CLUSTER —
         Generate rides it from the first render (the card's primary
         action, no grid needed) with Save image to its LEFT once the
         raster exists (grid && heatCanvas). Save hands HeatmapLayer's
         private composite canvas (radar + overlay — the very pixels on
         screen, via the onCanvas bridge) to the canonical
         downloadCanvasPNG; the cluster is out of the panel's flex flow,
         so the legend/radar/hint rows never shift either way. -->
    <div class="heat-float">
      {#if grid && heatCanvas}
        <button class="btn heat-save" onclick={saveRaster}
          ><span class="codicon codicon-save" aria-hidden="true"></span> {S.heatmaps.saveImage}</button
        >
      {/if}
      <button class="btn primary heat-generate" disabled={loading} onclick={generate}>
        <span class="codicon codicon-play" aria-hidden="true"></span>
        {loading ? S.heatmaps.generating : grid ? S.heatmaps.regenerate : S.heatmaps.generate}
      </button>
    </div>
  </section>
</div>

<style>
  /* A tab root sits in a display: contents frame, so it is a flex item of the
     Match view's column, where the shared .view auto margins would shrink it to
     its content. Full width, like the other tabs. */
  .heat-view {
    margin-inline: 0;
  }
</style>
