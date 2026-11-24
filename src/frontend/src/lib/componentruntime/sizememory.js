// The last rendered height of each mounted component, by its name. A component that unmounts
// and mounts again reserves the height its last render had, and the heights persist across app
// launches: the app stores them as one preference (setSizeStore, loadSizes). Keyed by name, not
// by data: the space of the last data is the space the next data takes.
const heights = new Map();
const KEY_LIMIT = 500;

let store = null; // { load: () => Promise<object|null>, save: (object) => Promise }
let timer = null;
let loaded = false; // the stored sizes have been read (or could not be)
let dirty = false; // a height changed before the load finished
const listeners = new Set();

// setSizeStore wires the persistent store (the app's preference store). Until it is set, the
// memory is process-only.
export function setSizeStore(s) {
  store = s;
}

// loadSizes reads the persisted heights once at startup. A height remembered in this session
// is newer than the stored one, so it is kept. Listeners are told when the load lands.
export async function loadSizes() {
  if (!store) return;
  try {
    const stored = await store.load();
    if (stored && typeof stored === 'object') {
      for (const [name, px] of Object.entries(stored)) {
        if (!heights.has(name) && Number.isFinite(px) && px > 0) heights.set(name, px);
      }
    }
  } catch {
    // An unreadable store leaves the memory process-only; nothing else depends on it.
  }
  loaded = true;
  if (dirty) schedule();
  for (const fn of listeners) fn();
}

// onSizesLoaded subscribes to the load. Returns the unsubscribe.
export function onSizesLoaded(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function rememberHeight(name, px) {
  if (!name || !(px > 0)) return;
  if (heights.get(name) === px) return;
  if (!heights.has(name) && heights.size >= KEY_LIMIT) return;
  heights.set(name, px);
  schedule();
}

export function recalledHeight(name) {
  return (name && heights.get(name)) || null;
}

// The writes are batched: a layout settles over several frames, and one store write per settle is enough.
function schedule() {
  if (!store) return;
  if (!loaded) {
    dirty = true;
    return;
  }
  dirty = false;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    store.save(Object.fromEntries(heights)).catch(() => {});
  }, 400);
}
