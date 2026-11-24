import '../../test/compile-worker-node.mjs';
// matchpanels.test.js — the Match view's six panels as builtin components
// (builtins/match/Match*.svelte). The contract a panel keeps:
//   - it is registered as a builtin, under the builtin namespace;
//   - it reads through `context` (the mount's match) and mounts nothing else;
//   - it imports only the curated helper surface: the strings catalog, and the
//     names BUILTIN_HELPERS lists for its module;
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

test('every import is on the curated surface (strings catalog, or a name BUILTIN_HELPERS lists)', () => {
  const helperKey = 'src/lib/builtins/match/panelhelpers.js';
  const helperNames = Object.keys(BUILTIN_HELPERS[helperKey].names);
  const surfaces = {
    '../../strings/index.js': null,
    './panelhelpers.js': helperNames,
    '../../builtinhelpers.js': Object.keys(BUILTIN_HELPERS['src/lib/builtinhelpers.js'].names),
    '../../services.js': ['getMatch', 'getVoicePresence', 'evictDemoCopy', 'getProvenance', 'getEntitySummary', 'errText'],
    // The shared status chip (a component, not copy): a panel shows a read's status with it.
    '../../components/StatusChip.svelte': 'default',
    // The loading shell (a component too): a card holds its space and shows its own spinner.
    '../../components/LoadBox.svelte': 'default',
  };
  for (const id of Object.keys(PANELS)) {
    const src = builtinShippedSource(id);
    for (const m of src.matchAll(/^\s*import\s+(\*\s+as\s+\w+|\{[^}]*\}|\w+)\s+from\s+'([^']+)';/gm)) {
      const [, clause, spec] = m;
      assert.ok(spec in surfaces, `${id} imports ${spec}, which is not on the builtin surface`);
      if (surfaces[spec] === 'default') {
        assert.equal(clause, spec.split('/').pop().replace('.svelte', ''), `${id} takes ${spec} under its own name`);
        continue;
      }
      if (surfaces[spec] === null) {
        assert.equal(clause, '* as S', `${id} takes the strings catalog whole, as S`);
        continue;
      }
      for (const name of clause.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)) {
        assert.ok(surfaces[spec].includes(name), `${id} imports ${name} from ${spec}, which is not listed`);
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
