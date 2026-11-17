<script>
  import * as S from '../strings/index.js';
  import { onMount } from 'svelte';
  import {
    getVersion,
    getDataInfo,
    getAnalysisConfig,
    setAnalysisConfig,
    recomputeAll,
    listPlugins,
    installPlugin,
    choosePluginSource,
    choosePluginFile,
    setPluginEnabled,
    removePlugin,
    getMapPackStatus,
    getIconManifest,
    getSoundManifest,
    setCS2Dir,
    chooseCS2Dir,
    checkForUpdateNow,
    getPref,
    setPref,
    getDemoDirs,
    setDemoDirs,
    resetDemoDirs,
    chooseDemoDir,
    getDemoCopyOnImport,
    setDemoCopyOnImport,
    getParallelWork,
    setParallelWork,
    freeAllDemoCopies,
    listJobs,
    onAssetProgress,
    errText,
  } from '../services.js';
  import { extractAllAssets, assetFamilyForStep } from '../assets.js';
  import { probeAudio } from '../replay/audio.js';
  import { AUDIO_VOL_DEFAULT, FOOTSTEPS_VOL_DEFAULT, prefVolume } from '../replay/sfx.js';
  import { fmtBytes } from '../fmt.js';
  import { getTheme, applyTheme } from '../theme.js';
  import { getFontSize, applyFontSize, reconcileFontSize, FONT_SIZES } from '../fontsize.js';
  // The loop-length pref's ONE home (default + coercer) — Settings is a
  // consumer like the replay transport and the event ▶ links.
  import { LOOP_SECS_DEFAULT, prefLoopSecs } from '../nav.js';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import HelpButton from '../components/HelpButton.svelte';

  // The header `?` (HelpButton.svelte) — App hands the view its
  // openDocs; Settings is the one view that had no props at all.
  let { openDocs = () => {} } = $props();

  let version = $state('…');
  let info = $state(null);
  let error = $state('');
  let updateBusy = $state(false);

  // The one confirmation modal (ConfirmDialog.svelte) shared by the
  // plugin-removal and free-copies prompts below — a bare window.confirm()
  // would take its title from the page ("JavaScript - wails://…").
  let confirmDlg = $state(null);

  // Settings → About → Check for Updates: hands off to the framework's
  // update window (it reports "up to date" and failures itself), so this
  // only guards the button while the check is kicked off.
  async function checkForUpdates() {
    error = ''; // clears-on-retry: a new attempt starts with a clean banner
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
    error = ''; // clears-on-retry
    fontSize = applyFontSize(sz);
    setPref('font_size', sz).catch((e) => (error = errText(e)));
  }

  const FONT_LABELS = { small: 'Small', medium: 'Medium', large: 'Large' };

  // Replay-audio faders (Audio & voice): the SAME kvstore keys and
  // defaults as Replay's volume popover (voice_volume / guns_volume /
  // utility_volume / c4_volume / announcer_volume / footsteps_volume —
  // prefs.go) —
  // optimistic local state on
  // every input, durable via setPref, read back in onMount (the
  // font-size pattern). The FOOTSTEPS level defaults to
  // FOOTSTEPS_VOL_DEFAULT (0.8 = 80 %) — it is muted by the replay
  // popover's session mute, never by the fader (owner instruction
  // 2026-11-10), so this surface has no mute control of its own.
  let volVoice = $state(AUDIO_VOL_DEFAULT);
  let volGuns = $state(AUDIO_VOL_DEFAULT);
  let volUtil = $state(AUDIO_VOL_DEFAULT);
  let volC4 = $state(AUDIO_VOL_DEFAULT);
  let volAnnouncer = $state(AUDIO_VOL_DEFAULT);
  let volSteps = $state(FOOTSTEPS_VOL_DEFAULT);

  function setVol(bucket, raw) {
    error = ''; // clears-on-retry
    const level = prefVolume(Number(raw) / 100, bucket === 'footsteps' ? FOOTSTEPS_VOL_DEFAULT : AUDIO_VOL_DEFAULT);
    if (bucket === 'voice') volVoice = level;
    else if (bucket === 'guns') volGuns = level;
    else if (bucket === 'c4') volC4 = level;
    else if (bucket === 'announcer') volAnnouncer = level;
    else if (bucket === 'footsteps') volSteps = level;
    else volUtil = level;
    const key =
      bucket === 'voice'
        ? 'voice_volume'
        : bucket === 'guns'
          ? 'guns_volume'
          : bucket === 'c4'
            ? 'c4_volume'
            : bucket === 'announcer'
              ? 'announcer_volume'
              : bucket === 'footsteps'
                ? 'footsteps_volume'
                : 'utility_volume';
    setPref(key, level).catch((e) => (error = errText(e)));
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
      demoDirError = ''; // a successful panel read clears the slot (Retry below)
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

  // Copy-on-import (the copy_on_import pref — Go reads it PER JOB
  // through library.Options.CopyEnabled, so a flip here applies to
  // queued jobs too). On is the default, and a read failure keeps it on:
  // the toggle must never fail "closed" into silently skipping copies.
  let copyOnImport = $state(true);

  async function refreshCopyOnImport() {
    try {
      copyOnImport = await getDemoCopyOnImport();
    } catch (e) {
      demoDirError = errText(e);
    }
  }

  async function setCopyOnImport(v) {
    const prev = copyOnImport;
    copyOnImport = v; // optimistic: the checkbox paints immediately
    try {
      await setDemoCopyOnImport(v);
      demoDirError = '';
    } catch (e) {
      copyOnImport = prev; // roll back — the pref didn't take
      demoDirError = errText(e);
    }
  }

  // Parallel work (the parallel_work pref — Go resizes the ONE shared
  // work-token budget on set, so a change applies to work already
  // queued or waiting, exactly like copy-on-import above). 1 = one
  // heavy background task at a time; the default AND the ceiling come
  // from the backend (budget.MachineTokens — this machine's
  // parallelism) — never guessed in the frontend. A read failure keeps
  // the floor view (the control must never paint a value the backend
  // didn't say) and says so in the card's own error slot.
  let parallelWork = $state(1);
  let parallelMax = $state(1);
  let parallelError = $state('');

  async function refreshParallelWork() {
    try {
      const p = await getParallelWork();
      parallelWork = p.value;
      parallelMax = p.max;
      parallelError = ''; // a successful panel read clears the slot (Retry below)
    } catch (e) {
      parallelError = errText(e);
    }
  }

  async function saveParallelWork(n) {
    const prev = parallelWork;
    parallelWork = n; // optimistic: the input paints immediately
    try {
      await setParallelWork(n);
      parallelError = '';
    } catch (e) {
      parallelWork = prev; // roll back — the pref didn't take
      parallelError = errText(e);
    }
  }

  // onParallelWorkChange snaps out-of-range or non-numeric input to the
  // honest clamped value BEFORE saving (the input's own min/max are
  // advisory — typed values still land on [1, parallelMax], never 0).
  function onParallelWorkChange(e) {
    const n = Math.min(Math.max(Number.parseInt(e.target.value, 10) || 1, 1), parallelMax);
    e.target.value = String(n); // snap the DOM even when state doesn't move
    saveParallelWork(n);
  }

  // Replay loop length (the loop_secs pref — frontend-owned kvstore, the
  // font_size pattern): how many seconds a loop spans around the
  // playhead or an event. The SAME number drives the replay transport's
  // quick-range button and every event-level ▶ link (nav.prefLoopSecs is
  // the one coercer, LOOP_SECS_DEFAULT the one default), so this control
  // and those surfaces can never disagree; an unset/corrupt pref reads
  // back as the default. Bounds are the coercer's own — min/max below.
  let loopSecs = $state(LOOP_SECS_DEFAULT);

  function saveLoopSecs(n) {
    error = ''; // clears-on-retry
    loopSecs = n; // optimistic: the input paints immediately
    setPref('loop_secs', n).catch((e) => (error = errText(e)));
  }

  // onLoopSecsChange snaps out-of-range or non-numeric input through the
  // SAME coercer the read path uses BEFORE saving (the input's own
  // min/max are advisory — typed values still land on [1, 60] rounded to
  // whole seconds, and garbage — an empty number field — lands on the
  // default, never 0).
  function onLoopSecsChange(e) {
    const raw = e.target.value;
    const n = prefLoopSecs(raw === '' ? NaN : Number(raw));
    e.target.value = String(n); // snap the DOM even when state doesn't move
    saveLoopSecs(n);
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
  // Live extraction progress: mpStep names the family step currently
  // running (set before each awaited call in doExtract), mpProgress holds
  // the last spectra:asset-progress payload ({family, stage, done, total})
  // — every family emits one now (mappackservice.go's shared emitter), so
  // each step renders the determinate bar from its own numbers.
  let mpStep = $state('');
  let mpProgress = $state(null);

  // The payload of the step CURRENTLY running, gated on that step's own
  // family (assets.js assetFamilyForStep): a stale payload from the
  // previous step or a concurrent run's payload for another family never
  // drives this display. Null between steps → StatusChip's indeterminate
  // spinner (block mode, progress 0) — never a pretended percentage.
  const mpStepProgress = $derived(
    mpProgress && mpProgress.family === assetFamilyForStep(mpStep) ? mpProgress : null,
  );

  // 0 = the indeterminate spinner (StatusChip block mode), a real 0..1 =
  // the ring plus its percentage in the details line underneath.
  const mpPct = $derived(
    mpStepProgress && mpStepProgress.total > 0
      ? Math.min(1, mpStepProgress.done / mpStepProgress.total)
      : 0,
  );

  // The details line under the block-mode indicator: the running step's
  // name plus its honest counts — byte-for-byte MapPackPrompt's
  // stepDetail (the identical site there), the counts only while that
  // step's own payload has any (between steps the line is the step name
  // alone).
  const mpDetail = $derived(
    mpStep
      ? `Extracting ${mpStep}…${
          mpStepProgress && mpStepProgress.done > 0
            ? ` ${mpStepProgress.done} of ${mpStepProgress.total}`
            : ''
        }`
      : '',
  );

  // Subscribe for the whole view lifetime; the unsubscribe is the $effect
  // cleanup (the pattern documented at services.js onEvent). Only the
  // RUNNING step's family is accepted: a concurrent run's payloads
  // (Replay's background icon auto-extract) and the previous step's
  // closing payload can never clobber this step's numbers — worst case
  // the bar stays indeterminate, never wrong.
  $effect(() => {
    const off = onAssetProgress((p) => {
      if (p && p.family === assetFamilyForStep(mpStep)) mpProgress = p;
    });
    return off;
  });

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

  // One action, all three families: delegate to lib/assets.js — THE
  // shared three-step extraction (map packs → equipment icons → replay
  // sounds) whose result message names what succeeded ("…N map packs, M
  // icons, K sounds") and what failed (every part is attempted even when
  // the first one fails). This view keeps the render: the mpBusy gate,
  // the mpStep label in StatusChip's details line, and the refreshes in
  // finally.
  async function doExtract() {
    mpBusy = true;
    mpMsg = '';
    mpError = '';
    // Drop any progress a previous run (or MapPackPrompt's own extract)
    // left behind — the first spectra:asset-progress of THIS run replaces
    // it; without this the bar could open at a stale "18 of 18".
    mpProgress = null;
    try {
      const out = await extractAllAssets({
        dir: mpStatus?.path || '',
        onStep: (label) => (mpStep = label),
      });
      mpMsg = out.msg;
      mpError = out.error;
    } finally {
      await refreshMapPacks();
      await refreshIcons();
      await refreshSounds();
      // Step label + progress die with the run — the row below renders
      // only while mpBusy AND a step is armed.
      mpStep = '';
      mpProgress = null;
      mpBusy = false;
    }
  }

  async function mpChooseFolder() {
    try {
      const dir = await chooseCS2Dir();
      if (dir) {
        await setCS2Dir(dir);
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

  async function browsePlugin() {
    // The bundle-directory picker (the common case); cancel resolves ""
    // and leaves the current selection alone. browsePluginFile below is
    // its manifest-file twin — no native dialog on our platforms mixes
    // files and folders, so each source kind gets a picker.
    try {
      const chosen = await choosePluginSource();
      if (chosen) installPath = chosen;
    } catch (e) {
      pluginsError = errText(e);
    }
  }

  async function browsePluginFile() {
    // The manifest-file twin of browsePlugin (no native dialog on our
    // platforms mixes files and folders): same read-only display, same
    // arming, and it REPLACES any path the directory picker left — one
    // display, one picked path.
    try {
      const chosen = await choosePluginFile();
      if (chosen) installPath = chosen;
    } catch (e) {
      pluginsError = errText(e);
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

  // Pristine tracking (save-UX honesty): cfgPristine snapshots the four
  // editable fields as a save would submit them (Number(...) || 0 — the
  // exact payload saveCfg sends), set on load and re-set after every
  // successful save. cfgDirty is that comparison, so Save is disabled
  // while the form matches the stored rules and the status slot reads
  // "No changes" instead of the post-save note. Bump semantics
  // stay server-side (SetConfig no-ops an identical save); this only
  // reports them.
  const CFG_FIELDS = ['tradeWindowS', 'ecoFullBuy', 'ecoForce', 'tradeOppDistance'];
  let cfgPristine = $state(null);
  const cfgDirty = $derived.by(() => {
    if (!cfgPristine) return false;
    return CFG_FIELDS.some((f) => Number(cfg[f]) !== cfgPristine[f]);
  });
  function snapCfg() {
    const s = {};
    for (const f of CFG_FIELDS) s[f] = Number(cfg[f]) || 0;
    cfgPristine = s;
  }

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

  // Settings → Data: refresh keeps info (and the copy count/bytes it
  // shows) current after a free; jobsPending gates the bulk free so a
  // sweep can never race an import that is mid-copy (the frontend gate —
  // re-read right before the dialog, and again after confirming).
  let dataBusy = $state(false);
  let dataMsg = $state('');
  let dataError = $state('');
  let jobsPending = $state(false);

  function refreshDataInfo() {
    error = ''; // clears-on-retry: a fresh read starts with a clean banner
    return getDataInfo()
      .then((d) => (info = d))
      .catch((e) => (error = errText(e)));
  }

  async function refreshJobsPending() {
    try {
      const jobs = await listJobs();
      jobsPending = (jobs || []).some((j) => j.status === 'queued' || j.status === 'running');
    } catch {
      jobsPending = false; // no job list → don't block the button on a failed read
    }
  }

  async function onFreeAllCopies() {
    dataMsg = '';
    dataError = '';
    await refreshJobsPending();
    if (jobsPending) {
      dataError = 'An import is still running — try again once it finishes.';
      return;
    }
    if (!info || info.demoCount === 0) return;
    const ok = await confirmDlg?.ask({
      title: 'Free all demo copies?',
      message:
        `Removes the ${info.demoCount} demo files (${fmtBytes(info.demoBytes)}) Spectra keeps under ` +
        `${info.demosDir}. Your matches, sidecars and original files stay untouched — Re-parse ` +
        'will then need your original file to still exist.',
      confirmLabel: 'Free all copies',
      danger: true,
    });
    if (!ok) return;
    dataBusy = true;
    try {
      const freed = await freeAllDemoCopies();
      dataMsg = `Freed ${fmtBytes(typeof freed === 'number' ? freed : 0)}.`;
      await refreshDataInfo();
      await refreshJobsPending();
    } catch (e) {
      dataError = errText(e);
    } finally {
      dataBusy = false;
    }
  }

  onMount(() => {
    error = ''; // the banner starts clean on every mount
    getVersion()
      .then((v) => (version = v))
      .catch((e) => (error = errText(e)));
    refreshDataInfo();
    refreshJobsPending();
    refreshMapPacks();
    refreshIcons();
    refreshSounds();
    getAnalysisConfig()
      .then((c) => {
        // Merge (not replace) so a missing key falls back to the default
        // above instead of binding an empty input that would save 0.
        if (c) cfg = { ...cfg, ...c };
        snapCfg(); // pristine = the loaded rules — Save starts disabled
        cfgLoading = false;
      })
      .catch((e) => {
        cfgError = errText(e);
        cfgLoading = false;
      });
    refreshPlugins();
    // Prefs: the font size re-reconciles against the durable kvstore (the
    // boot-time pass may still be in flight for a deep-linked Settings).
    reconcileFontSize()
      .then((v) => (fontSize = v))
      .catch(() => {});
    // Replay-audio faders + the loop length: read the persisted values
    // back (the boot-time pass may still be in flight for a deep-linked
    // Settings); never-set/corrupt falls to each key's OWN default — the
    // shared 0.8 for five of them, FOOTSTEPS_VOL_DEFAULT (0.8 = 80 %) for
    // footsteps (muted by the replay popover's session mute, not by the
    // fader), LOOP_SECS_DEFAULT for the loop length — so a broken pref
    // can never bind a wrong control value.
    Promise.all([
      getPref('voice_volume').catch(() => null),
      getPref('guns_volume').catch(() => null),
      getPref('utility_volume').catch(() => null),
      getPref('c4_volume').catch(() => null),
      getPref('announcer_volume').catch(() => null),
      getPref('footsteps_volume').catch(() => null),
      getPref('loop_secs').catch(() => null),
    ])
      .then(([v, g, u, c, a, s, ls]) => {
        volVoice = prefVolume(v);
        volGuns = prefVolume(g);
        volUtil = prefVolume(u);
        volC4 = prefVolume(c);
        volAnnouncer = prefVolume(a);
        volSteps = prefVolume(s, FOOTSTEPS_VOL_DEFAULT);
        // Loop length: unset/corrupt → the default (nav.prefLoopSecs).
        loopSecs = prefLoopSecs(ls);
      })
      .catch(() => {
        /* keep the defaults */
      });
    refreshDemoDirs();
    refreshCopyOnImport();
    refreshParallelWork();
  });

  async function saveCfg() {
    cfgError = '';
    cfgMsg = '';
    const preVersion = cfg.ruleVersion; // for the defensive no-bump check
    try {
      const saved = await setAnalysisConfig({
        tradeWindowS: Number(cfg.tradeWindowS) || 0,
        ecoFullBuy: Number(cfg.ecoFullBuy) || 0,
        ecoForce: Number(cfg.ecoForce) || 0,
        tradeOppDistance: Number(cfg.tradeOppDistance) || 0,
      });
      if (saved) cfg = { ...cfg, ...saved };
      // The pristine snapshot follows the save: whatever the form says now
      // IS the stored rules (bumped or byte-identical), so Save goes back
      // to disabled until the next edit.
      snapCfg();
      if (saved && Number(saved.ruleVersion) === Number(preVersion)) {
        // Defensive (the pristine gate should already prevent this): the
        // server judged the values identical and did NOT bump — say "No
        // changes", never the recompute note that implies a new version.
        cfgMsg = S.settings.saveNoChanges;
      } else {
        // Save = recompute, exactly like a semantic metric save
        // (metricservice.go SaveMetric → scheduleSweep): a bump kicks the
        // affected matches off in the background — no manual re-run step.
        // RecomputeAll resolves AT SUBMISSION (services.js), so awaiting
        // it never waits on the compute itself.
        cfgMsg = S.settings.saveRecomputing;
        try {
          await recomputeAll();
        } catch (e) {
          // The rules ARE saved; only the batch kick failed — say so
          // instead of a confirmation for work that never started.
          cfgMsg = '';
          cfgError = errText(e);
        }
      }
    } catch (e) {
      cfgError = errText(e);
    }
  }

</script>

<div class="view">
  <header class="view-header">
    <h1>{S.settings.settingsHeading}</h1>
    <!-- The view's help affordance (HelpButton.svelte): one `?` at the
         header's right end (the .spacer the header did not have yet),
         opening the guide's settings section. -->
    <div class="spacer"></div>
    <HelpButton section="settings" {openDocs} />
  </header>

  {#if error}
    <p class="error" role="alert">
      {error}
      <button class="btn small" aria-label={S.settings.dismissAria} onclick={() => (error = '')}
        ><span class="codicon codicon-close"></span></button
      >
    </p>
  {/if}

  <section class="panel">
    <h2>About</h2>
    <p>
      {S.settings.spectraName} <span class="muted">v{version}</span> {S.settings.aboutTagline}
    </p>
    <div class="row-between">
      <span class="muted"
        >{S.settings.updateCheckHint}</span
      >
      <button class="btn" disabled={updateBusy} onclick={checkForUpdates}>
        <span class="codicon codicon-sync" aria-hidden="true"></span>
        {updateBusy ? S.settings.checking : S.settings.checkForUpdates}
      </button>
    </div>
  </section>

  <section class="panel">
    <h2>Data</h2>
    {#if info}
      <dl class="facts">
        <div class="fact-wide">
          <dt>{S.settings.factDatabase}</dt>
          <dd class="mono">{info.dbPath}</dd>
        </div>
        <div class="fact-wide">
          <dt>{S.settings.factMatchesDir}</dt>
          <dd class="mono">{info.matchesDir}</dd>
        </div>
        <div class="fact-wide">
          <dt>{S.settings.factDemoCopies}</dt>
          <dd class="mono">
            {info.demosDir}
            <span class="muted">
              — {info.demoCount === 0
                ? 'none'
                : `${info.demoCount} files · ${fmtBytes(info.demoBytes)}`}
            </span>
          </dd>
        </div>
        <div>
          <dt>{S.settings.factParserVersion}</dt>
          <dd class="mono">{info.parserVersion}</dd>
        </div>
      </dl>
      <div class="row-between">
        <span class="muted"
          >{S.settings.demoCopyHint}</span
        >
        <button
          class="btn danger"
          disabled={dataBusy || jobsPending || info.demoCount === 0}
          title={jobsPending
            ? S.settings.freeCopiesBusyTitle
            : info.demoCount === 0
              ? S.settings.freeCopiesEmptyTitle
              : S.settings.freeCopiesTitle}
          onclick={onFreeAllCopies}
        >
          <span class="codicon codicon-trash" aria-hidden="true"></span>
          {dataBusy ? S.settings.freeing : S.settings.freeAllCopies}
        </button>
      </div>
      {#if dataMsg}
        <p class="muted" role="status">{dataMsg}</p>
      {/if}
      {#if dataError}
        <p class="error" role="alert">{dataError}</p>
      {/if}
    {:else if !error}
      <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
    {/if}
  </section>

  <section class="panel">
    <h2>Import dirs</h2>
    <p class="muted">
      {S.settings.libraryListsLead} <span class="mono">{S.settings.extDem}</span> /
      <span class="mono">{S.settings.extDemZst}</span> {S.settings.importDirsNote}
    </p>
    {#if demoDirs.length === 0}
      {#if !demoDirError}
        <!-- Gated on the panel's error: a failed read means the dirs are
             UNKNOWN, never "none" — the alert below carries the failure. -->
        <p class="muted" role="status">
          {S.settings.noImportDirs}
        </p>
      {/if}
    {:else}
      <div class="sett-dirs">
        {#each demoDirs as dir (dir)}
          <div class="sett-dir-row">
            <span class="mono sett-dir-path" title={dir}>{dir}</span>
            <button
              class="btn small danger"
              aria-label={`Remove ${dir}`}
              title={S.settings.remove}
              onclick={() => removeDemoDir(dir)}
              ><span class="codicon codicon-trash" aria-hidden="true"></span></button
            >
          </div>
        {/each}
      </div>
    {/if}
    {#if demoDirError}
      <p class="error" role="alert">
        {demoDirError}
        <button class="btn small" onclick={refreshDemoDirs}>{S.settings.retry}</button>
      </p>
    {/if}
    <div class="row-between">
      <span class="muted">
        {demoDirsCustom
          ? S.settings.defaultsCustom
          : S.settings.defaultsEffect}
      </span>
      <div class="sett-seg">
        <button class="btn" onclick={addDemoDir}
          ><span class="codicon codicon-folder" aria-hidden="true"></span>
          {S.settings.addFolder}</button
        >
        <button class="btn" disabled={!demoDirsCustom} onclick={onResetDemoDirs}
          ><span class="codicon codicon-discard" aria-hidden="true"></span>
          {S.settings.resetDefaults}</button
        >
      </div>
    </div>
    <div class="row-between">
      <label class="filt-check" for="sett-copy-on-import">
        <input
          id="sett-copy-on-import"
          type="checkbox"
          checked={copyOnImport}
          onchange={(e) => setCopyOnImport(e.target.checked)}
        />
        <span>{S.settings.copyOnImportLabel}</span>
      </label>
      <span class="muted"
        >{S.settings.copyOnImportHint}</span>
    </div>
  </section>

  <!-- Background work: the ONE machine-level concurrency knob, in its
       own card (it governs every heavy background task, not just
       imports). Each setting is one .row-between row, so a second knob
       can drop in beside this one later without restructuring. -->
  <section class="panel">
    <h2>Background work</h2>
    <p class="muted">
      {S.settings.backgroundWorkNote}
    </p>
    <div class="row-between">
      <div class="sett-field">
        <label class="field-label" for="sett-parallel-work">{S.settings.parallelWorkLabel}</label>
        <input
          class="input"
          id="sett-parallel-work"
          type="number"
          min="1"
          max={parallelMax}
          value={parallelWork}
          onchange={onParallelWorkChange}
        />
      </div>
      <span class="muted"
        >{S.fill(S.settings.parallelWorkHint, { max: parallelMax })}</span
      >
    </div>
    {#if parallelError}
      <p class="error" role="alert">
        {parallelError}
        <button class="btn small" onclick={refreshParallelWork}>{S.settings.retry}</button>
      </p>
    {/if}
  </section>

  <section class="panel">
    <h2>CS2 assets</h2>
    <p class="muted">
      {S.settings.cs2AssetsNote}
    </p>
    {#if mpStatus}
      <dl class="facts">
        <div class="fact-wide">
          <dt>{S.settings.factCs2Install}</dt>
          <dd class="mono">
            {mpStatus.found ? mpStatus.path : S.settings.notFound}
            {#if mpStatus.manual}<span class="chip">{S.settings.manualChip}</span>{/if}
          </dd>
        </div>
        <div>
          <dt>{S.settings.factRadarPacks}</dt>
          <dd class="mono">
            {mpStatus.maps && mpStatus.maps.length ? mpStatus.maps.length : 'none'}
          </dd>
        </div>
        <div>
          <dt>{S.settings.factEquipmentIcons}</dt>
          <dd class="mono">
            {#if !iconManifest}
              …
            {:else if iconManifest.count > 0}
              {iconManifest.count}
            {:else}
              {S.settings.noneExtractedYet}{#if iconNote} — {iconNote}{/if}
            {/if}
          </dd>
        </div>
        <div>
          <dt>{S.settings.factReplaySounds}</dt>
          <dd class="mono">
            {#if !soundManifest}
              …
            {:else if soundManifest.count > 0}
              {soundManifest.count}{soundNote ? ` — ${soundNote}` : ''}
            {:else}
              {S.settings.noneExtractedYet}{#if soundNote} — {soundNote}{/if}
            {/if}
          </dd>
        </div>
      </dl>
    {:else}
      <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
    {/if}
    {#if mpMsg}<p class="sett-msg" role="status">{mpMsg}</p>{/if}
    {#if mpError}<p class="error" role="alert">{mpError}</p>{/if}
    <!-- Live extraction progress: the app's ONE progress widget
         (StatusChip) in BLOCK mode — the centered ring/spinner with its
         details text underneath, the presentation every progress display
         outside a table cell uses (PRODUCT.md "### Defaults"). Every
         family drives it with real numbers from spectra:asset-progress
         (gated to the running step's own family); between steps the
         indicator stays the indeterminate spinner. -->
    {#if mpBusy && mpStep}
      <p class="muted" role="status">
        <StatusChip block progress={mpPct} detail={mpDetail} />
      </p>
    {/if}
    <div class="row-between">
      <span class="muted"
        >{S.settings.extractHint}</span>
      <div class="sett-seg">
        <button class="btn" disabled={mpBusy} onclick={mpChooseFolder}>
          <span class="codicon codicon-folder" aria-hidden="true"></span>
          {S.settings.chooseFolder}
        </button>
        <button class="btn primary" disabled={mpBusy || !mpStatus?.found} onclick={doExtract}>
          <span class="codicon codicon-download" aria-hidden="true"></span>
          {mpBusy ? 'Extracting…' : 'Extract all CS2 assets'}
        </button>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Appearance</h2>
    <div class="row-between">
      <span class="muted"
        >{S.settings.themeHint}</span>
      <div class="sett-seg" role="group" aria-label={S.settings.themeAria}>
        <button
          class="btn"
          class:primary={theme === 'dark'}
          aria-pressed={theme === 'dark'}
          onclick={() => setTheme('dark')}>{S.settings.themeDark}</button
        >
        <button
          class="btn"
          class:primary={theme === 'light'}
          aria-pressed={theme === 'light'}
          onclick={() => setTheme('light')}>{S.settings.themeLight}</button
        >
      </div>
    </div>
    <div class="row-between">
      <span class="muted"
        >{S.settings.fontSizeHint}</span>
      <div class="sett-seg" role="group" aria-label={S.settings.fontSizeAria}>
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
    <h2>Plugins</h2>
    <p class="muted">
      {S.settings.pluginsNoteLead}
      <span class="mono">{S.settings.pluginManifestName}</span> {S.settings.pluginsNoteTail}
    </p>
    <!-- The source row is a READ-ONLY display + TWO native pickers (w20
         + addendum): no free typing, and no native dialog on our
         platforms can offer files AND folders at once — Browse… picks
         the bundle directory (the common case), the icon-only file
         button picks a single spectra-plugin.json, both fill the SAME
         path below (one display, one picked path), and Install hands it
         straight to PlatformService.InstallPlugin. -->
    <div class="row-between">
      <input
        class="input sett-plugin-path"
        readonly
        value={installPath}
        aria-label={S.settings.pluginPathAria}
      />
      <div class="sett-seg">
        <button class="btn" onclick={browsePlugin}>
          <span class="codicon codicon-search" aria-hidden="true"></span>
          {S.settings.browsePlugin}
        </button>
        <button
          class="btn"
          title={S.settings.choosePluginFileTitle}
          aria-label={S.settings.choosePluginFileLabel}
          onclick={browsePluginFile}
          ><span class="codicon codicon-file" aria-hidden="true"></span></button
        >
        <button class="btn primary" disabled={installBusy || !installPath.trim()} onclick={doInstall}
          >{installBusy ? S.settings.installing : S.settings.installFromPath}</button
        >
      </div>
    </div>
    {#if pluginsError}
      <p class="error" role="alert">
        {pluginsError}
        <button class="btn small" onclick={refreshPlugins}>{S.settings.retry}</button>
      </p>
    {/if}
    {#if pluginMsg}
      <p class="sett-msg" role="status">{pluginMsg}</p>
    {/if}
    {#if pluginsLoading}
      <p class="muted" role="status"><StatusChip block detail="Loading plugins…" /></p>
    {:else if plugins.length === 0}
      {#if !pluginsError}
        <!-- Gated on the list error: a failed read is UNKNOWN, not
             "none installed" — the alert above carries the failure. -->
        <p class="muted" role="status">{S.settings.noPluginsYet}</p>
      {/if}
    {:else}
      <div class="sett-plugins">
        {#each plugins as p (p.manifest.id)}
          {@const op = pluginOp[p.manifest.id]}
          <div class="plugin-row" class:plugin-disabled={!p.enabled}>
            <span class="plugin-name">
              <strong>{p.manifest.name || p.manifest.id}</strong>
              <span class="mono muted"> {p.manifest.id} · v{p.manifest.version}</span>
            </span>
            <span class="chip" title={S.settings.metricsContributedTitle}>{(p.manifest.metrics || []).length} {S.settings.metricsWord}</span>
            <span class="chip" title={S.settings.reportTplsContributedTitle}
              >{(p.manifest.reportTpls || []).length} {S.settings.templatesWord}</span
            >
            {#if p.error}
              <span class="error-text" title={p.error}>{S.settings.invalid}</span>
            {:else}
              <button
                class="btn small"
                class:warn={p.enabled}
                disabled={op === 'busy'}
                aria-pressed={p.enabled}
                onclick={() => togglePlugin(p)}
                title={p.enabled ? S.settings.disablePlugin : S.settings.enablePlugin}
                >{p.enabled ? S.settings.enabled : S.settings.disabled}</button
              >
            {/if}
            {#if op && op !== 'busy'}
              <span class="error-text" title={op}>{S.settings.failed}</span>
            {/if}
            <span class="spacer"></span>
            <button
              class="btn small danger"
              disabled={op === 'busy'}
              title={S.settings.removePluginTitle}
              aria-label={S.settings.removePluginLabel}
              onclick={() => doRemove(p)}
              ><span class="codicon codicon-trash" aria-hidden="true"></span></button
            >
            {#if p.error}
              <p class="plugin-err error-text">{p.error}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    <p class="muted">
      {S.settings.trustModelNote}
    </p>
  </section>

  <section class="panel">
    <h2>Audio &amp; voice</h2>
    <div class="row-between">
      <span class="muted"
        >{S.settings.audioSelfTestHint}</span>
      <button class="btn" onclick={runAudioSelfTest} disabled={audioRunning}>
        <span class="codicon codicon-check" aria-hidden="true"></span>
        {audioRunning ? 'Testing…' : 'Run audio self-test'}
      </button>
    </div>
    {#if audioProbe}
      {#if audioProbe.ok}
        <p class="sett-audio-ok" role="status">
          {S.settings.audioPass} {audioProbe.sampleRate} Hz.
        </p>
      {:else}
        <p class="error" role="alert">
          {S.settings.audioFail} {audioProbe.error}
        </p>
        {#if !audioProbe.error.includes('gst-plugins-good')}
          <p class="muted">
            {S.settings.audioHintLead} <span class="mono">{S.settings.gstPluginsGood}</span>
            {S.settings.audioHintTail}
          </p>
        {/if}
      {/if}
    {/if}
    <!-- The six replay-audio faders: same kvstore keys (and defaults)
         as the transport's Volume popover — moving one here moves the
         other, and both survive restarts. -->
    <div class="row-between">
      <span class="muted">{S.settings.volVoiceHint}</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volVoice * 100)}
        aria-label={S.settings.volVoiceAria}
        oninput={(e) => setVol('voice', e.currentTarget.value)}
      />
    </div>
    <div class="row-between">
      <span class="muted">{S.settings.volGunsHint}</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volGuns * 100)}
        aria-label={S.settings.volGunsAria}
        oninput={(e) => setVol('guns', e.currentTarget.value)}
      />
    </div>
    <div class="row-between">
      <span class="muted">{S.settings.volUtilityHint}</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volUtil * 100)}
        aria-label={S.settings.volUtilityAria}
        oninput={(e) => setVol('utility', e.currentTarget.value)}
      />
    </div>
    <div class="row-between">
      <span class="muted">{S.settings.volC4Hint}</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volC4 * 100)}
        aria-label={S.settings.volC4Aria}
        oninput={(e) => setVol('c4', e.currentTarget.value)}
      />
    </div>
    <div class="row-between">
      <span class="muted"
        >{S.settings.volAnnouncerHint}</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volAnnouncer * 100)}
        aria-label={S.settings.volAnnouncerAria}
        oninput={(e) => setVol('announcer', e.currentTarget.value)}
      />
    </div>
    <div class="row-between">
      <span class="muted"
        >{S.settings.volFootstepsHint}</span>
      <input
        class="sett-vol"
        type="range"
        min="0"
        max="100"
        value={Math.round(volSteps * 100)}
        aria-label={S.settings.volFootstepsAria}
        oninput={(e) => setVol('footsteps', e.currentTarget.value)}
      />
    </div>
    <p class="muted">
      {S.settings.soundEffectsNote}
    </p>
    <p class="muted">
      {S.settings.voiceDecodeNote}
    </p>
  </section>

  <!-- Replay: the loop-length setting — ONE number behind the transport
       loop popover's quick-range button and every event-level ▶ link in
       the analysis views (the `loop_secs` pref; nav.prefLoopSecs owns the
       bounds and the default, so this control can never disagree with the
       surfaces it drives). -->
  <section class="panel">
    <h2>Replay</h2>
    <div class="row-between">
      <div class="sett-field">
        <label class="field-label" for="sett-loop-secs">{S.settings.loopSecsLabel}</label>
        <input
          class="input"
          id="sett-loop-secs"
          type="number"
          min="1"
          max="60"
          value={loopSecs}
          onchange={onLoopSecsChange}
        />
      </div>
      <span class="muted">{S.settings.loopSecsHint}</span>
    </div>
  </section>

  <section class="panel">
    <h2>Analysis rules</h2>
    {#if cfgError}
      <p class="error" role="alert">{cfgError}</p>
    {/if}
    {#if cfgLoading && !cfgError}
      <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
    {/if}
    <div class="sett-rules">
      <div class="sett-field">
        <label class="field-label" for="sett-trade">{S.settings.tradeWindowLabel}</label>
        <input
          class="input"
          id="sett-trade"
          type="number"
          min="1"
          max="30"
          step="0.5"
          bind:value={cfg.tradeWindowS}
        />
        <span class="muted sett-hint">{S.settings.tradeWindowHint}</span>
      </div>
      <div class="sett-field">
        <label class="field-label" for="sett-full">{S.settings.fullBuyLabel}</label>
        <input
          class="input"
          id="sett-full"
          type="number"
          min="0"
          step="100"
          bind:value={cfg.ecoFullBuy}
        />
        <span class="muted sett-hint">{S.settings.fullBuyHint}</span>
      </div>
      <div class="sett-field">
        <label
          class="field-label"
          for="sett-trade-dist"
          title={S.settings.tradeOppTitle}>{S.settings.tradeOppLabel}</label>
        <input
          class="input"
          id="sett-trade-dist"
          type="number"
          min="0"
          step="10"
          bind:value={cfg.tradeOppDistance}
        />
        <span class="muted sett-hint"
          >{S.settings.tradeOppHint}</span>
      </div>
      <div class="sett-field">
        <label class="field-label" for="sett-force">{S.settings.forceLabel}</label>
        <input
          class="input"
          id="sett-force"
          type="number"
          min="0"
          step="100"
          bind:value={cfg.ecoForce}
        />
        <span class="muted sett-hint">{S.settings.forceHint}</span>
      </div>
    </div>
    <!-- Save is honest about dirtiness: pristine (loaded/saved values)
         → disabled, its status slot reading "No changes", never a
         nudge. A save that bumped the rules kicks the background
         recompute (saveCfg). The status and the button share ONE
         .row-between so the button sizes to its label and parks right
         in every state: the post-save message, the pristine "No
         changes", or an empty left slot while the form is dirty. -->
    <div class="row-between">
      {#if cfgMsg}
        <p class="sett-msg" role="status">{cfgMsg}</p>
      {:else if !cfgLoading && !cfgError && !cfgDirty}
        <p class="muted" role="status">{S.settings.noChanges}</p>
      {:else}
        <span></span>
      {/if}
      <button class="btn primary" disabled={cfgLoading || !cfgDirty} onclick={saveCfg}>
        <span class="codicon codicon-save" aria-hidden="true"></span>
        {S.settings.saveRules}
      </button>
    </div>
  </section>

  <ConfirmDialog bind:this={confirmDlg} />
</div>
