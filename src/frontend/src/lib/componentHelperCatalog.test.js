// componentHelperCatalog.test.js — the completion catalog for user components
// (lib/editor/helperCatalog.js) names exactly the helpers the frame gives a
// component. The prop is built in components/ComponentFrame.svelte and
// componentruntime/readapi.js; this reads those sources, so a helper added to the
// prop without a catalog entry (or a catalog entry left behind after its helper
// goes) fails here, not in a user's editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SPECTRA_HELPERS, UI_PIECES, CONTEXT_FIELDS, componentCompletions } from './editor/helperCatalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const frame = readFileSync(join(here, 'components/ComponentFrame.svelte'), 'utf8');
const readapi = readFileSync(join(here, 'componentruntime/readapi.js'), 'utf8');

// The keys of the object literal that opens at `opener` (its braces balanced).
function literalKeys(src, opener) {
  const start = src.indexOf(opener);
  assert.ok(start >= 0, `${opener} is in the source`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  // Line comments carry commas and parens of their own: drop them before the scan.
  const body = src.slice(from + 1, i).replace(/\/\/.*$/gm, '');
  // Top-level keys only: strip nested braces and parens, then read the identifiers that start a line.
  let flat = '';
  let d = 0;
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === ')' || ch === ']') d--;
    else if (d === 0) flat += ch;
    else flat += ' ';
  }
  const keys = [];
  for (const part of flat.split(',')) {
    const getter = part.trim().match(/^get\s+(\w+)$/); // the parens of a getter's signature are flattened out
    if (getter) keys.push(getter[1]);
    const m = part.trim().match(/^(?:\.\.\.\s*\w+|(\w+)(?:\s*:|\s*$))/);
    if (m && m[1]) keys.push(m[1]);
  }
  return keys;
}

test('the catalog names every helper the spectra prop gives a component', () => {
  // The frame's own keys, plus the read API's (spread into the prop as `...api`).
  const prop = new Set(literalKeys(frame, 'const spectra = Object.freeze({'));
  for (const k of literalKeys(readapi, 'return Object.freeze({')) prop.add(k);
  const names = new Set(SPECTRA_HELPERS.map((h) => h.name));
  for (const k of prop) assert.ok(names.has(k), `spectra.${k} is on the prop but has no completion entry`);
  for (const n of names) assert.ok(prop.has(n), `completion entry spectra.${n} has no helper on the prop`);
});

test('the catalog names every piece under spectra.ui', () => {
  const ui = new Set(literalKeys(frame, 'ui: {'));
  const names = new Set(UI_PIECES.map((p) => p.name));
  assert.deepEqual([...names].sort(), [...ui].sort());
});

// The props a piece takes: the names in its component's $props() destructure.
function propsOf(src) {
  const m = src.match(/let \{([\s\S]*?)\} = \$props\(\);/);
  assert.ok(m, 'the component destructures $props()');
  return m[1]
    .split(',')
    .map((part) => part.trim().match(/^([\w$]+)/))
    .filter(Boolean)
    .map((x) => x[1]);
}

test('each ui piece documents every prop its component takes', () => {
  for (const piece of UI_PIECES) {
    const src = readFileSync(join(here, 'components', piece.name + '.svelte'), 'utf8');
    for (const prop of propsOf(src)) {
      if (prop === 'children') continue; // the doc says "children" once, for every piece with content
      const documented = new RegExp('\\b' + prop + '\\b').test(piece.doc);
      assert.ok(documented, `spectra.ui.${piece.name} takes ${prop} but its catalog entry does not say so`);
    }
  }
});

test('the context fields are the frame’s context keys', () => {
  // The mounting context the frame passes (matchId, steamId, round) is what the catalog offers.
  assert.deepEqual(CONTEXT_FIELDS.map((f) => f.name), ['matchId', 'steamId', 'round']);
});

test('completions follow the cursor: spectra., spectra.ui., context., and the top level', () => {
  const helpers = componentCompletions('  const x = spectra.');
  assert.ok(helpers.some((i) => i.label === 'metric'), 'spectra. offers the helpers');
  assert.ok(!helpers.some((i) => i.label === 'StatCard'), 'spectra. does not offer ui pieces');
  const ui = componentCompletions('<spectra.ui.');
  assert.deepEqual(ui.map((i) => i.label).sort(), UI_PIECES.map((p) => p.name).sort());
  assert.deepEqual(componentCompletions('context.').map((i) => i.label), ['matchId', 'steamId', 'round']);
  const top = componentCompletions('let y = ').map((i) => i.label);
  assert.ok(top.includes('spectra') && top.includes('context'));
});

test('a function helper inserts its call with the first parameter as a tab stop', () => {
  const metric = SPECTRA_HELPERS.find((h) => h.name === 'metric');
  assert.equal(metric.insert, 'metric($1)');
  assert.equal(metric.snippet, true);
  const dash = SPECTRA_HELPERS.find((h) => h.name === 'dash');
  assert.equal(dash.snippet, false, 'a value helper inserts plainly');
});

// Import completions: inside an import's braces the surface's names, after `from '` the one module.
test('import completions offer the surface names inside braces, and the one module after from', async () => {
  const { componentCompletions } = await import('./editor/helperCatalog.js');
  const names = componentCompletions("import { ErrorB").map((i) => i.label);
  assert.ok(names.includes('ErrorBanner'), 'a shared component is offered');
  assert.ok(names.includes('fmt1'), 'an app helper is offered');
  assert.equal(componentCompletions("import X from '")[0].label, 'spectra/helpers');
  assert.equal(componentCompletions("import { fmt1 } from 'sp")[0].label, 'spectra/helpers');
});
