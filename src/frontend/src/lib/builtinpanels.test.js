// builtinpanels.test.js — the Profile view's panels as builtin components
// (dogfood/PLAN C5d; dogfood/04-COMPONENTS.md §1, §7). Three pins:
//   1. the registry (builtins/panels.js) names the Profile component and its
//      six panels, every id sits in the reserved builtin namespace, and each
//      id's component file exists;
//   2. no panel reads a retired preference: the pin, order, hidden, economy,
//      transposed and localStorage keys (owner ruling 33, retired keys listed
//      in dogfood/04 §2), nor the readers of them. Comments are stripped
//      first, so a comment that names a retired key is not a read;
//   3. the surface the panels mount from (PlayerProfile.svelte) reads none of
//      them either.
// Run: node --test src/lib/builtinpanels.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PREFIX } from './componentbuiltins.js';

const LIB = fileURLToPath(new URL('.', import.meta.url));
const PANEL_DIR = path.join(LIB, 'builtins', 'profile');

// The retired preference keys and the readers of them. A panel that names one
// of these in code reads a retired preference (PLAN C5d item 3).
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
  'getPref',
  'setPref',
];

// stripComments removes block comments, HTML comments and line comments. The
// panels hold no URL, so a `//` tail is always a comment.
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

const panelFiles = readdirSync(PANEL_DIR).filter((f) => f.endsWith('.svelte') || f.endsWith('.js'));
const registry = readFileSync(path.join(LIB, 'builtins', 'panels.js'), 'utf8');

test('the registry names the Profile component and six panels, all in the builtin namespace', () => {
  const ids = [...registry.matchAll(/'(builtin-[a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(ids)].sort(),
    [
      'builtin-profile-career',
      'builtin-profile-history',
      'builtin-profile-maps',
      'builtin-profile-sides',
      'builtin-profile-trend',
      'builtin-profile-view',
      'builtin-profile-weapons',
    ],
  );
  for (const id of ids) assert.ok(id.startsWith(BUILTIN_PREFIX), `${id} carries the builtin prefix`);
});

test('every panel component the registry imports exists', () => {
  const imports = [...registry.matchAll(/from '\.\/(profile\/[A-Za-z]+\.svelte)'/g)].map((m) => m[1]);
  assert.equal(imports.length, 7, 'the registry imports the view and its six panels');
  for (const rel of imports) assert.ok(existsSync(path.join(LIB, 'builtins', rel)), `${rel} exists`);
});

test('no panel reads a retired preference key or its reader', () => {
  const hits = [];
  for (const f of panelFiles) {
    const code = stripComments(readFileSync(path.join(PANEL_DIR, f), 'utf8'));
    for (const key of RETIRED) if (code.includes(key)) hits.push(`${f}: ${key}`);
  }
  assert.deepEqual(hits, [], `retired preference reads in the Profile panels: ${hits.join('; ')}`);
  assert.ok(panelFiles.length >= 8, `walked only ${panelFiles.length} panel files — the scan is broken`);
});

test('the Profile surface reads no retired preference either', () => {
  const code = stripComments(readFileSync(path.join(LIB, 'views', 'PlayerProfile.svelte'), 'utf8'));
  const hits = RETIRED.filter((key) => code.includes(key));
  assert.deepEqual(hits, [], `retired preference reads in PlayerProfile.svelte: ${hits.join(', ')}`);
});
