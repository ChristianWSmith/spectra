<script>
  // One-time prompt: "Found Counter-Strike 2 — extract radar images?"
  // Shown by App on first launch after detection; Yes runs the local
  // extraction (Valve IP never ships — see internal/mappack), "Not now"
  // declines permanently, "Choose folder…" covers non-Steam installs.
  import {
    getMapPackStatus,
    extractMapPacks,
    setMapPackPromptState,
    chooseCS2Dir,
  } from '../services.js';

  let open = $state(false);
  let status = $state(null); // MapPackStatus once loaded
  let busy = $state(false);
  let error = $state('');
  let result = $state(null); // { maps, errors } after extraction
  let pickedDir = $state(''); // manual folder override

  export async function maybePrompt() {
    try {
      const st = await getMapPackStatus();
      if (!st || !st.found || st.promptState === 'declined' || st.promptState === 'done') {
        return;
      }
      status = st;
      pickedDir = st.path || '';
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
      }
    } catch (e) {
      error = errText(e);
    }
  }

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }
</script>

{#if open}
  <div class="cp-back" role="presentation" onclick={(e) => {
    if (e.target === e.currentTarget && !busy) close();
  }}>
    <div class="cp-panel mp-prompt" role="dialog" aria-modal="true" aria-label="Extract radar images">
      <div class="mp-body">
        <h2 class="mp-title">Found Counter-Strike 2</h2>
        <p class="muted">
          Spectra can extract the official radar images and map transforms
          from your local CS2 installation for authentic map backgrounds in
          replay and heatmaps.
        </p>
        <p class="muted mp-path mono">{pickedDir || status?.path || 'CS2 install'}</p>
        <p class="muted mp-fine">
          Images are read from your game files and stored in Spectra's data
          folder on this machine. Nothing is uploaded, and nothing from
          Counter-Strike ships with the app.
        </p>
        {#if result}
          <p class="mp-result" role="status">
            {#if result.maps && result.maps.length}
              Extracted {result.maps.length} map pack{result.maps.length === 1 ? '' : 's'}.
            {/if}
            {#if result.errors && result.errors.length}
              <span class="mp-err">{result.errors.length} failed: {result.errors[0]}</span>
            {/if}
          </p>
        {/if}
        {#if error}
          <p class="error" role="alert">{error}</p>
        {/if}
      </div>
      <div class="mp-actions">
        <button class="btn" disabled={busy} onclick={pickFolder}>
          Choose folder…
        </button>
        <span class="spacer"></span>
        <button class="btn" disabled={busy} onclick={decline}>Not now</button>
        <button class="btn primary" disabled={busy} onclick={accept}>
          {busy ? 'Extracting…' : 'Extract radar images'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .mp-prompt {
    width: min(520px, 94vw);
    padding: 20px 22px;
  }
  .mp-title {
    margin: 0 0 8px;
    font-size: 1.1em;
  }
  .mp-body p {
    margin: 8px 0;
    line-height: 1.45;
  }
  .mp-path {
    font-size: 0.9em;
    word-break: break-all;
    color: var(--text);
    opacity: 0.85;
  }
  .mp-fine {
    font-size: 0.85em;
    opacity: 0.75;
  }
  .mp-result {
    font-size: 0.9em;
  }
  .mp-err {
    color: var(--error, #e66a6a);
  }
  .mp-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 14px;
  }
  .mp-actions .spacer {
    flex: 1;
  }
</style>
