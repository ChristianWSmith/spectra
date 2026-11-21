import '../../test/compile-worker-node.mjs';
// matchbuiltins.test.js — the Match view's Heatmaps and Combat tabs as builtin
// components (PLAN C5-Heat-Combat; dogfood/04-COMPONENTS.md §3, §7). Pins:
//   1. the registry (builtins/panels.js) names the two tab components and their
//      panels, every id sits in the reserved builtin namespace, and each
//      panel's file exists;
//   2. no Heatmaps or Combat panel reads a retired preference (ruling 33: the
//      pin, order, hidden, economy, transposed and localStorage keys), and the
//      only preference the tabs read is `loop_secs`, which stays a plain pref;
//   3. the Match surface mounts the tabs as components, and the old views are
//      gone (no file, no import);
//   4. the pure Combat model: one row per kill, and the clutch kill-tick parse.
// Comments are stripped before a key scan, so a comment naming a key is not a
// read.
// Run: node --test src/lib/matchbuiltins.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PREFIX } from './componentbuiltins.js';
import { clutchKillTicks, groupEngagements } from './builtins/match/combatmodel.js';

const LIB = fileURLToPath(new URL('.', import.meta.url));
const MATCH_DIR = path.join(LIB, 'builtins', 'match');

// The retired keys and their readers (dogfood/04 §2, ruling 33), as in
// builtinpanels.test.js.
const RETIRED = [
  'metric_order_match',
  'metric_order_profile',
  'metric_order_overview',
  'metric_pins_overview',
  'metric_economy',
  'metric_hidden_match',
  'metric_hidden_profile',
  'scoreboard_starts_transposed',
  'spectra:pinned-metrics',
  'spectra:pinned-profile-metrics',
  'readOrder',
  'readHidden',
  'readOverviewPins',
  'readEconomyPins',
  'readStartsTransposed',
  'parseStoredPins',
  'localStorage',
  'GetPref',
  'setPref',
];

// stripComments removes block comments, HTML comments and line comments. The
// tabs hold no URL, so a `//` tail is always a comment.
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

const TAB_FILES = ['Heatmaps.svelte', 'HeatmapsPanel.svelte', 'Combat.svelte', 'CombatEngagements.svelte', 'CombatClutches.svelte', 'combatdata.js', 'combatmodel.js'];
const registry = readFileSync(path.join(LIB, 'builtins', 'panels.js'), 'utf8');

test('the registry names the Heatmaps and Combat tabs and their panels, in the builtin namespace', () => {
  const ids = [...new Set([...registry.matchAll(/'(builtin-match-[a-z-]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(ids, [
    'builtin-match-combat',
    'builtin-match-combat-clutches',
    'builtin-match-combat-engagements',
    'builtin-match-heatmap',
    'builtin-match-heatmaps',
    'builtin-match-tabs',
  ]);
  for (const id of ids) assert.ok(id.startsWith(BUILTIN_PREFIX), `${id} carries the builtin prefix`);
  const imports = [...registry.matchAll(/from '\.\/(match\/[A-Za-z]+\.svelte)'/g)].map((m) => m[1]);
  assert.equal(imports.length, 6, 'the registry imports the tab set, the two tabs and their three panels');
  for (const rel of imports) assert.ok(existsSync(path.join(LIB, 'builtins', rel)), `${rel} exists`);
});

test('no Heatmaps or Combat panel reads a retired preference (ruling 33)', () => {
  const hits = [];
  for (const f of TAB_FILES) {
    const code = stripComments(readFileSync(path.join(MATCH_DIR, f), 'utf8'));
    for (const key of RETIRED) if (code.includes(key)) hits.push(`${f}: ${key}`);
  }
  assert.deepEqual(hits, [], `retired preference reads: ${hits.join('; ')}`);
});

test('the tabs read one preference only, loop_secs (a plain pref, ruling 33)', () => {
  const names = new Set();
  for (const f of TAB_FILES) {
    const code = stripComments(readFileSync(path.join(MATCH_DIR, f), 'utf8'));
    for (const m of code.matchAll(/getPref\(\s*'([^']+)'/g)) names.add(m[1]);
  }
  assert.deepEqual([...names], ['loop_secs']);
});

test('the Match surface mounts the tabs as components, and the old views are gone', () => {
  const match = stripComments(readFileSync(path.join(LIB, 'views', 'Match.svelte'), 'utf8'));
  const tabs = stripComments(readFileSync(path.join(MATCH_DIR, 'MatchTabs.svelte'), 'utf8'));
  assert.ok(match.includes("from '../builtins/match/MatchTabs.svelte'"), 'Match mounts the tab set builtin');
  // The tab set mounts its tab components by name (a built-in imports no sibling
  // file: ruling 45 — helpers only).
  assert.ok(tabs.includes('name="builtin-match-heatmaps"'), 'the tab set mounts the Heatmaps tab component');
  assert.ok(tabs.includes('name="builtin-match-combat"'), 'the tab set mounts the Combat tab component');
  assert.ok(!/from '\.\/[^']+\.svelte'/.test(tabs), 'the tab set imports no sibling component file');
  assert.ok(!/from '\.\/(Heatmaps|Combat)\.svelte'/.test(match), 'Match no longer imports the old views');
  assert.ok(!existsSync(path.join(LIB, 'views', 'Heatmaps.svelte')), 'views/Heatmaps.svelte is removed');
  assert.ok(!existsSync(path.join(LIB, 'views', 'Combat.svelte')), 'views/Combat.svelte is removed');
  const hits = RETIRED.filter((key) => match.includes(key));
  assert.deepEqual(hits, [], `retired preference reads in Match.svelte: ${hits.join(', ')}`);
  assert.ok(readdirSync(MATCH_DIR).length >= 7, 'the tab directory holds the tabs and their panels');
});

test('groupEngagements: one row per kill, kinds kept in fetch order, first position kept', () => {
  const rows = groupEngagements([
    { round: 1, tick: 100, aSteam: 'A', aName: 'a', bSteam: 'B', bName: 'b', distance: 500, kind: 'opening' },
    { round: 1, tick: 90, aSteam: 'C', aName: 'c', bSteam: 'D', bName: 'd', distance: 200, kind: 'trade' },
    { round: 1, tick: 100, aSteam: 'A', aName: 'a', bSteam: 'B', bName: 'b', distance: 500, kind: 'trade' },
    { round: 1, tick: 100, aSteam: 'A', aName: 'a', bSteam: 'B', bName: 'b', distance: 500, kind: 'opening' },
    { round: 1, tick: 100, aSteam: 'A', aName: 'a', bSteam: 'B', bName: 'b', distance: 500, kind: 'untraded' },
  ]);
  assert.equal(rows.length, 2, 'two kills, one row each');
  assert.deepEqual(rows[0].kinds, ['opening', 'trade', 'untraded'], 'distinct kinds, in fetch order');
  assert.equal(rows[0].tick, 100);
  assert.equal(rows[1].aSteam, 'C', 'the second kill keeps its own position');
});

test('clutchKillTicks: a JSON array of ticks, and anything else reads as no kills', () => {
  assert.deepEqual(clutchKillTicks('[1200, 1310, -5, "x", 1400]'), [1200, 1310, 1400]);
  assert.deepEqual(clutchKillTicks('not json'), []);
  assert.deepEqual(clutchKillTicks('{"a":1}'), []);
  assert.deepEqual(clutchKillTicks(''), []);
  assert.deepEqual(clutchKillTicks(null), []);
});
