import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import wails from "@wailsio/runtime/plugins/vite";
import { fileURLToPath } from "node:url";

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [svelte(), wails("./bindings")],
  // The one import surface a component uses (AGENTS.md "Helper surface"): built-ins
  // and user components both write 'spectra/helpers'. componentruntime/compile.js
  // maps the same specifier at compile time.
  resolve: {
    alias: [{ find: /^spectra\/helpers$/, replacement: fileURLToPath(new URL("./src/lib/builtinhelpers.js", import.meta.url)) }],
  },
  // The compile worker (src/lib/componentruntime/compile.worker.js) loads
  // svelte/compiler by dynamic import, which needs an ES-module worker.
  worker: { format: "es" },
  // The main bundle (~540 kB, ~175 kB gzipped) is loaded eagerly on purpose:
  // pre-warming mounts every view at startup (lib/warm.js), so splitting views
  // into lazy chunks would not reduce what loads. The Svelte compiler (~880 kB)
  // is already its own chunk, loaded only when a user component compiles.
  build: { chunkSizeWarningLimit: 900 },
});
