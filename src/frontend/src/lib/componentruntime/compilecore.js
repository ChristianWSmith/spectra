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
    const { compile } = await loadCompiler();
    const out = compile(String(source), { ...COMPILE_OPTIONS, filename });
    const legacy = (out.warnings || []).find((w) => LEGACY_WARNINGS.has(w.code));
    if (legacy) {
      const start = legacy.start || {};
      return { id, ok: false, legacy: true, message: firstLine(legacy), line: start.line || 0, column: start.column || 0 };
    }
    return { id, ok: true, js: out.js.code };
  } catch (e) {
    const start = (e && e.start) || {};
    const legacy = !!(e && typeof e.code === 'string' && e.code.startsWith('legacy_'));
    return { id, ok: false, legacy, message: firstLine(e), line: start.line || 0, column: start.column || 0 };
  }
}
