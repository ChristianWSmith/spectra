// Characterization + canonical tests for CSV export (B3).
//
// The canonical csvCell/toCSV below are SqlConsole.svelte's stricter RFC
// 4180 semantics (see csv.js). `contextCsvCell` pins the laxer inline
// spelling it replaced:
//   - regex /[",\n]/ (no \r → a CR inside a cell was NOT quoted: a real
//     escaping bug), String(v ?? ''), objects → "[object Object]",
//     "\n" row endings and no trailing newline.
// Run: node --test src/lib/csv.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { csvCell, toCSV } from './csv.js';

test('csvCell: plain values pass through untouched', () => {
  assert.equal(csvCell('hello'), 'hello');
  assert.equal(csvCell('tick'), 'tick');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(-3), '-3');
  assert.equal(csvCell(true), 'true');
});

test('csvCell: null/undefined render as an empty field', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('csvCell: quotes are doubled and the field wrapped', () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('"'), '""""');
});

test('csvCell: commas, LF and CR all force quoting (RFC 4180)', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  // The CR case is the escaping bug Context's /[",\n]/ copy had: a bare CR
  // split the record. The canonical cell quotes it.
  assert.equal(csvCell('a\rb'), '"a\rb"');
  assert.equal(csvCell('a\r\nb'), '"a\r\nb"');
});

test('csvCell: objects serialize as JSON, not "[object Object]"', () => {
  // JSON text contains quotes/commas, so it is itself a quoted field.
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.equal(csvCell([1, 2]), '"[1,2]"');
  assert.equal(csvCell({ a: null }), '"{""a"":null}"');
  // JSON object/array text always carries quotes (→ a quoted field); only
  // the empty object has nothing to escape.
  assert.equal(csvCell({}), '{}');
});

test('toCSV: rows are comma-joined, CRLF-terminated with a trailing newline', () => {
  const out = toCSV([
    ['tick', 'round', 'text'],
    [1, 2, 'hello'],
  ]);
  assert.equal(out, 'tick,round,text\r\n1,2,hello\r\n');
});

test('toCSV: cells are escaped through csvCell', () => {
  const out = toCSV([
    ['name', 'note'],
    ['alice', 'a,b'],
    ['bob', 'said "hi"'],
    ['carol', null],
    ['dan', 'line1\nline2'],
  ]);
  assert.equal(
    out,
    'name,note\r\nalice,"a,b"\r\nbob,"said ""hi"""\r\ncarol,\r\ndan,"line1\nline2"\r\n',
  );
});

test('toCSV: an empty table still ends its (empty) record', () => {
  assert.equal(toCSV([]), '\r\n');
  assert.equal(toCSV([['only']]), 'only\r\n');
});

test('toCSV: a single row is one record', () => {
  assert.equal(toCSV([['a', 'b']]), 'a,b\r\n');
});

// --- Characterization fixture: the laxer inline csvCell ---------------
// Verbatim copy of the inline helper that drifted from SqlConsole's
// semantics, kept as the record of the two drifts the canonical form
// fixed: CR was not quoted (escaping bug) and rows were "\n"-joined
// without a trailing newline.
function contextCsvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

test('characterization: Context variant did NOT quote a bare CR (the bug)', () => {
  assert.equal(contextCsvCell('a\rb'), 'a\rb'); // canonical quotes it
  assert.equal(contextCsvCell('a\r\nb'), '"a\r\nb"'); // \r\n rides the \n
});

test('characterization: Context variant stringified objects and null the same way', () => {
  assert.equal(contextCsvCell(null), ''); // canonical agrees
  assert.equal(contextCsvCell(undefined), ''); // canonical agrees
  assert.equal(contextCsvCell({ a: 1 }), '[object Object]'); // canonical: JSON
  assert.equal(contextCsvCell(0), '0'); // canonical agrees
  assert.equal(contextCsvCell(false), 'false'); // canonical agrees
});

test('characterization: Context joined rows with "\n" and no trailing newline', () => {
  const lines = ['tick,text'];
  lines.push([1, 'a,b'].map(contextCsvCell).join(','));
  assert.equal(lines.join('\n'), 'tick,text\n1,"a,b"');
});
