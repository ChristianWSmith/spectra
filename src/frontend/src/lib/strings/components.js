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
  frameLoading: 'Loading component…',
  // A placement that names a component which no longer exists.
  frameMissing: 'This component is missing: {name}',
  // The source check (compile.js checkComponentSource): a compile error
  // positioned by line, and an import the runtime cannot provide.
  sourceAtLine: 'Line {line}: {err}',
  importRefused: 'Components cannot import {name}',
  // Read API refusals (readapi.js).
  metricUnknown: 'No metric named {name}',
  metricRoundUnavailable: 'Per-round metric values are not available yet',
  metricLibraryUnavailable: 'Library-wide metric values are not available yet',
};
