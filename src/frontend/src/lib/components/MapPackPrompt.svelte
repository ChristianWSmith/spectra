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
  // installs. Extract closes the prompt at once — the run and its
  // progress surface in the floating work indicator (App's .wk-pill).
  // Valve IP never ships — internal/mappack.
  import {
    getMapPackStatus,
    getIconManifest,
    getSoundManifest,
    setCS2Dir,
    chooseCS2Dir,
    errText,
  } from '../services.js';
  import { extractAllAssets } from '../assets.js';
  import * as S from '../strings/index.js'; // chrome copy (strings-audit Check B)
  import Dialog from './Dialog.svelte';

  let open = $state(false);
  let notFound = $state(false); // CS2 missing → the not-found variant
  let status = $state(null); // MapPackStatus once loaded
  let busy = $state(false);
  let error = $state('');
  let pickedDir = $state(''); // manual folder override

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
      open = true;
    } catch (e) {
      // Detection failure must never block app startup — and it must not
      // vanish into the console either: surface it in the prompt's own
      // error slot, which the Dialog already dismisses (Escape / backdrop
      // / "Not now"). Only a REAL probe rejection lands here — the
      // expected absent states (a resolved null status, unextracted
      // families) are the missing* flags above and keep the normal gate.
      // With no status in hand the dialog takes the same "no status →
      // not-found" variant the gate computes, and "Choose folder…"
      // re-establishes the status through setCS2Dir.
      status = null;
      notFound = true;
      error = `Couldn’t check the CS2 asset status: ${errText(e)}`;
      open = true;
    }
  }

  function close() {
    open = false;
  }

  async function accept() {
    busy = true;
    error = '';
    // Close on Extract (owner 2026-11-17): the run continues in the
    // background and the floating work indicator (App's .wk-pill, driven
    // by lib/workstate.svelte.js) is its surface — begin, honest
    // progress, completion and any failure. The popup's own progress
    // widget and its success line left with this; `busy` still gates the
    // dialog should it be open again while the run is in flight, and is
    // reset in finally as before.
    close();
    try {
      const out = await extractAllAssets({
        dir: pickedDir || (status && status.path) || '',
      });
      // Only observable if the dialog is open again by the time the run
      // lands (the launch probe re-ran); the indicator holds the same
      // aggregated failure either way (assets.js reportWorkError).
      error = out.error;
    } catch (e) {
      error = errText(e);
    } finally {
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
  label={notFound ? S.common.mapPackNotFoundTitle : S.common.mapPackExtractTitle}
  dismissable={!busy}
  onClose={close}
>
  <div class="pk-body">
    {#if notFound}
      <h2 class="pk-title">{S.common.mapPackNotFoundTitle}</h2>
      <p class="muted">
        {S.common.mapPackNotFoundIntro}
      </p>
      <p class="muted pk-fine">
        {S.common.mapPackNotFoundFine}
      </p>
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
    {:else}
      <h2 class="pk-title">{S.common.mapPackFoundTitle}</h2>
      <p class="muted">
        {S.common.mapPackFoundIntro}
      </p>
      <p class="muted pk-path mono">{pickedDir || status?.path || S.common.mapPackInstallFallback}</p>
      <p class="muted pk-fine">
        {S.common.mapPackFoundFine}
      </p>
      <!-- Extraction progress deliberately has NO surface here any more
           (owner 2026-11-17): the popup closes the moment Extract is
           pressed and the floating work indicator (App's .wk-pill) is
           THE progress display for the run — StatusChip stays the ONE
           progress widget, just not inside this dialog. -->
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
    {/if}
  </div>
  <div class="toolbar pk-actions">
    <button class="btn" disabled={busy} onclick={pickFolder}>
      {S.common.mapPackChooseFolder}
    </button>
    <span class="spacer"></span>
    <!-- Session-only dismissal: no suppression pref exists any more, so
         "Not now" closes this launch and the prompt returns on the next
         one while assets are still missing. -->
    <button class="btn" disabled={busy} onclick={close}>{S.common.mapPackNotNow}</button>
    {#if !notFound}
      <button class="btn primary" disabled={busy} onclick={accept}>
        {busy ? S.common.mapPackExtracting : S.common.mapPackExtractAll}
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
  .pk-actions {
    margin-top: 14px;
  }
  .pk-actions .spacer {
    flex: 1;
  }
</style>
