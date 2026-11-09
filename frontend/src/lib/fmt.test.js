// Unit tests for fmt.js — currently the clock formatter added for the
// Utility view's tick display (existing helpers keep their own behavior
// and are covered by the views that use them).
// Run: node --test src/lib/fmt.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtClock,
  parseClock,
  tickSeconds,
  fmtDuration,
  fmtInt,
  fmt1,
  fmt2,
  fmtPercent,
  fmtMoney,
  fmtMetric,
  fmtMs,
  fmtDate,
  normTickRate,
  chatClock,
  chatTag,
  chatLine,
  roundClock,
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

test('parseClock reads back exactly what fmtClock renders (round trip)', () => {
  // THE inverse: every canonical clock string parses to the seconds it
  // was formatted from, so a time input re-rendering after a parse can
  // never drift (the loop popover's frame↔time round trip).
  for (const s of [
    '0:00', '0:45', '1:00', '2:34', '9:59', '10:00', '10:59',
    '59:59', '1:00:00', '1:02:03', '10:00:00', '2:03:04', '100:00:00',
  ]) {
    assert.equal(fmtClock(parseClock(s)), s, s);
  }
  // …and at scale, over every whole second fmtClock's shapes cover.
  for (const sec of [0, 1, 59, 60, 61, 3599, 3600, 3661, 7384, 36000]) {
    assert.equal(fmtClock(parseClock(fmtClock(sec))), fmtClock(sec), String(sec));
  }
  // Bare seconds are the shorthand a text field naturally holds.
  assert.equal(parseClock('90'), 90);
  assert.equal(parseClock(' 64 '), 64); // surrounding whitespace is not garbage
  assert.equal(parseClock('01:05'), 65);
  assert.equal(fmtClock(parseClock('01:05')), '1:05'); // padded input re-displays canonically
  assert.equal(parseClock('1:02:03'), 3723);
  // A non-canonical but unambiguous entry still parses and re-displays
  // canonically ("75:30" → 4530 s → "1:15:30").
  assert.equal(fmtClock(parseClock('75:30')), '1:15:30');
});

test('parseClock rejects everything fmtClock would never have produced', () => {
  for (const bad of [
    '', '   ', 'abc', '1:60', '1:00:60', '1:2:3:4', '-1:00', '1.5', '1:5.5',
    'NaN', '—',
    null, undefined, 90, NaN, Infinity,
  ]) {
    assert.ok(Number.isNaN(parseClock(bad)), String(bad));
  }
});

test('existing duration formatting is untouched', () => {
  assert.equal(fmtDuration(35 * 60 + 39), '35m39s');
  assert.equal(fmtDuration(42), '42s');
});

// --- B2 characterization: inline formatter variants -----------------------
// Verbatim copies of the inline formatters the views shipped, pinned
// against the canonical exports asserted below: the signed, rounded money
// style ↔ fmtMoney, the metric format-matrix style ↔ fmtMetric, the
// "x.xs" ms style ↔ fmtMs, and the `> 0 ? : 64` tick-rate rule ↔
// normTickRate.
// Run: node --test src/lib/fmt.test.js   (from frontend/)
const group = (n) => n.toLocaleString(); // locale grouping, as the views call it

// The signed, rounded money style — the canonical fmtMoney format.
function economyMoney(v) {
  const n = Math.round(Number(v) || 0);
  return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString();
}

// The "$" + rounded money style — no negative/NaN handling.
function econCurveMoney(v) {
  return '$' + Math.round(v).toLocaleString();
}

// The metric format-matrix style (int / float1 / percent / currency).
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

// The "x.xs" ms → seconds style.
function msVariant(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

// The `> 0 ? : 64` tick-rate rule — normTickRate's home.
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
// ms/tick-rate helpers follow it. The divergences from the inline variants
// above are asserted here: EconCurve's "$-5"/"$NaN", the currency
// branch's kept fractions and ASCII minus, and CompareRounds' inline ms
// math.

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
  assert.equal(fmtMetric(1234.56, 'currency'), fmtMoney(1234.56));
  assert.equal(fmtMetric(-5, 'currency'), '−$5');
  assert.equal(fmtMetric(12, undefined), fmtInt(12));
  assert.equal(fmtMetric(12.345, undefined), fmt2(12.345));
  assert.equal(fmtMetric(NaN, 'int'), '—');
  assert.equal(fmtMetric(Infinity, 'float1'), '—');
  assert.equal(fmtMetric(NaN, 'currency'), '—');
});

