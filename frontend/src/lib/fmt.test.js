// Unit tests for fmt.js — currently the clock formatter added for the
// Utility view's tick display (existing helpers keep their own behavior
// and are covered by the views that use them).
// Run: node --test src/lib/fmt.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtClock,
  tickSeconds,
  fmtDuration,
  fmtInt,
  fmt1,
  fmt2,
  fmtPercent,
  fmtMoney,
  fmtMetric,
  fmtMs,
  normTickRate,
} from './fmt.js';

test('fmtClock renders m:ss with a zero-padded seconds part', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(45), '0:45');
  assert.equal(fmtClock(44.6), '0:45'); // rounds to the nearest second
  assert.equal(fmtClock(59.4), '0:59');
  assert.equal(fmtClock(60), '1:00');
  assert.equal(fmtClock(154), '2:34');
  assert.equal(fmtClock(599), '9:59');
  assert.equal(fmtClock(600), '10:00');
  assert.equal(fmtClock(659), '10:59');
});

test('fmtClock switches to h:mm:ss from one hour on', () => {
  assert.equal(fmtClock(3600), '1:00:00');
  assert.equal(fmtClock(3661), '1:01:01');
  assert.equal(fmtClock(36000), '10:00:00');
  assert.equal(fmtClock(7384), '2:03:04');
});

test('fmtClock rejects non-finite and negative input', () => {
  assert.equal(fmtClock(NaN), '—');
  assert.equal(fmtClock(Infinity), '—');
  assert.equal(fmtClock(-1), '—');
  assert.equal(fmtClock(undefined), '—');
});

test('fmtClock composes with tickSeconds at the match tickrate', () => {
  // 128 tick: 19200 ticks = 150 s → 2:30.
  assert.equal(fmtClock(tickSeconds(19200, 128)), '2:30');
  // Unknown/invalid tickrate falls back to 64 (tickSeconds contract).
  assert.equal(fmtClock(tickSeconds(64, 0)), '0:01');
});

test('existing duration formatting is untouched', () => {
  assert.equal(fmtDuration(35 * 60 + 39), '35m39s');
  assert.equal(fmtDuration(42), '42s');
});

// --- B2 characterization: pre-migration formatter variants -------------------
// Verbatim copies of the inline formatters the views shipped, kept as the
// record of what the consolidation changed (each call site has since
// migrated to the canonical fmt.js exports asserted below): Economy's
// signed money() became fmtMoney, and Match/Builder's fmtMetricValue,
// Utility's flashSec, CompareRounds' inline ms math and the `> 0 ? : 64`
// tick-rate fallback became fmtMetric / fmtMs / normTickRate.
// Run: node --test src/lib/fmt.test.js   (from frontend/)
const group = (n) => n.toLocaleString(); // locale grouping, as the views call it

// Economy.svelte `money()` — the canonical fmtMoney style (signed, rounded).
function economyMoney(v) {
  const n = Math.round(Number(v) || 0);
  return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString();
}

// EconCurve.svelte `money()` — no negative/NaN handling.
function econCurveMoney(v) {
  return '$' + Math.round(v).toLocaleString();
}

// Match.svelte / Builder.svelte `fmtMetricValue()` (byte-identical copies).
function metricValue(v, format) {
  if (!Number.isFinite(v)) return '—';
  switch (format) {
    case 'int':
      return fmtInt(v);
    case 'float1':
      return fmt1(v);
    case 'percent':
      return fmtPercent(v * 100);
    case 'currency':
      return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    default:
      return Number.isInteger(v) ? fmtInt(v) : fmt2(v);
  }
}

