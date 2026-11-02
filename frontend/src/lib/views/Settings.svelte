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
    setMapPackPromptState,
    chooseCS2Dir,
    checkForUpdateNow,
  } from '../services.js';
  import { probeAudio } from '../replay/audio.js';
  import { fmtDate } from '../fmt.js';
  import { getTheme, applyTheme } from '../theme.js';

  let version = $state('…');
  let info = $state(null);
  let error = $state('');
  let updateBusy = $state(false);

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

  // Plugins: declarative bundles installed by
  // path; enable/disable/remove reflected on the next list — no restart.
  let plugins = $state([]);  let pluginsError = $state('');
  let pluginsLoading = $state(true);
  let installPath = $state('');
  let installBusy = $state(false);
  let pluginMsg = $state('');
  let pluginOp = $state({}); // plugin id → 'busy' | error text

  // Map packs: radar extraction from a local CS2 install (Valve IP stays
  // local — internal/mappack). Status loads on mount; extract re-runs
  // idempotently after game updates.
  let mpStatus = $state(null); // MapPackStatus
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

  async function doExtract() {
    mpBusy = true;
    mpMsg = '';
    mpError = '';
    try {
      const out = await extractMapPacks(mpStatus?.path || '');
      const n = (out.maps || []).length;
      const errs = out.errors || [];
      if (n > 0 && !errs.length) mpMsg = `Extracted ${n} map pack${n === 1 ? '' : 's'}.`;
      else if (n > 0) mpMsg = `Extracted ${n}, ${errs.length} failed: ${errs[0]}`;
      else mpError = errs[0] || 'nothing extracted';
      await refreshMapPacks();
    } catch (e) {
      mpError = errText(e);
    } finally {
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
    if (!confirm(`Remove plugin "${p.manifest.name || pid}" (${pid})? Its bundle is deleted from disk.`)) {
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
  let cfg = $state({ tradeWindowS: 5, ecoFullBuy: 20000, ecoForce: 10000, ruleVersion: 0 });
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

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  onMount(() => {
    getVersion()
      .then((v) => (version = v))
      .catch((e) => (error = errText(e)));
    getDataInfo()
      .then((d) => (info = d))
      .catch((e) => (error = errText(e)));
    refreshMapPacks();
    getAnalysisConfig()
      .then((c) => {
        cfg = c || cfg;
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
  });

  async function saveCfg() {
    cfgError = '';
    cfgMsg = '';
    try {
      const saved = await setAnalysisConfig({
        tradeWindowS: Number(cfg.tradeWindowS) || 0,
        ecoFullBuy: Number(cfg.ecoFullBuy) || 0,
        ecoForce: Number(cfg.ecoForce) || 0,
      });
      cfg = saved || cfg;
      cfgMsg =
        `Saved — rule_version ${cfg.ruleVersion}. Stored rows keep the version they ` +
        'were computed with; run a recompute below to apply the new rules.';
    } catch (e) {
      cfgError = errText(e);
    }
  }

  async function recompute(m) {
    if (
      !confirm(
        `Recompute analysis for ${m.map || 'match #' + m.id} (${fmtDate(m.extractedAt)}) ` +
          'under the current rules? Stored derived rows for this match are rebuilt.',
      )
    ) {
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

  // Hand-written metric definitions. Keep the wording aligned
  // with what internal/analytics computes — generic where the exact rule is
  // configurable; every rule set is versioned via analysis_config/rule_version.
  const DEFINITIONS = [
    {
      term: 'KAST%',
      inferred: false,
      text: 'Share of rounds where the player recorded a Kill, an Assist, was Traded after their death, or Survived the round. Stored per player-round (player_round_stats); the “traded” part follows the trade window from analysis_config / rule_version.',
    },
    {
      term: 'Trade window',
      inferred: false,
      text: 'Seconds after a death during which a teammate’s kill counts as a trade (default 5 s, configurable under Analysis rules). Trade rate, trade opportunities and untraded deaths all use this window. Changing it bumps rule_version.',
    },
    {
      term: 'Buy classes (full / force / eco / save / pistol / bonus)',
      inferred: false,
      text: 'Derived per side from the round-start equipment value against the configured thresholds (full buy ≥ ecoFullBuy, force ≥ ecoForce, below that = eco/save), plus pistol detection by round number and side-switch pattern, and bonus/save by spend behaviour. Each round stores its label, explanation and rule_version — hover a round chip for the exact rule text that produced it.',
    },
    {
      term: 'Loss bonus (reconstructed)',
      inferred: true,
      text: 'A team’s loss-bonus money is reconstructed from consecutive round losses rather than read from a raw net message, so it is labelled reconstructed/inferred (fact/inference badge). The base amounts follow the game rules, not a configurable threshold.',
    },
    {
      term: 'Trade opportunities missed (inferred)',
      inferred: true,
      text: 'Heuristic v1: a player died while a living teammate was near and alive within the trade window but did not kill the attacker in time. It is an inference from positions/timing, not a demo fact — treat counts as indicative.',
    },
    {
      term: 'Damage conversion',
      inferred: false,
      text: 'Share of a player’s dealt damage that contributed to a kill by that player (damage preceding a kill in the same engagement), derived from stored events rather than reported by the game.',
    },
    {
      term: 'ADR',
      inferred: false,
      text: 'Average damage per round = total damage ÷ rounds played, from the player aggregates (player_stats). Friendly-fire damage is reported separately in the Combat tab.',
    },
    {
      term: 'Consistency σ',
      inferred: false,
      text: 'Standard deviation of per-match ADR across a player’s match history, shown as “ADR ± σ” on profiles: a spread, not an error bar. Lower σ = steadier performance (PRD §5.13).',
    },
  ];
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
    <p class="muted">
      Product requirements live in <span class="mono">ref/PRD.md</span> in the
      repository.
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
      <p class="muted">Loading…</p>
    {/if}
  </section>

  <section class="panel">
    <h2>Map packs</h2>
    <p class="muted">
      Radar images and map transforms are extracted from your local
      Counter-Strike 2 installation on this machine — nothing is uploaded,
      and no Valve assets ship with the app.
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
      </dl>
    {:else}
      <p class="muted">Loading…</p>
    {/if}
    {#if mpMsg}<p class="sett-msg" role="status">{mpMsg}</p>{/if}
    {#if mpError}<p class="error" role="alert">{mpError}</p>{/if}
    <div class="row-between">
      <span class="muted"
        >Extract all official-map radars (idempotent — re-run after a CS2
        update to refresh).</span
      >
      <div class="sett-seg">
        <button class="btn" disabled={mpBusy} onclick={mpChooseFolder}>
          Choose folder…
        </button>
        <button class="btn primary" disabled={mpBusy || !mpStatus?.found} onclick={doExtract}>
          {mpBusy ? 'Extracting…' : 'Extract radar images'}
        </button>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Appearance</h2>
    <div class="row-between">
      <span class="muted"
        >Theme — dark ships as the default; light tokens are new in M5 (plan
        §2.6). The choice is remembered and applied at startup.</span
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
      <p class="muted">Loading plugins…</p>
    {:else if plugins.length === 0}
      <p class="muted">No plugins installed yet.</p>
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
    <p class="muted">
      Voice decode: on-demand Opus decode (pure-Go pion/opus) — no cache
      directory in v1. PCM is served over HTTP per playback window at 16 kHz
      mono and mixed live with the replay clock.
    </p>
    <p class="muted">
      Transcription (local whisper) is <strong>explicitly deferred from
      v1</strong> — no whisper UI in this release; the
      storage and export contracts stay reserved for a later milestone.
    </p>
  </section>

  <section class="panel">
    <h2>Analysis rules</h2>
    {#if cfgError}
      <p class="error" role="alert">{cfgError}</p>
    {/if}
    {#if cfgLoading && !cfgError}
      <p class="muted">Loading…</p>
    {/if}
    <div class="sett-rules">
      <div class="sett-field">
        <label for="sett-trade">Trade window (seconds)</label>
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
        <label for="sett-full">Full-buy threshold (equip $)</label>
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
        <label for="sett-force">Force threshold (equip $)</label>
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

    <h3 class="sett-sub">Recompute analysis…</h3>
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
              <span class="chip status ready">done</span>
            {:else if state}
              <span class="error-text" title={state}>failed</span>
              <button class="btn small" onclick={() => recompute(m)}>Retry</button>
            {:else}
              <button class="btn small" onclick={() => recompute(m)}>Recompute</button>
            {/if}
          </span>
        </div>
      {:else}
        <p class="muted">
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
      {#each DEFINITIONS as d (d.term)}
        <details>
          <summary>
            {d.term}
            {#if d.inferred}
              <span
                class="chip sett-inferred"
                title="Heuristic/reconstructed — not a raw demo fact"
              >inferred</span>
            {/if}
          </summary>
          <p>{d.text}</p>
        </details>
      {/each}
    </div>
  </section>
</div>
