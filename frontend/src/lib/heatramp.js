// Heatmap density→color ramps — the ONE stop table for the heatmap
// canvas overlay (HeatmapLayer) and its legend (Heatmaps paints the
// .heat-ramp gradient from the same stops via rampCss/signedRampCss, so
// the legend can never drift from the renderer).
//
// Intensity curve: t = sqrt(v / max) — nonlinear, so a lone sample
// stays faint while clusters read clearly hotter (the old log-ish curve
// multiplied into a flat alpha that saturated by t≈0.67, which flattened
// every hotspot to one color). The signed kd kind maps
// t = sign(v)·sqrt(|v| / maxAbs): positive (kills) rides HEAT_STOPS,
// negative (deaths) rides DEATH_STOPS, zero stays transparent.

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
