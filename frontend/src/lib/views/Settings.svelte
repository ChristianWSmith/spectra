<script>
  import { onMount } from 'svelte';
  import { getVersion, getDataInfo } from '../services.js';

  let version = $state('…');
  let info = $state(null);
  let error = $state('');

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
  });
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
</div>
