// M2 replay renderer: layered Canvas 2D draw over the engine's typed arrays.
//
// Layers, bottom → top: radar (or world grid) → movement trails → grenade
// landmarks → bomb → players → HUD. Camera is a pan/zoom view over the
// radar's image-pixel space; world→image uses the map pack's transform —
// the canonical pack→transform reader is makeTransform (lib/components/
// mapxform.js, shared with HeatmapLayer): px=(wx-pos_x)/scale,
// py=(pos_y-wy)/scale (Z-up world, inverted Y). With no transform
// (missing pack) one is derived from sample extents so a blank
// coordinate grid still frames the players.
import { makeTransform } from '../components/mapxform.js';
import { classifyLandmark } from './landmarks.js';

const CT_COLOR = '#5aa9e6';
const T_COLOR = '#e6a35a';
const OTHER_COLOR = '#9aa4b5';
const TRAIL_FRAMES = 192; // ~3 s at 64 Hz
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;
const SMOKE_LIFETIME_S = 18;
const FIRE_LIFETIME_S = 7;
const FIRE_RADIUS = 130; // world units
const SMOKE_RADIUS = 144;

function teamColor(side) {
  if (side === 'ct') return CT_COLOR;
  if (side === 't') return T_COLOR;
  return OTHER_COLOR;
}

function hasPos(l) {
  return l && Number.isFinite(l.x) && Number.isFinite(l.y);
}

