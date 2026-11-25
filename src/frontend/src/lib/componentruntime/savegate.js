// The save gate for user components. Every
// path that stores a component source runs through gateComponentSave:
// the Component builder's live check (the Save button's enabled state)
// and services.js saveComponent (the write itself) both call it, so no
// caller can store a source the gate refuses.
//
// Today the gate is the syntax check (compile.js checkComponentSource).
// The metric and table gate joins HERE, after the syntax check, and no
// other module decides what a saved component may read.

import * as S from '../strings/index.js';
import { checkComponentSource } from './compile.js';

// gateComponentSave resolves {ok: true} or {ok: false, line, column,
// message}: the refusal is the author's to fix, and message is the bare
// reason (refusalText positions it).
// `builtinDir` (frontend-relative directory of a built-in's source, or null
// for a user component) selects the built-in rules: its relative imports are
// curated helpers (compile.js BUILTIN_HELPERS, ruling 45).
export function gateComponentSave(source, builtinDir = null, opts = {}) {
  return checkComponentSource(source, 'Component.svelte', builtinDir, opts);
}

// refusalText is the one user-facing sentence for a refused gate result:
// the reason, positioned by its line when the source gave one.
export function refusalText(result) {
  if (!result || result.ok) return '';
  return result.line > 0
    ? S.fill(S.components.sourceAtLine, { line: result.line, err: result.message })
    : result.message;
}
