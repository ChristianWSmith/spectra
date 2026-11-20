// The user-component compiler: Svelte 5 source → a mountable component,
// in the webview, lazily (dogfood/04-COMPONENTS.md §5).
//
// - `svelte/compiler` is loaded by DYNAMIC import on the first compile —
//   never at launch. Nothing else in src/ may import it statically
//   (compile.test.js pins that), so the bundler keeps it in its own chunk.
// - The compiler's output imports Svelte's runtime by bare specifier,
//   which a module evaluated from a string cannot resolve. rewriteModule
//   turns every import into a lookup in ONE registry (RUNTIME_MODULES)
//   that hands back the app's OWN runtime instance, so user and app
//   components share reactivity, context and the scheduler. The registry
//   loaders are dynamic imports too: a flags module (`flags/legacy`,
//   `flags/async`) flips a runtime flag when evaluated, so it is evaluated
//   only when a compiled module actually imports it — the same moment
//   ESM would have evaluated it.
// - Compiled modules are cached in memory, keyed by a hash of the source
//   (the entry keeps the source and a hit compares it, so a collision can
//   never mount the wrong component). Only source is ever stored.
// - checkComponentSource is the save-time check: compile + rewrite, no
//   evaluation, the answer {ok, line, column, message}. Runtime failures
//   are the frame's job (ComponentFrame.svelte), not this module's.
//
// Builtin components are app source compiled by the bundler; they never
// pass through here.

import * as S from '../strings/index.js';

// The registry: every specifier a compiled user module may import. The
// runes-only compile emits client and disclose-version (flags/async only
// in async mode); flags/legacy is kept for the legacy-mode runtime but no
// runes output imports it. The public svelte modules are what a user's
// own <script> may import. Anything else is refused at check time.
const RUNTIME_MODULES = {
  'svelte/internal/client': () => import('svelte/internal/client'),
  'svelte/internal/disclose-version': () => import('svelte/internal/disclose-version'),
  'svelte/internal/flags/legacy': () => import('svelte/internal/flags/legacy'),
  'svelte/internal/flags/async': () => import('svelte/internal/flags/async'),
  svelte: () => import('svelte'),
  'svelte/animate': () => import('svelte/animate'),
  'svelte/easing': () => import('svelte/easing'),
  'svelte/events': () => import('svelte/events'),
  'svelte/motion': () => import('svelte/motion'),
  'svelte/reactivity': () => import('svelte/reactivity'),
  'svelte/store': () => import('svelte/store'),
  'svelte/transition': () => import('svelte/transition'),
};

export const RUNTIME_SPECIFIERS = Object.freeze(Object.keys(RUNTIME_MODULES));

// --- lazy compiler ----------------------------------------------------------

let compilerPromise = null;

function loadCompiler() {
  if (!compilerPromise) {
    compilerPromise = import('svelte/compiler');
    // A failed load must not poison every later attempt.
    compilerPromise.catch(() => {
      compilerPromise = null;
    });
  }
  return compilerPromise;
}

// compilerRequested reports whether the compiler module has been asked
// for in this process — false until the first user-component compile
// (the "not loaded at launch" pin reads it).
export function compilerRequested() {
  return compilerPromise !== null;
}

// --- errors -----------------------------------------------------------------

// ComponentSourceError is a refusal of the SOURCE (a compile error or an
// import the registry cannot provide), positioned by 1-based line/column
// (0 when the position is unknown). Its message is already user-facing.
export class ComponentSourceError extends Error {
  constructor(message, line, column) {
    super(line > 0 ? S.fill(S.components.sourceAtLine, { line, err: message }) : message);
    this.name = 'ComponentSourceError';
    this.detail = message;
    this.line = line;
    this.column = column;
  }
}

// The compiler's message carries a trailing documentation link line —
// keep the sentence only.
function compilerMessage(e) {
  return String((e && e.message) || e).split('\n')[0].trim();
}

