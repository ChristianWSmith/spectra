import '../../test/compile-worker-node.mjs';
// econutilpanels.test.js — the Economy and Utility views as builtin components
// The contract:
//   - each view is a composer plus the panels it mounts, every id in the
//     reserved builtin namespace, registered in BUILTIN_COMPONENTS, and every
//     child a composer names is registered;
//   - every source passes the save-time check (runes, valid syntax);
//   - each panel reads through `context` (the mount's match) and imports nothing;
//   - no panel and no Match view code reads a retired preference (ruling 33):
//     the order/hidden keys, the transposed shape, and the economy readers.
//     Comments are stripped first.
//   - no panel reads the per-round player_round_stats.deaths column (F3 removes
//     it): the per-round deaths come from the stored metric raw_round_side_deaths.
// The rendered values are pinned by test/econ-util-panels.dom.mjs.
//
// Run: node --test src/lib/econutilpanels.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ECON_PANELS, ECONOMY_SOURCE } from './econpanels.js';
import { UTIL_PANELS } from './utilpanels.js';
import { BUILTIN_COMPONENTS, BUILTIN_PREFIX, builtinById } from './componentbuiltins.js';
import { gateComponentSave } from './componentruntime/savegate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The retired keys and readers.
const RETIRED = [
  'scoreboard_starts_transposed',
  'metric_order_',
  'metric_pins_',
  'metric_hidden_',
  'metric_economy',
  'spectra:pinned-metrics',
  'spectra:pinned-profile-metrics',
  'readOrder',
  'readHidden',
  'readStartsTransposed',
  'readOverviewPins',
  'readEconomyPins',
  'resolvePins',
  'localStorage',
];

// stripComments removes block, HTML and line comments (a comment that names a
// retired key is prose, not a read). The panels hold no URL, so `//` is a comment.
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

const PANELS = [...ECON_PANELS, ...UTIL_PANELS];
const COMPOSERS = [ECON_PANELS[0], UTIL_PANELS[0]];

test('the Economy and Utility views are builtins: a composer and three or four panels each', () => {
  assert.equal(ECON_PANELS.length, 4, 'Economy: composer, curve, cards, rounds');
  assert.equal(UTIL_PANELS.length, 4, 'Utility: composer, log, damage, blind');
  for (const p of PANELS) {
    assert.ok(p.id.startsWith(BUILTIN_PREFIX), `${p.id} is in the builtin namespace`);
    assert.ok(BUILTIN_COMPONENTS.some((b) => b.id === p.id), `${p.id} is in the builtin registry`);
    assert.equal(builtinById(p.id).source, p.source, `${p.id} resolves to its source`);
  }
});

test('every child a composer mounts is a registered builtin', () => {
  for (const composer of COMPOSERS) {
    const names = [...composer.source.matchAll(/spectra\.Child name="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(names.length >= 3, `${composer.id} mounts its panels`);
    for (const name of names) {
      assert.ok(builtinById(name), `${composer.id} mounts ${name}, which is not registered`);
    }
  }
});

test('every source passes the save-time check (runes, valid syntax)', async () => {
  for (const p of PANELS) {
    const gate = await gateComponentSave(p.source);
    assert.equal(gate.ok, true, `${p.id}: ${gate.message}`);
  }
});

test('every panel reads through context and imports nothing', () => {
  for (const p of PANELS) {
    const code = stripComments(p.source);
    assert.match(p.source, /let \{[^\n]*\bcontext\b[^\n]*\} = \$props\(\);/, `${p.id} takes context as a prop`);
    assert.doesNotMatch(code, /^\s*import\s/m, `${p.id} imports nothing (builtins are self-contained source)`);
  }
});

test('no panel reads a retired preference (ruling 33, grep)', () => {
  for (const p of PANELS) {
    const code = stripComments(p.source);
    for (const key of RETIRED) {
      assert.ok(!code.includes(key), `${p.id} reads the retired key or helper ${key}`);
    }
  }
  for (const file of ['econpanels.js', 'utilpanels.js', 'builtinhelpers.js']) {
    const code = stripComments(readFileSync(path.join(HERE, file), 'utf8'));
    for (const key of RETIRED) {
      assert.ok(!code.includes(key), `${file} holds the retired key or helper ${key}`);
    }
  }
});

test('the Match view names no retired preference and no economy or utility view file', () => {
  const view = readFileSync(path.join(HERE, 'views', 'Match.svelte'), 'utf8');
  for (const key of RETIRED) {
    assert.ok(!view.includes(key), `views/Match.svelte still names ${key}`);
  }
  assert.doesNotMatch(view, /from '\.\/(Economy|Utility)\.svelte'/, 'the old views are gone');
});

test('no panel reads the per-round deaths column (F3); deaths are the stored metric', () => {
  for (const p of PANELS) {
    const code = stripComments(p.source);
    assert.ok(!/player_round_stats/.test(code), `${p.id} reads player_round_stats`);
    assert.ok(!/\.deaths\b/.test(code), `${p.id} reads a per-round deaths field`);
  }
  const rounds = ECON_PANELS.find((p) => p.id.endsWith('-rounds'));
  assert.match(rounds.source, /metric\('raw_player_round_deaths'/, 'the rounds panel reads the stored round deaths');
});

test('the Economy cards read the six default statistics by their stored names', () => {
  const cards = ECON_PANELS.find((p) => p.id.endsWith('-cards'));
  for (const name of ['pistol_hold', 'team_force_wins', 'team_force_rounds', 'avg_equip_gap', 'lost_equip', 'team_lost_equip']) {
    assert.ok(cards.source.includes(`"metric":"${name}"`), `cards read ${name}`);
  }
});

test('the Economy composer owns no card set: the cards panel does', () => {
  assert.ok(!ECONOMY_SOURCE.includes('pistol_hold'), 'the composer loads rows only');
});