test('fmtPercent renders an already-0..100 value (the read-DTO percent scale)', () => {
  // The contract every *Pct/*Rate read field follows (KASTPct,
  // DMGConvPct, EntryRate/TradeRate, profile WinPct/OpeningRate/…): the
  // input is already a percent. fmtPercent does NOT scale fractions —
  // 0.05 renders "0.1%", never "5%" — which is why a 0..1 rate passed
  // here (the Combat tab's Entry%/Trade% regression) shows near-zero.
  assert.equal(fmtPercent(52.3), '52.3%');
  assert.equal(fmtPercent(0), '0%');
  assert.equal(fmtPercent(30.4348), '30.4%');
  assert.equal(fmtPercent(0.05), '0.1%'); // unscaled fraction, by design
  assert.equal(fmtPercent(NaN), '—');
  assert.equal(fmtPercent(undefined), '—');
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
  assert.equal(tickRateVariant(128), normTickRate(128)); // identical to the variant above
  assert.equal(tickRateVariant(0), normTickRate(0));
});

// --- round-relative clocks (chatClock / roundClock) -----------------------
// Both go through the one round-relative arithmetic (intoRoundSeconds):
// (tick − round.startTick) at the match rate with the match-relative
// fallback — never a negative readout. The chat clock is pinned here as
// characterization (its cells render in the Replay feed and RoundDetail);
// roundClock is the Utility rows' round-relative time (the row time is
// into THAT round, not into the overall game).

const ROUND_MAP = new Map([
  [-1, { number: -1, startTick: 400 }], // warmup — not counted play
  [1, { number: 1, startTick: 1200 }],
  [7, { number: 7, startTick: 24500 }],
  [9, { number: 9 }], // row without a startTick
]);

test('chatClock: "R{n} m:ss" — time into a counted round', () => {
  // 64 tick: (6960 − 1200) = 5760 ticks = 90 s into round 1.
  assert.equal(chatClock({ round: 1, tick: 6960 }, ROUND_MAP, 64), 'R1 1:30');
  // Unknown tickrate falls back to 64 (tickSeconds contract).
  assert.equal(chatClock({ round: 7, tick: 24500 + 64 * 61 }, ROUND_MAP, 0), 'R7 1:01');
});

test('chatClock: falls back to the match-relative clock (never negative)', () => {
  // No containing round → plain match clock: 6960 / 64 = 108.75 → 1:49.
  assert.equal(chatClock({ round: 5, tick: 6960 }, ROUND_MAP, 64), '1:49');
  // Counted-out round (warmup, lib/rounds.js isCounted): 1040 / 64 → 0:16.
  assert.equal(chatClock({ round: -1, tick: 1040 }, ROUND_MAP, 64), '0:16');
  // Tick before the round's start → negative offset → match clock.
  assert.equal(chatClock({ round: 7, tick: 1000 }, ROUND_MAP, 64), '0:16');
  // A round row without a startTick (NaN offset) → match clock.
  assert.equal(chatClock({ round: 9, tick: 640 }, ROUND_MAP, 64), '0:10');
  // Missing round lookup entirely.
  assert.equal(chatClock({ round: 1, tick: 6960 }, undefined, 64), '1:49');
});

// --- chat tags / lines (chatTag / chatLine) --------------------------------
// THE chat display rule, pinned by the owner's semantics: the bracket is
// a CHANNEL tag for all chat and a SIDE tag for team chat.
//   all  → [ALL] regardless of who spoke;
//   team → the SPEAKER'S SIDE at that round: [T] = Terrorist, [CT] = CT.
// System/unknown channel or an unresolved side → NO bracket (never guess).

test('chatTag: all chat reads [ALL] for both sides', () => {
  assert.equal(chatTag('all', 'ct'), '[ALL]'); // a CT speaking in ALL chat
  assert.equal(chatTag('all', 't'), '[ALL]'); // a T speaking in ALL chat
  assert.equal(chatTag('all', ''), '[ALL]'); // side not even needed
});

