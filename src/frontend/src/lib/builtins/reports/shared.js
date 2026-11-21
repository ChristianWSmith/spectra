// shared.js — the pure parts of the Reports builtin: the saved file's name,
// the appendix's text forms (Markdown and HTML) and the escaping they need.
// No state, no services: the component tests and the snapshot runner call
// these directly.

// fmtVal: one stored value as the appendix table shows it (a dash for a
// missing or non-finite value, never a zero: ruling 23).
export function fmtVal(v) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// findTemplate: the selected template row, or null.
export function findTemplate(templates, id) {
  return (templates || []).find((t) => t.id === id) || null;
}

// reportFilename: the save dialog's default name — the template's title
// slugged, the target it addresses, and the extension its format dictates.
export function reportFilename(tpl, { matchId, steamId, roundNo }) {
  const base =
    String((tpl && (tpl.title || tpl.id)) || 'report')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'report';
  const target =
    tpl.scope === 'player' ? steamId : tpl.scope === 'round' ? `round-${roundNo}` : `match-${matchId}`;
  return `${base}-${target}.${(tpl.format || 'md') === 'html' ? 'html' : 'md'}`;
}

// targetReady: the save button's gate — the template's target is filled in.
export function targetReady(tpl, { matchId, steamId, roundNo }) {
  if (!tpl) return false;
  if (tpl.scope === 'player') return !!steamId;
  if (tpl.scope === 'round') return !!matchId && roundNo >= 1;
  return !!matchId;
}

export function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// appendixMd / appendixHtml: the appendix as text. `entries` is the ordered
// list the appendix component builds: { title, line, hasTable, rows } with
// rows = [{ id, label, value }]. An entry without a table earns its line.
export function appendixMd(entries) {
  if (!entries.length) return '';
  let out = '\n\n## Stats appendix\n\n';
  for (const e of entries) {
    out += `### ${e.title}\n\n`;
    out += `${e.line}\n\n`;
    if (!e.hasTable) continue;
    out += '| Group | Label | Value |\n|---|---|---|\n';
    for (const r of e.rows) out += `| ${mdCell(r.id)} | ${mdCell(r.label)} | ${fmtVal(r.value)} |\n`;
    out += '\n';
  }
  return out;
}

export function appendixHtml(entries) {
  if (!entries.length) return '';
  let out = '<section class="rep-appendix-doc"><h2>Stats appendix</h2>';
  for (const e of entries) {
    out += `<h3>${esc(e.title)}</h3>`;
    out += `<p>${esc(e.line)}</p>`;
    if (!e.hasTable) continue;
    out += '<table class="data-table mini"><thead><tr><th>Group</th><th>Label</th><th class="num">Value</th></tr></thead><tbody>';
    for (const r of e.rows) out += `<tr><td>${esc(r.id)}</td><td>${esc(r.label)}</td><td class="num">${fmtVal(r.value)}</td></tr>`;
    out += '</tbody></table>';
  }
  out += '</section>';
  return out;
}

// compositeText: the rendered template body with the appendix appended. With
// no appendix entries the file is the body. The Go templates are trusted and
// the appendix is built from server data plus escaped text.
export function compositeText(body, entries, format) {
  if (!entries.length) return body;
  return format === 'html' ? body + appendixHtml(entries) : body + appendixMd(entries);
}
