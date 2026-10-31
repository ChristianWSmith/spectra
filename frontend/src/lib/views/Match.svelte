<script>
  import {
    getMatch,
    getScoreboard,
    getRounds,
    getChat,
    getWarnings,
    getGenericHistogram,
    getGenericEvents,
    getCombatStats,
    getRoundClasses,
    getVoicePresence,
    listMatches,
    setPendingTimelineFilter,
    setPendingSeek,
  } from '../services.js';
  import {
    fmtDuration,
    fmtBytes,
    fmtDate,
    fmt1,
    fmt2,
    fmtPercent,
    fmtInt,
    prettyJson,
  } from '../fmt.js';
  import RoundStrip from '../components/RoundStrip.svelte';
  import Economy from './Economy.svelte';
  import Utility from './Utility.svelte';
  import Heatmaps from './Heatmaps.svelte';
  import Combat from './Combat.svelte';
  import Context from './Context.svelte';
  import StatusChip from '../components/StatusChip.svelte';

  let { id = 0, nav = () => {} } = $props();

  const TABS = ['Overview', 'Scoreboard', 'Rounds', 'Economy', 'Utility', 'Heatmaps', 'Combat', 'Timeline', 'Chat', 'Context', 'Raw'];

  // GetScoreboard sort whitelist (mirror of the Go store's map). Columns
  // follow plan §2; combined columns sort by their primary key.
  // KAST% lives in the analytics pass (getCombatStats → kastPct), not the
  // scoreboard store — its sort is applied client-side (see viewRows).
  const KAST_DEF =
    'KAST% — rounds with a Kill, Assist, traded death or survival ÷ rounds played (player_round_stats; trade window from analysis_config / rule_version).';

  const SCORE_COLS = [
    { key: 'name', label: 'Name' },
    { key: 'side', label: 'Side' },
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'assists', label: 'A' },
    { key: 'adr', label: 'ADR' },
    { key: 'kast', label: 'KAST%', title: KAST_DEF },
    { key: 'hs_pct', label: 'HS%' },
    { key: 'kd', label: 'K/D' },
    { key: 'kda', label: 'KDA' },
    { key: 'total_damage', label: 'DMG' },
    { key: 'rounds_played', label: 'Rnds' },
    {
      key: 'three_k',
      label: '3K/4K/5K',
      fmt: (p) => `${p.threeK}/${p.fourK}/${p.fiveK}`,
    },
    { key: 'entry_kills', label: 'Entry' },
    { key: 'trade_kills', label: 'Trade' },
    {
      key: 'opening_kills',
      label: 'Opening K/D',
      fmt: (p) => `${p.openingKills}/${p.openingDeaths}`,
    },
    { key: 'best_streak', label: 'Streak' },
    { key: 'utility_damage', label: 'Util' },
    { key: 'mvps', label: 'MVPs' },
    { key: 'score', label: 'Score' },
  ];

  let match = $state(null);
  let summary = $state(null); // MatchSummary row (team names)
  let rounds = $state([]);
  let scoreboard = $state([]);
  let tab = $state('Overview');
  let sortKey = $state('kills');
  let desc = $state(true);
  let expanded = $state(0); // steamId of the expanded scoreboard row
  let warnings = $state(null); // null = not loaded
  let warningsOpen = $state(false);
  let chat = $state([]);
  let chatRound = $state(-1);
  let histogram = $state([]);
  let rawName = $state('');
  let rawEvents = $state([]);
  let rawLimit = $state(100);
  let error = $state('');
  // M4 header badges: voice presence (plan §1/§5) + chat-decrypt key state.
  let voice = $state(null);

  // Analytics (M3): per-player KAST for the scoreboard column + per-round
  // classification chips for the Rounds tab. Both are optional — failures
  // surface inline per section instead of breaking the whole match view.
  let combatBySteam = $state(new Map());
  let combatError = $state('');
  let classByRound = $state(new Map());
  let classError = $state('');
  // Rounds-tab compare picker: round numbers (max 4, non-warmup only).
  let compareSel = $state([]);

  // Match header + rounds + summary. Scoreboard has its own effect below
  // (sort changes must not re-trigger this one).
  $effect(() => {
    let live = true;
    Promise.all([
      getMatch(id),
      getRounds(id),
      listMatches('', 'extracted_at', false),
      getVoicePresence(id).catch(() => null),
    ])
      .then(([m, r, list, v]) => {
        if (!live) return;
        match = m;
        rounds = r || [];
        summary = (list || []).find((s) => s.id === id) || null;
        voice = v;
        error = m ? '' : 'Match not found.';
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  // Scoreboard fetch: initial load + every sort change. KAST% is not a
  // store column — when it is the sort key we keep the current rows and
  // sort them client-side against combatBySteam (viewRows).
  $effect(() => {
    sortKey;
    desc;
    if (sortKey === 'kast') return;
    let live = true;
    getScoreboard(id, sortKey, desc)
      .then((sb) => {
        if (live) scoreboard = sb || [];
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  // Per-player KAST% (CombatStatRow.kastPct) for the scoreboard column.
  $effect(() => {
    let live = true;
    combatError = '';
    getCombatStats(id)
      .then((rows) => {
        if (live) {
          combatBySteam = new Map((rows || []).map((r) => [r.steamId, r]));
        }
      })
      .catch((e) => {
        if (live) combatError = errText(e);
      });
    return () => (live = false);
  });

  // Round classification chips (label + explanation + rule version).
  $effect(() => {
    let live = true;
    classError = '';
    getRoundClasses(id)
      .then((rows) => {
        if (live) classByRound = new Map((rows || []).map((r) => [r.round, r]));
      })
      .catch((e) => {
        if (live) classError = errText(e);
      });
    return () => (live = false);
  });

  const viewRows = $derived.by(() => {
    if (sortKey !== 'kast') return scoreboard;
    const dir = desc ? -1 : 1;
    return [...scoreboard].sort(
      (a, b) => dir * ((kastPct(a) ?? -1) - (kastPct(b) ?? -1)),
    );
  });

  function kastPct(p) {
    const row = combatBySteam.get(p.steamId);
    return row && Number.isFinite(row.kastPct) ? row.kastPct : null;
  }

  $effect(() => {
    if (tab !== 'Chat') return;
    let live = true;
    getChat(id, chatRound)
      .then((rows) => {
        if (live) chat = rows || [];
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  $effect(() => {
    if (tab !== 'Raw' || rawName) return;
    let live = true;
    getGenericHistogram(id)
      .then((h) => {
        if (live) histogram = h || [];
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  $effect(() => {
    if (tab !== 'Raw' || !rawName) return;
    let live = true;
    getGenericEvents(id, rawName, rawLimit)
      .then((rows) => {
        if (live) rawEvents = rows || [];
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  function toggleSort(key) {
    if (sortKey === key) desc = !desc;
    else {
      sortKey = key;
      desc = true;
    }
    expanded = 0;
  }

  // Cell display for a scoreboard column: custom fmt wins, else map the
  // snake_case sort key onto the row's camelCase field with formatting.
  function cellText(col, p) {
    if (col.fmt) return col.fmt(p);
    const field = col.key.replace(/_(\w)/g, (_, c) => c.toUpperCase());
    switch (col.key) {
      case 'adr':
        return fmt1(p.adr);
      case 'kast': {
        const v = kastPct(p);
        return v == null ? '—' : fmtPercent(v);
      }
      case 'hs_pct':
        return fmtPercent(p.hsPct);
      case 'kd':
        return fmt2(p.kd);
      case 'kda':
        return fmt2(p.kda);
      default:
        return p[field];
    }
  }

  function openPlayerTimeline(steamId) {
    setPendingTimelineFilter({ steamId });
    nav(`/timeline/${id}`);
  }

  function openReplay() {
    setPendingSeek(null); // clear any stale seek; the whole match plays from 0
    nav(`/replay/${id}`);
  }

  // SteamID64 guard — bots/short ids never match #/player/(\d{17}).
  function isSteam(s) {
    return /^\d{17}$/.test(s || '');
  }

  // --- Rounds-tab compare picker (max 4, non-warmup) ------------------------
  function toggleCompare(n) {
    if (compareSel.includes(n)) compareSel = compareSel.filter((x) => x !== n);
    else if (compareSel.length < 4) compareSel = [...compareSel, n];
  }

  // sessionStorage contract (M3 WAVE B): key 'spectra:compare-rounds' holds
  // {matchId: number, rounds: number[]}. Written here right before navigating
  // to #/compare/:id; CompareRounds reads + clears it once on init.
  function goCompare() {
    try {
      sessionStorage.setItem(
        'spectra:compare-rounds',
        JSON.stringify({ matchId: id, rounds: [...compareSel] }),
      );
      nav(`/compare/${id}`);
    } catch (e) {
      error = errText(e);
    }
  }

  function selectRaw(name) {
    if (rawName === name) return;
    rawName = name;
    rawLimit = 100;
    rawEvents = [];
  }

  function loadMoreRaw() {
    rawLimit += 100;
  }

  const rawTotal = $derived(
    rawName ? (histogram.find((h) => h.name === rawName)?.count ?? rawEvents.length) : 0,
  );

  async function toggleWarnings() {
    warningsOpen = !warningsOpen;
    if (warningsOpen && warnings == null) {
      try {
        warnings = await getWarnings(id);
      } catch (e) {
        error = errText(e);
        warnings = [];
      }
    }
  }

  // JSON.parse of killsByWeapon/damageByWeapon — "" or malformed → [].
  function weaponEntries(json) {
    if (!json) return [];
    try {
      const obj = JSON.parse(json);
      if (!obj || typeof obj !== 'object') return [];
      return Object.entries(obj).sort((a, b) => Number(b[1]) - Number(a[1]));
    } catch {
      return [];
    }
  }

  const rosters = $derived.by(() => {
    const ct = scoreboard.filter((p) => p.side === 'ct');
    const t = scoreboard.filter((p) => p.side === 't');
    const other = scoreboard.filter((p) => p.side !== 'ct' && p.side !== 't');
    return { ct, t, other };
  });

  const topStats = $derived.by(() => {
    if (!scoreboard.length) return [];
    const maxBy = (fn) => scoreboard.reduce((a, b) => (fn(b) > fn(a) ? b : a));
    const frag = maxBy((p) => p.kills);
    const util = maxBy((p) => p.utilityDamage);
    const adr = maxBy((p) => p.adr);
    const entry = maxBy((p) => p.entryKills);
    const mvp = maxBy((p) => p.mvps);
    return [
      { label: 'Top fragger', p: frag, value: `${frag.kills}/${frag.deaths}/${frag.assists}` },
      { label: 'Best ADR', p: adr, value: fmt1(adr.adr) },
      { label: 'Most util', p: util, value: `${util.utilityDamage}` },
      { label: 'Entry opens', p: entry, value: `${entry.entryKills}` },
      { label: 'Most MVPs', p: mvp, value: `${mvp.mvps}` },
    ];
  });

  const firstBlood = $derived.by(() => {
    const r = rounds.find((x) => x.firstKillName && x.firstDeathName);
    return r ? `${r.firstKillName} killed ${r.firstDeathName} (R${r.number})` : null;
  });
</script>

<div class="view">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if match}
    <header class="view-header match-header">
      <div>
        <h1>
          <span class="ct">{summary?.ctName || 'CT'}</span>
          <span class="score">{match.scoreCT}–{match.scoreT}</span>
          <span class="t">{summary?.tName || 'T'}</span>
        </h1>
        <p class="muted match-sub">
          {match.map || '—'}
          · half {match.halfCT}–{match.halfT}
          · {fmtDuration(match.playbackTimeS)}
          · {fmt1(match.tickRate)} Hz
          · patch {match.patchVersion}
          · <StatusChip status={match.status || 'ready'} title={match.error || ''} />
          {#if voice}
            {#if voice.hasVoice}
              <span
                class="chip voice-badge"
                title="Voice: {fmtInt(voice.chunkCount)} chunks across {voice.playerCount} players — Opus, decoded on demand"
                >🔊 {(voice.chunkCount / 1000).toFixed(1)}k · {voice.playerCount}</span
              >
            {:else}
              <span
                class="chip voice-badge none"
                title="This demo source does not record voice (e.g. Valve MM) — normal, not broken"
                >no voice</span
              >
            {/if}
            {#if !voice.keyFound && (match.encryptedMessages || 0) > 0}
              <span
                class="chip voice-badge lock"
                title="Encrypted chat present — .dem.info key not found"
                >🔒</span
              >
            {/if}
          {/if}
          · parser {match.parserVersion || '—'}
        </p>
      </div>
      <div class="spacer"></div>
      {#if match.warningsCount > 0}
        <button class="btn warn" onclick={toggleWarnings}>
          {match.warningsCount} warning{match.warningsCount === 1 ? '' : 's'}
        </button>
      {:else}
        <button class="btn" onclick={toggleWarnings}>Warnings</button>
      {/if}
      <button class="btn primary" onclick={openReplay}>Replay</button>
      <button class="btn primary" onclick={() => nav(`/timeline/${id}`)}>
        Timeline
      </button>
    </header>

    {#if warningsOpen}
      <div class="panel warnings-panel">
        <div class="row-between">
          <h2>Extraction warnings</h2>
          <button class="btn small" aria-label="Dismiss warnings" onclick={() => (warningsOpen = false)}>
            ✕
          </button>
        </div>
        {#if warnings == null}
          <p class="muted">Loading…</p>
        {:else if warnings.length === 0}
          <p class="muted">None — the parser ran clean.</p>
        {:else}
          <ul class="warning-list">
            {#each warnings as w, i (i)}
              <li>{w}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    <RoundStrip {rounds} matchId={id} {nav} />

    <nav class="tabs" aria-label="Match sections">
      {#each TABS as t (t)}
        {#if t === 'Timeline'}
          <button class="tab" onclick={() => nav(`/timeline/${id}`)}>{t}</button>
        {:else}
          <button class="tab" class:active={tab === t} onclick={() => (tab = t)}>
            {t}
          </button>
        {/if}
      {/each}
    </nav>

    {#if tab === 'Overview'}
      <div class="stat-grid">
        {#each topStats as s (s.label)}
          <button
            class="stat-cell"
            title="Open timeline filtered to {s.p.name}"
            onclick={() => openPlayerTimeline(s.p.steamId)}
          >
            <span class="stat-label">{s.label}</span>
            <span class="stat-value">{s.value}</span>
            <span class="stat-sub">{s.p.name}</span>
          </button>
        {/each}
      </div>

      <div class="roster-grid">
        <section class="panel">
          <h2 class="side-ct">CT roster</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" class="num">K/D/A</th>
                <th scope="col" class="num">ADR</th>
              </tr>
            </thead>
            <tbody>
              {#each rosters.ct as p (p.steamId)}
                <tr
                  class="clickable"
                  class:dim={p.finalStatePresent === false}
                  title={p.finalStatePresent === false
                    ? 'not in final snapshot — stats derived from events'
                    : ''}
                  onclick={() => openPlayerTimeline(p.steamId)}
                >
                  <td>
                    {p.name}
                    {#if p.finalStatePresent === false}
                      <span class="chip provenance" title="not in final snapshot — stats derived from events">derived</span>
                    {/if}
                  </td>
                  <td class="num">{p.kills}/{p.deaths}/{p.assists}</td>
                  <td class="num"><span class="chip adr">{fmt1(p.adr)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
        <section class="panel">
          <h2 class="side-t">T roster</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" class="num">K/D/A</th>
                <th scope="col" class="num">ADR</th>
              </tr>
            </thead>
            <tbody>
              {#each rosters.t as p (p.steamId)}
                <tr
                  class="clickable"
                  class:dim={p.finalStatePresent === false}
                  title={p.finalStatePresent === false
                    ? 'not in final snapshot — stats derived from events'
                    : ''}
                  onclick={() => openPlayerTimeline(p.steamId)}
                >
                  <td>
                    {p.name}
                    {#if p.finalStatePresent === false}
                      <span class="chip provenance" title="not in final snapshot — stats derived from events">derived</span>
                    {/if}
                  </td>
                  <td class="num">{p.kills}/{p.deaths}/{p.assists}</td>
                  <td class="num"><span class="chip adr">{fmt1(p.adr)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if rosters.other.length > 0}
            <h2>Other</h2>
            <table class="data-table">
              <tbody>
                {#each rosters.other as p (p.steamId)}
                  <tr class="clickable" onclick={() => openPlayerTimeline(p.steamId)}>
                    <td>{p.name}</td>
                    <td class="num">{p.kills}/{p.deaths}/{p.assists}</td>
                    <td class="num"><span class="chip adr">{fmt1(p.adr)}</span></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
      </div>

      <section class="panel">
        <h2>Key facts</h2>
        <dl class="facts">
          <div><dt>Server</dt><dd>{match.serverName || '—'}</dd></div>
          <div><dt>Map</dt><dd>{match.map || '—'}</dd></div>
          <div><dt>Tickrate</dt><dd>{fmt1(match.tickRate)} Hz</dd></div>
          <div><dt>Frames</dt><dd class="num">{fmtInt(match.frames)}</dd></div>
          <div><dt>Duration</dt><dd>{fmtDuration(match.playbackTimeS)}</dd></div>
          <div><dt>Size</dt><dd>{fmtBytes(match.size)}</dd></div>
          <div><dt>Extracted</dt><dd>{fmtDate(match.extractedAt)}</dd></div>
          <div><dt>Warnings</dt><dd>{match.warningsCount}</dd></div>
          {#if firstBlood}
            <div><dt>First blood</dt><dd>{firstBlood}</dd></div>
          {/if}
          <div class="fact-wide"><dt>Source</dt><dd class="mono">{match.path}</dd></div>
        </dl>
      </section>
    {:else if tab === 'Scoreboard'}
      {#if combatError}
        <p class="error" role="alert">KAST% unavailable: {combatError}</p>
      {/if}
      <div class="table-scroll">
        <table class="data-table scoreboard">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">Expand</span></th>
              {#each SCORE_COLS as col (col.key)}
                <th scope="col" class="num" class:cmp-def={col.title} title={col.title || ''}>
                  <button
                    class="th-sort"
                    class:sorted={sortKey === col.key}
                    aria-label="Sort by {col.label}"
                    onclick={() => toggleSort(col.key)}
                  >
                    {col.label}{#if sortKey === col.key}{desc ? ' ↓' : ' ↑'}{/if}
                  </button>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each viewRows as p (p.steamId)}
              <tr
                class="clickable"
                onclick={(e) => {
                  // Svelte 5 delegated events: child stopPropagation does not
                  // reliably stop this row handler — guard on target instead.
                  if (e.target instanceof Element && e.target.closest('button, input, a'))
                    return;
                  openPlayerTimeline(p.steamId);
                }}
                onkeydown={(e) => e.key === 'Enter' && openPlayerTimeline(p.steamId)}
                tabindex="0"
              >
                <td class="expand-cell" onclick={(e) => e.stopPropagation()}>
                  <button
                    class="btn small ghost"
                    aria-label="Weapon breakdown for {p.name}"
                    aria-expanded={expanded === p.steamId}
                    onclick={() => (expanded = expanded === p.steamId ? 0 : p.steamId)}
                  >
                    {expanded === p.steamId ? '▾' : '▸'}
                  </button>
                </td>
                {#each SCORE_COLS as col (col.key)}
                  {#if col.key === 'name'}
                    <td class="num name-cell"
                      >{#if isSteam(p.steamId)}
                        <button
                          class="btn ghost small name-link"
                          title="Open {p.name}'s profile"
                          onclick={(e) => {
                            e.stopPropagation();
                            nav(`/player/${p.steamId}`);
                          }}
                        >{p.name}</button>
                      {:else}
                        {p.name}
                      {/if}{#if p.isBot}<span class="chip">bot</span>{/if}</td
                    >
                  {:else if col.key === 'side'}
                    <td class="num"
                      ><span class="chip side {p.side}"
                        >{p.side ? p.side.toUpperCase() : '—'}</span
                      ></td
                    >
                  {:else}
                    <td class="num">{cellText(col, p)}</td>
                  {/if}
                {/each}
              </tr>
              {#if expanded === p.steamId}
                <tr class="expand-row">
                  <td colspan={SCORE_COLS.length + 1}>
                    <div class="weapon-grid">
                      <div>
                        <h3>Kills by weapon</h3>
                        <table class="data-table mini">
                          <thead>
                            <tr><th scope="col">Weapon</th><th scope="col" class="num">Kills</th></tr>
                          </thead>
                          <tbody>
                            {#each weaponEntries(p.killsByWeapon) as [w, n] (w)}
                              <tr><td>{w}</td><td class="num">{n}</td></tr>
                            {:else}
                              <tr><td colspan="2" class="muted">None recorded</td></tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                      <div>
                        <h3>Damage by weapon</h3>
                        <table class="data-table mini">
                          <thead>
                            <tr><th scope="col">Weapon</th><th scope="col" class="num">Damage</th></tr>
                          </thead>
                          <tbody>
                            {#each weaponEntries(p.damageByWeapon) as [w, n] (w)}
                              <tr><td>{w}</td><td class="num">{n}</td></tr>
                            {:else}
                              <tr><td colspan="2" class="muted">None recorded</td></tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {:else if tab === 'Rounds'}
      {#if classError}
        <p class="error" role="alert">Round classes unavailable: {classError}</p>
      {/if}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th
                scope="col"
                class="num cmp-cmp-col"
                title="Tick rounds to compare (max 4 non-warmup rounds)"
              >Cmp</th>
              <th scope="col" class="num">№</th>
              <th scope="col">Winner</th>
              <th
                scope="col"
                class="cmp-def"
                title="Buy/round classification (pistol/anti-eco/eco/force/full/bonus/save) with the rule text and rule_version — hover a chip"
              >Class</th>
              <th scope="col">Reason</th>
              <th scope="col" class="num">Duration</th>
              <th scope="col">Site</th>
              <th scope="col">MVP</th>
              <th scope="col" class="num">Equip CT</th>
              <th scope="col" class="num">Equip T</th>
              <th scope="col">First blood</th>
              <th scope="col" class="num">Kills</th>
            </tr>
          </thead>
          <tbody>
            {#each rounds as r (r.number)}
              {@const cls = classByRound.get(r.number)}
              <tr
                class="clickable"
                onclick={(e) => {
                  if (e.target instanceof Element && e.target.closest('input, button, a'))
                    return;
                  nav(`/match/${id}/round/${r.number}`);
                }}
                onkeydown={(e) => e.key === 'Enter' && nav(`/match/${id}/round/${r.number}`)}
                tabindex="0"
              >
                <td class="num cmp-cmp-col" onclick={(e) => e.stopPropagation()}>
                  {#if !r.warmup}
                    <input
                      type="checkbox"
                      class="cmp-cb"
                      checked={compareSel.includes(r.number)}
                      disabled={compareSel.length >= 4 && !compareSel.includes(r.number)}
                      aria-label="Compare round {r.number}"
                      onchange={() => toggleCompare(r.number)}
                    />
                  {/if}
                </td>
                <td class="num">{r.number}{#if r.warmup}<span class="chip">wu</span>{/if}</td>
                <td>
                  <span class="chip side {r.winner || 'none'}">
                    {r.winner ? r.winner.toUpperCase() : '—'}
                  </span>
                </td>
                <td>
                  {#if cls}
                    <span
                      class="chip cmp-class"
                      title="{cls.explanation || 'classified'} (rule v{cls.ruleVersion}, confidence {Math.round((cls.confidence || 0) * 100)}%)"
                      >{cls.label}</span
                    >
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td>{r.reason || '—'}</td>
                <td class="num">{fmtDuration(r.durationS)}</td>
                <td>{r.bombSite || '—'}</td>
                <td>{r.mvpName || '—'}</td>
                <td class="num"><span class="chip side ct">{r.equipCT}</span></td>
                <td class="num"><span class="chip side t">{r.equipT}</span></td>
                <td>
                  {#if r.firstKillName && r.firstDeathName}
                    {r.firstKillName} killed {r.firstDeathName}
                  {:else}
                    —
                  {/if}
                </td>
                <td class="num">{r.kills}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if compareSel.length > 0}
        <p class="cmp-hint">
          {compareSel.length} of 4 rounds selected — warmup rounds cannot be compared.
        </p>
      {/if}
      {#if compareSel.length >= 2}
        <button class="btn primary cmp-float" onclick={goCompare}>
          Compare {compareSel.length} rounds ▸
        </button>
      {/if}
    {:else if tab === 'Economy'}
      <Economy {id} {nav} />
    {:else if tab === 'Utility'}
      <Utility {id} />
    {:else if tab === 'Heatmaps'}
      <Heatmaps {id} {nav} />
    {:else if tab === 'Combat'}
      <Combat {id} {nav} />
    {:else if tab === 'Chat'}
      <div class="toolbar">
        <label for="chat-round">Round</label>
        <select class="input" id="chat-round" bind:value={chatRound}>
          <option value={-1}>All rounds</option>
          {#each rounds as r (r.number)}
            <option value={r.number}>Round {r.number}</option>
          {/each}
        </select>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col" class="num">Tick</th>
              <th scope="col" class="num">Round</th>
              <th scope="col">Name</th>
              <th scope="col">Text</th>
            </tr>
          </thead>
          <tbody>
            {#each chat as c (c.id)}
              <tr>
                <td class="num mono">{c.tick}</td>
                <td class="num"
                  ><span class="chip round-chip">{c.round}</span></td
                >
                <td>{c.name || '—'}</td>
                <td>{c.text}</td>
              </tr>
            {:else}
              <tr><td colspan="4" class="muted">No chat in this selection.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if tab === 'Context'}
      <Context {id} {nav} />
    {:else if tab === 'Raw'}
      <div class="raw-grid">
        <section class="panel">
          <h2>Generic event histogram</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" class="num">Count</th>
              </tr>
            </thead>
            <tbody>
              {#each histogram as h (h.name)}
                <tr
                  class="clickable"
                  class:active={rawName === h.name}
                  onclick={() => selectRaw(h.name)}
                  onkeydown={(e) => e.key === 'Enter' && selectRaw(h.name)}
                  tabindex="0"
                >
                  <td class="mono">{h.name}</td>
                  <td class="num">{h.count}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
        <section class="panel">
          <h2>
            {#if rawName}
              <span class="mono">{rawName}</span>
            {:else}
              Pick an event name
            {/if}
          </h2>
          {#if rawName}
            {#each rawEvents as ge, i (i)}
              <div class="payload">
                <div class="payload-head">
                  <span class="chip round-chip">R{ge.round}</span>
                  <span class="mono muted">tick {ge.tick}</span>
                </div>
                <pre class="mono">{prettyJson(ge.payloadJson)}</pre>
              </div>
            {/each}
            {#if rawTotal > rawEvents.length}
              <button class="btn" onclick={loadMoreRaw}>
                + {rawTotal - rawEvents.length} more
              </button>
            {/if}
          {/if}
        </section>
      </div>
    {/if}
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</div>
