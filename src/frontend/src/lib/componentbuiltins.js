// The builtin component registry: every component shipped with the app,
// as Svelte source. A builtin is edited in place
// (ruling 43): the Component builder loads it, and Save stores an override of
// that builtin. A built-in is edited in place; there is no copy action.
//
// Ids live in a reserved namespace: every id starts with BUILTIN_PREFIX
// (the Go twin is componentservice.go BuiltinComponentPrefix, which
// refuses that prefix on a user component name), so a placement's
// component reference is a builtin id or a user name, never both.
// componentbuiltins.test.js pins the prefix and that every source passes
// the save-time check.
//
// The registry holds the placeholder (`placeholder: true`, shown with a
// placeholder chip), every
// compiled builtin the registry declares (builtins/panels.js: the Profile,
// Reports, Explorer, Match-tab, Economy and Utility components). The compiled ones are listed from the generated
// module's id list (builtins/generated/sources.js, written by
// scripts/gen-builtin-sources.mjs from panels.js), so no id is kept here by
// hand. Every builtin is mounted from its source like a user component
// (ComponentFrame's `source`), so its source text here is the default that
// Restore to default returns to.

import * as S from './strings/index.js';
import { PANEL_IDS, PANEL_SOURCES, PANEL_DIRS } from './builtins/generated/sources.js';


// The placeholder's source: Svelte 5, reading only through the read API
// it receives (`spectra`) and its read-only `context` prop (04 §3): the
// query's :match_id bind defaults from the context, so no value is written
// into the SQL here.

// The compiled registry entries: each listed by its id, labelled from the
// string catalog, with the source the build embedded for it.
const COMPILED_COMPONENTS = PANEL_IDS.map((id) =>
  Object.freeze({
    id,
    label: id,
    source: PANEL_SOURCES[id],
  }),
);

function registryList(entries) {
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) throw new Error(`componentbuiltins: builtin ${e.id} is registered twice`);
    seen.add(e.id);
  }
  return Object.freeze(entries);
}

export const BUILTIN_COMPONENTS = registryList([
  // The Match view's panels. Each is mounted
  // by the Match view with its context.
  // The compiled registry: the Profile, Reports, Explorer, Match-tab, Economy
  // and Utility components and their panels (builtins/panels.js).
  ...COMPILED_COMPONENTS,
]);

// isBuiltinId reports whether a placement's component reference names a
// shipped builtin.
export function isBuiltinId(id) {
  return BUILTIN_COMPONENTS.some((b) => b.id === id);
}

export function builtinById(id) {
  return BUILTIN_COMPONENTS.find((b) => b.id === id) || null;
}

// builtinShippedSource is the Svelte source a builtin ships with: its text
// here, or for a compiled builtin panel the text the build embedded
// (builtins/generated/sources.js, written by scripts/gen-builtin-sources.mjs).
// "Restore to default" and an unedited builtin's editor read this.
// builtinSourceDir is the frontend-relative directory a built-in's source
// lives in (its relative imports resolve against it), or null when the id is
// not a built-in. The registry's own components live in src/lib.
export function builtinSourceDir(id) {
  if (Object.hasOwn(PANEL_DIRS, id)) return PANEL_DIRS[id];
  return builtinById(id) ? 'src/lib' : null;
}

export function builtinShippedSource(id) {
  const b = builtinById(id);
  if (b) return b.source;
  return Object.hasOwn(PANEL_SOURCES, id) ? PANEL_SOURCES[id] : null;
}