// Position of the first occurrence of a quoted specifier in the source,
// so an import refusal points at its own line.
function specifierPosition(source, spec) {
  for (const q of ["'", '"']) {
    const i = source.indexOf(q + spec + q);
    if (i >= 0) {
      const before = source.slice(0, i);
      const line = before.split('\n').length;
      return { line, column: i - before.lastIndexOf('\n') - 1 };
    }
  }
  return { line: 0, column: 0 };
}

// --- the rewrite (pure) ------------------------------------------------------

// rewriteModule turns the compiler's ESM output into a function body that
// takes `__runtime` (specifier → module namespace) and returns the
// component. Returns {body, specs} with specs in import order, or throws
// {unknownSpecifier} for an import outside the registry. Only the leading
// import block is rewritten (the compiler hoists every import there), so
// markup text that happens to start a line with "import" is never touched.
export function rewriteModule(js, known = RUNTIME_SPECIFIERS) {
  const allowed = new Set(known);
  const specs = [];
  const head = [];
  let rest = js;
  // Leading import statements, one at a time (a statement may wrap lines).
  // A clause never contains a quote or a semicolon, so a match can never
  // run on into the next statement.
  const BARE = /^\s*import\s*(['"])([^'"]+)\1\s*;?[ \t]*(?:\r?\n|$)/;
  const FROM = /^\s*import\s*([^'";]*?)\s*from\s*(['"])([^'"]+)\2\s*;?[ \t]*(?:\r?\n|$)/;
  for (;;) {
    let whole;
    let clause = '';
    let spec;
    const bare = rest.match(BARE);
    const from = bare ? null : rest.match(FROM);
    if (bare) [whole, , spec] = bare;
    else if (from) [whole, clause, , spec] = from;
    else break;
    if (!allowed.has(spec)) {
      const err = new Error('unknown runtime import: ' + spec);
      err.unknownSpecifier = spec;
      throw err;
    }
    if (!specs.includes(spec)) specs.push(spec);
    const ref = `__runtime[${JSON.stringify(spec)}]`;
    if (clause) head.push(importBinding(clause.trim(), ref));
    rest = rest.slice(whole.length);
  }
  let body = rest
    .replace(/^export\s+default\s+function\b/m, 'const __default = function')
    .replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');
  if (!/const __default = function/.test(body)) {
    throw new Error('compiled module has no default component export');
  }
  body = head.join('\n') + '\n' + body + '\nreturn __default;\n';
  return { body, specs };
}

// importBinding renders one import clause as a const over the registry
// entry: `* as $`, `{ a, b as c }`, `def`, and `def, { a }` / `def, * as ns`.
function importBinding(clause, ref) {
  const out = [];
  let c = clause;
  const def = c.match(/^([\w$]+)\s*(?:,\s*|$)/);
  if (def) {
    out.push(`const ${def[1]} = ${ref}.default;`);
    c = c.slice(def[0].length).trim();
  }
  if (c.startsWith('*')) {
    const ns = c.match(/^\*\s*as\s+([\w$]+)$/);
    if (!ns) throw new Error('unsupported import clause: ' + clause);
    out.push(`const ${ns[1]} = ${ref};`);
  } else if (c.startsWith('{')) {
    const inner = c.replace(/^\{|\}$/g, '').trim();
    const parts = inner
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const m = p.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (!m) throw new Error('unsupported import clause: ' + clause);
        return m[2] ? `${m[1]}: ${m[2]}` : m[1];
      });
    out.push(`const { ${parts.join(', ')} } = ${ref};`);
  } else if (c) {
    throw new Error('unsupported import clause: ' + clause);
  }
  return out.join('\n');
}

// --- compile + check ---------------------------------------------------------

// User components are runes-only (owner, 2026-11-20): every compile runs
// with `runes: true`, so legacy syntax (`export let`, `$:`, `$$props`, …)
// is a compile error at its own line. Builtins get the same mode from
// svelte.config.js (compilerOptions.runes).
const COMPILE_OPTIONS = { generate: 'client', css: 'injected', dev: false, runes: true };

