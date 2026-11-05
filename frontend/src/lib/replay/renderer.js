// M2 replay renderer: layered Canvas 2D draw over the engine's typed arrays.
//
// Layers, bottom → top: radar (or world grid) → movement trails → grenade
// landmarks → bomb → players → HUD. Camera is a pan/zoom view over the
// radar's image-pixel space with two modes: 'smart' (the default — eased
// fit that keeps every alive player + the active bomb on screen; see
// smartCamTarget/stepSmart below) and 'free' (manual pan/zoom); world→image
// uses the map pack's transform — the canonical pack→transform reader is
// makeTransform (lib/components/mapxform.js, shared with HeatmapLayer):
// px=(wx-pos_x)/scale, py=(pos_y-wy)/scale (Z-up world, inverted Y).
// With no transform (missing pack) one is derived from sample extents so
// a blank coordinate grid still frames the players.
import { makeTransform } from '../components/mapxform.js';
// (bucketing/classification lives in ./landmarks.js — rows arrive
// pre-bucketed from normalizeEvent; see setLandmarks.)
import { bombEndTick, bombEvidenceAt, hasBombPos } from './bomb.js';

const CT_COLOR = '#5aa9e6';
const T_COLOR = '#e6a35a';
const OTHER_COLOR = '#9aa4b5';
const TRAIL_FRAMES = 192; // ~3 s at 64 Hz
// Trail continuity: a trail segment is only drawn between two ADJACENT
// frames that are continuous — a bounded tick gap AND a bounded step.
// Round resets and death→respawns teleport a player across the map
// between two otherwise-alive frames; without this rule the polyline
// connects through the teleport and draws one long streaking line from
// the old position back to spawn. The sidecar samples 1:1 with demo
// frames, so a normal gap is ~1 tick and a normal step is a few units.
const TRAIL_MAX_TICK_GAP = 8; // ticks — anything larger is a discontinuity
const TRAIL_MAX_STEP2 = 256 * 256; // world units² — human movement is ~8/frame
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;
// --- Smart camera (the DEFAULT mode) -----------------------------------------
// Keeps every alive player + the active bomb on screen at all times,
// easing toward a fitted target each frame (never snapping).
const SMART_MARGIN = 56; // CSS px of breathing room around the entities
const SMART_TAU_CENTER = 0.18; // s — center ease time constant
const SMART_TAU_ZOOM = 0.26; // s — zoom ease (slower = calmer)
const SMART_DT_CLAMP = 0.033; // s — max eased step per draw: after a
//                             stall/seek the first frame glides (~17%)
//                             instead of lurching toward the target
const SMART_ZOOM_MIN = 0.08; // floor — a full-map spread must still fit;
//                            // deliberately BELOW ZOOM_MIN (the manual
//                            // zoom floor): on-screen beats tight here
const SMART_ZOOM_MAX = 4; // cap — never tunnel-vision tighter than ~1/4 map
const SMART_EPS_CENTER = 0.25; // img px — "converged" for the settle loop
const SMART_EPS_ZOOM = 0.002; // relative zoom tolerance
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

// trailConnects — the pure continuity rule drawTrails applies per segment:
// does the trail draw between frame f and f+1 of one slot? `ticks` is the
// store's tick array, `pos` that slot's interleaved Float32Array
// [x, y, z, yaw] per frame. False breaks the polyline here (teleport /
// stalled sampling); the chain restarts at the next segment, so trails
// across a round reset or a death→respawn never connect — the first
// post-respawn segments start fresh at spawn. Exported for the headless
// test in src/lib/renderer.test.js.
export function trailConnects(ticks, pos, f) {
  if (f < 0 || f + 1 >= ticks.length) return false;
  const gap = ticks[f + 1] - ticks[f];
  if (gap <= 0 || gap > TRAIL_MAX_TICK_GAP) return false;
  const b = f * 4;
  const pb = (f + 1) * 4;
  const dx = pos[b] - pos[pb];
  const dy = pos[b + 1] - pos[pb + 1];
  return dx * dx + dy * dy <= TRAIL_MAX_STEP2;
}

