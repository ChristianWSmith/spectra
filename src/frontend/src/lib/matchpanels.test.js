import '../../test/compile-worker-node.mjs';
// matchpanels.test.js — the Match view's six panels as builtin components
// (builtins/match/Match*.svelte). The contract a panel keeps:
//   - it is registered as a builtin, under the builtin namespace;
//   - it reads through `context` (the mount's match) and mounts nothing else;
//   - it imports only the curated helper surface: the strings catalog, and the
//     names BUILTIN_HELPERS lists for the helper surface;
//   - no panel, and no Match view code, reads a retired preference (ruling 33:
//     order, hidden, the economy placement, the transposed shape, and the
//     retired localStorage keys).
// The rendered values are pinned by test/match-panels.dom.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BUILTIN_COMPONENTS, builtinShippedSource, builtinSourceDir, isBuiltinId } from './componentbuiltins.js';
import { BUILTIN_HELPERS } from './componentruntime/compile.js';
import { gateComponentSave } from './componentruntime/savegate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The retired keys and their readers.
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
  'localStorage',
];

const PANELS = {
  'match-overview': 'MatchOverview.svelte',
  'match-rosters': 'MatchRosters.svelte',
  'match-scoreboard': 'MatchScoreboard.svelte',
  'match-rounds': 'MatchRounds.svelte',
  'match-details': 'MatchDetails.svelte',
};

test('the Match view has its five panels, each a builtin under the builtin namespace', () => {
  assert.equal(Object.keys(PANELS).length, 5);
  for (const id of Object.keys(PANELS)) {
    assert.ok(isBuiltinId(id), `${id} is in the builtin namespace`);
    assert.ok(
      BUILTIN_COMPONENTS.some((b) => b.id === id),
      `${id} is in the builtin registry`,
    );
    assert.ok(builtinShippedSource(id), `${id} ships its source`);
  }
});

test('every panel is a .svelte file in builtins/match', () => {
  for (const [id, file] of Object.entries(PANELS)) {
    assert.equal(builtinSourceDir(id), 'src/lib/builtins/match', `${id} lives in builtins/match`);
    const src = readFileSync(path.join(HERE, 'builtins', 'match', file), 'utf8');
    assert.equal(builtinShippedSource(id), src, `${id} ships its file's text`);
  }
});

test('every panel passes the save-time check (runes, valid syntax)', async () => {
  for (const id of Object.keys(PANELS)) {
    const gate = await gateComponentSave(builtinShippedSource(id), builtinSourceDir(id));
    assert.equal(gate.ok, true, `${id}: ${gate.message}`);
  }
});

test('every panel reads through context and mounts nothing else', () => {
  for (const id of Object.keys(PANELS)) {
    const src = builtinShippedSource(id);
    assert.match(src, /let \{[\s\S]*?\bcontext\b[\s\S]*?\} = \$props\(\);/, `${id} takes context as a prop`);
    assert.match(src, /spectra\.metric\(|spectra\.query\(|readUnit\(spectra|getMatch\(|getProvenance\(/, `${id} reads metrics or facts`);
    assert.doesNotMatch(src, /spectra\.Child/, `${id} mounts no child`);
  }
});

test('every import is on the curated surface (spectra/helpers, and only its listed names)', () => {
  const helperNames = Object.keys(BUILTIN_HELPERS['src/lib/builtinhelpers.js'].names);
  for (const id of Object.keys(PANELS)) {
    const src = builtinShippedSource(id);
    for (const m of src.matchAll(/^\s*import\s+(\*\s+as\s+\w+|\{[^}]*\}|\w+)\s+from\s+'([^']+)';/gm)) {
      const [, clause, spec] = m;
      // A built-in imports one module: the helper surface. Relative paths and app modules are refused.
      assert.equal(spec, 'spectra/helpers', `${id} imports ${spec}: a built-in imports only spectra/helpers`);
      for (const name of clause.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean)) {
        const bare = name.split(/\s+as\s+/)[0];
        assert.ok(helperNames.includes(bare), `${id} imports ${bare}, which BUILTIN_HELPERS does not list`);
      }
    }
  }
});

test('no panel reads a retired preference (ruling 33)', () => {
  for (const id of [...Object.keys(PANELS), 'match']) {
    const src = builtinShippedSource(id);
    for (const key of RETIRED) {
      assert.ok(!src.includes(key), `${id} reads the retired key or helper ${key}`);
    }
  }
  const helpers = readFileSync(path.join(HERE, 'builtins', 'match', 'panelhelpers.js'), 'utf8');
  for (const key of RETIRED) {
    assert.ok(!helpers.includes(key), `panelhelpers.js holds the retired key or helper ${key}`);
  }
});

test('the Match view reads no retired preference either (grep)', () => {
  const view = readFileSync(path.join(HERE, 'views', 'Match.svelte'), 'utf8');
  for (const key of RETIRED) {
    assert.ok(!view.includes(key), `views/Match.svelte still names ${key}`);
  }
});
