// install-binding-stubs.mjs — for unit tests that load services.js (directly or through a module
// that imports it). services.js imports the Wails runtime and the generated bindings directory,
// which exist only after `wails3 generate bindings`; CI runs the unit tests without that step.
// This redirects both to the stubs in test/stubs/ before the test imports anything that needs them.
// Hooks are per-process, so call this before the first dynamic import of a module that reaches services.js.
import { registerHooks } from 'node:module';
import { installEsmDirHook } from './esm-dir-hook.mjs';

export function installBindingStubs() {
  installEsmDirHook();
  const stub = (name) => new URL(`./stubs/${name}`, import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
      if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}
