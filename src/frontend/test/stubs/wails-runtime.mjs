// Test stand-in for @wailsio/runtime's event bus (used by
// src/lib/services-cache.test.js). The real module receives events over
// webview IPC — nothing can fire them inside node — so this stub records
// the listeners and exposes fire() for the test to dispatch one.
// Resolved through a registerHooks stub in the test file; imported here
// directly by path (same resolved URL => same module instance).

const listeners = new Map(); // name -> Set<callback>

export const Events = {
  On(name, callback) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return () => listeners.get(name).delete(callback);
  },
};

// fire dispatches {name, data} to every listener of name — the shape
// services.js's onEvent wrapper expects (callback receives ev.data).
export function fire(name, data) {
  for (const cb of [...(listeners.get(name) || [])]) {
    cb({ name, data: data === undefined ? null : data });
  }
}

export function listenerCount(name) {
  return (listeners.get(name) || new Set()).size;
}
