// Heatmap rendering math for the canvas overlay (HeatmapLayer) and its
// legend (Heatmaps paints the .heat-ramp gradient from the same stops
// via rampCss/signedRampCss, so the legend can never drift from the
// renderer): the ONE stop table, the intensity curves, and the
// field→pixels raster pass (renderHeatField).
//
// Intensity curve: t = sqrt(v / max) — nonlinear, so a lone sample
// stays faint while clusters read clearly hotter. The signed kd kind
// maps t = sign(v)·sqrt(|v| / maxAbs): positive (kills) rides
// HEAT_STOPS, negative (deaths) rides DEATH_STOPS, zero transparent.
//
// Rendering model: cells are VALUES; color is resolved per OUTPUT pixel
// (sampleField → intensity → ramp LUT). Coloring cells and letting the
// browser interpolate RGBA instead would break the √ curve, band the
// 8-bit alpha per cell, and bleed the two kd ramps across zero.

// Stop = [t, r, g, b, a], ascending in t ∈ [0..1]. Colors: transparent
// amber → amber (fbac18, the app's existing heat hue) → red (e05b5b) →
// white-hot core.
export const HEAT_STOPS = [
  [0.0, 251, 172, 24, 0],
  [0.2, 251, 172, 24, 0.32],
  [0.45, 244, 132, 30, 0.66],
  [0.7, 224, 91, 91, 0.92],
  [1.0, 255, 242, 214, 1],
];

// Deaths side of the signed kd ramp (magnitude 0..1): transparent →
// blue → icy white — the mirror of HEAT_STOPS' white-hot core.
export const DEATH_STOPS = [
  [0.0, 130, 180, 255, 0],
  [0.2, 120, 172, 255, 0.3],
  [0.45, 86, 144, 255, 0.62],
  [0.7, 56, 112, 246, 0.9],
  [1.0, 206, 231, 255, 1],
];

// intensity maps a non-negative value onto 0..1 (sqrt curve; anything
// without a positive max normalizes to 0 — an empty grid paints
// nothing).
export function intensity(v, max) {
  if (!(max > 0) || !(v > 0)) return 0;
  const t = Math.sqrt(v / max);
  return t > 1 ? 1 : t;
}

// signedIntensity maps a signed value onto −1..1 (sqrt on the
// magnitude); the sign selects the ramp in the renderer.
export function signedIntensity(v, maxAbs) {
  if (!(maxAbs > 0) || v === 0) return 0;
  const t = Math.sqrt(Math.abs(v) / maxAbs);
  const m = t > 1 ? 1 : t;
  return v > 0 ? m : -m;
}

// rampColor samples the stop table at t ∈ [0..1] → [r, g, b, a]
// (linear interpolation inside the bracketing stops; t clamps).
export function rampColor(stops, t) {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < x) i++;
  const a = stops[i - 1];
  const b = stops[i];
  const span = b[0] - a[0];
  const f = span > 0 ? (x - a[0]) / span : 0;
  return [
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
    a[3] + (b[3] - a[3]) * f,
    a[4] + (b[4] - a[4]) * f,
  ];
}

