<script>
  // Launch prompt, two variants: "Found Counter-Strike 2 — extract all
  // assets?" when an install is detected, and "Counter-Strike 2 not
  // found" when it doesn't (plain-grid fallback explained; "Choose
  // folder…" validates a manual install and moves straight into the
  // extract flow). Shown by App on EVERY launch while any asset family
  // is missing — the gate is presence-driven (maps + icons + sounds all
  // extracted → no prompt), so "Not now" only skips this launch; there
  // is no persisted suppression. Escape/backdrop dismissal is
  // session-only the same way. "Choose folder…" covers non-Steam
  // installs. Valve IP never ships — internal/mappack.
  import {
    getMapPackStatus,
    getIconManifest,
    getSoundManifest,
    setCS2Dir,
    chooseCS2Dir,
    onAssetProgress,
    errText,
  } from '../services.js';
  import { extractAllAssets, assetFamilyForStep } from '../assets.js';
  import Dialog from './Dialog.svelte';
  import StatusChip from './StatusChip.svelte';

  let open = $state(false);
  let notFound = $state(false); // CS2 missing → the not-found variant
  let status = $state(null); // MapPackStatus once loaded
  let busy = $state(false);
  let error = $state('');
  let msg = $state(''); // aggregated result line after extraction
  let pickedDir = $state(''); // manual folder override
  // Live extraction progress: step names the family currently running
  // (set by extractAllAssets' onStep before each awaited call), progress
  // holds the last spectra:asset-progress payload — every family emits
  // one now (mappackservice.go's shared emitter), so each step renders
  // the determinate bar from its own numbers.
  let step = $state('');
  let progress = $state(null);

  // The payload of the step CURRENTLY running, gated on that step's own
  // family (assets.js assetFamilyForStep): a stale payload from the
  // previous step or a concurrent run's payload for another family never
  // drives this bar. Null between steps → the animated indeterminate bar
  // (StatusChip's class:indeterminate) — never a pretended percentage.
  const stepProgress = $derived(
    progress && progress.family === assetFamilyForStep(step) ? progress : null,
  );

  // 0 = the animated indeterminate bar (StatusChip's class:indeterminate),
  // a real 0..1 = the determinate bar + its percentage.
  const pct = $derived(
    stepProgress && stepProgress.total > 0
      ? Math.min(1, stepProgress.done / stepProgress.total)
      : 0,
  );

  // Subscribe for the whole component lifetime; the unsubscribe is the
  // $effect cleanup (the pattern documented at services.js onEvent).
  // Only the RUNNING step's family is accepted: a concurrent run's
  // payloads (Replay's background icon auto-extract) and the previous
  // step's closing payload can never clobber this step's numbers —
  // worst case the bar stays indeterminate, never wrong.
  $effect(() => {
    const off = onAssetProgress((p) => {
      if (p && p.family === assetFamilyForStep(step)) progress = p;
    });
    return off;
  });

  export async function maybePrompt() {
    try {
      // Presence signals for ALL THREE families — cheap local listings:
      // map packs = data-dir pack dirs (bundled packs carry no pixels, so
      // an empty data dir IS prompt-worthy), icons/sounds = manifests.
      const [st, icons, sounds] = await Promise.all([
        getMapPackStatus(),
        getIconManifest(),
        getSoundManifest(),
      ]);
      const mapsMissing = !st || !st.maps || st.maps.length === 0;
      const iconsMissing = !icons || !icons.extracted;
      const soundsMissing = !sounds || !sounds.extracted;
      // The gate: ANY family missing re-opens the prompt this launch.
      // Nothing is persisted — once every family exists, the condition
      // simply stops being true (extraction, not a pref, ends the loop).
      if (!mapsMissing && !iconsMissing && !soundsMissing) {
        return;
      }
      status = st;
      pickedDir = (st && st.path) || '';
      notFound = !st || !st.found;
      error = '';
      msg = '';
      step = '';
      progress = null;
      open = true;
    } catch (e) {
      // Detection failure must never block app startup.
      console.error('asset status', e);
    }
  }

  function close() {
    open = false;
  }

  async function accept() {
    busy = true;
    error = '';
    msg = '';
    step = '';
    // Drop any progress a previous run left behind — the first
    // spectra:asset-progress of THIS run replaces it; without this the
    // bar could open at a stale "18 of 18".
    progress = null;
    try {
      const out = await extractAllAssets({
        dir: pickedDir || (status && status.path) || '',
        onStep: (label) => (step = label),
      });
      msg = out.msg;
      error = out.error;
      if (msg && !error) {
        // Full success: every family extracted → presence now holds and
        // the loop ends; close on the same beat Settings shows its line.
        setTimeout(close, 900);
      }
    } catch (e) {
      error = errText(e);
    } finally {
      step = '';
      progress = null;
      busy = false;
    }
  }

  async function pickFolder() {
    try {
      const dir = await chooseCS2Dir();
      if (dir) {
        pickedDir = dir;
        // Persist so future detection/status calls use it.
        await setCS2Dir(dir);
        status = { ...(status || {}), path: dir, manual: true, found: true };
        // A validated folder ends the not-found variant: the dialog flips
        // into the normal "Found Counter-Strike 2 — extract all assets?"
        // flow.
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
  label={notFound ? 'Counter-Strike 2 not found' : 'Extract CS2 assets'}
  dismissable={!busy}
  onClose={close}
>
  <div class="pk-body">
    {#if notFound}
      <h2 class="pk-title">Counter-Strike 2 not found</h2>
      <p class="muted">
        Spectra reads the official radar images from a local Counter-Strike 2
        installation for authentic map backgrounds in replay and heatmaps.
        Without one, maps render as a plain grid.
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
        Spectra can read the official radar images, the equipment icons and
        the replay sounds from your local Counter-Strike 2 installation —
        authentic map backgrounds, inventory silhouettes and in-replay audio.
      </p>
      <p class="muted pk-path mono">{pickedDir || status?.path || 'CS2 install'}</p>
      <p class="muted pk-fine">
        Assets are read from your game files and stored in Spectra's data
        folder on this machine. Nothing is uploaded, and nothing from
        Counter-Strike ships with the app.
      </p>
      <!-- Live extraction progress: the app's ONE progress widget
           (StatusChip) beside the step text — the Settings pattern.
           Every family drives it with real numbers from
           spectra:asset-progress (gated to the running step's family);
           between steps the bar stays the animated indeterminate one. -->
      {#if busy && step}
        <p class="muted" role="status">
          <StatusChip status="running" progress={pct} />
          Extracting {step}…{stepProgress && stepProgress.done > 0
            ? ` ${stepProgress.done} of ${stepProgress.total}`
            : ''}
        </p>
      {/if}
      {#if msg}
        <p class="pk-result" role="status">{msg}</p>
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
    <!-- Session-only dismissal: no suppression pref exists any more, so
         "Not now" closes this launch and the prompt returns on the next
         one while assets are still missing. -->
    <button class="btn" disabled={busy} onclick={close}>Not now</button>
    {#if !notFound}
      <button class="btn primary" disabled={busy} onclick={accept}>
        {busy ? 'Extracting…' : 'Extract all CS2 assets'}
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
  .pk-actions {
    margin-top: 14px;
  }
  .pk-actions .spacer {
    flex: 1;
  }
</style>
