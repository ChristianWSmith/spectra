<script>
  import {
    importDialog,
    importPaths,
    listMatches,
    listJobs,
    deleteMatch,
    reprocess,
    getScoreboard,
    subscribeJobProgress,
    onJobDone,
    onLibraryChanged,
    onFilesDropped,
    listDemoFiles,
    deleteDemoFile,
    invalidate,
    errText,
  } from '../services.js';
  import { fmtBytes, fmtDuration, fmtDate, basename } from '../fmt.js';
  import { teamNames } from '../teams.js';
  import StatusChip from '../components/StatusChip.svelte';
  import SortTh from '../components/SortTh.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';

  // query is the route query: #/library?map=<MapName>&player=<steamid>
  // presets the structured filters below (the profile → library deep
  // link — App passes route.query through).
  let { nav = () => {}, query: routeQuery = {} } = $props();

  // Sortable column headers: clicking a header sorts the list by that
  // column (the store whitelists the keys — see matchListSort), a second
  // click on the active header flips the direction. The first click
  // applies the column's natural default — newest/largest first for dates
  // and sizes, A→Z for names. Matchup is synthesized client-side and
  // Actions is not data, so those headers stay plain.
  const SORT_DEFAULT_DESC = {
    extracted_at: true,
    map: false,
    size: true,
    score: true,
    duration: true,
    rounds: true,
    status: false,
  };

  // Recent import problems age out client-side (no server-side job delete).
  const PROBLEM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const PROBLEM_MAX = 10;

  let matches = $state([]);
  let jobs = $state([]);
  let jobProgress = $state(new Map()); // jobId -> latest progress payload
  let query = $state('');
  // Structured list facets (ANDed with each other and with `query` —
  // store.MatchListFilter, forwarded by services.js listMatches): a map
  // substring and "has player X" (exact 17-digit SteamID or name
  // substring — one input covers both). Seeded from the route query so a
  // deep link (#/library?map=&player=) lands pre-filtered; the preset
  // effect below re-applies them if the route query changes while this
  // view stays mounted.
  let mapFilter = $state(String(routeQuery.map || ''));
  let playerFilter = $state(String(routeQuery.player || ''));
  let sortKey = $state('extracted_at');
  let desc = $state(true);
  let error = $state('');
  let importError = $state('');

  // Demos sitting in the configured import dirs (Settings → "Import
  // dirs") that are not in the library yet — each with a one-click
  // Import that runs through the same pipeline as drag-and-drop, plus a
  // confirmed delete-from-disk for the file itself.
  let demoFiles = $state([]);
  let demoScanning = $state(false); // UI: refresh button + "Scanning…"
  // Non-reactive in-flight guard: refreshDemoFiles runs inside the mount
  // $effect, and reading $state there would make the effect depend on it
  // (every scan start/end would re-run the effect → rescan forever).
  // demoScanAgain queues one follow-up scan when an event lands mid-scan.
  let demoScanInFlight = false;
  let demoScanAgain = false;
  let demoError = $state('');
  let notice = $state('');
  // The one confirmation modal (ConfirmDialog.svelte) — see onDelete /
  // onDeleteFile for the two prompts this view opens.
  let confirmDlg = $state(null);

  // Route-query presets (#/library?map=&player=): (re)apply the deep-link
  // facets when the query changes while this view stays mounted (a fresh
  // mount is already seeded by the $state initializers above). Depends on
  // the STRING values only — App hands over a fresh {query} object for
  // every query-less hash, and that identity churn must not clobber
  // filters the user typed. Writing an unchanged value is a no-op
  // (primitive equality), so the mount-time run disturbs nothing.
  $effect(() => {
    mapFilter = String(routeQuery.map || '');
    playerFilter = String(routeQuery.player || '');
  });

  // Debounced list fetch: re-arms on every query/sort/filter change and
  // fires 250 ms later, so typing doesn't hammer the store. First run is
  // immediate so the library loads without the debounce delay (the filter
  // state is seeded from the route query at init, so that first fetch
  // already carries any deep-link preset).
  let firstList = true;
  $effect(() => {
    const q = query;
    const sk = sortKey;
    const d = desc;
    const mf = mapFilter;
    const pf = playerFilter;
    if (firstList) {
      firstList = false;
      refreshList(q, sk, d, mf, pf);
      return;
    }
    const timer = setTimeout(() => refreshList(q, sk, d, mf, pf), 250);
    return () => clearTimeout(timer);
  });

  async function refreshList(q = query, sk = sortKey, d = desc, mf = mapFilter, pf = playerFilter) {
    try {
      matches = await listMatches(q, sk, d, { map: mf, player: pf });
      error = '';
    } catch (e) {
      error = errText(e);
    }
  }

  // Both facets off (also the Clear-filters button's reset).
  function clearFilters() {
    mapFilter = '';
    playerFilter = '';
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

  // Mount: jobs + import-dir scan + event subscriptions. The initial
  // list load comes from the debounced effect above (fires once on mount).
  $effect(() => {
    refreshJobs();
    refreshDemoFiles();
    const offs = [
      subscribeJobProgress((snap) => (jobProgress = snap)),
      onJobDone(() => {
        refreshJobs();
        refreshList();
        refreshDemoFiles();
      }),
      onLibraryChanged(() => {
        refreshJobs();
        refreshList();
        refreshDemoFiles();
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

  // Any narrowing beyond "the whole library": the free-text query or a
  // structured facet. Drives the empty state — a filtered-out library
  // must offer the "no match" message, never "No matches yet" — and its
  // text (see filterSummary).
  const searching = $derived(
    !!(query.trim() || mapFilter.trim() || playerFilter.trim()),
  );

  const filterSummary = $derived.by(() => {
    const parts = [];
    if (query.trim()) parts.push(`“${query.trim()}”`);
    if (mapFilter.trim()) parts.push(`map “${mapFilter.trim()}”`);
    if (playerFilter.trim()) parts.push(`player “${playerFilter.trim()}”`);
    return parts.join(' + ');
  });

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
      await refreshDemoFiles();
    } catch (e) {
      importError = errText(e);
    }
  }

  // Rescan the configured import dirs (Settings → "Import dirs"). The
  // backend hashes only files it has never seen (bounded per scan) and
  // caches every hash by path+size+mtime, so repeat scans are stat-only;
  // force drops the frontend read cache first (the Refresh button — a
  // demo downloaded while the app was open is not announced by any
  // event).
  async function refreshDemoFiles(force = false) {
    if (force) invalidate();
    if (demoScanInFlight) {
      // A scan is already running: don't pile up (the walk + stats are
      // cheap, but a rescan mid-scan would only return the same rows) —
      // remember the request and run it once the current scan lands, so
      // a library event that arrived mid-scan is never lost.
      demoScanAgain = true;
      return;
    }
    demoScanInFlight = true;
    demoScanning = true;
    try {
      demoFiles = await listDemoFiles();
      demoError = '';
    } catch (e) {
      demoError = errText(e);
    } finally {
      demoScanInFlight = false;
      demoScanning = false;
      if (demoScanAgain) {
        demoScanAgain = false;
        refreshDemoFiles();
      }
    }
  }

  // Import one demo straight from the import-dir list: the same
  // pipeline as the Import… dialog and drag-and-drop (hash dedupe decides
  // duplicates, the row indicator shows progress).
  async function doImportFile(f, ev) {
    ev.stopPropagation();
    await doImportPaths([f.path]);
  }

  // Delete an import-dir demo from disk — always behind a confirmation,
  // and the backend re-checks the path (a demo file under a configured
  // import dir, never the data dir, never a library match's stored path)
  // before removing anything.
  async function onDeleteFile(f, ev) {
    ev.stopPropagation();
    notice = '';
    const ok = await confirmDlg?.ask({
      title: 'Delete from disk?',
      message: `Permanently deletes ${basename(f.path)} from ${f.root}. This cannot be undone.`,
      confirmLabel: 'Delete from disk',
    });
    if (!ok) return;
    try {
      await deleteDemoFile(f.path);
      await refreshDemoFiles();
      notice = `Deleted ${basename(f.path)} from disk.`;
    } catch (e) {
      demoError = errText(e);
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
    notice = '';
    if (
      !(await confirmDlg?.ask({
        title: 'Delete extracted data?',
        message:
          'Removes this match’s extracted data (rounds, events, sidecars) from Spectra. ' +
          'The demo file itself is not touched.',
        confirmLabel: 'Delete',
      }))
    ) {
      return;
    }
    // Only Spectra's OWN copy of the demo file is ever removed — the
    // backend reports removedDemo=false when there is no managed copy
    // (a row imported before copy-on-import points at the user's
    // original file, which stays untouched).
    const alsoFile = !!(await confirmDlg?.ask({
      title: 'Also delete the demo file?',
      message:
        'Deletes Spectra’s own imported copy of the demo from disk. ' +
        'Your original file is never touched.',
      confirmLabel: 'Delete demo file',
    }));
    try {
      const removedDemo = await deleteMatch(id, alsoFile);
      if (alsoFile && !removedDemo) {
        notice = 'The demo file was kept — Spectra only deletes the copy it imported.';
      }
      await refreshJobs();
      await refreshList();
      await refreshDemoFiles();
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

  <!-- Structured search facets — ANDed with each other and with the
       free-text box above (store.MatchListFilter). A filled input is an
       ACTIVE filter (accent border); each input's native × clears it,
       the button clears both. Values also arrive pre-set from the route
       query (#/library?map=&player= — the profile → library deep link). -->
  <div class="lib-filters" role="group" aria-label="Library filters">
    <span class="lib-filter-field">
      <label class="field-label" for="lib-filter-map">Map</label>
      <input
        id="lib-filter-map"
        class="input lib-filter"
        class:active={!!mapFilter.trim()}
        type="search"
        placeholder="e.g. de_mirage"
        aria-label="Filter by map"
        bind:value={mapFilter}
      />
    </span>
    <span class="lib-filter-field">
      <label class="field-label" for="lib-filter-player">Player</label>
      <input
        id="lib-filter-player"
        class="input lib-filter"
        class:active={!!playerFilter.trim()}
        type="search"
        placeholder="Player name or SteamID"
        aria-label="Filter by player"
        bind:value={playerFilter}
      />
    </span>
    {#if mapFilter || playerFilter}
      <button
        class="btn small ghost"
        title="Clear the map and player filters"
        onclick={clearFilters}>Clear filters</button
      >
    {/if}
  </div>

  <!-- Sortable header cells (SortTh): label + active-direction arrow; the
       button is the whole header target (same styling as the scoreboard's). -->

  {#if importError}
    <p class="error" role="alert">{importError}</p>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  {#if notice}
    <p class="muted" role="status">{notice}</p>
  {/if}

  {#if problemJobs.length > 0}
    <section class="panel problems" aria-label="Recent import problems">
      <h2>Recent import problems</h2>
      {#each problemJobs as job (job.id)}
        <div class="problem-row">
          <StatusChip status={job.status} />
          <span class="mono path" title={job.path}>{basename(job.path)}</span>
          <span class="error-text">{job.error || 'no error message'}</span>
        </div>
      {/each}
    </section>
  {/if}

  <div class="dropzone">
    {#if matches.length === 0 && jobs.length === 0 && !searching}
      <div class="empty">
        <p class="empty-title" role="status">No matches yet</p>
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
            <SortTh label="Map" active={sortKey === 'map'} {desc} onclick={() => toggleSort('map')} />
            <th scope="col">Matchup</th>
            <SortTh label="Score" cls="num" active={sortKey === 'score'} {desc} onclick={() => toggleSort('score')} />
            <SortTh label="Rounds" cls="num" active={sortKey === 'rounds'} {desc} onclick={() => toggleSort('rounds')} />
            <SortTh label="Duration" cls="num" active={sortKey === 'duration'} {desc} onclick={() => toggleSort('duration')} />
            <SortTh label="Size" cls="num" active={sortKey === 'size'} {desc} onclick={() => toggleSort('size')} />
            <SortTh label="Extracted" active={sortKey === 'extracted_at'} {desc} onclick={() => toggleSort('extracted_at')} />
            <SortTh label="Status" active={sortKey === 'status'} {desc} onclick={() => toggleSort('status')} />
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
                  title="Re-parse the demo — from Spectra's copy when one exists"
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
          <p class="muted" role="status">
            {searching
              ? `No matches match ${filterSummary}.`
              : 'No matches yet — imports will appear here.'}
          </p>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Import dirs: .dem / .dem.zst files under the dirs configured in
       Settings → "Import dirs" that are not in the library yet — the
       backend omits recognised imports, so deleting a match brings its
       demo back here. One Import button per row runs the ordinary
       pipeline (hash dedupe, row status chip); Delete from disk removes
       the file itself, behind a confirmation. -->
  <section class="panel" aria-label="Demos from your import dirs">
    <div class="row-between">
      <h2>Demos from your import dirs</h2>
      <button
        class="btn small"
        disabled={demoScanning}
        title="Rescan the configured import dirs"
        onclick={() => refreshDemoFiles(true)}>Refresh</button
      >
    </div>
    <p class="muted">
      Found under your import dirs (Settings → Import dirs) — subfolders up to
      four levels deep, hidden folders skipped. Importing copies the demo into
      Spectra’s data folder; your original file is never touched.
    </p>
    {#if demoError}
      <p class="error" role="alert">{demoError}</p>
    {/if}
    {#if demoScanning && demoFiles.length === 0}
      <p class="muted" role="status">Scanning folders…</p>
    {:else if demoFiles.length === 0}
      <p class="muted" role="status">
        No demos found — add import dirs in Settings, or use Import… / drop files on this
        panel.
      </p>
    {:else}
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col">Demo</th>
            <th scope="col">Folder</th>
            <th scope="col" class="num">Size</th>
            <th scope="col">Modified</th>
            <th scope="col">Library</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each demoFiles as f (f.path)}
            <tr>
              <td>
                <span class="mono lib-demo-name" title={f.path}>{basename(f.path)}</span>
              </td>
              <td>
                <span class="mono lib-demo-root" title={f.root}
                  >{basename(f.root) || f.root}</span
                >
              </td>
              <td class="num">{fmtBytes(f.size)}</td>
              <td>{fmtDate(f.modTime)}</td>
              <td>
                <span
                  class="chip idle"
                  title={f.hashed
                    ? 'Not in the library yet'
                    : 'Not content-checked yet — importing is safe, duplicates are detected by hash'}
                  >not imported</span
                >
              </td>
              <td class="row-actions" onclick={(e) => e.stopPropagation()}>
                <button class="btn small primary" onclick={(e) => doImportFile(f, e)}
                  >Import</button
                >
                <button
                  class="btn small danger"
                  title="Delete this demo file from disk"
                  onclick={(e) => onDeleteFile(f, e)}>Delete from disk</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <ConfirmDialog bind:this={confirmDlg} />
</div>
