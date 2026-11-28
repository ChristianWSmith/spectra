// copy-closure.mjs — the shared copy step of the jsdom drivers.
//
// A driver mounts app components in node from a cache directory of copied modules
// (node_modules/.cache/spectra-dom-tests/<driver>/). Hand-written copy lists drift as
// the app's modules gain imports, so the copy is computed instead: copyClosure walks
// every relative import from the entry modules, under src/lib, and writes each reached
// module into the cache dir with its relative layout intact.
//
//   - .js            copied verbatim (its relative imports stay valid in the same layout)
//   - .svelte        compiled to runes client output as <name>.js; an import of
//                    './Name.svelte' is rewritten to './Name.js' so it resolves to the copy
//   - .svelte.js     compiled as a rune module, same name
//
// `skip` maps a src/lib-relative path (e.g. 'services.js') to text the driver writes
// itself (a scripted stub). A skipped module is not walked further. Anything outside
// src/lib (bindings, node modules) is left to the driver's own resolve hooks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { compile, compileModule } from 'svelte/compiler';
import { aliasHelpers } from './helpers-alias.mjs';

const SRC = 'src/lib';
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;

// The copy's own path for a src-relative module: .svelte becomes .js.
// serviceStub: an ESM module with the same named exports as services.js, each a no-op read.
function serviceStub(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export (?:async )?(function|const|let) (\w+)/gm)) names.add(m[2] + ':' + m[1]);
  for (const m of src.matchAll(/^export \{([^}]*)\}/gm)) for (const p of m[1].split(',')) { const n = p.trim().split(/\s+as\s+/).pop(); if (n) names.add(n + ':const'); }
  const out = [];
  for (const entry of names) {
    const [n, kind] = entry.split(':');
    // errText is a synchronous pure helper (the frame renders its result), not a read.
    if (n === 'errText') out.push("export function errText(e) { return e == null ? '' : String((e && e.message) || e); }");
    else out.push(kind === 'function' ? `export function ${n}() { return Promise.resolve(null); }` : `export const ${n} = null;`);
  }
  return out.join('\n') + '\n';
}

// fillServiceStub completes a driver's scripted services.js: every real export the script does not
// declare is added as a no-op, so a module that imports a name the script never scripted still links.
export function fillServiceStub(scripted, realSrc) {
  // Any declaration of a name counts (exported or not): a second one would not link.
  const declared = new Set([...scripted.matchAll(/^\s*(?:export )?(?:async )?(?:function|const|let) (\w+)/gm)].map((m) => m[1]));
  const missing = serviceStub(realSrc).split('\n').filter((line) => {
    const m = line.match(/^export (?:function|const) (\w+)/);
    return m && !declared.has(m[1]);
  });
  return scripted + '\n' + missing.join('\n') + '\n';
}

const outRel = (rel) => (rel.endsWith('.svelte') ? rel.slice(0, -'.svelte'.length) + '.js' : rel);

export function copyClosure({ dir, entries, skip = new Map() }) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = posix.normalize(queue.shift());
    if (seen.has(rel)) continue;
    seen.add(rel);
    const dest = join(dir, outRel(rel));
    mkdirSync(dirname(dest), { recursive: true });
    if (skip.has(rel)) {
      writeFileSync(dest, skip.get(rel));
      continue;
    }
    const abs = join(SRC, rel);
    if (!existsSync(abs)) throw new Error(`copyClosure: ${abs} does not exist`);
    // services.js reaches the Wails bindings, which a node driver cannot load. Unless a driver
    // scripts it, the copy is a stub with the real export names: every function answers with null.
    if (rel === 'services.js') {
      writeFileSync(dest, serviceStub(readFileSync(abs, 'utf8')));
      continue;
    }
    const text = aliasHelpers(readFileSync(abs, 'utf8'), abs);
    // Walk the relative imports (only those that stay under src/lib). The generated builtin
    // sources hold panel code as TEXT (JSON strings), so they are copied, never walked.
    const generatedText = rel.startsWith('builtins/generated/');
    if (!generatedText) {
      for (const m of text.matchAll(IMPORT)) {
        const target = posix.normalize(posix.join(posix.dirname(rel), m[2]));
        if (target.startsWith('..')) continue;
        queue.push(target);
      }
    }
    const filename = abs;
    if (rel.endsWith('.svelte')) {
      // Rewrite the import of a sibling .svelte to its copy (.js) before compiling.
      const src = text.replace(/(['"])(\.{1,2}\/[^'"]+)\.svelte\1/g, (_, q, p) => `${q}${p}.js${q}`);
      writeFileSync(dest, compile(src, { filename, generate: 'client', css: 'injected', runes: true }).js.code);
    } else if (rel.endsWith('.svelte.js')) {
      writeFileSync(dest, compileModule(text, { filename, generate: 'client' }).js.code);
    } else {
      // A plain module: a sibling import of a .svelte names its compiled copy.
      writeFileSync(dest, text.replace(/(['"])(\.{1,2}\/[^'"]+)\.svelte\1/g, (_, q, p) => `${q}${p}.js${q}`));
    }
  }
  return dir;
}
