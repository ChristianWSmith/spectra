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
