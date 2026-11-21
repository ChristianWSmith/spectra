// The compile Web Worker (dogfood/04-COMPONENTS.md §5; owner ruling 47).
// Built by Vite from `new Worker(new URL('./compile.worker.js', …))` in
// compileclient.js. It holds svelte/compiler; the main thread sends
// {id, source, filename} and gets back the reply compileReply builds.
import { compileReply } from './compilecore.js';

self.onmessage = async (ev) => {
  self.postMessage(await compileReply(ev.data));
};
