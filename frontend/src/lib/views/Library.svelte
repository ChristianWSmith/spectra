<script>
  import {
    importDialog,
    importPaths,
    listMatches,
    listJobs,
    deleteMatch,
    reprocess,
    cancelJob,
    getScoreboard,
    subscribeJobProgress,
    onJobDone,
    onLibraryChanged,
    onFilesDropped,
  } from '../services.js';
  import { fmtBytes, fmtDuration, fmtDate, basename } from '../fmt.js';
  import { teamNames } from '../teams.js';
  import StatusChip from '../components/StatusChip.svelte';

  let { nav = () => {} } = $props();

  // Sortable column headers replace the old "Sort by" dropdown + direction
  // button: clicking a header sorts the list by that column (the store
  // whitelists the keys — see matchListSort), a second click on the active
  // header flips the direction. The first click applies the column's
  // natural default — newest/largest first for dates and sizes, A→Z for
  // names. Matchup is synthesized client-side and Actions is not data, so
  // those headers stay plain.
  const SORT_DEFAULT_DESC = {
    extracted_at: true,
    map: false,
    size: true,
    score: true,
    duration: true,
    rounds: true,
    status: false,
  };

  const STAGE_LABELS = {
    queued: 'queued',
    decompress: 'decompressing',
    parse: 'parsing',
    store: 'storing',
    analyze: 'analyzing',
    done: 'done',
  };

  // Recent import problems age out client-side (no server-side job delete).
  const PROBLEM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const PROBLEM_MAX = 10;

  let matches = $state([]);
  let jobs = $state([]);
  let jobProgress = $state(new Map()); // jobId -> latest progress payload
  let query = $state('');
  let sortKey = $state('extracted_at');
  let desc = $state(true);
  let error = $state('');
  let importError = $state('');

  // Debounced list fetch: re-arms on every query/sort change and fires
  // 250 ms later, so typing doesn't hammer the store. First run is
  // immediate so the library loads without the debounce delay.
  let firstList = true;
  $effect(() => {
    const q = query;
    const sk = sortKey;
    const d = desc;
    if (firstList) {
      firstList = false;
      refreshList(q, sk, d);
      return;
    }
    const timer = setTimeout(() => refreshList(q, sk, d), 250);
    return () => clearTimeout(timer);
  });

  async function refreshList(q = query, sk = sortKey, d = desc) {
    try {
      matches = await listMatches(q, sk, d);
      error = '';
    } catch (e) {
      error = errText(e);
    }
  }

  function toggleSort(key) {
    if (sortKey === key) desc = !desc;
    else {
      sortKey = key;
      desc = !!SORT_DEFAULT_DESC[key];
    }
  }

  async function refreshJobs() {
    try {
      jobs = await listJobs();
    } catch (e) {
      error = errText(e);
    }
  }

  // Mount: jobs + event subscriptions. The initial list load comes from
  // the debounced effect above (fires once on mount).
  $effect(() => {
    refreshJobs();
    const offs = [
      subscribeJobProgress((snap) => (jobProgress = snap)),
      onJobDone(() => {
        refreshJobs();
        refreshList();
      }),
      onLibraryChanged(() => {
        refreshJobs();
        refreshList();
      }),
      // Drop only reaches JS when the pointer is over an element with
      // data-file-drop-target (the drop zone below).
      onFilesDropped((data) => {
        const files = data && data.files;
        if (files && files.length) doImportPaths(files);
      }),
    ];
    return () => offs.forEach((off) => off());
  });

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  const activeJobs = $derived(
    jobs.filter((j) => j.status === 'queued' || j.status === 'running'),
  );

  const problemJobs = $derived(
    jobs
      .filter((j) => {
        if (j.status !== 'failed' && j.status !== 'cancelled') return false;
        const t = j.finishedAt ? new Date(j.finishedAt).getTime() : 0;
        return t > 0 && Date.now() - t < PROBLEM_MAX_AGE_MS;
      })
      .slice(0, PROBLEM_MAX),
  );

  function jobView(j) {
    const live = jobProgress.get(j.id);
    return live
      ? { ...j, stage: live.stage || j.stage, progress: live.progress ?? j.progress }
      : j;
  }

  // progressByMatch powers the "parsing" chip on match rows.
  const progressByMatch = $derived.by(() => {
    const m = new Map();
    for (const j of activeJobs) {
      if (j.matchId) m.set(j.matchId, jobView(j));
    }
    return m;
  });

  async function doImport() {
    importError = '';
    try {
      const sel = await importDialog();
      if (sel && sel.length) await doImportPaths(sel);
    } catch (e) {
      importError = errText(e);
    }
  }

  async function doImportPaths(paths) {
    importError = '';
    try {
      await importPaths(paths);
      await refreshJobs();
      await refreshList();
    } catch (e) {
      importError = errText(e);
    }
  }

  async function onCancel(job) {
    try {
      await cancelJob(job.id);
      await refreshJobs();
    } catch (e) {
      error = errText(e);
    }
  }

  async function onReprocess(id, ev) {
    ev.stopPropagation();
    try {
      await reprocess(id);
      await refreshJobs();
      await refreshList();
    } catch (e) {
      error = errText(e);
    }
  }

  async function onDelete(id, ev) {
    ev.stopPropagation();
    if (!confirm('Delete extracted data?')) return;
    const alsoFile = confirm('Also delete the demo file from disk?');
    try {
      await deleteMatch(id, alsoFile);
      await refreshJobs();
      await refreshList();
    } catch (e) {
      error = errText(e);
    }
  }

  // Team names for rows whose extract recorded no clan name: the list
  // carries no player rows, so fetch each such match's scoreboard once,
  // derive the per-side `team_<player>` names (shared with Match — see
  // lib/teams.js) and cache them per match id (the list refreshes on every
  // search/sort). Empty results (still parsing) and failures aren't cached,
  // so a later refresh picks up the extracted players or retries.
  let synthPlayers = $state(new Map()); // matchId → scoreboard rows

  $effect(() => {
    const missing = matches.filter(
      (m) => (!m.ctName || !m.tName) && !synthPlayers.has(m.id),
    );
    if (!missing.length) return;
    let live = true;
    Promise.all(
      missing.map((m) =>
        getScoreboard(m.id, '', false).catch(() => null),
      ),
    ).then((rows) => {
      if (!live) return;
      // Only publish when something new arrived — reassigning an unchanged
      // map would re-trigger this effect (and refetch) forever.
      let changed = false;
      const next = new Map(synthPlayers);
      missing.forEach((m, i) => {
        if (rows[i] && rows[i].length) {
          next.set(m.id, rows[i]);
          changed = true;
        }
      });
      if (changed) synthPlayers = next;
    });
    return () => (live = false);
  });

  function matchup(m) {
    // Both demo clan names known: no need for the scoreboard fallback.
    if (m.ctName && m.tName) return `${m.ctName} vs ${m.tName}`;
    const players = synthPlayers.get(m.id);
    if (!players) return '—'; // fallback still loading
    if (!players.length) return '—'; // no extracted players (parsing/failed row)
    // Sides switch at halftime — these are team names, resolved per side
    // (demo name → team_<player> → bare side as a last resort).
    const { ct, t } = teamNames({
      ctName: m.ctName || '',
      tName: m.tName || '',
      players,
    });
    return `${ct} vs ${t}`;
  }
