// The compile core: the one
// place svelte/compiler runs. It has NO app imports, so the same code runs
// in the compile Web Worker (compile.worker.js) and in the node worker the
// jsdom tests install (test/compile-worker-node-entry.mjs).
//
// - svelte/compiler is loaded by DYNAMIC import on the first compile, inside
//   the worker — never on the main thread, never at launch.
// - compileReply takes {id, source, filename} and resolves a plain reply:
//     {id, ok: true, js}                       the compiled ESM (client)
//     {id, ok: false, legacy, message, line, column}
//   `legacy` marks a legacy-syntax refusal (runes-only, 04 §5). The import
//   rewrite, the registry and the refusal wording stay in compile.js on the
//   calling thread; this module only reports what the compiler said.
// - Compile output is never stored here or anywhere: the reply is consumed
//   once by compile.js, which caches the mounted module in memory.

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

// componentRefs reads the references a component source makes to other user items from its
// parsed template and script: the `name` of a spectra.Child tag, and the name argument of a
// spectra.metric(...) call. parse is the svelte/compiler parser. A reference whose name is not a
// string literal cannot be tracked by name: it is listed in `untracked` (message and position),
// and the save gate decides what that means (a user component is refused; a builtin is curated).
export function componentRefs(parse, source) {
  const text = String(source);
  const ast = parse(text, { modern: true });
  const components = new Set();
  const metrics = new Set();
  const untracked = [];
  const refuse = (node, message) => {
    const before = text.slice(0, node.start || 0);
    const line = before.split('\n').length;
    const column = before.length - before.lastIndexOf('\n') - 1;
    untracked.push({ message, line, column });
  };
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (n.type === 'Component' && n.name === 'spectra.Child') {
      const name = childNameLiteral(n);
      if (name === null) refuse(n, CHILD_UNTRACKED);
      else components.add(name);
    }
    if (n.type === 'CallExpression' && isSpectraMetricCallee(n.callee)) {
      const arg = n.arguments && n.arguments[0];
      if (arg && arg.type === 'Literal' && typeof arg.value === 'string') metrics.add(arg.value);
      else refuse(n, METRIC_UNTRACKED);
    }
    for (const k of Object.keys(n)) {
      if (k !== 'metadata' && k !== 'parent') visit(n[k]);
    }
  };
  visit(ast);
  return { refs: { components: [...components], metrics: [...metrics], untracked } };
}

const CHILD_UNTRACKED = 'spectra.Child needs its name as a string, so the reference can be tracked';
const METRIC_UNTRACKED = 'spectra.metric needs its name as a string, so the reference can be tracked';

// childNameLiteral is the string a Child tag names, or null when it is not a literal.
function childNameLiteral(node) {
  const attr = (node.attributes || []).find((a) => a.type === 'Attribute' && a.name === 'name');
  if (!attr) return null;
  const v = attr.value;
  if (Array.isArray(v) && v.length === 1 && v[0].type === 'Text') return v[0].data;
  if (v && !Array.isArray(v) && v.type === 'ExpressionTag' && v.expression.type === 'Literal' && typeof v.expression.value === 'string') {
    return v.expression.value;
  }
  return null;
}

function isSpectraMetricCallee(c) {
  return !!c && c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'spectra' && c.property.type === 'Identifier' && c.property.name === 'metric';
}

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

// The compiler's message carries a trailing documentation link line —
// keep the sentence only.
function firstLine(e) {
  return String((e && e.message) || e).split('\n')[0].trim();
}

export async function compileReply({ id, source, filename }) {
  try {
    const { compile, parse } = await loadCompiler();
    const out = compile(String(source), { ...COMPILE_OPTIONS, filename });
    const legacy = (out.warnings || []).find((w) => LEGACY_WARNINGS.has(w.code));
    if (legacy) {
      const start = legacy.start || {};
      return { id, ok: false, legacy: true, message: firstLine(legacy), line: start.line || 0, column: start.column || 0 };
    }
    return { id, ok: true, js: out.js.code, refs: componentRefs(parse, source).refs };
  } catch (e) {
    const start = (e && e.start) || {};
    const legacy = !!(e && typeof e.code === 'string' && e.code.startsWith('legacy_'));
    return { id, ok: false, legacy, message: firstLine(e), line: start.line || 0, column: start.column || 0 };
  }
}
