// strings/components.js — the component frame (lib/components/ComponentFrame.svelte)
// and the component runtime's own messages (lib/componentruntime/): the
// failure frame every mounted component sits in, the load state, and the
// errors the read API and the source check report into that frame.
// {err} = underlying error text, {line} = source line, {name} = a name.
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const components = {
  // The failure frame (render/effect failures, handler and async errors).
  frameFailed: 'This component failed: {err}',
  frameDismiss: 'Dismiss component error',
  // Render failures only: re-render the component in place.
  frameRetry: 'Try again',
  // A placement that names a component which no longer exists.
  frameMissing: 'This component is missing: {name}',
  // The source check (compile.js checkComponentSource): a compile error
  // positioned by line, and an import the runtime cannot provide.
  sourceAtLine: 'Line {line}: {err}',
  // Components are runes-only: legacy syntax (export let, $:, on:, <slot>)
  // is refused with the compiler's reason.
  legacyRefused: 'Components use Svelte 5 runes only: {err}',
  importRefused: 'Components cannot import {name}',
  // A built-in's import of a helper name the registry does not list (ruling 45).
  helperNameRefused: 'Built-in components cannot import {name} from {module}',
  // A compile the author stopped (the Cancel button, ruling 47): the save or
  // the load reports it, and nothing was written.
  compileCancelled: 'Cancelled. Nothing was written.',
  // Read API refusals (readapi.js).
  metricUnknown: 'No metric named {name}',
  metricLibraryUnavailable: 'Library-wide metric values are not available yet',
  writeUnavailable: 'This surface cannot change stored data',
  // Binds (readapi.js resolveBinds, bindQuery): one bind given twice, a
  // query bind the surface has no value for, and a value of the wrong shape.
  bindConflict: 'Give the bind {name} once, not twice',
  bindUnset: 'The query uses :{name}, and this view has no value for it',
  bindInvalid: 'The query bind :{name} has a value that cannot be used',
  // Nested mount (components/ChildFrame.svelte): a child that names no
  // component, and a chain of components nested too deep.
  childNotFound: 'No component named {name} to mount',
  childDepth: 'Components can nest at most {depth} deep',
};