// rampCss renders the stop table as the legend's CSS gradient (set as
// the inline background of .heat-ramp — the stylesheet's static
// gradient is only the fallback).
export function rampCss(stops) {
  const parts = stops.map(
    ([t, r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${a}) ${(t * 100).toFixed(1)}%`,
  );
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

// signedRampCss is the diverging legend gradient: negStops (death
// magnitudes) laid out right-to-left across the −1..0 half, posStops
// across 0..+1, transparent at the shared center.
export function signedRampCss(negStops, posStops) {
  const neg = [...negStops]
    .reverse()
    .map(
      ([m, r, g, b, a]) =>
        `rgba(${r}, ${g}, ${b}, ${a}) ${(((1 - m) / 2) * 100).toFixed(1)}%`,
    );
  const pos = posStops.map(
    ([t, r, g, b, a]) =>
      `rgba(${r}, ${g}, ${b}, ${a}) ${(((1 + t) / 2) * 100).toFixed(1)}%`,
  );
  return `linear-gradient(90deg, ${[...neg, ...pos].join(', ')})`;
}

// --- Field → pixels (the canvas overlay's raster pass) --------------------

// smoothstepWeight is the interpolation curve between cell centers:
// f²(3−2f) — flat (zero slope) at both ends, so the interpolated field
// is C1 across every cell center. Plain bilinear leaves a slope kink at
// each center, which at the overlay's magnification reads as a diamond
// lattice over the blob ("pixelated").
export function smoothstepWeight(f) {
  return f * f * (3 - 2 * f);
}

// clampIndex clamps a neighbour index to [0, n−1] (edge extension).
function clampIndex(i, n) {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

// axisSpan is the ONE interpolation rule for an output position along a
// single cell-space axis: the pair of cells it reads (edge-extended past
// the outer centers) and the smoothstep weight between them. sampleField
// (a point) and renderHeatField (a whole raster, planned once per
// row/column) both go through it, so the raster cannot drift from the
// point sampler.
export function axisSpan(n, pos) {
  const c = pos - 0.5;
  const i = Math.floor(c);
  return { a: clampIndex(i, n), b: clampIndex(i + 1, n), f: smoothstepWeight(c - i) };
}

// sampleField bilinearly interpolates the cell field at (u, v) in cell
// space: u ∈ [0..w] across, v ∈ [0..h] down with row 0 (grid.minY)
// FIRST; cell (r,c) is centered at (c+0.5, r+0.5). Weights between
// centers are smoothstepWeight (see above); past the outer centers the
// edge value extends. The signed kd field is sampled as raw values, so
// a zero crossing interpolates through exactly 0 (transparent) instead
// of blending the two ramps' colors — no sign artifact at zero.
export function sampleField(cells, w, h, u, v) {
  const col = axisSpan(w, u);
  const row = axisSpan(h, v);
  const r0 = row.a * w;
  const r1 = row.b * w;
  const top = cells[r0 + col.a] + (cells[r0 + col.b] - cells[r0 + col.a]) * col.f;
  const bot = cells[r1 + col.a] + (cells[r1 + col.b] - cells[r1 + col.a]) * col.f;
  return top + (bot - top) * row.f;
}

// rampLut samples a stop table into a flat RGBA byte table (n entries)
// so the per-pixel pass pays one index instead of the stop walk. Byte
// rounding is the output buffer's own precision, so the LUT adds no
// visible error; t=0 and t=1 land exactly on the end stops.
export function rampLut(stops, n = 512) {
  const lut = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = rampColor(stops, i / (n - 1));
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = a * 255;
  }
  return lut;
}

// renderHeatField rasterizes the grid to an outW×outH RGBA buffer — one
// output pixel per device pixel of the grid's world-bounds rect. Each
// pixel samples the field at its center (axisSpan, planned once per
// row/column), maps the value through the intensity curve (sqrt, signed
// for the kd kind), and looks the ramp up in its LUT: color and alpha
// follow the value curve at every pixel, never banded per cell.
// Row 0 (grid.minY) lands at the BOTTOM of the buffer (image space
// flips Y). max is the normalization radius (g.max: |v|max for the
// signed kd kind); a zero/absent max yields a fully transparent buffer.
export function renderHeatField(cells, w, h, max, signed, outW, outH) {
  const ow = Math.max(0, outW | 0);
  const oh = Math.max(0, outH | 0);
  const out = new Uint8ClampedArray(ow * oh * 4);
  if (!(max > 0) || ow === 0 || oh === 0) return out;
  const pos = rampLut(HEAT_STOPS);
  const neg = signed ? rampLut(DEATH_STOPS) : null;
  const last = pos.length / 4 - 1;
  // Binding grids arrive as plain Arrays; the inner loop reads them as
  // Float64Array. Both axis plans are built through axisSpan (the ONE
  // interpolation rule), flattened to typed arrays for the hot loop.
  const src = cells instanceof Float64Array ? cells : Float64Array.from(cells);
  const colA = new Int32Array(ow);
  const colB = new Int32Array(ow);
  const colF = new Float64Array(ow);
  for (let x = 0; x < ow; x++) {
    const s = axisSpan(w, ((x + 0.5) * w) / ow);
    colA[x] = s.a;
    colB[x] = s.b;
    colF[x] = s.f;
  }
  const rowA = new Int32Array(oh);
  const rowB = new Int32Array(oh);
  const rowF = new Float64Array(oh);
  for (let y = 0; y < oh; y++) {
    const s = axisSpan(h, ((oh - y - 0.5) * h) / oh);
    rowA[y] = s.a;
    rowB[y] = s.b;
    rowF[y] = s.f;
  }
  for (let y = 0; y < oh; y++) {
    const r0 = rowA[y] * w;
    const r1 = rowB[y] * w;
    const fv = rowF[y];
    const base = y * ow * 4;
    for (let x = 0; x < ow; x++) {
      const ca = colA[x];
      const cb = colB[x];
      const fu = colF[x];
      const t00 = src[r0 + ca];
      const t01 = src[r0 + cb];
      const t10 = src[r1 + ca];
      const t11 = src[r1 + cb];
      const top = t00 + (t01 - t00) * fu;
      const bot = t10 + (t11 - t10) * fu;
      const val = top + (bot - top) * fv;
      const t = signed ? signedIntensity(val, max) : intensity(val, max);
      const lut = t < 0 && neg ? neg : pos;
      const idx = Math.round(Math.abs(t) * last) * 4;
      const o = base + x * 4;
      out[o] = lut[idx];
      out[o + 1] = lut[idx + 1];
      out[o + 2] = lut[idx + 2];
      out[o + 3] = lut[idx + 3];
    }
  }
  return out;
}