// smartCamTarget — the smart camera's FIT algorithm (pure; head-tested
// in renderer.test.js). `box` is the entity bounding box in IMAGE px,
// cssW/cssH the canvas size, cfg { margin, minZoom, maxZoom, extW, extH }.
// Returns the target camera state { cx, cy, s } where s is the ABSOLUTE
// scale (screen px per image px = cam.fit * cam.zoom): the box is padded
// by `margin` on every side and scaled to fit the canvas (clamped to the
// smart zoom band), then the center is clamped so a view that FITS
// INSIDE the image extent never shows void outside it — a view wider
// than the image centers on the image instead (the entities are inside
// the image either way, so they stay on screen).
export function smartCamTarget(box, cssW, cssH, cfg = {}) {
  const margin = cfg.margin ?? SMART_MARGIN;
  const minS = cfg.minZoom ?? SMART_ZOOM_MIN;
  const maxS = cfg.maxZoom ?? SMART_ZOOM_MAX;
  const w = Math.max(1e-6, box.maxX - box.minX);
  const h = Math.max(1e-6, box.maxY - box.minY);
  const availW = Math.max(1, cssW - 2 * margin);
  const availH = Math.max(1, cssH - 2 * margin);
  const s = Math.min(maxS, Math.max(minS, Math.min(availW / w, availH / h)));
  let cx = (box.minX + box.maxX) / 2;
  let cy = (box.minY + box.maxY) / 2;
  const halfW = cssW / (2 * s);
  const halfH = cssH / (2 * s);
  if (Number.isFinite(cfg.extW)) {
    cx = 2 * halfW <= cfg.extW ? Math.min(Math.max(cx, halfW), cfg.extW - halfW) : cfg.extW / 2;
  }
  if (Number.isFinite(cfg.extH)) {
    cy = 2 * halfH <= cfg.extH ? Math.min(Math.max(cy, halfH), cfg.extH - halfH) : cfg.extH / 2;
  }
  return { cx, cy, s };
}

// easeValue — one exponential-approach step toward target: the smoothing
// that keeps smart pan/zoom from ever snapping (the caller clamps dt).
export function easeValue(cur, target, dt, tau) {
  if (!(dt > 0) || !(tau > 0)) return cur;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
}

// camConverged — has the eased camera reached its target within the
// center/zoom tolerances? Drives the renderer's settle loop (the ease
// keeps running after a paused seek, where nothing else redraws).
export function camConverged(cur, target) {
  return (
    Math.abs(cur.cx - target.cx) < SMART_EPS_CENTER &&
    Math.abs(cur.cy - target.cy) < SMART_EPS_CENTER &&
    Math.abs(cur.s - target.s) <= SMART_EPS_ZOOM * Math.max(target.s, 1e-9)
  );
}

