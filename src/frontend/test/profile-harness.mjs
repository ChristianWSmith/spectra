// profile-harness.mjs — the jsdom setup the Profile panel tests share
// `boot()` installs the module hooks and the DOM globals,
// compiles every .svelte the panels reach (a .js module that imports a .svelte
// file is bundled too, so the builtin registry loads), and returns the mount
// helpers. The read services are the real services.js over the Wails stub
// (test/stubs/bindings.mjs): a test scripts the backend through `bindings`.
//
// Run from frontend/ through a driver, e.g. test/profile-panels.dom.mjs.
import { reachesSvelte } from './bundle-reach.mjs';
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from './esm-dir-hook.mjs';

const stub = (name) => pathToFileURL(join('test', 'stubs', name)).href;

export async function boot(cacheName = 'profile-panels') {
  installEsmDirHook();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
        return nextResolve(specifier, { ...context, conditions: ['browser', ...(context.conditions || [])] });
      }
      if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
      if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });

  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  for (const k of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
    'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAnchorElement',
    'SVGElement', 'Element', 'Node', 'Text', 'Comment',
    'DocumentFragment', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'MutationObserver', 'localStorage',
  ]) {
    if (!(k in dom.window)) continue;
    try {
      globalThis[k] = dom.window[k];
    } catch {
      Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    }
  }
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;

  const escaped = [];
  process.on('uncaughtException', (e) => {
    escaped.push(e);
    console.log('UNCAUGHT ' + (e && e.message));
  });
  process.on('unhandledRejection', (e) => {
    escaped.push(e);
    console.log('UNCAUGHT rejection ' + (e && e.message));
  });

  // --- bundling -------------------------------------------------------------
  const dir = join('node_modules', '.cache', 'spectra-dom-tests', cacheName);
  mkdirSync(dir, { recursive: true });
  const bundled = new Map();
  let seq = 0;
  const importsSvelte = (file) => reachesSvelte(file);
  function bundle(absPath) {
    if (bundled.has(absPath)) return bundled.get(absPath);
    const out = join(dir, `${String(++seq).padStart(3, '0')}-${absPath.split('/').pop()}.js`);
    bundled.set(absPath, out);
    const src = readFileSync(absPath, 'utf8').replace(/from '(\.{1,2}\/[^']+)'/g, (whole, rel) => {
      const target = resolve(dirname(absPath), rel);
      if (target.endsWith('.svelte') || target.endsWith('.svelte.js')) return `from '${pathToFileURL(bundle(target)).href}'`;
      if (target.endsWith('.js') && importsSvelte(target)) return `from '${pathToFileURL(bundle(target)).href}'`;
      return `from '${pathToFileURL(target).href}'`;
    });
    if (absPath.endsWith('.svelte')) writeFileSync(out, compile(src, { filename: absPath, generate: 'client' }).js.code);
  else if (absPath.endsWith('.svelte.js')) writeFileSync(out, compileModule(src, { filename: absPath, generate: 'client' }).js.code);
    else writeFileSync(out, src);
    return out;
  }
  const frameBundle = bundle(resolve('src/lib/components/ComponentFrame.svelte'));

  const { mount, unmount, flushSync } = await import('svelte');
  const bindings = await import('./stubs/bindings.mjs');
  const services = await import(pathToFileURL(resolve('src/lib/services.js')).href);
  const ComponentFrame = (await import(pathToFileURL(frameBundle).href)).default;
  const panelsMod = await import(pathToFileURL(bundle(resolve('src/lib/builtins/panels.js'))).href);

  const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const settle = async (ms = 150) => {
    await sleep(ms);
    flushSync();
  };

  // mountComponent mounts one builtin (a panel or the Profile component) in a
  // ComponentFrame, with the given fixed context. It returns the target and an
  // unmount function.
  async function mountComponent(component, context, props = {}) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const instance = mount(ComponentFrame, { target, props: { component, context, props, nav: () => {} } });
    await settle();
    return {
      target,
      cleanup: () => {
        unmount(instance);
        target.remove();
      },
    };
  }

  return {
    dom,
    dir,
    bindings,
    services,
    panels: panelsMod.BUILTIN_PANELS,
    escaped,
    sleep,
    settle,
    mountComponent,
    // bundle(abs): compile one app .svelte (or a .js that imports one) for a
    // driver that mounts a surface directly, e.g. views/Reports.svelte.
    bundle,
  };
}
