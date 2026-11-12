import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  // Consult https://svelte.dev/docs#compile-time-svelte-preprocess
  // for more information about preprocessors
  preprocess: vitePreprocess(),
  // Warning gate: warnings never fail the build by themselves (GitHub only
  // fails on a nonzero exit), so for the allowlisted codes we print the
  // warning ourselves and set process.exitCode = 1 — a flag the plugin's
  // error handling cannot swallow, which then propagates npm run build →
  // wails3 build → make artifact → red CI. Everything else keeps the
  // default handler unchanged.
  onwarn(warning, warn) {
    if (warning.code === 'state_referenced_locally') {
      console.error(
        `[svelte warning gate] ${warning.code}: ${warning.message} (${warning.filename ?? 'unknown file'})`
      );
      process.exitCode = 1;
      return;
    }
    warn(warning);
  },
}
