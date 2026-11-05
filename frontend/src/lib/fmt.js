// Formatting helpers for the M1 views. Pure functions — no services.
import { isCounted } from './rounds.js';

// chatClock renders a chat line's time cell: "R12 1:23" — how far INTO
// its round the message was said: (tick − round.startTick) / tickRate,
// rendered with fmtClock. Messages with no containing round, in a
// counted-out round (knife/warmup — lib/rounds.js) or with a negative
// offset fall back to a match-relative clock (tick / tickRate) — plain
// "m:ss", never a negative; keep it simple. The raw tick stays in the
// cell's title tooltip. This is THE chat clock (the Replay feed's
// chat rows and RoundDetail's round chat both render it).
export function chatClock(c, roundByNumber, tickRate) {
  const r = (roundByNumber || new Map()).get(c.round);
  if (r && isCounted(r)) {
    const intoRound = tickSeconds(c.tick - r.startTick, tickRate);
    if (intoRound >= 0) return `R${r.number} ${fmtClock(intoRound)}`;
  }
  return fmtClock(tickSeconds(c.tick, tickRate));
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

// fmtPercent renders an already-0..100 value ("52%").
export function fmtPercent(x) {
  if (!Number.isFinite(x)) return '—';
  return `${round1(x)}%`;
}

// fmtDate renders a Date/ISO string as a locale date-time.
export function fmtDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
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
