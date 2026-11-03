// Canonical CSV serialization for every export path (B3).
//
// csvCell/toCSV are SqlConsole.svelte's stricter semantics, lifted
// verbatim: RFC 4180 escaping (quote a field containing ", CR or LF,
// double embedded quotes), null/undefined → empty field, objects →
// JSON text, "\r\n" record endings with a trailing newline.
//
// This replaced three drifting copies:
//   - SqlConsole.svelte — source of these semantics (\r\n, /["\r\n]/)
//   - Context.svelte    — /["\n]/ (a bare CR was NOT quoted: a real
//                         escaping bug), "\n" endings, no trailing
//                         newline, objects → "[object Object]"
//   - Reports.svelte    — builds markdown/HTML, not CSV (unchanged)
// Row building is `toCSV([[...header], [...row], ...])`.

// csvCell renders one field as a CSV cell.
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// toCSV renders a table (array of row arrays, cells via csvCell) as
// CRLF-separated records terminated by a final CRLF.
export function toCSV(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
