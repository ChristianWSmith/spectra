import '../../test/compile-worker-node.mjs';
// econutilpanels.test.js — the Economy and Utility views as builtin components
// The contract:
//   - each view is a composer plus the panels it mounts, every id in the
//     reserved builtin namespace, registered in the compiled registry, and every
//     child a composer names is registered;
//   - every source passes the save-time check (runes, valid syntax);
//   - each panel reads through `context` (the mount's match);
//   - each panel imports only the curated helper surface: the strings catalog
//     and the names BUILTIN_HELPERS lists for builtinhelpers.js;
//   - no panel and no Match view code reads a retired preference (ruling 33):
//     the order/hidden keys, the transposed shape, and the economy readers.
//     Comments are stripped first.
//   - no panel reads the per-round player_round_stats.deaths column (F3 removes
//     it): the per-round deaths come from the stored metric raw_player_round_deaths.
// The rendered values are pinned by test/econ-util-panels.dom.mjs.
//
// Run: node --test src/lib/econutilpanels.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_COMPONENTS, builtinById, builtinShippedSource, builtinSourceDir, isBuiltinId } from './componentbuiltins.js';
import { BUILTIN_HELPERS } from './componentruntime/compile.js';
import { gateComponentSave } from './componentruntime/savegate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ECONOMY = ['match-economy', 'match-economy-curve', 'match-economy-cards', 'match-economy-rounds'];
const UTILITY = ['match-utility', 'match-utility-log', 'match-utility-damage', 'match-utility-blind'];
const COMPOSERS = ['match-economy', 'match-utility'];
const PANELS = [...ECONOMY, ...UTILITY];

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

const sourceOf = (id) => builtinShippedSource(id);

test('the Economy and Utility views are builtins: a composer and three or four panels each', () => {
  assert.equal(ECONOMY.length, 4, 'Economy: composer, curve, cards, rounds');
  assert.equal(UTILITY.length, 4, 'Utility: composer, log, damage, blind');
  for (const id of PANELS) {
    assert.ok(isBuiltinId(id), `${id} is in the builtin namespace`);
    assert.ok(BUILTIN_COMPONENTS.some((b) => b.id === id), `${id} is in the builtin registry`);
    assert.ok(builtinById(id), `${id} resolves`);
    assert.ok(sourceOf(id), `${id} has shipped source`);
  }
});

test('the view files are Svelte components under builtins/econ and builtins/util', () => {
  const files = [...readdirSync(path.join(HERE, 'builtins', 'econ')), ...readdirSync(path.join(HERE, 'builtins', 'util'))];
  for (const f of ['Economy.svelte', 'EconCurve.svelte', 'EconCards.svelte', 'EconRounds.svelte', 'Utility.svelte', 'UtilLog.svelte', 'UtilBars.svelte']) {
    assert.ok(files.includes(f), `${f} exists`);
  }
});

test('every child a composer mounts is a registered builtin', () => {
  for (const id of COMPOSERS) {
    const names = [...sourceOf(id).matchAll(/spectra\.Child name="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(names.length >= 3, `${id} mounts its panels`);
    for (const name of names) {
      assert.ok(builtinById(name), `${id} mounts ${name}, which is not registered`);
    }
  }
});

test('every source passes the save-time check (runes, valid syntax)', async () => {
  for (const id of PANELS) {
    const gate = await gateComponentSave(sourceOf(id), builtinSourceDir(id));
    assert.equal(gate.ok, true, `${id}: ${gate.message}`);
  }
});

test('every panel reads through context', () => {
  for (const id of PANELS) {
    assert.match(sourceOf(id), /let \{[\s\S]*?\bcontext\b[\s\S]*?\} = \$props\(\);/, `${id} takes context as a prop`);
  }
});

test('every import is on the curated surface (strings catalog, or a name BUILTIN_HELPERS lists)', () => {
  for (const id of PANELS) {
    const code = stripComments(sourceOf(id));
    for (const m of code.matchAll(/^\s*import\s+(\*\s+as\s+\w+|\{[^}]*\})\s+from\s+'([^']+)';/gm)) {
      const [, clause, spec] = m;
      if (spec === '../../strings/index.js') {
        assert.equal(clause, '* as S', `${id} takes the strings catalog whole, as S`);
        continue;
      }
      // The module must be a registered helper (its key is the path from the
      // frontend root), and every name it takes must be listed for it.
      const key = path.posix.normalize(`${builtinSourceDir(id)}/${spec}`);
      assert.ok(Object.hasOwn(BUILTIN_HELPERS, key), `${id} imports ${spec} (${key}), which is not on the builtin surface`);
      const helperNames = Object.keys(BUILTIN_HELPERS[key].names);
      for (const name of clause.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)) {
        assert.ok(helperNames.includes(name), `${id} imports ${name}, which BUILTIN_HELPERS does not list for ${key}`);
      }
    }
  }
});

test('no panel reads a retired preference (ruling 33, grep)', () => {
  for (const id of PANELS) {
    const code = stripComments(sourceOf(id));
    for (const key of RETIRED) {
      assert.ok(!code.includes(key), `${id} reads the retired key or helper ${key}`);
    }
  }
  for (const file of ['builtinhelpers.js']) {
    const code = stripComments(readFileSync(path.join(HERE, file), 'utf8'));
    for (const key of RETIRED) {
      assert.ok(!code.includes(key), `${file} holds the retired key or helper ${key}`);
    }
  }
});

test('the Match view names no retired preference and no economy or utility view file', () => {
  const view = readFileSync(path.join(HERE, 'builtins', 'match', 'MatchTabs.svelte'), 'utf8');
  for (const key of RETIRED) {
    assert.ok(!view.includes(key), `MatchTabs.svelte still names ${key}`);
  }
});

test('no panel reads the per-round deaths column (F3); deaths are the stored metric', () => {
  for (const id of PANELS) {
    const code = stripComments(sourceOf(id));
    assert.ok(!/player_round_stats/.test(code), `${id} reads player_round_stats`);
    assert.ok(!/\.deaths\b/.test(code), `${id} reads a per-round deaths field`);
  }
  assert.match(sourceOf('match-economy-rounds'), /metric\('raw_player_round_deaths'/, 'the rounds panel reads the stored round deaths');
});

test('the Economy cards read the six default statistics by their stored names', () => {
  const cards = sourceOf('match-economy-cards');
  for (const name of ['pistol_hold', 'team_force_wins', 'team_force_rounds', 'avg_equip_gap', 'lost_equip', 'team_lost_equip']) {
    assert.ok(cards.includes(`metric: '${name}'`), `cards read ${name}`);
  }
});

test('the Economy composer owns no card set: the cards panel does', () => {
  assert.ok(!sourceOf('match-economy').includes('pistol_hold'), 'the composer loads rows only');
});
