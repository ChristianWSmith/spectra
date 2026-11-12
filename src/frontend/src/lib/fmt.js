// Formatting helpers for the M1 views. Pure functions — no services.
import { isCounted } from './rounds.js';

// intoRoundSeconds is THE round-relative time arithmetic: seconds from
// the round's start tick to `tick` at the match rate — null when the
// round is unknown or the tick precedes its start (callers fall back to
// the match-relative clock, never a negative readout). Shared by
// chatClock below and roundClock, so the two clocks stay one rule.
function intoRoundSeconds(tick, round, tickRate) {
  if (!round) return null;
  const into = tickSeconds(tick - round.startTick, tickRate);
  return into >= 0 ? into : null;
}

// chatClock renders a chat line's time cell: "RD12 1:23" — how far INTO
// its round the message was said, rendered with fmtClock. Messages with
// no containing round, in a counted-out round (knife/warmup —
// lib/rounds.js) or with a negative offset fall back to a match-relative
// clock (tick / tickRate) — plain "m:ss", never a negative; keep it
// simple. The raw tick stays in the cell's title tooltip. This is THE
// chat clock (the Replay feed's chat rows and RoundDetail's round chat
// both render it).
export function chatClock(c, roundByNumber, tickRate) {
  const r = (roundByNumber || new Map()).get(c.round);
  if (r && isCounted(r)) {
    const into = intoRoundSeconds(c.tick, r, tickRate);
    // Round prefix is spelled RD everywhere (owner: "standardize round
    // spelling everywhere as RD") — RD12, never R12.
    if (into != null) return `RD${r.number} ${fmtClock(into)}`;
  }
  return fmtClock(tickSeconds(c.tick, tickRate));
}

// chatTag renders the bracket tag of one chat message — the CHANNEL tag
// for all chat and the SIDE tag for team chat:
//
//   channel 'all'  → '[ALL]' — regardless of who spoke
//   channel 'team' → '[T]' or '[CT]' — the SPEAKER'S SIDE at that round:
//                    [T] = Terrorist, [CT] = Counter-Terrorist. A CT
//                    writing in team chat renders `name [CT]: message`.
//   system rows / an unknown channel, or a team-chat side that cannot be
//                    resolved → '' — NO bracket, never a guessed side.
//
// [T]/[CT] are the speaker's SIDE (Terrorist/CT), not "team" — shown only
// for team chat; all chat always reads [ALL]. This and chatLine below are
// THE chat display rule every surface renders through (the DOM surfaces
// that link the name compose <ProfileLink> + chatTag + ': ' + text, so
// the link survives and the line reads identically).
export function chatTag(channel, side) {
  if (channel === 'all') return '[ALL]';
  if (channel === 'team') {
    const s = String(side || '').toLowerCase();
    if (s === 'ct') return '[CT]';
    if (s === 't') return '[T]';
  }
  return '';
}

// chatLine composes the full chat line — THE one display rule:
// `<name> [<tag>]: <text>` (e.g. `donk666 [T]: lol`, `donk666 [ALL]: lol`).
// A nameless/system row (no name and no tag) is plain text — no bracket,
// no leading colon. The feed export (CSV/JSON `label`) precomposes through
// this so exported rows read exactly like the UI.
export function chatLine(name, channel, side, text) {
  const head = [name, chatTag(channel, side)].filter(Boolean).join(' ');
  if (!head) return text ?? '';
  return `${head}: ${text ?? ''}`;
}

// roundClock renders a tick as time INTO its round ("m:ss") — the
// round-relative row clock every per-round row shows (the Utility rows:
// how far into that round the throw happened). Same arithmetic and
// fallback as chatClock via intoRoundSeconds — an unknown round or a
// tick before its start renders the match-relative clock; the raw tick
// stays in the cell's title tooltip.
export function roundClock(tick, round, tickRate) {
  const into = intoRoundSeconds(tick, round, tickRate);
  return fmtClock(into != null ? into : tickSeconds(tick, tickRate));
}

// fmtDuration renders seconds as "35m39s" (or "42s" / "1h02m03s").
export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// fmtClock renders seconds as a clock position: "m:ss" ("0:45", "12:34")
// and "h:mm:ss" from one hour on ("1:02:03"). Rounds to the nearest
// second; non-finite or negative input renders "—". Unlike fmtDuration
// this is a *time of day* style readout, not a duration label.
export function fmtClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// parseClock — THE inverse of fmtClock (same file, same grammar): it
// accepts the clock shapes fmtClock renders — "m:ss" ("1:00", "1:05"),
// "h:mm:ss" from one hour on ("1:02:03") — plus what a user may TYPE
// into a clock field: zero-padded fields ("01:05") and the bare
// whole-seconds shorthand ("90"). It returns whole SECONDS. Anything
// else (empty, letters, a sign, a fractional or an over-range field
// such as "1:60" — fmtClock never emits one) is NaN: callers restore
// the value they displayed instead of writing NaN into state. Round-trip
// is the contract: fmtClock(parseClock(fmtClock(s))) === s for every
// whole second s ≥ 0 (unit-tested in fmt.test.js), which is what keeps a
// re-rendered time input from drifting while the user edits it.
export function parseClock(str) {
  if (typeof str !== 'string') return NaN;
  const s = str.trim();
  if (!s) return NaN;
  const parts = s.split(':');
  if (parts.length > 3) return NaN;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) return NaN;
  if (parts.length === 1) return nums[0]; // bare seconds ("90")
  // Field ranges: the seconds (and the minutes of a h:mm:ss clock) are
  // 0–59 — a value outside them is not a clock fmtClock could have
  // produced ("1:60" is rejected, never silently folded to 2:00). The
  // leading m of "m:ss" and the bare seconds count are unbounded, so a
  // typed "75:30" still parses and re-displays canonically as "1:15:30".
  if (parts.length === 2) {
    const [m, sec] = nums;
    if (sec > 59) return NaN;
    return m * 60 + sec;
  }
  const [h, m, sec] = nums;
  if (m > 59 || sec > 59) return NaN;
  return h * 3600 + m * 60 + sec;
}

