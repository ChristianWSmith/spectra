import '../../test/compile-worker-node.mjs';
// matchpanels.test.js — the Match view's panels as builtins (dogfood/PLAN.md
// C5b, dogfood/04-COMPONENTS.md §3, §3.5). The contract a panel keeps:
//   - it is registered as a builtin, under the builtin namespace;
//   - it reads through `context` (the mount's match) and mounts nothing else;
//   - no panel, and no Match view code, reads a retired preference (ruling 33:
//     order, hidden, the economy placement, the transposed shape, and the
//     retired localStorage keys).
// The rendered values are pinned by test/match-panels.dom.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MATCH_PANELS, MATCH_PANEL_IDS } from './matchpanels.js';
import { BUILTIN_COMPONENTS, BUILTIN_PREFIX } from './componentbuiltins.js';
import { gateComponentSave } from './componentruntime/savegate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The retired keys and their readers (dogfood/04 §2, ruling 33).
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

test('the Match view has its six panels, each a builtin under the builtin namespace', () => {
  assert.equal(MATCH_PANELS.length, 6);
  const ids = MATCH_PANELS.map((p) => p.id);
  assert.deepEqual(ids, [
    MATCH_PANEL_IDS.overview,
    MATCH_PANEL_IDS.rosters,
    MATCH_PANEL_IDS.scoreboard,
    MATCH_PANEL_IDS.rounds,
    MATCH_PANEL_IDS.details,
    MATCH_PANEL_IDS.facts,
  ]);
  for (const p of MATCH_PANELS) {
    assert.ok(p.id.startsWith(BUILTIN_PREFIX), `${p.id} is in the builtin namespace`);
    assert.ok(BUILTIN_COMPONENTS.some((b) => b.id === p.id), `${p.id} is in the builtin registry`);
  }
});

test('every panel passes the save-time check (runes, valid syntax)', async () => {
  for (const p of MATCH_PANELS) {
    const gate = await gateComponentSave(p.source, 'src/lib');
    assert.equal(gate.ok, true, `${p.id}: ${gate.message}`);
  }
});

// The registry helpers a panel may import (ruling 45): the only imports a
// built-in carries, each name listed in compile.js BUILTIN_HELPERS.
const HELPER_IMPORTS = {
  [MATCH_PANEL_IDS.rounds]: ['./viewstate.svelte.js'],
  [MATCH_PANEL_IDS.facts]: ['./services.js'],
};

test('every panel reads through context and mounts nothing else', () => {
  for (const p of MATCH_PANELS) {
    assert.match(p.source, /let \{[^}]*\bcontext\b[^}]*\} = \$props\(\);/, `${p.id} takes context as a prop`);
    // The facts panel reads the match services (voice, the demo copy), not a query.
    if (p.id !== MATCH_PANEL_IDS.facts) {
      assert.match(p.source, /spectra\.metric\(|spectra\.query\(/, `${p.id} reads metrics or facts`);
    }
    assert.doesNotMatch(p.source, /spectra\.Child/, `${p.id} mounts no child`);
    const imports = [...p.source.matchAll(/^\s*import\s.*?from\s*'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports, HELPER_IMPORTS[p.id] || [], `${p.id} imports only its registry helpers`);
  }
});

test('no panel reads a retired preference (ruling 33)', () => {
  for (const p of MATCH_PANELS) {
    for (const key of RETIRED) {
      assert.ok(!p.source.includes(key), `${p.id} reads the retired key or helper ${key}`);
    }
  }
  const matchpanels = readFileSync(path.join(HERE, 'matchpanels.js'), 'utf8');
  for (const key of RETIRED) {
    assert.ok(!matchpanels.includes(key), `matchpanels.js holds the retired key or helper ${key}`);
  }
});

test('the Match view reads no retired preference either (grep)', () => {
  const view = readFileSync(path.join(HERE, 'views', 'Match.svelte'), 'utf8');
  for (const key of RETIRED) {
    assert.ok(!view.includes(key), `views/Match.svelte still names ${key}`);
  }
});
