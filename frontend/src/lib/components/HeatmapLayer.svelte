<script>
  // Canvas heatmap layer: map-pack radar as base, HeatmapGrid raster as
  // overlay. All world→image math goes through mapxform's transform — the
  // formula is never duplicated here.
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
  const W = $derived(xf ? xf.width : 1024);
  const H = $derived(xf ? xf.height : 1024);

  $effect(() => {
    const meta = pack && pack.meta;
    if (!map || !meta || !meta.radar || !meta.radar.file) {
      radar = null;
      return;
    }
    let live = true;
    const img = new Image();
    img.src = `/maps/${encodeURIComponent(map)}/${meta.radar.file}`;
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
      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(0, 0, W, H);
    }
    drawOverlay(ctx);
  }

  function drawOverlay(ctx) {
    const g = grid;
    if (!xf || !g || !g.w || !g.h) return;
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
    const logMax = Math.log(10); // log(1 + 9·1): normalizes v/max → 0..1
    for (let r = 0; r < g.h; r++) {
      const dstRow = g.h - 1 - r; // row 0 (minY) → bottom of image space
      for (let c = 0; c < g.w; c++) {
        const v = cells[r * g.w + c] || 0;
        // Log-ish scale so low-traffic cells stay visible next to hotspots.
        const t = max > 0 && v > 0 ? Math.log(1 + 9 * (v / max)) / logMax : 0;
        const o = (dstRow * g.w + c) * 4;
        if (t <= 0) {
          data[o + 3] = 0;
          continue;
        }
        // Ramp: transparent → amber → red, normalized by grid.max.
        const a = Math.min(1, t * 1.5) * 0.92;
        data[o] = Math.round(245 + (224 - 245) * t);
        data[o + 1] = Math.round(166 + (91 - 166) * t);
        data[o + 2] = Math.round(24 + (91 - 24) * t);
        data[o + 3] = Math.round(a * 255);
      }
    }
    octx.putImageData(imgData, 0, 0);

    // World-bounds rect → image pixels: top-left is (minX, maxY) because
    // toImage flips Y. Cells whose bounds run past the radar simply clip.
    const p0 = xf.toImage(g.minX, g.maxY);
    const p1 = xf.toImage(g.maxX, g.minY);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.restore();
  }

  // Click → world coords → the grid cell containing the point (snapped to
  // cell size) → bbox drill into the timeline.
  function onClick(e) {
    const c = canvas;
    if (!xf || !c || !grid || !grid.w || !grid.h) return;
    const cw = (grid.maxX - grid.minX) / grid.w;
    const ch = (grid.maxY - grid.minY) / grid.h;
    if (!(cw > 0) || !(ch > 0)) return;
    const rect = c.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * c.width;
    const py = ((e.clientY - rect.top) / rect.height) * c.height;
    const world = xf.toWorld(px, py);
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
    title="Click a region to filter the timeline by position"
    onclick={onClick}
    aria-label="Heatmap over the map radar"
  ></canvas>
</div>
