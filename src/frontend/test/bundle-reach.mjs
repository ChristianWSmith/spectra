// bundle-reach.mjs — the jsdom drivers' bundling rule for plain .js modules.
//
// A .js module is bundled (copied into the drivers' cache dir with its
// relative imports rewritten to the bundled copies) only when it reaches a
// .svelte file through its own imports, directly or through other relative
// .js modules: that is the only way the harness can compile the Svelte it
// needs (resolve.js → builtins/panels.js → *.svelte). Every other .js stays
// where it is, so the plain modules keep one instance. Generated modules
// (builtins/generated/…) hold Svelte source as TEXT, so they are never
// bundled, and their text is never read as an import.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { aliasHelpers } from './helpers-alias.mjs';

const reaching = new Map();

export function reachesSvelte(absPath, seen = new Set()) {
  if (absPath.includes('/generated/')) return false;
  // The helper surface's definitions are always bundled: the built-ins reach them through
  // shared.js and the other helper modules, and they must share the bundled services instance
  // the driver scripts (not the real one), even though helperdefs.js itself imports no .svelte.
  if (absPath.endsWith('/src/lib/helperdefs.js')) return true;
  if (reaching.has(absPath)) return reaching.get(absPath);
  if (seen.has(absPath)) return false;
  seen.add(absPath);
  const text = aliasHelpers(readFileSync(absPath, 'utf8'), absPath);
  let hit = /from '[^']*\.svelte'/.test(text);
  // A dynamic import('…') counts like a static one: compile.js loads the helper surface that way.
  for (const m of text.matchAll(/(?:from |import\()'(\.{1,2}\/[^']+)'/g)) {
    if (hit) break;
    const target = resolve(dirname(absPath), m[1]);
    // A runes module (one that uses $state, $derived, $effect or $props) has to be compiled, so a
    // module that imports one is bundled with it. A plain module that imports a runes-free .svelte.js
    // (services.js reads workstate.svelte.js) stays where it is.
    if (target.endsWith('.svelte.js') && /\$(state|derived|effect|props)\b/.test(readFileSync(target, 'utf8').replace(/\/\/.*$/gm, ''))) hit = true;
    if (target.endsWith('.js') && reachesSvelte(target, seen)) hit = true;
  }
  reaching.set(absPath, hit);
  return hit;
}
