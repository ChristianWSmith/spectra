// Installs the node compile worker as the compile client's worker factory
// (test seam for ruling 47). Import this file first in any node test or jsdom
// driver that compiles a user component: jsdom and node have no browser
// Worker, so the compile runs on a worker_threads thread instead, behind the
// same postMessage / onmessage / terminate surface the browser Worker has.
//
// `created` counts the workers started, so a test can prove a fresh worker
// after a cancel.
import { Worker as NodeWorker } from 'node:worker_threads';
import { setCompileWorkerFactory, compileWork, subscribeCompiles } from '../src/lib/componentruntime/compileclient.js';

// warm loads the compiler in the worker (its first compile is a cold start)
// before a driver's mounts, so the drivers' fixed settles are not racing it.
export async function warm() {
  await compileWork('<p>warm</p>', 'Warm.svelte');
}

// compileIdle resolves once no compile is pending (in any copy of the client):
// a driver's wait after a mount, so a user component's compile has finished.
let pendingNow = false;
subscribeCompiles((on) => {
  pendingNow = on;
});
export async function compileIdle(maxMs = 20000) {
  const end = Date.now() + maxMs;
  while (pendingNow && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

const ENTRY = new URL('./compile-worker-node-entry.mjs', import.meta.url);

export const created = { count: 0 };

export function nodeCompileWorker() {
  created.count++;
  const w = new NodeWorker(ENTRY);
  // The thread holds the process open only while a request is in flight:
  // an idle worker is unref'd, so a finished test file exits on its own.
  w.unref();
  let inFlight = 0;
  const surface = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      inFlight++;
      w.ref();
      w.postMessage(message);
    },
    terminate() {
      return w.terminate();
    },
  };
  w.on('message', (data) => {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) w.unref();
    if (surface.onmessage) surface.onmessage({ data });
  });
  w.on('error', (err) => {
    if (surface.onerror) surface.onerror({ message: err && err.message });
  });
  return surface;
}

setCompileWorkerFactory(nodeCompileWorker);