test('chatTag: team chat tags the SPEAKER\'S SIDE — [CT] for a CT, [T] for a T', () => {
  assert.equal(chatTag('team', 'ct'), '[CT]'); // CT in team chat → [CT]
  assert.equal(chatTag('team', 't'), '[T]'); // T in team chat → [T]
  // Case-insensitive on the side value, but the SPELLING is uppercase.
  assert.equal(chatTag('team', 'T'), '[T]');
  assert.equal(chatTag('team', 'CT'), '[CT]');
});

test('chatTag: system/unknown channel or unresolved side → no bracket', () => {
  assert.equal(chatTag('', 'ct'), ''); // system row — plain, no bracket
  assert.equal(chatTag('team', ''), ''); // team chat, side unknown → NEVER guess
  assert.equal(chatTag('team', null), '');
  assert.equal(chatTag('saytext', 't'), ''); // unknown channel
  assert.equal(chatTag(undefined, undefined), '');
});

test('chatLine: composes name + tag + ": " + text (THE display rule)', () => {
  assert.equal(chatLine('donk666', 'all', 'ct', 'lol'), 'donk666 [ALL]: lol');
  assert.equal(chatLine('donk666', 'all', 't', 'lol'), 'donk666 [ALL]: lol');
  assert.equal(chatLine('donk666', 'team', 't', 'lol'), 'donk666 [T]: lol');
  assert.equal(chatLine('donk666', 'team', 'ct', 'lol'), 'donk666 [CT]: lol');
  // Unresolved team side → the line still reads, bracket-less.
  assert.equal(chatLine('donk666', 'team', '', 'lol'), 'donk666: lol');
  // System row (no name, no channel) → plain text — no bracket, no colon.
  assert.equal(chatLine('', '', '', 'Match is live'), 'Match is live');
});

test('roundClock: renders time into the given round', () => {
  // 64 tick: (6960 − 1200) / 64 = 90 s → 1:30 — NOT the match clock.
  assert.equal(roundClock(6960, { number: 1, startTick: 1200 }, 64), '1:30');
  assert.equal(roundClock(24500 + 64 * 30, ROUND_MAP.get(7), 64), '0:30');
  // Unknown tickrate falls back to 64: (2020 − 100) / 64 = 30 s.
  assert.equal(roundClock(2020, { number: 1, startTick: 100 }, 0), '0:30');
  // A round starting at tick 0 is still a valid start.
  assert.equal(roundClock(320, { number: 1, startTick: 0 }, 64), '0:05');
});

test('roundClock: unknown round / negative offset → match-relative, never negative', () => {
  assert.equal(roundClock(6960, null, 64), '1:49'); // rounds data missing
  assert.equal(roundClock(6960, undefined, 64), '1:49');
  assert.equal(roundClock(1000, { number: 7, startTick: 24500 }, 64), '0:16');
  assert.equal(roundClock(NaN, { number: 1, startTick: 1200 }, 64), '—');
});

// --- fmtDate (the Library "Extracted" column / match Details) --------------
// matches.extracted_at is NULL until SaveExtracted writes it (status
// ready), and store.nullTime turns that NULL into the Go zero time.Time,
// which JSON serializes as "0001-01-01T00:00:00Z". A queued/parsing/failed
// row therefore carries that value — fmtDate must render the placeholder
// rather than a year-0001 "extraction time".
test('fmtDate: the never-extracted zero timestamp renders the placeholder', () => {
  assert.equal(fmtDate('0001-01-01T00:00:00Z'), '—');
  assert.equal(fmtDate('0001-01-01T00:00:00+00:00'), '—');
  assert.equal(fmtDate(new Date('0001-01-01T00:00:00Z')), '—');
  assert.equal(fmtDate(undefined), '—'); // missing value, same placeholder
  assert.equal(fmtDate('not a date'), '—'); // unparseable input
});

test('fmtDate renders a stamped extraction time as a locale date-time', () => {
  // Mid-year UTC: no timezone offset can roll the year back.
  const out = fmtDate('2026-06-15T12:00:00Z');
  assert.notEqual(out, '—');
  assert.match(out, /2026/);
  assert.notEqual(fmtDate(new Date('2026-06-15T09:30:00Z')), '—');
});
