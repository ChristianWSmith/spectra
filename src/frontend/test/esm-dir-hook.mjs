// ESM resolve helper for node --test: the app's bundler (Vite) resolves
// bare directory specifiers to <dir>/index.js, but node's ESM resolver
// rejects them ("Directory import ... is not supported"). The generated
// bindings are imported as
// `.../bindings/github.com/ChristianWSmith/spectra`, so any test that pulls
// in the service layer (services.js → bindings) installs this hook first:
//
//   import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';
//   installEsmDirHook();
//   const services = await import('./services.js');
//
// Install BEFORE the dynamic import; it only affects specifiers node would
// otherwise fail on, so plain imports keep node's own resolution.
import { registerHooks } from 'node:module';

export function installEsmDirHook() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        const relative = specifier.startsWith('.') || specifier.startsWith('/');
        if (relative && !specifier.endsWith('.js') && !specifier.endsWith('/')) {
          return nextResolve(`${specifier}/index.js`, context);
        }
        throw err;
      }
    },
  });
}
