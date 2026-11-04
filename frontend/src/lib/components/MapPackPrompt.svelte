<script>
  // One-time prompt, two variants: "Found Counter-Strike 2 — extract
  // radar images?" when detection succeeds, and "Counter-Strike 2 not
  // found" when it doesn't (plain-grid fallback explained; "Choose
  // folder…" validates a manual install and moves straight into the
  // extract flow). Shown by App on first launch after detection; "Not
  // now" declines permanently in either variant, "Choose folder…"
  // covers non-Steam installs. Valve IP never ships — internal/mappack.
  import {
    getMapPackStatus,
    extractMapPacks,
    setMapPackPromptState,
    chooseCS2Dir,
    errText,
  } from '../services.js';
  import Dialog from './Dialog.svelte';

  let open = $state(false);
  let notFound = $state(false); // CS2 missing → the not-found variant
  let status = $state(null); // MapPackStatus once loaded
  let busy = $state(false);
  let error = $state('');
  let result = $state(null); // { maps, errors } after extraction
  let pickedDir = $state(''); // manual folder override

  export async function maybePrompt() {
    try {
      const st = await getMapPackStatus();
      if (!st || st.promptState === 'declined' || st.promptState === 'done') {
        return;
      }
      status = st;
      pickedDir = st.path || '';
      notFound = !st.found;
      error = '';
      result = null;
      open = true;
    } catch (e) {
      // Detection failure must never block app startup.
      console.error('map pack status', e);
    }
  }

  function close() {
    open = false;
  }

  async function accept() {
    busy = true;
    error = '';
    try {
      const out = await extractMapPacks(pickedDir);
      result = out;
      if (out && out.maps && out.maps.length > 0 && !(out.errors || []).length) {
        // Full success: the prompt state was persisted Go-side too.
        setTimeout(close, 900);
      }
    } catch (e) {
      error = errText(e);
    } finally {
      busy = false;
    }
  }

  async function decline() {
    try {
      await setMapPackPromptState('declined', '');
    } catch (e) {
      console.error('save prompt state', e);
    }
    close();
  }

  async function pickFolder() {
    try {
      const dir = await chooseCS2Dir();
      if (dir) {
        pickedDir = dir;
        // Persist so future detection/status calls use it.
        await setMapPackPromptState('', dir);
        status = { ...(status || {}), path: dir, manual: true, found: true };
        // A validated folder ends the not-found variant: the dialog flips
        // into the normal "Found Counter-Strike 2 — extract radar?" flow.
        notFound = false;
        error = '';
      }
    } catch (e) {
      error = errText(e);
    }
  }
</script>

<Dialog
  open={open}
  backClass="top"
  panelClass="pk-prompt"
  label={notFound ? 'Counter-Strike 2 not found' : 'Extract radar images'}
  dismissable={!busy}
  onClose={close}
>
  <div class="pk-body">
    {#if notFound}
      <h2 class="pk-title">Counter-Strike 2 not found</h2>
      <p class="muted">
        Spectra extracts radar images and map transforms from a local
        Counter-Strike 2 installation for authentic map backgrounds in
        replay and heatmaps. Without one, maps render as a plain grid.
      </p>
      <p class="muted pk-fine">
        Nothing from Counter-Strike ships with the app, and nothing is
        uploaded — your game files are read locally and the extracted packs
        are stored in Spectra's data folder on this machine.
      </p>
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
    {:else}
      <h2 class="pk-title">Found Counter-Strike 2</h2>
      <p class="muted">
        Spectra can extract the official radar images and map transforms
        from your local CS2 installation for authentic map backgrounds in
        replay and heatmaps.
      </p>
      <p class="muted pk-path mono">{pickedDir || status?.path || 'CS2 install'}</p>
      <p class="muted pk-fine">
        Images are read from your game files and stored in Spectra's data
        folder on this machine. Nothing is uploaded, and nothing from
        Counter-Strike ships with the app.
      </p>
      {#if result}
        <p class="pk-result" role="status">
          {#if result.maps && result.maps.length}
            Extracted {result.maps.length} map pack{result.maps.length === 1 ? '' : 's'}.
          {/if}
          {#if result.errors && result.errors.length}
            <span class="pk-err">{result.errors.length} failed: {result.errors[0]}</span>
          {/if}
        </p>
      {/if}
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
    {/if}
  </div>
  <div class="toolbar pk-actions">
    <button class="btn" disabled={busy} onclick={pickFolder}>
      Choose folder…
    </button>
    <span class="spacer"></span>
    <button class="btn" disabled={busy} onclick={decline}>Not now</button>
    {#if !notFound}
      <button class="btn primary" disabled={busy} onclick={accept}>
        {busy ? 'Extracting…' : 'Extract radar images'}
      </button>
    {/if}
  </div>
</Dialog>

<style>
  /* The panel element belongs to Dialog.svelte, so the prompt's own size
     has to reach it through a global selector (pk- = MapPackPrompt). */
  :global(.dlg-panel.pk-prompt) {
    width: min(520px, 94vw);
    padding: 20px 22px;
  }
  .pk-title {
    margin: 0 0 8px;
    font-size: 1.1em;
  }
  .pk-body p {
    margin: 8px 0;
    line-height: 1.45;
  }
  .pk-path {
    font-size: 0.9em;
    word-break: break-all;
    color: var(--text);
    opacity: 0.85;
  }
  .pk-fine {
    font-size: 0.85em;
    opacity: 0.75;
  }
  .pk-result {
    font-size: 0.9em;
  }
  .pk-err {
    color: var(--danger);
  }
  .pk-actions {
    margin-top: 14px;
  }
  .pk-actions .spacer {
    flex: 1;
  }
</style>
