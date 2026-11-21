import '../../test/compile-worker-node.mjs';
// componentbuiltins.test.js — the built-in component registry
// (componentbuiltins.js): every id sits in the reserved builtin namespace
// (the Go twin refuses that prefix on a user name), and every shipped source
// passes the save gate, so Duplicate never saves a refused copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_COMPONENTS, BUILTIN_PREFIX, builtinById, builtinSourceDir, isBuiltinId } from './componentbuiltins.js';
import { gateComponentSave } from './componentruntime/savegate.js';

test('every built-in id is in the reserved namespace and resolves back to itself', () => {
  assert.ok(BUILTIN_COMPONENTS.length > 0, 'the registry is not empty');
  for (const b of BUILTIN_COMPONENTS) {
    assert.ok(b.id.startsWith(BUILTIN_PREFIX), `${b.id} carries the built-in prefix`);
    assert.equal(builtinById(b.id), b);
    assert.equal(isBuiltinId(b.id), true);
  }
  assert.equal(isBuiltinId('mine'), false);
  assert.equal(builtinById('builtin-missing'), null);
});

// A built-in is checked under the built-in rules (its curated helper imports,
// ruling 45): the gate gets its source directory. A panel that imports a helper
// is refused as a user copy, so a Duplicate of it is refused at save.
test('every built-in source passes the save gate under its built-in rules', async () => {
  for (const b of BUILTIN_COMPONENTS) {
    const gate = await gateComponentSave(b.source, builtinSourceDir(b.id));
    assert.equal(gate.ok, true, `${b.id}: ${gate.message}`);
  }
});