// Utility.svelte `flashSec()` / CompareRounds.svelte's inline ms → seconds.
function msVariant(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

// The `> 0 ? : 64` tick-rate fallback shared by fmt.js, replay/engine.js,
// replay/audio.js and Replay.svelte.
function tickRateVariant(v) {
  return Number(v) > 0 ? Number(v) : 64;
}

test('characterization: Economy money() — signed, rounded, grouped', () => {
  assert.equal(economyMoney(0), '$0');
  assert.equal(economyMoney(1234), '$' + group(1234));
  assert.equal(economyMoney(1234.56), '$' + group(1235)); // rounds
  assert.equal(economyMoney(-5), '−$5'); // U+2212 minus, abs value
  assert.equal(economyMoney(-1234.56), '−$' + group(1235));
  assert.equal(economyMoney(NaN), '$0'); // Number(v) || 0
  assert.equal(economyMoney(undefined), '$0');
  assert.equal(economyMoney('42'), '$' + group(42)); // coerced
});

test('characterization: EconCurve money() — "$" + rounded, ASCII minus, NaN', () => {
  assert.equal(econCurveMoney(1234), '$' + group(1234));
  assert.equal(econCurveMoney(1234.56), '$' + group(1235));
  assert.equal(econCurveMoney(-5), '$-5'); // differs from Economy: '$-5'
  assert.equal(econCurveMoney(NaN), '$NaN'); // differs from Economy: '$0'
});

test('characterization: Match/Builder metric currency branch — keeps fractions', () => {
  assert.equal(metricValue(1234.56, 'currency'), '$' + (1234.56).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  assert.equal(metricValue(1234567.891, 'currency'), '$' + (1234567.891).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  assert.equal(metricValue(-5, 'currency'), '$-5'); // ASCII minus, no rounding
  assert.equal(metricValue(NaN, 'currency'), '—'); // the shared finite guard
});

test('characterization: Match/Builder fmtMetricValue format matrix', () => {
  assert.equal(metricValue(1234.56, 'int'), fmtInt(1234.56));
  assert.equal(metricValue(1234.56, 'float1'), fmt1(1234.56));
  assert.equal(metricValue(0.523, 'percent'), fmtPercent(52.3));
  assert.equal(metricValue(12, undefined), fmtInt(12)); // integer default
  assert.equal(metricValue(12.345, undefined), fmt2(12.345)); // float default
  assert.equal(metricValue(NaN, 'int'), '—');
  assert.equal(metricValue(Infinity, 'float1'), '—');
  assert.equal(metricValue('7', 'int'), '—'); // Number.isFinite does NOT coerce
});

test('characterization: ms → "x.xs" (Utility flashSec / CompareRounds)', () => {
  assert.equal(msVariant(1500), '1.5s');
  assert.equal(msVariant(0), '0.0s');
  assert.equal(msVariant(999), '1.0s'); // rounds up
  assert.equal(msVariant(-500), '-0.5s'); // no sign guard
  assert.equal(msVariant(NaN), 'NaNs'); // no finite guard
});

test('characterization: the >0 ? :64 tick-rate fallback', () => {
  assert.equal(tickRateVariant(128), 128);
  assert.equal(tickRateVariant(64), 64);
  assert.equal(tickRateVariant(0), 64);
  assert.equal(tickRateVariant(-1), 64);
  assert.equal(tickRateVariant(null), 64);
  assert.equal(tickRateVariant(undefined), 64);
  assert.equal(tickRateVariant(NaN), 64);
  assert.equal(tickRateVariant('128'), 128); // Number() coercion
});

// --- canonical formatters (B2) ----------------------------------------------
// fmtMoney is Economy's signed style; fmtMetric's currency branch and the
// ms/tick-rate helpers follow it. The divergences the migration removed are
// asserted against the old variants above: EconCurve's "$-5"/"$NaN", the
// currency branch's kept fractions and ASCII minus, and CompareRounds'
// inline ms math.

test('fmtMoney renders the signed, rounded, grouped Economy style', () => {
  assert.equal(fmtMoney(0), '$0');
  assert.equal(fmtMoney(1234), '$' + group(1234));
  assert.equal(fmtMoney(1234.56), '$' + group(1235)); // rounds to whole dollars
  assert.equal(fmtMoney(-5), '−$5'); // U+2212 minus, abs value
  assert.equal(fmtMoney(-1234.56), '−$' + group(1235));
  assert.equal(fmtMoney(NaN), '$0');
  assert.equal(fmtMoney(undefined), '$0');
  assert.equal(fmtMoney('42'), '$' + group(42));
});

test('fmtMetric drives every format tag, currency through fmtMoney', () => {
  assert.equal(fmtMetric(1234.56, 'int'), fmtInt(1234.56));
  assert.equal(fmtMetric(1234.56, 'float1'), fmt1(1234.56));
  assert.equal(fmtMetric(0.523, 'percent'), fmtPercent(52.3));
  assert.equal(fmtMetric(1234.56, 'currency'), fmtMoney(1234.56)); // was '$1,234.56'
  assert.equal(fmtMetric(-5, 'currency'), '−$5'); // was '$-5'
  assert.equal(fmtMetric(12, undefined), fmtInt(12));
  assert.equal(fmtMetric(12.345, undefined), fmt2(12.345));
  assert.equal(fmtMetric(NaN, 'int'), '—');
  assert.equal(fmtMetric(Infinity, 'float1'), '—');
  assert.equal(fmtMetric(NaN, 'currency'), '—');
});

test('fmtMs renders ms as seconds with one decimal', () => {
  assert.equal(fmtMs(1500), '1.5s');
  assert.equal(fmtMs(0), '0.0s');
  assert.equal(fmtMs(999), '1.0s');
  assert.equal(fmtMs(-500), '-0.5s');
  assert.equal(fmtMs(NaN), 'NaNs');
});

test('normTickRate is the shared >0 ? :64 fallback', () => {
  assert.equal(normTickRate(128), 128);
  assert.equal(normTickRate(64), 64);
  assert.equal(normTickRate(0), 64);
  assert.equal(normTickRate(-1), 64);
  assert.equal(normTickRate(null), 64);
  assert.equal(normTickRate(undefined), 64);
  assert.equal(normTickRate(NaN), 64);
  assert.equal(normTickRate('128'), 128);
  assert.equal(tickRateVariant(128), normTickRate(128)); // identical to the copies
  assert.equal(tickRateVariant(0), normTickRate(0));
});
