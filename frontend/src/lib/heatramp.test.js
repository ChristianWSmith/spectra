import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEAT_STOPS,
  DEATH_STOPS,
  intensity,
  signedIntensity,
  rampColor,
  rampCss,
  signedRampCss,
  smoothstepWeight,
  sampleField,
  rampLut,
  renderHeatField,
} from './heatramp.js';

test('stop tables are well-formed and start transparent', () => {
  for (const stops of [HEAT_STOPS, DEATH_STOPS]) {
    assert.ok(stops.length >= 2);
    let prev = -1;
    for (const [t, r, g, b, a] of stops) {
      assert.ok(t > prev && t <= 1, `stop t ${t} ascending in (0,1]`);
      prev = t;
      assert.ok(r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255);
      assert.ok(a >= 0 && a <= 1);
    }
    // The ramp must fade in from nothing (both the plain legend and the
    // shared transparent center of the diverging legend depend on it).
    assert.equal(stops[0][4], 0, 'first stop is fully transparent');
    // …and reach full intensity at the extreme.
    assert.equal(stops[stops.length - 1][4], 1, 'last stop is opaque');
  }
  assert.equal(HEAT_STOPS.length, DEATH_STOPS.length, 'legend symmetry');
});

test('intensity is a clamped sqrt curve', () => {
  assert.equal(intensity(0, 10), 0);
  assert.equal(intensity(-1, 10), 0, 'negative heat is not intensity');
  assert.equal(intensity(5, 0), 0, 'empty grid normalizes to 0');
  assert.equal(intensity(10, 10), 1);
  assert.equal(intensity(100, 10), 1, 'clamps above max');
  // sqrt: a quarter of the max is half the intensity — single samples
  // stay visibly below clusters instead of saturating together.
  assert.equal(intensity(1, 4), 0.5);
  // Monotonic.
  let prev = -1;
  for (let v = 0; v <= 10; v++) {
    const t = intensity(v, 10);
    assert.ok(t >= prev);
    prev = t;
  }
});

test('signedIntensity keeps the sign and applies sqrt to the magnitude', () => {
  assert.equal(signedIntensity(0, 4), 0);
  assert.equal(signedIntensity(4, 4), 1);
  assert.equal(signedIntensity(-4, 4), -1);
  assert.equal(signedIntensity(-1, 4), -0.5, 'deaths side mirrors kills');
  assert.equal(signedIntensity(1, 0), 0, 'empty grid normalizes to 0');
  assert.equal(signedIntensity(100, 4), 1, 'clamps');
  assert.equal(signedIntensity(-100, 4), -1, 'clamps negative');
});

test('rampColor samples bracketing stops and clamps t', () => {
  // Endpoints are the stops themselves.
  assert.deepEqual(rampColor(HEAT_STOPS, 0), [...HEAT_STOPS[0].slice(1)]);
  assert.deepEqual(rampColor(HEAT_STOPS, 1), [...HEAT_STOPS.at(-1).slice(1)]);
  // Out-of-range t clamps instead of extrapolating.
  assert.deepEqual(rampColor(HEAT_STOPS, -3), [...HEAT_STOPS[0].slice(1)]);
  assert.deepEqual(rampColor(HEAT_STOPS, 9), [...HEAT_STOPS.at(-1).slice(1)]);
  // Midpoint between the 0.2 and 0.45 stops lerps every channel.
  const mid = rampColor(HEAT_STOPS, 0.325);
  assert.deepEqual(mid, [(251 + 244) / 2, (172 + 132) / 2, (24 + 30) / 2, (0.32 + 0.66) / 2]);
  // The death ramp is transparent at t=0 (the diverging center).
  assert.equal(rampColor(DEATH_STOPS, 0)[3], 0);
});

test('rampCss renders the stops as a 0..100% legend gradient', () => {
  const css = rampCss(HEAT_STOPS);
  assert.ok(css.startsWith('linear-gradient(90deg, '));
  assert.ok(css.includes('rgba(251, 172, 24, 0) 0.0%'), 'transparent low end');
  assert.ok(css.includes('255, 242, 214, 1) 100.0%'), 'white-hot high end');
  assert.equal(
    (css.match(/rgba\(/g) || []).length,
    HEAT_STOPS.length,
    'one entry per stop',
  );
});

test('signedRampCss lays deaths left of the transparent center', () => {
  const css = signedRampCss(DEATH_STOPS, HEAT_STOPS);
  const entries = css.match(/rgba\([^)]+\) [\d.]+%/g);
  assert.equal(entries.length, DEATH_STOPS.length + HEAT_STOPS.length);
  // Left edge = full deaths extreme; right edge = full kills extreme;
  // both ramps meet transparent at 50%.
  assert.ok(css.startsWith('linear-gradient(90deg, '));
  assert.ok(css.includes('206, 231, 255, 1) 0.0%'), 'deaths extreme at left');
  assert.ok(css.includes('255, 242, 214, 1) 100.0%'), 'kills extreme at right');
  assert.equal(
    (css.match(/ 50\.0%/g) || []).length,
    2,
    'both transparent stops meet at the center',
  );
});

test('smoothstepWeight is the C1 between-centers curve', () => {
  assert.equal(smoothstepWeight(0), 0);
  assert.equal(smoothstepWeight(1), 1);
  assert.equal(smoothstepWeight(0.5), 0.5, 'symmetric midpoint');
  // Flatter than linear near the ends (the kink-free approach to each
  // cell center) and symmetric: s(f) = 1 − s(1−f).
  assert.equal(smoothstepWeight(0.25), 0.15625);
  assert.equal(smoothstepWeight(0.75), 1 - 0.15625);
  // Zero slope at both ends — bilinear's slope kink at each center is
  // what produced the diamond lattice under magnification.
  const e = 1e-6;
  assert.ok(smoothstepWeight(e) < 1e-5, 'flat at 0');
  assert.ok(1 - smoothstepWeight(1 - e) < 1e-5, 'flat at 1');
});

