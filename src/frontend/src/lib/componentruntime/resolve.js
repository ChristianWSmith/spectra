// What a component reference mounts (dogfood/04-COMPONENTS.md §2, §3.5;
// owner ruling 43). A reference is a builtin id (builtin-…) or a user
// component's name. The result is exactly one of:
//   {component}  a compiled builtin panel (app Svelte the bundler compiled)
//   {source}     Svelte 5 source to compile (a user component, an edited
//                builtin, or a text builtin)
//   null         no such component
//
// An edited builtin (builtin_overrides, ruling 43) wins over its shipped
// code wherever the builtin is mounted: the override's source is compiled
// and mounted in place of the shipped component.
import { BUILTIN_PREFIX, builtinById } from '../componentbuiltins.js';
import { builtinPanelById } from '../builtins/panels.js';
import { listComponents, listBuiltinOverrides } from '../services.js';

export async function resolveComponentRef(name) {
  if (String(name).startsWith(BUILTIN_PREFIX)) {
    const overrides = (await listBuiltinOverrides()) || [];
    const hit = overrides.find((o) => o && o.id === name);
    if (hit) return { component: null, source: hit.source };
    const panel = builtinPanelById(name);
    if (panel) return { component: panel, source: null };
    const b = builtinById(name);
    return b ? { component: null, source: b.source } : null;
  }
  const rows = (await listComponents()) || [];
  const hit = rows.find((c) => c && c.name === name);
  return hit ? { component: null, source: hit.source } : null;
}
