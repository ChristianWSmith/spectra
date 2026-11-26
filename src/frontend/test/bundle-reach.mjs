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

const reaching = new Map();

export function reachesSvelte(absPath, seen = new Set()) {
  if (absPath.includes('/generated/')) return false;
  if (reaching.has(absPath)) return reaching.get(absPath);
  if (seen.has(absPath)) return false;
  seen.add(absPath);
  const text = readFileSync(absPath, 'utf8');
  let hit = /from '[^']*\.svelte'/.test(text);
  for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
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
