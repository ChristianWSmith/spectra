<script>
  // M4 Context stream: merged chat + match administration —
  // connects/disconnects (typed events), server ConVars and team changes
  // (generic events) — one tick-sorted list with per-source filter chips and
  // CSV/JSON export through the native save dialog. Sources fetched
  // independently; a failed source shows its error but never blanks the rest.
  import { getChat, getEvents, getGenericEvents, setPendingSeek, errText } from '../services.js';
  import { downloadText } from '../download.js';
  import { toCSV } from '../csv.js';
  import { fmtInt } from '../fmt.js';
  import EventPlay from '../components/EventPlay.svelte';

  let { id = 0, nav = () => {} } = $props();

  const SOURCES = [
    { key: 'chat', label: 'Chat' },
    { key: 'connect', label: 'Connects' },
    { key: 'disconnect', label: 'Disconnects' },
    { key: 'team', label: 'Team changes' },
    { key: 'convar', label: 'ConVars' },
  ];

  let rows = $state([]); // {tick, round, src, name, text}
  let active = $state(
    Object.fromEntries(SOURCES.map((s) => [s.key, true])),
  );
  let errors = $state([]);
  let loading = $state(true);

  // Defensive payload reader: generic-event payloads are untyped maps.
  function payloadOf(json) {
    try {
      const p = JSON.parse(json || '{}');
      return p && typeof p === 'object' ? p : {};
    } catch {
      return {};
    }
  }

  function compactPayload(p) {
    const entries = Object.entries(p);
    if (!entries.length) return '';
    return entries.map(([k, v]) => `${k}=${v}`).join(' ');
  }

  $effect(() => {
    const mid = id;
    let live = true;
    loading = true;
    errors = [];
    const out = [];
    const jobs = [];

    // A failed source records its error but never blanks the others; the
    // live flag keeps late results from a previous matchId out.
    const fail = (label) => (e) => {
      if (live) errors.push(`${label}: ${errText(e)}`);
    };

    jobs.push(
      getChat(mid, -1)
        .then((chat) => {
          for (const c of chat || []) {
            out.push({
              tick: c.tick,
              round: c.round,
              src: 'chat',
              name: c.name || '',
              text: c.text || '',
            });
          }
        })
        .catch(fail('chat')),
    );

    // Connect/disconnect are typed events (models.EventConnect/Disconnect);
    // the attacker SteamID carries the joinable name via the players table.
    for (const [kind, src] of [
      ['player_connect', 'connect'],
      ['player_disconnect', 'disconnect'],
    ]) {
      jobs.push(
        getEvents({
          matchId: mid,
          round: -1,
          kind,
          steamId: '',
          weapon: '',
          tickFrom: 0,
          tickTo: 0,
          dmgMin: 0,
          dmgMax: 0,
          distanceMax: 0,
          headshotOnly: false,
          offset: 0,
          limit: 2000,
        })
          .then((evs) => {
            for (const ev of evs || []) {
              out.push({
                tick: ev.tick,
                round: ev.round,
                src,
                name: ev.attackerName || ev.attacker || '',
                text: src === 'connect' ? 'connected' : 'disconnected',
              });
            }
          })
          .catch(fail(src)),
      );
    }

    // Generic-event names are probed defensively (only the two known-good
    // names — no speculative probing).
    for (const [name, src] of [
      ['server_cvar', 'convar'],
      ['player_team', 'team'],
    ]) {
      jobs.push(
        getGenericEvents(mid, name, 500)
          .then((ges) => {
            for (const ge of ges || []) {
              const p = payloadOf(ge.payloadJson);
              const who = p.name || p.playername || p.player || '';
              let text;
              if (src === 'convar') {
                const cv = p.cvarname ?? p.cvar ?? p.convar ?? '';
                const val = p.cvarvalue ?? p.value ?? p.val ?? '';
                text = cv ? `${cv} = ${val}` : compactPayload(p);
              } else {
                const team = p.team ?? p.newteam ?? '';
                const old = p.oldteam ?? '';
                text = team
                  ? `team ${old !== '' ? old + ' → ' : '→ '}${team}`
                  : compactPayload(p);
              }
              out.push({ tick: ge.tick, round: ge.round, src, name: who, text });
            }
          })
          .catch(fail(name)),
      );
    }

    Promise.all(jobs).then(() => {
      if (!live) return;
      out.sort((a, b) => a.tick - b.tick);
      rows = out;
      loading = false;
    });
    return () => (live = false);
  });

  const visible = $derived(rows.filter((r) => active[r.src]));

  function toggle(key) {
    active = { ...active, [key]: !active[key] };
  }

  // --- Export (native save dialog — lib/save.js) ------------------------------
  // The view has no status strip for save failures; cancel is a silent
  // no-op by contract, real failures land in the console.
  async function download(filename, mime, text) {
    try {
      await downloadText(filename, mime, text);
    } catch (e) {
      console.error('Context export failed:', e);
    }
  }

  function exportJSON() {
    return download(
      `match-${id}-context.json`,
      'application/json',
      JSON.stringify(visible, null, 2),
    );
  }

  function exportCSV() {
    const rows = [['tick', 'round', 'source', 'name', 'text']];
    for (const r of visible) rows.push([r.tick, r.round, r.src, r.name, r.text]);
    return download(
      `match-${id}-context.csv`,
      'text/csv;charset=utf-8',
      toCSV(rows),
    );
  }

  function watchTick(r) {
    setPendingSeek({ tick: r.tick });
    nav(`/replay/${id}`);
  }
</script>

<div class="view ctx-view">
  <div class="toolbar ctx-toolbar">
    <span class="muted">Sources</span>
    {#each SOURCES as s (s.key)}
      <button
        class="chip ctx-chip"
        class:on={active[s.key]}
        aria-pressed={active[s.key]}
        onclick={() => toggle(s.key)}>{s.label}</button
      >
    {/each}
    <div class="spacer"></div>
    <span class="muted num">{visible.length} rows</span>
    <button class="btn small" onclick={exportCSV} disabled={!visible.length}
      >Export CSV</button
    >
    <button class="btn small" onclick={exportJSON} disabled={!visible.length}
      >Export JSON</button
    >
  </div>

  {#each errors as e, i (i)}
    <p class="error" role="alert">Context source failed — {e}</p>
  {/each}

  {#if loading}
    <p class="muted" role="status">Loading context…</p>
  {:else}
    <div class="table-scroll">
      <table class="data-table ctx-table">
        <thead>
          <tr>
            <th scope="col" class="num">Tick</th>
            <th scope="col" class="num">Round</th>
            <th scope="col">Source</th>
            <th scope="col">Name</th>
            <th scope="col">Detail</th>
            <th scope="col"><span class="sr-only">Watch</span></th>
          </tr>
        </thead>
        <tbody>
          {#each visible as r, i (i)}
            <tr>
              <td class="num mono">{r.tick}</td>
              <td class="num"
                ><span class="chip round-chip">{r.round}</span></td
              >
              <td><span class="chip ctx-src src-{r.src}">{r.src}</span></td>
              <td>{r.name || '—'}</td>
              <td class="ctx-detail">{r.text}</td>
              <td>
                <EventPlay tick={r.tick} cls="vrow-play" onclick={() => watchTick(r)} />
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="6" class="muted">
                No context rows in this selection.
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="muted ctx-note">
      {fmtInt(rows.length)} total rows across all sources — toggle chips above
      to filter, <span class="codicon codicon-play"></span> opens the replay at that tick.
    </p>
  {/if}
</div>