</script>

<!-- The whole view is a file-drop target (data-file-drop-target): the
     native drop only reaches JS when the pointer is over it. -->
<div class="view" data-file-drop-target>
  <header class="view-header">
    <h1>Library</h1>
    <button class="btn primary" onclick={doImport}>Import…</button>
    <span class="muted">or drop .dem / .dem.zst files</span>
    <div class="spacer"></div>
    <input
      class="input"
      type="search"
      placeholder="Search map, path, team…"
      aria-label="Search matches"
      bind:value={query}
    />
  </header>

  <!-- Sortable header cell: label + active-direction arrow; the button is
       the whole header target (same styling as the scoreboard's). -->
  {#snippet sortTh(label, key, cls)}
    <th scope="col" class={cls}>
      <button
        class="th-sort"
        class:sorted={sortKey === key}
        aria-label="Sort by {label}"
        title="Sort by {label}"
        onclick={() => toggleSort(key)}
      >{label}{#if sortKey === key}{desc ? ' ↓' : ' ↑'}{/if}</button>
    </th>
  {/snippet}

  {#if importError}
    <p class="error" role="alert">{importError}</p>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if activeJobs.length > 0}
    <section class="panel" aria-label="Imports in progress">
      <h2>Imports in progress</h2>
      {#each activeJobs as job (job.id)}
        {@const j = jobView(job)}
        <div class="job-row">
          <span class="mono path" title={j.path}>{basename(j.path)}</span>
          <span class="chip">{STAGE_LABELS[j.stage] || j.stage || 'queued'}</span>
          <div
            class="progress"
            role="progressbar"
            aria-label="Import progress"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round((j.progress || 0) * 100)}
          >
            <div
              class="progress-fill"
              class:indeterminate={!j.progress}
              style="width:{Math.max(4, Math.round((j.progress || 0) * 100))}%"
            ></div>
          </div>
          <span class="num muted">{Math.round((j.progress || 0) * 100)}%</span>
          <button class="btn small danger" onclick={() => onCancel(j)}>Cancel</button>
        </div>
      {/each}
    </section>
  {/if}

  {#if problemJobs.length > 0}
    <section class="panel problems" aria-label="Recent import problems">
      <h2>Recent import problems</h2>
      {#each problemJobs as job (job.id)}
        <div class="problem-row">
          <span class="chip status {job.status}">{job.status}</span>
          <span class="mono path" title={job.path}>{basename(job.path)}</span>
          <span class="error-text">{job.error || 'no error message'}</span>
        </div>
      {/each}
    </section>
  {/if}

  <div class="dropzone">
    {#if matches.length === 0 && jobs.length === 0}
      <div class="empty">
        <p class="empty-title">No matches yet</p>
        <p class="muted">
          Import a CS2 demo with the button above, or drop <span class="mono"
            >.dem</span
          > / <span class="mono">.dem.zst</span> files anywhere in this panel.
        </p>
        <button class="btn primary" onclick={doImport}>Import…</button>
      </div>
    {:else}
      <table class="data-table">
        <thead>
          <tr>
            {@render sortTh('Map', 'map', '')}
            <th scope="col">Matchup</th>
            {@render sortTh('Score', 'score', 'num')}
            {@render sortTh('Rounds', 'rounds', 'num')}
            {@render sortTh('Duration', 'duration', 'num')}
            {@render sortTh('Size', 'size', 'num')}
            {@render sortTh('Extracted', 'extracted_at', '')}
            {@render sortTh('Status', 'status', '')}
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each matches as m (m.id)}
            <tr
              class="clickable"
              onclick={() => nav(`/match/${m.id}`)}
              onkeydown={(e) => e.key === 'Enter' && nav(`/match/${m.id}`)}
              tabindex="0"
            >
              <td>{m.map || '—'}</td>
              <td>{matchup(m)}</td>
              <td class="num"
                ><span class="ct">{m.scoreCT}</span>–<span class="t">{m.scoreT}</span
                ></td
              >
              <td class="num">{m.realRounds}</td>
              <td class="num">{fmtDuration(m.durationS)}</td>
              <td class="num">{fmtBytes(m.size)}</td>
              <td>{fmtDate(m.extractedAt)}</td>
              <td>
                {#if m.status === 'parsing' || m.status === 'queued'}
                  <StatusChip
                    status={m.status === 'parsing' ? 'parsing' : 'queued'}
                    progress={progressByMatch.get(m.id)?.progress ?? null}
                    title={m.error || ''}
                  />
                {:else if m.status === 'failed'}
                  <StatusChip status="failed" title={m.error || 'import failed'} />
                {:else}
                  <StatusChip status="ready" />
                {/if}
              </td>
              <td class="row-actions" onclick={(e) => e.stopPropagation()}>
                <button
                  class="btn small"
                  title="Re-parse the original demo"
                  onclick={(e) => onReprocess(m.id, e)}>Reprocess</button
                >
                <button
                  class="btn small danger"
                  title="Delete extracted data"
                  onclick={(e) => onDelete(m.id, e)}>Delete</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if matches.length === 0}
        <div class="empty">
          <p class="muted">
            {query
              ? `No matches match “${query}”.`
              : 'No matches yet — imports will appear here.'}
          </p>
        </div>
      {/if}
    {/if}
  </div>
</div>
