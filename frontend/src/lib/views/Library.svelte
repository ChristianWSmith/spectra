<script>
  import {
    importDialog,
    importPaths,
    listMatchesPage,
    listMapNames,
    listPlayers,
    listJobs,
    deleteMatch,
    evictDemoCopy,
    reprocess,
    cancelJob,
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
  import { listedPlayers } from '../players.js';
  import { teamNames } from '../teams.js';
  import StatusChip from '../components/StatusChip.svelte';
  import SortTh from '../components/SortTh.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import SuggestInput from '../components/SuggestInput.svelte';

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

  // Window size for the match list: one page per fetch, one more page per
  // Load-more click (backend default store.ListMatchesPageSize is the
  // same 200 — the button's row counts and the store's window agree).
  const PAGE_SIZE = 200;

  let matches = $state([]);
  // Keyset pagination ("Load more"): one window per fetch (PAGE_SIZE), and
  // hasNext is the backend's limit+1 probe — the button below the table
  // appends the NEXT window (cursor = last row's id) until it comes back
  // false. The whole window is ONE IPC call (its roster fallback rides
  // along — see applyRosters), so a list load never fans out per row.
  let hasNext = $state(false);
  let loadingMore = $state(false);
  let jobs = $state([]);
  let jobProgress = $state(new Map()); // jobId -> latest progress payload
  // Structured list facets (ANDed with each other — store.MatchListFilter,
  // forwarded by services.js listMatches): a map substring and "has player
  // X" (exact 17-digit SteamID or name substring — one input covers both).
  // These two inputs are the Library's ONLY search: the free-text box is
  // gone (listMatches' query parameter stays in the binding/API, and every
  // fetch below simply passes ''). Seeded from the route query so a deep
  // link (#/library?map=&player=) lands pre-filtered; the preset effect
  // below re-applies them if the route query changes while this view stays
  // mounted.
  let mapFilter = $state(String(routeQuery.map || ''));
  let playerFilter = $state(String(routeQuery.player || ''));
  // Suggestion sources for the two facets, fetched once on mount: the
  // distinct maps in the library (store.ListMapNames) and every player in
  // it (listPlayers — the same library-wide career list the Profiles view
  // and the profile finder use). Both reads are invalidated with the rest
  // of the read cache on spectra:library-changed.
  let mapNames = $state([]);
  let libPlayers = $state([]);
  let sortKey = $state('extracted_at');
  let desc = $state(true);
  let error = $state('');
  let importError = $state('');

  // Demos sitting in the configured import dirs (Settings → "Import
  // dirs") that are not in the library yet — each with a one-click
  // Import that runs through the same pipeline as drag-and-drop, plus a
  // confirmed delete-from-disk for the file itself. A file the queue is
  // already working on flips to the live job's chip with Import replaced
  // by Remove/Cancel (pendingDemoPaths) — see the row markup below.
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
  // onDeleteFile / onFreeCopy for the three prompts this view opens.
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

  // Debounced list fetch: re-arms on every sort/filter change and fires
  // 250 ms later, so typing doesn't hammer the store. First run is
  // immediate so the library loads without the debounce delay (the filter
  // state is seeded from the route query at init, so that first fetch
  // already carries any deep-link preset). The free-text query is always
  // '' — the facets are the search now.
  let firstList = true;
  $effect(() => {
    const sk = sortKey;
    const d = desc;
    const mf = mapFilter;
    const pf = playerFilter;
    if (firstList) {
      firstList = false;
      refreshList(sk, d, mf, pf);
      return;
    }
    const timer = setTimeout(() => refreshList(sk, d, mf, pf), 250);
    return () => clearTimeout(timer);
  });

  // listGen distinguishes the current window sequence from stale replies
  // (see refreshList/loadMore); non-reactive on purpose — it is not state.
  let listGen = 0;

  async function refreshList(sk = sortKey, d = desc, mf = mapFilter, pf = playerFilter) {
    // Any full (re)fetch restarts the window: cursor 0, replace — a sort/
    // filter change or a spectra:* refresh must never APPEND onto the
    // previous window's rows. listGen tags the fetch so a Load-more reply
    // that lands after a restart is dropped instead of appended.
    const gen = ++listGen;
    try {
      const page = await listMatchesPage('', sk, d, 0, PAGE_SIZE, { map: mf, player: pf });
      if (gen !== listGen) return;
      matches = (page && page.rows) || [];
      hasNext = !!(page && page.hasNext);
      applyRosters(page && page.rosters);
      error = '';
    } catch (e) {
      if (gen === listGen) error = errText(e);
    }
  }

  // loadMore appends the NEXT window: the cursor is the last rendered
  // row's id (the store resolves it to its stored sort value — ties are
  // broken server-side, so windows never skip or duplicate a row).
  // Duplicate ids are filtered out anyway (a row re-sorted or re-imported
  // between windows), because a repeated keyed {#each} id would throw.
  async function loadMore() {
    if (loadingMore || !hasNext || !matches.length) return;
    loadingMore = true;
    const gen = listGen;
    try {
      const last = matches[matches.length - 1];
      const page = await listMatchesPage('', sortKey, desc, last.id, PAGE_SIZE, {
        map: mapFilter,
        player: playerFilter,
      });
      if (gen !== listGen) return; // a refresh replaced the list meanwhile
      const seen = new Set(matches.map((m) => m.id));
      const add = ((page && page.rows) || []).filter((m) => !seen.has(m.id));
      matches = [...matches, ...add];
      hasNext = !!(page && page.hasNext);
      applyRosters(page && page.rosters);
      error = '';
    } catch (e) {
      error = errText(e);
    } finally {
      loadingMore = false;
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

  // Mount: jobs + import-dir scan + the facet suggestion sources + event
  // subscriptions. The initial list load comes from the debounced effect
  // above (fires once on mount). Suggestion failures are swallowed — a
  // missing suggestion list degrades to "no dropdown", never to an error
  // banner, because the facets themselves still work as LIKE filters.
  $effect(() => {
    let live = true;
    refreshJobs();
    refreshDemoFiles();
    listMapNames()
      .then((names) => {
        if (live) mapNames = names || [];
      })
      .catch(() => {});
    listPlayers('')
      .then((rows) => {
        if (live) libPlayers = listedPlayers(rows) || [];
      })
      .catch(() => {});
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
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  });

  // Any narrowing beyond "the whole library": a structured facet (the
  // Library's only search now). Drives the empty state — a filtered-out
  // library must offer the "no match" message, never "No matches yet" —
  // and its text (see filterSummary).
  const searching = $derived(!!(mapFilter.trim() || playerFilter.trim()));

  const filterSummary = $derived.by(() => {
    const parts = [];
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
        // A cancel that never started is a pure DEQUEUE (the user removed
        // a waiting job): not a problem — its synthetic row is already
        // gone and nothing was interrupted. Cancelled jobs that did run
        // stay (their parse was cut short).
        if (j.status === 'cancelled' && !j.startedAt) return false;
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

  // Synthetic rows: imports the queue owns but the matches table cannot
  // show yet. A match row is only created after hash (and the copy stage,
  // when copy-on-import is on — store.CreateMatchRow), so an import that
  // is queued — or hashing/copying/parsing before its row lands — has NO
  // match row at all. These
  // jobs render as their own table rows built from `jobs` (kind=import,
  // matchId 0), live-progress merged: the queued state is visible from the
  // moment Enqueue returns, never as an invisible wait.
  const pendingImports = $derived(
    jobs
      .filter(
        (j) => j.kind === 'import' && !j.matchId && (j.status === 'queued' || j.status === 'running'),
      )
      .map(jobView),
  );

  // The pending import for an import-dir path — the row's "queued" flip
  // (the file has no match row yet, which is exactly why the scan still
  // lists it). Keyed by the exact path string the pipeline stores: the
  // dir row's Import hands the same string to importPaths, and Enqueue
  // dedupes on it.
  const pendingDemoPaths = $derived(new Map(pendingImports.map((j) => [j.path, j])));

  // Cancel vs Remove: one backend call (cancelJob), two labels — a
  // queued job is waiting in line (Remove takes it out), a running one
  // is being worked (Cancel stops it).
  function cancelLabel(status) {
    return status === 'queued' ? 'Remove' : 'Cancel';
  }

  function cancelTitle(status) {
    return status === 'queued'
      ? 'Take it out of line — nothing has been read yet'
      : 'Stop this import now';
  }

  // Cancel/Remove on any Library row (match row, synthetic import row,
  // import-dir row): after it lands the row must be usable again — the
  // backend restores/hands back the match state (see library.Cancel).
  async function onCancelJob(id, ev) {
    ev.stopPropagation();
    try {
      await cancelJob(id);
      await refreshJobs();
      await refreshList();
      await refreshDemoFiles();
    } catch (e) {
      error = errText(e);
    }
  }

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

  // Free the disk space Spectra's copy of a match's demo uses — the row
  // action behind copyState 'copied' (fs-derived, so it is only rendered
  // when a copy actually exists and the row is openable). Only the managed
  // copy under the app's data dir goes: the match, its sidecars and the
  // user's original file are untouched, and the row re-derives its state
  // (external / missing) on the next list load.
  async function onFreeCopy(m, ev) {
    ev.stopPropagation();
    notice = '';
    const ok = await confirmDlg?.ask({
      title: 'Free Spectra’s copy of the demo?',
      message:
        `Deletes the ${fmtBytes(m.size)} copy Spectra keeps for this match. ` +
        'Your original file, this match’s data and its replay stay as they are — ' +
        'but Re-parse will need your original file to still exist.',
      confirmLabel: 'Free copy',
    });
    if (!ok) return;
    try {
      const freed = await evictDemoCopy(m.id);
      notice = `Freed ${fmtBytes(typeof freed === 'number' ? freed : m.size)}`;
      await refreshList();
    } catch (e) {
      error = errText(e);
    }
  }

  async function onDelete(m, ev) {
    ev.stopPropagation();
    notice = '';
    if (
      !(await confirmDlg?.ask({
        title: 'Delete this match’s data?',
        message:
          'Removes everything Spectra saved for this match (rounds, events, voice, positions). ' +
          'The demo file itself is not touched.',
        confirmLabel: 'Delete',
      }))
    ) {
      return;
    }
    // The "also delete the demo file?" prompt only makes sense when there
    // IS a managed copy to delete (copyState 'copied' — fs-derived at the
    // last list load): a skip-copied or already-evicted match has none,
    // and asking to delete a file that isn't ours would be a lie. Only
    // Spectra's OWN copy is ever removed — the backend reports
    // removedDemo=false when there is no managed copy, and the user's
    // original file is never ours to touch.
    let alsoFile = false;
    if (m.copyState === 'copied') {
      alsoFile = !!(await confirmDlg?.ask({
        title: 'Also delete the demo file?',
        message:
          'Deletes Spectra’s own imported copy of the demo from disk. ' +
          'Your original file is never touched.',
        confirmLabel: 'Delete demo file',
      }));
    }
    try {
      const removedDemo = await deleteMatch(m.id, alsoFile);
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

  // A match row opens /match/:id — but only when there is a match view
  // to open. A queued/parsing row has no rounds/events yet, so the match
  // view would be an empty shell: those rows are NOT interactive — no
  // navigation on click/Enter, no focus stop (tabindex) and no pointer
  // affordance (.clickable). `failed` stays openable: the view shows the
  // failure state (the failed StatusChip carries match.error in its
  // title), and a reprocess failure keeps any previously extracted rows
  // on screen. The row's own Reprocess/Delete buttons stopPropagation on
  // click and are disabled while the row is NOT openable (parsing/queued
  // — re-running either against a row mid-parse would race the job), with
  // a title hint saying why; the row's Cancel/Remove control is the one
  // button that stays ENABLED while the row is locked (it is the way out
  // of that state — see onCancelJob). Enter on them must not navigate the
  // row either (the keydown bubbles up to the <tr>), hence the target
  // check in the keydown handler.
  function isOpenable(m) {
    return m.status !== 'parsing' && m.status !== 'queued';
  }

  function openMatch(m) {
    if (!isOpenable(m)) return;
    nav(`/match/${m.id}`);
  }

  // Team names for rows whose extract recorded no clan name: the page's
  // `rosters` map carries the roster rows for exactly those matches (the
  // ONE batched read — store.ListMatchesPage, replacing the pre-pagination
  // per-row getScoreboard fan-out), so the synthesis inputs land with the
  // list load itself: no second IPC call, no per-row cache keys. Derived
  // rosters cache per match id across windows (the list refreshes on every
  // search/sort); a match with NO roster (still parsing) gets no entry, so
  // its matchup stays "—" until a later window carries players.
  let synthPlayers = $state(new Map()); // matchId → roster rows

  function applyRosters(rosters) {
    if (!rosters) return;
    let next = null;
    for (const key of Object.keys(rosters)) {
      const id = Number(key);
      if (synthPlayers.has(id)) continue; // already resolved by an earlier window
      const players = listedPlayers(rosters[key]) || [];
      if (!players.length) continue; // no extracted players (parsing/failed row)
      (next ??= new Map(synthPlayers)).set(id, players);
    }
    // Only publish when something new arrived — reassigning an unchanged
    // map would churn every dependent render for nothing.
    if (next) synthPlayers = next;
  }

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
    <!-- The Library's ONLY search controls, sitting where the free-text
         box used to be: the map + player facets, ANDed with each other
         (store.MatchListFilter). A filled input is an ACTIVE filter
         (accent border); each input's native × clears it, the button
         clears both. Values also arrive pre-set from the route query
         (#/library?map=&player= — the profile → library deep link), and
         each input offers suggestions drawn from the library itself
         (distinct maps / the profile list) without ever constraining
         what may be typed. -->
    <div class="lib-filters" role="group" aria-label="Library filters">
      <span class="lib-filter-field">
        <label class="field-label" for="lib-filter-map">Map</label>
        <SuggestInput
          id="lib-filter-map"
          inputClass="lib-filter"
          placeholder="e.g. de_mirage"
          ariaLabel="Filter by map"
          items={mapNames}
          bind:value={mapFilter}
          onselect={(m) => (mapFilter = m)}
        />
      </span>
      <span class="lib-filter-field">
        <label class="field-label" for="lib-filter-player">Player</label>
        <SuggestInput
          id="lib-filter-player"
          inputClass="lib-filter"
          kind="player"
          placeholder="Player name or SteamID"
          ariaLabel="Filter by player"
          items={libPlayers}
          bind:value={playerFilter}
          onselect={(p) => (playerFilter = p.steamId || p.name)}
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
  </header>

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
          <span class="error-text">{job.error || 'no details'}</span>
        </div>
      {/each}
    </section>
  {/if}

  <div class="dropzone">
    {#if matches.length === 0 && jobs.length === 0 && !searching}
      <div class="empty">
        <p class="empty-title" role="status">No matches yet</p>
        <!-- No Import… button here: the header already owns the one
             import action (top-left of this view) — the copy points at
             it instead of duplicating it. -->
        <p class="muted">
          Import a CS2 demo with the button above, or drop <span class="mono"
            >.dem</span
          > / <span class="mono">.dem.zst</span> files anywhere in this panel.
        </p>
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
            <SortTh label="Imported" active={sortKey === 'extracted_at'} {desc} onclick={() => toggleSort('extracted_at')} />
            <SortTh label="Status" active={sortKey === 'status'} {desc} onclick={() => toggleSort('status')} />
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <!-- Queued/early imports: jobs with no match row yet (see
               pendingImports) rendered as their own rows, ahead of the
               match list — the visible half of the queue. -->
          {#each pendingImports as job (job.id)}
            <tr data-pending-import>
              <td>—</td>
              <td><span class="mono" title={job.path}>{basename(job.path)}</span></td>
              <td class="num">—</td>
              <td class="num">—</td>
              <td class="num">—</td>
              <td class="num">—</td>
              <td>—</td>
              <td>
                <StatusChip
                  status={job.status}
                  progress={job.progress}
                  stage={job.stage}
                  title={job.error || ''}
                />
              </td>
              <td class="row-actions" onclick={(e) => e.stopPropagation()}>
                <button
                  class="btn small"
                  title={cancelTitle(job.status)}
                  onclick={(e) => onCancelJob(job.id, e)}
                  >{cancelLabel(job.status)}</button
                >
              </td>
            </tr>
          {/each}
          {#each matches as m (m.id)}
            <tr
              class:clickable={isOpenable(m)}
              onclick={() => openMatch(m)}
              onkeydown={(e) =>
                e.key === 'Enter' && e.target === e.currentTarget && openMatch(m)}
              tabindex={isOpenable(m) ? 0 : undefined}
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
              <!-- fmtDate owns the placeholder: a row that has not been
                   extracted yet (NULL extracted_at → Go zero time) renders
                   "—", never a year-0001 date. -->
              <td>{fmtDate(m.extractedAt)}</td>
              <td>
                {#if m.status === 'parsing' || m.status === 'queued'}
                  <StatusChip
                    status={m.status === 'parsing' ? 'parsing' : 'queued'}
                    progress={progressByMatch.get(m.id)?.progress ?? null}
                    stage={progressByMatch.get(m.id)?.stage ?? ''}
                    title={m.error || ''}
                  />
                {:else if m.status === 'failed'}
                  <StatusChip status="failed" title={m.error || 'import failed'} />
                {:else}
                  <StatusChip status="ready" />
                {/if}
              </td>
              <td class="row-actions" onclick={(e) => e.stopPropagation()}>
                <!-- Cancel/Remove exists only while a job owns this row
                     (a queued reprocess, a running parse) — the one
                     control that unlocks it again. -->
                {#if progressByMatch.has(m.id)}
                  <button
                    class="btn small"
                    title={cancelTitle(progressByMatch.get(m.id).status)}
                    onclick={(e) => onCancelJob(progressByMatch.get(m.id).id, e)}
                    >{cancelLabel(progressByMatch.get(m.id).status)}</button
                  >
                {/if}
                <button
                  class="btn small"
                  disabled={!isOpenable(m)}
                  title={!isOpenable(m)
                    ? 'Available once parsing finishes'
                    : "Re-parse the demo — from Spectra's copy when one exists"}
                  onclick={(e) => onReprocess(m.id, e)}>Re-parse</button
                >
                <!-- Free copy: rendered only while the fs-derived state
                     says a managed copy exists AND the row is openable —
                     a parsing/queued row never shows it, so the row's
                     action-count stays the two controls the queue pins. -->
                {#if m.copyState === 'copied' && isOpenable(m)}
                  <button
                    class="btn small"
                    title="Free the disk space Spectra’s copy uses — your original file is not touched"
                    onclick={(e) => onFreeCopy(m, e)}>Free copy</button
                  >
                {/if}
                <button
                  class="btn small danger"
                  disabled={!isOpenable(m)}
                  title={!isOpenable(m)
                    ? 'Available once parsing finishes'
                    : 'Delete this match’s data'}
                  onclick={(e) => onDelete(m, e)}>Delete</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if matches.length === 0 && pendingImports.length === 0}
        <div class="empty">
          <p class="muted" role="status">
            {searching
              ? `No matches match ${filterSummary}.`
              : 'No matches yet — imports will appear here.'}
          </p>
        </div>
      {/if}
      <!-- Keyset pagination footer: only while another window exists
           (backend hasNext). Appends the next PAGE_SIZE rows below the
           ones already shown — jobs and dir sections are unaffected. -->
      {#if hasNext}
        <div class="row-between">
          <span class="muted" role="status">Showing {matches.length} matches</span>
          <button class="btn" disabled={loadingMore} onclick={loadMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Import dirs: .dem / .dem.zst files under the dirs configured in
       Settings → "Import dirs" that are not in the library yet — the
       backend omits recognised imports, so deleting a match brings its
       demo back here. One Import button per row runs the ordinary
       pipeline (hash dedupe, row status chip); a file with a pending job
       flips to that job's chip and swaps Import for its Remove/Cancel
       (pendingDemoPaths, sourced from store.FindPendingJobByPath); Delete
       from disk removes the file itself, behind a confirmation. -->
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
      four levels deep, hidden folders skipped. Importing never moves, modifies or
      deletes your original file; the copy kept in Spectra’s data folder is
      optional (Settings → Import dirs) and can be freed from any match row.
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
            <!-- A pending import for this exact path flips the row: the
                 chip shows the live job (queued → running) and Import is
                 replaced by its Remove/Cancel — the same control the
                 synthetic row above offers, so the file can never be
                 enqueued twice from here. -->
            {@const pj = pendingDemoPaths.get(f.path)}
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
                {#if pj}
                  <StatusChip
                    status={pj.status}
                    progress={pj.progress}
                    stage={pj.stage}
                    title={pj.error || 'This demo is already being imported'}
                  />
                {:else}
                  <span
                    class="chip idle"
                    title={f.hashed
                      ? 'Not in the library yet'
                      : 'Not compared with the library yet — importing is safe; Spectra spots duplicates itself'}
                    >not imported</span
                  >
                {/if}
              </td>
              <td class="row-actions" onclick={(e) => e.stopPropagation()}>
                {#if pj}
                  <button
                    class="btn small"
                    title={cancelTitle(pj.status)}
                    onclick={(e) => onCancelJob(pj.id, e)}
                    >{cancelLabel(pj.status)}</button
                  >
                {:else}
                  <button class="btn small primary" onclick={(e) => doImportFile(f, e)}
                    >Import</button
                  >
                {/if}
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