export function createRenderer(canvas, { engine, data, players }) {
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;

  let store = data; // parsed positions
  let slotSides = (players || []).map((p) => p.side);
  let slotNames = (players || []).map((p) => p.name || '');
  let pack = null; // map pack meta.json or null
  let packTf = null; // makeTransform(meta) output — the canonical
  //                    pack→{posX,posY,scale,width,height} derivation
  let radar = null; // Image, when the pack ships one
  let landmarks = [];
  let polylines = []; // grenade throw→detonate pairs
  let dets = []; // grenade detonations
  let smokes = [];
  let fires = [];
  let plants = [];
  let explodes = [];
  let defuses = [];
  let packNote = ''; // HUD hint (missing radar / missing pack)

  // Camera: center of view in image-pixel space + zoom multiplier over the
  // fit scale (which is recomputed on resize).
  const cam = { cx: 0, cy: 0, zoom: 1, fit: 1 };
  // Effective world→image transform + image extent, rebuilt by reproject()
  // from packTf (makeTransform's canonical derivation) or sample bounds.
  // The numeric fields — not an allocating toImage() call — keep the
  // per-frame paths (drawTrails) allocation-free.
  const tf = { pos_x: 0, pos_y: 0, scale: 1 };
  let extW = 1024;
  let extH = 1024;

  const tmp = {};

  function worldToImage(wx, wy, out) {
    out.x = (wx - tf.pos_x) / tf.scale;
    out.y = (tf.pos_y - wy) / tf.scale;
    return out;
  }

  const imgPt = { x: 0, y: 0 };
  function worldToScreen(wx, wy) {
    worldToImage(wx, wy, imgPt);
    const s = cam.fit * cam.zoom;
    return { x: cssW / 2 + (imgPt.x - cam.cx) * s, y: cssH / 2 + (imgPt.y - cam.cy) * s };
  }

  function screenToImage(sx, sy) {
    const s = cam.fit * cam.zoom;
    imgPt.x = cam.cx + (sx - cssW / 2) / s;
    imgPt.y = cam.cy + (sy - cssH / 2) / s;
    return imgPt;
  }

  // reproject derives the effective transform + extent from whatever we have:
  // the pack transform (via makeTransform — packTf) ± radar size, else
  // sample bounds (the no-pack fallback stays renderer-only).
  function reproject() {
    const b = store ? store.bounds : { minX: 0, maxX: 1024, minY: 0, maxY: 1024 };
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanY = Math.max(1, b.maxY - b.minY);
    if (packTf && Number.isFinite(packTf.posX)) {
      tf.pos_x = packTf.posX;
      tf.pos_y = packTf.posY;
      // makeTransform copies scale verbatim; keep the renderer's
      // degenerate-scale guard (0/negative would divide to NaN/infinity).
      tf.scale = packTf.scale > 0 ? packTf.scale : 1;
      extW = packTf.width;
      extH = packTf.height;
      if (radar) packNote = '';
      else packNote = 'map pack has no radar image — grid only';
    } else {
      // Blank coordinate grid: invent an image space from sample extents.
      const scale = Math.max(spanX, spanY) / 900;
      tf.pos_x = b.minX - spanX * 0.05;
      tf.pos_y = b.maxY + spanY * 0.05;
      tf.scale = scale > 0 ? scale : 1;
      extW = Math.max(64, (spanX * 1.1) / tf.scale);
      extH = Math.max(64, (spanY * 1.1) / tf.scale);
      packNote = pack
        ? 'map pack missing radar — world-coordinate grid'
        : 'map pack missing — world-coordinate grid (transform unknown)';
    }
  }

  function fit() {
    reproject();
    cam.zoom = 1;
    cam.cx = extW / 2;
    cam.cy = extH / 2;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    cssW = canvas.clientWidth;
    cssH = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fit();
    draw();
  }

  // setPack(meta, image, transform): transform is the makeTransform()
  // output loadMapPack already built (Replay passes it through); a caller
  // handing us a bare meta gets it derived here — either way makeTransform
  // is the single pack→transform reader.
  function setPack(newPack, image, transform) {
    pack = newPack || null;
    radar = image || null;
    packTf = transform || (pack ? makeTransform(pack) : null);
    fit();
  }

  function setLandmarks(list) {
    landmarks = list || [];
    polylines = [];
    dets = [];
    smokes = [];
    fires = [];
    plants = [];
    explodes = [];
    defuses = [];
    for (const l of landmarks) {
      const bucket = classifyLandmark(l.kind);
      if (bucket === 'throw') {
        // pair with the nearest detonation of same round+thrower+weapon
        // (the partner filter is the detonation bucket — 'grenade' for
        // real data; 'he'/'he_explode' aliases bucket the same way).
        let best = null;
        let bestDelta = Infinity;
        for (const d of landmarks) {
          if (classifyLandmark(d.kind) !== 'detonation') continue;
          if (d.round !== l.round) continue;
          if (l.steamId && d.steamId !== l.steamId) continue;
          if (l.weapon && d.weapon && d.weapon !== l.weapon) continue;
          if (d.tick < l.tick) continue;
          const delta = d.tick - l.tick;
          if (delta < bestDelta) {
            bestDelta = delta;
            best = d;
          }
        }
        polylines.push({ from: l, to: best });
      } else if (bucket === 'detonation') {
        dets.push(l);
      } else if (bucket === 'smoke') {
        smokes.push(l);
      } else if (bucket === 'fire') {
        fires.push(l);
      } else if (bucket === 'plant') {
        plants.push(l);
      } else if (bucket === 'explode') {
        explodes.push(l);
      } else if (bucket === 'defuse') {
        defuses.push(l);
      }
    }
  }

  function setData(newData) {
    store = newData;
    fit();
  }

  function panBy(dx, dy) {
    const s = cam.fit * cam.zoom;
    cam.cx -= dx / s;
    cam.cy -= dy / s;
  }

  function zoomAt(factor, sx, sy) {
    screenToImage(sx, sy);
    const bx = imgPt.x;
    const by = imgPt.y;
    cam.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoom * factor));
    const s = cam.fit * cam.zoom;
    cam.cx = bx - (sx - cssW / 2) / s;
    cam.cy = by - (sy - cssH / 2) / s;
  }

  // --- layers ----------------------------------------------------------------

  function drawGrid() {
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, cssW, cssH);
    const s = cam.fit * cam.zoom;
    ctx.strokeStyle = 'rgba(215, 221, 232, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 64; // image px (= 64 * scale world units)
    const gx0 = Math.floor(screenToImage(0, 0).x / step) * step;
    const gy0 = Math.floor(screenToImage(0, 0).y / step) * step;
    const brX = screenToImage(cssW, cssH).x;
    const brY = screenToImage(cssW, cssH).y;
    for (let gx = gx0; gx <= brX; gx += step) {
      // vertical grid line at image x = gx
      const sx = cssW / 2 + (gx - cam.cx) * s;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, cssH);
    }
    for (let gy = gy0; gy <= brY; gy += step) {
      const sy = cssH / 2 + (gy - cam.cy) * s;
      ctx.moveTo(0, sy);
      ctx.lineTo(cssW, sy);
    }
    ctx.stroke();
    // extent border
    ctx.strokeStyle = 'rgba(58, 67, 86, 0.9)';
    ctx.lineWidth = 2;
    const c0 = worldToScreen(0, 0);
    ctx.strokeRect(c0.x, c0.y, extW * s, extH * s);
  }

  function drawRadar() {
    if (!radar) return false;
    const s = cam.fit * cam.zoom;
    const x = cssW / 2 - cam.cx * s;
    const y = cssH / 2 - cam.cy * s;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(radar, x, y, extW * s, extH * s);
    return true;
  }

  // sideAtFrame resolves a slot's side at frame f: the per-frame side
  // bits (q16-v2 — sides flip at halftime, so the final-side table is
  // only the fallback for legacy sidecars).
  function sideBits(flagsByte) {
    const b = (flagsByte >> 2) & 3;
    return b === 1 ? 't' : b === 2 ? 'ct' : '';
  }
  function sideAtFrame(slot, f) {
    return sideBits(store.slots[slot].flags[f]) || slotSides[slot] || '';
  }

  function drawTrails(frame) {
    const n = store.frames;
    const from = Math.max(0, frame - TRAIL_FRAMES);
    const s = cam.fit * cam.zoom;
    for (let slot = 0; slot < store.slots.length; slot++) {
      const p = store.slots[slot].pos;
      const color = teamColor(sideAtFrame(slot, frame));
      let prev = null;
      for (let f = frame; f >= from; f--) {
        if (!(store.masks[f] & (1 << slot))) {
          prev = null;
          continue;
        }
        const b = f * 4;
        const sx = cssW / 2 + ((p[b] - tf.pos_x) / tf.scale - cam.cx) * s;
        const sy = cssH / 2 + ((tf.pos_y - p[b + 1]) / tf.scale - cam.cy) * s;
        if (prev) {
          const age = (frame - f) / TRAIL_FRAMES;
          ctx.strokeStyle = color;
          ctx.globalAlpha = (1 - age) * 0.5;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }
        prev = [sx, sy];
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawGrenades(tick) {
    const tr = engine.tickRate;
    // smoke / fire areas first (under the lines)
    for (const l of smokes) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > SMOKE_LIFETIME_S) continue;
      const c = worldToScreen(l.x, l.y);
      const r = (SMOKE_RADIUS / tf.scale) * cam.fit * cam.zoom;
      const fade = age > SMOKE_LIFETIME_S - 2 ? (SMOKE_LIFETIME_S - age) / 2 : 1;
      ctx.fillStyle = `rgba(180, 190, 205, ${0.18 * fade})`;
      ctx.strokeStyle = `rgba(180, 190, 205, ${0.35 * fade})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const l of fires) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > FIRE_LIFETIME_S) continue;
      const c = worldToScreen(l.x, l.y);
      const r = (FIRE_RADIUS / tf.scale) * cam.fit * cam.zoom;
      ctx.fillStyle = 'rgba(230, 120, 60, 0.22)';
      ctx.strokeStyle = 'rgba(230, 140, 60, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // throw→detonate polylines, visible while the nade is "in flight"
    for (const pl of polylines) {
      if (!hasPos(pl.from)) continue;
      if (tick < pl.from.tick) continue;
      if (pl.to && tick > pl.to.tick) continue;
      const a = worldToScreen(pl.from.x, pl.from.y);
      ctx.fillStyle = 'rgba(251, 172, 24, 0.8)';
      ctx.beginPath();
      ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
      ctx.fill();
      if (pl.to && hasPos(pl.to)) {
        const b = worldToScreen(pl.to.x, pl.to.y);
        ctx.strokeStyle = 'rgba(251, 172, 24, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // detonation pops (~2 s)
    for (const l of dets) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > 2) continue;
      const c = worldToScreen(l.x, l.y);
      const r = 4 + age * 10;
      ctx.strokeStyle = `rgba(224, 91, 91, ${0.9 - age * 0.4})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawBomb(tick, now) {
    const tr = engine.tickRate;
    for (const l of plants) {
      if (!hasPos(l)) continue;
      // visible from plant until the matching explode (same round), else 40 s
      let endTick = l.tick + 40 * tr;
      for (const e of explodes) {
        if (e.round === l.round && e.tick >= l.tick) {
          endTick = e.tick;
          break;
        }
      }
      if (tick < l.tick || tick > endTick) continue;
      const c = worldToScreen(l.x, l.y);
      const pulse = 10 + 4 * Math.sin(now / 200);
      ctx.strokeStyle = 'rgba(251, 172, 24, 0.95)';
      ctx.fillStyle = 'rgba(251, 172, 24, 0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fbac18';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('C4', c.x, c.y + 3);
    }
    for (const l of explodes) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > 3) continue;
      const c = worldToScreen(l.x, l.y);
      const r = 12 + age * 28;
      ctx.strokeStyle = `rgba(224, 91, 91, ${0.9 - age * 0.3})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const l of defuses) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > 2) continue;
      const c = worldToScreen(l.x, l.y);
      ctx.fillStyle = `rgba(90, 169, 230, ${0.8 - age * 0.4})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPlayers() {
    const s = cam.fit * cam.zoom;
    for (let slot = 0; slot < store.slots.length; slot++) {
      engine.lerpAt(slot, tmp);
      if (!tmp.alive) continue;
      const c = worldToScreen(tmp.x, tmp.y);
      if (c.x < -60 || c.y < -60 || c.x > cssW + 60 || c.y > cssH + 60) continue;
      const color = teamColor(sideAtFrame(slot, engine.state.frame));
      const r = tmp.duck ? 6.5 : 9;
      // view cone ±22°, semi-transparent
      const a0 = (-tmp.yaw - 22) * Math.PI / 180;
      const a1 = (-tmp.yaw + 22) * Math.PI / 180;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.arc(c.x, c.y, r * 2.8, a0, a1);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // body
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // follow ring
      if (engine.state.followSlot === slot) {
        ctx.strokeStyle = '#fbac18';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      // name label
      const name = slotNames[slot] || `#${slot}`;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 3;
      ctx.fillStyle = '#d7dde8';
      ctx.fillText(name, c.x, c.y + r + 13);
      ctx.shadowBlur = 0;
    }
  }

  function fmtClock(tick) {
    const sec = Math.max(0, Math.floor(tick / engine.tickRate));
    const m = Math.floor(sec / 60);
    const s2 = sec % 60;
    return `${m}:${String(s2).padStart(2, '0')}`;
  }

  function drawHUD() {
    const st = engine.state;
    const lines = [
      `tick ${st.tick}   ${fmtClock(st.tick)}`,
      `${st.speed}×   frame ${st.frame + 1}/${engine.frames}`,
    ];
    if (st.followSlot != null) {
      lines.push(`follow: ${slotNames[st.followSlot] || '#' + st.followSlot}`);
    }
    if (st.loopEnabled && st.loopFrom >= 0) {
      lines.push(`loop: f${st.loopFrom}–${st.loopTo}`);
    }
    if (packNote) lines.push(packNote);
    const pad = 8;
    const lh = 15;
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    let w = 0;
    for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
    ctx.fillStyle = 'rgba(14, 17, 22, 0.78)';
    ctx.strokeStyle = 'rgba(35, 42, 55, 0.9)';
    ctx.lineWidth = 1;
    const bh = lines.length * lh + pad * 2 - 3;
    ctx.beginPath();
    // roundRect is baseline in modern WebKit; fall back for older builds
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(8, 8, w + pad * 2, bh, 6);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(8, 8, w + pad * 2, bh);
      ctx.strokeRect(8, 8, w + pad * 2, bh);
    }
    ctx.fillStyle = '#d7dde8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((ln, i) => {
      ctx.fillStyle = i === 0 ? '#fbac18' : '#8b94a7';
      ctx.fillText(ln, 8 + pad, 8 + pad + i * lh);
    });
    ctx.textBaseline = 'alphabetic';
  }

  function draw() {
    if (!cssW || !cssH) return;
    const now = performance.now();
    const st = engine.state;
    ctx.clearRect(0, 0, cssW, cssH);
    if (!drawRadar()) drawGrid();
    if (store && store.frames > 0) {
      // center on the followed player before drawing the rest
      if (st.followSlot != null) {
        engine.lerpAt(st.followSlot, tmp);
        worldToImage(tmp.x, tmp.y, imgPt);
        cam.cx = imgPt.x;
        cam.cy = imgPt.y;
      }
      drawTrails(st.frame);
      drawGrenades(st.tick);
      drawBomb(st.tick, now);
      drawPlayers();
    }
    drawHUD();
  }

  return {
    draw,
    resize,
    fit,
    setPack,
    setLandmarks,
    setData,
    panBy,
    zoomAt,
    worldToScreen,
    getCam: () => cam,
  };
}
