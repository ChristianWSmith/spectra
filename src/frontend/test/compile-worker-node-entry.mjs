// The node-side compile worker (test seam for ruling 47). It is the same
// message contract as src/lib/componentruntime/compile.worker.js, run on a
// node worker_threads thread: the compile core answers every request, so a
// long compile runs off the main thread here exactly as in the browser.
import { parentPort } from 'node:worker_threads';
import { compileReply } from '../src/lib/componentruntime/compilecore.js';

parentPort.on('message', async (request) => {
  parentPort.postMessage(await compileReply(request));
});
