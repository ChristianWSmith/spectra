<script>
  import { makeTransform } from './mapxform.js';
  import {
    HEAT_STOPS,
    DEATH_STOPS,
    intensity,
    signedIntensity,
    rampColor,
  } from '../heatramp.js';

  // Canvas heatmap layer: map-pack radar as base, HeatmapGrid raster as
  // overlay. All world→image math goes through mapxform's transform — the
  // formula is never duplicated here. With no pack transform, a fallback
  // transform built from the heatmap's own world bounds gives one generic
  // presentation: a plain coordinate grid (the app ships no radar art).
  //
  // Grid mapping contract: cells[] is row-major (r*w+c) with row 0 at
  // grid.minY, so cell (r,c) covers world
  //   x ∈ [minX + c*cw, minX + (c+1)*cw],  y ∈ [minY + r*ch, minY + (r+1)*ch]
  // where cw=(maxX-minX)/w, ch=(maxY-minY)/h. Row 0 (minY) sits at the
  // BOTTOM of image space (toImage flips Y), hence the row flip when
  // writing the offscreen ImageData.
  let { map = '', pack = null, grid = null, onRegion = () => {} } = $props();

  let canvas = $state(null);
  let radar = $state(null); // decoded radar image | null

  const xf = $derived(pack && pack.transform ? pack.transform : null);
  // No-pack fallback: derive the world→image mapping from the heatmap's own
  // world bounds — the same honest presentation as the replay renderer's
  // no-pack grid (plain world-coordinate grid, never invented map art).
  // Built through makeTransform (mapxform), so the formula stays canonical:
  // image space = padded bounds at ~900 px, mirroring renderer.reproject().
  const fb = $derived.by(() => {
    // A radar image without a transform stays the old path (image only) —
    // never position data over pixels we can't align.
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
  const W = $derived(eff ? eff.width : 1024);
  const H = $derived(eff ? eff.height : 1024);

  $effect(() => {
    const meta = pack && pack.meta;
    if (!map || !meta || !meta.radar || !meta.radar.file) {
      radar = null;
      return;
    }
    let live = true;
    const img = new Image();
    // pack.base: /api/mappack/<map> for extracted packs, /maps/<map> for
    // the bundled meta (loadMapPack resolves the source; the bundle ships
    // metadata only, never radar art — maps/README.md).
    img.src = `${pack.base || '/maps/' + encodeURIComponent(map)}/${meta.radar.file}`;
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
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (radar) {
      ctx.drawImage(radar, 0, 0, W, H);
    } else {
      // No radar art (missing pack, or a pack without an image): one
      // generic presentation — dark surface + plain coordinate grid,
      // same line colors as the replay renderer's grid.
      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(0, 0, W, H);
      drawPlainGrid(ctx);
    }
    drawOverlay(ctx);
  }

  function drawPlainGrid(ctx) {
    ctx.strokeStyle = 'rgba(215, 221, 232, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 64; // image px — renderer.drawGrid()'s step
    for (let x = step; x < W; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
    }
    for (let y = step; y < H; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
    }
    ctx.stroke();
    // extent border
    ctx.strokeStyle = 'rgba(58, 67, 86, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
  }

  function drawOverlay(ctx) {
    const g = grid;
    if (!eff || !g || !g.w || !g.h) return;
    const cells = g.cells;
    if (!cells || cells.length < g.w * g.h) return;
    const cw = (g.maxX - g.minX) / g.w;
    const ch = (g.maxY - g.minY) / g.h;
    if (!(cw > 0) || !(ch > 0)) return;

    // Grid-resolution offscreen raster, then one smoothed upscale into the
    // grid's world-bounds rect — bilinear gives the interpolated ramp.
    const off = document.createElement('canvas');
    off.width = g.w;
    off.height = g.h;
    const octx = off.getContext('2d');
    if (!octx) return;
    const imgData = octx.createImageData(g.w, g.h);
    const data = imgData.data;
    const max = g.max > 0 ? g.max : 0;
    // The signed kd raster normalizes by |v|max and picks its ramp per
    // sign (deaths blue, kills amber→white-hot); everything else rides
    // HEAT_STOPS on the sqrt intensity curve (lib/heatramp.js — the
    // legend's gradient is painted from the same stops).
    const signed = g.kind === 'kd';
    for (let r = 0; r < g.h; r++) {
      const dstRow = g.h - 1 - r; // row 0 (minY) → bottom of image space
      for (let c = 0; c < g.w; c++) {
        const v = cells[r * g.w + c] || 0;
        const t = signed ? signedIntensity(v, max) : intensity(v, max);
        const o = (dstRow * g.w + c) * 4;
        if (t === 0) {
          data[o + 3] = 0;
          continue;
        }
        const [cr, cg, cb, ca] = rampColor(
          t < 0 ? DEATH_STOPS : HEAT_STOPS,
          Math.abs(t),
        );
        data[o] = Math.round(cr);
        data[o + 1] = Math.round(cg);
        data[o + 2] = Math.round(cb);
        data[o + 3] = Math.round(ca * 255);
      }
    }
    octx.putImageData(imgData, 0, 0);

    // World-bounds rect → image pixels: top-left is (minX, maxY) because
    // toImage flips Y. Cells whose bounds run past the radar simply clip.
    const p0 = eff.toImage(g.minX, g.maxY);
    const p1 = eff.toImage(g.maxX, g.minY);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.restore();
  }

  // Click → world coords → the grid cell containing the point (snapped to
  // cell size) → bbox drill into the replay landmark feed.
  function onClick(e) {
    const c = canvas;
    if (!eff || !c || !grid || !grid.w || !grid.h) return;
    const cw = (grid.maxX - grid.minX) / grid.w;
    const ch = (grid.maxY - grid.minY) / grid.h;
    if (!(cw > 0) || !(ch > 0)) return;
    const rect = c.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * c.width;
    const py = ((e.clientY - rect.top) / rect.height) * c.height;
    const world = eff.toWorld(px, py);
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

<div class="heat-canvas-wrap">
  <canvas
    bind:this={canvas}
    class="heat-canvas"
    width={W}
    height={H}
    title="Click a region to open the replay events for that position"
    onclick={onClick}
    aria-label="Heatmap over the map grid"
  ></canvas>
</div>
