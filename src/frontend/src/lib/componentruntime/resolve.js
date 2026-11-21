// What a component reference mounts (dogfood/04-COMPONENTS.md §2, §3.5;
// owner ruling 43). A reference is a builtin id (builtin-…) or a user
// component's name. The result is exactly one of:
//   {component, dir}  a compiled builtin panel (app Svelte the bundler compiled)
//   {source, dir}     Svelte 5 source to compile: an edited builtin, a text
//                     builtin, or a user component (dir null)
//   null              no such component
// `dir` is the built-in's source directory (componentbuiltins.builtinSourceDir)
// so an edited or text built-in compiles with the built-in rules (ruling 45);
// null for a user component.
//
// An edited builtin (builtin_overrides, ruling 43) wins over its shipped
// code wherever the builtin is mounted: the override's source is compiled
// and mounted in place of the shipped component.
import { BUILTIN_PREFIX, builtinById, builtinSourceDir } from '../componentbuiltins.js';
import { builtinPanelById } from '../builtins/panels.js';
import { listComponents, listBuiltinOverrides } from '../services.js';

export async function resolveComponentRef(name) {
  if (String(name).startsWith(BUILTIN_PREFIX)) {
    const dir = builtinSourceDir(name);
    const overrides = (await listBuiltinOverrides()) || [];
    const hit = overrides.find((o) => o && o.id === name);
    if (hit) return { component: null, source: hit.source, dir };
    const panel = builtinPanelById(name);
    if (panel) return { component: panel, source: null, dir };
    const b = builtinById(name);
    return b ? { component: null, source: b.source, dir } : null;
  }
  const rows = (await listComponents()) || [];
  const hit = rows.find((c) => c && c.name === name);
  return hit ? { component: null, source: hit.source, dir: null } : null;
}
