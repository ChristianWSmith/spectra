// The user-component compiler (lib/componentruntime/compile.js): the lazy
// compiler boundary, the save-time source check, the runtime-import
// rewrite and the source-keyed cache.
//
// Run: node --test src/lib/componentcompile.test.js   (from frontend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compilerRequested,
  checkComponentSource,
  loadComponent,
  rewriteModule,
  sourceHash,
  RUNTIME_SPECIFIERS,
} from './componentruntime/compile.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// MUST stay the first test: importing the runtime module does not load
// the compiler — only the first compile does.
test('the compiler is not requested until the first compile', async () => {
  assert.equal(compilerRequested(), false);
  const res = await checkComponentSource('<p>hi</p>');
  assert.deepEqual(res, { ok: true });
  assert.equal(compilerRequested(), true);
});

test('no app module imports the compiler statically', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|svelte)$/.test(e.name) && !e.name.endsWith('.test.js')) {
        const text = readFileSync(p, 'utf8');
        if (/(?:^|[\s;])import\s[^('"]*?['"]svelte\/compiler['"]|^\s*import\s*['"]svelte\/compiler['"]/m.test(text)) {
          offenders.push(path.relative(SRC, p));
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], 'svelte/compiler must only be reached by dynamic import (compile.js)');
  const own = readFileSync(path.join(SRC, 'lib/componentruntime/compile.js'), 'utf8');
  assert.match(own, /import\('svelte\/compiler'\)/);
});

test('a syntax error is refused with its line', async () => {
  const res = await checkComponentSource('<script>\n  let x = ;\n</script>\n<p>{x}</p>');
  assert.equal(res.ok, false);
  assert.equal(res.line, 2);
  assert.ok(res.column > 0);
  assert.ok(res.message.length > 0 && !res.message.includes('\n'), res.message);
});

test('a markup error is refused with its line', async () => {
  const res = await checkComponentSource('<div>\n  <p>\n{#if}\n</div>');
  assert.equal(res.ok, false);
  assert.equal(res.line, 3);
});

test('an import outside the runtime is refused at its own line', async () => {
  const res = await checkComponentSource(
    "<script>\n  import { onMount } from 'svelte';\n  import x from './other.js';\n</script>\n<p>{x}</p>",
  );
  assert.equal(res.ok, false);
  assert.equal(res.line, 3);
  assert.match(res.message, /\.\/other\.js/);
});

test('public svelte imports are allowed', async () => {
  const res = await checkComponentSource(
    "<script>\n  import { onMount } from 'svelte';\n  import { fade as f } from 'svelte/transition';\n  onMount(() => {});\n</script>\n<p transition:f>x</p>",
  );
  assert.deepEqual(res, { ok: true });
});

test('rewriteModule turns every import form into a registry lookup', () => {
  const js = [
    "import 'svelte/internal/disclose-version';",
    "import 'svelte/internal/flags/legacy';",
    "import * as $ from 'svelte/internal/client';",
    'import { onMount, tick as t } from "svelte";',
    "import {\n  fade,\n  fly\n} from 'svelte/transition';",
    '',
    'var root = $.from_html(`<p>import x from "y"</p>`);',
    'export const k = 1;',
    'export default function C($$anchor) {}',
  ].join('\n');
  const { body, specs } = rewriteModule(js);
  assert.deepEqual(specs, [
    'svelte/internal/disclose-version',
    'svelte/internal/flags/legacy',
    'svelte/internal/client',
    'svelte',
    'svelte/transition',
  ]);
  assert.ok(!/^\s*import\s/m.test(body), body);
  assert.ok(!/^\s*export\s/m.test(body), body);
  assert.match(body, /const \$ = __runtime\["svelte\/internal\/client"\];/);
  assert.match(body, /const \{ onMount, tick: t \} = __runtime\["svelte"\];/);
  assert.match(body, /const \{ fade, fly \} = __runtime\["svelte\/transition"\];/);
  assert.match(body, /import x from "y"/); // markup text is never rewritten
  assert.match(body, /return __default;\s*$/);
});

test('rewriteModule refuses a specifier outside the registry', () => {
  assert.throws(
    () => rewriteModule("import x from 'node:fs';\nexport default function C() {}"),
    (e) => e.unknownSpecifier === 'node:fs',
  );
  assert.ok(RUNTIME_SPECIFIERS.includes('svelte/internal/flags/async'));
});

test('compiled modules are cached by source', async () => {
  const a = '<p>cache a</p>';
  const p1 = loadComponent(a);
  const p2 = loadComponent(a);
  assert.equal(p1, p2, 'same source → the same compile');
  const C = await p1;
  assert.equal(typeof C, 'function');
  assert.notEqual(loadComponent('<p>cache b</p>'), p1);
  assert.equal(sourceHash(a), sourceHash(String(a)));
  assert.notEqual(sourceHash(a), sourceHash('<p>cache b</p>'));
});

test('a refused source rejects with its line and stays refused', async () => {
  const bad = '<script>\n\n  let = 1;\n</script>';
  await assert.rejects(loadComponent(bad), (e) => e.name === 'ComponentSourceError' && e.line === 3);
  await assert.rejects(loadComponent(bad), (e) => e.line === 3);
});
