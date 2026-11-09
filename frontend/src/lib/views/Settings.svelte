<script>
  import { onMount } from 'svelte';
  import {
    getVersion,
    getDataInfo,
    getAnalysisConfig,
    setAnalysisConfig,
    recomputeAnalysis,
    listMatches,
    listPlugins,
    installPlugin,
    setPluginEnabled,
    removePlugin,
    getMapPackStatus,
    extractMapPacks,
    getIconManifest,
    extractIcons,
    getSoundManifest,
    extractSounds,
    setMapPackPromptState,
    chooseCS2Dir,
    checkForUpdateNow,
    getPref,
    setPref,
    getDemoDirs,
    setDemoDirs,
    resetDemoDirs,
    chooseDemoDir,
    errText,
  } from '../services.js';
  import { probeAudio } from '../replay/audio.js';
  import { AUDIO_VOL_DEFAULT, prefVolume } from '../replay/sfx.js';
  import { fmtDate } from '../fmt.js';
  import { GLOSSARY } from '../definitions.js';
  import { getTheme, applyTheme } from '../theme.js';
  import { getFontSize, applyFontSize, reconcileFontSize, FONT_SIZES } from '../fontsize.js';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';

  let version = $state('…');
  let info = $state(null);
  let error = $state('');
  let updateBusy = $state(false);

  // The one confirmation modal (ConfirmDialog.svelte) shared by the
  // plugin-removal and recompute prompts below — a bare window.confirm()
  // would take its title from the page ("JavaScript - wails://…").
  let confirmDlg = $state(null);

  // Settings → About → Check for Updates: hands off to the framework's
  // update window (it reports "up to date" and failures itself), so this
  // only guards the button while the check is kicked off.
  async function checkForUpdates() {
    updateBusy = true;
    try {
      await checkForUpdateNow();
    } catch (e) {
      error = errText(e);
    } finally {
      updateBusy = false;
    }
  }

  // M5 appearance: dark default, light tokens in style-m3b.css.
  let theme = $state(getTheme());

  function setTheme(t) {
    theme = applyTheme(t);
  }

  // Font size: small/medium/large segmented control.
  // applyFontSize paints immediately (localStorage cache — main.js applied
  // the same value pre-paint) and the kvstore pref font_size is the durable
  // record, reconciled on every boot by reconcileFontSize().
  let fontSize = $state(getFontSize());

  function setFontSize(sz) {
    fontSize = applyFontSize(sz);
    setPref('font_size', sz).catch((e) => (error = errText(e)));
  }

  const FONT_LABELS = { small: 'Small', medium: 'Medium', large: 'Large' };

  // Replay-audio faders (Audio & voice): the SAME kvstore keys and
  // default as Replay's volume popover (voice_volume / guns_volume /
  // utility_volume / c4_volume — prefs.go) — optimistic local state on
  // every input, durable via setPref, read back in onMount (the
  // font-size pattern).
  let volVoice = $state(AUDIO_VOL_DEFAULT);
  let volGuns = $state(AUDIO_VOL_DEFAULT);
  let volUtil = $state(AUDIO_VOL_DEFAULT);
  let volC4 = $state(AUDIO_VOL_DEFAULT);

  function setVol(bucket, raw) {
    const level = prefVolume(Number(raw) / 100);
    if (bucket === 'voice') volVoice = level;
    else if (bucket === 'guns') volGuns = level;
    else if (bucket === 'c4') volC4 = level;
    else volUtil = level;
    const key =
      bucket === 'voice'
        ? 'voice_volume'
        : bucket === 'guns'
          ? 'guns_volume'
          : bucket === 'c4'
            ? 'c4_volume'
            : 'utility_volume';
    setPref(key, level).catch((e) => (error = errText(e)));
  }

  // Show knife & warmup rounds: pure kvstore pref
  // `show_knife_warmup_rounds`, default off; the Match view consumes it.
  let showKnife = $state(false);

  function setShowKnife(v) {
    showKnife = v;
    setPref('show_knife_warmup_rounds', v).catch((e) => (error = errText(e)));
  }

  // kvstore round-trips JSON, and the only writer of this key passes a
  // real boolean (the toggle's checked state) — anything that is not
  // exactly true (unset, null, corrupt) reads as off.
  function prefBool(v) {
    return v === true;
  }

  // Import dirs (the Settings panel of the same name): the Library lists
  // .dem / .dem.zst files found under them that are not in the library
  // yet, each with a one-click Import. The backend owns the pref — an
  // unset pref means "defaults in effect" (Downloads + the CS2 replay
  // folder, recomputed on every read), so the list below always shows the
  // effective import dirs.
  let demoDirs = $state([]);
  let demoDirsCustom = $state(false);
  let demoDirError = $state('');

  async function refreshDemoDirs() {
    try {
      const r = await getDemoDirs();
      demoDirs = (r && r.dirs) || [];
      demoDirsCustom = !!(r && r.custom);
    } catch (e) {
      demoDirError = errText(e);
    }
  }

  async function saveDemoDirs(dirs) {
    try {
      await setDemoDirs(dirs);
      await refreshDemoDirs();
      demoDirError = '';
    } catch (e) {
      demoDirError = errText(e);
    }
  }

  function removeDemoDir(dir) {
    saveDemoDirs(demoDirs.filter((d) => d !== dir));
  }

  async function addDemoDir() {
    try {
      const dir = await chooseDemoDir();
      if (dir && !demoDirs.includes(dir)) await saveDemoDirs([...demoDirs, dir]);
    } catch (e) {
      demoDirError = errText(e);
    }
  }

  async function onResetDemoDirs() {
    try {
      await resetDemoDirs();
      await refreshDemoDirs();
      demoDirError = '';
    } catch (e) {
      demoDirError = errText(e);
    }
  }

  // Plugins: declarative bundles installed by
  // path; enable/disable/remove reflected on the next list — no restart.
  let plugins = $state([]);  let pluginsError = $state('');
  let pluginsLoading = $state(true);
  let installPath = $state('');
  let installBusy = $state(false);
  let pluginMsg = $state('');
  let pluginOp = $state({}); // plugin id → 'busy' | error text

  // CS2 assets: the THREE asset families the app consumes from a local CS2
  // install — radar map packs (internal/mappack), equipment-icon SVG
  // silhouettes (iconservice) and weapon/utility sounds (soundservice).
  // Valve IP stays local; status loads on mount; the extract below
  // re-runs idempotently after game updates.
  let mpStatus = $state(null); // MapPackStatus
  let iconManifest = $state(null); // IconManifest
  let soundManifest = $state(null); // SoundManifest
  let mpBusy = $state(false);
  let mpMsg = $state('');
  let mpError = $state('');

  async function refreshMapPacks() {
    try {
      mpStatus = await getMapPackStatus();
    } catch (e) {
      mpError = errText(e);
    }
  }

  async function refreshIcons() {
    try {
      iconManifest = await getIconManifest();
    } catch (e) {
      mpError = errText(e);
    }
  }

  async function refreshSounds() {
    try {
      soundManifest = await getSoundManifest();
    } catch (e) {
      mpError = errText(e);
    }
  }

  // The manifest's note is only worth showing when it says MORE than the
  // generic placeholder GetIconManifest stamps on every empty manifest
  // ("icons not extracted yet" — pure duplication next to "none extracted
  // yet"); a real note names the cause (no CS2 install, a VPK error).
  const iconNote = $derived(
    iconManifest && iconManifest.note && iconManifest.note !== 'icons not extracted yet'
      ? iconManifest.note
      : '',
  );

  // The manifest's note is only worth showing when it says MORE than the
  // generic placeholder GetSoundManifest stamps on every empty manifest
  // ("sounds not extracted yet" — pure duplication next to "none extracted
  // yet"); a real note names the cause (no CS2 install, a VPK error) or a
  // partial-extraction failure. Same rule as iconNote above.
  const soundNote = $derived(
    soundManifest && soundManifest.note && soundManifest.note !== 'sounds not extracted yet'
      ? soundManifest.note
      : '',
  );

  // One action, all three families: extract the map packs, the equipment
  // icons and the replay sounds sequentially under the single mpBusy
  // state, then aggregate the outcomes — mpMsg names what succeeded
  // ("…N map packs, M icons, K sounds"), mpError names what failed (every
  // part is attempted even when the first one fails).
  async function doExtract() {
    mpBusy = true;
    mpMsg = '';
    mpError = '';
    const dir = mpStatus?.path || '';
    const done = [];
    const failed = [];
    try {
      try {
        const out = await extractMapPacks(dir);
        const n = (out.maps || []).length;
        const errs = out.errors || [];
        if (n > 0) done.push(`${n} map pack${n === 1 ? '' : 's'}`);
        if (errs.length) failed.push(`map packs: ${errs[0]}`);
        else if (n === 0) failed.push('map packs: nothing extracted');
      } catch (e) {
        failed.push(`map packs: ${errText(e)}`);
      }
      try {
        const m = await extractIcons(dir);
        if (m && m.count > 0) {
          done.push(`${m.count} icon${m.count === 1 ? '' : 's'}`);
          if (m.note) failed.push(`icons: ${m.note}`);
        } else {
          failed.push(`icons: ${(m && m.note) || 'nothing extracted'}`);
        }
      } catch (e) {
        failed.push(`icons: ${errText(e)}`);
      }
      try {
        const s = await extractSounds(dir);
        if (s && s.count > 0) {
          done.push(`${s.count} sound${s.count === 1 ? '' : 's'}`);
          if (s.note) failed.push(`sounds: ${s.note}`);
        } else {
          failed.push(`sounds: ${(s && s.note) || 'nothing extracted'}`);
        }
      } catch (e) {
        failed.push(`sounds: ${errText(e)}`);
      }
      if (done.length) mpMsg = `Extracted ${done.join(', ')}.`;
      if (failed.length) mpError = `${failed.join('; ')}.`;
      if (!done.length && !failed.length) mpError = 'Nothing extracted.';
    } finally {
      await refreshMapPacks();
      await refreshIcons();
      await refreshSounds();
      mpBusy = false;
    }
  }

  async function mpChooseFolder() {
    try {
      const dir = await chooseCS2Dir();
      if (dir) {
        await setMapPackPromptState('', dir);
        await refreshMapPacks();
      }
    } catch (e) {
      mpError = errText(e);
    }
  }

  async function refreshPlugins() {
    pluginsLoading = true;
    try {
      plugins = (await listPlugins()) || [];
      pluginsError = '';
    } catch (e) {
      pluginsError = errText(e);
    } finally {
      pluginsLoading = false;
    }
  }

  async function doInstall() {
    const path = installPath.trim();
    if (!path) return;
    installBusy = true;
    pluginMsg = '';
    pluginsError = '';
    try {
      const st = await installPlugin(path);
      if (st && st.error) pluginMsg = `Installed with validation error: ${st.error}`;
      else pluginMsg = `Installed ${(st && st.manifest && st.manifest.id) || path}.`;
      installPath = '';
      await refreshPlugins();
    } catch (e) {
      pluginsError = errText(e);
    } finally {
      installBusy = false;
    }
  }

  async function togglePlugin(p) {
    const pid = p.manifest.id;
    pluginOp = { ...pluginOp, [pid]: 'busy' };
    try {
      await setPluginEnabled(pid, !p.enabled);
      await refreshPlugins();
    } catch (e) {
      pluginOp = { ...pluginOp, [pid]: errText(e) };
      return;
    }
    const next = { ...pluginOp };
    delete next[pid];
    pluginOp = next;
  }

  async function doRemove(p) {
    const pid = p.manifest.id;
    const ok = await confirmDlg?.ask({
      title: 'Remove plugin?',
      message: `Removes "${p.manifest.name || pid}" (${pid}) and deletes its bundle from disk.`,
      confirmLabel: 'Remove',
    });
    if (!ok) {
      return;
    }
    pluginOp = { ...pluginOp, [pid]: 'busy' };
    try {
      await removePlugin(pid);
      await refreshPlugins();
    } catch (e) {
      pluginOp = { ...pluginOp, [pid]: errText(e) };
      return;
    }
    const next = { ...pluginOp };
    delete next[pid];
    pluginOp = next;
  }

  // Analysis rules (DoD: classification + trade window
  // configurable from Settings; rule_version recorded on save).
  let cfg = $state({
    tradeWindowS: 5,
    ecoFullBuy: 20000,
    ecoForce: 10000,
    tradeOppDistance: 1000,
    ruleVersion: 0,
  });
  let cfgError = $state('');
  let cfgMsg = $state('');
  let cfgLoading = $state(true);

  // Per-match recompute list (recomputeAnalysis is per-match, never global).
  let readyMatches = $state([]);
  let matchesError = $state('');
  let recomputeState = $state({}); // matchId → 'busy' | 'ok' | error text

  // M4 audio self-test: probe creates a throwaway AudioContext,
  // resumes it (user click = gesture), and reports state/rate or the exact
  // device failure with the gst-plugins-good hint.
  let audioProbe = $state(null); // null | {ok, state, sampleRate, error}
  let audioRunning = $state(false);

  async function runAudioSelfTest() {
    audioRunning = true;
    audioProbe = await probeAudio();
    audioRunning = false;
  }

  onMount(() => {
    getVersion()
      .then((v) => (version = v))
      .catch((e) => (error = errText(e)));
    getDataInfo()
      .then((d) => (info = d))
      .catch((e) => (error = errText(e)));
    refreshMapPacks();
    refreshIcons();
    refreshSounds();
    getAnalysisConfig()
      .then((c) => {
        // Merge (not replace) so a missing key falls back to the default
        // above instead of binding an empty input that would save 0.
        if (c) cfg = { ...cfg, ...c };
        cfgLoading = false;
      })
      .catch((e) => {
        cfgError = errText(e);
        cfgLoading = false;
      });
    listMatches('', 'extracted_at', false)
      .then((rows) => {
        readyMatches = (rows || []).filter((m) => m.status === 'ready');
      })
      .catch((e) => {
        matchesError = errText(e);
      });
    refreshPlugins();
    // Prefs: the font size re-reconciles against the durable kvstore (the
    // boot-time pass may still be in flight for a deep-linked Settings),
    // and the knife/warmup toggle reads its bool (never-set = off).
    reconcileFontSize()
      .then((v) => (fontSize = v))
      .catch(() => {});
    getPref('show_knife_warmup_rounds')
      .then((v) => (showKnife = prefBool(v)))
      .catch(() => {
        /* keep the default (off) */
      });
    // Replay-audio faders: read the four persisted levels back (the
    // boot-time pass may still be in flight for a deep-linked Settings);
    // never-set/corrupt falls to the shared 0.8 default so a broken pref
    // can never bind a 0-fader slider.
    Promise.all([
      getPref('voice_volume').catch(() => null),
      getPref('guns_volume').catch(() => null),
      getPref('utility_volume').catch(() => null),
      getPref('c4_volume').catch(() => null),
    ])
      .then(([v, g, u, c]) => {
        volVoice = prefVolume(v);
        volGuns = prefVolume(g);
        volUtil = prefVolume(u);
        volC4 = prefVolume(c);
      })
      .catch(() => {
        /* keep the defaults */
      });
    refreshDemoDirs();
  });

  async function saveCfg() {
    cfgError = '';
    cfgMsg = '';
    try {
      const saved = await setAnalysisConfig({
        tradeWindowS: Number(cfg.tradeWindowS) || 0,
        ecoFullBuy: Number(cfg.ecoFullBuy) || 0,
        ecoForce: Number(cfg.ecoForce) || 0,
        tradeOppDistance: Number(cfg.tradeOppDistance) || 0,
      });
      if (saved) cfg = { ...cfg, ...saved };
      cfgMsg =
        `Saved — rule_version ${cfg.ruleVersion}. Stored rows keep the version they ` +
        'were computed with; run a recompute below to apply the new rules.';
    } catch (e) {
      cfgError = errText(e);
    }
  }

  async function recompute(m) {
    const ok = await confirmDlg?.ask({
      title: 'Recompute analysis?',
      message:
        `Recompute analysis for ${m.map || 'match #' + m.id} (${fmtDate(m.extractedAt)}) ` +
        'under the current rules? Stored derived rows for this match are rebuilt.',
      confirmLabel: 'Recompute',
      danger: false,
    });
    if (!ok) {
      return;
    }
    recomputeState = { ...recomputeState, [m.id]: 'busy' };
    try {
      await recomputeAnalysis(m.id);
      recomputeState = { ...recomputeState, [m.id]: 'ok' };
    } catch (e) {
      recomputeState = { ...recomputeState, [m.id]: errText(e) };
    }
  }

