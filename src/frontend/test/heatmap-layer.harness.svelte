<script>
  // Test harness for HeatmapLayer's floor-mismatch overlay gate: one
  // multi-floor pack (per-floor radar files, shared transform — the
  // normal case) plus switchable pack/grid/floor props, with setters
  // exposed on globalThis so the driver can flip floors, "Regenerate"
  // (gridLayer := layer), and swap the pack or grid.
  import HeatmapLayer from './components/HeatmapLayer.js';
  import { makeTransform } from './components/mapxform.js';

  // Multi-floor pack built through makeTransform (the canonical
  // pack→layers reader): both floors inherit the shared transform and
  // carry their own radar file — exactly the layout the selector shows.
  const meta = {
    transform: { pos_x: -50, pos_y: 50, scale: 1 },
    radar: { file: 'base.png', width: 1024, height: 1024 },
    layers: [
      { id: 'upper', name: 'Upper', file: 'upper.png', z_min: 0, z_max: 60 },
      { id: 'lower', name: 'Lower', file: 'lower.png', z_min: -60, z_max: 0 },
    ],
  };
  const multiPack = { meta, transform: makeTransform(meta), base: '/api/mappack/de_test' };

  // Single-floor pack (no `layers` key) — the selector-hidden fallback.
  const singleMeta = {
    transform: { pos_x: -50, pos_y: 50, scale: 1 },
    radar: { file: 'base.png', width: 1024, height: 1024 },
  };
  const singlePack = {
    meta: singleMeta,
    transform: makeTransform(singleMeta),
    base: '/api/mappack/de_test',
  };

  function mkGrid() {
    return {
      kind: 'presence',
      w: 4,
      h: 4,
      max: 16,
      samples: 100,
      minX: -50,
      maxX: 50,
      minY: -50,
      maxY: 50,
      cells: Array.from({ length: 16 }, (_, i) => i + 1),
    };
  }

  let pack = $state(multiPack);
  let grid = $state(mkGrid());
  let layer = $state(0);
  let gridLayer = $state(0);
  // Drill surface: the kind Heatmaps passes its region gate with, and the
  // regions the component emits (the driver clicks the canvas and reads
  // what came back).
  let kind = $state('kills');
  const regions = [];

  // Driver controls. __setGrid(null) is the pre-Generate state; __newGrid
  // swaps in a fresh raster object the way Regenerate does after another
  // filter (kind/spacing/region) changed on the SAME floor.
  globalThis.__set = (l, gl) => {
    layer = l;
    gridLayer = gl;
  };
  globalThis.__setPack = (p) => (pack = p);
  globalThis.__setGrid = (g) => (grid = g);
  globalThis.__newGrid = () => (grid = mkGrid());
  globalThis.__singlePack = singlePack;
  globalThis.__setKind = (k) => (kind = k);
  globalThis.__regions = regions;
  function onRegion(bbox, value) {
    regions.push({ bbox, value });
  }
</script>

<HeatmapLayer map="de_test" {pack} {grid} {layer} {gridLayer} {kind} {onRegion} />
