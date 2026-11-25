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

const SRC = 'src/lib';
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;

// The copy's own path for a src-relative module: .svelte becomes .js.
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
    const text = readFileSync(abs, 'utf8');
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