// tickSeconds converts demo ticks to seconds at the match tickrate
// (tickrate <= 0 falls back to 64 — CS2's standard).
export function tickSeconds(ticks, tickRate) {
  return ticks / normTickRate(tickRate);
}

// normTickRate normalizes a match tick rate: anything absent, non-numeric
// or <= 0 falls back to 64 (CS2's fixed simulation rate). The single home
// of the `> 0 ? : 64` rule — replay/engine.js (createEngine) and
// replay/audio.js call it.
export function normTickRate(tickRate) {
  return Number(tickRate) > 0 ? Number(tickRate) : 64;
}

// fmtMoney renders a money amount in the signed, rounded, grouped style
// the Economy view canonicalised: "$1,234" and "−$1,234" (U+2212 minus,
// abs value grouped by the locale). Whole dollars only; a missing /
// non-numeric value counts as 0.
export function fmtMoney(v) {
  const n = Math.round(Number(v) || 0);
  return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString();
}

// fmtMetric renders one metric value for its format tag — the tag-driven
// formatter shared by the metric Builder's preview and the match
// scoreboard's pinned-metric columns (int | float1 | percent | currency,
// defaulting by integrality). PlayerProfile's per-key metric formatter is
// a different shape (metric id, not format tag) and stays local.
export function fmtMetric(v, format) {
  if (!Number.isFinite(v)) return '—';
  switch (format) {
    case 'int':
      return fmtInt(v);
    case 'float1':
      return fmt1(v);
    case 'percent':
      return fmtPercent(v * 100);
    case 'currency':
      return fmtMoney(v);
    default:
      return Number.isInteger(v) ? fmtInt(v) : fmt2(v);
  }
}

// fmtMs renders a millisecond duration as seconds with one decimal
// ("1.5s") — flash durations in Utility / CompareRounds.
export function fmtMs(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

// fmtZeroDash — THE zero → em-dash rule for the utility tables' value
// cells (product-owner rule): a value that counts NOTHING renders as the
// em dash "—"; a positive value renders as itself with an optional
// `unit` suffix ("42 dmg", "3 aff"). "Nothing" = 0 AND any missing /
// non-numeric input (null, undefined, NaN, '') — a cell with no measured
// value shows the dash, never a fabricated 0 (the unit goes with it: a
// dash never carries "dmg"). Deliberately OUT of scope, by the owner's
// carve-out: clock times (0:00 is a real time), the toolbar's row counts
// (a 0 there is the table's N, not a value), identity fields (kind,
// thrower — and the coordinate cell's own both-zero rule lives in
// Utility.svelte) and the Flash-effectiveness card (a summary card, not
// a table). Negative values render as themselves — never a dash; no
// cell produces one today (counts are ≥ 0).
export function fmtZeroDash(value, unit = '') {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '—';
  return unit ? `${n} ${unit}` : String(n);
}

// fmtTickSeconds renders ticks as a seconds string ("12.3s").
export function fmtTickSeconds(ticks, tickRate) {
  if (!Number.isFinite(ticks)) return '—';
  return `${tickSeconds(ticks, tickRate).toFixed(1)}s`;
}

// fmtBytes renders byte counts as MB (GB above 1024 MB).
export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// fmtPercent renders an already-0..100 value ("52%"). That is the scale
// every read-DTO percent field carries (KASTPct, DMGConvPct, EntryRate,
// TradeRate, the profile's WinPct/OpeningRate/…): passing a 0..1 fraction
// here renders "0.05%" instead of "5%". The metric Builder's `percent`
// format tag is the deliberate exception — those values ARE 0..1 and
// fmtMetric scales them ×100 before calling this (never pass them raw).
export function fmtPercent(x) {
  if (!Number.isFinite(x)) return '—';
  return `${round1(x)}%`;
}

// fmtDate renders a Date/ISO string as a locale date-time. A timestamp
// the backend never wrote — the Go zero time.Time behind a NULL
// matches.extracted_at, serialized as "0001-01-01T00:00:00Z" — is "not
// extracted yet", not a date: it takes the placeholder instead of
// rendering a year-0001 oddity on a still-parsing/queued/failed row.
export function fmtDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  if (date.getUTCFullYear() <= 1) return '—'; // the Go zero time (never stamped)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// round1 rounds a float to one decimal (the ±float formatter).
export function round1(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

// fmt1 / fmt2 render floats with a fixed 1- / 2-decimal tail.
export function fmt1(x) {
  if (!Number.isFinite(x)) return '—';
  return round1(x).toFixed(1);
}

export function fmt2(x) {
  if (!Number.isFinite(x)) return '—';
  return (Math.round(x * 100) / 100).toFixed(2);
}

// fmtInt renders an integer with locale grouping.
export function fmtInt(x) {
  if (!Number.isFinite(x)) return '—';
  return Math.round(x).toLocaleString();
}

// basename extracts the final path segment (Windows or POSIX separators).
export function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

// prettyJson pretty-prints a JSON string, falling back to the raw text.
export function prettyJson(s) {
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return String(s);
  }
}
