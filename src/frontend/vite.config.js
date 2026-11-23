import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import wails from "@wailsio/runtime/plugins/vite";

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [svelte(), wails("./bindings")],
  // The compile worker (src/lib/componentruntime/compile.worker.js) loads
  // svelte/compiler by dynamic import, which needs an ES-module worker.
  worker: { format: "es" },
  // The main bundle (~540 kB, ~175 kB gzipped) is loaded eagerly on purpose:
  // pre-warming mounts every view at startup (lib/warm.js), so splitting views
  // into lazy chunks would not reduce what loads. The Svelte compiler (~880 kB)
  // is already its own chunk, loaded only when a user component compiles.
  build: { chunkSizeWarningLimit: 900 },
});