// Legacy forms the runes-mode compiler only WARNS about (it still
// compiles them): refused like the legacy_* errors, so runes-only holds
// for every legacy form, not just the ones that fail to compile.
const LEGACY_WARNINGS = new Set([
  'event_directive_deprecated', // on:click
  'slot_element_deprecated', // <slot>
  'script_context_deprecated', // <script context="module">
  'svelte_component_deprecated', // <svelte:component>
  'svelte_self_deprecated', // <svelte:self>
]);

// legacyRefusal words a legacy-syntax refusal through the catalog.
function legacyRefusal(e) {
  return new ComponentSourceError(
    S.fill(S.components.legacyRefused, { err: compilerMessage(e) }),
    (e.start && e.start.line) || 0,
    (e.start && e.start.column) || 0,
  );
}

// compileSource compiles and rewrites; throws ComponentSourceError for
// anything the author must fix.
async function compileSource(source, filename) {
  const { compile } = await loadCompiler();
  let js;
  try {
    const out = compile(String(source), { ...COMPILE_OPTIONS, filename });
    const legacy = (out.warnings || []).find((w) => LEGACY_WARNINGS.has(w.code));
    if (legacy) throw legacyRefusal(legacy);
    js = out.js.code;
  } catch (e) {
    if (e instanceof ComponentSourceError) throw e;
    if (e && typeof e.code === 'string' && e.code.startsWith('legacy_')) throw legacyRefusal(e);
    const start = (e && e.start) || {};
    throw new ComponentSourceError(compilerMessage(e), start.line || 0, start.column || 0);
  }
  try {
    return rewriteModule(js);
  } catch (e) {
    if (e && e.unknownSpecifier) {
      const pos = specifierPosition(String(source), e.unknownSpecifier);
      throw new ComponentSourceError(
        S.fill(S.components.importRefused, { name: e.unknownSpecifier }),
        pos.line,
        pos.column,
      );
    }
    throw new ComponentSourceError(compilerMessage(e), 0, 0);
  }
}

// checkComponentSource is the save-time syntax check: compile + rewrite
// without evaluating anything. {ok: true} or {ok: false, line, column,
// message} (line/column 1-based, 0 when unknown; message is the bare
// reason — the caller positions it).
export async function checkComponentSource(source, filename = 'Component.svelte') {
  try {
    await compileSource(source, filename);
    return { ok: true };
  } catch (e) {
    if (e instanceof ComponentSourceError) {
      return { ok: false, line: e.line, column: e.column, message: e.detail };
    }
    throw e;
  }
}

// --- load + cache ------------------------------------------------------------

// sourceHash: two independent 32-bit FNV-1a lanes + the length — a cache
// KEY, not an integrity check (the entry's source is compared on a hit).
export function sourceHash(source) {
  const s = String(source);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + s.length.toString(16);
}

const cache = new Map(); // hash -> {source, promise}

// loadComponent resolves to the mountable component for `source`
// (compiled once per distinct source per process). A source refusal
// rejects with ComponentSourceError; a module-evaluation error rejects
// with the thrown error. Source refusals stay cached (the same source
// fails the same way); any other failure (the compiler chunk did not
// load, the module threw while evaluating) is dropped so the next mount
// retries.
export function loadComponent(source, filename = 'Component.svelte') {
  const key = sourceHash(source);
  const hit = cache.get(key);
  if (hit && hit.source === source) return hit.promise;
  const promise = (async () => {
    const { body, specs } = await compileSource(source, filename);
    const runtime = {};
    // Sequential, in import order: evaluation order matters for the
    // flag modules exactly as it would under ESM.
    for (const spec of specs) runtime[spec] = await RUNTIME_MODULES[spec]();
    return new Function('__runtime', body)(runtime);
  })();
  cache.set(key, { source, promise });
  promise.catch((e) => {
    if (e instanceof ComponentSourceError) return;
    const entry = cache.get(key);
    if (entry && entry.promise === promise) cache.delete(key);
  });
  return promise;
}

// resetComponentCache empties the compiled-module cache (tests).
export function resetComponentCache() {
  cache.clear();
}
