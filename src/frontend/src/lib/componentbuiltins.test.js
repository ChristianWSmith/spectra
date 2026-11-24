import '../../test/compile-worker-node.mjs';
// componentbuiltins.test.js — the built-in component registry
// (componentbuiltins.js): every id sits in the reserved builtin namespace
// (the Go twin refuses that prefix on a user name), and every shipped source
// passes the save gate under its built-in rules (ruling 45).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUILTIN_COMPONENTS, builtinById, builtinShippedSource, builtinSourceDir, isBuiltinId } from './componentbuiltins.js';
import { gateComponentSave } from './componentruntime/savegate.js';
import { componentbuilder } from './strings/componentbuilder.js';
import { panelRegistry } from '../../scripts/gen-builtin-sources.mjs';

const REGISTRY = panelRegistry(readFileSync(new URL('./builtins/panels.js', import.meta.url), 'utf8')).map((e) => e.id);
const PROFILE_IDS = [
  'profile',
  'profile-career',
  'profile-trend',
  'profile-sides',
  'profile-maps',
  'profile-weapons',
  'profile-history',
];

test('every built-in id is in the reserved namespace and resolves back to itself', () => {
  assert.ok(BUILTIN_COMPONENTS.length > 0, 'the registry is not empty');
  for (const b of BUILTIN_COMPONENTS) {
    assert.ok(isBuiltinId(b.id), `${b.id} carries the built-in prefix`);
    assert.equal(builtinById(b.id), b);
    assert.equal(isBuiltinId(b.id), true);
  }
  assert.equal(isBuiltinId('mine'), false);
  assert.equal(builtinById('builtin-missing'), null);
});

// A built-in is checked under the built-in rules (its curated helper imports,
// ruling 45): the gate gets its source directory. A user copy of a panel that
// imports a helper would be refused at save, which is why no Duplicate is
// offered for a builtin (ruling 43).
test('every built-in source passes the save gate under its built-in rules', async () => {
  for (const b of BUILTIN_COMPONENTS) {
    const gate = await gateComponentSave(b.source, builtinSourceDir(b.id));
    assert.equal(gate.ok, true, `${b.id}: ${gate.message}`);
  }
});

// (a) every id the registry (builtins/panels.js) declares is listed exactly
// once, and the list holds no id the registry does not declare beyond the
// placeholder.
test('every registry id is listed in BUILTIN_COMPONENTS exactly once', () => {
  const listed = BUILTIN_COMPONENTS.map((b) => b.id);
  assert.equal(new Set(listed).size, listed.length, 'no id is listed twice');
  assert.equal(REGISTRY.length, 27, 'the registry declares 27 compiled builtins');
  for (const id of REGISTRY) {
    assert.equal(listed.filter((x) => x === id).length, 1, `${id} is listed exactly once`);
  }
});

// (b) the Profile view and its six panels (seven ids) are listed with labels.
test('the Profile view and each of its panels is listed, labelled from the catalog', () => {
  assert.equal(PROFILE_IDS.length, 7);
  for (const id of PROFILE_IDS) {
    const b = builtinById(id);
    assert.ok(b, `${id} is listed`);
    assert.equal(b.label, id, `${id} is named by its id`);
  }
});

// (c) every listed builtin has shipped source and a source directory, so the
// editor can open it, restore it and compile it with the built-in rules.
test('every listed builtin has shipped source and a source directory', () => {
  for (const b of BUILTIN_COMPONENTS) {
    const shipped = builtinShippedSource(b.id);
    assert.equal(typeof shipped, 'string', `${b.id} has shipped source`);
    assert.ok(shipped.trim().length > 0, `${b.id} source is not empty`);
    assert.equal(builtinSourceDir(b.id) === null, false, `${b.id} has a source directory`);
  }
});

// The store seeds every builtin name (schema.sql): the seeds and the registry must name the same
// components, or a builtin could be refused by the store or missing from it.
test('the seeded builtin components in schema.sql are exactly the registry ids', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const schema = readFileSync(fileURLToPath(new URL('../../../internal/store/schema.sql', import.meta.url)), 'utf8');
  const seeded = [...schema.matchAll(/INSERT OR IGNORE INTO components \(name, source, origin, created_at, updated_at\) VALUES \('([^']+)', '', 'builtin'/g)].map((m) => m[1]);
  assert.deepEqual([...seeded].sort(), BUILTIN_COMPONENTS.map((b) => b.id).sort());
});