</script>

<div class="view">
  <header class="view-header">
    <h1>Settings</h1>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <section class="panel">
    <h2>About</h2>
    <p>
      Spectra <span class="muted">v{version}</span> — an offline, local-first
      CS2 demo viewer and match analysis toolkit. Demos are parsed on your
      machine; nothing is uploaded anywhere.
    </p>
    <div class="row-between">
      <span class="muted"
        >Checks GitHub Releases for a newer version and runs the update flow
        when one exists (already up to date is reported too).</span
      >
      <button class="btn" disabled={updateBusy} onclick={checkForUpdates}>
        {updateBusy ? 'Checking…' : 'Check for Updates…'}
      </button>
    </div>
  </section>

  <section class="panel">
    <h2>Data</h2>
    {#if info}
      <dl class="facts">
        <div class="fact-wide">
          <dt>Database</dt>
          <dd class="mono">{info.dbPath}</dd>
        </div>
        <div class="fact-wide">
          <dt>Matches directory</dt>
          <dd class="mono">{info.matchesDir}</dd>
        </div>
        <div>
          <dt>Parser version</dt>
          <dd class="mono">{info.parserVersion}</dd>
        </div>
      </dl>
    {:else if !error}
      <p class="muted" role="status">Loading…</p>
    {/if}
  </section>

  <section class="panel">
    <h2>Import dirs</h2>
    <p class="muted">
      The Library lists <span class="mono">.dem</span> /
      <span class="mono">.dem.zst</span> files found in these import dirs and imports
      them with one click — each import copies the demo into Spectra’s data
      folder, so your original files are never moved, modified or deleted.
      Subfolders are scanned up to four levels deep; hidden folders are skipped.
      Demos already in the Library are left out of the list.
    </p>
    {#if demoDirs.length === 0}
      <p class="muted" role="status">
        No import dirs — the Library won’t offer any demos to import.
      </p>
    {:else}
      <div class="sett-dirs">
        {#each demoDirs as dir (dir)}
          <div class="sett-dir-row">
            <span class="mono sett-dir-path" title={dir}>{dir}</span>
            <button
              class="btn small danger"
              aria-label={`Remove ${dir}`}
              onclick={() => removeDemoDir(dir)}>Remove</button
            >
          </div>
        {/each}
      </div>
    {/if}
    {#if demoDirError}
      <p class="error" role="alert">{demoDirError}</p>
    {/if}
    <div class="row-between">
      <span class="muted">
        {demoDirsCustom
          ? 'Saved as your list — the defaults no longer apply.'
          : 'Defaults in effect: your Downloads folder and the CS2 replay folder, where the client saves downloaded matches.'}
      </span>
      <div class="sett-seg">
        <button class="btn" onclick={addDemoDir}>Add folder…</button>
        <button class="btn" disabled={!demoDirsCustom} onclick={onResetDemoDirs}
          >Reset to defaults</button
        >
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>CS2 assets</h2>
    <p class="muted">
      Radar map transforms, equipment-icon silhouettes and replay sounds are
      all extracted locally from your own Counter-Strike 2 installation on
      this machine — nothing is uploaded, and no Valve assets ship with the
      app.
    </p>
    {#if mpStatus}
      <dl class="facts">
        <div class="fact-wide">
          <dt>CS2 install</dt>
          <dd class="mono">
            {mpStatus.found ? mpStatus.path : 'not found'}
            {#if mpStatus.manual}<span class="chip">manual</span>{/if}
          </dd>
        </div>
        <div>
          <dt>Extracted packs</dt>
          <dd class="mono">
            {mpStatus.maps && mpStatus.maps.length
              ? `${mpStatus.maps.length} (${mpStatus.maps.join(', ')})`
              : 'none'}
          </dd>
        </div>
        <div>
          <dt>Equipment icons</dt>
          <dd class="mono">
            {#if !iconManifest}
              …
            {:else if iconManifest.count > 0}
              {iconManifest.count}
            {:else}
              none extracted yet{#if iconNote} — {iconNote}{/if}
            {/if}
          </dd>
        </div>
        <div>
          <dt>Replay sounds</dt>
          <dd class="mono">
            {#if !soundManifest}
              …
            {:else if soundManifest.count > 0}
              {soundManifest.count}{soundNote ? ` — ${soundNote}` : ''}
            {:else}
              none extracted yet{#if soundNote} — {soundNote}{/if}
            {/if}
          </dd>
        </div>
      </dl>
    {:else}
      <p class="muted" role="status">Loading…</p>
    {/if}
    {#if mpMsg}<p class="sett-msg" role="status">{mpMsg}</p>{/if}
    {#if mpError}<p class="error" role="alert">{mpError}</p>{/if}
    <div class="row-between">
      <span class="muted"
        >Extracts every official-map radar, every equipment icon and the
        replay's gun/utility sounds (idempotent — re-run after a CS2 update
        to refresh).</span
      >
      <div class="sett-seg">
        <button class="btn" disabled={mpBusy} onclick={mpChooseFolder}>
          Choose folder…
        </button>
        <button class="btn primary" disabled={mpBusy || !mpStatus?.found} onclick={doExtract}>
          {mpBusy ? 'Extracting…' : 'Extract all CS2 assets'}
        </button>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Appearance</h2>
    <div class="row-between">
      <span class="muted"
        >Theme — dark ships as the default. The choice is remembered and
        applied at startup.</span
      >
      <div class="sett-seg" role="group" aria-label="Theme">
        <button
          class="btn"
          class:primary={theme === 'dark'}
          aria-pressed={theme === 'dark'}
          onclick={() => setTheme('dark')}>Dark</button
        >
        <button
          class="btn"
          class:primary={theme === 'light'}
          aria-pressed={theme === 'light'}
          onclick={() => setTheme('light')}>Light</button
        >
      </div>
    </div>
    <div class="row-between">
      <span class="muted"
        >Font size — scales the whole UI (13 / 15 / 17 px); applied instantly
        and remembered across restarts. Medium is the default.</span
      >
      <div class="sett-seg" role="group" aria-label="Font size">
        {#each FONT_SIZES as sz (sz)}
          <button
            class="btn"
            class:primary={fontSize === sz}
            aria-pressed={fontSize === sz}
            onclick={() => setFontSize(sz)}>{FONT_LABELS[sz]}</button
          >
        {/each}
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Match view</h2>
    <div class="row-between">
      <label class="filt-check" for="sett-knife">
        <input
          id="sett-knife"
          type="checkbox"
          checked={showKnife}
          onchange={(e) => setShowKnife(e.target.checked)}
        />
        <span>Show knife &amp; warmup rounds</span>
      </label>
      <span class="muted"
        >Include pregame knife and warmup rounds (negative round numbers,
        not counted play) in the round lists. Off by default.</span
      >
    </div>
  </section>

  <section class="panel">
    <h2>Plugins</h2>
    <p class="muted">
      Declarative bundles: a directory with
      <span class="mono">spectra-plugin.json</span> (plus optional metric /
      report-template definitions) or a single manifest JSON. Enabled plugins
      contribute metrics and report templates on the next list — no restart.
    </p>
    <div class="row-between">
      <input
        class="input sett-plugin-path"
        placeholder="/path/to/plugin-dir or manifest.json"
        bind:value={installPath}
        onkeydown={(e) => e.key === 'Enter' && doInstall()}
        aria-label="Plugin source path"
      />
      <button class="btn primary" disabled={installBusy || !installPath.trim()} onclick={doInstall}
        >{installBusy ? 'Installing…' : 'Install from path'}</button
      >
    </div>
    {#if pluginsError}
      <p class="error" role="alert">{pluginsError}</p>
    {/if}
    {#if pluginMsg}
      <p class="sett-msg" role="status">{pluginMsg}</p>
    {/if}
    {#if pluginsLoading}
      <p class="muted" role="status">Loading plugins…</p>
    {:else if plugins.length === 0}
      <p class="muted" role="status">No plugins installed yet.</p>
    {:else}
      <div class="sett-plugins">
        {#each plugins as p (p.manifest.id)}
          {@const op = pluginOp[p.manifest.id]}
          <div class="plugin-row" class:plugin-disabled={!p.enabled}>
            <span class="plugin-name">
              <strong>{p.manifest.name || p.manifest.id}</strong>
              <span class="mono muted"> {p.manifest.id} · v{p.manifest.version}</span>
            </span>
            <span class="chip" title="Metrics contributed">{(p.manifest.metrics || []).length} metrics</span>
            <span class="chip" title="Report templates contributed"
              >{(p.manifest.reportTpls || []).length} templates</span
            >
            {#if p.error}
              <span class="error-text" title={p.error}>invalid</span>
            {:else}
              <button
                class="btn small"
                class:warn={p.enabled}
                disabled={op === 'busy'}
                aria-pressed={p.enabled}
                onclick={() => togglePlugin(p)}
                title={p.enabled ? 'Disable plugin' : 'Enable plugin'}
                >{p.enabled ? 'Enabled' : 'Disabled'}</button
              >
            {/if}
            {#if op && op !== 'busy'}
              <span class="error-text" title={op}>failed</span>
            {/if}
            <span class="spacer"></span>
            <button class="btn small danger" disabled={op === 'busy'} onclick={() => doRemove(p)}
              >Remove</button
            >
            {#if p.error}
              <p class="plugin-err error-text">{p.error}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    <p class="muted">
      Trust model: install only bundles you built or got from someone you
      trust — manifests may pin a sha256 hash; there is no auto-update.
    </p>
  </section>

  <section class="panel">
    <h2>Audio &amp; voice</h2>
    <div class="row-between">
      <span class="muted"
        >Audio self-test — creates an AudioContext, resumes it and reports the
        device state.</span
      >
      <button class="btn" onclick={runAudioSelfTest} disabled={audioRunning}
        >{audioRunning ? 'Testing…' : 'Run audio self-test'}</button
      >
    </div>
    {#if audioProbe}
      {#if audioProbe.ok}
        <p class="sett-audio-ok" role="status">
          PASS — AudioContext running at {audioProbe.sampleRate} Hz.
        </p>
      {:else}
        <p class="error" role="alert">
          FAIL — {audioProbe.error}
        </p>
        {#if !audioProbe.error.includes('gst-plugins-good')}
          <p class="muted">
            Hint: on Linux install <span class="mono">gst-plugins-good</span>
            (GStreamer) so WebKitGTK can open the audio device, then retry.
          </p>
        {/if}
      {/if}
    {/if}
    <!-- The four replay-audio faders: same kvstore keys (and default)
         as the transport's Volume popover — moving one here moves the
         other, and both survive restarts. -->
    <div class="row-between">
      <span class="muted">Voice volume — the players' radio chatter in the replay.</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volVoice * 100)}
        aria-label="Voice volume"
        oninput={(e) => setVol('voice', e.currentTarget.value)}
      />
    </div>
    <div class="row-between">
      <span class="muted">Guns volume — weapon fire in the replay.</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volGuns * 100)}
        aria-label="Guns volume"
        oninput={(e) => setVol('guns', e.currentTarget.value)}
      />
    </div>
    <div class="row-between">
      <span class="muted">Utility volume — grenade detonations in the replay.</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volUtil * 100)}
        aria-label="Utility volume"
        oninput={(e) => setVol('utility', e.currentTarget.value)}
      />
    </div>
    <div class="row-between">
      <span class="muted">C4 volume — the planted bomb's beeps and its explosion.</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volC4 * 100)}
        aria-label="C4 volume"
        oninput={(e) => setVol('c4', e.currentTarget.value)}
      />
    </div>
    <p class="muted">
      Sound effects are extracted from your local CS2 install (CS2 assets
      above); the replay plays gun, utility and C4 sounds when they are
      available.
    </p>
    <p class="muted">
      Voice decode: on-demand Opus decode (pure-Go pion/opus) — no cache
      directory in v1. PCM is served over HTTP per playback window at 16 kHz
      mono and mixed live with the replay clock.
    </p>
    <p class="muted">
      Transcription (local whisper) is not included — no whisper UI in this
      app; the storage and export fields stay reserved for future use.
    </p>
  </section>

  <section class="panel">
    <h2>Analysis rules</h2>
    {#if cfgError}
      <p class="error" role="alert">{cfgError}</p>
    {/if}
    {#if cfgLoading && !cfgError}
      <p class="muted" role="status">Loading…</p>
    {/if}
    <div class="sett-rules">
      <div class="sett-field">
        <label class="field-label" for="sett-trade">Trade window (seconds)</label>
        <input
          class="input"
          id="sett-trade"
          type="number"
          min="1"
          max="30"
          step="0.5"
          bind:value={cfg.tradeWindowS}
        />
        <span class="muted sett-hint">Kill after a teammate death within this window = trade (default 5).</span>
      </div>
      <div class="sett-field">
        <label class="field-label" for="sett-full">Full-buy threshold (equip $)</label>
        <input
          class="input"
          id="sett-full"
          type="number"
          min="0"
          step="100"
          bind:value={cfg.ecoFullBuy}
        />
        <span class="muted sett-hint">Team equipment ≥ this = full buy (default 20000).</span>
      </div>
      <div class="sett-field">
        <label
          class="field-label"
          for="sett-trade-dist"
          title="A death counts as a missed trade opportunity only if a living teammate of the victim was within this distance of the killer at the death tick — someone close enough to actually trade him. The proximity is measured once per kill at import; this threshold only gates the count. Deaths with no nearby teammate or no position data never count.">Trade-opportunity distance (units)</label
        >
        <input
          class="input"
          id="sett-trade-dist"
          type="number"
          min="0"
          step="10"
          bind:value={cfg.tradeOppDistance}
        />
        <span class="muted sett-hint"
          >“Trade opp missed” counts an untraded death only when a living teammate of the victim was within this distance of the killer (default 1000).</span
        >
      </div>
      <div class="sett-field">
        <label class="field-label" for="sett-force">Force threshold (equip $)</label>
        <input
          class="input"
          id="sett-force"
          type="number"
          min="0"
          step="100"
          bind:value={cfg.ecoForce}
        />
        <span class="muted sett-hint">Team equipment ≥ this = force buy (default 10000).</span>
      </div>
    </div>
    <div class="row-between">
      <span class="muted">Active rule_version: <strong class="mono">{cfg.ruleVersion}</strong></span>
      <button class="btn primary" onclick={saveCfg}>Save rules</button>
    </div>
    {#if cfgMsg}
      <p class="sett-msg" role="status">{cfgMsg}</p>
    {/if}
    <p class="muted">
      Saving stores the rules and bumps <span class="mono">rule_version</span>;
      it does <strong>not</strong> rewrite stored rows — recompute explicitly below.
    </p>

    <h3 class="section-title sett-sub">Recompute analysis…</h3>
    <p class="muted">
      Per match, under the current rules (classification, KAST, clutches,
      engagements, career rollups refresh too).
    </p>
    {#if matchesError}
      <p class="error" role="alert">{matchesError}</p>
    {/if}
    <div class="sett-matches">
      {#each readyMatches as m (m.id)}
        {@const state = recomputeState[m.id]}
        <div class="sett-match-row">
          <span>
            <span class="chip side ct">#{m.id}</span>
            {m.map || '—'} · {m.scoreCT}–{m.scoreT} · {fmtDate(m.extractedAt)}
          </span>
          <span class="row-actions">
            {#if state === 'busy'}
              <span class="muted">recomputing…</span>
            {:else if state === 'ok'}
              <span class="chip status ok">done</span>
            {:else if state}
              <span class="error-text" title={state}>failed</span>
              <button class="btn small" onclick={() => recompute(m)}>Retry</button>
            {:else}
              <button class="btn small" onclick={() => recompute(m)}>Recompute</button>
            {/if}
          </span>
        </div>
      {:else}
        <p class="muted" role="status">
          {matchesError ? 'Matches unavailable.' : 'No ready matches to recompute yet.'}
        </p>
      {/each}
    </div>
  </section>

  <section class="panel">
    <h2>Metric definitions</h2>
    <p class="muted">
      Every derived or heuristic number in the app, with its rule. Thresholds
      live in <span class="mono">analysis_config</span> and are versioned —
      stored rows keep the <span class="mono">rule_version</span> they were
      computed with.
    </p>
    <div class="sett-defs">
      {#each GLOSSARY as d (d.term)}
        <details>
          <summary>
            {d.term}
            {#if d.inferred}
              <span
                class="chip badge-inferred"
                title="Heuristic/reconstructed — not a raw demo fact"
              >inferred</span>
            {/if}
          </summary>
          <p>{d.text}</p>
        </details>
      {/each}
    </div>
  </section>

  <ConfirmDialog bind:this={confirmDlg} />
</div>