export function createRenderer(canvas, { engine, data, players, onUserCamera = null }) {
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
  let drops = []; // bomb_drop evidence rows (carrier position — bomb.js)
  let pickups = []; // bomb_pickup evidence rows
  let roundEnds = []; // round_end rows — the round-end bomb terminator
  // The dropped-C4 evidence bundle consumed by bomb.js bombEvidenceAt
  // (the smart camera's bomb point and drawBomb's dropped marker).
  let bombEv = { drops: [], pickups: [], plants: [], roundEnds: [] };
  let packNote = ''; // HUD hint (missing radar / missing pack)

  // Camera: center of view in image-pixel space + zoom multiplier over the
  // fit scale (which is recomputed on resize).
  const cam = { cx: 0, cy: 0, zoom: 1, fit: 1 };
  // Follow camera: last ALIVE world position of the followed slot (the
  // camera holds it while they are dead — see draw()).
  let followFor = -1;
  let followX = null;
  let followY = null;
  // Camera mode: 'smart' (the default — eases the view to keep every
  // alive player + the active bomb framed) or 'free' (manual pan/zoom).
  // Follow overrides both (explicit user intent) and smart resumes when
  // follow releases. Panning/zooming while smart takes over to free and
  // notifies the caller (onUserCamera) so its selector follows — the
  // pref keeps whatever the user picked there explicitly.
  let camMode = 'free';
  let easeRaf = 0; // the smart settle loop's pending frame (0 = idle)
  let lastEaseT = 0; // last eased draw, for the dt of the next step
  let smartConverged = true;
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
    // Rows arrive PRE-BUCKLETED (lib/replay/landmarks.js normalizeEvent
    // stamps `bucket`) — no classification happens in the render path.
    // Two passes: bucket everything, then pair throws against the
    // COMPLETE detonation set (a single pass would scan a half-populated
    // raw list and re-classify every row per throw).
    landmarks = list || [];
    polylines = [];
    dets = [];
    smokes = [];
    fires = [];
    plants = [];
    explodes = [];
    defuses = [];
    drops = [];
    pickups = [];
    roundEnds = [];
    const throws = [];
    for (const l of landmarks) {
      switch (l.bucket) {
        case 'throw':
          throws.push(l);
          break;
        case 'detonation':
          dets.push(l);
          break;
        case 'smoke':
          smokes.push(l);
          break;
        case 'fire':
          fires.push(l);
          break;
        case 'plant':
          plants.push(l);
          break;
        case 'explode':
          explodes.push(l);
          break;
        case 'defuse':
          defuses.push(l);
          break;
        case 'drop':
          drops.push(l);
          break;
        case 'pickup':
          pickups.push(l);
          break;
        case 'round':
          roundEnds.push(l);
          break;
      }
    }
    // The bomb evidence bundle for bomb.js (dropped reconstruction +
    // planted round-end cleanup). One rebuild per setLandmarks call —
    // the per-frame paths only scan these small arrays.
    bombEv = { drops, pickups, plants, roundEnds };
    for (const l of throws) {
      // pair with the nearest detonation of same round+thrower+weapon
      let best = null;
      let bestDelta = Infinity;
      for (const d of dets) {
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
    }
  }

  function setData(newData) {
    store = newData;
    fit();
  }

  function panBy(dx, dy) {
    if (camMode === 'smart') takeOver(); // manual drag → free camera
    const s = cam.fit * cam.zoom;
    cam.cx -= dx / s;
    cam.cy -= dy / s;
  }

  function zoomAt(factor, sx, sy) {
    if (camMode === 'smart') takeOver(); // manual wheel → free camera
    screenToImage(sx, sy);
    const bx = imgPt.x;
    const by = imgPt.y;
    cam.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoom * factor));
    const s = cam.fit * cam.zoom;
    cam.cx = bx - (sx - cssW / 2) / s;
    cam.cy = by - (sy - cssH / 2) / s;
  }

  // --- smart camera ---------------------------------------------------------

  // takeOver: user panned/zoomed while smart — drop to free for the
  // session and tell the caller (Replay updates its selector; the pref
  // keeps the explicit choice, so the next entry starts smart again).
  function takeOver() {
    camMode = 'free';
    cancelEase();
    if (onUserCamera) onUserCamera();
  }

  function cancelEase() {
    if (easeRaf) cancelAnimationFrame(easeRaf);
    easeRaf = 0;
  }

  // setCameraMode: 'smart' | 'free' (anything else reads as free).
  // Switching to smart re-arms the ease from wherever the camera is —
  // the target is computed on the next draw, never snapped to.
  function setCameraMode(mode) {
    const next = mode === 'smart' ? 'smart' : 'free';
    if (next === camMode) return;
    camMode = next;
    lastEaseT = 0;
    if (next === 'smart') smartConverged = false;
    else cancelEase();
    draw();
  }

  // smartTarget: the bounding box of everything that must stay on
  // screen — ALIVE players (the store only samples alive slots; a dead
  // player has no current position and their last spot would pin the
  // view to a ghost) plus the ACTIVE bomb: planted (the bombEndTick
  // window) or dropped (bomb.js evidence). A carried bomb needs no
  // point of its own — its carrier is an alive player. Returns null
  // when there is nobody to frame (hold the current view).
  function smartTarget() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const img = { x: 0, y: 0 };
    const add = (wx, wy) => {
      worldToImage(wx, wy, img);
      if (img.x < minX) minX = img.x;
      if (img.x > maxX) maxX = img.x;
      if (img.y < minY) minY = img.y;
      if (img.y > maxY) maxY = img.y;
    };
    for (let slot = 0; slot < store.slots.length; slot++) {
      engine.lerpAt(slot, tmp);
      if (tmp.alive && Number.isFinite(tmp.x)) add(tmp.x, tmp.y);
    }
    const tr = engine.tickRate;
    const tick = engine.state.tick;
    for (const l of plants) {
      if (!hasPos(l)) continue;
      if (tick >= l.tick && tick <= bombEndTick(l, tr, explodes, defuses, roundEnds)) {
        add(l.x, l.y);
      }
    }
    const ev = bombEvidenceAt(bombEv, tick);
    if (ev && ev.state === 'dropped' && hasBombPos(ev)) add(ev.x, ev.y);
    if (!(minX <= maxX)) return null;
    return smartCamTarget({ minX, minY, maxX, maxY }, cssW, cssH, { extW, extH });
  }

  // stepSmart eases cam one step toward the fitted target (log-space
  // zoom so in/out feel symmetric) and records convergence.
  function stepSmart(now) {
    const target = smartTarget();
    if (!target) {
      smartConverged = true; // nothing to frame — hold the view
      lastEaseT = now;
      return;
    }
    let dt = lastEaseT ? (now - lastEaseT) / 1000 : SMART_DT_CLAMP;
    lastEaseT = now;
    dt = Math.max(0, Math.min(SMART_DT_CLAMP, dt));
    cam.cx = easeValue(cam.cx, target.cx, dt, SMART_TAU_CENTER);
    cam.cy = easeValue(cam.cy, target.cy, dt, SMART_TAU_CENTER);
    const sCur = cam.fit * cam.zoom;
    const s = Math.exp(easeValue(Math.log(sCur), Math.log(target.s), dt, SMART_TAU_ZOOM));
    cam.zoom = Math.max(SMART_ZOOM_MIN, Math.min(ZOOM_MAX, s / cam.fit));
    smartConverged = camConverged(
      { cx: cam.cx, cy: cam.cy, s: cam.fit * cam.zoom },
      target,
    );
  }

  // The settle loop: draw() arms it while the smart camera has not
  // converged (a paused seek, a mode switch — anywhere nothing else
  // redraws). While the engine is PLAYING its own per-frame draw() has
  // already eased, so the loop just stays armed instead of double-
  // drawing. It stops on convergence, on 'free', or on follow.
  function easeTick() {
    easeRaf = 0;
    if (camMode !== 'smart') return;
    const st = engine.state;
    if (st.followSlot != null) return; // follow owns the camera
    if (st.playing) {
      if (!smartConverged) easeRaf = requestAnimationFrame(easeTick);
      return;
    }
    draw();
  }

  function destroy() {
    cancelEase();
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
  // bits (q16-v2 — sides flip at halftime), falling back to the slot's
  // final side from meta. The fallback is not an old-format shim: v2
  // side bits are 0 (unknown) whenever the slot carries no payload that
  // frame (dead player) or the extractor saw an unassigned team, and the
  // final-side table is all we have for those frames.
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
        // prev is frame f+1 (the loop is contiguous and only alive frames
        // set it); trailConnects breaks the chain across a round reset /
        // respawn teleport instead of drawing the streaking line.
        if (prev && trailConnects(store.ticks, p, f)) {
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
      // Visible from plant until the first same-round terminator —
      // detonation, defuse, or the ROUND END (the planted-C4 cleanup:
      // a round that ends before the bomb resolves no longer keeps the
      // marker on screen). bomb.js bombEndTick owns the rule; the 40 s
      // C4 timer is its no-terminator fallback.
      const endTick = bombEndTick(l, tr, explodes, defuses, roundEnds);
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
    // Dropped C4 — drawn only while the reconstruction says it is ON
    // THE GROUND (bomb.js bombEvidenceAt state 'dropped'; the position
    // is the carrier's evidence position from bomb_drop). A picked-up
    // bomb follows its carrier's player row and a planted one is the
    // loop above — neither draws here. Dashed ring = not armed.
    const ev = bombEvidenceAt(bombEv, tick);
    if (ev && ev.state === 'dropped' && hasBombPos(ev)) {
      const c = worldToScreen(ev.x, ev.y);
      const pulse = 9 + 3 * Math.sin(now / 240);
      ctx.strokeStyle = 'rgba(251, 172, 24, 0.9)';
      ctx.fillStyle = 'rgba(251, 172, 24, 0.16)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
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
    // Smart mode eases toward its fitted target BEFORE the frame renders
    // (an explicit follow overrides it — follow is user intent, smart
    // resumes the moment follow releases).
    if (camMode === 'smart') {
      if (st.followSlot == null && store && store.frames > 0) stepSmart(now);
      else smartConverged = true; // follow owns it / nothing to frame
    }
    ctx.clearRect(0, 0, cssW, cssH);
    if (!drawRadar()) drawGrid();
    if (store && store.frames > 0) {
      // center on the followed player before drawing the rest
      if (st.followSlot != null) {
        if (st.followSlot !== followFor) {
          followFor = st.followSlot;
          followX = followY = null;
        }
        engine.lerpAt(st.followSlot, tmp);
        // Hold the last ALIVE position while they are dead (respawn /
        // round transition): lerpAt leaves x/y untouched for dead frames
        // and tmp is shared with drawPlayers, so without this hold the
        // camera would jump to whichever slot drew last.
        if (tmp.alive && Number.isFinite(tmp.x)) {
          followX = tmp.x;
          followY = tmp.y;
        }
        if (followX != null) {
          worldToImage(followX, followY, imgPt);
          cam.cx = imgPt.x;
          cam.cy = imgPt.y;
        }
      } else {
        followFor = -1;
      }
      drawTrails(st.frame);
      drawGrenades(st.tick);
      drawBomb(st.tick, now);
      drawPlayers();
    }
    drawHUD();
    // Arm the settle loop when smart is still short of its target — a
    // paused seek (or a mode switch) has no other redraw driver. draw()
    // is the single arming point and it checks !easeRaf, so the engine's
    // per-frame draws while playing never double up with the loop.
    if (camMode === 'smart' && st.followSlot == null && !smartConverged && !easeRaf) {
      easeRaf = requestAnimationFrame(easeTick);
    }
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
    setCameraMode,
    destroy,
    worldToScreen,
    getCam: () => cam,
  };
}
