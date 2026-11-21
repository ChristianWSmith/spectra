// matchpanels.test.js — the Match view's panels as builtins (dogfood/PLAN.md
// C5b, dogfood/04-COMPONENTS.md §3, §3.5). The contract a panel keeps:
//   - it is registered as a builtin, under the builtin namespace;
//   - it reads through `context` (the mount's match) and mounts nothing else;
//   - no panel, and no Match view code, reads a retired preference (ruling 33:
//     pins, order, hidden, the economy pins, the transposed shape, the two
//     localStorage pin keys). C5e removes the controls and keys later.
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

test('the Match view has three panels, each a builtin under the builtin namespace', () => {
  assert.equal(MATCH_PANELS.length, 3);
  const ids = MATCH_PANELS.map((p) => p.id);
  assert.deepEqual(ids, [MATCH_PANEL_IDS.overview, MATCH_PANEL_IDS.rosters, MATCH_PANEL_IDS.scoreboard]);
  for (const p of MATCH_PANELS) {
    assert.ok(p.id.startsWith(BUILTIN_PREFIX), `${p.id} is in the builtin namespace`);
    assert.ok(BUILTIN_COMPONENTS.some((b) => b.id === p.id), `${p.id} is in the builtin registry`);
  }
});

test('every panel passes the save-time check (runes, valid syntax)', async () => {
  for (const p of MATCH_PANELS) {
    const gate = await gateComponentSave(p.source);
    assert.equal(gate.ok, true, `${p.id}: ${gate.message}`);
  }
});

test('every panel reads through context and mounts nothing else', () => {
  for (const p of MATCH_PANELS) {
    assert.match(p.source, /let \{[^}]*\bcontext\b[^}]*\} = \$props\(\);/, `${p.id} takes context as a prop`);
    assert.match(p.source, /spectra\.metric\(|spectra\.query\(/, `${p.id} reads metrics or facts`);
    assert.doesNotMatch(p.source, /spectra\.Child/, `${p.id} mounts no child`);
    assert.doesNotMatch(p.source, /^\s*import\s/m, `${p.id} imports nothing (builtins are self-contained source)`);
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
