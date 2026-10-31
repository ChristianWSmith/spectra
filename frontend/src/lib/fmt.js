// Formatting helpers for the M1 views. Pure functions — no services.

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

// tickSeconds converts demo ticks to seconds at the match tickrate
// (tickrate <= 0 falls back to 64 — CS2's standard).
export function tickSeconds(ticks, tickRate) {
  const tr = Number(tickRate) > 0 ? Number(tickRate) : 64;
  return ticks / tr;
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
