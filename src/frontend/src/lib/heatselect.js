// heatselect.js — THE pure selection math for the heatmap map's rubber-band
// drag (HeatmapLayer): client px → image space → world, the bare-click
// threshold, the drag box's normalisation/clamping and its intersection with
// the raster grid. No DOM, no component state — unit-tested by
// heatselect.test.js; HeatmapLayer keeps only the pointer plumbing.
//
// Every client→world mapping goes through the SAME formula the single-click
// path always used (ix = (clientX − rect.left) / rect.width · W, then
// `baseTf.toWorld`), so a drag box and a click land in one coordinate space:
// one formula, never two.

// A pointer gesture that never moves this many px in EITHER axis is a click,
// not a drag: a rubber band this small is a mis-aimed click, and the cell
// behaviour is what the user meant. The boundary is inclusive — a 4px move
// crosses it (pinned in heatselect.test.js and the DOM driver).
export const DRAG_THRESHOLD_PX = 4;

// isBareClick — Chebyshev distance under the threshold: movement is judged
// per axis (a fast horizontal swipe with jitter stays a drag; a 3px nudge
// stays a click) rather than by Euclidean length, which would let one large
// axis hide behind a small one only after squaring.
export function isBareClick(x0, y0, x1, y1, threshold = DRAG_THRESHOLD_PX) {
  return Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) < threshold;
}

// clientToWorld — THE one client px → world mapping. The rect is the canvas'
// (a layout rect, so it may sit anywhere and be any size); W/H are the image
// space of the LIVE floor. Returns null when either input cannot produce a
// coordinate — never a guessed point.
export function clientToWorld(tf, rect, clientX, clientY, W, H) {
  if (!tf || !rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  if (!(W > 0) || !(H > 0)) return null;
  const ix = ((clientX - rect.left) / rect.width) * W;
  const iy = ((clientY - rect.top) / rect.height) * H;
  return tf.toWorld(ix, iy);
}

// dragWorldBox — the gesture's two corners → a normalised world rect. Y is
// FLIPPED between screen and world (toWorld: y = posY − py·scale), so the
// top-left corner of the gesture is the MAXIMUM world y: taking min/max over
// both corners is what normalises the flip, with no sign juggling at the
// call site. Null when either corner cannot be mapped.
export function dragWorldBox(tf, rect, W, H, x0, y0, x1, y1) {
  const a = clientToWorld(tf, rect, x0, y0, W, H);
  const b = clientToWorld(tf, rect, x1, y1, W, H);
  if (!a || !b) return null;
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

// intersectGrid — the drag box clipped to the raster's world bounds; null
// when it NEVER reaches the raster. "Reaches" is deliberately generous: a
// zero-extent clip (a perfectly straight drag, or a box resting exactly on
// an edge) still counts, because the gesture does touch the data and the
// view's pad expansion turns the line into a real region — falling back
// there would ignore a 500px gesture to drill one cell. Null therefore means
// exactly one thing: the gesture missed the raster entirely, and the caller
// falls back to the anchor's own cell — a selection over no data drills
// where it started, never an invented region and never a silent no-op.
export function intersectGrid(grid, box) {
  if (!grid || !box) return null;
  const minX = Math.max(box.minX, grid.minX);
  const minY = Math.max(box.minY, grid.minY);
  const maxX = Math.min(box.maxX, grid.maxX);
  const maxY = Math.min(box.maxY, grid.maxY);
  if (!(minX <= maxX) || !(minY <= maxY)) return null;
  return { minX, minY, maxX, maxY };
}

// overlayRect — the gesture in CSS px RELATIVE TO THE RECT'S ORIGIN, clamped
// inside it: the overlay is positioned against the canvas it is drawn over,
// and must never spill past the map's edge (the wrapper clips anyway — the
// clamp keeps the numbers honest rather than relying on overflow). Output is
// always a non-negative width/height, so a reversed drag (right-to-left) is
// indistinguishable from its mirror.
export function overlayRect(x0, y0, x1, y1, rect) {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const cl = clamp(Math.min(x0, x1), rect.left, right);
  const cr = clamp(Math.max(x0, x1), rect.left, right);
  const ct = clamp(Math.min(y0, y1), rect.top, bottom);
  const cb = clamp(Math.max(y0, y1), rect.top, bottom);
  return { left: cl - rect.left, top: ct - rect.top, width: cr - cl, height: cb - ct };
}

// cellAt — the grid cell CONTAINING a world point: the click path's math,
// kept verbatim (row-major, row 0 at grid.minY — heatramp's convention).
// A point OUTSIDE the grid still yields its (out-of-range) cell box with
// value undefined — a missing read, never a fabricated 0 (the kd sign rule
// reads missing as "no signal"). Null only when the grid or point cannot
// produce a cell at all.
export function cellAt(grid, world) {
  if (!grid || !world || !grid.w || !grid.h) return null;
  const cw = (grid.maxX - grid.minX) / grid.w;
  const ch = (grid.maxY - grid.minY) / grid.h;
  if (!(cw > 0) || !(ch > 0)) return null;
  const ci = Math.floor((world.x - grid.minX) / cw);
  const ri = Math.floor((world.y - grid.minY) / ch);
  const inGrid = ci >= 0 && ci < grid.w && ri >= 0 && ri < grid.h;
  return {
    bbox: {
      minX: grid.minX + ci * cw,
      minY: grid.minY + ri * ch,
      maxX: grid.minX + (ci + 1) * cw,
      maxY: grid.minY + (ri + 1) * ch,
    },
    value: inGrid ? grid.cells[ri * grid.w + ci] : undefined,
    inGrid,
  };
}
