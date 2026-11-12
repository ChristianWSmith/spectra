<script>
  import { makeTransform } from './mapxform.js';
  import { renderHeatField } from '../heatramp.js';
  import { heatRegionTakesBBox } from '../heatkinds.js';

  // Canvas heatmap layer: map-pack radar as base, HeatmapGrid raster as
  // overlay. All world→image math goes through mapxform's transform — the
  // formula is never duplicated here. With no pack transform, a fallback
  // transform built from the heatmap's own world bounds gives one generic
  // presentation: a plain coordinate grid (the app ships no radar art).
  //
  // Multi-floor timing split (owner decision): the RADAR follows the LIVE
  // floor selection (`layer`) — switch floors and the image under the
  // cursor changes at once — while the RASTER draws ONLY while the live
  // floor is the floor it was fetched for (`layer === gridLayer`). So a
  // floor switch CLEARS the overlay (the new floor has no data yet) until
  // Regenerate refetches with the new band; other pending controls (kind,
  // spacing, region…) keep the stale raster on screen under the dirty
  // banner — only a FLOOR MISMATCH hides it. Because the gate guarantees
  // the two indices agree whenever anything is drawn, the overlay is
  // positioned with the SAME transform as the image (`baseTf`); the
  // canvas image space (W/H, the image, click mapping) is likewise the
  // LIVE floor's.
  //
  // The backing store is sized in DEVICE pixels (wrapper width ×
  // devicePixelRatio), so neither the radar nor the overlay is ever
  // browser-upscaled from CSS pixels — the classic hiDPI smudge. The
  // overlay is rasterized by heatramp's renderHeatField at the device
  // resolution of the grid's world-bounds rect and blitted at ~1:1, so
  // cells never appear as blocks. cells[] is row-major (r*w+c) with row
  // 0 at grid.minY (the BOTTOM of image space — renderHeatField flips
  // rows into image space itself).
  // `kind` is the heatmap kind the view's region gate reads (Heatmaps
  // passes its own, so the cursor affordance and the click gate can never
  // disagree with the view's nav gate). It defaults to '' = drillable
  // (heatRegionTakesBBox: only presence refuses today), which keeps any
  // driver that passes no kind on the old behavior.
  let {
    map = '',
    pack = null,
    grid = null,
    layer = 0,
    gridLayer = 0,
    kind = '',
    onRegion = () => {},
  } = $props();

  // The ONE drill affordance predicate (lib/heatkinds.js — generic: any
  // future bbox-less kind is covered here and in Heatmaps.onRegion, never
  // a kind-name special case in either place).
  const drillable = $derived(heatRegionTakesBBox(kind));

  let canvas = $state(null);
  let radar = $state(null); // decoded radar image | null
  let boxW = $state(0); // wrapper content width (CSS px)
  let dpr = $state(1); // window devicePixelRatio

  const xf = $derived(pack && pack.transform ? pack.transform : null);
  // The pack's radar panels (makeTransform's ONE pack→layers reader):
  // default first, each with its own image/size/transform. Absent = a
  // single-floor pack, and `layers` stays empty — every path then reads
  // xf/fb exactly as before (single-layer behavior unchanged).
  const layers = $derived(xf && Array.isArray(xf.layers) ? xf.layers : []);
  const liveLayer = $derived(layers[layer] || null); // floor on screen NOW
  // No-pack fallback: derive the world→image mapping from the heatmap's own
  // world bounds — the same honest presentation as the replay renderer's
  // no-pack grid (plain world-coordinate grid, never invented map art).
  // Built through makeTransform (mapxform), so the formula stays canonical:
  // image space = padded bounds at ~900 px, mirroring renderer.reproject().
  const fb = $derived.by(() => {
    // A radar image without a transform paints the image alone — never
    // position data over pixels we can't align.
    if (xf || radar || !grid || !grid.w || !grid.h) return null;
    const spanX = Math.max(1, grid.maxX - grid.minX);
    const spanY = Math.max(1, grid.maxY - grid.minY);
    const scale = Math.max(spanX, spanY) / 900;
    return makeTransform({
      transform: {
        pos_x: grid.minX - spanX * 0.05,
        pos_y: grid.maxY + spanY * 0.05,
        scale,
      },
      radar: {
        width: Math.max(64, (spanX * 1.1) / scale),
        height: Math.max(64, (spanY * 1.1) / scale),
      },
    });
  });
  const eff = $derived(xf || fb);
  // Image space (canvas W/H + the image + click mapping) follows the LIVE
  // floor — and so does the overlay's transform, because drawOverlay only
  // lets the raster through when the fetched floor IS the live one
  // (header comment: `layer === gridLayer` is the gate, so there is no
  // separate fetched-floor transform to position data with). A pack layer
  // carries its own logical image size, so the radar is never drawn at a
  // distorted aspect.
  const baseTf = $derived(liveLayer ? liveLayer.tf : eff);
  const W = $derived(liveLayer ? liveLayer.width : eff ? eff.width : 1024);
  const H = $derived(liveLayer ? liveLayer.height : eff ? eff.height : 1024);

  // Device-pixel backing store: displayed CSS width × DPR, aspect-locked
  // to image space. The canvas keeps width:100%/height:auto in CSS, so
  // this only changes resolution, never layout.
  const bw = $derived(Math.max(1, Math.round(boxW * dpr)));
  const bh = $derived(Math.max(1, Math.round((bw * H) / W)));

  $effect(() => {
    const update = () => (dpr = Math.max(1, window.devicePixelRatio || 1));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  });

  $effect(() => {
    const meta = pack && pack.meta;
    // The gate stays on the pack's radar metadata (no radar at all = no
    // image, plain grid); WHICH image is on screen follows the LIVE floor
    // — a panel's own file when it has one, the pack's radar otherwise
    // (index 0, or a meta that omits per-layer files). Reading liveLayer
    // here is the dependency: flipping the selector reloads the image at
    // once, while the floor-mismatch gate in drawOverlay clears the
    // raster until Regenerate fetches it for the new floor.
    if (!map || !meta || !meta.radar || !meta.radar.file) {
      radar = null;
      return;
    }
    const file = (liveLayer && liveLayer.file) || meta.radar.file;
    let live = true;
    const img = new Image();
    // pack.base: /api/mappack/<map> for extracted packs, /maps/<map> for
    // the bundled meta (loadMapPack resolves the source; the bundle ships
    // metadata only, never radar art — maps/README.md).
    img.src = `${pack.base || '/maps/' + encodeURIComponent(map)}/${file}`;
    img
      .decode()
      .then(() => {
        if (live) radar = img;
      })
      .catch(() => {
        if (live) radar = null;
      });
    return () => {
      live = false;
    };
  });

  $effect(() => {
    draw();
  });

  function draw() {
    const c = canvas;
    if (!c) return;
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, bw, bh);
    if (radar) {
      // Radar art → device-pixel backing: smoothing high, and no
      // CSS-pixel upscale on either side of this draw.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(radar, 0, 0, bw, bh);
    } else {
      // No radar art (missing pack, or a pack without an image): one
      // generic presentation — dark surface + plain coordinate grid,
      // same line colors as the replay renderer's grid.
      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(0, 0, bw, bh);
      drawPlainGrid(ctx);
    }
    drawOverlay(ctx);
  }

  // Plain grid drawn straight in device pixels (the 64-image-px step of
  // renderer.drawGrid(), scaled and snapped so lines stay hairlines).
  function drawPlainGrid(ctx) {
    const sx = bw / W;
    const sy = bh / H;
    ctx.strokeStyle = 'rgba(215, 221, 232, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const stepX = 64 * sx;
    const stepY = 64 * sy;
    for (let x = stepX; x < bw; x += stepX) {
      const px = Math.round(x) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, bh);
    }
    for (let y = stepY; y < bh; y += stepY) {
      const py = Math.round(y) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(bw, py);
    }
    ctx.stroke();
    // extent border
    ctx.strokeStyle = 'rgba(58, 67, 86, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, bw - 2, bh - 2);
  }

  // Overlay raster cache: the field→pixel render is the expensive step;
  // redraws (radar arrival, resize) reuse it while both inputs — the
  // grid object and the device-pixel rect size — are unchanged.
  let overlay = null; // { grid, ow, oh, cv } | null

  function overlayCanvas(g, ow, oh) {
    if (overlay && overlay.grid === g && overlay.ow === ow && overlay.oh === oh) {
      return overlay.cv;
    }
    const cv = document.createElement('canvas');
    cv.width = ow;
    cv.height = oh;
    const octx = cv.getContext('2d');
    if (!octx) return null;
    const img = octx.createImageData(ow, oh);
    img.data.set(renderHeatField(g.cells, g.w, g.h, g.max, g.kind === 'kd', ow, oh));
    octx.putImageData(img, 0, 0);
    overlay = { grid: g, ow, oh, cv };
    return cv;
  }

  function drawOverlay(ctx) {
    // Floor-mismatch gate (owner rule): the raster draws ONLY while the
    // live floor is the floor it was fetched for — a floor switch clears
    // the overlay from view (the new floor has no data yet) while the
    // radar image flips immediately; Regenerate records the selected
    // index as gridLayer and the raster is drawn again. Before the first
    // Generate `grid` is null so nothing draws regardless (gridLayer
    // starts at 0 = layer's initial value); with no pack layers the
    // selector is hidden so `layer` never leaves 0 — the single-layer /
    // no-pack / bundled-grid fallbacks always pass this gate, unchanged.
    if (layer !== gridLayer) return;
    const g = grid;
    if (!baseTf || !g || !g.w || !g.h) return;
    const cells = g.cells;
    if (!cells || cells.length < g.w * g.h) return;
    const cw = (g.maxX - g.minX) / g.w;
    const ch = (g.maxY - g.minY) / g.h;
    if (!(cw > 0) || !(ch > 0)) return;

    // World-bounds rect → device pixels (image space × the device
    // scale). The overlay is rendered AT that rect's device resolution
    // and drawn ~1:1 (fractional origin keeps it locked to world space;
    // the ≤1 device-px edge softness beats a half-pixel world shift).
    // Top-left is (minX, maxY) because toImage flips Y. Cells whose
    // bounds run past the radar simply clip. The image space here is the
    // LIVE floor's — the gate above guarantees that is also the floor the
    // raster was fetched for (same index whenever anything is drawn).
    const p0 = baseTf.toImage(g.minX, g.maxY);
    const p1 = baseTf.toImage(g.maxX, g.minY);
    const sx = bw / W;
    const sy = bh / H;
    const ox = p0.x * sx;
    const oy = p0.y * sy;
    const ow = Math.max(1, Math.round((p1.x - p0.x) * sx));
    const oh = Math.max(1, Math.round((p1.y - p0.y) * sy));
    const off = overlayCanvas(g, ow, oh);
    if (!off) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, ox, oy, ow, oh);
    ctx.restore();
  }

  // Click → world coords → the grid cell containing the point (snapped to
  // cell size) → bbox drill into the replay landmark feed. Client pixels
  // map through the displayed size to IMAGE space (the backing store is
  // device pixels, so c.width is the wrong scale here).
  // No bbox for this kind (heatRegionTakesBBox — the view's nav gate is
  // the same predicate) → the click does nothing: a click that navigated
  // nowhere useful would open the replay with no region selected. The
  // cell readout under the cursor stays available (the title still names
  // what the map shows) — only the DRILL affordance goes away.
  function onClick(e) {
    if (!drillable) return;
    const c = canvas;
    // baseTf (the LIVE floor's mapping — same space as the image on
    // screen and the W/H below): a click drills into the world region the
    // cursor is over on the radar the user is actually looking at.
    if (!baseTf || !c || !grid || !grid.w || !grid.h) return;
    const cw = (grid.maxX - grid.minX) / grid.w;
    const ch = (grid.maxY - grid.minY) / grid.h;
    if (!(cw > 0) || !(ch > 0)) return;
    const rect = c.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ix = ((e.clientX - rect.left) / rect.width) * W;
    const iy = ((e.clientY - rect.top) / rect.height) * H;
    const world = baseTf.toWorld(ix, iy);
    const ci = Math.floor((world.x - grid.minX) / cw);
    const ri = Math.floor((world.y - grid.minY) / ch);
    onRegion({
      minX: grid.minX + ci * cw,
      minY: grid.minY + ri * ch,
      maxX: grid.minX + (ci + 1) * cw,
      maxY: grid.minY + (ri + 1) * ch,
    });
  }
</script>

<div class="heat-canvas-wrap" bind:clientWidth={boxW}>
  <canvas
    bind:this={canvas}
    class="heat-canvas"
    width={bw}
    height={bh}
    title={drillable
      ? 'Click a region to open the replay events for that position'
      : 'No region drill for this heatmap kind — its raster has no event rows behind it'}
    style={drillable ? undefined : 'cursor: default'}
    onclick={onClick}
    aria-label="Heatmap over the map grid"
  ></canvas>
</div>