test('sampleField reads cell centers exactly and interpolates between them', () => {
  const cells = [0, 1]; // w=2, h=1 — cell centers at u = 0.5, 1.5
  assert.equal(sampleField(cells, 2, 1, 0.5, 0.5), 0, 'center of cell 0');
  assert.equal(sampleField(cells, 2, 1, 1.5, 0.5), 1, 'center of cell 1');
  assert.equal(sampleField(cells, 2, 1, 1.0, 0.5), 0.5, 'midpoint = average');
  assert.equal(
    sampleField(cells, 2, 1, 0.75, 0.5),
    smoothstepWeight(0.25),
    'between centers: smoothstep weight, not plain linear',
  );
  // Edge extension past the outer centers (no phantom cells).
  assert.equal(sampleField(cells, 2, 1, 0, 0.5), 0);
  assert.equal(sampleField(cells, 2, 1, 2, 0.5), 1);
  // v runs row-first: row 0 (grid.minY) at v = 0.5 for h = 2.
  assert.equal(sampleField([10, 20], 1, 2, 0.5, 0.5), 10);
  assert.equal(sampleField([10, 20], 1, 2, 0.5, 1.5), 20);
});

test('sampleField interpolates a signed field through zero', () => {
  const cells = [1, -1];
  // Exact zero at the midpoint: the sign is decided per sample of the
  // interpolated VALUE, so the kd renderer fades to transparent at the
  // crossing instead of blending amber into blue.
  assert.equal(sampleField(cells, 2, 1, 1.0, 0.5), 0);
  assert.ok(sampleField(cells, 2, 1, 0.75, 0.5) > 0);
  assert.ok(sampleField(cells, 2, 1, 1.25, 0.5) < 0);
});

test('rampLut reproduces rampColor within one byte', () => {
  const n = 256;
  for (const stops of [HEAT_STOPS, DEATH_STOPS]) {
    const lut = rampLut(stops, n);
    assert.equal(lut.length, n * 4);
    for (let i = 0; i < n; i++) {
      const [r, g, b, a] = rampColor(stops, i / (n - 1));
      assert.ok(Math.abs(lut[i * 4] - r) <= 1, `red @${i}`);
      assert.ok(Math.abs(lut[i * 4 + 1] - g) <= 1, `green @${i}`);
      assert.ok(Math.abs(lut[i * 4 + 2] - b) <= 1, `blue @${i}`);
      assert.ok(Math.abs(lut[i * 4 + 3] - a * 255) <= 1, `alpha @${i}`);
    }
    // Ends are exact: transparent first stop, opaque last stop.
    assert.equal(lut[3], 0, 'first stop transparent');
    assert.equal(lut[n * 4 - 1], 255, 'last stop opaque');
  }
});

test('renderHeatField resolves colors per output pixel and flips row 0 to the bottom', () => {
  // cells row 0 (minY) = [0,0], row 1 = [0,1] — the hot cell sits at
  // (row 1, col 1) = top-right of image space once row 0 lands at the
  // bottom.
  const out = renderHeatField([0, 0, 0, 1], 2, 2, 1, false, 4, 4);
  assert.equal(out.length, 4 * 4 * 4);
  const px = (x, y) => out.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
  // Top-right = the hot cell at the ramp's end (white-hot, opaque).
  assert.deepEqual([...px(3, 0)], [255, 242, 214, 255]);
  // Bottom-right would be row 0, col 1 (zero) if the rows were NOT
  // flipped — transparent.
  assert.equal(px(3, 3)[3], 0, 'row 0 rendered at the bottom');
  assert.equal(px(0, 3)[3], 0, 'zero cells stay transparent');
  // Resolution: pixels BETWEEN cell centers take interpolated values, so
  // a 2-cell row at 16 px yields many distinct alphas — flat cell
  // coloring would give exactly two.
  const row = renderHeatField([0, 1], 2, 1, 1, false, 16, 1);
  const alphas = [];
  for (let i = 3; i < row.length; i += 4) alphas.push(row[i]);
  assert.equal(alphas[0], 0, 'edge extends cell 0 (zero)');
  assert.equal(alphas.at(-1), 255, 'edge extends cell 1 (max)');
  let prev = -1;
  for (const a of alphas) {
    assert.ok(a >= prev, 'alpha non-decreasing along the ramp');
    prev = a;
  }
  assert.ok(
    new Set(alphas).size >= 8,
    `want per-pixel alpha steps, got ${new Set(alphas).size} distinct`,
  );
});

test('renderHeatField renders the signed kd kind per pixel: white-hot kills, icy deaths, transparent at zero', () => {
  // 2 cells [kills, deaths] at max 1 → outW 3 puts the middle pixel
  // exactly on the zero crossing (u = 1.0 = the midpoint).
  const out = renderHeatField([1, -1], 2, 1, 1, true, 3, 1);
  assert.deepEqual([...out.subarray(0, 4)], [255, 242, 214, 255], 'kills side');
  assert.equal(out[7], 0, 'zero crossing fully transparent (no sign bleed)');
  assert.deepEqual([...out.subarray(8, 12)], [206, 231, 255, 255], 'deaths side');
});

test('renderHeatField with no signal is fully transparent', () => {
  const out = renderHeatField([0, 0, 0, 0], 2, 2, 0, false, 8, 8);
  assert.equal(out.length, 8 * 8 * 4);
  for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 0);
});
