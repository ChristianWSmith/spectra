// completions.test.js — the pure completion lists for the source editors: SQL
// (metric and console), report templates. The Monaco adapter is exercised in the
// browser; the lists it renders are checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlItems, METRIC_BINDS, SQL_KEYWORDS } from './sqlCompletions.js';
import { templateItems, TEMPLATE_FUNCTIONS } from './templateCompletions.js';

const labels = (items) => items.map((i) => i.label);

test('a SQL statement is offered its keywords, functions, the bot filter, tables and columns', () => {
  const items = sqlItems({
    tables: [
      { name: 'kills', note: 'one kill', columns: [{ name: 'steam_id', type: 'TEXT' }, { name: 'round', type: 'INTEGER' }] },
      { name: 'deaths', note: '', columns: [{ name: 'steam_id', type: 'TEXT' }] },
    ],
    binds: METRIC_BINDS,
    metrics: [{ name: 'kd', title: 'K/D' }],
  });
  const l = labels(items);
  for (const k of SQL_KEYWORDS) assert.ok(l.includes(k), `keyword ${k}`);
  for (const f of ['COUNT', 'SUM', 'NULLIF', 'is_bot_key', 'kills', 'deaths', ':match_id', ':steam_id', ':round', "metric('kd')"]) {
    assert.ok(l.includes(f), `offers ${f}`);
  }
});

test('a column that several tables carry is offered once, and says how many', () => {
  const items = sqlItems({
    tables: [
      { name: 'a', columns: [{ name: 'steam_id', type: 'TEXT' }] },
      { name: 'b', columns: [{ name: 'steam_id', type: 'TEXT' }] },
    ],
  });
  const cols = items.filter((i) => i.label === 'steam_id');
  assert.equal(cols.length, 1);
  assert.equal(cols[0].detail, 'TEXT · 2 tables');
});

test('the bot filter and the binds appear only where the caller offers them', () => {
  const console = labels(sqlItems({ tables: [], binds: [], botFilter: false }));
  assert.ok(!console.includes('is_bot_key'));
  assert.ok(!console.some((l) => l.startsWith(':')));
});

test('a snippet inserts its call with the argument as a tab stop', () => {
  const count = sqlItems({}).find((i) => i.label === 'COUNT');
  assert.equal(count.insert, 'COUNT($1)');
  assert.equal(count.snippet, true);
});

test('a template is offered its functions, keywords and the scope’s fields', () => {
  const items = templateItems({
    fields: [
      { name: 'Scoreboard', type: '[]models.PlayerStatsRow', fields: [{ name: 'Name', type: 'string' }] },
      { name: 'CTName', type: 'string' },
      { name: 'Match', type: 'models.Match', fields: [{ name: 'Map', type: 'string' }] },
    ],
  });
  const l = labels(items);
  for (const f of TEMPLATE_FUNCTIONS) assert.ok(l.includes(f.name), `function ${f.name}`);
  for (const k of ['if', 'range', 'end', 'with']) assert.ok(l.includes(k), `keyword ${k}`);
  assert.ok(l.includes('.Scoreboard') && l.includes('.CTName') && l.includes('.Match'));
  assert.ok(l.includes('.Match.Map'), 'a struct field is one level down');
  assert.ok(l.includes('range .Scoreboard'), 'a row list offers its range loop');
  const range = items.find((i) => i.label === 'range .Scoreboard');
  assert.equal(range.insert, 'range .Scoreboard}}\n\t$0\n{{end}}');
  assert.equal(range.snippet, true);
});
