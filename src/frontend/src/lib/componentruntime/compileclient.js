// The main-thread client of the compile worker. Every user-component compile (the save-time check, the
// live check, a preview's first mount) is sent here; the compiler itself runs
// in compile.worker.js, so a large component never blocks the UI thread.
//
// - One worker is kept alive between compiles and started on the first
//   compile (the compiler inside it loads lazily on that first message). The
//   worker is never started at launch.
// - cancelCompiles terminates the worker and resolves every pending compile
//   as {cancelled: true}. The next compile starts a fresh worker.
// - Each compile is tracked as background work through setCompileTracker,
//   which the work indicator registers (workstate.svelte.js → runWork). The
//   tracker is a seam, not an import: this module imports nothing from the
//   app, so the node tests load it without the Wails bindings.
// - subscribeCompiles reports whether any compile is pending (the Cancel
//   button's visibility in the component editor).
// - setCompileWorkerFactory is the test seam: the node tests and the jsdom
//   drivers install a worker_threads-backed factory (test/compile-worker-node.mjs)
//   because jsdom and node have no browser Worker.
//
// The seam and the pending state live on one shared registry (Symbol.for),
// not only in this module's closure: a jsdom driver that bundles its own copy
// of this file still shares the factory and the pending state with the real
// one. The app never sets the factory.

const defaultFactory = () => new Worker(new URL('./compile.worker.js', import.meta.url), { type: 'module' });

const SHARED_KEY = Symbol.for('spectra.compileClient');

function shared() {
  if (!globalThis[SHARED_KEY]) globalThis[SHARED_KEY] = { factory: null, subs: new Set(), active: 0 };
  return globalThis[SHARED_KEY];
}

let track = (p) => p;
let worker = null; // the live worker, or null (none started, or cancelled)
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}
let requested = false;

export function setCompileWorkerFactory(fn) {
  shared().factory = fn || null;
}

function makeWorker() {
  return (shared().factory || defaultFactory)();
}

export function setCompileTracker(fn) {
  track = fn || ((p) => p);
}

// compileRequested: whether any compile has been asked for in this process
// (the compiler is loaded by the first one, not at launch).
export function compileRequested() {
  return requested;
}

function notify() {
  const s = shared();
  const on = s.active > 0;
  for (const fn of s.subs) fn(on);
}

// subscribeCompiles hands fn the current pending state at once and on every
// change; returns the unsubscribe function.
export function subscribeCompiles(fn) {
  const s = shared();
  s.subs.add(fn);
  fn(s.active > 0);
  return () => s.subs.delete(fn);
}

// finish retires one pending compile (its reply, a worker failure, or a cancel).
function finish(id) {
  const p = pending.get(id);
  if (!p) return null;
  pending.delete(id);
  shared().active--;
  return p;
}

function settle(id, value) {
  const p = finish(id);
  if (!p) return;
  notify();
  p.resolve(value);
}

function retire(w) {
  if (worker === w) worker = null;
  try {
    w.terminate();
  } catch {
    // already gone
  }
}

function ensureWorker() {
  if (worker) return worker;
  const w = makeWorker();
  w.onmessage = (ev) => settle(ev.data && ev.data.id, ev.data);
  w.onerror = (ev) => {
    // The worker failed outside a reply (it did not start, or threw while
    // loading). Every pending compile fails with that; the next one starts
    // a fresh worker.
    retire(w);
    const err = new Error('compile worker failed: ' + ((ev && ev.message) || 'unknown error'));
    for (const id of [...pending.keys()]) finish(id).reject(err);
    notify();
  };
  worker = w;
  return w;
}

// compileWork posts one compile and resolves its reply, or {cancelled: true}
// when cancelCompiles stopped it. Tracked as background work, unless quiet:
// the builder's live check runs on every keystroke, so it does not raise the
// work indicator (a save still does).
export function compileWork(source, filename, { quiet = false } = {}) {
  requested = true;
  const w = ensureWorker();
  const id = nextId++;
  const done = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  shared().active++;
  notify();
  w.postMessage({ id, source: String(source), filename });
  return quiet ? done : track(done);
}

// cancelCompiles stops every compile in flight: the worker is terminated and
// each pending compile resolves {cancelled: true}. Nothing else is touched.
export function cancelCompiles() {
  const w = worker;
  worker = null;
  if (w) {
    try {
      w.terminate();
    } catch {
      // already gone
    }
  }
  for (const id of [...pending.keys()]) finish(id).resolve({ id, cancelled: true });
  notify();
}
