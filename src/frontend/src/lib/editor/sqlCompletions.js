// The completion items for a metric or SQL-console statement: the SQL keywords
// and functions, the tables and their columns, the binds a statement may use,
// and the metrics it can reference. Pure data in, items out (the Monaco adapter
// lives in monaco.js), so the lists are checked under node.

export const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'WITH', 'AS', 'JOIN', 'LEFT JOIN', 'ON', 'GROUP BY', 'ORDER BY',
  'HAVING', 'LIMIT', 'UNION ALL', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'EXISTS', 'BETWEEN', 'LIKE', 'NULL',
];

// The SQLite functions a statement uses most, with their call shape.
export const SQL_FUNCTIONS = [
  { name: 'COUNT', args: 'expr', doc: 'The number of rows (or non-NULL values).' },
  { name: 'SUM', args: 'expr', doc: 'The sum of the values.' },
  { name: 'AVG', args: 'expr', doc: 'The mean of the values.' },
  { name: 'MIN', args: 'expr', doc: 'The smallest value.' },
  { name: 'MAX', args: 'expr', doc: 'The largest value.' },
  { name: 'COALESCE', args: 'a, b', doc: 'The first non-NULL argument.' },
  { name: 'NULLIF', args: 'a, b', doc: 'NULL when the two arguments are equal, otherwise the first.' },
  { name: 'ROUND', args: 'x, digits', doc: 'x rounded to digits decimal places.' },
  { name: 'CAST', args: 'expr AS type', doc: 'The value converted to a type.' },
];

// The reserved binds a metric statement may use; the engine supplies each one.
export const METRIC_BINDS = [
  { name: 'match_id', doc: 'The match the metric runs for.' },
  { name: 'steam_id', doc: 'The player the metric runs for.' },
  { name: 'round', doc: 'The round the metric runs for (needs match_id too).' },
];

// The bot filter a statement uses to leave bots out.
export const BOT_FILTER = {
  name: 'is_bot_key',
  args: 'steam_id',
  doc: 'Returns 1 for a bot and 0 for a human. AND NOT is_bot_key(steam_id) leaves bots out.',
};

// sqlItems builds the completion items for a statement.
//   tables:  [{ name, note, columns: [{ name, type }] }], the tables it may read
//   binds:   the bind descriptions to offer (METRIC_BINDS in the metric builder, [] in the console)
//   metrics: [{ name, title }], the saved metrics a metric('…') reference may name
//   botFilter: offer is_bot_key (the metric builder and the console both can use it)
export function sqlItems({ tables = [], binds = [], metrics = [], botFilter = true } = {}) {
  const items = [];
  for (const k of SQL_KEYWORDS) items.push({ label: k, kind: 'keyword', detail: 'SQL keyword', doc: '', insert: k, snippet: false });
  for (const f of SQL_FUNCTIONS) {
    items.push({ label: f.name, kind: 'function', detail: `${f.name}(${f.args})`, doc: f.doc, insert: `${f.name}($1)`, snippet: true });
  }
  if (botFilter) {
    items.push({ label: BOT_FILTER.name, kind: 'function', detail: `${BOT_FILTER.name}(${BOT_FILTER.args})`, doc: BOT_FILTER.doc, insert: `${BOT_FILTER.name}($1)`, snippet: true });
  }
  for (const t of tables) {
    items.push({ label: t.name, kind: 'table', detail: 'table', doc: t.note || '', insert: t.name, snippet: false });
  }
  // A column appears once, whichever tables carry it; the detail names how many.
  const columns = new Map();
  for (const t of tables) {
    for (const c of t.columns || []) {
      const entry = columns.get(c.name) || { type: c.type || '', note: c.note || '', tables: [] };
      entry.tables.push(t.name);
      columns.set(c.name, entry);
    }
  }
  for (const [name, c] of [...columns.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const where = c.tables.length === 1 ? c.tables[0] : `${c.tables.length} tables`;
    items.push({ label: name, kind: 'field', detail: `${c.type || 'column'} · ${where}`, doc: c.note, insert: name, snippet: false });
  }
  for (const b of binds) {
    items.push({ label: `:${b.name}`, kind: 'variable', detail: 'bind', doc: b.doc, insert: `:${b.name}`, snippet: false });
  }
  for (const m of metrics) {
    items.push({ label: `metric('${m.name}')`, kind: 'reference', detail: m.title || m.name, doc: `The stored value of the metric ${m.name}, for the same match, player or round.`, insert: `metric('${m.name}')`, snippet: false });
  }
  return items;
}
